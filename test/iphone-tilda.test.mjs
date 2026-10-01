import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverTildaIphoneCategories, discoverTildaIphoneParts, parseTildaIphoneProducts, fetchTildaIphones } from '../scripts/iphone-tilda.mjs';

const models = ['iPhone 18 Pro', 'iPhone 18 Pro Max', 'iPhone 17 Pro', 'iPhone 17 Pro Max'];
const cashPolicy = 'Все цены на сайте указаны со скидкой за наличный расчет';
const smartPolicy = 'при оплате по карте/ qr-коду стоимость выше на 20% от указанной';
const store = (recid, part) => `<script>var options={recid:'${recid}',storepart:'${part}'};</script>`;
function product(retailer = 'ReSale', { uid = 100, model = 'iPhone 18 Pro', ...overrides } = {}) {
  const slug = model.toLowerCase().replaceAll(' ', '-');
  const url = retailer === 'ReSale' ? `https://resale52.ru/iphone/iphone-18/${slug}`
    : retailer === 'AFM' ? `https://afmcenter.ru/shop/iphone/${slug.replace('iphone-', '')}/256gb`
    : retailer === 'Madstore' ? `https://madstore.ru/catalog/tproduct/11-${uid}-${slug}-256gb`
    : `https://smart-device.shop/iphone-18pro/tproduct/11-${uid}-${slug}-256gb`;
  return {
    uid, title: retailer === 'ReSale' ? model : `${model} 256GB`, url,
    price: '99900.0000', quantity: '',
    descr: retailer === 'AFM' ? 'Цена указана за версию sim+esim при оплате наличными.' : '',
    editions: [{ uid: uid + 1, price: '120 990.00', quantity: '',
      'Память': '256GB', 'Цвет': 'Silver', 'Версия Sim': 'eSIM',
      ...(retailer === 'Madstore' ? { 'Способ оплаты': 'Наличными' } : {}) }],
    characteristics: [], ...overrides,
  };
}
const parse = (retailer, products, options = {}) => parseTildaIphoneProducts(retailer, products, { cashPolicyVerified: true, ...options });

test('Tilda phone collectors support exactly the four requested models across all four retailers', () => {
  for (const retailer of ['ReSale', 'AFM', 'Madstore', 'Smart Device']) {
    const offers = parse(retailer, models.map((model, index) => product(retailer, { uid: 100 + index * 10, model })));
    assert.deepEqual(offers.map(offer => offer.model), models);
    assert.ok(offers.every(offer => offer.storageGb === 256 && offer.color === 'Silver' && offer.simType === 'eSIM' && offer.condition === 'new'));
    assert.ok(offers.every(offer => offer.price === 120990 && offer.paymentMethod === 'cash' && offer.sourceCity === 'Нижний Новгород'));
    assert.deepEqual(offers.map(offer => new URL(offer.url).searchParams.get('editionuid')), ['101', '111', '121', '131']);
    assert.deepEqual(parse(retailer, [product(retailer, { model: 'iPhone 17' }), product(retailer, { model: 'iPhone 16 Pro' }), product(retailer, { title: 'Чехол iPhone 18 Pro 256GB' })]), []);
  }
});

test('phone options keep separate cash prices, storage, colors and SIM versions without parent-price fallback', () => {
  const unpriced = [];
  const offers = parse('Madstore', [product('Madstore', { editions: [
    { uid: 101, price: '112990.0000', 'Способ оплаты': 'Наличными', 'Версия SIM': 'Dual eSIM', 'Цвет': 'Burgundy' },
    { uid: 102, price: '120990.0000', 'Способ оплаты': 'Наличными', 'Версия SIM': 'Sim-eSim', 'Память': '1TB', 'Цвет': 'Glacier' },
    { uid: 103, price: '134390.0000', 'Способ оплаты': 'Банковской картой', 'Версия SIM': 'Sim-eSim' },
    { uid: 104, price: '', 'Способ оплаты': 'Наличными', 'Версия SIM': 'eSIM', 'Цвет': 'Black' },
    { uid: 105, price: '0.0000', 'Способ оплаты': 'Наличными', 'Версия SIM': 'eSIM', 'Цвет': 'Silver' },
  ] })], { unpriced });
  assert.deepEqual(offers.map(offer => [offer.price, offer.storageGb, offer.color, offer.simType]), [
    [112990, 256, 'Burgundy', 'eSIM'], [120990, 1000, 'Glacier', 'SIM + eSIM'],
  ]);
  assert.equal(new Set(offers.map(offer => offer.externalId)).size, 2);
  assert.deepEqual(offers.map(offer => offer.sourceVariantId), ['101', '102']);
  assert.deepEqual(unpriced.map(offer => offer.editionId), ['104', '105']);
  assert.ok(offers.every(offer => offer.price !== 99900));
});

