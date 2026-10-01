import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGoogleRate, parseCbrRate, findAppleGuides, findMacGuides, findPriceGuides, parseAppleGuide, convertForeignPrices, refreshForeignPrices, readForeignPrices, GUIDE_URL, IPHONE_GUIDE_URL, RATE_URL } from '../scripts/foreign-prices.mjs';

const guideUrl = 'https://prices.appleinsider.com/macbook-air-13-inch-m5';
// Synthetic contract fixture; real browser samples are tested below.
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

test('server discovery retains Macs and includes exactly the four requested iPhone Pro guides', () => {
  const paths = ['iphone-18-pro', 'iphone-18-pro-max', 'iphone-17-pro', 'iphone-17-pro-max'];
  const html = `<a href="${guideUrl}">Air</a>` + paths.map(path => `<a href="/${path}">${path}</a><a href="/${path}#prices">duplicate</a>`).join('')
    + '<a href="/iphone-18">Base</a><a href="/iphone-16-pro">Old</a><a href="/ipad-pro">iPad</a><a href="https://other.test/iphone-18-pro">Other</a>';
  assert.deepEqual(findPriceGuides(html), [guideUrl, ...paths.map(path => `https://prices.appleinsider.com/${path}`)]);
  assert.throws(() => findPriceGuides('<h1>Access denied</h1>'));
});

