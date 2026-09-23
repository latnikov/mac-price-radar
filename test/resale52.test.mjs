import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverResale52Store, fetchResale52Offers, parseResale52Products } from '../scripts/resale52.mjs';

const catalogue = `<script>var options={recid:'836850532',storepart:'750854905322',size:36};t_store_init('836850532',options);</script>`;
const product = (overrides = {}) => ({
  uid: 100,
  title: 'MacBook Air 13, M5',
  url: 'https://resale52.ru/mac/macbook-air/macbook-air-13-m5',
  price: '99 990.00',
  editions: [
    { uid: 101, externalid: 'air-silver', price: '130 990.00', quantity: '', 'Память': '16/512Gb', 'Цвет': 'Silver' },
    { uid: 102, externalid: 'air-black', price: '149 990.00', quantity: '0', 'Память': '16/1Tb', 'Цвет': 'Midnight' },
  ],
  ...overrides,
});

test('discovers the current Tilda catalogue identifiers without hardcoding them', () => {
  assert.deepEqual(discoverResale52Store(catalogue), { recid: '836850532', storepartuid: '750854905322' });
  assert.throws(() => discoverResale52Store('<h1>Mac</h1>'), /catalogue reference not found/);
});

test('parses every MacBook edition at the cash price and excludes desktop Macs', () => {
  const offers = parseResale52Products({ products: [
    product(),
    product({
      uid: 200,
      title: 'MacBook Pro 14, M5',
      url: 'https://resale52.ru/mac/macbook-pro/macbook-pro-14-m5',
      editions: [{ uid: 201, externalid: 'pro-black', price: '169 990.00', quantity: '', 'Память': '16/512Gb', 'Цвет': 'Black' }],
    }),
    product({
      uid: 300,
      title: 'MacBook Neo',
      url: 'https://resale52.ru/mac/macbook-air/macbook-neo',
      editions: [{ uid: 301, externalid: 'neo-citrus', price: '66 990.00', quantity: '', 'Память': '8/256Gb', 'Цвет': 'Citrus' }],
    }),
    { uid: 400, title: 'Mac Mini, M4', url: 'https://resale52.ru/mac/mac-mini/mac-mini-m4', price: '84 990.00', editions: [] },
  ] }, { fetchedAt: '2026-09-23T12:00:00.000Z', storepartuid: '750854905322' });
  assert.equal(offers.length, 4);
  assert.deepEqual({ model: offers[0].model, chip: offers[0].chip, ram: offers[0].ramGb, storage: offers[0].storageGb, color: offers[0].color, price: offers[0].price },
    { model: 'MacBook Air 13"', chip: 'M5', ram: 16, storage: 512, color: 'Silver', price: 130990 });
  assert.equal(new URL(offers[0].url).searchParams.get('editionuid'), '101');
  assert.equal(offers[1].stock, 'OutOfStock');
  assert.equal(offers[2].color, 'Space Black');
  assert.deepEqual({ model: offers[3].model, chip: offers[3].chip, cpu: offers[3].cpuCores, gpu: offers[3].gpuCores },
    { model: 'MacBook Neo 13"', chip: 'A18 Pro', cpu: 6, gpu: 5 });
  assert.ok(offers.every(offer => offer.retailer === 'ReSale' && offer.sourceCity === 'Нижний Новгород' && offer.paymentMethod === 'cash'));
  assert.ok(offers.every(offer => offer.evidence.priceMeaning === 'Цена со скидкой за наличный расчёт'));
});

test('walks every API slice and fails instead of publishing a partial catalogue', async () => {
  const pages = new Map([
    ['https://resale52.ru/mac', catalogue],
    [1, { total: 2, products: [product()] }],
    [2, { total: 2, products: [product({ uid: 300, title: 'MacBook Neo', url: 'https://resale52.ru/mac/macbook-air/macbook-neo', editions: [{ uid: 301, externalid: 'neo', price: '66 990.00', 'Память': '8/256Gb', 'Цвет': 'Citrus' }] })] }],
  ]);
  const fetchPage = async url => {
    if (url === 'https://resale52.ru/mac') return new Response(pages.get(url));
    const slice = Number(new URL(url).searchParams.get('slice'));
    assert.equal(new URL(url).hostname, 'store.tildaapi.com');
    return JSON.stringify(pages.get(slice));
  };
  const result = await fetchResale52Offers({ fetchPage, pageSize: 1 });
  assert.equal(result.offers.length, 3);
  assert.deepEqual(result.stats, { catalogPagesFetched: 1, apiPagesFetched: 2, products: 2, macbookProducts: 2, variants: 3 });
  await assert.rejects(fetchResale52Offers({ fetchPage: async url => url === 'https://resale52.ru/mac' ? catalogue : JSON.stringify({ total: 2, products: [] }), pageSize: 1 }), /pagination stopped early/);
});

test('rejects malformed, duplicated, and unrecognized MacBook variants', () => {
  assert.throws(() => parseResale52Products({ products: [product({ editions: [{ uid: 1, externalid: 'same', price: '10', 'Память': '16/512Gb', 'Цвет': 'Silver' }, { uid: 2, externalid: 'same', price: '20', 'Память': '16/1Tb', 'Цвет': 'Silver' }] })] }), /duplicate/);
  assert.throws(() => parseResale52Products('{broken'), /invalid Tilda catalogue JSON/);
  assert.throws(() => parseResale52Products({ products: [product({ editions: [{ uid: 1, externalid: 'bad', price: '', 'Память': '16/512Gb', 'Цвет': 'Silver' }], price: '' })] }), /invalid price/);
});
