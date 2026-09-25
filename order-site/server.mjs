import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { validateConfiguration, describeConfiguration } from './catalog.mjs';
import { formatPublicPrice, pricingInfo, quoteConfigurator, quoteCustomerPrice } from './pricing.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const fault = (status, message) => Object.assign(new Error(message), { status });
async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fault(415, 'Неверный формат запроса.');
  if (Number(req.headers['content-length']) > 8192) throw fault(413, 'Слишком большой запрос.');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8192) throw fault(413, 'Слишком большой запрос.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fault(400, 'Некорректный запрос.'); }
}
function notificationText(row) {
  const p = JSON.parse(row.payload);
  let priceLine = '';
  try {
    const priceRub = Number.isInteger(p.priceRub) ? p.priceRub : quoteCustomerPrice(p.configuration);
    priceLine = `\nПредварительная цена: ${formatPublicPrice(priceRub)}`;
  } catch { /* Preserve delivery for an older order whose configuration left the current price list. */ }
  return `Новая заявка · Макбучная\n№ ${row.id}\n${new Date(row.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (МСК)\n\n${describeConfiguration(p.configuration)}${priceLine}\n\nИмя: ${p.name || 'не указано'}\nТелефон: ${p.phone}\nГород: Нижний Новгород\n\nСвяжитесь с клиентом для подтверждения стоимости и срока.`;
}
export function validateOrder(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fault(400, 'Некорректная заявка.');
  let configuration;
  try { configuration = validateConfiguration(body.configuration); } catch (e) { throw fault(400, e.message); }
  if (typeof body.phone !== 'string' || body.phone.length > 24 || /[^\d+()\s-]/.test(body.phone)) throw fault(400, 'Проверьте номер телефона.');
  let phone = body.phone.replace(/\D/g, '');
  if (phone.length === 10) phone = `7${phone}`;
  if (phone.startsWith('8') && phone.length === 11) phone = `7${phone.slice(1)}`;
  if (!/^7\d{10}$/.test(phone)) throw fault(400, 'Укажите российский номер: +7 и ещё 10 цифр.');
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 100 || /[\x00-\x1f\x7f]/.test(body.name))) throw fault(400, 'Проверьте имя.');
  if (body.consent !== true) throw fault(400, 'Подтвердите согласие на обработку данных.');
  if (body.website) throw fault(400, 'Не удалось отправить заявку.');
  return { configuration, priceRub: quoteCustomerPrice(configuration), pricingAsOf: pricingInfo.checkedAt, phone: `+${phone}`, name: (body.name || '').trim(), consentVersion: '2026-09-24' };
}

