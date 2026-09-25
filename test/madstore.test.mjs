import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverMadstoreCategoryUrls, discoverMadstoreStoreParts, fetchMadstoreOffers, parseMadstoreProducts } from '../scripts/madstore.mjs';

const root = `
  <a href="/macbook-madstore">Air M4</a>
  <a href="macbook-air-m5-2026">Air M5</a>
  <a href="https://evil.test/macbook-pro">outside</a>
  <a href="/macbook-air-m5-2026/tproduct/1-2-product">product</a>`;
const store = (recid, storepartuid) => `<script>var options={recid:'${recid}',storepart:'${storepartuid}',size:36};t_store_init('${recid}',options);</script>`;

const product = (overrides = {}) => ({
  uid: 100,
  title: 'MacBook Air 13" (M5) 512GB/16GB/10 CPU/8 GPU',
  sku: 'Цвет: Midnight',
  url: 'https://madstore.ru/macbook-air-m5-2026/tproduct/1-100-macbook-air',
  quantity: '',
  characteristics: [
    { title: 'Цвет', value: 'Midnight' },
    { title: 'Объем памяти', value: '512GB' },
    { title: 'Процессор', value: 'M5' },
    { title: 'Оперативная память', value: '16GB' },
    { title: 'Core CPU', value: '10' },
    { title: 'Core GPU', value: '8' },
    { title: 'Диагональ дисплея', value: '13,6 дюйма' },
  ],
  editions: [
    { uid: 101, externalid: 'cash-air', price: '139 990.00', quantity: '', 'Способ оплаты': 'Наличными' },
    { uid: 102, externalid: 'card-air', price: '156 790.00', quantity: '', 'Способ оплаты': 'Банковской картой' },
  ],
  ...overrides,
});

const neo = product({
  uid: 200,
  title: 'MacBook Neo 13" (A18 Pro) 8Gb/6-CPU/5-GPU/256Gb',
  sku: 'Цвет: Citrus',
  url: 'https://madstore.ru/macbook-neo/tproduct/2-200-macbook-neo',
  characteristics: [
    { title: 'Цвет', value: 'Citrus' },
    { title: 'Объем памяти', value: '256GB' },
    { title: 'Процессор', value: 'A18' },
    { title: 'Оперативная память', value: '8GB' },
    { title: 'Диагональ дисплея', value: '13 дюйма' },
  ],
  editions: [
    { uid: 201, externalid: 'cash-neo', price: '69 990.00', quantity: '0', 'Способ оплаты': 'Наличными' },
    { uid: 202, externalid: 'card-neo', price: '78 390.00', quantity: '', 'Способ оплаты': 'Банковской картой' },
  ],
});

test('discovers only local category pages and every Tilda catalogue reference', () => {
  assert.deepEqual(discoverMadstoreCategoryUrls(root), [
    'https://madstore.ru/macbook-madstore',
    'https://madstore.ru/macbook-air-m5-2026',
  ]);
  assert.deepEqual(discoverMadstoreStoreParts(`${store(1, 11)}${store(2, 22)}${store(1, 11)}`), [
    { recid: '1', storepartuid: '11' },
    { recid: '2', storepartuid: '22' },
  ]);
  assert.throws(() => discoverMadstoreCategoryUrls('<a href="https://evil.test/macbook">MacBook</a>'), /links not found/);
  assert.throws(() => discoverMadstoreStoreParts('<h1>MacBook</h1>'), /reference not found/);
});

