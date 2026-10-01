import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverHitappleCategories, fetchHitappleOffers, parseHitappleVariations } from '../scripts/hitapple.mjs';

const origin = 'https://hitapple.ru';
const catalogueUrl = `${origin}/category/iphone/`;
const ajaxUrl = `${origin}/?wc-ajax=get_variation`;
const phones = [
  ['18-pro', 'iPhone 18 Pro'], ['18-pro-max', 'iPhone 18 Pro Max'],
  ['17-pro', 'iPhone 17 Pro'], ['17-pro-max', 'iPhone 17 Pro Max'],
].map(([slug, model], index) => ({ slug, model, productId: String(1100 + index), url: `${origin}/product/iphone-${slug}/` }));
const optionNames = ['attribute_pa_czvet', 'attribute_pa_obem-pamyati', 'attribute_pa_svyaz'];
const priceHtml = amount => `<span class="price"><span class="woocommerce-Price-amount"><bdi>${amount}<span class="woocommerce-Price-currencySymbol">₽</span></bdi></span></span>`;
const categoryRoot = items => `<ul class="products">${items.map(phone => `<li class="product-category"><a href="${origin}/category/iphone/${phone.slug}/"><h2 class="woocommerce-loop-category__title">${phone.model}</h2></a></li>`).join('')}</ul>`;
const selections = (color = 'silver', sim = 'esim') => ({ attribute_pa_czvet: color, 'attribute_pa_obem-pamyati': '256gb', attribute_pa_svyaz: sim });

function variantFor(phone, attributes) {
  const index = (attributes.attribute_pa_czvet === 'special' ? 2 : 0) + (attributes.attribute_pa_svyaz === 'sim-esim' ? 1 : 0);
  return { variation_id: Number(phone.productId) * 10 + index + 1, attributes, display_price: 110000 + index * 1000,
    display_regular_price: 150000, price_html: priceHtml(110000 + index * 1000), min_qty: 1,
    is_in_stock: true, is_purchasable: true, variation_is_active: true, variation_is_visible: true,
    image: { title: attributes.attribute_pa_czvet === 'special' ? 'iPhone Deep Blue' : 'iPhone Silver', url: `https://hitapple.ru/images/${attributes.attribute_pa_czvet === 'special' ? 'deep-blue' : 'silver'}.jpg` } };
}
function productHtml(phone) {
  return `<form class="variations_form" data-product_id="999" data-product_variations="[]"></form>
    <div class="summary"><h1 class="product_title">Apple ${phone.model}</h1><p>Цена указана при наличном расчёте</p>
    ${priceHtml(1)}<form class="variations_form" data-product_id="${phone.productId}" data-product_variations="false">
    <select name="attribute_pa_czvet"><option value="">Выберите цвет</option><option value="silver">Серебристый</option><option value="special">Особый цвет</option></select>
    <select name="attribute_pa_obem-pamyati"><option value="">Память</option><option value="256gb">256 GB</option></select>
    <select name="attribute_pa_svyaz"><option value="">Связь</option><option value="esim">eSIM</option><option value="sim-esim">SIM + eSIM</option></select>
    </form></div>`;
}
const selectedUrl = (phone, attributes) => {
  const url = new URL(phone.url);
  for (const name of optionNames) url.searchParams.set(name, attributes[name]);
  url.searchParams.sort();
  return url.href;
};
function categoryHtml(phone, { catalogueVariant = false, cataloguePriceDelta = 0 } = {}) {
  const attributes = selections('special', 'esim'), variant = variantFor(phone, attributes);
  return `<ul class="products"><li class="product post-${phone.productId} product-type-variable instock"><a class="woocommerce-LoopProduct-link" href="${phone.url}"><h2 class="woocommerce-loop-product__title">Apple ${phone.model}</h2></a>${priceHtml(1)}</li>
    ${catalogueVariant ? `<li class="product post-${variant.variation_id} product-type-variation instock"><a class="woocommerce-LoopProduct-link" href="${selectedUrl(phone, attributes)}"><h2 class="woocommerce-loop-product__title">${phone.model} 256GB Deep Blue eSIM</h2></a>${priceHtml(variant.display_price + cataloguePriceDelta)}</li>` : ''}</ul>`;
}
function mockStore({ catalogueVariant = false, cataloguePriceDelta = 0, mutateVariant = (_, variant) => variant } = {}) {
  const calls = [];
  const fetchPage = async (url, options) => {
    if (url === ajaxUrl) {
      assert.equal(options?.method, 'POST');
      assert.ok(options.body instanceof URLSearchParams);
      const body = Object.fromEntries(options.body);
      const phone = phones.find(item => item.productId === body.product_id);
      assert.ok(phone, `Unknown AJAX product: ${body.product_id}`);
      assert.deepEqual(Object.keys(body).sort(), ['product_id', ...optionNames].sort());
      const attributes = Object.fromEntries(optionNames.map(name => [name, body[name]]));
      calls.push({ url, productId: phone.productId, attributes });
      return JSON.stringify(mutateVariant(phone, variantFor(phone, attributes)));
    }
    calls.push({ url });
    if (url === catalogueUrl) return categoryRoot(phones);
    const category = phones.find(phone => url === `${origin}/category/iphone/${phone.slug}/`);
    if (category) return categoryHtml(category, { catalogueVariant, cataloguePriceDelta });
    const product = phones.find(phone => url === phone.url);
    if (product) return productHtml(product);
    assert.fail(`Unexpected page: ${url}`);
  };
  return { fetchPage, calls };
}

