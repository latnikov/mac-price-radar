import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrderService, priceStatusForDate } from '../server.mjs';
import { catalog } from '../catalog.mjs';
import { pricingInfo, quoteConfigurator, quoteCustomerPrice } from '../pricing.mjs';
const order = () => ({ configuration: { model: 'mini', chip: 'm6-12-12', memory: 16, storage: 256, ethernet: 2.5 }, phone: '8 (999) 000-00-00', name: 'Тест', consent: true });
async function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mac-orders-'));
  const env = { ORDER_ORIGIN: 'https://order.example.test', ORDER_ACCEPTING: '1', ORDER_TELEGRAM_BOT_TOKEN: 'test-only', ORDER_TELEGRAM_CHAT_ID: 'test-chat', ORDER_PRICE_MAX_AGE_MS: '0', ...overrides.env };
  const args = { env, dbPath: join(directory, 'orders.sqlite'), runWorker: false, ...overrides, env };
  let service = createOrderService(args);
  await new Promise(r => service.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = (body = order(), key = 'test-order-key-0001', headers = {}) => fetch(`${base}/api/orders`, { method: 'POST', headers: { Origin: env.ORDER_ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers }, body: JSON.stringify(body) });
  return { service, post, base, args };
}
test('persists a validated order, normalizes phone, and deduplicates retried requests', async t => {
  const { service, post } = await setup(t);
  const first = await post(); assert.equal(first.status, 201);
  const result = await first.json();
  assert.equal(result.priceRub, 105319);
  assert.equal(result.priceStatus, 'estimated');
  assert.equal(result.pricingAsOf, pricingInfo.checkedAt);
  const second = await post(); assert.equal(second.status, 200); assert.equal((await second.json()).orderId, result.orderId);
  const rows = service.db.prepare('SELECT * FROM orders').all(); assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].payload).phone, '+79990000000');
  assert.equal(JSON.parse(rows[0].payload).priceRub, 105319);
  assert.equal(JSON.parse(rows[0].payload).priceStatus, 'estimated');
  assert.equal(JSON.parse(rows[0].payload).pricingAsOf, pricingInfo.checkedAt);
  assert.equal((await post({ ...order(), name: 'Другое имя' })).status, 409);
});

test('retry returns the saved order and price after a pricebook change, including legacy fingerprints', async t => {
  const { service, post } = await setup(t);
  const first = await (await post()).json();
  const row = service.db.prepare('SELECT * FROM orders WHERE id=?').get(first.orderId);
  const saved = JSON.parse(row.payload);
  saved.priceRub = 99999;
  saved.priceStatus = 'stale_estimate';
  saved.pricingAsOf = '2026-09-30T00:00:00Z';
  service.db.prepare('UPDATE orders SET payload=?, fingerprint=? WHERE id=?').run(JSON.stringify(saved), 'legacy-price-payload-hash', first.orderId);
  const retry = await post();
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { orderId: first.orderId, accepted: true, priceRub: 99999, priceStatus: 'stale_estimate', pricingAsOf: '2026-09-30T00:00:00Z' });
  assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
});

test('legacy retries infer the saved price status without inventing a verification date', async t => {
  const { service, post } = await setup(t);
  const first = await (await post()).json();
  const row = service.db.prepare('SELECT payload FROM orders WHERE id=?').get(first.orderId);
  const saved = JSON.parse(row.payload);
  delete saved.priceStatus;
  delete saved.pricingAsOf;
  for (const [priceRub, priceStatus] of [[99999, 'estimated'], [null, 'on_request']]) {
    saved.priceRub = priceRub;
    service.db.prepare('UPDATE orders SET payload=?, fingerprint=? WHERE id=?').run(JSON.stringify(saved), 'legacy-price-payload-hash', first.orderId);
    const retry = await post();
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { orderId: first.orderId, accepted: true, priceRub, priceStatus, pricingAsOf: null });
  }
  assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
});

