import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSmartDeviceCategories, discoverSmartDeviceStoreParts, fetchSmartDeviceOffers, parseSmartDeviceProducts } from '../scripts/smart-device.mjs';
import { calculateRetailAnalytics } from '../web/retail-analytics.js';

const product = (overrides = {}) => ({
  uid: 100,
  title: 'MacBook Air 13 Early 2026 MDHH4 M5 10-core, GPU 8-core, 16GB, 512GB, Sky Bluе',
  url: 'https://smart-device.shop/mac-air/tproduct/1-100-macbook-air',
  price: '134900.0000', priceold: '161900.0000', quantity: '',
  editions: [{ uid: 101, price: '134 900.00', quantity: '', 'Объем памяти': '512' }],
  characteristics: [{ title: 'Цвет', value: 'Sky Bluе' }],
  ...overrides,
});
const neo = product({ uid: 200, title: 'MacBook Neo 13 Early 2026 MHFH4 A18 Pro 6-core, GPU 5-core, 8GB, 256GB, Blush',
  url: 'https://smart-device.shop/macbook-neo/tproduct/2-200-macbook-neo', characteristics: [],
  editions: [{ uid: 200, price: '72900.0000', priceold: '81000', quantity: '0' }],
});
const store = (id, part) => `<script>var options={recid:'${id}',storepart:'${part}'};</script>`;

test('discovers all Mac families, ignores off-site links and finds every store block', () => {
  const html = '<a href="/mac-air">Air</a><a href="/mac-pro">Pro</a><a href="/macbook-neo">Neo</a><a href="/imac">iMac</a><a href="/mac-mini">mini</a><a href="/mac-air/?foo=1">duplicate</a><a href="https://evil.test/mac-air">bad</a><a href="/mac-air/tproduct/1-2-product">product</a>';
  assert.equal(discoverSmartDeviceCategories(html).length, 5);
  assert.deepEqual(discoverSmartDeviceStoreParts(store(1, 11) + store(2, 22) + store(1, 11)), [{recid:'1',storepartuid:'11'}, {recid:'2',storepartuid:'22'}]);
  assert.throws(() => discoverSmartDeviceCategories('<a href="/iphone">iPhone</a>'), /links not found/);
  assert.throws(() => discoverSmartDeviceStoreParts('maintenance'), /reference not found/);
});

test('uses current edition prices, normalizes Tilda decimals and mixed-script Sky Blue', () => {
  const offers = parseSmartDeviceProducts([product(), neo], { fetchedAt: '2026-09-26T10:00:00Z' });
  assert.deepEqual(offers.map(o => [o.model, o.chip, o.ramGb, o.storageGb, o.cpuCores, o.gpuCores, o.color, o.price, o.stock]), [
    ['MacBook Air 13"', 'M5', 16, 512, 10, 8, 'Sky Blue', 134900, 'source_reported'],
    ['MacBook Neo 13"', 'A18 Pro', 8, 256, 6, 5, 'Blush', 72900, 'OutOfStock'],
  ]);
  assert.equal(new URL(offers[0].url).searchParams.get('editionuid'), '101');
  assert.ok(offers.every(o => o.retailer === 'Smart Device' && o.sourceCity === 'Нижний Новгород' && o.paymentMethod === 'cash' && o.priceType === 'full'));
});

test('preserves each edition configuration and never falls back to the parent minimum', () => {
  const offers = parseSmartDeviceProducts([product({ editions: [
    {uid:101,price:'134900.0000', 'Объем памяти':'512'},
    {uid:102,price:'158900.0000', 'Объем памяти':'1024', 'Цвет':'Silver'},
    {uid:103,price:'173900.0000', 'Память':'24/1TB', 'Цвет':'Midnight'},
  ] })]);
  assert.deepEqual(offers.map(o => [o.ramGb,o.storageGb,o.color,o.price]), [[16,512,'Sky Blue',134900],[16,1000,'Silver',158900],[24,1000,'Midnight',173900]]);
  assert.equal(new Set(offers.map(o => o.externalId)).size, 3);
  assert.throws(() => parseSmartDeviceProducts([product({editions:[{uid:101,price:''}]})]), /invalid current price/);
});

