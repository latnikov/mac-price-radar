import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createExchangeRateProvider, parseCbrUsdRate, CBR_RATE_URL, RATE_REFRESH_MS } from '../exchange-rate.mjs';
import { pricingInfo } from '../pricing.mjs';

const timestamp = Date.parse('2026-10-01T12:00:00Z');
const xml = (value = '83,5588', date = '01.10.2026', nominal = '1') => `<?xml version="1.0" encoding="windows-1251"?><ValCurs Date="${date}" name="Foreign Currency Market"><Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>${nominal}</Nominal><Name>Доллар США</Name><Value>${value}</Value></Valute></ValCurs>`;
function provider(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  const rates = createExchangeRateProvider({ db, fallback: pricingInfo, now: () => timestamp, onError: () => {}, ...options });
  t.after(async () => { await rates.close(); db.close(); });
  return { db, rates };
}

test('parses the official USD value, decimal comma, nominal and Moscow effective date', () => {
  assert.deepEqual(parseCbrUsdRate(xml(), timestamp), {
    usdRub: 83.5588, rateDate: '2026-10-01', checkedAt: '2026-09-30T21:00:00.000Z',
    fetchedAt: '2026-10-01T12:00:00.000Z', source: CBR_RATE_URL,
  });
  assert.ok(Math.abs(parseCbrUsdRate(xml('8355,88', '01.10.2026', '100'), timestamp).usdRub - 83.5588) < 1e-10);
  assert.equal(parseCbrUsdRate(xml('83.5'), timestamp).usdRub, 83.5);
  assert.equal(parseCbrUsdRate(xml('83', '02.10.2026'), Date.parse('2026-10-01T21:00:00Z')).rateDate, '2026-10-02');
});

test('rejects bad currency data, duplicates, invalid dates, future rates and XML entities', () => {
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1e2', '83abc', '', '1000001']) assert.throws(() => parseCbrUsdRate(xml(value), timestamp));
  for (const nominal of ['0', '-1', '1.5']) assert.throws(() => parseCbrUsdRate(xml('83', '01.10.2026', nominal), timestamp));
  for (const date of ['31.09.2026', '01.13.2026', '2026-10-01', '02.10.2026']) assert.throws(() => parseCbrUsdRate(xml('83', date), timestamp));
  assert.throws(() => parseCbrUsdRate(xml().replace('USD', 'EUR'), timestamp));
  assert.throws(() => parseCbrUsdRate(xml().replace('</ValCurs>', `${xml().match(/<Valute[\s\S]*<\/Valute>/)[0]}</ValCurs>`), timestamp));
  assert.throws(() => parseCbrUsdRate('<html>temporary outage</html>', timestamp));
  assert.throws(() => parseCbrUsdRate(`<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]>${xml()}`, timestamp));
});

test('requests today in Moscow, shares one fetch and refreshes hourly without request flooding', async t => {
  let clock = timestamp, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const { rates } = provider(t, {
    now: () => clock,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(new URL(url).origin, 'https://www.cbr.ru');
      assert.equal(new URL(url).searchParams.get('date_req'), '01/10/2026');
      assert.ok(options.signal instanceof AbortSignal);
      await gate;
      return new Response(xml());
    },
  });
  const first = rates.refreshIfDue(), second = rates.refreshIfDue();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(calls, 1);
  clock += RATE_REFRESH_MS - 1;
  await rates.refreshIfDue();
  assert.equal(calls, 1);
  clock++;
  await rates.refreshIfDue();
  assert.equal(calls, 2);
});

test('retains the last valid rate on timeout, bad HTTP/XML, oversized or older data; retries after five minutes', async t => {
  let clock = timestamp, result = () => new Response(xml()), calls = 0;
  const { rates, db } = provider(t, { now: () => clock, fetchImpl: async () => { calls++; return result(); } });
  const valid = await rates.refresh();
  const saved = db.prepare('SELECT data FROM order_exchange_rate').get().data;
  for (const invalid of [
    () => { throw new Error('timeout'); }, () => new Response(xml(), { status: 503 }),
    () => new Response('invalid XML'), () => new Response('x'.repeat(65537)),
    () => new Response(xml('82', '30.09.2026')), () => new Response(xml('83', '02.10.2026')),
  ]) {
    result = invalid;
    assert.deepEqual(await rates.refresh(), valid);
    assert.equal(db.prepare('SELECT data FROM order_exchange_rate').get().data, saved);
  }
  const before = calls;
  clock += 5 * 60000 - 1;
  await rates.refreshIfDue();
  assert.equal(calls, before);
  clock++;
  result = () => new Response(xml('84'));
  await rates.refreshIfDue();
  assert.equal(calls, before + 1);
  assert.equal(rates.current().usdRub, 84);
});

test('restores the saved rate after restart, keeps its source date and never re-dates stale data', async t => {
  const { db, rates } = provider(t, { fetchImpl: async () => new Response(xml('83', '28.09.2026')) });
  const original = await rates.refresh();
  const reopened = createExchangeRateProvider({ db, fallback: pricingInfo, now: () => timestamp, fetchImpl: async () => { throw new Error('offline'); }, onError: () => {} });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.current(), original);
  assert.deepEqual(await reopened.refresh(), original);
  assert.equal(reopened.current().checkedAt, '2026-09-27T21:00:00.000Z');
  assert.equal(reopened.current().fetchedAt, '2026-10-01T12:00:00.000Z');
});

test('first-start outage retains the explicit legacy fallback; corrupt cache cannot set the price', async t => {
  const { db, rates } = provider(t, { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await rates.refresh()).usdRub, pricingInfo.usdRub);
  assert.equal(rates.current().checkedAt, pricingInfo.checkedAt);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_exchange_rate').get().n, 0);
  db.prepare('INSERT INTO order_exchange_rate VALUES(1,?)').run('{"usdRub":0}');
  const reopened = createExchangeRateProvider({ db, fallback: pricingInfo, now: () => timestamp, onError: () => {} });
  t.after(() => reopened.close());
  assert.equal(reopened.current().usdRub, pricingInfo.usdRub);
});

test('shutdown aborts a refresh before the database can close', async t => {
  const { rates } = provider(t, { fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const pending = rates.refresh();
  await rates.close();
  await pending;
  assert.equal(rates.current().usdRub, pricingInfo.usdRub);
});