test('expired Mac prices retain explicit dated estimates and server-calculated option differences', async t => {
  const { post, base, service } = await setup(t, { now: () => Date.parse('2026-09-29T12:00:00Z'), env: { ORDER_PRICE_MAX_AGE_MS: String(72 * 3600000) } });
  const quote = await (await fetch(`${base}/api/quote?model=mini&chip=m6-12-12&memory=16&storage=256&ethernet=2.5`)).json();
  assert.deepEqual(quote, { ...quoteConfigurator(order().configuration), priceStatus: 'stale_estimate', pricingAsOf: pricingInfo.checkedAt, currency: 'RUB' });
  const response = await post({ ...order(), priceRub: 1, priceStatus: 'estimated', pricingAsOf: '2099-01-01T00:00:00Z' });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.priceRub, 105319);
  assert.equal(result.priceStatus, 'stale_estimate');
  assert.equal(result.pricingAsOf, pricingInfo.checkedAt);
  const saved = JSON.parse(service.db.prepare('SELECT payload FROM orders').get().payload);
  assert.equal(saved.priceRub, 105319);
  assert.equal(saved.priceStatus, 'stale_estimate');
  assert.equal(saved.pricingAsOf, pricingInfo.checkedAt);
});

test('accepted quote survives pricebook expiry when the customer retries the same key', async t => {
  let clock = Date.parse('2026-09-25T12:00:00Z');
  const { post, base } = await setup(t, { now: () => clock, env: { ORDER_PRICE_MAX_AGE_MS: String(72 * 3600000) } });
  const path = '/api/quote?model=mini&chip=m6-12-12&memory=16&storage=256&ethernet=2.5';
  assert.equal((await (await fetch(base + path)).json()).priceRub, 105319);
  const first = await (await post()).json();
  assert.equal(first.priceStatus, 'estimated');
  clock = Date.parse('2026-09-29T12:00:00Z');
  const stale = await (await fetch(base + path)).json();
  assert.equal(stale.priceRub, 105319);
  assert.equal(stale.priceStatus, 'stale_estimate');
  assert.equal(stale.pricingAsOf, pricingInfo.checkedAt);
  const retry = await post();
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), first);
});

test('fresh quote cache revalidates at the exact age boundary and after prices become stale', async t => {
  const maxAge = 72 * 3600000;
  let clock = Date.parse(pricingInfo.checkedAt) + maxAge - 1;
  const { base } = await setup(t, { now: () => clock, env: { ORDER_PRICE_MAX_AGE_MS: String(maxAge) } });
  const path = '/api/quote?model=mini&chip=m6-12-12&memory=16&storage=256&ethernet=2.5';
  const first = await fetch(base + path);
  assert.equal(first.status, 200);
  const freshTag = first.headers.get('etag');
  const fresh = await first.json();
  assert.equal(fresh.priceStatus, 'estimated');
  assert.equal(fresh.pricingAsOf, pricingInfo.checkedAt);
  clock++;
  const boundary = await fetch(base + path, { headers: { 'If-None-Match': freshTag } });
  assert.equal(boundary.status, 304);
  clock++;
  const expired = await fetch(base + path, { headers: { 'If-None-Match': freshTag } });
  assert.equal(expired.status, 200);
  const staleTag = expired.headers.get('etag');
  assert.notEqual(staleTag, freshTag);
  const stale = await expired.json();
  assert.deepEqual(stale, { ...fresh, priceStatus: 'stale_estimate' });
  const repeated = await fetch(base + path, { headers: { 'If-None-Match': staleTag } });
  assert.equal(repeated.status, 304);
});

test('all 50 expired Mac configurations keep positive estimates and complete option differences', async t => {
  const { base } = await setup(t, { now: () => Date.parse(pricingInfo.checkedAt) + 73 * 3600000, env: { ORDER_PRICE_MAX_AGE_MS: String(72 * 3600000) } });
  let variants = 0;
  for (const model of catalog.models) {
    for (const chip of model.chips) {
      for (const memory of chip.memory) {
        for (const storage of chip.storage) {
          const configuration = { model: model.id, chip: chip.id, memory, storage, ethernet: model.ethernet[0] };
          const response = await fetch(`${base}/api/quote?${new URLSearchParams(configuration)}`);
          assert.equal(response.status, 200);
          const quote = await response.json();
          assert.deepEqual(quote, { ...quoteConfigurator(configuration), priceStatus: 'stale_estimate', pricingAsOf: pricingInfo.checkedAt, currency: 'RUB' });
          assert.ok(Number.isSafeInteger(quote.priceRub) && quote.priceRub > 0);
          for (const prices of Object.values(quote.stepPricesRub)) {
            assert.ok(Object.values(prices).every(Number.isSafeInteger));
          }
          variants++;
        }
      }
    }
  }
  assert.equal(variants, 50);
});

