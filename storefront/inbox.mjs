import { randomUUID, createHash } from 'node:crypto';
import { fail } from './core.mjs';

const key = (...parts) => createHash('sha256').update(JSON.stringify(parts.map(String))).digest('hex');
const text = (value, max = 5000) => String(value ?? '').slice(0, max);

export function openInbox(store, { recoverOutbox = true } = {}) {
  const { db, now, tx, audit } = store;
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_accounts(id TEXT PRIMARY KEY, channel TEXT NOT NULL, remote_id TEXT NOT NULL,
      label TEXT NOT NULL, synced_at INTEGER, state TEXT NOT NULL DEFAULT 'pending', UNIQUE(channel,remote_id));
    CREATE TABLE IF NOT EXISTS inbox_dialogs(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, remote_id TEXT NOT NULL,
      title TEXT NOT NULL, unread INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, history_complete INTEGER NOT NULL DEFAULT 0,
      history_offset INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', segment TEXT NOT NULL DEFAULT '', UNIQUE(account_id,remote_id));
    CREATE TABLE IF NOT EXISTS inbox_messages(id TEXT PRIMARY KEY, dialog_id TEXT NOT NULL, remote_id TEXT NOT NULL,
      direction TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(dialog_id,remote_id));
    CREATE INDEX IF NOT EXISTS inbox_message_history ON inbox_messages(dialog_id,created_at,id);
    CREATE INDEX IF NOT EXISTS inbox_dialog_recent ON inbox_dialogs(updated_at DESC,id);
    CREATE INDEX IF NOT EXISTS inbox_account_recent ON inbox_dialogs(account_id,updated_at DESC,id);
    CREATE TABLE IF NOT EXISTS inbox_outbox(id TEXT PRIMARY KEY, dialog_id TEXT NOT NULL, body TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft', remote_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `);
  if(recoverOutbox)db.prepare("UPDATE inbox_outbox SET state='unknown' WHERE state='sending'").run();
  const account = id => db.prepare('SELECT * FROM inbox_accounts WHERE id=?').get(id);
  const accounts = () => db.prepare('SELECT * FROM inbox_accounts ORDER BY channel,label').all();
  function saveAccount(channel, remoteId, label) {
    if (!['avito', 'telegram'].includes(channel) || !remoteId) throw fail(400, 'Неизвестный аккаунт.');
    const id = key(channel, remoteId);
    db.prepare(`INSERT INTO inbox_accounts(id,channel,remote_id,label) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label`).run(id, channel, String(remoteId), text(label, 100));
    return account(id);
  }
  const dialog = id => db.prepare(`SELECT d.*,a.channel,a.label AS account_label,a.remote_id AS account_remote_id,x.through_at AS archive_through,x.message_count AS archive_messages
    FROM inbox_dialogs d JOIN inbox_accounts a ON a.id=d.account_id LEFT JOIN inbox_archives x ON x.dialog_id=d.id WHERE d.id=?`).get(id);
  function saveDialog(accountId, input) {
    if (!account(accountId) || !input.id) throw fail(400, 'Неизвестный диалог.');
    const id = key(accountId, input.id);
    db.prepare(`INSERT INTO inbox_dialogs(id,account_id,remote_id,title,unread,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,unread=excluded.unread,updated_at=MAX(updated_at,excluded.updated_at)`)
      .run(id, accountId, String(input.id), text(input.title || 'Клиент', 200), input.unread == null ? -1 : input.unread ? 1 : 0, Number(input.updatedAt) || now());
    return dialog(id);
  }
  function saveMessages(dialogId, messages, { onlyMissing = false } = {}) {
    if (!dialog(dialogId)) throw fail(404, 'Диалог не найден.');
    return tx(() => {
      const insert = db.prepare(`INSERT INTO inbox_messages(id,dialog_id,remote_id,direction,body,kind,created_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(dialog_id,remote_id) ${onlyMissing?'DO NOTHING':'DO UPDATE SET body=excluded.body,kind=excluded.kind,direction=excluded.direction'}`);
      for (const m of messages) {
        if (!m.id || !['in', 'out', 'system'].includes(m.direction)) throw fail(400, 'Некорректное сообщение.');
        insert.run(key(dialogId, m.id), dialogId, String(m.id), m.direction, text(m.body, 50000), text(m.kind || 'text', 40), Number(m.createdAt) || now());
      }
    });
  }
  function list({ q = '', accountId = '', unread = false, offset = 0, limit = 50 } = {}) {
    return db.prepare(`SELECT d.*,a.channel,a.label AS account_label,
      (SELECT body FROM inbox_messages WHERE dialog_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1) AS preview
      FROM inbox_dialogs d JOIN inbox_accounts a ON a.id=d.account_id
      WHERE (?='' OR d.account_id=?) AND (?=0 OR d.unread>0)
      AND (?='' OR instr(casefold(d.title),casefold(?))>0 OR EXISTS
        (SELECT 1 FROM inbox_messages m WHERE m.dialog_id=d.id AND instr(casefold(m.body),casefold(?))>0))
      ORDER BY d.updated_at DESC,d.id LIMIT ? OFFSET ?`)
      .all(accountId, accountId, unread ? 1 : 0, q, q, q, Math.min(100, limit), Math.max(0, offset));
  }
  const messages = (id, offset = 0) => db.prepare('SELECT * FROM inbox_messages WHERE dialog_id=? ORDER BY created_at DESC,id DESC LIMIT 100 OFFSET ?').all(id, offset).reverse();
  const outgoing = id => db.prepare('SELECT * FROM inbox_outbox WHERE dialog_id=? ORDER BY created_at DESC LIMIT 20').all(id);
  function edit(id, { note, segment }, actor) {
    if (!dialog(id)) throw fail(404, 'Диалог не найден.');
    db.prepare('UPDATE inbox_dialogs SET note=?,segment=? WHERE id=?').run(text(note, 5000), text(segment, 100), id);
    audit(actor, 'inbox_dialog_updated', id);
  }
  function draft(dialogId, body, actor) {
    if (!dialog(dialogId)) throw fail(404, 'Диалог не найден.');
    const value = String(body || '').trim();
    if (!value || value.length > 4000) throw fail(400, 'Введите ответ длиной до 4000 символов.');
    const id = randomUUID();
    db.prepare('INSERT INTO inbox_outbox(id,dialog_id,body,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, dialogId, value, now(), now());
    audit(actor, 'inbox_reply_drafted', id);
    return id;
  }
  async function send(id, adapter, actor) {
    const row = db.prepare('SELECT * FROM inbox_outbox WHERE id=?').get(id);
    if (!row) throw fail(404, 'Ответ не найден.');
    const d = dialog(row.dialog_id);
    if (!adapter) throw fail(503, 'Отправка для этого аккаунта ещё не подключена. Черновик сохранён.');
    if (row.state !== 'draft') throw fail(409, 'Ответ уже отправлялся. Проверьте историю перед повторной отправкой.');
    const claimed = db.prepare("UPDATE inbox_outbox SET state='sending',updated_at=? WHERE id=? AND state='draft'").run(now(), id);
    if (!claimed.changes) throw fail(409, 'Ответ уже отправляется.');
    try {
      const result = await adapter(d, row.body);
      if (!result?.id) throw new Error('Missing remote message identifier');
      tx(() => {
        saveMessages(d.id, [{ id: result.id, direction: 'out', body: row.body, kind: 'text', createdAt: result.createdAt || now() }]);
        db.prepare("UPDATE inbox_outbox SET state='sent',remote_id=?,updated_at=? WHERE id=?").run(String(result.id), now(), id);
        db.prepare('UPDATE inbox_dialogs SET updated_at=? WHERE id=?').run(now(), d.id);
        audit(actor, 'inbox_reply_sent', id);
      });
    } catch {
      db.prepare("UPDATE inbox_outbox SET state='unknown',updated_at=? WHERE id=?").run(now(), id);
      throw fail(502, 'Результат отправки неизвестен. Проверьте чат на площадке; автоматического повтора не будет.');
    }
  }
  return { account, accounts, saveAccount, dialog, saveDialog, saveMessages, list, messages, outgoing, edit, draft, send };
}