test('server refresh discovers phone category and records confirmed phone prices with their real check date', async t => {
  const root = await mkdtemp(join(tmpdir(), 'foreign-phones-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = ['iphone-18-pro', 'iphone-18-pro-max', 'iphone-17-pro', 'iphone-17-pro-max'];
  const fetchPage = async url => url === GUIDE_URL ? `<a href="${guideUrl}">Air</a>` : url === RATE_URL ? rateHtml
    : url === IPHONE_GUIDE_URL ? paths.map(path => `<a href="/${path}">${path}</a>`).join('')
      : url === guideUrl ? guide : `<h1>${new URL(url).pathname.slice(1).replace(/-/g, ' ')} Prices</h1><table><tr><th>Configuration</th><th>Best Price</th></tr><tr><td>256GB, Silver, eSIM</td><td>$1,199</td></tr></table>`;
  const now = '2026-10-01T01:00:00Z';
  const saved = await refreshForeignPrices({ root, fetchPage, now: () => now });
  assert.equal(saved.guides, 5);
  const phones = saved.rows.filter(row => row.category === 'iPhone');
  assert.equal(phones.length, 4);
  assert.ok(phones.every(row => row.fetchedAt === now && row.usd === 1199));
  await assert.rejects(refreshForeignPrices({ root, fetchPage: async url => url === IPHONE_GUIDE_URL ? Promise.reject(new Error('iPhone catalog blocked')) : fetchPage(url) }));
  const failed = await readForeignPrices(root);
  assert.equal(failed.state, 'error'); assert.equal(failed.updatedAt, saved.updatedAt);
  assert.deepEqual(failed.rows, saved.rows);
  await assert.rejects(refreshForeignPrices({ root, fetchPage: async url => url === IPHONE_GUIDE_URL ? '<h1>Just a moment</h1>' : fetchPage(url) }), /недоступен каталог iPhone/);
  assert.deepEqual((await readForeignPrices(root)).rows, saved.rows);
});
test('failed and partial collections preserve last good prices, rate and timestamps', async t => {
  const root = await mkdtemp(join(tmpdir(), 'foreign-prices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetchPage = async url => url === GUIDE_URL ? `<a href="${guideUrl}">Air</a>` : url === RATE_URL ? rateHtml : guide;
  const original = await refreshForeignPrices({ root, fetchPage, now: () => '2026-09-30T00:00:00Z' });
  assert.equal(original.rows.length, 2);
  assert.equal(original.effectiveRate, 87.7504);
  await writeFile(join(root, 'data/private/foreign-request.json'), JSON.stringify({ requestedAt: '2026-09-30T00:30:00Z' }));
  await assert.rejects(refreshForeignPrices({ root, now: () => '2026-09-30T01:00:00Z', fetchPage: async url => {
    if (url === RATE_URL) throw new Error('HTTP 403: Google');
    return fetchPage(url);
  } }), /403/);
  let saved = await readForeignPrices(root);
  assert.equal(saved.state, 'error');
  assert.equal(saved.updatedAt, original.updatedAt);
  assert.deepEqual(saved.rows, original.rows);
  assert.equal(saved.attemptedAt, '2026-09-30T01:00:00Z');
  assert.equal(saved.requestedAt, undefined);
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

test('real browser tables read full prices and exclude carrier installments and other speaker brands', async () => {
  const fixture = path => readFile(new URL(`./fixtures/foreign/${path}.html`, import.meta.url), 'utf8');
  const air = parseAppleGuide(await fixture('macbook-air-15-inch-m5'), 'https://prices.appleinsider.com/macbook-air-15-inch-m5');
  assert.deepEqual(air.map(row => row.usd), [1399, 1429]);
  assert.equal(air[0].category, 'Mac');
  const phone = parseAppleGuide(await fixture('iphone-18-pro'), 'https://prices.appleinsider.com/iphone-18-pro');
  assert.deepEqual(phone.map(row => row.usd), [1199, 1199]);
  const speakers = parseAppleGuide(await fixture('smart-speakers'), 'https://prices.appleinsider.com/smart-speakers');
  assert.equal(speakers.length, 7);
  assert.ok(speakers.every(row => /HomePod/.test(row.configuration)));
});

test('CBR rate selects USD and accounts for nominal with an explicit date', () => {
  const xml = '<ValCurs Date="30.09.2026"><Valute><CharCode>EUR</CharCode><Nominal>1</Nominal><Value>99,1234</Value></Valute><Valute><CharCode>USD</CharCode><Nominal>10</Nominal><Value>844,2830</Value></Valute></ValCurs>';
  const rate = parseCbrRate(xml);
  assert.equal(rate.usdRate, 84.4283);
  assert.equal(rate.rateDate, '30.09.2026');
  assert.equal(convertForeignPrices([{ usd: 1399 }], rate.usdRate)[0].rub, 123711);
  assert.throws(() => parseCbrRate(xml.replace('<Nominal>10</Nominal>', '<Nominal>0</Nominal>')));
  assert.throws(() => parseCbrRate(xml.replace('USD', 'GBP')));
  assert.throws(() => parseCbrRate('<html>403</html>'));
});

test('all-line discovery excludes external hosts, retailer redirects and trade-in', () => {
  assert.deepEqual(findAppleGuides('<a href="/ipad-pro-11-inch-m5">iPad</a><a href="/iphone-18-pro">Phone</a><a href="/apple-watch-series-12">Watch</a><a href="/product/ipad/x">SKU</a><a href="/trade-in">Trade</a><a href="https://other.test/macbook-pro">Other</a>'), ['https://prices.appleinsider.com/ipad-pro-11-inch-m5', 'https://prices.appleinsider.com/iphone-18-pro', 'https://prices.appleinsider.com/apple-watch-series-12']);
});

test('pending Mac request is visible without changing saved prices or collection date', async t => {
  const root = await mkdtemp(join(tmpdir(), 'foreign-mac-request-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetchPage = async url => url === GUIDE_URL ? `<a href="${guideUrl}">Air</a>` : url === RATE_URL ? rateHtml : guide;
  const original = await refreshForeignPrices({ root, fetchPage, now: () => '2026-09-30T00:00:00Z' });
  await writeFile(join(root, 'data/private/foreign-request.json'), JSON.stringify({ requestedAt: '2026-09-30T01:00:00Z' }));
  const saved = await readForeignPrices(root);
  assert.equal(saved.requestedAt, '2026-09-30T01:00:00Z');
  assert.equal(saved.updatedAt, original.updatedAt);
  assert.deepEqual(saved.rows, original.rows);
});