test('future price verification dates cannot produce a numerical quote or saved price', async t => {
  const { base, post, service } = await setup(t, { now: () => Date.parse(pricingInfo.checkedAt) - 1, env: { ORDER_PRICE_MAX_AGE_MS: String(72 * 3600000) } });
  const response = await fetch(`${base}/api/quote?model=mini&chip=m6-12-12&memory=16&storage=256&ethernet=2.5`);
  assert.equal(response.status, 200);
  const quote = await response.json();
  assert.equal(quote.priceRub, null);
  assert.equal(quote.priceStatus, 'on_request');
  assert.equal(quote.pricingAsOf, pricingInfo.checkedAt);
  assert.equal(quote.currency, 'RUB');
  assert.deepEqual(quote.stepPricesRub, {});
  const result = await (await post({ ...order(), priceRub: 1, priceStatus: 'estimated' })).json();
  assert.equal(result.priceRub, null);
  assert.equal(result.priceStatus, 'on_request');
  assert.equal(result.pricingAsOf, pricingInfo.checkedAt);
  const saved = JSON.parse(service.db.prepare('SELECT payload FROM orders').get().payload);
  assert.equal(saved.priceRub, null);
  assert.equal(saved.priceStatus, 'on_request');
});

test('invalid or missing verification dates require a price request while test mode remains explicit', () => {
  const clock = Date.parse('2026-09-30T12:00:00Z');
  for (const checkedAt of [null, undefined, '', 'not-a-date', '2099-01-01T00:00:00Z']) {
    assert.equal(priceStatusForDate(checkedAt, clock, 72 * 3600000), 'on_request');
  }
  assert.equal(priceStatusForDate(pricingInfo.checkedAt, clock, 0), 'estimated');
});
test('rejects forged configurations, missing consent, cross-origin calls and private paths', async t => {
  const { service, post, base } = await setup(t);
  const bad = order(); bad.configuration.memory = 512;
  assert.equal((await post(bad)).status, 400);
  const unpriced = order(); unpriced.configuration.storage = 4096;
  assert.equal((await post(unpriced)).status, 400);
  assert.equal((await post({ ...order(), consent: false })).status, 400);
  assert.equal((await post(order(), 'test-order-key-0001', { Origin: 'https://attacker.test' })).status, 403);
  assert.equal((await post({ ...order(), phone: '+7letters9990000000' })).status, 400);
  assert.equal((await post({ ...order(), website: 'spam' })).status, 400);
  assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/data/orders.sqlite`)).status, 404);
  assert.equal(service.db.prepare('SELECT count(*) AS n FROM orders').get().n, 0);
});
test('explicit Telegram rejection survives a database reopen and retries without losing order', async t => {
  let clock = 1000000; let fail = true; const messages = [];
  const fetchImpl = async (url, options) => { if (fail) return {ok:false,json:async()=>({ok:false,parameters:{retry_after:15}})}; messages.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }; };
  const { service, post, args } = await setup(t, { now: () => clock, fetchImpl });
  assert.equal((await post()).status, 201);
  await service.dispatch();
  let row = service.db.prepare('SELECT * FROM orders').get(); assert.equal(row.attempts, 1); assert.equal(row.notified_at, null);
  // A second independent process can recover the durable queue after restart.
  const recovered = createOrderService(args);
  try {
    fail = false; clock += 16000; await recovered.dispatch(); await recovered.dispatch();
    row = service.db.prepare('SELECT * FROM orders').get(); assert.equal(row.notified_at, clock);
    assert.equal(messages.length, 1); assert.match(messages[0].text, /\+79990000000/); assert.match(messages[0].text, /Mac mini/);
  } finally { await recovered.close(); }
});
test('uncertain notification never repeats after restart and preserves the accepted order', async t => {
  let calls=0,clock=1000000;
  const fetchImpl=async()=>{calls++;throw new Error('connection lost after submission');};
  const {service,post,args}=await setup(t,{now:()=>clock,fetchImpl});
  assert.equal((await post()).status,201);
  await service.dispatch();
  assert.equal(service.db.prepare('SELECT notification_state FROM orders').get().notification_state,'unknown');
  const recovered=createOrderService(args);
  try{clock+=86400000;await recovered.dispatch();assert.equal(calls,1);assert.equal(recovered.db.prepare('SELECT COUNT(*) n FROM orders').get().n,1);}
  finally{await recovered.close();}
});
test('preview cannot accept orders and rate limit does not block an idempotent retry', async t => {
  const preview = await setup(t, { env: { ORDER_ACCEPTING: '0' } });
  assert.equal((await preview.post()).status, 503);
  assert.equal((await (await fetch(`${preview.base}/api/status`)).json()).acceptingOrders, false);
  const live = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await live.post(order(), `test-rate-limit-${i}`)).status, 201);
  assert.equal((await live.post(order(), 'test-rate-limit-6')).status, 429);
  assert.equal((await live.post(order(), 'test-rate-limit-0')).status, 200);
});
test('relay queue is authenticated, leased, recovered after timeout and acknowledged idempotently', async t => {
  let clock = 1000000;
  const key = 'test-only-relay-secret-not-production-12345';
  const { service, post, base } = await setup(t, { env: { ORDER_DELIVERY_MODE: 'relay', ORDER_RELAY_KEY: key }, now: () => clock });
  const relay = (path, body = {}, auth = key) => fetch(`${base}/api/relay/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post()).status, 201);
  assert.equal((await relay('status', {}, 'wrong')).status, 403);
  assert.deepEqual(await (await relay('status')).json(), { acceptingOrders: true, pendingNotifications: 1, oldestPendingSeconds: 0 });
  assert.equal((await relay('claim', {}, 'wrong')).status, 403);
  const first = (await (await relay('claim')).json()).notifications[0];
  assert.match(first.text, /Mac mini/);
  assert.match(first.text, /105[\s ]319 ₽/);
  assert.equal((await (await relay('claim')).json()).notifications.length, 0);
  clock += 181000;
  const next = (await (await relay('claim')).json()).notifications[0];
  assert.notEqual(first.lease, next.lease);
  assert.equal((await relay('ack', { orderId: first.orderId, lease: first.lease })).status, 409);
  assert.equal((await relay('ack', { orderId: next.orderId, lease: next.lease })).status, 200);
  assert.equal((await relay('ack', { orderId: next.orderId, lease: next.lease })).status, 200);
  assert.equal((await (await relay('claim')).json()).notifications.length, 0);
  assert.equal(service.db.prepare('SELECT notified_at FROM orders').get().notified_at, clock);
  assert.deepEqual(await (await relay('status')).json(), { acceptingOrders: true, pendingNotifications: 0, oldestPendingSeconds: null });
});

