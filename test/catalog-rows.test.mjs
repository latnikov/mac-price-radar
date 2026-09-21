import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogRows, mergeLiveOffers } from '../scripts/catalog-rows.mjs';

const offer = { retailer: 'Technichno', url: 'https://example.test/a', model: 'MacBook Air 15"', chip: 'M5', ramGb: 24, storageGb: 1000, color: 'Sky Blue', price: 120000, currency: 'RUB', condition: 'new', fetchedAt: new Date().toISOString(), cpuCores: 10, gpuCores: 10, screenIn: 15, keyboard: 'US', region: 'US', displayType: 'standard', bundle: 'standard', priceType: 'full', paymentMethod: 'cash', buyerType: 'retail', minimumQuantity: 1, stock: 'InStock' };

test('discovered configurations survive outside the manually maintained catalog', () => {
  const rows = buildCatalogRows([], [offer, { ...offer, color: 'Silver', url: 'https://example.test/b' }]);
  assert.equal(rows.length, 2);
  assert.equal(rows.flatMap(r => r.offers).length, 2);
  assert.equal(rows[0].product.storageGb, 1000);
});

test('Neo without core specifications stays visible without claiming verified cores', () => {
  const catalog = [{ name: 'MacBook Neo 13"', chip: 'A18 Pro', ramGb: 8, storageGb: 256, cpuCores: 6, gpuCores: 5, colors: ['Silver'] }];
  const neo = { ...offer, model: catalog[0].name, chip: 'A18 Pro', ramGb: 8, storageGb: 256, color: 'Silver', cpuCores: null, gpuCores: null };
  const rows = buildCatalogRows(catalog, [neo]);
  assert.equal(rows.flatMap(r => r.offers).length, 1);
  assert.equal(rows.find(r => r.offers.length).product.cpuCores, null);
  assert.match(rows.find(r => r.offers.length).product.verificationNote, /cpuCores, gpuCores/);
});

test('single-retailer refresh preserves real observations from the other retailers', () => {
  const other = { ...offer, retailer: 'BigGeek', price: 130000 };
  const updated = { ...offer, price: 110000, fetchedAt: new Date(Date.now() + 1000).toISOString() };
  assert.deepEqual(mergeLiveOffers([offer, other], [updated], ['Technichno']), [updated, other]);
  assert.deepEqual(mergeLiveOffers([], [offer, updated], ['Technichno']), [updated]);
});

test('unavailable offers remain visible but cannot win the minimum', () => {
  const rows = buildCatalogRows([], [{ ...offer, stock: 'OutOfStock', price: 1 }, { ...offer, url: 'https://example.test/b', stock: 'InStock' }]);
  assert.equal(rows[0].offers.length, 2);
  assert.equal(rows[0].best.price, 120000);
});

test('source contradictions stay visible and are excluded from best price', () => {
  const rows = buildCatalogRows([], [{ ...offer, qualityWarnings: ['RAM conflict'] }]);
  assert.equal(rows[0].offers.length, 1);
  assert.equal(rows[0].best, null);
});

 test('AC12 omitted listing survives a partial refresh without renewed timestamp', () => {
  const omitted = { ...offer, url: 'https://example.test/omitted' };
  const updated = { ...offer, price: 115000 };
  assert.deepEqual(mergeLiveOffers([offer, omitted], [updated]), [updated, omitted]);
});
