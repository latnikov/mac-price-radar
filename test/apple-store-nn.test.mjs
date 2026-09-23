import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAppleStoreOffers, parseAppleStorePage } from '../scripts/apple-store-nn.mjs';

const root = 'https://nn.stores-apple.com/catalog/mac/';
const card = ({ id, title, href, amount, sale = null }) => `
  <div data-elem class="item item-parent catalog-block-view__item item_block" data-id="${id}" data-product_type="1">
    <div class="item-title"><a class="dark_link" href="${href}"><span>${title}</span></a></div>
    <div class="cost prices"><div data-value="${amount}" class="price font-bold" data-currency="RUB">
      ${sale ? `<div class="price_value_sale"><span>${sale}<span class="price_currency">₽</span></span></div>` : ''}
      <span class="price_value">${amount}</span>
    </div></div>
  </div>`;
const page = ({ total = 4, available = '', preorder = '', next = '' }) => `
  ${next ? `<link rel="next" rel="nofollow" href="${next}">` : ''}
  <div class="item-cnt" data-count="${total}"></div>
  ${available ? `<div class="catalogPage__title catalogPage__title_instock">Товары в наличии</div>${available}` : ''}
  ${preorder ? `<div class="catalogPage__title">Товары по предзаказу</div>${preorder}` : ''}`;

const accessory = card({ id: 1, title: 'Чехол для MacBook Air 13', href: '/catalog/chehol/', amount: 1690 });
const air = card({ id: 2, title: 'Ноутбук Apple MacBook Air 13&quot; (M5, 2026) 10C CPU/8C GPU, 16 ГБ, 512 ГБ SSD, серебристый MDH74', href: '/catalog/macbook-air-m5/', amount: 139390, sale: '125 390' });
const pro = card({ id: 3, title: 'Ноутбук Apple MacBook Pro 14&quot; (M5 Pro, 2026) 12C CPU/18C GPU, 24/1024 ГБ, черный космос', href: '/catalog/macbook-pro-m5-pro/', amount: 229390 });
const neo = card({ id: 4, title: 'Ноутбук Apple MacBook Neo (2026) 8 ГБ, 256 ГБ, индиго MHFF4, английская раскладка', href: '/catalog/macbook-neo-8-256-indigo/', amount: 72990 });

test('parses the unconditional retail price, stock section, and implicit Neo chip', () => {
  const parsed = parseAppleStorePage(page({ available: `${accessory}${air}`, preorder: pro, next: '?PAGEN_4=2' }));
  assert.equal(parsed.total, 4);
  assert.equal(parsed.cardCount, 3);
  assert.equal(parsed.next, `${root}?PAGEN_4=2`);
  assert.equal(parsed.offers.length, 2);
  assert.deepEqual({ price: parsed.offers[0].price, stock: parsed.offers[0].stock, model: parsed.offers[0].model, chip: parsed.offers[0].chip, ram: parsed.offers[0].ramGb, storage: parsed.offers[0].storageGb, color: parsed.offers[0].color },
    { price: 139390, stock: 'InStock', model: 'MacBook Air 13"', chip: 'M5', ram: 16, storage: 512, color: 'Silver' });
  assert.equal(parsed.offers[0].evidence.conditionalWarrantyPrice, 125390);
  assert.equal(parsed.offers[1].stock, 'PreOrder');
});

test('walks every page and verifies the catalogue count before publishing', async () => {
  const pages = new Map([
    [root, page({ available: `${accessory}${air}`, preorder: pro, next: '?PAGEN_4=2' })],
    [`${root}?PAGEN_4=2`, page({ preorder: neo })],
  ]);
  const result = await fetchAppleStoreOffers({ fetchPage: async url => { assert.ok(pages.has(url), url); return pages.get(url); } });
  assert.equal(result.offers.length, 3);
  assert.deepEqual(result.stats, { catalogPagesFetched: 2, catalogCards: 4, macbooks: 3, inStock: 1, preOrder: 2 });
  const parsedNeo = result.offers.find(offer => offer.externalId === '4');
  assert.deepEqual({ model: parsedNeo.model, chip: parsedNeo.chip, cpu: parsedNeo.cpuCores, gpu: parsedNeo.gpuCores, keyboard: parsedNeo.keyboard },
    { model: 'MacBook Neo 13"', chip: 'A18 Pro', cpu: 6, gpu: 5, keyboard: 'US' });
  assert.ok(result.offers.every(offer => offer.retailer === 'Apple Store' && offer.sourceCity === 'Нижний Новгород' && offer.priceType === 'full'));
});

test('rejects partial, duplicated, malformed, and external pagination results', async () => {
  await assert.rejects(fetchAppleStoreOffers({ fetchPage: async () => page({ total: 2, preorder: air }) }), /received 1 of 2/);
  await assert.rejects(fetchAppleStoreOffers({ fetchPage: async url => url === root ? page({ total: 2, preorder: air, next: '?PAGEN_4=2' }) : page({ total: 2, preorder: air }) }), /duplicate product id/);
  assert.throws(() => parseAppleStorePage(page({ total: 1, preorder: card({ id: 8, title: 'Ноутбук Apple MacBook Air 13 M5 16 ГБ 512 ГБ Silver', href: '/catalog/bad/', amount: '' }) })), /invalid retail price/);
  assert.throws(() => parseAppleStorePage(page({ total: 1, preorder: air, next: 'https://evil.test/catalog/mac/?PAGEN_4=2' })), /outside the catalogue/);
});
