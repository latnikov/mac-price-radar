import test from 'node:test';
import assert from 'node:assert/strict';
import { IPHONE_MODELS, iphoneModel, iphoneStorage, iphoneColor, iphoneSim, parseIphone } from '../scripts/iphone.mjs';
import { parseProduct } from '../scripts/offer-normalization.mjs';
import { assessOffer, offerIdentityFields, variantKey } from '../scripts/domain.mjs';
import { openMasterStore } from '../scripts/master-store.mjs';

const at = '2026-10-01T10:00:00.000Z';
function offer(model = 'iPhone 18 Pro', simType = 'eSIM', metadata = {}) {
  return parseProduct(`${model} 256GB Silver`, 'https://shop.test/iphone-18-pro-256gb-silver', 'Shop', 120990.25, at, {
    simType, condition: 'new', region: 'US', stock: 'InStock', priceType: 'full', paymentMethod: 'cash', buyerType: 'retail', minimumQuantity: 1, ...metadata,
  });
}

test('normalizes exactly the four requested iPhone families, including compact and Russian names', () => {
  assert.deepEqual(new Set(IPHONE_MODELS), new Set(['iPhone 18 Pro', 'iPhone 18 Pro Max', 'iPhone 17 Pro', 'iPhone 17 Pro Max']));
  for (const model of IPHONE_MODELS) {
    assert.equal(iphoneModel(`Apple ${model} 256GB`), model);
    assert.equal(iphoneModel(model.replaceAll(' ', '').toUpperCase()), model);
    assert.equal(iphoneModel(model.replace('iPhone', 'Айфон')), model);
    const normalized = offer(model);
    assert.equal(normalized.model, model);
    assert.deepEqual([normalized.ramGb, normalized.cpuCores, normalized.gpuCores, normalized.screenIn], [null, null, null, null]);
    assert.equal(normalized.keyboard, 'not_applicable');
  }
  for (const title of ['iPhone 16 Pro', 'iPhone 18', 'iPhone 17 Air', 'iPhone 18 ProMotion', 'MacBook Pro M5']) assert.equal(iphoneModel(title), null);
});

test('canonicalizes phone storage, exact color names and physical versus electronic SIM', () => {
  for (const [text, storage] of [['256Гб', 256], ['512GB', 512], ['1ТБ', 1000], ['1024 GB', 1000], ['2TB', 2000], ['2048Gb', 2000]]) assert.equal(iphoneStorage(text), storage);
  for (const [text, color, model] of [
    ['Cosmic Orange', 'Cosmic Orange', 'iPhone 17 Pro'], ['Deep Blue', 'Deep Blue', 'iPhone 17 Pro Max'],
    ['Glacier', 'Glacier', 'iPhone 18 Pro'], ['Burgundy', 'Burgundy', 'iPhone 18 Pro Max'],
    ['Серебристый (Silver)', 'Silver', 'iPhone 18 Pro'], ['Чёрный (Black)', 'Black', 'iPhone 18 Pro'],
  ]) assert.equal(iphoneColor(text, model), color);
  for (const [text, expected] of [
    ['eSIM', 'eSIM'], ['Dual eSIM', 'eSIM'], ['eSIM + eSIM', 'eSIM'], ['eSIM / eSIM', 'eSIM'],
    ['SIM + eSIM', 'SIM + eSIM'], ['nanoSIM + eSIM', 'SIM + eSIM'], ['Sim-eSim', 'SIM + eSIM'],
    ['2 nano SIM', 'Dual SIM'], ['Dual SIM', 'Dual SIM'], ['SIM + SIM', 'Dual SIM'], ['', 'unknown'],
  ]) assert.equal(iphoneSim(text), expected, text);
});

test('takes memory from the title and records conflicts with the product URL', () => {
  const phone = parseProduct('iPhone 17 Pro Max 1TB Deep Blue SIM+eSIM', 'https://shop.test/iphone-17-pro-max-256gb', 'Shop', 130000, at);
  assert.deepEqual([phone.storageGb, phone.color, phone.simType], [1000, 'Deep Blue', 'SIM + eSIM']);
  assert.ok(phone.qualityWarnings.some(warning => /Конфликт памяти/.test(warning)));
  const fromSlug = parseProduct('iPhone 18 Pro', 'https://shop.test/iphone-18-pro-512gb-burgundy-esim', 'Shop', 140000, at);
  assert.deepEqual([fromSlug.storageGb, fromSlug.color, fromSlug.simType], [512, 'Burgundy', 'eSIM']);
  assert.equal(parseProduct('iPhone 18 Pro', 'https://shop.test/iphone-18-pro', 'Shop', 140000, at), null);
});