test('HitApple iPhone discovery requires all four exact category models', () => {
  assert.deepEqual(discoverHitappleCategories(categoryRoot(phones), { phones: true }), phones.map(phone => `${origin}/category/iphone/${phone.slug}/`));
  assert.throws(() => discoverHitappleCategories(categoryRoot(phones.slice(1)), { phones: true }), /expected all requested categories/);
  assert.throws(() => discoverHitappleCategories(categoryRoot(phones).replace('iPhone 18 Pro Max', 'iPhone 17 Pro Max'), { phones: true }), /title does not match/);
});

test('HitApple AJAX resolves three explicit options for each phone and ignores unrelated forms and parent prices', async () => {
  const store = mockStore({ catalogueVariant: true, mutateVariant: (phone, variant) => phone.slug === '18-pro-max'
    && variant.attributes.attribute_pa_czvet === 'silver' && variant.attributes.attribute_pa_svyaz === 'sim-esim' ? false : variant });
  const result = await fetchHitappleOffers({ catalogueUrl, fetchPage: store.fetchPage });
  assert.equal(result.stats.catalogPagesFetched, 5); assert.equal(result.stats.productPagesFetched, 4);
  assert.equal(result.offers.length, 15); assert.equal(result.stats.variants, 15);
  assert.deepEqual([...new Set(result.offers.map(offer => offer.model))].sort(), phones.map(phone => phone.model).sort());
  assert.deepEqual([...new Set(result.offers.map(offer => offer.simType))].sort(), ['SIM + eSIM', 'eSIM']);
  assert.deepEqual([...new Set(result.offers.map(offer => offer.color))].sort(), ['Deep Blue', 'Silver']);
  assert.ok(result.offers.every(offer => offer.storageGb === 256 && offer.price >= 110000 && offer.price <= 113000
    && offer.paymentMethod === 'cash' && offer.condition === 'new' && offer.priceType === 'full' && offer.keyboard === 'not_applicable'
    && offer.ramGb === null && offer.sourceVariantId && offer.stock === 'InStock'));
  assert.equal(new Set(result.offers.map(offer => offer.externalId)).size, 15);
  const lookups = store.calls.filter(call => call.url === ajaxUrl);
  assert.equal(lookups.length, 16);
  for (const phone of phones) assert.equal(lookups.filter(call => call.productId === phone.productId).length, 4);
  for (const offer of result.offers) {
    assert.equal(offer.url, selectedUrl(phones.find(phone => phone.productId === offer.sourceProductId), offer.evidence.sourceVariantAttributes));
  }
});

test('HitApple AJAX rejects response attributes that do not match requested options', async () => {
  const store = mockStore({ mutateVariant: (_, variant) => ({ ...variant, attributes: { ...variant.attributes, 'attribute_pa_obem-pamyati': '512gb' } }) });
  await assert.rejects(fetchHitappleOffers({ catalogueUrl, fetchPage: store.fetchPage }), /AJAX phone variation selection mismatch/);
});

test('HitApple rejects rendered-price mismatches and catalogue/variation price inconsistencies', async () => {
  const phone = phones[0], attributes = selections();
  const variant = variantFor(phone, attributes);
  assert.throws(() => parseHitappleVariations(productHtml(phone), phone.url, { expectedProductId: phone.productId,
    variants: [{ ...variant, price_html: priceHtml(variant.display_price + 1) }] }), /variant price differs from rendered RUB price/);
  assert.throws(() => parseHitappleVariations(productHtml(phone), phone.url, { expectedProductId: phone.productId,
    variants: [{ ...variant, attributes: { ...attributes, attribute_pa_czvet: '' } }] }), /wildcard variant attribute/);
  const store = mockStore({ catalogueVariant: true, cataloguePriceDelta: 1 });
  await assert.rejects(fetchHitappleOffers({ catalogueUrl, fetchPage: store.fetchPage }), /differs between catalogue and product page/);
});
