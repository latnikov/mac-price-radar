import test from 'node:test';
import assert from 'node:assert/strict';
import { apifySnapshot } from '../scripts/avito-apify.mjs';
import { parseAvitoSnapshot } from '../scripts/avito.mjs';

const options = { runId: 'synthetic-run', startedAt: '2026-09-30T12:00:00Z', finishedAt: '2026-09-30T12:01:00Z', now: Date.parse('2026-09-30T12:01:01Z') };
const parameters = values => Object.entries(values).map(([name, value]) => ({ name, value }));
const record = (overrides = {}) => ({
  id: 1234567890, url: 'https://www.avito.ru/nizhniy_novgorod/noutbuki/macbook_air_1234567890?tracking=1#top',
  title: 'MacBook Air 13 M5 16/512 Sky Blue', address: 'Нижегородская обл., г.о. Нижний Новгород, ул. Учебная, 1',
  price: 110900, priceFormatted: '110\u00a0900 ₽', currency: '₽', status: 'active',
  description: 'Использовался, полностью исправен.', userType: 'private', scrapedAt: '2026-09-30T12:00:30.123456+00:00',
  parameters: parameters({ 'Состояние': 'Отличное', 'Модель': 'Macbook Air 13 (2026, M5)', 'Процессор': 'Apple M5',
    'Диагональ, дюйм': '13.6', 'Оперативная память, ГБ': '16', 'Объем накопителей, ГБ': '512', 'Цвет': 'Голубой',
    'Количество ядер процессора': '10', 'Видеокарта': 'Apple graphics 10-core' }),
  seller: { name: 'Алексей', userKey: 'seller-key', profileUrl: 'https://www.avito.ru/user/seller-key/profile' },
  ...overrides,
});
const snapshot = records => apifySnapshot(records, options);
const parsed = records => parseAvitoSnapshot(snapshot(records), { now: options.now });

test('Apify phone records preserve the legacy snapshot scope and explicit memory, SIM and region without invented laptop fields', () => {
  for (const model of ['iPhone 18 Pro', 'iPhone 18 Pro Max', 'iPhone 17 Pro', 'iPhone 17 Pro Max']) {
    const phone = record({ title: `${model} Silver`, url: 'https://www.avito.ru/nizhniy_novgorod/telefony/iphone_1234567890',
      parameters: parameters({ 'Состояние': 'Отличное', 'Модель': model, 'Встроенная память': '256 ГБ', 'Цвет': 'Silver', 'Тип SIM-карты': 'SIM + eSIM', 'Регион': 'EU' }) });
    const output = snapshot([phone]);
    assert.equal(output.scope, 'avito-nizhny-macbook');
    const [offer] = parsed([phone]).offers;
    assert.equal(offer?.model, model);
    assert.equal(offer.storageGb, 256);
    assert.equal(offer.simType, 'SIM + eSIM');
    assert.equal(offer.region, 'EU');
    assert.ok(['chip', 'ramGb', 'cpuCores', 'gpuCores', 'screenIn'].every(field => offer[field] === null));
  }
});

test('Apify adapter produces a partial importable snapshot using observation time, explicit specs and seller identity', () => {
  const source = record(), input = structuredClone(source);
  const result = snapshot([source]);
  assert.deepEqual(source, input);
  assert.equal(result.complete, false);
  assert.equal(result.expectedTotal, null);
  assert.equal(result.discovered, 1);
  assert.equal(result.completedAt, options.finishedAt);
  assert.equal(result.listings[0].observedAt, source.scrapedAt);
  assert.equal(result.listings[0].seller.id, 'seller-key');
  assert.equal(result.listings[0].url, 'https://www.avito.ru/nizhniy_novgorod/noutbuki/macbook_air_1234567890');
  assert.equal(result.listings[0].currency, 'RUB');
  assert.equal(result.listings[0].documentHash.length, 64);
  const output = parseAvitoSnapshot(result, { now: options.now });
  assert.equal(output.offers.length, 1);
  assert.equal(output.offers[0].color, 'Sky Blue');
  assert.equal(output.offers[0].cpuCores, 10);
  assert.equal(output.offers[0].gpuCores, 10);
  assert.equal(output.offers[0].fetchedAt, source.scrapedAt);
});