test('keeps condition and price semantics and rejects accessories and fractions of a kopeck', () => {
  for (const [suffix, expected] of [['б/у', 'used'], ['used', 'used'], ['ASIS+', 'open_box'], ['open box', 'open_box'], ['предактив', 'open_box'], ['refurbished', 'refurbished']]) {
    assert.equal(parseProduct(`iPhone 17 Pro 256GB Silver ${suffix}`, 'https://shop.test/phone', 'Shop', 100000, at).condition, expected);
  }
  assert.equal(offer('iPhone 18 Pro', 'eSIM', { rawPrice: 'от 120990' }).priceType, 'from');
  assert.equal(offer('iPhone 18 Pro', 'eSIM', { rawPrice: '5000 в месяц' }).priceType, 'installment');
  for (const title of ['Чехол iPhone 18 Pro 256GB', 'Case iPhone 17 Pro 256GB', 'Защитное стекло iPhone 17 Pro Max 256GB', 'Коробка от iPhone 18 Pro 256GB']) assert.equal(parseProduct(title, 'https://shop.test/accessory', 'Shop', 2000, at), null);
  for (const amount of [0, -1, NaN, Infinity, 120990.001, Number.MAX_SAFE_INTEGER]) assert.equal(parseIphone('iPhone 18 Pro 256GB', 'https://shop.test/phone', 'Shop', amount, at), null);
  assert.deepEqual([offer().price, offer().priceMinor, offer().currency], [120990.25, 12099025, 'RUB']);
});

test('phone identity requires memory, color and SIM while avoiding Mac-only specification requirements', () => {
  const esim = offer(), physical = offer('iPhone 18 Pro', 'SIM + eSIM');
  assert.deepEqual(offerIdentityFields(esim), ['model', 'storageGb', 'color', 'simType', 'region', 'bundle']);
  assert.notEqual(variantKey(esim), variantKey(physical));
  assert.equal(variantKey(esim), variantKey({ ...esim, retailer: 'Other Shop', url: 'https://other.test/another-phone', chip: 'A20 Pro' }));
  assert.equal(assessOffer(esim, { now: Date.parse(at) }).marketEligible, true);
  assert.equal(assessOffer({ ...esim, condition: 'open_box' }, { now: Date.parse(at) }).marketEligible, false);
  const unresolved = { ...esim, simType: 'unknown' };
  assert.notEqual(variantKey(unresolved), variantKey({ ...unresolved, retailer: 'Other Shop', url: 'https://other.test/phone' }));
  const assessment = assessOffer(unresolved, { now: Date.parse(at) });
  assert.equal(assessment.matchStatus, 'needs_review');
  assert.ok(assessment.qualityReasons.some(reason => /simType/.test(reason)));
});

test('SQLite round-trip retains all four phone models and independent SIM variants with accepted money', t => {
  const store = openMasterStore(':memory:');
  t.after(() => store.close());
  const observations = IPHONE_MODELS.flatMap((model, index) => ['eSIM', 'SIM + eSIM'].map((simType, variant) => offer(model, simType, {
    retailer: 'Айфория', externalId: `iphoriya:${index * 10 + variant + 1}`, sourceProductId: String(index + 1),
    sourceVariantId: String(index * 10 + variant + 1), url: `https://iphoriya.ru/product/phone-${index + 1}`,
    evidence: { method: 'phone-test', originalSimType: simType },
  })));
  assert.equal(store.ingestRun({ runId: 'phone-first', observations }).counts.accepted, 8);
  const saved = store.getOffers();
  assert.equal(saved.length, 8);
  assert.equal(new Set(saved.map(item => item.listingId)).size, 8);
  for (const model of IPHONE_MODELS) assert.deepEqual(new Set(saved.filter(item => item.model === model).map(item => item.simType)), new Set(['eSIM', 'SIM + eSIM']));
  assert.ok(saved.every(item => item.storageGb === 256 && item.priceMinor === 12099025 && item.ramGb === null && item.rejected === false));
  assert.ok(saved.every(item => item.evidence.originalSimType === item.simType));
  const updated = observations.map(item => ({ ...item, price: 119990.25, priceMinor: 11999025, observedAt: '2026-10-01T11:00:00.000Z', fetchedAt: '2026-10-01T11:00:00.000Z' }));
  store.ingestRun({ runId: 'phone-next', observations: updated });
  assert.equal(store.getOffers().length, 8);
  assert.ok(store.getOffers().every(item => item.priceMinor === 11999025));
  assert.equal(store.getHistory(saved[0].listingId).length, 2);
});
