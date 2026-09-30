import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAvitoOpportunities } from '../scripts/avito-opportunities.mjs';
import { AVITO } from '../scripts/avito-policy.mjs';

const at = '2026-09-30T12:00:00.000Z', now = Date.parse(at);
const common = {
  model: 'MacBook Air 13"', chip: 'M4', screenIn: 13, ramGb: 16, storageGb: 256, color: 'Silver',
  cpuCores: 10, gpuCores: 8, condition: 'new', stock: 'InStock', priceType: 'full', currency: 'RUB',
  minimumQuantity: 1, fetchedAt: at, observedAt: at,
};
const avito = (extra = {}) => ({ ...common, retailer: AVITO, sourceType: 'marketplace',
  listingId: 'avito:1234567890', externalId: '1234567890', marketplaceSellerId: 'avito-shop',
  sellerId: 'avito:marketplace', sellerName: 'Магазин техники', sourceCity: 'Нижний Новгород',
  url: 'https://www.avito.ru/nizhniy_novgorod/noutbuki/macbook_1234567890',
  price: 80_000, title: 'MacBook Air 13 M4 16/256 Silver', ...extra });
const shop = (retailer = 'Айфория', price = 100_000, extra = {}) => ({ ...common,
  retailer, price, sourceType: 'website', sellerId: `seller:${retailer}`, listingId: `shop:${retailer}`,
  url: `https://example.com/${encodeURIComponent(retailer)}/macbook`, ...extra });
const market = (target = avito(), shops = [shop(), shop('Technichno', 110_000)], options = {}) => calculateAvitoOpportunities([target, ...shops], { now, ...options });

test('spread uses lowest independent shop, deducts the reserve, and exposes evidence and clear scenario language', () => {
  const result = market(), candidate = result.candidates[0];
  assert.equal(candidate.referencePrice, 100_000);
  assert.equal(candidate.grossDeltaRub, 20_000);
  assert.equal(candidate.costReserveRub, 3_000);
  assert.equal(candidate.deltaRub, 17_000);
  assert.equal(candidate.estimatedDeltaRub, candidate.deltaRub);
  assert.equal(candidate.deltaPercent, 17);
  assert.equal(candidate.shopCount, 2);
  assert.equal(candidate.evidence[0].retailer, 'Айфория');
  assert.equal(candidate.alertEligible, true);
  assert.equal(candidate.requiresReview, false);
  assert.equal(candidate.observedAt, at);
  assert.deepEqual(candidate.reasons, candidate.reviewReasons);
  assert.match(result.note, /не гарантированная.*прибыль/);
  assert.equal(result.summary.alertEligibleCount, 1);
});

test('thresholds apply after costs and percent is relative to the conservative reference price', () => {
  assert.equal(market(avito({ price: 88_000 })).candidates.length, 0);
  assert.equal(market(avito({ price: 87_000 })).candidates.length, 1);
  assert.equal(market(avito(), undefined, { minDeltaRub: 18_000 }).candidates.length, 0);
  assert.equal(market(avito(), undefined, { minDeltaPercent: 18 }).candidates.length, 0);
  assert.equal(market(avito(), undefined, { costReserveRub: 12_000 }).candidates.length, 0);
  assert.equal(market(avito({ price: 98_999.99 }), undefined, { minDeltaRub: 1_000.01, minDeltaPercent: 0, costReserveRub: 0 }).candidates[0].deltaRub, 1_000.01);
});

test('at least two independent retail shops are necessary; Avito peers cannot make an opportunity', () => {
  assert.equal(market(avito(), [shop()]).candidates.length, 0);
  const peers = [1, 2, 3].map(i => avito({ listingId: `peer:${i}`, externalId: String(1234567890 + i), marketplaceSellerId: `peer:${i}`,
    url: `https://www.avito.ru/nizhniy_novgorod/noutbuki/macbook_${1234567890 + i}`, price: 120_000 }));
  assert.equal(market(avito(), [shop(), ...peers]).candidates.length, 0);
  assert.equal(market(avito(), [shop(), shop('BigGeek')]).candidates.length, 0);
  assert.equal(market(avito(), [shop(), shop('Technichno', 110_000, { sourceType: 'telegram_channel' })]).candidates.length, 0);
});

