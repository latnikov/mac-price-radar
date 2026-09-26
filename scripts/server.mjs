import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { buildCatalogRows } from './catalog-rows.mjs';
import { ingestBusinessUpdate, startBsaBusinessPolling } from './telegram-business.mjs';
import { inPublicSourceScope } from './domain.mjs';
import { createResponseCache, cachedFile, sendCached } from './response-cache.mjs';

const RETAILERS = ['BigGeek', 'Айфория', 'Technichno', 'iMobile', 'ReSale', 'Apple Store', 'Rebro', 'Madstore', 'Smart Device', 'RifaStore', 'BSA', 'Дима'];
const STATIC_FILES = new Map([
  ['/', ['web/index.html', 'text/html; charset=utf-8']],
  ['/web/', ['web/index.html', 'text/html; charset=utf-8']],
  ['/web/index.html', ['web/index.html', 'text/html; charset=utf-8']],
  ['/web/app.js', ['web/app.js', 'text/javascript; charset=utf-8']],
  ['/web/retail-analytics.js', ['web/retail-analytics.js', 'text/javascript; charset=utf-8']],
  ['/web/styles.css', ['web/styles.css', 'text/css; charset=utf-8']],
  ['/web/favicon.svg', ['web/favicon.svg', 'image/svg+xml']],
  ['/web/favicon-32.png', ['web/favicon-32.png', 'image/png']],
  ['/web/apple-touch-icon.png', ['web/apple-touch-icon.png', 'image/png']],
  ['/web/og-image.jpg', ['web/og-image.jpg', 'image/jpeg']],
  ['/robots.txt', ['web/robots.txt', 'text/plain; charset=utf-8']],
  ['/sitemap.xml', ['web/sitemap.xml', 'application/xml; charset=utf-8']],
  ['/thank-you.html', ['web/thank-you.html', 'text/html; charset=utf-8']],
]);
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function send(res, code, value, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}

async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Нужен Content-Type: application/json'), { statusCode: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Object.assign(new Error('Импорт больше 2 МБ'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw Object.assign(new Error('Некорректный объект JSON'), { statusCode: 400 }); }
}

function runCollector({ root, retailers, timeoutMs }) {
  return new Promise((resolveJob, reject) => execFile(process.execPath, ['scripts/build-data.mjs'], {
    cwd: root, env: { ...process.env, LIVE: '1', RETAILER: retailers.join(',') },
    timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
  }, error => error ? reject(new Error(error.killed ? 'Превышен срок выполнения сбора' : 'Сбор завершился с ошибкой; сохранён последний успешный снимок')) : resolveJob()));
}

