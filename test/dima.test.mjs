import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDimaOffers, parseDimaMessages } from '../scripts/dima.mjs';

const price = `MacBook: НАВИГАЦИЯ
MacBook MDHH4 Air 13 Sky Blue (M5, 16GB, 512GB) 2026 123500
MacBook MGED4 Pro 16 Space Black (M5 Max,36GB,2TB)2026 326000
MacBook MHFD4 Neo Citrus (A18, 8GB, 256GB) 2026 62000
MacBook MHFD4 Neo Citrus (A18, 8GB, 256GB) 2026 62000 🚚
Macbook Z1LX000K8 Air 15 Midnight (M5 32/4TB) 2026 350000`;

test('Dima parser reads current MacBooks, normalizes Neo and removes delivery duplicates', () => {
  const result = parseDimaMessages([{ id: '634', date: '2026-09-23T06:40:00.000Z', sourceChatId: '-1003421701174', sourceTitle: 'прайс от Л', text: price }], { now: '2026-09-23T10:00:00+03:00' });
  assert.equal(result.failures.length, 0);
  assert.equal(result.offers.length, 4);
  assert.deepEqual(result.offers.map(offer => [offer.model, offer.chip, offer.ramGb, offer.storageGb, offer.price]), [
    ['MacBook Air 13"', 'M5', 16, 512, 123500],
    ['MacBook Pro 16"', 'M5 Max', 36, 2000, 326000],
    ['MacBook Neo 13"', 'A18 Pro', 8, 256, 62000],
    ['MacBook Air 15"', 'M5', 32, 4000, 350000],
  ]);
  assert.ok(result.offers.every(offer => offer.retailer === 'Дима' && offer.sourceSender === 'прайс от Л'));
  assert.ok(result.offers.every(offer => offer.url.startsWith('https://t.me/c/3421701174/634?item=')));
});

test('Dima collector filters out messages forwarded before the current Moscow date', async () => {
  const result = await fetchDimaOffers({
    now: '2026-09-23T10:00:00+03:00',
    readMessages: async () => [
      { id: 'old', date: '2026-09-22T10:00:00.000Z', sourceChatId: '-1003421701174', sourceTitle: 'прайс от Л', text: price },
      { id: 'new', date: '2026-09-23T06:40:00.000Z', sourceChatId: '-1003421701174', sourceTitle: 'прайс от Л', text: price },
    ],
  });
  assert.equal(result.stats.eligibleMessages, 1);
  assert.equal(result.offers.length, 4);
});
