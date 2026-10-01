import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createAvitoInboxApi, avitoMessage } from './avito-inbox.mjs';
import { normalizeAccountPhone } from './accounts.mjs';

const msRoot = 'https://api.moysklad.ru/api/remap/1.2';
export function configuredSecret(env, name) { return env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`], 'utf8').trim() : env[name] || ''; }
export function createDataSync(store, inbox, { env = process.env, fetchImpl = fetch } = {}) {
  const { db, now, tx } = store;
  function status(channel, accountId, state, { cursor = null, error = null, success = false } = {}) {
    db.prepare(`INSERT INTO sync_state(channel,account_id,state,cursor,last_success,last_attempt,error) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(channel,account_id) DO UPDATE SET state=excluded.state,cursor=COALESCE(excluded.cursor,sync_state.cursor),last_success=COALESCE(excluded.last_success,sync_state.last_success),last_attempt=excluded.last_attempt,error=excluded.error`)
      .run(channel, accountId, state, cursor ? JSON.stringify(cursor) : null, success ? now() : null, now(), error);
  }
  const token = configuredSecret(env, 'STORE_MOYSKLAD_TOKEN');
  const avitoApis = ['AVITO', 'AVITO_2'].map(prefix => ({ prefix, expectedId: String(env[`${prefix}_ACCOUNT_ID`] || ''), label: env[`${prefix}_LABEL`] || (prefix === 'AVITO' ? 'Авито 1' : 'Авито 2'),
    api: env[`${prefix}_CLIENT_ID`] && env[`${prefix}_CLIENT_SECRET`] ? createAvitoInboxApi({ clientId: env[`${prefix}_CLIENT_ID`], clientSecret: env[`${prefix}_CLIENT_SECRET`], fetchImpl }) : null }));
  status('МойСклад', '', token ? 'pending' : 'blocked', { error: token ? null : 'Нужен доступ к учётному аккаунту' });
  for (const a of avitoApis) status('Авито', a.label, a.api ? 'pending' : 'blocked', { error: a.api ? null : 'Нужны отдельные ключи этого профиля' });
  status('Telegram', '@macbookbro', configuredSecret(env, 'STORE_TELEGRAM_INGEST_TOKEN') ? 'pending' : 'blocked', { error: configuredSecret(env, 'STORE_TELEGRAM_INGEST_TOKEN') ? null : 'Нужны авторизация рабочего аккаунта и подключение синхронизации' });

  async function msGet(path) {
    let response;
    try { response = await fetchImpl(`${msRoot}/${path}`, { redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(20000) }); }
    catch { throw new Error('Нет ответа МойСклад'); }
    if (!response.ok) throw Object.assign(new Error(response.status === 429 ? 'МойСклад ограничил частоту запросов' : response.status === 401 || response.status === 403 ? 'Проверьте права МойСклад' : `МойСклад: HTTP ${response.status}`),{auth:response.status===401});
    const data = await response.json();
    if (!Array.isArray(data.rows)) throw new Error('Неизвестный формат данных МойСклад');
    return data;
  }
  function ingestMoysklad(type, rows) {
    tx(() => {
      for (const row of rows) {
        if (!row.id) throw new Error('МойСклад не передал идентификатор записи');
        db.prepare(`INSERT INTO ms_objects VALUES(?,?,?,?,?) ON CONFLICT(type,remote_id) DO UPDATE SET data=excluded.data,remote_updated=excluded.remote_updated,imported_at=excluded.imported_at`)
          .run(type, String(row.id), JSON.stringify(row), row.updated || null, now());
        if (type === 'counterparty') {
          const existing = db.prepare('SELECT id FROM customers WHERE moysklad_id=?').get(row.id);
          if (!existing) {
            let phone = ''; try { phone = row.phone ? normalizeAccountPhone(row.phone) : ''; } catch { /* Multiple or foreign numbers remain in the original private record. */ }
            // External IDs, not names or user-supplied contacts, establish this identity.
            db.prepare('INSERT INTO customers(id,name,phone,email,moysklad_id,updated_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), String(row.name || '').slice(0, 120), phone, String(row.email || '').slice(0, 254), String(row.id), now());
          }
        }

      }
      if(type==='customerorder')for(const code of new Set(rows.map(r=>r.externalCode).filter(c=>/^MB-[A-F0-9]{12}$/.test(c||'')))){
        const order=db.prepare('SELECT id FROM orders WHERE id=?').get(code);if(!order)continue;
        const matches=db.prepare("SELECT remote_id FROM ms_objects WHERE type='customerorder' AND json_extract(data,'$.externalCode')=?").all(code);
        const previous=db.prepare("SELECT remote_id FROM publications WHERE entity='order' AND entity_id=? AND channel='moysklad'").get(code);
        if(matches.length!==1||(previous?.remote_id&&previous.remote_id!==matches[0].remote_id)){
          db.prepare("UPDATE publications SET state='conflict',detail='Several remote orders or a different linked ID: owner review required' WHERE entity='order' AND entity_id=? AND channel='moysklad'").run(code);
          db.prepare("UPDATE jobs SET state='blocked',error='Several remote orders require owner review' WHERE entity='order' AND entity_id=? AND channel='moysklad' AND state IN ('queued','retry')").run(code);
        }else db.prepare("INSERT INTO publications VALUES('order',?,'moysklad',?,1,'published',NULL,?) ON CONFLICT(entity,entity_id,channel) DO UPDATE SET remote_id=excluded.remote_id,state='published',detail=NULL,updated_at=excluded.updated_at").run(code,matches[0].remote_id,now());
      }
    });
  }
  async function syncMoysklad() {
    if (!token) return;
    const entities = ['counterparty', 'product', 'variant', 'customerorder', 'supply', 'demand', 'salesreturn', 'enter', 'loss', 'paymentin', 'cashin'];
    for (const entity of entities) {
      const channel = `МойСклад · ${entity}`, previous = db.prepare('SELECT cursor FROM sync_state WHERE channel=? AND account_id=?').get(channel, '');
      const cursor = previous?.cursor ? JSON.parse(previous.cursor) : {};
      status(channel, '', 'syncing');
      try {
        let offset = 0, imported = 0, updated = cursor.updated || null;
        while (true) {
          const filter = cursor.updated ? `updated>=${cursor.updated}` : ['supply', 'demand', 'salesreturn', 'enter', 'loss', 'paymentin', 'cashin'].includes(entity) ? 'moment>=2026-01-01 00:00:00' : '';
          const params = new URLSearchParams({ limit: '100', offset: String(offset), order: 'updated' }); if (filter) params.set('filter', filter);
          const result = await msGet(`entity/${entity}?${params}`);
          ingestMoysklad(entity, result.rows);
          for (const r of result.rows) if (r.updated && (!updated || r.updated > updated)) updated = r.updated;
          imported += result.rows.length; offset += result.rows.length;
          if (result.rows.length < 100) { if (Number(result.meta?.size) > offset) throw new Error('МойСклад вернул неполную страницу'); break; }
          if (offset > 100000) throw new Error('Начальный импорт слишком велик: нужна поэтапная загрузка');
        }
        status(channel, '', 'ready', { cursor: { updated, imported }, success: true });
      } catch (e) { status(channel, '', 'error', { error: String(e.message).startsWith('МойСклад') || String(e.message).startsWith('Нет ответа') || String(e.message).startsWith('Неизвестный') ? e.message : 'Не удалось завершить импорт; сохранённые страницы доступны' });if(e.auth){status('МойСклад','','error',{error:'Доступ отклонён: нужен действующий API-токен'});return;} }
    }
    // Current stock is a separate report, never reconstructed from the 2026 purchase cohort.
    try {
      let offset = 0, stock = 0; const snapshot=[];
      while (true) {
        const data = await msGet(`report/stock/all?limit=100&offset=${offset}`);
        const rows = data.rows.map(row => ({ ...row, id: row.assortment?.id || row.meta?.href?.split('/').pop() })).filter(r => r.id);
        if(rows.length!==data.rows.length)throw new Error('invalid_stock_id');
        snapshot.push(...rows); stock += rows.length; offset += data.rows.length;
        if (data.rows.length < 100) break;
        if (offset > 100000) throw new Error('stock_limit');
      }
      tx(()=>{db.prepare("DELETE FROM ms_objects WHERE type='stock'").run();ingestMoysklad('stock',snapshot);});
      status('МойСклад · остатки', '', 'ready', { cursor: { rows: stock }, success: true });
    } catch { status('МойСклад · остатки', '', 'error', { error: 'Не удалось обновить текущий отчёт остатков' }); }
    const states = db.prepare("SELECT state FROM sync_state WHERE channel LIKE 'МойСклад · %'").all();
    const complete = states.every(s => s.state === 'ready');
    status('МойСклад', '', complete ? 'ready' : 'partial', { success: complete, error: complete ? null : 'Часть данных требует проверки прав или повторного чтения' });
  }
  async function syncAvito(a) {
    if (!a.api) return;
    status('Авито', a.label, 'syncing');
    try {
      const identity = await a.api.account();
      if (!identity.id || (a.expectedId && String(identity.id) !== a.expectedId)) throw new Error('identity_mismatch');
      const account = inbox.saveAccount('avito', identity.id, a.label);
      const old = db.prepare('SELECT last_success FROM sync_state WHERE channel=? AND account_id=?').get('Авито', a.label);
      let offset = 0, partial = false, historyAllowed = true, changed = 0;
      do {
        const list = await a.api.chats(identity.id, offset);
        if (!Array.isArray(list.chats)) throw new Error('invalid_chats');
        for (const chat of list.chats) {
          const person = chat.users?.find(u => String(u.id) !== String(identity.id));
          const d = inbox.saveDialog(account.id, { id: chat.id, title: `${person?.name || 'Клиент'}${chat.context?.value?.title ? ` · ${chat.context.value.title}` : ''}`, unread: typeof chat.last_message?.read === 'boolean' ? chat.last_message.direction === 'in' && !chat.last_message.read : null, updatedAt: Number(chat.updated) * 1000 });
          if (chat.last_message) inbox.saveMessages(d.id, [avitoMessage(chat.last_message)]);
          const needsHistory=!d.history_complete || !old?.last_success || Number(chat.updated)*1000>=old.last_success;
          if(needsHistory && (!historyAllowed || changed>=20))partial=true;
          if (historyAllowed && needsHistory && changed++ < 20) {
            try { const result = await a.api.history(identity.id, chat.id, 0), batch = Array.isArray(result) ? result : result.messages;
              if (!Array.isArray(batch)) throw new Error('invalid_history'); inbox.saveMessages(d.id, batch.map(avitoMessage));
              db.prepare('UPDATE inbox_dialogs SET history_complete=? WHERE id=?').run(batch.length < 100 && !result.meta?.has_more ? 1 : 0, d.id);
              if (batch.length === 100 || result.meta?.has_more) partial = true;
            } catch { partial = true; historyAllowed = false; db.prepare('UPDATE inbox_dialogs SET history_complete=0 WHERE id=?').run(d.id); }
          }
        }
        offset += list.chats.length;
        if (!list.meta?.has_more) break;
        if (!list.chats.length) throw new Error('empty_page');
        if (offset > 1000) { partial = true; break; }
      } while (true);
      db.prepare('UPDATE inbox_accounts SET state=?,synced_at=? WHERE id=?').run(partial ? 'partial' : 'ready', now(), account.id);
      status('Авито', a.label, partial ? 'partial' : 'ready', { success: true, error: partial ? 'Новые сообщения получены; полнота истории требует тарифа и проверки пагинации' : null });
    } catch { status('Авито', a.label, 'error', { error: 'Проверьте доступ, тариф и идентификатор подключённого профиля' }); }
  }
  let running = false;
  async function sync() {
    if (running) return; running = true;
    try { await Promise.allSettled([syncMoysklad(),...avitoApis.map(syncAvito)]); }
    finally { running = false; }
  }
  function ingestTelegram(packet) {
    if (String(packet.username || '').toLowerCase() !== 'macbookbro' || !/^\d+$/.test(String(packet.accountId || ''))) throw new Error('invalid_telegram_account');
    if (env.STORE_TELEGRAM_ACCOUNT_ID && String(packet.accountId) !== String(env.STORE_TELEGRAM_ACCOUNT_ID)) throw new Error('telegram_identity_mismatch');
    if (!Array.isArray(packet.dialogs) || packet.dialogs.length > 100) throw new Error('invalid_telegram_batch');
    const account = inbox.saveAccount('telegram', packet.accountId, '@macbookbro');
    tx(() => {
      for (const source of packet.dialogs) {
        if (!Array.isArray(source.messages) || source.messages.length > 100) throw new Error('invalid_messages');
        const d = inbox.saveDialog(account.id, { id: source.id, title: source.title, unread: source.unread, updatedAt: source.updatedAt });
        inbox.saveMessages(d.id, source.messages);
        if (source.complete === true) db.prepare('UPDATE inbox_dialogs SET history_complete=1 WHERE id=?').run(d.id);
      }
      const complete=packet.complete===true||(packet.live===true&&account.state==='ready');
      db.prepare("UPDATE inbox_accounts SET state=?,synced_at=? WHERE id=?").run(complete ? 'ready' : 'partial', now(), account.id);
      status('Telegram', '@macbookbro', complete ? 'ready' : 'partial', { success: true, error: complete ? null : 'Импорт облачной истории продолжается' });
    });
  }
  return { sync, syncMoysklad, ingestMoysklad, ingestTelegram, status };
}
