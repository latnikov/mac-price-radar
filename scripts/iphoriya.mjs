import { parseProduct } from './offer-normalization.mjs';

const ORIGIN = 'https://iphoriya.ru';
const CATEGORY_SLUGS = new Set(['macbook-air', 'macbook-pro', 'macbook-neo']);

async function jsonResponse(value, url) {
  if (typeof value === 'string') return { data: JSON.parse(value), headers: null };
  if (!value?.ok) throw new Error(`HTTP ${value?.status || 'error'}: ${url}`);
  return { data: await value.json(), headers: value.headers };
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`Iphoriya incomplete crawl: invalid ${label}`);
  return number;
}

function productOffer(product) {
  if (!Number.isInteger(product?.id) || !product.name || !product.permalink) throw new Error('Iphoriya incomplete crawl: malformed product');
  const url = new URL(product.permalink);
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/product/')) throw new Error('Iphoriya incomplete crawl: unsafe product URL');
  const prices = product.prices || {};
  if (prices.currency_code !== 'RUB' || !/^\d+$/.test(String(prices.price || ''))) throw new Error(`Iphoriya incomplete crawl: invalid price for product ${product.id}`);
  const minorUnit = Number(prices.currency_minor_unit);
  if (!Number.isInteger(minorUnit) || minorUnit < 0 || minorUnit > 2) throw new Error(`Iphoriya incomplete crawl: invalid currency unit for product ${product.id}`);
  const amount = Number(prices.price) / 10 ** minorUnit;
  const offer = parseProduct(product.name, url.href, 'Айфория', amount, undefined, {
    externalId: `iphoriya:${product.id}`,
    stock: product.is_in_stock === true ? 'InStock' : product.is_in_stock === false ? 'OutOfStock' : 'unknown',
    rawPrice: prices.price,
    evidence: { method: 'woocommerce-store-api-v1', productId: product.id, rawPrice: prices.price, currencyMinorUnit: minorUnit },
  });
  if (!offer) throw new Error(`Iphoriya incomplete crawl: unrecognized product ${product.id}`);
  return offer;
}

export async function fetchIphoriyaOffers({ fetchPage = url => fetch(url), pageSize = 100, maxPages = 10 } = {}) {
  const categoryUrl = `${ORIGIN}/wp-json/wc/store/v1/products/categories?per_page=100`;
  const categoryResponse = await jsonResponse(await fetchPage(categoryUrl), categoryUrl);
  if (!Array.isArray(categoryResponse.data)) throw new Error('Iphoriya incomplete crawl: malformed categories');
  const categories = categoryResponse.data.filter(category => CATEGORY_SLUGS.has(category.slug));
  if (categories.length !== CATEGORY_SLUGS.size || new Set(categories.map(category => category.slug)).size !== CATEGORY_SLUGS.size) throw new Error('Iphoriya incomplete crawl: MacBook categories are missing');
  const expectedTotal = categories.reduce((sum, category) => sum + Number(category.count || 0), 0);
  const categoryIds = categories.map(category => positiveInteger(category.id, 'category id')).sort((a, b) => a - b);
  const products = [];
  let total, totalPages;
  for (let page = 1; page <= (totalPages || 1); page += 1) {
    if (page > maxPages) throw new Error(`Iphoriya incomplete crawl: more than ${maxPages} pages`);
    const url = new URL(`${ORIGIN}/wp-json/wc/store/v1/products`);
    url.searchParams.set('category', categoryIds.join(','));
    url.searchParams.set('per_page', String(pageSize));
    url.searchParams.set('page', String(page));
    const response = await jsonResponse(await fetchPage(url.href), url.href);
    if (!Array.isArray(response.data)) throw new Error('Iphoriya incomplete crawl: malformed products');
    const reportedTotal = response.headers ? positiveInteger(response.headers.get('x-wp-total'), 'product total') : response.data.length;
    const reportedPages = response.headers ? positiveInteger(response.headers.get('x-wp-totalpages'), 'page total') : 1;
    if (total == null) { total = reportedTotal; totalPages = reportedPages; }
    else if (total !== reportedTotal || totalPages !== reportedPages) throw new Error('Iphoriya incomplete crawl: catalogue total changed during refresh');
    products.push(...response.data);
  }
  if (!products.length || products.length !== total || expectedTotal !== total) throw new Error(`Iphoriya incomplete crawl: received ${products.length} of ${total || expectedTotal}`);
  if (new Set(products.map(product => product.id)).size !== products.length) throw new Error('Iphoriya incomplete crawl: duplicate product id');
  const offers = products.map(productOffer);
  return {
    offers,
    failures: [],
    stats: {
      protocol: 'WooCommerce Store API',
      categories: categories.length,
      catalogProducts: products.length,
      inStock: offers.filter(offer => offer.stock === 'InStock').length,
      outOfStock: offers.filter(offer => offer.stock === 'OutOfStock').length,
    },
  };
}