test('stale estimate relay explains the indicative amount and original verification date', async t => {
  const key = 'test-only-relay-secret-not-production-12345';
  const { post, base } = await setup(t, { now: () => Date.parse('2026-09-30T12:00:00Z'), env: { ORDER_DELIVERY_MODE: 'relay', ORDER_RELAY_KEY: key, ORDER_PRICE_MAX_AGE_MS: String(72 * 3600000) } });
  const accepted = await post();
  assert.equal(accepted.status, 201);
  const response = await fetch(`${base}/api/relay/claim`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  const { notifications } = await response.json();
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /Ориентировочная цена: 105[\s ]319 ₽/);
  assert.match(notifications[0].text, /25\.09\.2026/);
  assert.match(notifications[0].text, /подтвер|уточн/i);
  assert.doesNotMatch(notifications[0].text, /NaN|undefined/);
});

test('keeps the 50 base totals private and publishes only final ruble quotes', async t => {
  const pricedConfigurations = catalog.models.reduce((sum, model) => sum + model.chips.reduce((chipSum, chip) => chipSum + chip.memory.length * chip.storage.length, 0), 0);
  assert.equal(pricedConfigurations, 50);
  assert.equal(pricingInfo.configurationCount, 50);
  assert.equal(quoteCustomerPrice(order().configuration), 105319);
  assert.equal(quoteCustomerPrice({ model: 'studio', chip: 'm5max-18-40', memory: 128, storage: 2048, ethernet: 10 }), 675319);
  assert.equal(quoteCustomerPrice({ model: 'studio', chip: 'm5ultra-36-80', memory: 256, storage: 2048, ethernet: 10 }), 1275878);
  const { base } = await setup(t);
  const [page, catalogSource, quote, privatePricing] = await Promise.all([
    fetch(base).then(response => response.text()),
    fetch(`${base}/catalog.mjs`).then(response => response.text()),
    fetch(`${base}/api/quote?model=mini&chip=m6-12-12&memory=16&storage=256&ethernet=2.5`).then(response => response.json()),
    fetch(`${base}/pricing.mjs`),
  ]);
  assert.doesNotMatch(page, /<select\b/i);
  assert.match(page, /id="storage-options"/);
  assert.match(page, /насколько цена увеличится или уменьшится/);
  assert.doesNotMatch(page, /Свериться с конфигуратором Apple/);
  assert.doesNotMatch(catalogSource, /prices|1189|applePrice|purchasePrice|procurement|customs|delivery/i);
  assert.deepEqual(quote, { ...quoteConfigurator(order().configuration), priceStatus: 'estimated', pricingAsOf: pricingInfo.checkedAt, currency: 'RUB' });
  assert.equal(quote.stepPricesRub.memory[16], 0);
  assert.equal(quote.stepPricesRub.memory[24], 22145);
  assert.equal(quote.stepPricesRub.memory[32], 44289);
  assert.equal(quote.stepPricesRub.storage[512], 22145);
  assert.equal(quote.stepPricesRub.chip['m5pro-15-16'], 88844);
  assert.equal(privatePricing.status, 404);
  assert.equal((await fetch(`${base}/pixel-pricing.mjs`)).status, 404);
});