test('Apify never uses generic catalogue productSpecs, URL slugs, or descriptions to complete configurations', () => {
  const incomplete = record({ title: 'MacBook Air 13 M5', parameters: parameters({ 'Состояние': 'Отличное' }),
    url: 'https://www.avito.ru/nizhniy_novgorod/noutbuki/macbook_air_m5_16_512_sky_blue_1234567890',
    description: '16 GB RAM, 512 GB SSD, Sky Blue',
    productSpecs: { specs: [{ key: 'Оперативная память', value: '16' }, { key: 'Объем накопителей', value: '512' }] },
  });
  const result = snapshot([incomplete]);
  assert.deepEqual(result.listings[0].specs, {});
  assert.equal(parsed([incomplete]).offers.length, 0);
  assert.equal(parsed([incomplete]).review.length, 1);
});

test('Apify recognizes explicit Neo model ordering and yellow alias without inventing its chip or screen', () => {
  const neo = record({ title: 'MacBook Neo 8/256GB Citrus', parameters: parameters({ 'Состояние': 'Отличное',
    'Модель': 'MacBook 13 Neo (2026)', 'Процессор': 'Apple A18 Pro', 'Диагональ, дюйм': '13',
    'Оперативная память, ГБ': '8', 'Объем накопителей, ГБ': '256', 'Цвет': 'Жёлтый' }) });
  const [offer] = parsed([neo]).offers;
  assert.equal(offer?.model, 'MacBook Neo 13"');
  assert.equal(offer.chip, 'A18 Pro');
  assert.equal(offer.color, 'Citrus');
  const noChip = structuredClone(neo);
  noChip.parameters = noChip.parameters.filter(item => item.name !== 'Процессор');
  assert.equal(parsed([noChip]).offers.length, 0);
  const noSize = structuredClone(neo);
  noSize.parameters = parameters({ 'Состояние': 'Отличное', 'Модель': 'MacBook Neo', 'Процессор': 'Apple A18 Pro', 'Цвет': 'Citrus' });
  assert.equal(parsed([noSize]).offers.length, 0);
});

test('Apify accepts explicit NN localities but never infers location from the search URL', () => {
  for (const address of ['Нижний Новгород', 'г.о. Нижний Новгород', 'Нижегородская область, Нижний Новгород, центр']) {
    assert.equal(parsed([record({ address })]).offers.length, 1, address);
  }
  for (const address of ['Нижегородская область', 'Бор', 'Великий Новгород', 'Москва, ул. Нижний Новгород']) {
    assert.equal(parsed([record({ address })]).offers.length, 0, address);
  }
  assert.equal(parsed([record({ address: undefined })]).review.length, 1);
  assert.equal(parsed([record({ city: 'Москва' })]).review.length, 1);
});

test('Apify preserves short links and partial details for review instead of fabricating slugs', () => {
  const result = snapshot([record({ url: 'https://www.avito.ru/1234567890', address: undefined, parameters: undefined, status: undefined })]);
  assert.equal(result.listings[0].url, 'https://www.avito.ru/1234567890');
  assert.equal(result.diagnostics.detailed, 0);
  assert.equal(parseAvitoSnapshot(result, { now: options.now }).review.length, 1);
  assert.equal(parsed([record({ url: 'https://www.avito.ru/1234567890' })]).offers.length, 0);
});

test('Apify rejects URL host, ID and seller/profile conflicts', () => {
  for (const url of ['https://evil.test/macbook_1234567890', 'https://www.avito.ru/noutbuki/macbook_1234567899', 'http://www.avito.ru/noutbuki/macbook_1234567890']) {
    assert.equal(parsed([record({ url })]).offers.length, 0, url);
  }
  for (const profileUrl of ['https://evil.test/user/seller-key/profile', 'https://www.avito.ru/user/different-key/profile', 'https://www.avito.ru/brands/seller-key']) {
    const bad = record({ seller: { name: 'Тест', userKey: 'seller-key', profileUrl } });
    assert.equal(snapshot([bad]).listings[0].seller.id, '');
    assert.equal(parsed([bad]).review.length, 1);
  }
  const profileOnly = record({ seller: { name: 'Тест', profileUrl: 'https://www.avito.ru/user/exact-key/profile' } });
  assert.equal(parsed([profileOnly]).offers[0].marketplaceSellerId, 'exact-key');
});

test('Apify keeps explicit promotional prices in review, including confusable Cyrillic copy', () => {
  for (const description of ['Цена с учётом скидки при обмене', 'Используйте промокод', 'Уникальный прoмокод на скидку', 'Цена при покупке гарантии']) {
    const result = parsed([record({ description })]);
    assert.equal(result.offers.length, 0, description);
    assert.equal(result.review.length, 1, description);
  }
  for (const overrides of [{ priceFormatted: 'от 110 900 ₽' }, { priceFormatted: '10 900 ₽' }, { title: 'MacBook Air 13 M5 16/512 Sky Blue в месяц' }, { currency: 'USD' }, { price: -1 }, { price: '110900' }]) {
    assert.equal(parsed([record(overrides)]).offers.length, 0, JSON.stringify(overrides));
  }
  assert.equal(parsed([record({ description: 'Оплата наличными, картой (+14%), рассрочка до 36 месяцев', hasInstallments: true })]).offers.length, 1);
});

