import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBigGeekIphones, fetchRetailIphones } from '../scripts/iphone-retail.mjs';
import { fetchIphoriyaOffers } from '../scripts/iphoriya.mjs';

const models = ['iPhone 18 Pro', 'iPhone 18 Pro Max', 'iPhone 17 Pro', 'iPhone 17 Pro Max'];
const slugs = new Set(models.map(model => model.toLowerCase().replaceAll(' ', '-')));
function biggeek({ title = 'Apple iPhone 18 Pro 256GB Glacier', productId = 500, variants, characteristics } = {}) {
  const data = { productId, variantCharacteristicPicker: {
    characteristics: characteristics || [{ id: 'sim', name: 'SIM', values: [{ id: 1, label: 'eSIM' }, { id: 2, label: 'nanoSIM + eSIM' }, { id: 3, label: 'eSIM + eSIM' }] }],
    variantsMatrix: variants || [
      { id: 501, valueIds: { sim: 1 }, price: '120990.00', cardprice: '145190.00', oldprice: '199990.00', isAvailable: true },
      { id: 502, valueIds: { sim: 2 }, price: '130990.00', cardprice: '157190.00', oldprice: '209990.00', isAvailable: false },
    ],
  } };
  return `<h1>${title}</h1><script id="product-properties-json" type="application/json">${JSON.stringify(data)}</script><div class="price">99990</div>`;
}
const biggeekUrl = 'https://biggeek.ru/products/apple-iphone-18-pro-256gb-glacier';

test('BigGeek reads every requested iPhone model with each own current cash price and exact SIM configuration', () => {
  for (const [index, model] of models.entries()) {
    const offers = parseBigGeekIphones(biggeek({ title: `Apple ${model} 256GB Silver`, productId: 500 + index }), biggeekUrl);
    assert.deepEqual(offers.map(offer => [offer.model, offer.storageGb, offer.color, offer.simType, offer.price, offer.stock]), [
      [model, 256, 'Silver', 'eSIM', 120990, 'InStock'], [model, 256, 'Silver', 'SIM + eSIM', 130990, 'OutOfStock'],
    ]);
    assert.deepEqual(offers.map(offer => offer.sourceVariantId), ['501', '502']);
    assert.deepEqual(offers.map(offer => new URL(offer.url).searchParams.get('variation_id')), ['501', '502']);
    assert.ok(offers.every(offer => offer.sourceProductId === String(500 + index) && offer.paymentMethod === 'cash' && offer.priceType === 'full'));
    assert.ok(offers.every(offer => ![99990, 145190, 157190, 199990, 209990].includes(offer.price)));
  }
  const [electronic] = parseBigGeekIphones(biggeek({ variants: [{ id: 503, valueIds: { sim: 3 }, price: '120990.25', isNoOrder: true }] }), biggeekUrl);
  assert.equal(electronic.simType, 'eSIM');
  assert.equal(electronic.priceMinor, 12099025);
  assert.equal(electronic.stock, 'PreOrder');
});

test('BigGeek rejects missing, duplicate and ambiguous phone options and invalid current prices', () => {
  const variant = { id: 501, valueIds: { sim: 1 }, price: '120990', isAvailable: true };
  for (const invalidPrice of ['', '0', '-1', 'free', '120990.001']) assert.throws(() => parseBigGeekIphones(biggeek({ variants: [{ ...variant, price: invalidPrice }] }), biggeekUrl), /unrecognized phone variant|invalid.*price/i);
  assert.throws(() => parseBigGeekIphones(biggeek({ variants: [variant, variant] }), biggeekUrl), /duplicate phone variant/);
  assert.throws(() => parseBigGeekIphones(biggeek({ variants: [{ ...variant, id: 'invalid' }] }), biggeekUrl), /variant id/);
  assert.throws(() => parseBigGeekIphones(biggeek({ variants: [{ ...variant, valueIds: { sim: 999 } }] }), biggeekUrl), /missing selected phone option/);
  assert.throws(() => parseBigGeekIphones(biggeek({ characteristics: [{ id: 'sim', name: 'SIM', values: [{ id: 1, label: 'unknown' }] }] }), biggeekUrl), /missing phone SIM type/);
  assert.throws(() => parseBigGeekIphones(biggeek({ characteristics: [{ id: 'sim', name: 'Bundle', values: [{ id: 1, label: 'Standard' }] }] }), biggeekUrl), /unsupported phone option/);
  assert.throws(() => parseBigGeekIphones(biggeek({ productId: 'invalid' }), biggeekUrl), /product id|parent id/i);
  assert.throws(() => parseBigGeekIphones('<h1>iPhone 18 Pro 256GB</h1><script id="product-properties-json">{bad json}</script>', biggeekUrl), /invalid phone variant JSON/);
});

test('BigGeek ignores accessories and iPhone families outside the requested scope', () => {
  for (const title of ['Чехол iPhone 18 Pro 256GB', 'Case iPhone 17 Pro Max 256GB', 'Защитное стекло iPhone 17 Pro 256GB', 'Apple iPhone 16 Pro 256GB', 'Apple iPhone 18 256GB']) assert.deepEqual(parseBigGeekIphones(biggeek({ title }), biggeekUrl), [], title);
});