test('reads each retailer phone schema and cash evidence without using crossed-out prices', () => {
  const resale = parse('ReSale', [product('ReSale', { editions: [{ uid: 101, price: '133 990.00', priceold: '200000', 'Память': '2Tb', 'Цвет': 'Black', 'Версия Sim': 'Sim + Esim' }] })])[0];
  assert.deepEqual([resale.storageGb, resale.color, resale.simType, resale.price], [2000, 'Black', 'SIM + eSIM', 133990]);
  const smart = parse('Smart Device', [product('Smart Device', {
    title: 'iPhone 17 Pro Max 512GB Cosmic Orange',
    editions: [{ uid: 101, price: '114800.0000', priceold: '140100.00', Sim: 'SIM+eSIM', quantity: '1' }],
  })])[0];
  assert.deepEqual([smart.storageGb, smart.color, smart.simType, smart.price, smart.stock], [512, 'Cosmic Orange', 'SIM + eSIM', 114800, 'InStock']);
  const afm = parse('AFM', [product('AFM', { title: 'iPhone 17 Pro 256Гб', editions: [{ uid: 101, price: '101 900.00', Цвет: 'Серебристый (Silver)' }] })])[0];
  assert.deepEqual([afm.storageGb, afm.color, afm.simType, afm.price], [256, 'Silver', 'SIM + eSIM', 101900]);
  const afmEsim = parse('AFM', [product('AFM', { title: 'iPhone 18 Pro 1Тб (esim only)', descr: 'Цена указана за версию esim only при оплате наличными.', editions: [{ uid: 101, price: '199900.0000', Цвет: 'Голубой (Glacier)' }] })])[0];
  assert.deepEqual([afmEsim.storageGb, afmEsim.color, afmEsim.simType], [1000, 'Glacier', 'eSIM']);
  assert.throws(() => parseTildaIphoneProducts('ReSale', [product()]), /cash policy not confirmed/);
  assert.throws(() => parseTildaIphoneProducts('Smart Device', [product('Smart Device')]), /cash policy not confirmed/);
  assert.throws(() => parse('AFM', [product('AFM', { descr: 'Оплата кредитом' })]), /cash price not confirmed/);
  assert.throws(() => parse('Madstore', [product('Madstore', { editions: [{ uid: 101, price: '100000' }] })]), /cash-price edition not confirmed/);
});

test('preserves used, refurbished and open-box conditions including ReSale ASIS replacement phones', () => {
  const offers = parse('ReSale', [
    product('ReSale', { uid: 100, title: 'Apple iPhone 17 Pro Max Asis+', text: 'Данный iPhone не активирован. Устройство поставляется без коробки.' }),
    product('ReSale', { uid: 200, title: 'iPhone 17 Pro б/у' }),
    product('ReSale', { uid: 300, title: 'iPhone 18 Pro вскрыт' }),
    product('ReSale', { uid: 400, title: 'iPhone 18 Pro refurbished' }),
  ]);
  assert.deepEqual(offers.map(offer => offer.condition), ['open_box', 'used', 'open_box', 'refurbished']);
  assert.equal(offers[0].rawTitle, 'Apple iPhone 17 Pro Max Asis+');
  assert.equal(offers[0].evidence.sourceProductTitle, 'Apple iPhone 17 Pro Max Asis+');
});

test('validates options, prices, identities and same-site product links', () => {
  for (const rawPrice of ['free', '120990.0001', '120.990', '-100']) assert.throws(() => parse('ReSale', [product('ReSale', { editions: [{ uid: 101, price: rawPrice, Память: '256GB' }] })]), /invalid current price/);
  for (const url of ['https://evil.test/iphone/iphone-18/18-pro', 'https://x@y.resale52.ru/iphone/iphone-18/18-pro', 'https://resale52.ru/mac/macbook']) assert.throws(() => parse('ReSale', [product('ReSale', { url })]), /outside/);
  assert.throws(() => parse('ReSale', [product('ReSale', { editions: [{ uid: 101, price: '100000', Память: '256GB', Комплект: 'With accessories' }] })]), /unsupported variant option/);
  assert.throws(() => parse('ReSale', [product('ReSale', { editions: [{ uid: 101, price: '100000', Память: 'three TB' }] })]), /invalid variant memory/);
  assert.throws(() => parse('ReSale', [product(), product()]), /duplicate product/);
  assert.throws(() => parse('ReSale', [product('ReSale', { editions: [{ uid: 101, price: '100000', Память: '256GB' }, { uid: 101, price: '110000', Память: '512GB' }] })]), /duplicate edition/);
  assert.equal(parse('Madstore', [product('Madstore', { url: 'https://madstore.ru/price-iphone-se-2022/tproduct/545923055-100-iphone-17-pro-256gb' })]).length, 1);
});