test('Apify flags explicit preorder language without rewriting source evidence', () => {
  const description = 'Вы производите предоплату. Срок привоза — до 15 рабочих дней.';
  const item = snapshot([record({ description })]).listings[0];
  assert.deepEqual(item.adapterRisks, ['Товар под заказ']);
  assert.equal(item.description, description);
});

test('Apify never supplies now for missing, stale or out-of-run observations', () => {
  for (const scrapedAt of [undefined, 'bad', '2026-09-30T12:00:30', '2026-09-29T12:00:30Z', '2026-09-30T12:01:01Z']) {
    const result = snapshot([record({ scrapedAt })]);
    assert.equal(result.discovered, 1);
    assert.equal(result.listings.length, 0);
    assert.equal(result.diagnostics.skipped.length, 1);
    assert.equal(result.complete, false);
  }
  const stale = apifySnapshot([record()], { ...options, now: options.now + 3 * 3600000 });
  assert.throws(() => parseAvitoSnapshot(stale, { now: options.now + 3 * 3600000 }), /устарел/);
});

test('Apify validates run provenance and skips malformed record IDs', () => {
  assert.throws(() => apifySnapshot({}, options), /массивом/);
  for (const changes of [{ runId: '' }, { startedAt: 'bad' }, { startedAt: '2026-09-30T12:02:00Z' }, { finishedAt: '2026-09-30T12:03:00Z' }]) {
    assert.throws(() => apifySnapshot([], { ...options, ...changes }), /Apify/);
  }
  const result = snapshot([null, {}, record({ id: 'invalid' }), record({ id: Number.MAX_SAFE_INTEGER + 1 })]);
  assert.equal(result.discovered, 0);
  assert.equal(result.listings.length, 0);
  assert.equal(result.diagnostics.skipped.length, 4);
});

test('Apify deduplicates observations, retains newest observation and quarantines same-time conflicts', () => {
  const first = record(), later = record({ scrapedAt: '2026-09-30T12:00:50Z', price: 100000, priceFormatted: '100 000 ₽' });
  const result = snapshot([first, first, later, first]);
  assert.equal(result.discovered, 1);
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].price, 100000);
  assert.equal(result.diagnostics.duplicates, 3);
  const conflict = record({ price: 100000, priceFormatted: '100 000 ₽' });
  assert.equal(parsed([first, conflict, conflict]).offers.length, 0);
  assert.equal(parsed([first, conflict, conflict]).review.length, 1);
});

test('Apify retains listing parameter ambiguity and title conflicts for review', () => {
  const source = record();
  for (const additional of [
    { name: 'Оперативная память, ГБ', value: '24' }, { name: 'Диагональ, дюйм', value: '15.3' },
    { name: 'Цвет', value: 'Silver / Sky Blue' }, { name: 'Процессор', value: 'Apple M5 / Apple M4' },
  ]) {
    assert.equal(parsed([record({ parameters: [...source.parameters, additional] })]).offers.length, 0, additional.name);
  }
  const conflict = record({ title: 'MacBook Air 13 M5 24/512 Sky Blue' });
  assert.equal(parsed([conflict]).review.length, 1);
});

test('Apify keeps working used listings, excluding broken, other-city and own-store listings', () => {
  assert.equal(parsed([record({ address: 'Москва' })]).excluded.length, 1);
  const used = record();
  used.parameters.find(p => p.name === 'Состояние').value = 'Отличное';
  assert.equal(parsed([used]).offers[0].condition, 'used');
  assert.equal(parsed([{ ...used, parameters: [...used.parameters, { name: 'Неисправны устройства', value: 'Веб-камера' }] }]).excluded.length, 1);
  assert.equal(parsed([record({ seller: { userKey: 'own-store', name: 'Макбучная' } })]).excluded.length, 1);
  const removed = parsed([record({ status: 'removed' })]);
  assert.equal(removed.offers[0].stock, 'Discontinued');
});

test('Apify refuses unsupported snapshot size instead of silently truncating', () => {
  const records = Array.from({ length: 3001 }, (_, i) => record({ id: 1234567890 + i, url: `https://www.avito.ru/noutbuki/macbook_${1234567890 + i}` }));
  assert.throws(() => snapshot(records), /3000/);
});