const response = (data, headers = {}) => new Response(JSON.stringify(data), { headers });
function iphoriyaFixture(overrides = {}) {
  const categories = models.map((model, index) => ({ id: 700 + index, slug: model.toLowerCase().replaceAll(' ', '-'), count: 1 }));
  const variations = new Map();
  const parents = models.map((model, index) => {
    const id = 100 + index;
    const ids = [901 + index * 100, 902 + index * 100];
    for (const [variantIndex, variantId] of ids.entries()) variations.set(variantId, {
      id: variantId, parent: id, type: 'variation', name: `Apple ${model} 256GB Silver`,
      variation: variantIndex ? 'SIM: nanoSIM + eSIM' : 'SIM: eSIM',
      permalink: `https://iphoriya.ru/product/${model.toLowerCase().replaceAll(' ', '-')}-256gb-silver/?attribute_pa_sim=${variantIndex ? 'sim-esim' : 'esim'}`,
      prices: { currency_code: 'RUB', currency_minor_unit: 2, price: variantIndex ? '13099025' : '12099025', regular_price: '19999000' },
      is_in_stock: variantIndex === 0,
    });
    return { id, type: 'variable', name: `Apple ${model} 256GB Silver`,
      permalink: `https://iphoriya.ru/product/${model.toLowerCase().replaceAll(' ', '-')}-256gb-silver/`,
      prices: { currency_code: 'RUB', currency_minor_unit: 2, price: '99900', price_range: { min_amount: '99900', max_amount: '13099025' } },
      variations: ids.map(id => ({ id })), is_in_stock: true,
    };
  });
  const fetched = [];
  const fetchPage = async url => {
    fetched.push(url);
    if (url.includes('/products/categories')) return response(overrides.categories || categories);
    const parsed = new URL(url), match = parsed.pathname.match(/\/products\/(\d+)$/);
    if (match) {
      const variant = variations.get(Number(match[1]));
      return response(overrides.variant ? overrides.variant({ ...variant }, Number(match[1])) : variant);
    }
    assert.equal(parsed.searchParams.get('category'), '700,701,702,703');
    return response(overrides.parents || parents, { 'x-wp-total': '4', 'x-wp-totalpages': '1' });
  };
  return { fetchPage, fetched, parents, variations, categories };
}

test('Iphoriya fetches native phone variation endpoints, keeps IDs, and never uses the parent minimum', async () => {
  const fixture = iphoriyaFixture();
  const result = await fetchIphoriyaOffers({ fetchPage: fixture.fetchPage, categorySlugs: slugs });
  assert.equal(result.offers.length, 8);
  assert.equal(result.stats.catalogProducts, 4);
  assert.equal(fixture.fetched.filter(url => /\/products\/\d+$/.test(url)).length, 8);
  for (const model of models) {
    const offers = result.offers.filter(offer => offer.model === model);
    assert.deepEqual(new Set(offers.map(offer => offer.simType)), new Set(['eSIM', 'SIM + eSIM']));
    assert.deepEqual(new Set(offers.map(offer => offer.price)), new Set([120990.25, 130990.25]));
    assert.ok(offers.every(offer => offer.sourceVariantId !== offer.sourceProductId && offer.externalId === `iphoriya:${offer.sourceVariantId}`));
    assert.ok(offers.every(offer => offer.price !== 999));
    assert.ok(offers.every(offer => new URL(offer.url).searchParams.get('attribute_pa_sim')));
  }
});

test('Iphoriya refuses mismatched variation IDs, parents, ranged prices and missing SIM data', async () => {
  for (const change of [variant => ({ ...variant, id: variant.id + 1 }), variant => ({ ...variant, parent: variant.parent + 1 }), variant => ({ ...variant, type: 'simple' }), variant => ({ ...variant, prices: { ...variant.prices, price_range: { min_amount: '1', max_amount: '2' } } })]) {
    const fixture = iphoriyaFixture({ variant: change });
    await assert.rejects(fetchIphoriyaOffers({ fetchPage: fixture.fetchPage, categorySlugs: slugs }), /variant identity mismatch/);
  }
  const noSim = iphoriyaFixture({ variant: variant => ({ ...variant, variation: '' }) });
  await assert.rejects(fetchIphoriyaOffers({ fetchPage: noSim.fetchPage, categorySlugs: slugs }), /missing phone SIM variant/);
  const invalidPrice = iphoriyaFixture({ variant: variant => ({ ...variant, prices: { ...variant.prices, price: '120990.001' } }) });
  await assert.rejects(fetchIphoriyaOffers({ fetchPage: invalidPrice.fetchPage, categorySlugs: slugs }), /invalid price/);
  const fractionalUnit = iphoriyaFixture({ variant: variant => ({ ...variant, prices: { ...variant.prices, currency_minor_unit: 3 } }) });
  await assert.rejects(fetchIphoriyaOffers({ fetchPage: fractionalUnit.fetchPage, categorySlugs: slugs }), /invalid currency unit/);
  const fixture = iphoriyaFixture();
  fixture.parents[0].variations = [fixture.parents[0].variations[0], fixture.parents[0].variations[0]];
  await assert.rejects(fetchIphoriyaOffers({ fetchPage: fixture.fetchPage, categorySlugs: slugs }), /duplicate phone variant/);
});

test('retail iPhone entry point uses native Iphoriya variants for all four phone families', async () => {
  const fixture = iphoriyaFixture();
  const result = await fetchRetailIphones('Айфория', { fetchPage: fixture.fetchPage });
  assert.equal(result.offers.length, 8);
  assert.deepEqual(new Set(result.offers.map(offer => offer.model)), new Set(models));
});