test('quotes both surcharges and savings relative to the current selection', () => {
  const quote = quoteConfigurator({ model: 'mini', chip: 'm6-12-12', memory: 24, storage: 512, ethernet: 2.5 });
  assert.equal(quote.priceRub, 149608);
  assert.equal(quote.stepPricesRub.memory[16], -22144);
  assert.equal(quote.stepPricesRub.memory[24], 0);
  assert.equal(quote.stepPricesRub.memory[32], 22145);
  assert.equal(quote.stepPricesRub.storage[256], -22144);
  assert.equal(quote.stepPricesRub.storage[512], 0);
  assert.equal(quote.stepPricesRub.chip['m6-12-12'], 0);
});

test('assets and quotes revalidate without caching orders, status or relay responses', async t => {
  const { base, post } = await setup(t);
  for (const path of ['/', '/app.js', '/quote-client.mjs', '/selection-link.mjs', '/catalog.mjs', '/style.css', '/api/quote?model=mini&chip=m6-12-12&memory=16&storage=256&ethernet=2.5']) {
    const first = await fetch(base + path);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    const etag = first.headers.get('etag');
    const bytes = await first.arrayBuffer();
    assert.equal(Number(first.headers.get('content-length')), bytes.byteLength);
    const second = await fetch(base + path, { headers: { 'If-None-Match': `"other", W/${etag}` } });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), '');
    if (!path.startsWith('/api/')) {
      const head = await fetch(base + path, { method: 'HEAD' });
      assert.equal(head.headers.get('etag'), etag);
      assert.equal(Number(head.headers.get('content-length')), bytes.byteLength);
      assert.equal(await head.text(), '');
    }
  }
  for (const path of ['/api/status', '/api/relay/claim', '/http-cache.mjs', '/api/quote?model=invalid']) {
    const response = await fetch(base + path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('etag'), null);
  }
  assert.equal((await post()).headers.get('cache-control'), 'no-store');
});

