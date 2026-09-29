import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discoverAfmStore, parseAfmDetails, parseAfmProducts, fetchAfmOffers } from '../scripts/afmcenter.mjs';
import { calculateRetailAnalytics } from '../web/retail-analytics.js';

const captured = JSON.parse(readFileSync(new URL('./fixtures/afm-products.json', import.meta.url), 'utf8'));
const product = (changes = {}) => ({ ...structuredClone(captured[0]), ...changes });
const catalogue = '<script>var ROOT="316484309409"; var options={recid:"2410843591",storepart:"465434141673"};</script>';
const neoHtml = '<div class="t744__title">MacBook Neo, 256Гб</div><div class="t744__descr">Чип A18 Pro, дисплей 13″ Liquid Retina</div>';
const imacHtml = '<div class="t744__title">iMac 24" M4, 16/256Гб</div>';

test('discovers the Mac block instead of the all-products ROOT', () => {
  assert.deepEqual(discoverAfmStore(catalogue), { recid: '2410843591', storepartuid: '465434141673' });
  assert.throws(() => discoverAfmStore('maintenance'), /reference/);
  assert.throws(() => discoverAfmStore(catalogue + catalogue), /reference/);
});

test('captured AFM products retain individual color prices, Russian memory units and core counts', async () => {
  const details = new Map([['561375382712', await parseAfmDetails(neoHtml)], ['336383597892', await parseAfmDetails(imacHtml)]]);
  const offers = parseAfmProducts(captured, { details, fetchedAt: '2026-09-29T12:00:00Z' });
  assert.equal(offers.length, captured.reduce((n, p) => n + p.editions.length, 0));
  assert.equal(new Set(offers.map(o => o.externalId)).size, offers.length);
  assert.ok(offers.every(o => o.retailer === 'AFM' && o.paymentMethod === 'cash' && o.priceType === 'full' && o.qualityWarnings.length === 0));
  const pro = offers.filter(o => o.sourceProductId === '629847008922');
  assert.deepEqual(pro.map(o => [o.ramGb, o.storageGb, o.color, o.price]), [[32, 1000, 'Space Black', 243800], [32, 1000, 'Silver', 234900]]);
  const imac = offers.find(o => o.sourceProductId === '336383597892');
  assert.deepEqual([imac.model, imac.cpuCores, imac.gpuCores, imac.ramGb, imac.storageGb], ['iMac 24"', 8, 8, 16, 256]);
  const neo = offers.find(o => o.color === 'Citrus');
  assert.deepEqual([neo.model, neo.chip, neo.ramGb, neo.storageGb], ['MacBook Neo 13"', 'A18 Pro', 8, 256]);
  assert.equal(neo.evidence.specificationSource, 'https://support.apple.com/en-ie/126322');
  assert.ok(offers.some(o => o.color === 'Midnight'));
  assert.ok(offers.filter(o => /^Mac mini/.test(o.model)).every(o => o.screenIn === null));
});

test('never uses a parent minimum or crossed-out price when a variant price is missing', () => {
  for (const value of ['free', '123.4567', '-1']) {
    const p = product(); p.editions[0].price = value; p.editions[0].priceold = '999999';
    assert.throws(() => parseAfmProducts([p]), /invalid current price/);
  }
  const p = product(); p.editions[0].price = '199900.0000';
  assert.equal(parseAfmProducts([p])[0].price, 199900);
  for (const value of ['', null, '0.0000']) {
    const unpriced = [], p = product(); p.editions[0].price = value;
    assert.equal(parseAfmProducts([p], { unpriced }).length, 1);
    assert.equal(unpriced.length, 1);
    assert.equal(unpriced[0].editionId, String(p.editions[0].uid));
  }
});

test('availability is not invented when AFM leaves quantity empty', () => {
  const p = product(); p.editions[0].quantity = '0'; p.editions[1].quantity = '2';
  assert.deepEqual(parseAfmProducts([p]).map(o => o.stock), ['OutOfStock', 'InStock']);
  assert.ok(parseAfmProducts([product()]).every(o => o.stock === 'source_reported'));
});

test('accepts the observed Air URL layout but rejects off-site, credential and unrelated URLs', () => {
  assert.ok(parseAfmProducts([product({ url: 'https://afmcenter.ru/shop/mac-air-13-m5-16-512gb' })]).length);
  for (const url of ['https://evil.test/shop/mac/a', 'https://user@afmcenter.ru/shop/mac/a', 'https://afmcenter.ru/shop/iphone', 'javascript:alert(1)']) {
    assert.throws(() => parseAfmProducts([product({ url })]), /outside/);
  }
});

