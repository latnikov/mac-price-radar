import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStore77Fetch, discoverStore77Categories, parseStore77Category, parseStore77Product, fetchStore77Offers } from '../scripts/store77.mjs';
import { buildPriceTable, prepareTableOffers, currentPrice } from '../web/price-table.js';

const page = 'https://store77.net/apple_macbook_air_m5/';
const fetchedAt = '2026-10-01T17:00:00Z';
const fixture = await readFile(new URL('./fixtures/store77/air-m5.html', import.meta.url), 'utf8');
const productFixture = await readFile(new URL('./fixtures/store77/air-product.html', import.meta.url), 'utf8');
function productHtml(reference) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return `<h1>${escape(reference.evidence.sourceProductTitle)}</h1><link rel="canonical" href="${escape(reference.url)}"><div class="b-big-offer-popup__info"><h2 class="bp_text_info">${escape(reference.evidence.sourceProductTitle)}</h2><p class="bp_text_price">${reference.price} —</p><a data-type="addBasket" data-id="${reference.sourceProductId}" data-price="${reference.price}">В корзину</a></div>`;
}

test('Store77 reads full catalogue prices and preserves localized/warranty variants', () => {
  const result = parseStore77Category(fixture, page, { fetchedAt });
  assert.equal(result.cards, 24);
  assert.equal(result.offers.length, 24);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.pages, [page + '?PAGEN_1=2', page + '?PAGEN_1=3']);
  const ordinary = result.offers.find(o => o.color === 'Starlight' && o.storageGb === 512 && o.keyboardLocalization === 'none');
  const localized = result.offers.find(o => o.color === 'Starlight' && o.storageGb === 512 && o.keyboardLocalization === 'localized' && !o.warrantyYears);
  assert.equal(ordinary.price, 122980);
  assert.equal(ordinary.model, 'MacBook Air 13"');
  assert.equal(ordinary.chip, 'M5');
  assert.equal(ordinary.keyboard, 'unknown');
  assert.equal(localized.keyboard, 'RU-localized');
  assert.notEqual(localized.externalId, ordinary.externalId);
  assert.ok(localized.price > ordinary.price);
  assert.ok(result.offers.some(o => o.warrantyYears === 2 && o.bundle === '2 года гарантии'));
  assert.ok(result.offers.some(o => o.color === 'Midnight'));
  assert.ok(result.offers.every(o => !o.qualityWarnings.length && o.stock === 'InStock' && o.priceType === 'full'));
});

test('localized versions never absorb ordinary offers or supply their keyboard during table inference', () => {
  const offers = parseStore77Category(fixture, page, { fetchedAt }).offers.filter(o => o.model === 'MacBook Air 13"' && o.color === 'Starlight' && o.storageGb === 512);
  const rows = buildPriceTable(prepareTableOffers(offers), { now: Date.parse(fetchedAt) });
  assert.equal(rows.length, 3);
  const original = rows.find(row => row.sample.keyboardLocalization === 'none');
  assert.equal(original.sample.keyboard, 'unknown');
  assert.equal(original.offers.length, 1);
  assert.equal(original.analytics.averageRetail, null, 'Moscow does not contribute to the Nizhny average');
});

test('catalogue/basket mismatch is rejected and unavailable cards cannot become current', () => {
  const changed = fixture.replace('data-price="122980"', 'data-price="1000"');
  const result = parseStore77Category(changed, page);
  assert.equal(result.offers.length, 23);
  assert.match(result.failures[0], /price mismatch/);
  const unavailable = fixture.replaceAll('data-type="addBasket"', 'data-type="notify"');
  assert.ok(parseStore77Category(unavailable, page).offers.every(o => o.stock !== 'InStock'));
});

