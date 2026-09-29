import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAfmProducts } from '../scripts/afmcenter.mjs';
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