export function createOrderService({ env = process.env, dbPath = env.ORDERS_DB || resolve(root, 'data/orders.sqlite'), fetchImpl = fetch, now = Date.now, runWorker = true } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  chmodSync(dbPath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL, notified_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS orders_pending ON orders(notified_at, next_attempt);`);
  const columns = db.prepare('PRAGMA table_info(orders)').all().map(x => x.name);
  if (!columns.includes('lease_token')) db.exec('ALTER TABLE orders ADD COLUMN lease_token TEXT; ALTER TABLE orders ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;');
  const relayMode = env.ORDER_DELIVERY_MODE === 'relay';
  const telegramReady = Boolean(env.ORDER_TELEGRAM_BOT_TOKEN && env.ORDER_TELEGRAM_CHAT_ID);
  const deliveryReady = relayMode ? Boolean(env.ORDER_RELAY_KEY?.length >= 32 && env.ORDER_TELEGRAM_CHAT_ID) : telegramReady;
  const acceptingOrders = deliveryReady && env.ORDER_ACCEPTING === '1';
  const allowedOrigin = env.ORDER_ORIGIN || 'http://127.0.0.1:4180';
  const rate = new Map();
  let working = false;
  async function dispatch() {
    if (relayMode || !telegramReady || working) return;
    working = true;
    try {
      const rows = db.prepare('SELECT * FROM orders WHERE notified_at IS NULL AND next_attempt <= ? ORDER BY created_at LIMIT 10').all(now());
      for (const row of rows) {
        const text = notificationText(row);
        try {
          const response = await fetchImpl(`https://api.telegram.org/bot${env.ORDER_TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: env.ORDER_TELEGRAM_CHAT_ID, text, link_preview_options: { is_disabled: true } }), signal: AbortSignal.timeout(12000),
          });
          const result = await response.json();
          if (!response.ok || result.ok !== true) {
            const retryAfter = Math.min(86400, Math.max(0, Number(result.parameters?.retry_after) || 0));
            throw Object.assign(new Error('telegram_rejected'), { retryAfter });
          }
          db.prepare('UPDATE orders SET notified_at = ?, last_error = NULL WHERE id = ?').run(now(), row.id);
        } catch (e) {
          const delay = Math.max(Math.min(3600, 15 * 2 ** Math.min(row.attempts, 8)), e.retryAfter || 0) * 1000;
          db.prepare('UPDATE orders SET attempts = attempts + 1, next_attempt = ?, last_error = ? WHERE id = ?').run(now() + delay, 'delivery_failed', row.id);
          console.warn(`Order ${row.id}: notification queued for retry`);
        }
      }
    } finally { working = false; }
  }
  const staticFiles = new Map([
    ['/', ['public/index.html', 'text/html']], ['/style.css', ['public/style.css', 'text/css']],
    ['/app.js', ['public/app.js', 'text/javascript']], ['/catalog.mjs', ['catalog.mjs', 'text/javascript']],
    ['/privacy.html', ['public/privacy.html', 'text/html']],
  ]);
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if ((req.method === 'GET' || req.method === 'HEAD') && staticFiles.has(path)) {
        const [file, type] = staticFiles.get(path);
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        res.end(req.method === 'HEAD' ? undefined : readFileSync(resolve(root, file))); return;
      }
      if (req.method === 'GET' && path === '/api/status') { json(200, { acceptingOrders }); return; }
      if (req.method === 'GET' && path === '/api/quote') {
        const configuration = {
          model: url.searchParams.get('model'), chip: url.searchParams.get('chip'),
          memory: Number(url.searchParams.get('memory')), storage: Number(url.searchParams.get('storage')),
          ethernet: Number(url.searchParams.get('ethernet')),
        };
        let quote;
        try { quote = quoteConfigurator(configuration); } catch (e) { throw fault(400, e.message); }
        json(200, { ...quote, currency: 'RUB' }); return;
      }
      if (req.method === 'GET' && path === '/healthz') { db.prepare('SELECT 1').get(); json(200, { ok: true }); return; }
      if (path === '/api/relay/claim' || path === '/api/relay/ack') {
        if (req.method !== 'POST') throw fault(405, 'Метод не поддерживается.');
        const supplied = Buffer.from(String(req.headers.authorization || ''));
        const expected = Buffer.from(`Bearer ${env.ORDER_RELAY_KEY || ''}`);
        if (!relayMode || !env.ORDER_RELAY_KEY || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fault(403, 'Доступ запрещён.');
        const body = await readJson(req);
        if (path.endsWith('/claim')) {
          db.exec('BEGIN IMMEDIATE');
          try {
            const rows = db.prepare('SELECT * FROM orders WHERE notified_at IS NULL AND next_attempt <= ? AND lease_until <= ? ORDER BY created_at LIMIT 3').all(now(), now());
            const notifications = rows.map(row => {
              const lease = randomUUID();
              db.prepare('UPDATE orders SET lease_token = ?, lease_until = ?, attempts = attempts + 1 WHERE id = ?').run(lease, now() + 180000, row.id);
              return { orderId: row.id, lease, chatId: env.ORDER_TELEGRAM_CHAT_ID, text: notificationText(row) };
            });
            db.exec('COMMIT'); json(200, { notifications });
          } catch (e) { db.exec('ROLLBACK'); throw e; }
        } else {
          if (!body || typeof body.orderId !== 'string' || typeof body.lease !== 'string') throw fault(400, 'Некорректное подтверждение.');
          const row = db.prepare('SELECT * FROM orders WHERE id = ? AND lease_token = ?').get(body.orderId, body.lease);
          if (!row) throw fault(409, 'Подтверждение устарело.');
          db.prepare('UPDATE orders SET notified_at = COALESCE(notified_at, ?), last_error = NULL WHERE id = ?').run(now(), row.id);
          json(200, { ok: true });
        }
        return;
      }
      if (path !== '/api/orders') throw fault(404, 'Страница не найдена.');
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw fault(405, 'Метод не поддерживается.'); }
      if (req.headers.origin !== allowedOrigin) throw fault(403, 'Отправьте заявку с сайта магазина.');
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[\w-]{16,80}$/.test(key)) throw fault(400, 'Обновите страницу и повторите отправку.');
      const body = await readJson(req);
      const payload = validateOrder(body);
      const serialized = JSON.stringify(payload);
      const fingerprint = createHash('sha256').update(serialized).digest('hex');
      const existing = db.prepare('SELECT id, fingerprint, payload FROM orders WHERE request_key = ?').get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw fault(409, 'Заявка изменилась. Обновите страницу и отправьте её заново.');
        const saved = JSON.parse(existing.payload);
        let priceRub = saved.priceRub;
        try { if (!Number.isInteger(priceRub)) priceRub = quoteCustomerPrice(saved.configuration); } catch { priceRub = undefined; }
        json(200, { orderId: existing.id, accepted: true, ...(Number.isInteger(priceRub) ? { priceRub } : {}) }); return;
      }
      if (!acceptingOrders) throw fault(503, 'Приём заявок пока не подключён. Попробуйте позже.');
      // Caddy overwrites X-Forwarded-For; only trust it behind the loopback proxy.
      const peer = req.socket.remoteAddress;
      const ip = env.ORDER_TRUST_PROXY === '1' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) ? String(req.headers['x-forwarded-for'] || peer).split(',').at(-1).trim() : peer;
      const windowStart = now() - 15 * 60 * 1000;
      for (const [address, hits] of rate) { const fresh = hits.filter(t => t > windowStart); if (fresh.length) rate.set(address, fresh); else rate.delete(address); }
      const hits = rate.get(ip) || [];
      if (hits.length >= 5 || rate.size >= 10000) { res.setHeader('Retry-After', '900'); throw fault(429, 'Слишком много заявок. Попробуйте через 15 минут.'); }
      const id = `MB-${randomUUID().slice(0, 8).toUpperCase()}`;
      db.prepare('INSERT INTO orders (id, request_key, fingerprint, payload, created_at) VALUES (?, ?, ?, ?, ?)').run(id, key, fingerprint, serialized, now());
      hits.push(now()); rate.set(ip, hits);
      json(201, { orderId: id, accepted: true, priceRub: payload.priceRub });
      if (runWorker) void dispatch().catch(() => console.error('Notification worker unavailable'));
    } catch (e) {
      if (!e.status) console.error('Order request failed');
      if (!res.headersSent) json(e.status || 500, e.status ? { error: e.message } : { error: 'Не удалось сохранить заявку. Повторите отправку.' });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const timer = runWorker ? setInterval(() => { void dispatch().catch(() => console.error('Notification worker unavailable')); }, 15000) : null;
  timer?.unref();
  if (runWorker) void dispatch().catch(() => console.error('Notification worker unavailable'));
  return { server, db, dispatch, async close() { clearInterval(timer); await new Promise(r => server.close(r)); while (working) await new Promise(r => setTimeout(r, 20)); db.close(); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const service = createOrderService();
  const port = Number(process.env.ORDER_PORT || 4180);
  service.server.listen(port, '127.0.0.1', () => console.log(`Order site listening on 127.0.0.1:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await service.close(); process.exit(0); });
}