test('discovers phone categories and all Tilda sections while rejecting unrelated and external links', () => {
  const madHtml = '<a href="price-iphone-18-pro">18</a><a href="/price-iphone-18-pro-max">18 Max</a><a href="/price-iphone-17-pro?x=1">17</a><a href="/price-iphone-17">base</a><a href="https://evil.test/price-iphone-17-pro-max">bad</a>';
  assert.deepEqual(discoverTildaIphoneCategories(madHtml, 'Madstore'), ['https://madstore.ru/price-iphone-18-pro', 'https://madstore.ru/price-iphone-18-pro-max', 'https://madstore.ru/price-iphone-17-pro']);
  const smartHtml = '<a href="/iphone-18pro">18</a><a href="/iphone-17promax">17 Max</a><a href="/iphone-17">base</a><a href="/iphone-16pro">old</a>';
  assert.deepEqual(discoverTildaIphoneCategories(smartHtml, 'Smart Device'), ['https://smart-device.shop/iphone-18pro', 'https://smart-device.shop/iphone-17promax']);
  assert.deepEqual(discoverTildaIphoneParts(store(1, 11) + store(2, 22) + store(1, 11), 'ReSale'), [{ recid: '1', storepartuid: '11' }, { recid: '2', storepartuid: '22' }]);
  assert.throws(() => discoverTildaIphoneCategories('<a href="/macbook">Mac</a>', 'Madstore'), /links not found/);
  assert.throws(() => discoverTildaIphoneParts('maintenance', 'AFM'), /reference not found/);
});

function resaleFixture(payloads) {
  return async url => {
    if (url === 'https://resale52.ru/iphone') return cashPolicy + store(1, 11);
    const u = new URL(url);
    assert.equal(u.origin, 'https://store.tildaapi.com');
    assert.equal(u.searchParams.get('getoptions'), 'true');
    return JSON.stringify(payloads.get(u.searchParams.get('slice')));
  };
}
test('fetches complete phone pagination and preserves unpriced variants without borrowing parent prices', async () => {
  const first = product('ReSale', { uid: 100 }), second = product('ReSale', { uid: 200, model: 'iPhone 17 Pro Max' });
  const result = await fetchTildaIphones('ReSale', { pageSize: 1, fetchPage: resaleFixture(new Map([['1', { total: 2, products: [first] }], ['2', { total: 2, products: [second] }]])) });
  assert.equal(result.offers.length, 2);
  assert.equal(result.stats.apiPagesFetched, 2);
  assert.equal(result.stats.uniqueProducts, 2);
  assert.equal(result.offers[0].evidence.categoryPages[0], 'https://resale52.ru/iphone');
  const unavailable = product('ReSale', { editions: [{ uid: 101, price: '', Память: '256GB' }] });
  const unpriced = await fetchTildaIphones('ReSale', { fetchPage: resaleFixture(new Map([['1', { total: 1, products: [unavailable] }]])) });
  assert.equal(unpriced.offers.length, 0);
  assert.equal(unpriced.unpriced.length, 1);
});

test('fails closed when phone pages repeat, totals change, pagination truncates or redirects leave the origin', async () => {
  for (const [second, pattern] of [
    [{ total: 2, products: [] }, /pagination stopped early/],
    [{ total: 2, products: [product()] }, /repeated product/],
    [{ total: 3, products: [product('ReSale', { uid: 200 })] }, /total changed/],
  ]) await assert.rejects(fetchTildaIphones('ReSale', { pageSize: 1, fetchPage: resaleFixture(new Map([['1', { total: 2, products: [product()] }], ['2', second]])) }), pattern);
  for (const total of [null, '', -1, 1.5, 99999]) await assert.rejects(fetchTildaIphones('ReSale', { fetchPage: resaleFixture(new Map([['1', { total, products: [] }]])) }), /invalid product total/);
  await assert.rejects(fetchTildaIphones('ReSale', { maxSlices: 1, pageSize: 1, fetchPage: resaleFixture(new Map([['1', { total: 2, products: [product()] }]])) }), /invalid product total/);
  await assert.rejects(fetchTildaIphones('ReSale', { fetchPage: async () => ({ ok: true, url: 'https://evil.test/iphone', text: async () => cashPolicy + store(1, 11) }) }), /redirect outside/);
});

test('fetches phone categories, deduplicates placements and detects conflicting versions', async () => {
  const fixture = conflicting => async url => {
    if (url === 'https://smart-device.shop/apple-iphone') return smartPolicy + '<a href="/iphone-18pro">18</a><a href="/iphone-17promax">17</a>';
    if (url === 'https://smart-device.shop/iphone-18pro') return store(1, 11);
    if (url === 'https://smart-device.shop/iphone-17promax') return store(2, 22);
    const u = new URL(url);
    return { total: 1, products: [product('Smart Device', { ...(conflicting && u.searchParams.get('storepartuid') === '22' ? { price: '109900.0000' } : {}) })] };
  };
  const result = await fetchTildaIphones('Smart Device', { fetchPage: fixture(false) });
  assert.equal(result.offers.length, 1);
  assert.equal(result.stats.catalogPagesFetched, 3);
  assert.equal(result.stats.apiPagesFetched, 2);
  assert.equal(result.stats.duplicatePlacements, 1);
  assert.equal(result.offers[0].evidence.categoryPages.length, 2);
  await assert.rejects(fetchTildaIphones('Smart Device', { fetchPage: fixture(true) }), /conflicting product/);
});
