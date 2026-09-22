import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBsaOffers, parseBsaMessages } from '../scripts/bsa.mjs';

test('BSA parser keeps only Moscow-today-and-later MacBook price lists', () => {
  const messages = [
    { id: 100, text: `MacBook Air\n22/09/2026\nMDH74 Air 13 (M5 16/512) Silver-120.000` },
    { id: 101, text: `MacBook Air\n23/09/2026\n
      MacBook Pro 16 Leather Sleeve -20.000\n
      🇭🇰🇺🇸[MHFF4] NEO (8/256) Indigo-61.500\n
      🇺🇸MDHH4 Air 13 (M5 16/512) Sky Blue -126.000\n
      🇮🇳🇺🇸💻 MX2X3 Space Black 16 Pro M4 Pro 14-Core, GPU 20-\nCore, 24GB, 512GB-213.000*` },
  ];
  // It is already 23 September in Moscow, although UTC is still 22 September.
  const result = parseBsaMessages(messages, { now: '2026-09-22T21:30:00.000Z' });
  assert.equal(result.stats.fromDate, '2026-09-23');
  assert.equal(result.stats.eligibleMessages, 1);
  assert.equal(result.failures.length, 0);
  assert.equal(result.offers.length, 3);
  assert.deepEqual(result.offers.map(offer => [offer.model, offer.chip, offer.ramGb, offer.storageGb, offer.color, offer.price]), [
    ['MacBook Neo 13"', 'A18 Pro', 8, 256, 'Indigo', 61500],
    ['MacBook Air 13"', 'M5', 16, 512, 'Sky Blue', 126000],
    ['MacBook Pro 16"', 'M4 Pro', 24, 512, 'Space Black', 213000],
  ]);
  assert.ok(result.offers.every(offer => offer.retailer === 'BSA' && offer.stock === 'source_reported' && offer.url.startsWith('https://t.me/BigSaleApple/101?item=')));
});

test('BSA parser handles compact Pro core notation and ignores undated historical search hits', () => {
  const messages = [
    { id: 200, text: `MacBook\nMGDN4 MacBook Pro 14 M5 Pro 15/16 24GB 1TB Silver - 208.500` },
    { id: 201, text: `24/09/2026\nMDE14 MacBook Pro 14 М5 10/10 16/1TB Space Black-176.000` },
  ];
  const result = parseBsaMessages(messages, { now: '2026-09-23T10:00:00+03:00' });
  assert.equal(result.offers.length, 1);
  assert.deepEqual(
    [result.offers[0].chip, result.offers[0].cpuCores, result.offers[0].gpuCores, result.offers[0].ramGb, result.offers[0].storageGb],
    ['M5', 10, 10, 16, 1000],
  );
});

test('BSA collector uses injected Business API messages and requires no web fetch', async () => {
  let calls = 0;
  const result = await fetchBsaOffers({
    now: '2026-09-23T10:00:00+03:00',
    readMessages: async () => { calls++; return [{ id: 300, text: '23/09/2026\nMDH74 Air 13 (M5 16/512) Silver-126.500' }]; },
  });
  assert.equal(calls, 1);
  assert.equal(result.stats.protocol, 'Telegram Business Bot API');
  assert.equal(result.offers[0].price, 126500);
});
