import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_STATE_PATH = 'data/private/bsa-business.json';
const DEFAULT_CHANNEL = 'BigSaleApple';
const ALLOWED_UPDATES = [
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
];

const emptyState = () => ({
  schemaVersion: 1,
  lastUpdateId: 0,
  businessConnection: null,
  messages: [],
  updatedAt: null,
});

function username(value) {
  return String(value || '').replace(/^@/, '').toLowerCase();
}

function messageOrigin(message) {
  const forward = message?.forward_origin;
  if (forward?.type === 'channel' && forward.chat) {
    return {
      username: forward.chat.username,
      chatId: forward.chat.id,
      postId: forward.message_id,
    };
  }
  return {
    username: message?.chat?.username,
    chatId: message?.chat?.id,
    postId: message?.message_id,
  };
}

function cachedMessage(update, channel) {
  const message = update.business_message
    || update.edited_business_message
    || update.message
    || update.edited_message
    || update.channel_post
    || update.edited_channel_post;
  if (!message) return null;
  const origin = messageOrigin(message);
  if (username(origin.username) !== username(channel)) return null;
  const text = String(message.text || message.caption || '').trim();
  if (!text || !Number.isSafeInteger(Number(origin.postId))) return null;
  return {
    id: String(origin.postId),
    text,
    date: Number.isSafeInteger(message.date) ? new Date(message.date * 1000).toISOString() : null,
    sourceChatId: String(origin.chatId ?? ''),
    receivedAt: new Date().toISOString(),
    businessConnectionId: message.business_connection_id || null,
  };
}

function connectionFrom(update) {
  const connection = update.business_connection;
  if (!connection) return null;
  return {
    id: connection.id,
    userId: String(connection.user?.id ?? ''),
    isEnabled: Boolean(connection.is_enabled),
    date: Number.isSafeInteger(connection.date) ? new Date(connection.date * 1000).toISOString() : null,
  };
}

export function applyBusinessUpdates(previous, updates, { channel = DEFAULT_CHANNEL, maxMessages = 500 } = {}) {
  const state = { ...emptyState(), ...previous, messages: [...(previous?.messages || [])] };
  let changed = false;
  for (const update of updates) {
    const updateId = Number(update?.update_id);
    if (Number.isSafeInteger(updateId) && updateId >= state.lastUpdateId) {
      state.lastUpdateId = updateId + 1;
      changed = true;
    }
    const connection = connectionFrom(update);
    if (connection) {
      state.businessConnection = connection;
      changed = true;
    }
    const message = cachedMessage(update, channel);
    if (!message) continue;
    const key = `${message.sourceChatId}:${message.id}`;
    const existing = state.messages.findIndex(item => `${item.sourceChatId}:${item.id}` === key);
    if (existing >= 0) state.messages.splice(existing, 1, message);
    else state.messages.push(message);
    changed = true;
  }
  state.messages.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.id) - Number(a.id));
  state.messages = state.messages.slice(0, maxMessages);
  if (changed) state.updatedAt = new Date().toISOString();
  return { state, changed };
}

export async function readBusinessState(path = DEFAULT_STATE_PATH) {
  try {
    return { ...emptyState(), ...JSON.parse(await readFile(path, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

export async function writeBusinessState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

function configuredToken(env) {
  const token = String(env.TELEGRAM_BUSINESS_BOT_TOKEN || '').trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error('Telegram Business Bot API не настроен: нужен TELEGRAM_BUSINESS_BOT_TOKEN');
  }
  return token;
}

async function botApi(token, method, payload, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok || !body?.ok) {
    throw new Error(`Telegram Bot API: ${body?.description || `HTTP ${response.status}`}`);
  }
  return body.result;
}

export async function pollBusinessUpdates({
  env = process.env,
  statePath = env.TELEGRAM_BSA_STATE_PATH || DEFAULT_STATE_PATH,
  channel = env.TELEGRAM_BSA_CHANNEL || DEFAULT_CHANNEL,
  timeout = 0,
  fetchImpl = fetch,
  signal,
} = {}) {
  const token = configuredToken(env);
  const previous = await readBusinessState(statePath);
  const updates = await botApi(token, 'getUpdates', {
    offset: previous.lastUpdateId,
    limit: 100,
    timeout,
    allowed_updates: ALLOWED_UPDATES,
  }, { fetchImpl, signal });
  const result = applyBusinessUpdates(previous, updates, { channel });
  if (!result.state.updatedAt) result.state.updatedAt = new Date().toISOString();
  if (result.changed || !previous.updatedAt) await writeBusinessState(statePath, result.state);
  return { ...result, received: updates.length };
}

const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason || new Error('Остановлено'));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, milliseconds);
  signal?.addEventListener('abort', onAbort, { once: true });
});

export function startBsaBusinessPolling({ env = process.env, logger = console } = {}) {
  if (!String(env.TELEGRAM_BUSINESS_BOT_TOKEN || '').trim()) {
    return { enabled: false, stop: async () => {} };
  }
  const controller = new AbortController();
  const done = (async () => {
    while (!controller.signal.aborted) {
      try {
        await pollBusinessUpdates({ env, timeout: 45, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) break;
        logger.error(`BSA Business API: ${error.message}`);
        try { await wait(5000, controller.signal); } catch { break; }
      }
    }
  })();
  return {
    enabled: true,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

export async function readCachedBsaMessages({ env = process.env } = {}) {
  const statePath = env.TELEGRAM_BSA_STATE_PATH || DEFAULT_STATE_PATH;
  const state = await readBusinessState(statePath);
  if (!state.messages.length) {
    const connection = state.businessConnection?.isEnabled ? 'подключение активно' : 'подключение ещё не подтверждено';
    throw new Error(`BSA Business API ещё не получил прайс-лист из @${env.TELEGRAM_BSA_CHANNEL || DEFAULT_CHANNEL} (${connection})`);
  }
  return state.messages;
}