test('the product page confirms current price and configuration, ignoring catalogue cache, installments and add-ons', () => {
  const reference = parseStore77Category(fixture, page, { fetchedAt }).offers.find(o => o.sourceProductId === '3224850');
  const offer = parseStore77Product(productFixture, reference, { fetchedAt });
  assert.equal(reference.price, 149900);
  assert.equal(offer.price, 147900);
  assert.equal(offer.model, 'MacBook Air 15"');
  assert.equal(offer.evidence.catalogPrice, 149900);
  assert.equal(offer.evidence.productPrice, 147900);
  assert.equal(offer.evidence.method, 'store77-product-v1');
  assert.throws(() => parseStore77Product(productFixture.replace('data-price="147900"', 'data-price="1000"'), reference), /basket mismatch/);
  assert.throws(() => parseStore77Product(productFixture.replaceAll('(M5, 16 ГБ, 512 ГБ SSD)', '(M5, 24 ГБ, 512 ГБ SSD)'), reference), /configuration mismatch/);
  const soldOut = productHtml(reference).replace(/<a[^>]+>В корзину<\/a>/, '<a data-type="addBasket" data-id="" class="out-of-stock">Распродано</a>');
  const unavailable = parseStore77Product(soldOut, reference, { fetchedAt });
  assert.equal(unavailable.stock, 'OutOfStock');
  assert.equal(currentPrice(unavailable, Date.parse(fetchedAt)), false);
});

test('cookie redirects reuse the response cookie and session across product requests', async () => {
  const calls = [];
  const client = createStore77Fetch({ fetchImpl: async (url, options) => {
    calls.push({ url, cookie: options.headers.get('cookie'), redirect: options.redirect });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: page, 'set-cookie': '__hash_=test; Domain=.store77.net; Path=/; Secure' } }) : new Response('catalogue');
  } });
  assert.equal(await (await client(page)).text(), 'catalogue');
  await client(page + '?PAGEN_1=2');
  assert.equal(calls.length, 3);
  assert.equal(calls[1].cookie, '__hash_=test');
  assert.equal(calls[2].cookie, '__hash_=test');
  assert.ok(calls.every(c => c.redirect === 'manual'));
});

test('external redirects, loops, missing pages and incomplete crawls fail explicitly', async () => {
  let calls = 0;
  const outside = createStore77Fetch({ fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://other.test/' } }); } });
  await assert.rejects(outside(page), /outside Store77/);
  assert.equal(calls, 1);
  const loop = createStore77Fetch({ maxRedirects: 2, fetchImpl: async () => new Response(null, { status: 302, headers: { location: page } }) });
  await assert.rejects(loop(page), /redirect limit/);
  assert.throws(() => parseStore77Category('<html>maintenance</html>', page), /cards missing/);
  assert.throws(() => discoverStore77Categories('<a href="https://evil.test/apple_macbook_air_m5/">Mac</a>'), /category missing/);
  const html = fixture + `<a href="${page}">Air</a>`;
  await assert.rejects(fetchStore77Offers({ maxPages: 1, fetchPage: async () => html }), /page limit/);
  await assert.rejects(fetchStore77Offers({ fetchPage: async url => { if (url.includes('PAGEN')) throw new Error('HTTP 503'); return html; } }), /HTTP 503/);
});

test('category filters are stripped and all catalogue pagination is fetched once', async () => {
  const urls = discoverStore77Categories(`<a href="${page}">Air</a><a href="/apple_macbook_air_m4/?set_filter=Y">M4</a><a href="/adaptery_dlya_macbook/">Adapter</a>`);
  assert.deepEqual(urls, [page, 'https://store77.net/apple_macbook_air_m4/']);
  const requested = [];
  const noPagination = fixture.replace(/<div class="pagination_catalog">[\s\S]*$/, '');
  const html = fixture + `<a href="${page}">Air</a>`;
  const products = new Map(parseStore77Category(fixture, page).offers.map(o => [o.url, productHtml(o)]));
  const result = await fetchStore77Offers({ fetchPage: async url => { requested.push(url); return products.get(url) || (url === page ? html : noPagination); } });
  assert.equal(requested.length, 27);
  assert.equal(new Set(requested).size, 27);
  assert.equal(result.offers.length, 24);
  assert.equal(result.stats.catalogPagesFetched, 3);
});