test('duplicate retailers, linked seller IDs and the candidate own mapped shop never increase independent evidence', () => {
  const duplicates = [shop(), shop('Айфория', 110_000, { listingId: 'duplicate', url: 'https://example.com/duplicate', sellerId: 'different-source' })];
  assert.equal(market(avito(), duplicates).candidates.length, 0);
  assert.equal(market(avito(), [shop(), shop('Technichno', 110_000, { sellerId: 'seller:Айфория' })]).candidates.length, 0);
  assert.equal(market(avito({ matchedRetailer: 'Айфория' })).candidates.length, 0);
  assert.equal(market(avito({ sellerId: 'seller:Айфория' })).candidates.length, 0);
  const linked = [...duplicates, shop('Technichno', 110_000, { sellerId: 'different-source' }), shop('iMobile', 115_000)];
  assert.equal(market(avito(), linked).candidates[0].shopCount, 2);
});

test('configuration, color, known CPU/GPU and commercial differences are never silently compared', () => {
  for (const extra of [{ color: 'Midnight' }, { ramGb: 24 }, { storageGb: 512 }, { chip: 'M3' }, { model: 'MacBook Pro 13"' },
    { screenIn: 15 }, { cpuCores: 12 }, { gpuCores: 10 }, { condition: 'used' }, { priceType: 'installment' }, { currency: 'USD' }]) {
    assert.equal(market(avito(), [shop(), shop('Technichno', 110_000, extra)]).candidates.length, 0, JSON.stringify(extra));
  }
  assert.equal(market(avito({ keyboard: 'US' }), [shop('Айфория', 100_000, { keyboard: 'RU' }), shop('Technichno')]).candidates.length, 0);
  assert.equal(market(avito({ storageGb: 1024 }), [shop('Айфория', 100_000, { storageGb: 1000 }), shop('Technichno', 110_000, { storageGb: 1000 })]).candidates.length, 1);
});

test('unknown cores remain an explicit review lead with no invented exact specification', () => {
  const candidate = market(avito({ cpuCores: null })).candidates[0];
  assert.equal(candidate.requiresReview, true);
  assert.match(candidate.reviewReasons.join(' '), /Проверить число ядер/);
  assert.equal(candidate.alertEligible, true);
  assert.equal(market(avito({ color: 'unknown' })).candidates.length, 0);
});

test('used listings show a discount from new retail, explicitly require inspection, and can be review alerts', () => {
  const candidate = market(avito({ condition: 'used' })).candidates[0];
  assert.equal(candidate.condition, 'used');
  assert.equal(candidate.comparisonKind, 'discount-from-new-retail');
  assert.match(candidate.comparisonNote, /цена перепродажи б\/у не определена/);
  assert.match(candidate.reasons.join(' '), /проверить состояние, аккумулятор, ремонт/);
  assert.equal(candidate.requiresReview, true);
  assert.equal(candidate.alertEligible, true);
  assert.equal(market(avito({ condition: 'refurbished' })).candidates.length, 0);
  assert.equal(market(avito({ condition: 'unknown' })).candidates.length, 0);
});