test('all 25 Pixel variants validate, quote and reject forged storage/model values', async t => {
  const { base, post, service } = await setup(t);
  let variants = 0;
  assert.equal(catalog.pixelModels.length, 9);
  for (const phone of catalog.pixelModels) {
    for (const storage of phone.storage) {
      variants++;
      const configuration = { model: 'pixel', phone: phone.id, storage };
      const response = await fetch(`${base}/api/quote?${new URLSearchParams(configuration)}`);
      assert.equal(response.status, 200);
      const quote = await response.json();
      assert.equal(quote.priceRub, null); // No invented retail price without an approved supplier price.
      assert.equal(quote.priceStatus, 'on_request');
      assert.equal(quote.pricingAsOf, null);
      assert.equal(quote.currency, 'RUB');
      assert.deepEqual(Object.keys(quote.stepPricesRub['pixel-storage']).map(Number), phone.storage);
      assert.equal(quote.stepPricesRub.phone[phone.id], null);
    }
  }
  assert.equal(variants, 25);
  for (const phone of ['pixel-99', 'pixel-11']) {
    assert.equal((await fetch(`${base}/api/quote?model=pixel&phone=${phone}&storage=99999`)).status, 400);
  }
  const payload = { ...order(), configuration: { model: 'pixel', phone: 'pixel-11-pro', storage: 512 }, paymentMethod: 'invoice', priceRub: 1, priceStatus: 'estimated', pricingAsOf: '2099-01-01T00:00:00Z' };
  const response = await post(payload);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.priceRub, null);
  assert.equal(result.priceStatus, 'on_request');
  assert.equal(result.pricingAsOf, null);
  const saved = JSON.parse(service.db.prepare('SELECT payload FROM orders').get().payload);
  assert.equal(saved.priceRub, null);
  assert.equal(saved.priceStatus, 'on_request');
  assert.equal(saved.pricingAsOf, null);
  assert.equal(saved.paymentMethod, 'invoice');
  assert.match(saved.configurationDescription, /Pixel 11 Pro \(512 ГБ, 16 ГБ/);
  const retry = await post(payload);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), result);
  assert.equal((await post({ ...payload, paymentMethod: 'cash' })).status, 409);
});

test('custom product requests and payment allowlist work without quoting zero rubles', async t => {
  const { post, service, base } = await setup(t);
  const payload = { ...order(), configuration: { model: 'other', description: '  MacBook Air 16/512  ' }, paymentMethod: 'cash' };
  const response = await post(payload);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.priceRub, null);
  assert.equal(result.priceStatus, 'on_request');
  assert.equal(result.pricingAsOf, null);
  const saved = JSON.parse(service.db.prepare('SELECT payload FROM orders').get().payload);
  assert.equal(saved.configuration.description, 'MacBook Air 16/512');
  for (const description of ['', 'a', 'x'.repeat(501), 'Injected\nmessage']) {
    assert.equal((await post({ ...payload, configuration: { model: 'other', description } })).status, 400);
  }
  for (const paymentMethod of ['bitcoin', 'crypto', 'card', {}, null]) {
    assert.equal((await post({ ...payload, paymentMethod })).status, 400);
  }
  const page = await (await fetch(base)).text();
  assert.doesNotMatch(page, /bitcoin|крипт|битко/i);
  assert.match(page, /Перевод на расчётный счёт от ИП\/юрлица/);
  assert.match(page, /Наличные/);
});

test('Pixel and custom requests survive restart and relay with payment and no false price', async t => {
  const key = 'test-only-relay-secret-not-production-12345';
  const { post, args } = await setup(t, { env: { ORDER_DELIVERY_MODE: 'relay', ORDER_RELAY_KEY: key } });
  await post({ ...order(), configuration: { model: 'pixel', phone: 'pixel-10a', storage: 128 }, paymentMethod: 'invoice' }, 'pixel-restart-key-0001');
  await post({ ...order(), configuration: { model: 'other', description: '<b>MacBook Air</b>' }, paymentMethod: 'cash' }, 'other-restart-key-0001');
  const recovered = createOrderService(args);
  await new Promise(r => recovered.server.listen(0, '127.0.0.1', r));
  try {
    const response = await fetch(`http://127.0.0.1:${recovered.server.address().port}/api/relay/claim`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{}' });
    const { notifications } = await response.json();
    assert.equal(notifications.length, 2);
    assert.match(notifications[0].text, /Google Pixel 10a/);
    assert.match(notifications[0].text, /Перевод на расчётный счёт от ИП\/юрлица/);
    assert.match(notifications[1].text, /Другой товар: <b>MacBook Air<\/b>/);
    for (const { text } of notifications) {
      assert.match(text, /Цена: по запросу/);
      assert.doesNotMatch(text, /0 ₽|NaN|undefined/);
    }
  } finally { await recovered.close(); }
});