test('includes iMac and Mac mini without inventing screens or mixing old prices', () => {
  const mini = product({title:'Apple Mac mini Late 2024 MCX44 M4 Pro 12-core, GPU 16-core, 24GB, 512GB',url:'https://smart-device.shop/mac-mini/tproduct/1-100-mini',characteristics:[{title:'Цвет',value:'Silver'}],editions:[{uid:101,price:'177900.0000',quantity:'2'}]});
  const imac = product({uid:300,title:'Apple iMac 24 Late 2023 M3 8-core, GPU 10-core, 8GB, 256GB, Blue',url:'https://smart-device.shop/imac/tproduct/1-300-imac',characteristics:[],editions:[] ,price:'147400.0000',quantity:'1'});
  const offers=parseSmartDeviceProducts([mini,imac]);
  assert.deepEqual(offers.map(o=>[o.model,o.chip,o.screenIn,o.color,o.price,o.stock]), [['Mac mini','M4 Pro',null,'Silver',177900,'InStock'],['iMac 24','M3',24,'Blue',147400,'InStock']]);
});

function fixture(payloads) {
  return async url => {
    if (url === 'https://smart-device.shop/mac') return '<a href="/mac-air">Air</a><a href="/macbook-neo">Neo</a>';
    if (url === 'https://smart-device.shop/mac-air') return store(1,11);
    if (url === 'https://smart-device.shop/macbook-neo') return store(2,22);
    const u=new URL(url); assert.equal(u.origin,'https://store.tildaapi.com');
    return JSON.stringify(payloads.get(`${u.searchParams.get('storepartuid')}:${u.searchParams.get('slice')}`));
  };
}

test('fetches every section and page, deduplicates placements and keeps category evidence', async () => {
  const fetchPage=fixture(new Map([['11:1',{total:2,products:[product()]}],['11:2',{total:2,products:[neo]}],['22:1',{total:1,products:[neo]}]]));
  const result=await fetchSmartDeviceOffers({fetchPage,pageSize:1});
  assert.equal(result.offers.length,2);
  assert.equal(result.stats.apiPagesFetched,3);
  assert.equal(result.stats.uniqueProducts,2);
  assert.equal(result.stats.duplicatePlacements,1);
  assert.equal(result.offers.find(o=>o.sourceProductId==='200').evidence.categoryPages.length,2);
});

test('fails closed on truncated, repeated, changing and conflicting catalogue pages', async () => {
  for (const [second, pattern] of [
    [{total:2,products:[]}, /pagination stopped early/],
    [{total:2,products:[product()]}, /repeated product/],
    [{total:3,products:[neo]}, /total changed/],
  ]) {
    const fetchPage=fixture(new Map([['11:1',{total:2,products:[product()]}],['11:2',second],['22:1',{total:0,products:[]}]]));
    await assert.rejects(fetchSmartDeviceOffers({fetchPage,pageSize:1}),pattern);
  }
  const fetchPage=fixture(new Map([['11:1',{total:1,products:[product()]}],['22:1',{total:1,products:[product({price:'99999.0000'})]}]]));
  await assert.rejects(fetchSmartDeviceOffers({fetchPage}),/conflicting product/);
});

test('rejects unsafe URLs, invalid prices and duplicate variants', () => {
  for (const value of ['0','free','72900.0001','72.900','']) assert.throws(()=>parseSmartDeviceProducts([product({editions:[{uid:101,price:value}]})]),/invalid current price/);
  assert.throws(()=>parseSmartDeviceProducts([product({url:'https://evil.test/mac-air/tproduct/1-100-air'})]),/outside/);
  assert.throws(()=>parseSmartDeviceProducts([product(),product()]),/duplicate product/);
});

test('Smart Device prices contribute to the Nizhny retail analytics', () => {
  const analytics=calculateRetailAnalytics([{retailer:'Дима',price:100000,stock:'source_reported'}, {retailer:'Smart Device',price:134900,stock:'source_reported'}]);
  assert.equal(analytics.retailCount,1);
  assert.equal(analytics.benchmark.retailer,'Smart Device');
});


test('selects cash variants and rejects a product with no cash price', () => {
  const cash = {uid:101,price:'134900.0000', 'Способ оплаты':'Наличными'};
  const card = {uid:102,price:'161880.0000', 'Способ оплаты':'Банковской картой'};
  assert.deepEqual(parseSmartDeviceProducts([product({editions:[cash,card]})]).map(o=>o.price),[134900]);
  assert.throws(()=>parseSmartDeviceProducts([product({editions:[card]})]),/no cash-price/);
});
