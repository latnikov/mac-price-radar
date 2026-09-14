import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProduct, price } from '../scripts/offer-normalization.mjs';
import { findRifaCategoryUrls, findRifaNextPage, parseRifaCategory } from '../scripts/rifastore.mjs';

const title = 'MacBook Air 13, M4 (10c CPU, 10c GPU) RAM 24 ГБ, SSD 1 ТБ, Starlight (Сияющая звезда), английская раскладка (KB-US)';
const productUrl = 'https://rifastore.ru/products/macbook-air-13-m4-10c-cpu-10c-gpu-ram-24-gb-ssd-1-tb-starlight';
const categoryHtml = `
  <link rel="next" href="/categories/macbook-air-13-m4?page=2">
  <a data-ng-href="{{productViewItem.getUrl('${productUrl}')}}" class="products-view-name-link" title="${title}"></a>
  <div class="products-view-meta"></div>
  <div class="price-number">142 000 <span>руб.</span></div>
`;

test('discovers RifaStore categories and pagination', () => {
  assert.deepEqual(findRifaCategoryUrls('<a href="/categories/macbook-air-13-m4">Air</a>'), ['https://rifastore.ru/categories/macbook-air-13-m4']);
  assert.equal(findRifaNextPage(categoryHtml, 'https://rifastore.ru/categories/macbook-air-13-m4'), 'https://rifastore.ru/categories/macbook-air-13-m4?page=2');
});

test('parses an Angular RifaStore card into the catalog format', () => {
  const [raw] = parseRifaCategory(categoryHtml, 'https://rifastore.ru/categories/macbook-air-13-m4');
  assert.equal(raw.url, productUrl);
  assert.equal(price(raw.priceText), 142000);
  const offer = parseProduct(raw.title, raw.url, 'RifaStore', price(raw.priceText), '2026-09-14T00:00:00.000Z');
  assert.equal(offer.model, 'MacBook Air 13"');
  assert.equal(offer.storageGb, 1000);
  assert.equal(offer.ramGb, 24);
  assert.equal(offer.color, 'Starlight');
  assert.equal(offer.cpuCores, 10);
  assert.equal(offer.gpuCores, 10);
});
