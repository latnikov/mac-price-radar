import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBsaTelegramPage } from '../scripts/bsa.mjs';

const message = (id, text) => `<div class="tgme_widget_message js-widget_message" data-post="BigSaleApple/${id}">
  <div class="tgme_widget_message_text js-message_text">${text}</div>
</div>`;

test('BSA parser keeps only Moscow-today-and-later MacBook price lists', () => {
  const html = [
    message(100, `MacBook Air<br>22/09/2026<br>MDH74 Air 13 (M5 16/512) Silver-120.000`),
    message(101, `MacBook Air<br>23/09/2026<br>
      MacBook Pro 16 Leather Sleeve -20.000<br>
      🇭🇰🇺🇸[MHFF4] NEO (8/256) Indigo-61.500<br>
      🇺🇸MDHH4 Air 13 (M5 16/512) Sky Blue -126.000<br>
      🇮🇳🇺🇸💻 MX2X3 Space Black 16 Pro M4 Pro 14-Core, GPU 20-<br>Core, 24GB, 512GB-213.000*`),
  ].join('');
  // It is already 23 September in Moscow, although UTC is still 22 September.
  const result = parseBsaTelegramPage(html, { now: '2026-09-22T21:30:00.000Z' });
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
  const html = [
    message(200, `MacBook<br>MGDN4 MacBook Pro 14 M5 Pro 15/16 24GB 1TB Silver - 208.500`),
    message(201, `24/09/2026<br>MDE14 MacBook Pro 14 М5 10/10 16/1TB Space Black-176.000`),
  ].join('');
  const result = parseBsaTelegramPage(html, { now: '2026-09-23T10:00:00+03:00' });
  assert.equal(result.offers.length, 1);
  assert.deepEqual(
    [result.offers[0].chip, result.offers[0].cpuCores, result.offers[0].gpuCores, result.offers[0].ramGb, result.offers[0].storageGb],
    ['M5', 10, 10, 16, 1000],
  );
});
