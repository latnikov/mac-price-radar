import { readBusinessState } from './telegram-business.mjs';

export function telegramSource(source, env = process.env) {
  const sourceChatId = String(source.sourceChatId || '');
  if (!/^-\d+$/.test(sourceChatId)) return null;
  const sourceUsername = String(source.sourceUsername || '').replace(/^@/, '');
  const retailer = sourceChatId === String(env.TELEGRAM_DIMA_CHAT_ID || '-1003421701174') ? 'Дима'
    : sourceChatId === String(env.TELEGRAM_BSA_CHAT_ID || '-1001291236326') || sourceUsername.toLowerCase() === String(env.TELEGRAM_BSA_CHANNEL || 'BigSaleApple').replace(/^@/, '').toLowerCase() ? 'BSA'
      : `Telegram:${sourceChatId}`;
  return { retailer, sourceType: 'telegram_channel', sourceChatId, sourceUsername,
    sourceTitle: String(source.sourceTitle || sourceUsername || `Канал ${sourceChatId}`).slice(0, 160) };
}

export function telegramSources(state, env = process.env) {
  const sources = new Map();
  // Latest channel title wins; identity always comes from its numeric ID.
  for (const message of [...(state.messages || [])].sort((a, b) => String(b.receivedAt || b.date || '').localeCompare(String(a.receivedAt || a.date || '')))) {
    const source = telegramSource(message, env);
    if (source && !sources.has(source.retailer)) sources.set(source.retailer, source);
  }
  return [...sources.values()];
}

export async function readTelegramSources(env = process.env) {
  return telegramSources(await readBusinessState(env.TELEGRAM_BSA_STATE_PATH), env);
}
