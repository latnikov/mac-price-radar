import { createHash } from 'node:crypto';
import { fail } from './core.mjs';
import { suggestSegment } from './crm-desk.mjs';

export const telegramText = text => Array.isArray(text) ? text.map(x => typeof x === 'string' ? x : String(x?.text || '')).join('') : String(text || '');
export function importTelegramExport(store, inbox, desk, data, sourceHash, expectedOwner = '') {
  const owner = data.personal_information;
  if (!owner?.user_id || String(owner.username || '').replace(/^@/, '').toLowerCase() !== 'macbookbro') throw fail(400, 'Экспорт должен принадлежать рабочему аккаунту @macbookbro.');
  if (expectedOwner && String(owner.user_id) !== String(expectedOwner)) throw fail(400, 'Экспорт принадлежит другому аккаунту Telegram.');
  const chats = data.chats?.list;
  if (!Array.isArray(chats)) throw fail(400, 'Нужен полный JSON-экспорт Telegram Desktop.');
  const account = inbox.saveAccount('telegram', owner.user_id, '@macbookbro');
  const hash = sourceHash || createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const importId = createHash('sha256').update(`telegram:${owner.user_id}:${hash}`).digest('hex');
  store.db.prepare(`INSERT INTO crm_imports(id,channel,account_id,source_hash,started_at,state) VALUES(?,?,?,?,?,'importing')
    ON CONFLICT(id) DO UPDATE SET state='importing',started_at=excluded.started_at`).run(importId, 'telegram', account.id, hash, store.now());
  let dialogs = 0, messages = 0, excluded = 0, latestMessageAt = 0;
  try {
    for (const source of chats) {
      if (source.type !== 'personal_chat') { excluded++; continue; }
      if (!source.id || !Array.isArray(source.messages)) throw fail(400, 'Некорректный диалог экспорта.');
      const batch = source.messages.map(m => {
        const createdAt = Number(m.date_unixtime) * 1000;
        if (!m.id || !Number.isFinite(createdAt) || createdAt <= 0) throw fail(400, 'Сообщение без ID или даты.');
        const kind = m.type === 'service' ? 'service' : m.media_type || (m.photo ? 'photo' : m.file ? 'file' : 'text');
        const body = telegramText(m.text) || (kind === 'service' ? `[${m.action || 'Служебное событие'}]` : `[${kind}]`);
        const sender = String(m.from_id || '');
        return { id: String(m.id), createdAt, kind, body,
          direction: m.type === 'service' ? 'system' : sender === `user${owner.user_id}` ? 'out' : sender === `user${source.id}` ? 'in' : 'system' };
      });
      store.tx(() => {
        const old = store.db.prepare('SELECT * FROM inbox_dialogs WHERE account_id=? AND remote_id=?').get(account.id, String(source.id));
        const updatedAt = batch.reduce((n, m) => Math.max(n, m.createdAt), 1);
        // An offline archive does not know read state and must not overwrite a newer live status.
        const d = inbox.saveDialog(account.id, { id: source.id, title: old?.updated_at > updatedAt ? old.title : source.name || 'Контакт Telegram', updatedAt, unread: old?.unread >= 0 ? Boolean(old.unread) : null });
        inbox.saveMessages(d.id, batch, { onlyMissing: true });
        store.db.prepare(`INSERT INTO inbox_archives VALUES(?,?,?,?) ON CONFLICT(dialog_id) DO UPDATE SET
          import_id=CASE WHEN excluded.through_at>=through_at THEN excluded.import_id ELSE import_id END,
          through_at=MAX(through_at,excluded.through_at),message_count=MAX(message_count,excluded.message_count)`).run(d.id, importId, updatedAt, batch.length);
        // An export has a coverage date; it does not establish complete cloud history.
        if (!store.db.prepare('SELECT 1 FROM telegram_dialog_connections WHERE dialog_id=?').get(d.id)) store.db.prepare('UPDATE inbox_dialogs SET history_complete=0 WHERE id=?').run(d.id);
        latestMessageAt = Math.max(latestMessageAt, updatedAt);
        desk.ensureCustomer(d.id, { name: source.name, source: 'Telegram Desktop — архив',
          segment: suggestSegment(batch.filter(m => m.direction === 'in').slice(-100).map(m => m.body).join('\n')) });
      });
      dialogs++; messages += batch.length;
    }
    store.db.prepare("UPDATE crm_imports SET state='complete',completed_at=?,dialogs=?,messages=? WHERE id=?").run(store.now(), dialogs, messages, importId);
    store.db.prepare("UPDATE inbox_accounts SET state=CASE WHEN state='live' THEN state ELSE 'archive' END,synced_at=? WHERE id=?").run(store.now(), account.id);
    store.setSetting('telegram_export', { at: store.now(), dialogs, messages, excluded, hash, latestMessageAt });
    return { dialogs, messages, excluded };
  } catch (error) {
    store.db.prepare("UPDATE crm_imports SET state='partial',dialogs=?,messages=? WHERE id=?").run(dialogs, messages, importId);
    throw error;
  }
}