test('rejects duplicate identity and unrecognized variant dimensions', () => {
  assert.throws(() => parseAfmProducts([product(), product()]), /duplicate product/);
  const p = product(); p.editions.push(p.editions[0]);
  assert.throws(() => parseAfmProducts([p]), /duplicate edition/);
  const memory = product(); memory.editions[0]['Память'] = '24/1TB';
  assert.throws(() => parseAfmProducts([memory]), /unsupported variant/);
});

test('requires evidence for cash prices and excludes payment surcharges', () => {
  assert.throws(() => parseAfmProducts([product({ descr: '' })]), /cash price not confirmed/);
  const p = product(); p.editions[0]['Оплата'] = 'Наличные'; p.editions[1]['Оплата'] = 'Банковская карта +15%';
  assert.equal(parseAfmProducts([p]).length, 1);
  p.editions[0]['Оплата'] = 'Кредит';
  assert.throws(() => parseAfmProducts([p]), /no cash-price/);
});

test('does not guess Neo specifications or an iMac screen without a detail page', () => {
  for (const p of captured.filter(p => /Neo|iMac/i.test(p.title))) assert.throws(() => parseAfmProducts([p]), /unverified Neo|missing iMac screen/);
  const neo = captured.find(p => /Neo/i.test(p.title));
  assert.throws(() => parseAfmProducts([neo], { details: new Map([[String(neo.uid), { title: 'MacBook Neo', description: 'A19 Pro 13″' }]]) }), /unverified Neo/);
});

function pages(payloads) {
  return async url => {
    if (url === 'https://afmcenter.ru/shop/mac') return catalogue;
    const u = new URL(url);
    assert.equal(u.origin, 'https://store.tildaapi.com');
    assert.equal(u.searchParams.get('storepartuid'), '465434141673');
    return JSON.stringify(payloads[Number(u.searchParams.get('slice')) - 1]);
  };
}

test('fetches every page and validates the total', async () => {
  const result = await fetchAfmOffers({ pageSize: 1, fetchPage: pages([{ total: 2, products: [captured[0]] }, { total: 2, products: [captured[1]] }]) });
  assert.equal(result.stats.apiPagesFetched, 2);
  assert.equal(result.stats.products, 2);
  assert.equal(result.offers.length, 4);
});

test('incomplete, repeated, changing and invalid catalogues fail without publishing a partial success', async () => {
  for (const [second, pattern] of [[{ total: 2, products: [] }, /stopped early/], [{ total: 2, products: [captured[0]] }, /repeated product/], [{ total: 3, products: [captured[1]] }, /total changed/]]) {
    await assert.rejects(fetchAfmOffers({ pageSize: 1, fetchPage: pages([{ total: 2, products: [captured[0]] }, second]) }), pattern);
  }
  for (const total of [null, '', 'bad', -1]) await assert.rejects(fetchAfmOffers({ fetchPage: pages([{ total, products: [] }]) }), /invalid total/);
  await assert.rejects(fetchAfmOffers({ fetchPage: pages([{ total: 0, products: [] }]) }), /no Mac variants/);
  await assert.rejects(fetchAfmOffers({ pageSize: 101 }), /pagination limits/);
  await assert.rejects(fetchAfmOffers({ fetchPage: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
});

test('complete AFM catalog with all prices withdrawn is still a valid source snapshot', async () => {
  const product = structuredClone(captured[0]);
  for (const edition of product.editions) edition.price = '';
  const result = await fetchAfmOffers({ fetchPage: pages([{ total: 1, products: [product] }]) });
  assert.equal(result.offers.length, 0);
  assert.equal(result.unpriced.length, product.editions.length);
});

test('fetches missing detail fields and fails when a required detail page fails', async () => {
  const neo = captured.find(p => /Neo/i.test(p.title));
  const fetchPage = async url => url === neo.url ? neoHtml : pages([{ total: 1, products: [neo] }])(url);
  const result = await fetchAfmOffers({ fetchPage });
  assert.equal(result.stats.productPagesFetched, 1);
  assert.equal(result.offers.length, 4);
  await assert.rejects(fetchAfmOffers({ fetchPage: url => url === neo.url ? { ok: false, status: 404 } : fetchPage(url) }), /HTTP 404/);
});

test('AFM participates in local retail analytics', () => {
  const analytics = calculateRetailAnalytics([{ retailer: 'Дима', price: 100000 }, { retailer: 'AFM', price: 125000 }]);
  assert.equal(analytics.averageRetail, 125000);
  assert.equal(analytics.recommendedPrice, 124500);
  assert.equal(analytics.benchmark.retailer, 'AFM');
});
