import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

export const CHANNELS = ['telegram', 'avito', 'yandex', 'moysklad'];
export const ORDER_STATES = ['new', 'checking', 'confirmed', 'fulfilling', 'completed', 'cancelled', 'returned'];
export const fail = (status, message) => Object.assign(new Error(message), { status });
export const hash = v => createHash('sha256').update(Buffer.isBuffer(v) ? v : String(v)).digest('hex');
export const opaque = () => randomBytes(32).toString('base64url');
const parse = v => v ? JSON.parse(v) : null;
const bounded = (v, n, label) => { const s = String(v ?? '').trim(); if (s.length > n || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) throw fail(400, `Проверьте поле «${label}».`); return s; };

export function normalizeProduct(input, previous = {}) {
  const title = bounded(input.title, 120, 'Название');
  if (!title) throw fail(400, 'Укажите название компьютера.');
  const category = bounded(input.category || 'Mac', 40, 'Категория');
  const channels = [...new Set(Array.isArray(input.channels) ? input.channels : input.channels ? [input.channels] : [])];
  if (channels.some(c => !CHANNELS.includes(c))) throw fail(400, 'Неизвестный канал.');
  const recommendationKey = bounded(input.recommendationKey, 40, 'Конфигурация dev');
  if (recommendationKey && !/^[a-f0-9]{32}$/.test(recommendationKey)) throw fail(400, 'Выберите конфигурацию dev.');
  const moyskladId = bounded(input.moyskladId, 36, 'МойСклад');
  if (moyskladId && !/^[a-f0-9-]{36}$/.test(moyskladId)) throw fail(400, 'Проверьте идентификатор МойСклад.');
  const result = { title, category, description: bounded(input.description, 1800, 'Описание'), specification: bounded(input.specification, 800, 'Характеристики'),
    warranty: bounded(input.warranty, 250, 'Гарантия'), recommendationKey, mappingConfirmed: input.mappingConfirmed === true || input.mappingConfirmed === 'on',
    channels, moyskladId, moyskladType: input.moyskladType === 'variant' ? 'variant' : 'product', vendor: bounded(input.vendor || 'Apple', 50, 'Бренд'),
    avitoCategory: bounded(input.avitoCategory || 'Ноутбуки', 80, 'Категория Авито'), photos: previous.photos || [], individual: input.individual === true || input.individual === 'on' };
  if (['title','description','specification','warranty'].reduce((n,k)=>n+Buffer.byteLength(result[k].replace(/[&<>"']/g,'&quot;')),0)>6000) throw fail(400,'Сократите описание и характеристики: карточка должна загружаться быстро.');
  return result;
}

export function openShopStore(path, { now = Date.now } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path); chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, draft TEXT NOT NULL, published TEXT, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recommendations(key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, csrf TEXT NOT NULL, cart TEXT NOT NULL DEFAULT '{}', role TEXT, auth_until INTEGER, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS checkouts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, snapshot TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, checkout_id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'new', note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL, channel TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT, UNIQUE(entity,entity_id,channel,revision));
    CREATE TABLE IF NOT EXISTS publications(entity TEXT NOT NULL, entity_id TEXT NOT NULL, channel TEXT NOT NULL, remote_id TEXT, revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'queued', detail TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(entity,entity_id,channel));
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, event TEXT NOT NULL, reference TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(state,next_at);`);
  // An interrupted outgoing create may have succeeded remotely. Never blindly resend it.
  db.prepare("UPDATE jobs SET state='unknown',error='Процесс прерван: проверьте результат площадки' WHERE state='working'").run();
  let inTransaction = false;
  const tx = fn => { if (inTransaction) return fn(); db.exec('BEGIN IMMEDIATE'); inTransaction = true; try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { inTransaction = false; } };
  const audit = (actor, event, reference) => db.prepare('INSERT INTO audit(actor,event,reference,at) VALUES(?,?,?,?)').run(actor, event, reference, now());
  const setting = key => parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value);
  const setSetting = (key, value) => db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, JSON.stringify(value));
  const recommendation = key => parse(db.prepare('SELECT data FROM recommendations WHERE key=?').get(key)?.data);
  const product = id => { const row = db.prepare('SELECT * FROM products WHERE id=?').get(id); return row && { ...row, draft: parse(row.draft), published: parse(row.published) }; };
  const products = () => db.prepare('SELECT id FROM products ORDER BY updated_at DESC,id').all().map(r => product(r.id));
  function priced(data) {
    const row = recommendation(data.recommendationKey);
    const valid = row && data.mappingConfirmed && row.priceRub > 0 && row.expiresAt > now();
    return { ...data, priceRub: valid ? row.priceRub : null, priceExpiresAt: valid ? row.expiresAt : 0 };
  }
  function publicProduct(p) {
    if (!p?.published) return null;
    const d = p.published;
    return { id: p.id, title: d.title, category: d.category, description: d.description, specification: d.specification, warranty: d.warranty,
      vendor: d.vendor, photos: d.photos, priceRub: d.priceExpiresAt > now() ? d.priceRub : null, revision: p.revision };
  }
  function queue(entity, id, channel, revision) {
    db.prepare("UPDATE jobs SET state='superseded' WHERE entity=? AND entity_id=? AND channel=? AND revision<? AND state IN ('queued','retry','blocked','ready','served')").run(entity,id,channel,revision);
    db.prepare('INSERT OR IGNORE INTO jobs(entity,entity_id,channel,revision) VALUES(?,?,?,?)').run(entity,id,channel,revision);
  }
  function enqueueProduct(p, previous) {
    for (const channel of new Set([...(p.published?.channels || []), ...(previous?.channels || [])])) queue('product',p.id,channel,p.revision);
  }
  function saveProduct(input, { id, actor = 'owner', publish = false, expectedRevision } = {}) {
    return tx(() => {
      const old = id ? product(id) : null;
      if (id && !old) throw fail(404, 'Товар не найден.');
      if (old && Number(expectedRevision) !== old.revision) throw fail(409, 'Карточка изменилась. Откройте её заново.');
      const draft = normalizeProduct(input, old?.draft);
      if (draft.recommendationKey && !recommendation(draft.recommendationKey)) throw fail(400, 'Обновите прайс dev и выберите конфигурацию.');
      if (publish && draft.recommendationKey && !draft.mappingConfirmed) throw fail(400, 'Подтвердите точное соответствие конфигурации dev.');
      const published = publish ? priced(draft) : old?.published || null;
      const result = { id: id || randomUUID(), draft, published, revision: (old?.revision || 0) + 1 };
      db.prepare('INSERT INTO products VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET draft=excluded.draft,published=excluded.published,revision=excluded.revision,updated_at=excluded.updated_at')
        .run(result.id,JSON.stringify(draft),published ? JSON.stringify(published) : null,result.revision,now());
      // Draft edits don't change the published content, but do invalidate obsolete work.
      if (published) enqueueProduct(result,old?.published);
      audit(actor,publish ? 'product_published' : 'draft_saved',result.id); return result;
    });
  }
  function unpublish(id, actor = 'owner') {
    return tx(() => { const old = product(id); if (!old) throw fail(404,'Товар не найден.');
      db.prepare('UPDATE products SET published=NULL,revision=revision+1,updated_at=? WHERE id=?').run(now(),id);
      enqueueProduct(product(id),old.published); audit(actor,'product_unpublished',id); });
  }
  function refreshPrices(rows) {
    return tx(() => {
      for (const row of rows) db.prepare('INSERT OR REPLACE INTO recommendations VALUES(?,?)').run(row.key,JSON.stringify(row));
      const keys = new Set(rows.map(r => r.key));
      for (const r of db.prepare('SELECT key FROM recommendations').all()) if (!keys.has(r.key)) db.prepare('DELETE FROM recommendations WHERE key=?').run(r.key);
      reconcilePrices(); setSetting('price_sync',{ ok: true, at: now(), count: rows.length });
    });
  }
  function reconcilePrices() {
    for (const p of products().filter(p => p.published)) {
      const next = priced(p.published);
      if (next.priceRub === p.published.priceRub && next.priceExpiresAt === p.published.priceExpiresAt) continue;
      db.prepare('UPDATE products SET published=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(next),now(),p.id);
      enqueueProduct(product(p.id),p.published);
    }
  }
  function session(token) {
    let row = token && db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(hash(token),now());
    if (!row) { token = opaque(); row = { id:hash(token),csrf:opaque(),cart:'{}',role:null,auth_until:0,expires:now()+7*86400000 }; db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(row.id,row.csrf,row.cart,null,0,row.expires); }
    return { ...row, token, cart:parse(row.cart), role: row.auth_until > now() ? row.role : null };
  }
  function rotateSession(old, role) {
    return tx(() => { const next = session(); db.prepare('UPDATE sessions SET role=?,auth_until=?,cart=? WHERE id=?').run(role,now()+2*3600000,JSON.stringify(old.cart),next.id); db.prepare('DELETE FROM sessions WHERE id=?').run(old.id); return { ...next,role,cart:old.cart }; });
  }
  function setCart(s, cart) { db.prepare('UPDATE sessions SET cart=? WHERE id=?').run(JSON.stringify(cart),s.id); s.cart=cart; }
  function cartLines(s) { return Object.entries(s.cart).map(([id,qty]) => { const p = publicProduct(product(id)); return { id,qty,title:p?.title || 'Предложение закрыто',priceRub:p?.priceRub ?? null,active:Boolean(p) }; }); }
  function checkout(s) { const lines = cartLines(s); if (!lines.length || lines.some(l=>!l.active)) throw fail(400,'Проверьте товары в корзине.'); const id=opaque(); db.prepare('INSERT INTO checkouts VALUES(?,?,?,?)').run(id,s.id,JSON.stringify(lines),now()+20*60000); return {id,lines}; }
  function placeOrder(s, input) {
    const phone = bounded(input.phone,24,'Телефон').replace(/\D/g,'').replace(/^8(?=\d{10}$)/,'7');
    const normalizedPhone = phone.length===10 ? `7${phone}` : phone;
    if (!/^7\d{10}$/.test(normalizedPhone)) throw fail(400,'Укажите телефон: +7 и ещё 10 цифр.');
    if (input.consent !== 'on') throw fail(400,'Подтвердите согласие на обработку данных.');
    if (input.website) throw fail(400,'Не удалось отправить заказ.');
    if (!['cash','invoice'].includes(input.payment || 'cash')) throw fail(400,'Выберите способ оплаты.');
    const contact={phone:`+${normalizedPhone}`,name:bounded(input.name,100,'Имя'),comment:bounded(input.comment,600,'Комментарий'),payment:input.payment || 'cash',consentVersion:'2026-09-28'};
    const fingerprint=hash(JSON.stringify(contact));
    return tx(()=>{
      const existing=db.prepare('SELECT * FROM orders WHERE checkout_id=?').get(String(input.checkoutId));
      if(existing) { if(existing.session_id!==s.id || existing.fingerprint!==fingerprint) throw fail(409,'Этот заказ уже отправлен с другими данными.'); return existing.id; }
      const quote=db.prepare('SELECT * FROM checkouts WHERE id=? AND session_id=? AND expires>?').get(String(input.checkoutId),s.id,now());
      if(!quote) throw fail(409,'Срок подтверждения истёк. Проверьте корзину ещё раз.');
      let lines=cartLines(s);
      if(JSON.stringify(lines)!==quote.snapshot) throw fail(409,'Цена или состав заказа изменились. Проверьте новый итог перед отправкой.');
      lines=lines.map(line=>{const d=product(line.id).published;return {...line,specification:d.specification,recommendationKey:d.recommendationKey,moyskladId:d.moyskladId,moyskladType:d.moyskladType,individual:d.individual};});
      const id=`MB-${randomBytes(6).toString('hex').toUpperCase()}`;
      const data={...contact,lines,totalRub:lines.every(l=>l.priceRub!=null)?lines.reduce((n,l)=>n+l.qty*l.priceRub,0):null};
      db.prepare('INSERT INTO orders(id,checkout_id,session_id,fingerprint,data,created_at) VALUES(?,?,?,?,?,?)').run(id,input.checkoutId,s.id,fingerprint,JSON.stringify(data),now());
      queue('order',id,'moysklad',1); audit('customer','order_created',id); setCart(s,{}); return id;
    });
  }
  function addPhoto(id, filename, expectedRevision, actor='owner') {
    return tx(()=>{const p=product(id);if(!p)throw fail(404,'Товар не найден.');
      if(p.revision!==Number(expectedRevision))throw fail(409,'Карточка изменилась. Откройте её заново.');
      if(p.draft.photos.length>=6)throw fail(400,'Допускается до шести фотографий.');
      db.prepare('UPDATE products SET draft=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify({...p.draft,photos:[...new Set([...p.draft.photos,filename])]}),now(),id);
      if(p.published)enqueueProduct(product(id),p.published);audit(actor,'photo_uploaded',id);
    });
  }
  function updateOrder(id, state, note, actor='owner') {
    return tx(()=>{if(!ORDER_STATES.includes(state))throw fail(400,'Неизвестный статус.');
      const row=db.prepare('SELECT * FROM orders WHERE id=?').get(id);if(!row)throw fail(404,'Заказ не найден.');
      db.prepare('UPDATE orders SET state=?,note=? WHERE id=?').run(state,bounded(note,2000,'Заметки'),id);
      if(state==='completed')for(const line of parse(row.data).lines){if(line.individual&&product(line.id)?.published)unpublish(line.id,actor);}
      audit(actor,'order_updated',id);
    });
  }
  function limit(key,max,windowMs) { const bucket=`${key}:${Math.floor(now()/windowMs)}`; db.prepare('INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(bucket,now()+windowMs); return db.prepare('SELECT count FROM limits WHERE key=?').get(bucket).count<=max; }
  function maintenance() { db.prepare('DELETE FROM limits WHERE expires<?').run(now()); db.prepare('DELETE FROM sessions WHERE expires<?').run(now()); db.prepare('DELETE FROM checkouts WHERE expires<? AND id NOT IN (SELECT checkout_id FROM orders)').run(now()); tx(reconcilePrices); }
  return {db,now,tx,audit,setting,setSetting,product,products,publicProduct,recommendation,priced,queue,saveProduct,unpublish,refreshPrices,reconcilePrices:()=>tx(reconcilePrices),
    session,rotateSession,setCart,cartLines,checkout,placeOrder,addPhoto,updateOrder,limit,maintenance,close:()=>db.close()};
}