export async function createMasterServer({ root = process.cwd(), store, refreshRunner = runCollector, refreshTimeoutMs = 15 * 60 * 1000, telegramRefreshDelayMs = 1500, autoRefreshIntervalMs = 0, analyticsPath = join(root, 'data/private/analytics.ndjson'), env = process.env } = {}) {
  const ownsStore = !store;
  if (!store) {
    const { openMasterStore } = await import('./master-store.mjs');
    store = openMasterStore(join(root, 'data/private/master.sqlite'));
  }
  const { calculateEconomics } = await import('./procurement.mjs');
  const csrfToken = randomBytes(32).toString('hex');
  const previews = new Map();
  const responseCache = createResponseCache();
  const cachedReply = (req, res, value, type = 'application/json; charset=utf-8') => sendCached(req, res, value, type, SECURITY_HEADERS);
  let activeJob = null;
  let jobStatus = null;
  let bsaWebhookQueue = Promise.resolve();
  let telegramRefreshTimer = null;
  let autoRefreshTimer = null;
  let nextRefreshAt = null;
  const pendingTelegramRetailers = new Set();

  async function status() {
    const saved = await readFile(join(root, 'data/status.json'), 'utf8').then(JSON.parse).catch(() => ({ state: 'idle', stage: 'idle' }));
    // Progress is reported by completed collector work, never by a timer.
    delete saved.progress;
    if (jobStatus && (!saved.startedAt || saved.startedAt < jobStatus.startedAt || jobStatus.state === 'error')) return jobStatus;
    if (activeJob) return { ...saved, ...(!saved.stage ? { stage: 'collecting' } : {}), state: 'running' };
    // A previous process may have stopped mid-run. A GET does not restart it.
    if (saved.state === 'running' && !activeJob) return { ...saved, state: 'interrupted', stage: 'interrupted', error: 'Предыдущий сбор не завершён. Последние наблюдения сохранены.' };
    return saved;
  }

  function refresh(selected) {
    if (activeJob) return false;
    jobStatus = { state: 'running', stage: 'starting', retailers: selected, startedAt: new Date().toISOString(), completed: 0, total: selected.length };
    activeJob = Promise.resolve().then(() => refreshRunner({ root, retailers: selected, timeoutMs: refreshTimeoutMs }))
      .then(() => { jobStatus = { ...jobStatus, state: 'ready', stage: 'complete', updatedAt: new Date().toISOString() }; })
      .catch(error => { jobStatus = { ...jobStatus, state: 'error', stage: 'failed', error: error.message, updatedAt: new Date().toISOString() }; })
      .finally(() => {
        activeJob = null;
        if (pendingTelegramRetailers.size) scheduleTelegramRefresh([]);
      });
    return true;
  }

  function telegramRetailers(sources) {
    const bsaUsername = String(env.TELEGRAM_BSA_CHANNEL || 'BigSaleApple').replace(/^@/, '').toLowerCase();
    const dimaChatId = String(env.TELEGRAM_DIMA_CHAT_ID || '-1003421701174');
    const selected = new Set();
    for (const source of sources || []) {
      if (String(source.sourceUsername || '').replace(/^@/, '').toLowerCase() === bsaUsername) selected.add('BSA');
      if (String(source.sourceChatId || '') === dimaChatId) selected.add('Дима');
    }
    return [...selected];
  }

  function scheduleTelegramRefresh(retailers) {
    for (const retailer of retailers) pendingTelegramRetailers.add(retailer);
    if (telegramRefreshTimer) clearTimeout(telegramRefreshTimer);
    telegramRefreshTimer = setTimeout(() => {
      telegramRefreshTimer = null;
      if (activeJob) return scheduleTelegramRefresh([]);
      const selected = [...pendingTelegramRetailers];
      pendingTelegramRetailers.clear();
      if (selected.length) refresh(selected);
    }, Math.max(0, Number(telegramRefreshDelayMs) || 0));
    telegramRefreshTimer.unref?.();
  }

  const server = createServer(async (req, res) => {
    try {
      const port = req.socket.localPort;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !allowedHosts.includes(req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Доступ разрешён только с локального компьютера' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'Метод не поддерживается' });
      if (path === '/api/telegram/bsa-webhook') {
        if (req.method !== 'POST') return send(res, 405, { error: 'Метод не поддерживается' });
        const supplied = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] || ''));
        const expected = Buffer.from(String(env.TELEGRAM_BUSINESS_WEBHOOK_SECRET || ''));
        if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          return send(res, 403, { error: 'Неверный секрет Telegram webhook' });
        }
        const update = await jsonBody(req);
        const task = bsaWebhookQueue.catch(() => {}).then(() => ingestBusinessUpdate(update, { env }));
        bsaWebhookQueue = task;
        const result = await task;
        const scheduledRetailers = telegramRetailers(result.acceptedSources);
        if (scheduledRetailers.length) scheduleTelegramRefresh(scheduledRetailers);
        return send(res, 200, { ok: true, accepted: result.acceptedMessages > 0, refreshScheduled: scheduledRetailers });
      }
      if (req.method === 'POST') {
        const token = Buffer.from(String(req.headers['x-csrf-token'] || ''));
        const expected = Buffer.from(csrfToken);
        const allowedOrigins = new Set([`http://${req.headers.host}`, String(env.PUBLIC_ORIGIN || 'https://dev.macbookbro.ru').replace(/\/$/, '')]);
        if (!allowedOrigins.has(req.headers.origin) || token.length !== expected.length || !timingSafeEqual(token, expected)) return send(res, 403, { error: 'Откройте мастер-таблицу и повторите действие' });
        const body = await jsonBody(req);
        if (path === '/api/refresh' || path === '/refresh') {
          const retailer = body.retailer || url.searchParams.get('retailer');
          if (retailer && !RETAILERS.includes(retailer)) return send(res, 400, { error: 'Неизвестный источник' });
          const started = refresh(retailer ? [retailer] : RETAILERS);
          return send(res, started ? 202 : 409, started ? { started: true } : { error: 'Сбор уже выполняется' });
        }
        if (path === '/api/analytics') {
          const allowedEvents = new Set(['page_view', 'order_cta', 'order_cta_mobile', 'filter_change', 'filter_reset', 'export']);
          if (!allowedEvents.has(body.event)) return send(res, 400, { error: 'Неизвестное событие аналитики' });
          const record = {
            recordedAt: new Date().toISOString(),
            event: body.event,
            path: String(body.path || '').slice(0, 200),
            properties: body.properties && typeof body.properties === 'object' && !Array.isArray(body.properties) ? body.properties : {},
          };
          await mkdir(dirname(analyticsPath), { recursive: true, mode: 0o700 });
          await appendFile(analyticsPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
          return send(res, 200, { accepted: true });
        }
        if (path === '/api/quotes') return send(res, 200, store.saveQuote(body));
        if (path === '/api/calculations') return send(res, 200, store.saveCalculation(body));
        if (path === '/api/prices') return send(res, 200, store.savePriceDecision(body));
        if (path === '/api/economics') return send(res, 200, calculateEconomics(body));
        if (path === '/api/imports/dry-run') {
          const preview = store.previewImport(body);
          const token = randomBytes(24).toString('hex');
          for (const [key, value] of previews) if (value.expiresAt < Date.now()) previews.delete(key);
          if (previews.size >= 100) previews.delete(previews.keys().next().value);
          previews.set(token, { payload: structuredClone(body), expiresAt: Date.now() + 15 * 60 * 1000 });
          return send(res, 200, { token, preview });
        }
        if (path === '/api/imports/commit') {
          const preview = previews.get(body.token);
          if (!preview || preview.expiresAt < Date.now()) return send(res, 409, { error: 'Предпросмотр истёк. Проверьте импорт заново.' });
          const result = store.commitImport(preview.payload);
          previews.delete(body.token);
          return send(res, 200, result);
        }
        return send(res, 404, { error: 'Не найдено' });
      }
      if (path === '/web/public-config.json') return send(res, 200, { mode: 'local' });
      if (path === '/api/session') return send(res, 200, { mode: 'local', csrfToken, retailers: RETAILERS });
      if (path === '/status' || path === '/api/status') return send(res, 200, { ...await status(), autoRefreshIntervalMs, nextRefreshAt });
      if (path === '/api/desktop-prices') return cachedReply(req, res, await cachedFile(responseCache, join(root, 'data/desktop-prices.json')));
      if (path === '/api/table') {
        const snapshot = await responseCache('table', store.getRevision(), () => {
          const fields = ['listingId', 'retailer', 'title', 'model', 'chip', 'screenIn', 'ramGb', 'storageGb', 'color', 'cpuCores', 'gpuCores', 'keyboard', 'region', 'price', 'currency', 'stock', 'url', 'fetchedAt', 'validFrom', 'validUntil', 'condition', 'paymentMethod', 'minimumQuantity', 'priceType', 'validationStatus', 'qualityWarnings'];
          const offers = store.getOffers({ includeRejected: true, summary: true })
            .filter(offer => offer.visibility !== 'private' && !offer.isDemo && offer.dataKind !== 'demo' && inPublicSourceScope(offer) && Number.isFinite(offer.price) && offer.price > 0)
            .map(offer => Object.fromEntries(fields.filter(field => offer[field] !== undefined).map(field => [field, offer[field]])));
          return { schemaVersion: 1, offers };
        });
        return cachedReply(req, res, snapshot);
      }
      if (path === '/api/master') {
        const catalogFile = await cachedFile(responseCache, join(root, 'data/catalog.json'));
        const snapshot = await responseCache('master', `${store.getRevision()}:${catalogFile.etag}:${Math.floor(Date.now() / 30000)}`, () => {
          const catalog = JSON.parse(catalogFile.body);
          const offers = store.getOffers({ includeRejected: true, summary: true }).filter(inPublicSourceScope);
          const rows = buildCatalogRows(catalog, offers);
          for (const quote of store.listQuotes()) {
            if (rows.some(row => row.productKey === quote.variantId || row.product.id === quote.variantId || row.offers.some(offer => offer.listingId === quote.listingId))) continue;
            rows.push({ productKey: quote.variantId || quote.id, product: { id: quote.variantId || quote.id, ...quote.variant, name: quote.title || quote.variantId || 'Ручная котировка', reviewStatus: quote.status==='confirmed'?'exact':'needs_review' }, color: quote.variant?.color || null, offers: [], best: null, emptyReason: 'Нет наблюдений рынка; вариант из ручной котировки' });
          }
          return { schemaVersion: 1, generatedAt: new Date().toISOString(), rows };
        });
        return cachedReply(req, res, snapshot);
      }
      if (path === '/api/offers') return send(res, 200, store.getOffers({ includeRejected: true }).filter(inPublicSourceScope));
      if (path === '/api/history') {
        const listingId = url.searchParams.get('listingId') || url.searchParams.get('offerId');
        if (!listingId) return send(res, 400, { error: 'Не указан listingId' });
        return send(res, 200, store.getHistory(listingId));
      }
      if (path === '/api/runs') return send(res, 200, store.getRuns({ limit: 50 }));
      if (path === '/api/sources') return send(res, 200, store.getSources());
      if (path === '/api/quotes') return send(res, 200, store.listQuotes());
      if (path === '/api/calculations') return send(res, 200, store.getCalculations());
      if (path === '/api/prices') return send(res, 200, store.listPriceDecisions());
      if (path === '/') { res.writeHead(302, { ...SECURITY_HEADERS, location: '/web/' }); return res.end(); }
      if (path === '/api/audit') return send(res, 200, store.getAudit());
      const asset = STATIC_FILES.get(path);
      if (!asset) {
        if (path.startsWith('/api/')) return send(res, 404, { error: 'Не найдено' });
        return send(res, 404, await readFile(join(root, 'web/404.html')), 'text/html; charset=utf-8');
      }
      try { return cachedReply(req, res, await cachedFile(responseCache, join(root, asset[0])), asset[1]); }
      catch { return send(res, 404, { error: 'Не найдено' }); }
    } catch (error) {
      const code = error.statusCode || (/version|conflict|конфликт/i.test(error.message) ? 409 : 400);
      send(res, code, { error: error.message || 'Не удалось выполнить действие' });
    }
  });
  // The server owns the schedule: it works without an open browser, and shares
  // the same lock with manual and Telegram-triggered collection.
  if (autoRefreshIntervalMs > 0) {
    const tick = () => {
      nextRefreshAt = new Date(Date.now() + autoRefreshIntervalMs).toISOString();
      refresh(RETAILERS);
    };
    server.once('listening', () => {
      tick();
      autoRefreshTimer = setInterval(tick, autoRefreshIntervalMs);
      autoRefreshTimer.unref?.();
    });
  }
  server.on('close', () => {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    if (telegramRefreshTimer) clearTimeout(telegramRefreshTimer);
    if (ownsStore) store.close();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const server = await createMasterServer({ autoRefreshIntervalMs: Number(process.env.AUTO_REFRESH_INTERVAL_MS ?? 3600000) });
  const bsaPolling = startBsaBusinessPolling();
  server.on('close', () => { void bsaPolling.stop(); });
  server.listen(port, '127.0.0.1', () => console.log(`Мастер-таблица: http://127.0.0.1:${port}/web/`));
}
