import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRetailAnalytics, catalogConfigurationKey, colorPriceTrustKey, findColorPriceLowTrust, RETAILER_TRUST } from '../web/retail-analytics.js';

test('catalogue grouping ignores missing CPU/GPU core details', () => {
  const base = { model: 'MacBook Air 15"', chip: 'M5', screenIn: 15, ramGb: 16, storageGb: 512 };
  assert.equal(
    catalogConfigurationKey({ ...base, cpuCores: 10, gpuCores: 10 }),
    catalogConfigurationKey({ ...base, cpuCores: null, gpuCores: null }),
  );
  assert.notEqual(catalogConfigurationKey(base), catalogConfigurationKey({ ...base, ramGb: 24 }));
  assert.notEqual(catalogConfigurationKey(base), catalogConfigurationKey({ ...base, storageGb: 1000 }));
  assert.equal(catalogConfigurationKey({ ...base, storageGb: 1024 }), catalogConfigurationKey({ ...base, storageGb: 1000 }));
});

test('retail analytics compares the minimum procurement with trusted Nizhny prices', () => {
  const analytics = calculateRetailAnalytics([
    { retailer: 'Дима', price: 100000, stock: 'source_reported' },
    { retailer: 'BSA', price: 102000, stock: 'source_reported' },
    { retailer: 'Айфория', price: 120000, stock: 'InStock' },
    { retailer: 'Technichno', price: 122000, stock: 'InStock' },
    { retailer: 'ReSale', price: 90000, stock: 'source_reported' },
  ]);

  assert.equal(analytics.minimumProcurement, 100000);
  assert.equal(analytics.procurementBenchmark.retailer, 'Дима');
  assert.equal(analytics.averageRetail, 121000);
  assert.equal(analytics.difference, 21000);
  assert.equal(analytics.markupPercent, 21);
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

  assert.equal(analytics.minimumProcurement, 100000);
  assert.equal(analytics.averageRetail, null);
  assert.equal(analytics.difference, null);
  assert.equal(analytics.recommendedPrice, null);
});

test('only the lowest usable offer from each retailer contributes to its average', () => {
  const analytics = calculateRetailAnalytics([
    { retailer: 'Дима', price: 101000, stock: 'source_reported' },
    { retailer: 'Дима', price: 100000, stock: 'source_reported' },
    { retailer: 'Technichno', price: 121000, stock: 'InStock' },
    { retailer: 'Technichno', price: 120000, stock: 'InStock' },
  ]);

  assert.equal(analytics.minimumProcurement, 100000);
  assert.equal(analytics.averageRetail, 120000);
  assert.equal(analytics.procurementCount, 1);
  assert.equal(analytics.retailCount, 1);
});

test('every Nizhny price more than five percent below the average gets low trust', () => {
  const analytics = calculateRetailAnalytics([
    { retailer: 'Айфория', price: 100000, stock: 'InStock' },
    { retailer: 'Technichno', price: 100000, stock: 'InStock' },
    { retailer: 'iMobile', price: 80000, stock: 'InStock' },
    { retailer: 'Apple Store', price: 79000, stock: 'OutOfStock' },
  ]);

  assert.equal(analytics.nizhnyReferenceAverage, 93333);
  assert.deepEqual([...analytics.lowTrustRetailers], ['iMobile']);
  assert.equal(analytics.averageRetail, 100000);
  assert.equal(analytics.retailCount, 2);
  assert.equal(analytics.ignoredLowTrustCount, 1);
  assert.equal(analytics.benchmark.retailer, 'Айфория');
});

test('a Nizhny price exactly five percent below the average keeps normal trust', () => {
  const analytics = calculateRetailAnalytics([
    { retailer: 'Айфория', price: 95000, stock: 'InStock' },
    { retailer: 'Technichno', price: 105000, stock: 'InStock' },
  ]);

  assert.equal(analytics.nizhnyReferenceAverage, 100000);
  assert.equal(analytics.lowTrustRetailers.size, 0);
  assert.equal(analytics.averageRetail, 100000);
});

test('a cheaper color of the same retailer configuration gets low trust', () => {
  const configurationKey = offer => [offer.model, offer.chip, offer.ramGb, offer.storageGb].join('|');
  const silver = { retailer: 'iMobile', model: 'MacBook Air 13', chip: 'M5', ramGb: 16, storageGb: 512, color: 'Silver', price: 130000, stock: 'InStock' };
  const midnight = { ...silver, color: 'Midnight', price: 134900 };
  const otherRetailer = { ...silver, retailer: 'Айфория', price: 129000 };
  const lowTrust = findColorPriceLowTrust([silver, midnight, otherRetailer], configurationKey);

  assert.equal(lowTrust.get(colorPriceTrustKey(silver, configurationKey)).comparisonPrice, 134900);
  assert.match(lowTrust.get(colorPriceTrustKey(silver, configurationKey)).reason, /Silver/);
  assert.equal(lowTrust.has(colorPriceTrustKey(midnight, configurationKey)), false);
  assert.equal(lowTrust.has(colorPriceTrustKey(otherRetailer, configurationKey)), false);
});

test('color low trust is excluded from Nizhny analytics and recommendation', () => {
  const analytics = calculateRetailAnalytics([
    { retailer: 'iMobile', price: 130000, stock: 'InStock' },
    { retailer: 'Айфория', price: 135000, stock: 'InStock' },
  ], { additionalLowTrust: new Map([['iMobile', { reason: 'Cheaper color' }]]) });

  assert.equal(analytics.averageRetail, 135000);
  assert.equal(analytics.retailCount, 1);
  assert.equal(analytics.benchmark.retailer, 'Айфория');
  assert.equal(analytics.lowTrustReasons.get('iMobile'), 'Cheaper color');
});
