import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRetailAnalytics, RETAILER_TRUST } from '../web/retail-analytics.js';

test('retail analytics compares retailer averages and recommends 500 rubles below the trusted Nizhny minimum', () => {
  const analytics = calculateRetailAnalytics([
    { retailer: 'Дима', price: 100000, stock: 'source_reported' },
    { retailer: 'BSA', price: 102000, stock: 'source_reported' },
    { retailer: 'Айфория', price: 120000, stock: 'InStock' },
    { retailer: 'Technichno', price: 122000, stock: 'InStock' },
    { retailer: 'ReSale', price: 90000, stock: 'source_reported' },
  ]);

  assert.equal(analytics.averageProcurement, 101000);
  assert.equal(analytics.averageRetail, 121000);
  assert.equal(analytics.averageDifference, 20000);
  assert.equal(Math.round(analytics.averageMarkupPercent * 10) / 10, 19.8);
  assert.equal(analytics.recommendedPrice, 119500);
  assert.equal(analytics.benchmark.retailer, 'Айфория');
  assert.equal(analytics.ignoredLowTrustCount, 1);
  assert.equal(RETAILER_TRUST.ReSale.level, 'low');
});

test('out-of-stock and low-trust prices do not set the recommendation', () => {
  const analytics = calculateRetailAnalytics([
    { retailer: 'Дима', price: 100000, stock: 'source_reported' },
    { retailer: 'Айфория', price: 110000, stock: 'OutOfStock' },
    { retailer: 'ReSale', price: 105000, stock: 'source_reported' },
  ]);

  assert.equal(analytics.averageProcurement, 100000);
  assert.equal(analytics.averageRetail, null);
  assert.equal(analytics.averageDifference, null);
  assert.equal(analytics.recommendedPrice, null);
});

test('only the lowest usable offer from each retailer contributes to its average', () => {
  const analytics = calculateRetailAnalytics([
    { retailer: 'Дима', price: 101000, stock: 'source_reported' },
    { retailer: 'Дима', price: 100000, stock: 'source_reported' },
    { retailer: 'Technichno', price: 121000, stock: 'InStock' },
    { retailer: 'Technichno', price: 120000, stock: 'InStock' },
  ]);

  assert.equal(analytics.averageProcurement, 100000);
  assert.equal(analytics.averageRetail, 120000);
  assert.equal(analytics.procurementCount, 1);
  assert.equal(analytics.retailCount, 1);
});
