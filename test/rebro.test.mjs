import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRebroOffers, parseRebroPage } from '../scripts/rebro.mjs';

const root = 'https://nn.rebro-store.ru/catalog/mac/';
const card = ({ id, title, href, amount = null, old = null }) => `
  <div class="col-6 col-md-4 col-xl-3" id="bx_3966226736_${id}">
    <div class="catalog-item _bg-none _btn-hide">
      <p class="catalog-item__head"><a href="${href}" class="link-head">${title}</a></p>
      <div class="price">${amount ? `<b class="product-price__price">${amount} &#8381;</b>${old ? `<s class="product-price__sale1">${old} &#8381;</s>` : ''}` : '<b>Нет в наличии</b>'}</div>
      ${amount ? `<a data-role="basket-add" data-item="${id}">В корзину</a>` : '<a class="btn">Перейти</a>'}
    </div>
  </div>`;
const page = ({ total, cards, next = '' }) => `
  <span id="catalog-top__count">${total}</span>
  <div class="catalog-row">${cards}</div>
  ${next ? `<a class="pagination__arrow _next" href="${next}">Дальше</a>` : ''}`;

test('parses current Rebro prices, product identity and stock while excluding crossed-out prices', () => {
  const html = page({ total: 3, cards: [
    card({ id: 12732, title: 'Apple MacBook Neo 13&quot; (A18 Pro, 6C / 5C, 2026) 8 ГБ, 256 ГБ SSD, Розовый румянец', href: '/catalog/mac/macbook-neo/neo-pink/', amount: '71 990', old: '89 990' }),
    card({ id: 12733, title: 'Apple MacBook Air 13&quot; (M5, 10C / 8C, 2026) 16 ГБ, 512 ГБ SSD, Полуночный черный', href: '/catalog/mac/macbook-air/air-midnight/', amount: '140 990', old: '176 990' }),
    card({ id: 6406, title: 'Apple iMac 24&quot; Retina 4,5K, M4 8C / 8C, 16 ГБ, 256 ГБ, Розовый', href: '/catalog/mac/imac/imac-pink/' }),
  ].join(''), next: '/catalog/mac/?PAGEN_1=2' });
  const result = parseRebroPage(html);
  assert.equal(result.total, 3);
  assert.equal(result.next, 'https://nn.rebro-store.ru/catalog/mac/?PAGEN_1=2');
  assert.equal(result.entries[2].stock, 'OutOfStock');
  assert.equal(result.offers.length, 2);
  assert.deepEqual({ model: result.offers[0].model, chip: result.offers[0].chip, cpu: result.offers[0].cpuCores, gpu: result.offers[0].gpuCores, ram: result.offers[0].ramGb, storage: result.offers[0].storageGb, color: result.offers[0].color, price: result.offers[0].price },
    { model: 'MacBook Neo 13"', chip: 'A18 Pro', cpu: 6, gpu: 5, ram: 8, storage: 256, color: 'Blush', price: 71990 });
  assert.equal(result.offers[0].evidence.ordinaryPrice, 89990);
  assert.deepEqual({ model: result.offers[1].model, chip: result.offers[1].chip, cpu: result.offers[1].cpuCores, gpu: result.offers[1].gpuCores, color: result.offers[1].color },
    { model: 'MacBook Air 13"', chip: 'M5', cpu: 10, gpu: 8, color: 'Midnight' });
  assert.ok(result.offers.every(offer => offer.retailer === 'Rebro' && offer.sourceCity === 'Нижний Новгород' && offer.stock === 'InStock'));
});

test('walks every Rebro catalogue page and verifies total coverage', async () => {
  const pages = new Map([
    [root, page({ total: 2, cards: card({ id: 1, title: 'Apple MacBook Pro 14&quot; (M5, 10C / 10C, 2025) 16 ГБ, 512 ГБ SSD, чёрный космос', href: '/catalog/mac/macbook-pro/pro-black/', amount: '188 990' }), next: '/catalog/mac/?PAGEN_1=2' })],
    [`${root}?PAGEN_1=2`, page({ total: 2, cards: card({ id: 2, title: 'Apple Mac mini M4 (10C / 10C, 2024) 16 ГБ, 256 ГБ SSD', href: '/catalog/mac/mac-mini/mini/', amount: '74 990' }) })],
  ]);
  const result = await fetchRebroOffers({ fetchPage: async url => pages.get(url) });
  assert.equal(result.offers.length, 1);
  assert.deepEqual(result.stats, { catalogPagesFetched: 2, catalogCards: 2, supportedProducts: 1, priced: 1, inStock: 1, preOrder: 0, outOfStock: 0 });
  const loopPage = page({ total: 2, cards: card({ id: 2, title: 'Apple Mac mini M4 (10C / 10C, 2024) 16 ГБ, 256 ГБ SSD', href: '/catalog/mac/mac-mini/mini/', amount: '74 990' }), next: '/catalog/mac/?PAGEN_1=2' });
  await assert.rejects(fetchRebroOffers({ fetchPage: async url => url === root ? pages.get(root) : loopPage }), /pagination loop/);
  await assert.rejects(fetchRebroOffers({ fetchPage: async url => url === root ? pages.get(root) : page({ total: 3, cards: card({ id: 2, title: 'Apple Mac mini M4 (10C \/ 10C, 2024) 16 ГБ, 256 ГБ SSD', href: '/catalog/mac/mac-mini/mini/', amount: '74 990' }) }) }), /total changed/);
});

test('rejects unsafe pagination, duplicate ids and malformed current prices', async () => {
  const duplicate = page({ total: 2, cards: card({ id: 1, title: 'Apple MacBook Air 13&quot; (M5, 10C / 8C, 2026) 16 ГБ, 512 ГБ SSD, Серебристый', href: '/catalog/mac/macbook-air/air/', amount: '140 990' }), next: '/catalog/mac/?PAGEN_1=2' });
  await assert.rejects(fetchRebroOffers({ fetchPage: async () => duplicate }), /duplicate product id/);
  assert.throws(() => parseRebroPage(page({ total: 1, cards: card({ id: 1, title: 'Apple MacBook Air 13&quot; (M5, 10C / 8C, 2026) 16 ГБ, 512 ГБ SSD, Серебристый', href: '/catalog/mac/macbook-air/air/', amount: 'по запросу' }) })), /invalid current price/);
  assert.throws(() => parseRebroPage(page({ total: 1, cards: card({ id: 1, title: 'Apple MacBook Air 13&quot; (M5, 10C / 8C, 2026) 16 ГБ, 512 ГБ SSD, Серебристый', href: '/catalog/mac/macbook-air/air/', amount: '140 990' }), next: 'https://evil.test/catalog/mac/?PAGEN_1=2' })), /outside/);
});