test('both sides must be current, available and accepted; last rejected checks cannot reuse old prices', () => {
  const invalid = [
    { observedAt: '2026-09-30T07:59:59.000Z' }, { observedAt: '2026-09-30T12:02:00.000Z' },
    { observedAt: 'invalid' }, { validUntil: at }, { withdrawn: true }, { active: false },
    { stock: 'PreOrder' }, { stock: 'OutOfStock' }, { stock: 'unknown' }, { rejected: true },
    { validationStatus: 'rejected' }, { latestAttempt: { rejected: true } },
    { latestAttempt: { validationStatus: 'invalid' } }, { latestAttempt: { status: 'withdrawn' } },
    { visibility: 'private' }, { qualityWarnings: ['Конфликт CPU'] }, { validationIssues: ['invalid_price'] },
    { isDemo: true }, { price: 0 }, { price: NaN }, { price: '80000' }, { minimumQuantity: 2 },
  ];
  for (const extra of invalid) {
    assert.equal(market(avito(extra)).candidates.length, 0, `Avito: ${JSON.stringify(extra)}`);
    assert.equal(market(avito(), [shop(), shop('Technichno', 110_000, extra)]).candidates.length, 0, `shop: ${JSON.stringify(extra)}`);
  }
  assert.equal(market(avito({ observedAt: '2026-09-30T08:00:00.000Z' })).candidates.length, 1);
  assert.equal(market(avito({ observedAt: '2026-09-30T08:00:00.000Z' }), undefined, { maxAgeHours: 3 }).candidates.length, 0);
});

test('price anomalies and conditional availability stay visible for manual review without a normal alert', () => {
  for (const extra of [{ price: 50_000 }, { previousPrice: 120_000 }, { avitoRisks: ['Условия цены требуют проверки'] }]) {
    const candidate = market(avito(extra)).candidates[0];
    assert.equal(candidate.requiresReview, true);
    assert.equal(candidate.alertEligible, false);
    assert.equal(candidate.status, 'needs_review');
    assert.ok(candidate.reasons.length > 0);
  }
  assert.equal(market(avito(), [shop(), shop('Technichno', 150_000)]).candidates[0].alertEligible, false);
  assert.equal(market(avito({ avitoRisks: ['Товар под заказ'] })).candidates.length, 0);
});

test('deduplication uses stable Avito ID and price, latest withdrawal wins, and inputs stay immutable', () => {
  const target = avito(), input = [target, ...[shop(), shop('Technichno')]], before = structuredClone(input);
  const first = calculateAvitoOpportunities([...input, { ...target, listingId: 'alternate-id' }], { now });
  assert.equal(first.candidates.length, 1);
  assert.equal(first.candidates[0].dedupKey, market().candidates[0].dedupKey);
  assert.notEqual(first.candidates[0].dedupKey, market(avito({ price: 79_000 })).candidates[0].dedupKey);
  assert.deepEqual(input, before);
  const withdrawn = { ...target, observedAt: '2026-09-30T12:00:30.000Z', stock: 'Discontinued' };
  assert.equal(calculateAvitoOpportunities([...input, withdrawn], { now }).candidates.length, 0);
  assert.equal(calculateAvitoOpportunities([withdrawn, ...input], { now }).candidates.length, 0);
});

test('own sellers, wrong cities and untrusted URLs are excluded', () => {
  for (const extra of [{ sellerName: 'Макбучная' }, { matchedRetailer: 'MacBookBro' }, { sourceCity: 'Москва' },
    { marketplaceSellerId: '' }, { url: 'https://evil.example/macbook_1234567890' }, { externalId: '9999999999' }]) {
    assert.equal(market(avito(extra)).candidates.length, 0);
  }
  assert.equal(market(avito(), [shop(), shop('Technichno', 110_000, { url: avito().url })]).candidates.length, 0);
});

test('invalid calculation options fail clearly instead of returning false leads', () => {
  for (const options of [{ now: NaN }, { minDeltaRub: -1 }, { minDeltaRub: '1000' }, { minDeltaPercent: 101 },
    { maxAgeHours: 0 }, { costReserveRub: 0.001 }]) assert.throws(() => market(avito(), undefined, options), TypeError);
  assert.throws(() => calculateAvitoOpportunities(null), TypeError);
  assert.equal(calculateAvitoOpportunities([null, false, {}], { now }).candidates.length, 0);
});
