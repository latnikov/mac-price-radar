import test from 'node:test';
import assert from 'node:assert/strict';
import { AVITO, avitoSellerColumns, priceColumnKey, groupOffersByPriceColumn } from '../web/avito-columns.js';
import { catalogConfigurationKey } from '../web/retail-analytics.js';

const offer = (id, seller, overrides = {}) => ({
  retailer: AVITO, sellerId: 'avito:marketplace', marketplaceSellerId: seller,
  listingId: `avito:${id}`, sellerName: `Магазин ${seller}`,
  model: 'MacBook Air', chip: 'M5', screenIn: 15, ramGb: 16, storageGb: 512, color: 'Silver',
  price: 130000, fetchedAt: '2026-09-27T00:00:00Z',
  url: `https://www.avito.ru/nizhniy_novgorod/noutbuki/macbook_${id}`,
  ...overrides,
});

test('Air M5 15: independent seller columns keep all direct links and the lowest price with its Trust', () => {
  const cheap = offer('10000001', 'one', { price: 110000, avitoRank: { level: 'low', position: 3 } });
  const moreTrusted = offer('10000002', 'one', { price: 130000, avitoRank: { level: 'high', position: 1 } });
  const otherSeller = offer('10000003', 'two', { price: 125000, avitoRank: { level: 'medium', position: 2 } });
  const offers = [moreTrusted, otherSeller, cheap];
  assert.equal(new Set(offers.map(catalogConfigurationKey)).size, 1);
  const columns = avitoSellerColumns(offers), cells = groupOffersByPriceColumn(offers);
  assert.equal(columns.length, 2);
  assert.equal(cells.size, 2);
  assert.deepEqual(cells.get(columns[0].key), [cheap, moreTrusted]);
  assert.equal(cells.get(columns[0].key)[0].avitoRank.level, 'low');
  assert.deepEqual(cells.get(columns[1].key), [otherSeller]);
  assert.equal(new Set([...cells.values()].flat().map(x => x.url)).size, 3);
  assert.deepEqual(offers, [moreTrusted, otherSeller, cheap]);
});

test('same-name profiles stay separate; a renamed profile keeps its ID and latest name', () => {
  const older = offer('10000001', 'one', { sellerName: 'Старое имя' });
  const latest = offer('10000002', 'one', { sellerName: 'Apple', fetchedAt: '2026-09-27T01:00:00Z' });
  const namesake = offer('10000003', 'two', { sellerName: 'Apple' });
  const columns = avitoSellerColumns([older, namesake, latest]);
  assert.equal(columns.length, 2);
  assert.deepEqual(columns.map(x => x.label), ['Apple', 'Apple']);
  assert.deepEqual(columns.map(x => x.profileLabel), ['Профиль 1', 'Профиль 2']);
  assert.notEqual(columns[0].key, columns[1].key);
  assert.equal(priceColumnKey(older), priceColumnKey(latest));
  assert.deepEqual(avitoSellerColumns([latest, namesake, older]), columns);
});

test('a verified NN store retains distinct website and Avito columns', () => {
  const marketplace = offer('10000001', 'shop', { sellerName: 'iMobile', matchedRetailer: 'iMobile' });
  const website = { ...marketplace, retailer: 'iMobile', listingId: 'web:one', url: 'https://imobile.test/macbook', price: 140000 };
  const cells = groupOffersByPriceColumn([marketplace, website]);
  assert.equal(cells.size, 2);
  assert.deepEqual(cells.get(priceColumnKey(website)), [website]);
  assert.deepEqual(cells.get(priceColumnKey(marketplace)), [marketplace]);
  assert.equal(avitoSellerColumns([marketplace, website])[0].matchedRetailer, 'iMobile');
});

test('seller cells do not mix configurations or colors, and filters remove irrelevant seller columns', () => {
  const offers = [offer('10000001', 'one'), offer('10000002', 'one', { screenIn: 13 }),
    offer('10000003', 'two', { storageGb: 1024 }), offer('10000004', 'two', { color: 'Midnight' })];
  const rows = Map.groupBy(offers, item => `${catalogConfigurationKey(item)}|${item.color}`);
  assert.equal(rows.size, 4);
  for (const items of rows.values()) assert.equal([...groupOffersByPriceColumn(items).values()].flat().length, 1);
  const selected = offers.filter(item => item.screenIn === 15 && item.storageGb === 512 && item.color === 'Silver');
  assert.deepEqual(avitoSellerColumns(selected).map(x => x.sellerId), ['one']);
});

test('empty data creates no aggregate or fake seller column; unknown profile never joins another', () => {
  assert.deepEqual(avitoSellerColumns([]), []);
  const unknown = offer('10000001', null);
  const known = offer('10000002', 'real');
  assert.equal(priceColumnKey(unknown), null);
  assert.equal(avitoSellerColumns([unknown, known]).length, 1);
  assert.deepEqual([...groupOffersByPriceColumn([unknown, known]).values()], [[known]]);
});
