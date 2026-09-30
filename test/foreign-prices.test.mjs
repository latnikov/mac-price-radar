import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGoogleRate, findMacGuides, parseAppleGuide, convertForeignPrices, refreshForeignPrices, readForeignPrices, GUIDE_URL, RATE_URL } from '../scripts/foreign-prices.mjs';

const guideUrl = 'https://prices.appleinsider.com/macbook-air-13-inch-m5';
// Contract fixture, not a saved live scrape: live access currently returns HTTP 403.
const guide = `<h1>M5 MacBook Air 13-inch Prices</h1><table>
<tr><th>Configurations</th><th>Best Price</th><th>Apple</th><th>Discount</th></tr>
<tr><td>M5, 16GB, 512GB, Silver</td><td><a href="/go/shop">$1,239.99</a></td><td>$1,299</td><td>$60</td></tr>
<tr><td>M5, 16GB, 512GB, Midnight</td><td>$1,199 with coupon</td><td>$1,299</td><td>$100</td></tr>
<tr><td>M5, 24GB, 1TB, Silver</td><td>sold out</td><td>$1,899</td><td>$200</td></tr>
<tr><td>M5, 32GB, 1TB, Silver</td><td>$99/mo</td><td>$2,199</td><td>$200</td></tr></table>`;
const rateHtml = '<body>USD / RUB<div class="YMlKec fxKbKc">83.7504</div><div class="YMlKec fxKbKc">94.9</div></body>';

test('foreign parser uses only Best Price, preserves configs and coupon terms', () => {
  const rows = parseAppleGuide(guide, guideUrl);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].usd, 1239.99);
  assert.equal(rows[0].configuration, 'M5, 16GB, 512GB, Silver');
  assert.equal(rows[0].offerUrl, 'https://prices.appleinsider.com/go/shop');
  assert.equal(rows[1].terms, 'with coupon');
  assert.throws(() => parseAppleGuide('<h1>Just a moment</h1>', guideUrl));
  assert.throws(() => parseAppleGuide(guide.replace('Best Price', 'Savings'), guideUrl));
});
test('Google rate is explicit USD/RUB and markup changes fail closed', () => {
  assert.equal(parseGoogleRate(rateHtml), 83.7504);
  assert.throws(() => parseGoogleRate(rateHtml.replace('USD / RUB', 'EUR / RUB')));
  assert.throws(() => parseGoogleRate('<body>USD / RUB 90.00</body>'));
  assert.throws(() => parseGoogleRate(rateHtml.replace('83.7504', 'Unavailable')));
});
test('conversion adds four rubles to rate before multiplication and rounds final rubles', () => {
  const rows = convertForeignPrices([{ usd: 1239.99 }], 83.7504);
  assert.equal(rows[0].rub, 108810);
  assert.equal(rows[0].usd, 1239.99);
  assert.throws(() => convertForeignPrices([], NaN));
});
test('guide discovery stays on source host and limits scope to Macs', () => {
  assert.deepEqual(findMacGuides(`<a href="${guideUrl}">Air</a><a href="${guideUrl}#prices">Air</a><a href="https://other.test/macbook-pro">Bad</a><a href="/ipad-pro">iPad</a>`), [guideUrl]);
  assert.throws(() => findMacGuides('<h1>Access denied</h1>'));
});
test('failed and partial collections preserve last good prices, rate and timestamps', async t => {
  const root = await mkdtemp(join(tmpdir(), 'foreign-prices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetchPage = async url => url === GUIDE_URL ? `<a href="${guideUrl}">Air</a>` : url === RATE_URL ? rateHtml : guide;
  const original = await refreshForeignPrices({ root, fetchPage, now: () => '2026-09-30T00:00:00Z' });
  assert.equal(original.rows.length, 2);
  assert.equal(original.effectiveRate, 87.7504);
  await assert.rejects(refreshForeignPrices({ root, now: () => '2026-09-30T01:00:00Z', fetchPage: async url => {
    if (url === RATE_URL) throw new Error('HTTP 403: Google');
    return fetchPage(url);
  } }), /403/);
  let saved = await readForeignPrices(root);
  assert.equal(saved.state, 'error');
  assert.equal(saved.updatedAt, original.updatedAt);
  assert.deepEqual(saved.rows, original.rows);
  assert.equal(saved.attemptedAt, '2026-09-30T01:00:00Z');
  await assert.rejects(refreshForeignPrices({ root, fetchPage: async url => url === guideUrl ? '<h1>Challenge</h1>' : fetchPage(url) }));
  saved = await readForeignPrices(root);
  assert.deepEqual(saved.rows, original.rows);
  assert.equal(saved.googleRate, original.googleRate);
});
test('first blocked collection saves honest empty error state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'foreign-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(refreshForeignPrices({ root, fetchPage: async () => { throw new Error('HTTP 403'); } }));
  const saved = await readForeignPrices(root);
  assert.equal(saved.state, 'error');
  assert.deepEqual(saved.rows, []);
  assert.equal(saved.googleRate, undefined);
});