test('publishes the explicit cash edition with canonical specifications and source terms', () => {
  const conflict = product({
    uid: 300,
    title: 'MacBook Pro 14\' (M5) 1TB/24GB/10 CPU/10 GPU',
    sku: 'Цвет: Silver',
    url: 'https://madstore.ru/macbook-pro-m5/tproduct/3-300-macbook-pro',
    characteristics: [
      { title: 'Цвет', value: 'Silver' },
      { title: 'Объем памяти', value: '2TB' },
      { title: 'Процессор', value: 'M5' },
      { title: 'Оперативная память', value: '24GB' },
      { title: 'Core CPU', value: '10' },
      { title: 'Core GPU', value: '10' },
      { title: 'Диагональ дисплея', value: '14,2 дюйма' },
    ],
    editions: [
      { uid: 301, price: '219 990.00', quantity: '', 'Способ оплаты': 'Наличными' },
      { uid: 302, price: '246 390.00', quantity: '', 'Способ оплаты': 'Банковской картой' },
    ],
  });
  const offers = parseMadstoreProducts([product(), neo, conflict], { fetchedAt: '2026-09-26T10:00:00.000Z' });
  assert.deepEqual({ model: offers[0].model, chip: offers[0].chip, cpu: offers[0].cpuCores, gpu: offers[0].gpuCores, ram: offers[0].ramGb, storage: offers[0].storageGb, color: offers[0].color, price: offers[0].price },
    { model: 'MacBook Air 13"', chip: 'M5', cpu: 10, gpu: 8, ram: 16, storage: 512, color: 'Midnight', price: 139990 });
  assert.deepEqual({ model: offers[1].model, chip: offers[1].chip, cpu: offers[1].cpuCores, gpu: offers[1].gpuCores, stock: offers[1].stock },
    { model: 'MacBook Neo 13"', chip: 'A18 Pro', cpu: 6, gpu: 5, stock: 'OutOfStock' });
  assert.equal(new URL(offers[0].url).searchParams.get('editionuid'), '101');
  assert.equal(offers[2].storageGb, 1000);
  assert.match(offers[2].qualityWarnings.join('; '), /Конфликт SSD.*1000 GB.*2000 GB/);
  assert.ok(offers.every(offer => offer.retailer === 'Madstore' && offer.sourceCity === 'Нижний Новгород' && offer.paymentMethod === 'cash' && offer.priceType === 'full'));
  assert.ok(offers.every(offer => offer.evidence.priceMeaning === 'Цена при оплате наличными'));
});

test('walks every linked section, checks pagination and deduplicates repeated products', async () => {
  const categoryOne = 'https://madstore.ru/macbook-madstore';
  const categoryTwo = 'https://madstore.ru/macbook-air-m5-2026';
  const pages = new Map([
    ['https://madstore.ru/macbook', root],
    [categoryOne, `${store(1, 11)}${store(2, 22)}`],
    [categoryTwo, store(3, 33)],
  ]);
  const payloads = new Map([
    ['11:1', { total: 2, products: [product()] }],
    ['11:2', { total: 2, products: [neo] }],
    ['22:1', { total: 1, products: [product()] }],
    ['33:1', { total: 1, products: [neo] }],
  ]);
  const fetchPage = async url => {
    if (pages.has(url)) return pages.get(url);
    const parsed = new URL(url);
    return payloads.get(`${parsed.searchParams.get('storepartuid')}:${parsed.searchParams.get('slice')}`);
  };
  const result = await fetchMadstoreOffers({ fetchPage, pageSize: 1 });
  assert.equal(result.offers.length, 2);
  assert.deepEqual(result.stats, {
    catalogPagesFetched: 3,
    categoryPages: 2,
    catalogueSections: 3,
    apiPagesFetched: 4,
    sectionProducts: 4,
    duplicatePlacements: 2,
    uniqueProducts: 2,
    variants: 2,
  });
  assert.deepEqual(result.offers[1].evidence.categoryPages, [categoryOne, categoryTwo]);

  const incomplete = async url => pages.has(url)
    ? pages.get(url)
    : { total: 2, products: new URL(url).searchParams.get('slice') === '1' ? [product()] : [] };
  await assert.rejects(fetchMadstoreOffers({ fetchPage: incomplete, pageSize: 1 }), /pagination stopped early/);
});

test('rejects ambiguous payment terms, malformed prices and unsafe product links', () => {
  assert.throws(() => parseMadstoreProducts([product({ editions: [] })]), /exactly one cash-price/);
  assert.throws(() => parseMadstoreProducts([product({ editions: [{ uid: 101, price: 'free', 'Способ оплаты': 'Наличными' }] })]), /invalid cash price/);
  assert.throws(() => parseMadstoreProducts([product({ url: 'https://evil.test/macbook/tproduct/1-2-product' })]), /outside/);
});
