import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTableOffers, buildPriceTable, selectTablePage, currentPrice } from '../web/price-table.js';

const now = Date.parse('2026-09-28T12:00:00Z');
const base = { retailer: 'Дима', url: 'https://shop.test/a', model: 'MacBook Air 13"', chip: 'M5', screenIn: 13,
  ramGb: 16, storageGb: 1000, color: 'Silver', cpuCores: 10, gpuCores: 10, condition: 'new',
  price: 100000, fetchedAt: new Date(now).toISOString(), stock: 'InStock', validationStatus: 'needs_review' };
const build = offers => buildPriceTable(prepareTableOffers(offers), { now });

test('colors, core bins and ambiguous missing core counts are separate visible rows', () => {
  const rows = build([base, { ...base, color: 'Midnight' }, { ...base, gpuCores: 8 }, { ...base, cpuCores: null, gpuCores: null }]);
  assert.equal(rows.length, 4);
  assert.equal(rows.reduce((n, row) => n + row.offers.length, 0), 4);
});

test('normalizes model typography, casing and 1 TB without merging different memory or screens', () => {
  const groups = build([base, { ...base, model: 'MacBook Air 13″', chip: 'm5', color: 'silver', storageGb: 1024 },
    { ...base, ramGb: 24 }, { ...base, model: 'MacBook Air 15"', screenIn: 15 }]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].offers.length, 1);
});

test('deduplicates tracked URLs using the latest price, preserving seller and variant identities', () => {
  const fresh = { ...base, price: 120000, fetchedAt: new Date(now + 1000).toISOString(), url: base.url + '/?utm_source=feed#price' };
  const offers = prepareTableOffers([base, fresh, { ...base, retailer: 'Другой' }, { ...base, color: 'Midnight' }]);
  assert.equal(offers.length, 3);
  assert.equal(offers[0].price, 120000);
  const avito = { ...base, retailer: 'Авито НН', sellerName: 'Apple' };
  assert.equal(prepareTableOffers([{ ...avito, marketplaceSellerId: 'a' }, { ...avito, marketplaceSellerId: 'b' }]).length, 2);
});

test('does not erase two offer variants with a shared URL or different purchase terms', () => {
  const offers = prepareTableOffers([base, { ...base, optionId: 'other' }, { ...base, paymentMethod: 'card' }, { ...base, minimumQuantity: 5 }]);
  assert.equal(offers.length, 4);
});

test('actual nearby shop prices determine the average once per shop; procurement and Moscow are excluded', () => {
  const [row] = build([base, { ...base, retailer: 'Technichno', price: 120000 },
    { ...base, retailer: 'Technichno', url: 'https://shop.test/second', price: 125000 },
    { ...base, retailer: 'Айфория', price: 122000 }, { ...base, retailer: 'BigGeek', price: 99000 }]);
  assert.equal(row.analytics.minimumRetail, 120000);
  assert.equal(row.analytics.averageRetail, 121000);
  assert.equal(row.analytics.retailCount, 2);
  assert.equal(row.analytics.recommendedPrice, 119500);
  assert.equal(row.analytics.minimumProcurement, 100000);
  assert.equal(row.analytics.procurementBenchmark.retailer, 'Дима');
  assert.equal(row.analytics.difference, 21000);
  assert.equal(row.analytics.markupPercent, 21);
});

test('restored difference uses the displayed average even when the recommendation excludes low-trust prices', () => {
  const [row] = build([base, { ...base, retailer: 'AFM', price: 80000 },
    { ...base, retailer: 'Technichno', price: 110000 }, { ...base, retailer: 'Айфория', price: 110000 }]);
  assert.equal(row.analytics.averageRetail, 100000);
  assert.equal(row.analytics.difference, 0);
  assert.equal(row.analytics.markupPercent, 0);
  assert.equal(row.analytics.recommendedPrice, 109500);
});

test('missing or stale procurement leaves difference empty, and negative differences remain negative', () => {
  const retail = { ...base, retailer: 'AFM', price: 90000 };
  for (const procurement of [[], [{ ...base, fetchedAt: '2026-09-27T12:00:00Z' }]]) {
    const [row] = build([retail, ...procurement]);
    assert.equal(row.analytics.minimumProcurement, null);
    assert.equal(row.analytics.difference, null);
    assert.equal(row.analytics.markupPercent, null);
  }
  const [row] = build([base, retail]);
  assert.equal(row.analytics.difference, -10000);
  assert.equal(row.analytics.markupPercent, -10);
  assert.equal(build([base])[0].analytics.difference, null);
});

test('stale, expired, rejected, future and unavailable observations remain visible but do not set the average', () => {
  for (const change of [{ fetchedAt: '2026-09-27T12:00:00Z' }, { validUntil: new Date(now).toISOString() },
    { validationStatus: 'rejected' }, { qualityWarnings: ['Конфликт конфигурации'] }, { fetchedAt: new Date(now + 120000).toISOString() },
    { stock: 'OutOfStock' }, { priceType: 'installment' }, { minimumQuantity: 5 }, { fetchedAt: 'invalid' }]) {
    const retail = { ...base, retailer: 'Technichno', price: 120000, ...change };
    const [row] = build([base, retail]);
    assert.equal(row.offers.length, 2);
    assert.equal(row.analytics.averageRetail, null, JSON.stringify(change));
    assert.equal(currentPrice(retail, now), false);
  }
});

test('pagination caps rendered groups, clamps old page numbers and leaves the full summary intact', () => {
  const groups = build(Array.from({ length: 95 }, (_, i) => ({ ...base, ramGb: i + 1, price: 100000 + i })));
  const first = selectTablePage(groups, { sort: 'price-down' });
  const last = selectTablePage(groups, { page: 999, sort: 'price-down' });
  assert.equal(first.rows.length, 30); assert.equal(first.rows[0].minimumPrice, 100094);
  assert.equal(last.page, 4); assert.equal(last.rows.length, 5);
  assert.equal(first.total, 95);
  assert.equal(first.allRows.length, 95);
  assert.equal(groups[0].minimumPrice, 100000);
});


test('missing details join an unambiguous variant without duplicating its row', () => {
  const rows = build([{ ...base, cpuCores: null, gpuCores: null }, { ...base, retailer: 'Technichno', price: 120000 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].offers[0].gpuCores, null);
  assert.equal(rows[0].offers.length, 2);
});

test('known color, core, condition, keyboard and region conflicts always remain separate', () => {
  for (const field of ['color', 'gpuCores', 'condition', 'keyboard', 'region']) {
    const rows = build([{ ...base, [field]: 'one' }, { ...base, retailer: 'Technichno', price: 120000, [field]: 'two' }]);
    assert.equal(rows.length, 2, field);
  }
});
