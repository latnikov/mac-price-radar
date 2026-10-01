import { readFileSync } from 'node:fs';
import { randomUUID, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fail, hash, opaque } from './core.mjs';
import { normalizeEmail } from './checkout-data.mjs';
const scrypt = promisify(scryptCallback);
export function normalizeAccountPhone(value) {
  let phone = String(value || '').replace(/[\s()+-]/g, '').replace(/^8(?=\d{10}$)/, '7');
  if (/^\d{10}$/.test(phone)) phone = `7${phone}`;
  if (!/^7\d{10}$/.test(phone)) throw fail(400, 'Укажите телефон: +7 и ещё 10 цифр.');
  return `+${phone}`;
}
async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw fail(400, 'Пароль должен содержать от 10 до 128 символов.');
  const salt = randomBytes(16).toString('hex'), result = await scrypt(password, salt, 32);
  return `${salt}:${result.toString('hex')}`;
}
async function passwordMatches(password, saved) {
  const [salt, value] = String(saved || `${'0'.repeat(32)}:${'0'.repeat(64)}`).split(':');
  const result = await scrypt(String(password || '').slice(0, 129), salt, 32);
  const expected = Buffer.from(value, 'hex');
  return expected.length === result.length && timingSafeEqual(result, expected);
}

export function openAccounts(store, { env = process.env, fetchImpl = fetch, origin } = {}) {
  env={...env,STORE_MAIL_WEBHOOK_TOKEN:env.STORE_MAIL_WEBHOOK_TOKEN_FILE?readFileSync(env.STORE_MAIL_WEBHOOK_TOKEN_FILE,'utf8').trim():env.STORE_MAIL_WEBHOOK_TOKEN};
  const { db, tx, now, audit } = store;
  function current(session) {
    return db.prepare('SELECT a.id,a.email,a.phone,a.email_verified FROM customer_accounts a JOIN account_sessions s ON s.account_id=a.id WHERE s.session_id=?').get(session.id);
  }
  function grant(id, accountId, evidence) { db.prepare('INSERT OR IGNORE INTO account_orders VALUES(?,?,?)').run(accountId, id, evidence); }
  store.hooks.accountOrderCreated = (id, session) => { if (session) { const account = current(session); if (account) grant(id, account.id, 'authenticated_checkout'); } };
  function bind(account, session) {
    return tx(() => {
      const oldOrders = db.prepare('SELECT id FROM orders WHERE session_id=?').all(session.id);
      const next = store.rotateSession(session, null);
      db.prepare('INSERT INTO account_sessions VALUES(?,?)').run(next.id, account.id);
      for (const o of oldOrders) grant(o.id, account.id, 'owned_guest_session');
      audit(`account:${account.id}`, 'customer_login', account.id);
      return next;
    });
  }
  async function register(input, session) {
    const email = normalizeEmail(input.email); if (!email) throw fail(400, 'Укажите email.');
    const phone = normalizeAccountPhone(input.phone);
    if (input.consent !== 'on') throw fail(400, 'Подтвердите согласие на обработку данных.');
    const encoded = await passwordHash(input.password);
    return tx(() => {
      if (db.prepare('SELECT 1 FROM customer_accounts WHERE email=? OR phone=?').get(email, phone)) throw fail(409, 'Не удалось создать аккаунт с этими данными. Попробуйте вход или восстановление доступа.');
      const account = { id: randomUUID(), email, phone };
      db.prepare('INSERT INTO customer_accounts(id,email,phone,password_hash,created_at) VALUES(?,?,?,?,?)').run(account.id, email, phone, encoded, now());
      return bind(account, session);
    });
  }
  async function login(input, session) {
    const identifier = String(input.identifier || '').trim();
    let email = '', phone = '';
    try { if (identifier.includes('@')) email = normalizeEmail(identifier); else phone = normalizeAccountPhone(identifier); } catch { /* Same response and hashing work for every failed login. */ }
    const account = db.prepare('SELECT * FROM customer_accounts WHERE email=? OR phone=?').get(email, phone);
    const valid = await passwordMatches(input.password, account?.password_hash);
    if (!account || !valid) throw fail(401, 'Данные для входа не подошли.');
    return bind(account, session);
  }
  function logout(session) {
    db.prepare('DELETE FROM account_sessions WHERE session_id=?').run(session.id);
    return store.rotateSession(session, null);
  }
  function canViewOrder(id, session) {
    const account = current(session);
    return Boolean(db.prepare('SELECT 1 FROM orders WHERE id=? AND session_id=?').get(id, session.id) || (account && db.prepare('SELECT 1 FROM account_orders WHERE account_id=? AND order_id=?').get(account.id, id)));
  }
  const orders = session => {
    const account = current(session); if (!account) return [];
    return db.prepare('SELECT o.* FROM orders o JOIN account_orders a ON a.order_id=o.id WHERE a.account_id=? ORDER BY o.created_at DESC LIMIT 50').all(account.id);
  };
  function support(input, session) {
    const account = current(session); if (!account) throw fail(401, 'Войдите в личный кабинет.');
    if (input.orderId && !db.prepare('SELECT 1 FROM account_orders WHERE account_id=? AND order_id=?').get(account.id, input.orderId)) throw fail(404, 'Заказ не найден.');
    const body = String(input.body || '').trim();
    if (!body || body.length > 2000) throw fail(400, 'Напишите сообщение до 2000 символов.');
    const id = randomUUID();
    db.prepare('INSERT INTO customer_requests(id,account_id,order_id,body,created_at) VALUES(?,?,?,?,?)').run(id, account.id, input.orderId || null, body, now());
    audit(`account:${account.id}`, 'customer_request', id); return id;
  }
  const mailConfigured = () => Boolean(env.STORE_MAIL_WEBHOOK_URL && env.STORE_MAIL_WEBHOOK_TOKEN);
  function cleanExpiredMail(){
    db.prepare('DELETE FROM account_tokens WHERE expires<?').run(now());
    db.prepare("UPDATE customer_outbox SET state='expired',data=NULL WHERE state='queued' AND created_at<?").run(now()-20*60000);
  }
  function requestReset(value) {
    cleanExpiredMail();
    let email; try { email = normalizeEmail(value); } catch { return; }
    const account = db.prepare('SELECT id FROM customer_accounts WHERE email=?').get(email);
    if (!account || !mailConfigured()) return;
    tx(() => {
      db.prepare("UPDATE customer_outbox SET state='superseded',data=NULL WHERE destination=? AND state='queued'").run(email);
      const token = opaque();
      db.prepare('UPDATE account_tokens SET used_at=? WHERE email=? AND used_at IS NULL').run(now(), email);
      db.prepare('INSERT INTO account_tokens VALUES(?,?,?, ?,NULL)').run(hash(token), email, 'reset', now() + 20 * 60000);
      db.prepare('INSERT INTO customer_outbox(id,kind,destination,data,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), 'reset', email, JSON.stringify({ subject: 'Восстановление доступа в Макбучную', text: `Ссылка действует 20 минут: ${origin}/account/reset?token=${encodeURIComponent(token)}` }), now());
    });
  }
  async function reset(token, password, session) {
    const encoded = await passwordHash(password);
    return tx(() => {
      const record = db.prepare("SELECT * FROM account_tokens WHERE hash=? AND kind='reset' AND expires>? AND used_at IS NULL").get(hash(String(token || '')), now());
      if (!record) throw fail(400, 'Ссылка недействительна или уже использована.');
      const account = db.prepare('SELECT * FROM customer_accounts WHERE email=?').get(record.email);
      db.prepare('UPDATE customer_accounts SET password_hash=?,email_verified=1 WHERE id=?').run(encoded, account.id);
      db.prepare('UPDATE account_tokens SET used_at=? WHERE hash=?').run(now(), record.hash);
      db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(account.id);
      return bind(account, session);
    });
  }
  let sending = false;
  async function dispatchMail() {
    cleanExpiredMail();
    if (sending || !mailConfigured()) return;
    const endpoint = new URL(env.STORE_MAIL_WEBHOOK_URL);
    if (endpoint.protocol !== 'https:') { store.setSetting('mail_status', { state: 'blocked', error: 'Нужен HTTPS-адрес отправителя' }); return; }
    sending = true;
    try {
      for (const job of db.prepare("SELECT * FROM customer_outbox WHERE state='queued' ORDER BY created_at LIMIT 10").all()) {
        db.prepare("UPDATE customer_outbox SET state='sending',attempts=attempts+1 WHERE id=?").run(job.id);
        try {
          const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.STORE_MAIL_WEBHOOK_TOKEN}`, 'Idempotency-Key': job.id }, body: JSON.stringify({ to: job.destination, ...JSON.parse(job.data) }), signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error('mail_rejected');
          db.prepare("UPDATE customer_outbox SET state='sent',data=NULL,error=NULL WHERE id=?").run(job.id);
        } catch { db.prepare("UPDATE customer_outbox SET state='unknown',error='Проверьте результат отправки',data=NULL WHERE id=?").run(job.id); }
      }
    } finally { sending = false; }
  }
  db.prepare("UPDATE customer_outbox SET state='unknown',data=NULL,error='Отправка прервана' WHERE state='sending'").run();
  return { current, register, login, logout, orders, canViewOrder, support, requestReset, reset, dispatchMail, mailConfigured };
}
