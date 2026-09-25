import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrderService } from '../server.mjs';
import { catalog } from '../catalog.mjs';
import { pricingInfo, quoteConfigurator, quoteCustomerPrice } from '../pricing.mjs';
const order = () => ({ configuration: { model: 'mini', chip: 'm6-12-12', memory: 16, storage: 256, ethernet: 2.5 }, phone: '8 (999) 000-00-00', name: 'Тест', consent: true });
async function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mac-orders-'));
  const env = { ORDER_ORIGIN: 'https://order.example.test', ORDER_ACCEPTING: '1', ORDER_TELEGRAM_BOT_TOKEN: 'test-only', ORDER_TELEGRAM_CHAT_ID: 'test-chat', ...overrides.env };
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
  const second = await post(); assert.equal(second.status, 200); assert.equal((await second.json()).orderId, result.orderId);
  const rows = service.db.prepare('SELECT * FROM orders').all(); assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].payload).phone, '+79990000000');
  assert.equal(JSON.parse(rows[0].payload).priceRub, 105319);
  assert.equal((await post({ ...order(), name: 'Другое имя' })).status, 409);
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
test('delivery failure survives a database reopen and retries successfully without losing order', async t => {
  let clock = 1000000; let fail = true; const messages = [];
  const fetchImpl = async (url, options) => { if (fail) throw new Error('offline'); messages.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }; };
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
  assert.match(page, /У базового варианта показана полная цена с ним/);
  assert.doesNotMatch(page, /Свериться с конфигуратором Apple/);
  assert.doesNotMatch(catalogSource, /prices|1189|applePrice|purchasePrice|procurement|customs|delivery/i);
  assert.deepEqual(quote, { ...quoteConfigurator(order().configuration), currency: 'RUB' });
  assert.deepEqual(quote.basePricesRub, { chip: 105319, memory: 105319, storage: 105319, ethernet: 105319 });
  assert.equal(quote.stepPricesRub.memory[16], 0);
  assert.equal(quote.stepPricesRub.memory[24], 22145);
  assert.equal(quote.stepPricesRub.memory[32], 44289);
  assert.equal(quote.stepPricesRub.storage[512], 22145);
  assert.equal(quote.stepPricesRub.chip['m5pro-15-16'], 88844);
  assert.equal(privatePricing.status, 404);
});
