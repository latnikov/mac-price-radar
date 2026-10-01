import { fail } from './core.mjs';

export function createAvitoInboxApi({ clientId, clientSecret, fetchImpl = fetch }) {
  let accessToken, expiresAt = 0;
  async function request(path, options = {}, authenticated = true) {
    if (authenticated && (!accessToken || Date.now() >= expiresAt)) {
      const result = await request('/token', {
        method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
      }, false);
      accessToken = result.access_token;
      if (!accessToken) throw fail(502, 'Авито не вернул токен.');
      expiresAt = Date.now() + Math.max(0, (Number(result.expires_in) || 3600) - 60) * 1000;
    }
    let response;
    try {
      response = await fetchImpl(`https://api.avito.ru${path}`, {
        ...options, headers: { ...options.headers, ...(authenticated ? { Authorization: `Bearer ${accessToken}` } : {}) },
        signal: AbortSignal.timeout(20000), redirect: 'error',
      });
    } catch { throw fail(502, 'Не удалось связаться с Авито.'); }
    if (!response.ok) {
      if (response.status === 401) expiresAt = 0;
      const message = response.status === 402 ? 'Авито требует тариф с доступом к истории мессенджера (HTTP 402).'
        : response.status === 429 ? 'Авито ограничил частоту запросов. Повторите позже.' : `Авито: HTTP ${response.status}.`;
      throw fail(502, message);
    }
    return response.json();
  }
  const account = () => request('/core/v1/accounts/self');
  const chats = (accountId, offset = 0) => request(`/messenger/v2/accounts/${encodeURIComponent(accountId)}/chats?limit=100&offset=${offset}`);
  const history = (accountId, chatId, offset = 0) => request(`/messenger/v3/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(chatId)}/messages/?limit=100&offset=${offset}`);
  async function send(accountId, chatId, body) {
    const result = await request(`/messenger/v1/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'text', message: { text: body } }),
    });
    return { id: result.id, createdAt: Number(result.created) * 1000 };
  }
  return { account, chats, history, send };
}

export const avitoMessage = message => ({
  id: String(message.id), direction: message.direction === 'out' ? 'out' : message.direction === 'in' ? 'in' : 'system',
  body: message.content?.text || (message.type === 'image' ? '[Фотография]' : `[${message.type || 'Сообщение'}]`),
  kind: message.type || 'text', createdAt: Number(message.created) * 1000,
});

// Imports never call the remote read-mark endpoint or filter for unread chats.
export async function importAvitoInbox(store, inbox, api, label = 'Авито 1') {
  const identity = await api.account();
  if (!identity.id) throw fail(502, 'Авито не вернул ID аккаунта.');
  const account = inbox.saveAccount('avito', identity.id, label);
  store.db.prepare("UPDATE inbox_accounts SET state='importing' WHERE id=?").run(account.id);
  let offset = 0, dialogs = 0, messages = 0, listComplete = true;
  try {
    while (true) {
      const result = await api.chats(identity.id, offset);
      if (!Array.isArray(result.chats)) throw fail(502, 'Авито вернул неизвестный формат списка диалогов.');
      if (!result.chats.length && result.meta?.has_more) throw fail(502, 'Авито вернул пустую промежуточную страницу.');
      for (const chat of result.chats) {
        const customer = chat.users?.find(user => String(user.id) !== String(identity.id));
        const d = inbox.saveDialog(account.id, {
          id: chat.id, title: `${customer?.name || 'Клиент'}${chat.context?.value?.title ? ` · ${chat.context.value.title}` : ''}`,
          unread: typeof chat.last_message?.read === 'boolean' ? chat.last_message.direction === 'in' && !chat.last_message.read
            : chat.last_message?.read ? false : null, updatedAt: Number(chat.updated) * 1000,
        });
        if (chat.last_message) inbox.saveMessages(d.id, [avitoMessage(chat.last_message)]);
        dialogs++;
      }
      offset += result.chats.length;
      if (!result.meta?.has_more) break;
      if (offset > 1000) { listComplete = false; break; }
    }
    // List all chats before loading history; a tariff failure still leaves the available dialog list.
    const rows = store.db.prepare('SELECT * FROM inbox_dialogs WHERE account_id=? ORDER BY id').all(account.id);
    for (const d of rows) {
      let historyOffset = 0; // Rescan mutable histories from newest, deduplicating stable remote IDs.
      while (true) {
        const result = await api.history(identity.id, d.remote_id, historyOffset);
        const batch = Array.isArray(result) ? result : result.messages;
        if (!Array.isArray(batch)) throw fail(502, 'Авито вернул неизвестный формат истории.');
        inbox.saveMessages(d.id, batch.map(avitoMessage));
        messages += batch.length; historyOffset += batch.length;
        const hasMore = result.meta?.has_more ?? (batch.length === 100);
        if (!batch.length && hasMore) throw fail(502, 'Авито вернул пустую промежуточную страницу истории.');
        store.db.prepare('UPDATE inbox_dialogs SET history_offset=?,history_complete=? WHERE id=?').run(historyOffset, hasMore ? 0 : 1, d.id);
        if (!hasMore) break;
        if (historyOffset > 1000) throw fail(502, 'История диалога превышает глубину пагинации Авито. Требуется дополнительная выгрузка.');
      }
    }
    if (!listComplete) throw fail(502, 'Список превышает глубину пагинации Авито. Требуется выгрузка по объявлениям.');
    store.db.prepare("UPDATE inbox_accounts SET state='ready',synced_at=? WHERE id=?").run(store.now(), account.id);
    return { accountId: account.id, dialogs, messages, complete: true };
  } catch (error) {
    store.db.prepare("UPDATE inbox_accounts SET state='partial' WHERE id=?").run(account.id);
    throw error;
  }
}
