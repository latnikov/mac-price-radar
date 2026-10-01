import { fail } from './core.mjs';
import { configuredSecret } from './data-sync.mjs';

// Updates are durably queued before acknowledging their offset. A foreign or
// malformed update cannot stall other customers, and deferred messages survive restart.
export function createTelegramBusinessCrm(store, inbox, desk, { env = process.env, fetchImpl = fetch } = {}) {
  const token = configuredSecret(env, 'STORE_CRM_TELEGRAM_BOT_TOKEN');
  const expectedBot = String(env.STORE_CRM_TELEGRAM_EXPECTED_BOT || 'mbroadmin_bot').replace(/^@/, '').toLowerCase();
  const ownerId = String(env.STORE_TELEGRAM_ACCOUNT_ID || '');
  let checked = false, busy = false;
  async function call(method, data = {}) {
    let response, result;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {method:'POST',body:JSON.stringify(data),headers:{'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(20000)});
      result = await response.json();
    } catch { throw fail(502, 'Telegram не ответил.'); }
    if (!response.ok || !result.ok) throw Object.assign(fail(502, `Telegram: HTTP ${response.status}. Проверьте подключение бизнес-бота.`), { remoteStatus: response.status });
    return result.result;
  }
  async function verify() {
    if (checked) return;
    if (!token || !/^\d+$/.test(ownerId)) throw fail(403, 'Нужны CRM-бот и подтверждённый аккаунт владельца.');
    const me = await call('getMe');
    if (me.is_bot !== true || me.username?.toLowerCase() !== expectedBot) throw fail(403, 'Проверьте выбранного CRM-бота.');
    const previous = store.setting('crm_telegram_bot_id');
    if (previous && String(previous) !== String(me.id)) throw fail(403, 'Изменился аккаунт CRM-бота; нужна проверка владельца.');
    const webhook = await call('getWebhookInfo');
    if (webhook.url) throw fail(409, 'У бота уже есть webhook. Подключите доставку событий к CRM.');
    store.setSetting('crm_telegram_bot_id', String(me.id)); checked = true;
  }
  const connection = id => store.db.prepare('SELECT * FROM telegram_connections WHERE id=?').get(String(id || ''));
  function saveConnection(source) {
    if (!source?.id || !ownerId || String(source.user?.id) !== ownerId) throw fail(403, 'Бизнес-бот подключён к другому аккаунту.');
    const old = connection(source.id);
    if (old && old.user_id !== ownerId) throw fail(403, 'Идентификатор подключения принадлежит другому аккаунту.');
    const account = inbox.saveAccount('telegram', ownerId, '@macbookbro');
    store.db.prepare(`INSERT INTO telegram_connections VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      enabled=excluded.enabled,can_reply=excluded.can_reply,updated_at=excluded.updated_at`)
      .run(String(source.id), account.id, ownerId, source.is_enabled === true ? 1 : 0, (source.rights?.can_reply ?? source.can_reply) === true ? 1 : 0, store.now());
    return connection(source.id);
  }
  function apply(update) {
    return store.tx(() => {
      if (!Number.isSafeInteger(update.update_id)) throw fail(400, 'Некорректный номер события.');
      if (store.db.prepare('SELECT 1 FROM telegram_updates WHERE update_id=?').get(update.update_id)) return;
      if (update.business_connection) {
        const id=String(update.business_connection.id||''),previous=store.db.prepare('SELECT update_id FROM telegram_connection_versions WHERE connection_id=?').get(id);
        if (!previous || previous.update_id<update.update_id) {
          saveConnection(update.business_connection);
          store.db.prepare('INSERT OR REPLACE INTO telegram_connection_versions VALUES(?,?)').run(id,update.update_id);
        }
      }
      const message = update.business_message || update.edited_business_message;
      if (message) {
        const conn = connection(message.business_connection_id);
        if (!conn) throw fail(409, 'Ожидает сведений о Business-подключении.');
        if (conn.user_id !== ownerId) throw fail(403, 'Другой бизнес-аккаунт.');
        if (message.chat?.type !== 'private' || !Number.isSafeInteger(message.message_id) || !(message.date > 0)) throw fail(400, 'Некорректное личное сообщение.');
        const old = store.db.prepare('SELECT unread FROM inbox_dialogs WHERE account_id=? AND remote_id=?').get(conn.account_id, String(message.chat.id));
        const direction = message.sender_business_bot || String(message.from?.id) === ownerId ? 'out' : String(message.from?.id) === String(message.chat.id) ? 'in' : 'system';
        const d = inbox.saveDialog(conn.account_id, { id:message.chat.id,title:[message.chat.first_name,message.chat.last_name].filter(Boolean).join(' ') || message.chat.username || 'Клиент Telegram',
          updatedAt:message.date*1000,unread:old?.unread>=0?Boolean(old.unread):null });
        const kind = message.photo?'photo':message.voice?'voice':message.document?'file':'text';
        const previous=store.db.prepare('SELECT update_id FROM telegram_message_versions WHERE dialog_id=? AND remote_id=?').get(d.id,String(message.message_id));
        if (!previous || previous.update_id<update.update_id) {
          inbox.saveMessages(d.id,[{id:message.message_id,direction,createdAt:message.date*1000,kind,body:message.text || message.caption || `[${kind}]`}]);
          store.db.prepare('INSERT OR REPLACE INTO telegram_message_versions VALUES(?,?,?)').run(d.id,String(message.message_id),update.update_id);
        }
        store.db.prepare('INSERT INTO telegram_dialog_connections VALUES(?,?) ON CONFLICT(dialog_id) DO UPDATE SET connection_id=excluded.connection_id').run(d.id,conn.id);
        desk.ensureCustomer(d.id,{source:'Telegram Business'});
      }
      if (update.deleted_business_messages) {
        const deleted=update.deleted_business_messages,conn=connection(deleted.business_connection_id);
        if (!conn) throw fail(409,'Ожидает сведений о Business-подключении.');
        if (conn.user_id!==ownerId) throw fail(403,'Другой бизнес-аккаунт.');
        if (!deleted.chat?.id || !Array.isArray(deleted.message_ids)) throw fail(400,'Некорректное удаление.');
        const existing=store.db.prepare('SELECT id FROM inbox_dialogs WHERE account_id=? AND remote_id=?').get(conn.account_id,String(deleted.chat.id));
        const d=existing?inbox.dialog(existing.id):inbox.saveDialog(conn.account_id,{id:deleted.chat.id,title:[deleted.chat.first_name,deleted.chat.last_name].filter(Boolean).join(' ') || 'Клиент Telegram',unread:null,updatedAt:store.now()});
        for(const id of deleted.message_ids){
          const previous=store.db.prepare('SELECT update_id FROM telegram_message_versions WHERE dialog_id=? AND remote_id=?').get(d.id,String(id));
          if (previous && previous.update_id>=update.update_id) continue;
          const old=store.db.prepare('SELECT * FROM inbox_messages WHERE dialog_id=? AND remote_id=?').get(d.id,String(id));
          inbox.saveMessages(d.id,[{id,direction:old?.direction||'system',createdAt:old?.created_at||store.now(),body:'[Сообщение удалено в Telegram]',kind:'deleted'}]);
          store.db.prepare('INSERT OR REPLACE INTO telegram_message_versions VALUES(?,?,?)').run(d.id,String(id),update.update_id);
        }
      }
      store.db.prepare('INSERT INTO telegram_updates VALUES(?,?)').run(update.update_id,store.now());
    });
  }
  function capability(d) {
    if (!token) return {allowed:false,reason:'Нужен токен CRM Business-бота'};
    const row=store.db.prepare('SELECT c.* FROM telegram_dialog_connections d JOIN telegram_connections c ON c.id=d.connection_id WHERE d.dialog_id=?').get(d.id);
    if (!row?.enabled || !row.can_reply || row.user_id!==ownerId) return {allowed:false,reason:'Клиент должен написать в диалог, доступный Business-боту'};
    const last=store.db.prepare("SELECT MAX(created_at) at FROM inbox_messages WHERE dialog_id=? AND direction='in'").get(d.id);
    if (!last.at || last.at>store.now()+60000 || store.now()-last.at>=86400000) return {allowed:false,reason:'Прошло 24 часа после сообщения клиента; ответьте в Telegram'};
    return {allowed:true,connectionId:row.id};
  }
  async function send(d, body) {
    await verify();
    let can=capability(d);if(!can.allowed)throw fail(403,can.reason);
    saveConnection(await call('getBusinessConnection',{business_connection_id:can.connectionId}));
    can=capability(d);if(!can.allowed)throw fail(403,can.reason);
    const result=await call('sendMessage',{business_connection_id:can.connectionId,chat_id:Number(d.remote_id),text:body});
    return {id:result.message_id,createdAt:result.date*1000};
  }
  async function processPending() {
    const rows=store.db.prepare("SELECT * FROM telegram_update_queue WHERE state='pending' AND next_at<=? ORDER BY update_id LIMIT 100").all(store.now());
    for(const row of rows){
      try{
        const update=JSON.parse(row.payload),source=update.business_message||update.edited_business_message||update.deleted_business_messages;
        if(source&&!connection(source.business_connection_id))saveConnection(await call('getBusinessConnection',{business_connection_id:source.business_connection_id}));
        store.tx(()=>{apply(update);store.db.prepare("UPDATE telegram_update_queue SET state='processed',payload='{}',error=NULL WHERE update_id=?").run(row.update_id);});
      }catch(e){
        if(e.status===400||e.status===403){store.db.prepare("UPDATE telegram_update_queue SET state='ignored',payload='{}',error=? WHERE update_id=?").run(e.message,row.update_id);}
        else store.db.prepare('UPDATE telegram_update_queue SET attempts=attempts+1,next_at=?,error=? WHERE update_id=?').run(store.now()+Math.min(300000,15000*2**Math.min(row.attempts,5)),'Событие ожидает повторной обработки',row.update_id);
      }
    }
  }
  function status(state,error=null,connected=false){
    store.setSetting('crm_telegram_status',{state,at:store.now(),connected,error,pending:store.db.prepare("SELECT COUNT(*) n FROM telegram_update_queue WHERE state='pending'").get().n});
    store.db.prepare(`INSERT INTO sync_state(channel,account_id,state,last_success,last_attempt,error) VALUES('Telegram','@macbookbro',?,?,?,?)
      ON CONFLICT(channel,account_id) DO UPDATE SET state=excluded.state,last_success=COALESCE(excluded.last_success,sync_state.last_success),last_attempt=excluded.last_attempt,error=excluded.error`).run(state,connected?store.now():null,store.now(),error);
  }
  async function poll() {
    if(busy)return;
    if(!token||!ownerId){status('blocked','Нужны CRM-бот и аккаунт владельца');return;}
    busy=true;
    try{
      await verify();
      const result=await call('getUpdates',{offset:store.setting('crm_telegram_offset')||0,timeout:0,limit:100,allowed_updates:['business_connection','business_message','edited_business_message','deleted_business_messages']});
      if(!Array.isArray(result))throw fail(502,'Неизвестный формат событий Telegram.');
      store.tx(()=>{for(const update of result){
        if(!Number.isSafeInteger(update.update_id))throw fail(502,'Неизвестный номер события Telegram.');
        store.db.prepare('INSERT OR IGNORE INTO telegram_update_queue(update_id,payload,received_at) VALUES(?,?,?)').run(update.update_id,JSON.stringify(update),store.now());
        store.setSetting('crm_telegram_offset',Math.max(store.setting('crm_telegram_offset')||0,update.update_id+1));
      }});
      await processPending();
      const connected=Boolean(store.db.prepare('SELECT 1 FROM telegram_connections WHERE enabled=1 AND user_id=?').get(ownerId));
      const pending=store.db.prepare("SELECT COUNT(*) n FROM telegram_update_queue WHERE state='pending'").get().n;
      status(connected?(pending?'partial':'ready'):'pending',connected?(pending?'Некоторые события ожидают повторной обработки':null):'Добавьте @'+expectedBot+' в Telegram → Настройки → Чат-боты и разрешите нужные диалоги',connected);
      if(connected)store.db.prepare("UPDATE inbox_accounts SET state='live',synced_at=? WHERE channel='telegram' AND remote_id=?").run(store.now(),ownerId);
    }catch(e){status('error',e.status?e.message:'Не удалось принять события Telegram.');}
    finally{busy=false;}
  }
  return {apply,capability,send,poll,processPending,configured:Boolean(token)};
}
