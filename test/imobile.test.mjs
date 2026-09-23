import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverImobileLinks, fetchImobileOffers, parseImobileProducts } from '../scripts/imobile.mjs';

const root = 'https://imobile.market/mac';
const category = `${root}/macbook_air`;
const productPage = `${category}/macbook_air_m5_2026/macbook_air_13_m5`;
const variant = (overrides = {}) => ({
  id: '3008', price: '139900', color: 'Темная ночь==#262D35', memory: 'M5 10-Core / GPU 8-Core / 16GB / 512GB', code_model: 'MDHE4',
  title: 'MacBook Air 13 M5 (MDHE4, Темная ночь, M5 10-Core / GPU 8-Core / 16GB / 512GB)', ...overrides,
});
const page = products => `<h1>MacBook Air 13 M5</h1><script>const products = ${JSON.stringify(products)};</script>`;

test('discovers only same-origin MacBook catalogue links outside scripts', () => {
  const html = `<a href="/mac/macbook_air">Air</a><a href='${productPage}?utm_source=x#top'>Product</a>
    <a href='/mac/imac_24'>iMac</a><a href='https://evil.test/mac/macbook_pro'>External</a>
    <script>const fake = '<a href="/mac/macbook_fake">fake</a>';</script>`;
  assert.deepEqual(discoverImobileLinks(html, root), [category, productPage]);
});

test('parses every selectable variant at the non-loyalty cash price', () => {
  const offers = parseImobileProducts(page([
    variant(),
    variant({ id: '3010', price: '157900', color: 'Серебристый==#ccc', code_model: 'MDH84', title: 'MacBook Air 13 M5 (MDH84, Серебристый, M5 10-Core / GPU 10-Core / 16GB / 1ТB)' }),
  ]), productPage);
  assert.equal(offers.length, 2);
  assert.deepEqual({ price: offers[0].price, model: offers[0].model, chip: offers[0].chip, ram: offers[0].ramGb, storage: offers[0].storageGb, color: offers[0].color, cpu: offers[0].cpuCores, gpu: offers[0].gpuCores },
    { price: 139900, model: 'MacBook Air 13"', chip: 'M5', ram: 16, storage: 512, color: 'Midnight', cpu: 10, gpu: 8 });
  assert.ok(offers.every(offer => offer.retailer === 'iMobile' && offer.sourceCity === 'Нижний Новгород' && offer.priceType === 'full' && offer.stock === 'source_reported'));
  assert.equal(offers[1].externalId, '3010');
  assert.equal(offers[1].storageGb, 1000);
  assert.deepEqual(offers[1].qualityWarnings, []);
  assert.equal(offers[1].evidence.priceMeaning, 'Стоимость без карты лояльности');
});

test('normalizes iMobile Neo titles with implicit 8GB memory and Cyrillic chip spelling', () => {
  const neoUrl = `${root}/macbook_neo_13_a18_pro_6c_5c-_2026`;
  const [offer] = parseImobileProducts(page([variant({
    id: '2958', price: '65900', color: 'Citrus==#F0E68C', memory: '256GB', code_model: '',
    title: 'Macbook Neo 13’ (А18 Pro 6C / 5C, 2026) (Citrus, 256GB)',
  })]), neoUrl);
  assert.deepEqual({ model: offer.model, chip: offer.chip, ram: offer.ramGb, storage: offer.storageGb, color: offer.color, cpu: offer.cpuCores, gpu: offer.gpuCores },
    { model: 'MacBook Neo 13"', chip: 'A18 Pro', ram: 8, storage: 256, color: 'Citrus', cpu: 6, gpu: 5 });
});

test('crawls category hierarchy, keeps same-page variants separate, and rejects incomplete runs', async () => {
  const pages = new Map([
    [root, `<a href="/mac/macbook_air">Air</a>`],
    [category, `<a class="card-title" href="${productPage}">M5</a>`],
    [productPage, page([variant(), variant({ id: '3009', price: '140900', color: 'Сияющая звезда==#fff', title: 'MacBook Air 13 M5 (MDHA4, Сияющая звезда, M5 10-Core / GPU 8-Core / 16GB / 512GB)' })])],
  ]);
  const result = await fetchImobileOffers({ fetchPage: async url => { assert.ok(pages.has(url), url); return pages.get(url); } });
  assert.equal(result.offers.length, 2);
  assert.deepEqual(result.stats, { pagesFetched: 3, productPages: 1, variants: 2 });
  await assert.rejects(fetchImobileOffers({ fetchPage: async url => url === root ? '<a href="/mac/macbook_air">Air</a>' : new Response('Failure', { status: 503 }) }), /incomplete crawl:.*HTTP 503/);
  await assert.rejects(fetchImobileOffers({ fetchPage: async () => '<h1>Mac</h1>' }), /no priced MacBook variants/);
});
