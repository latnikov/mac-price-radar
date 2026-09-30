import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchHitappleOffers } from '../scripts/hitapple.mjs';

test('HitApple completes all catalogue pages and publishes exact Neo variations without parent ranges', async () => {
  const { pages } = JSON.parse(await readFile(new URL('./fixtures/hitapple/catalog-pages.json', import.meta.url), 'utf8'));
  const result = await fetchHitappleOffers({ fetchPage: async url => {
    assert.ok(pages[url], `Unexpected page: ${url}`);
    return pages[url];
  } });
  assert.equal(result.stats.catalogPagesFetched, 7);
  assert.equal(result.stats.catalogCards, 71);
  assert.equal(result.offers.length, 70);
  assert.equal(result.stats.inStock, 27);
  assert.equal(result.stats.outOfStock, 43);
  assert.equal(new Set(result.offers.map(offer => offer.externalId)).size, 70);
  const neo = result.offers.filter(offer => offer.model.startsWith('MacBook Neo'));
  assert.equal(neo.length, 8);
  assert.deepEqual([...new Set(neo.map(offer => offer.color))].sort(), ['Blush', 'Citrus', 'Indigo', 'Silver']);
  assert.deepEqual([...new Set(neo.map(offer => offer.storageGb))].sort((a, b) => a - b), [256, 512]);
  assert.ok(neo.every(offer => offer.sourceVariantId && offer.url.includes('attribute_pa_') && offer.chip === 'A18 Pro' && offer.ramGb === 8));
  assert.ok(result.offers.every(offer => offer.retailer === 'HitApple' && offer.paymentMethod === 'cash' && offer.priceType === 'full'));
});
