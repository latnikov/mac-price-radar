import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAfmProducts } from '../scripts/afmcenter.mjs';
import { parseTildaIphoneProducts } from '../scripts/iphone-tilda.mjs';
import { afmWithdrawalObservations } from '../scripts/afm-withdrawals.mjs';
import { openMasterStore } from '../scripts/master-store.mjs';
import { currentPrice } from '../web/price-table.js';

test('complete AFM price withdrawal removes current offer but preserves its history', t => {
  const store = openMasterStore(':memory:'); t.after(() => store.close());
  const product = structuredClone(JSON.parse(readFileSync(new URL('./fixtures/afm-products.json', import.meta.url)))[0]);
  const before = parseAfmProducts([product], { fetchedAt: '2026-09-29T11:00:00Z' });
  store.ingestRun({ observations: before });
  product.editions[0].price = '';
  const unpriced = [];
  const after = parseAfmProducts([product], { fetchedAt: '2026-09-29T12:00:00Z', unpriced });
  const withdrawals = afmWithdrawalObservations(store.getOffers({ includeRejected: true }), unpriced, '2026-09-29T12:00:00Z');
  assert.equal(after.length, 1);
  assert.equal(withdrawals.length, 1);
  store.ingestRun({ observations: [...after, ...withdrawals] });
  assert.equal(store.getOffers().length, 1);
  const archived = store.getOffers({ includeRejected: true }).find(offer => offer.externalId === before[0].externalId);
  assert.equal(archived.withdrawn, true);
  assert.equal(currentPrice(archived, Date.parse('2026-09-29T12:01:00Z')), false);
  assert.equal(store.getHistory(archived.listingId).length, 2);
  assert.equal(afmWithdrawalObservations(store.getOffers({ includeRejected: true }), unpriced).length, 0);
  store.ingestRun({ observations: [{ ...before[0], fetchedAt: '2026-09-29T13:00:00Z', observedAt: '2026-09-29T13:00:00Z' }] });
  assert.equal(store.getOffers().length, 2);
});

test('AFM phone withdrawals use the phone external identity and preserve price history and recovery', t => {
  const store = openMasterStore(':memory:'); t.after(() => store.close());
  const product = {
    uid: 1001, title: 'iPhone 17 Pro Max 256Гб (esim only)',
    url: 'https://afmcenter.ru/shop/iphone/17-pro-max/256gb-esim',
    price: '99900.0000', descr: 'Цена указана за версию esim only при оплате наличными.',
    editions: [{ uid: 1101, price: '120990.0000', Цвет: 'Silver' }, { uid: 1102, price: '130990.0000', Цвет: 'Deep Blue' }],
  };
  const before = parseTildaIphoneProducts('AFM', [product], { fetchedAt: '2026-10-01T10:00:00Z' });
  store.ingestRun({ runId: 'phone-present', observations: before });
  product.editions[0].price = '';
  const unpriced = [];
  const after = parseTildaIphoneProducts('AFM', [product], { fetchedAt: '2026-10-01T11:00:00Z', unpriced });
  assert.equal(unpriced[0].externalId, 'afm-iphone:1001:1101');
  const withdrawals = afmWithdrawalObservations(store.getOffers({ includeRejected: true }), unpriced, '2026-10-01T11:00:00Z');
  assert.equal(withdrawals.length, 1);
  assert.equal(withdrawals[0].externalId, before[0].externalId);
  assert.equal(withdrawals[0].listingId, store.getOffers().find(offer => offer.externalId === before[0].externalId).listingId);
  store.ingestRun({ runId: 'phone-withdrawn', observations: [...after, ...withdrawals] });
  assert.equal(store.getOffers().length, 1);
  assert.equal(store.getOffers()[0].sourceVariantId, '1102');
  const archived = store.getOffers({ includeRejected: true }).find(offer => offer.externalId === before[0].externalId);
  assert.equal(archived.withdrawn, true);
  assert.equal(archived.price, 120990);
  assert.equal(currentPrice(archived, Date.parse('2026-10-01T11:01:00Z')), false);
  const history = store.getHistory(archived.listingId);
  assert.equal(history.length, 2);
  assert.equal(history[0].status, 'withdrawn');
  assert.equal(history[0].raw.externalId, 'afm-iphone:1001:1101');
  assert.equal(afmWithdrawalObservations(store.getOffers({ includeRejected: true }), unpriced).length, 0);
  store.ingestRun({ runId: 'phone-returned', observations: [{ ...before[0], price: 119990, priceMinor: 11999000, fetchedAt: '2026-10-01T12:00:00Z', observedAt: '2026-10-01T12:00:00Z' }] });
  const restored = store.getOffers().find(offer => offer.externalId === before[0].externalId);
  assert.equal(store.getOffers().length, 2);
  assert.equal(restored.listingId, archived.listingId);
  assert.equal(restored.price, 119990);
  assert.equal(restored.withdrawn, undefined);
});

test('explicit AFM external identities take precedence over the legacy Mac fallback', () => {
  const oldPhone = { retailer: 'AFM', externalId: 'afm-iphone:1001:1101', url: 'https://afmcenter.ru/shop/iphone/17-pro-max/256gb-esim', price: 120990 };
  const oldMac = { ...oldPhone, externalId: 'afm:1001:1101', price: 150990 };
  const item = { productId: '1001', editionId: '1101', externalId: oldPhone.externalId, url: oldPhone.url };
  assert.equal(afmWithdrawalObservations([oldMac, oldPhone], [item])[0].externalId, oldPhone.externalId);
  const { externalId, ...legacyItem } = item;
  assert.equal(afmWithdrawalObservations([oldMac, oldPhone], [legacyItem])[0].externalId, oldMac.externalId);
});
