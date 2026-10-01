import { load } from 'cheerio';
import { parseProduct, price } from './offer-normalization.mjs';
import { iphoneModel, iphoneSim } from './iphone.mjs';
import { extractProductPrice } from './structured-price.mjs';
import { crawlQueue } from './crawl-queue.mjs';
import { fetchIphoriyaOffers } from './iphoriya.mjs';
import { fetchImobileOffers } from './imobile.mjs';
import { fetchAppleStoreOffers } from './apple-store-nn.mjs';
import { fetchRebroOffers } from './rebro.mjs';
import { fetchHitappleOffers } from './hitapple.mjs';
import { productOffer } from './technichno.mjs';

export const IPHONE_RETAILERS = new Set(['BigGeek', 'Айфория', 'Technichno', 'iMobile', 'Apple Store', 'Rebro', 'HitApple', 'ReSale', 'Madstore', 'Smart Device', 'AFM']);
const phoneSlugs = new Set(['iphone-18-pro', 'iphone-18-pro-max', 'iphone-17-pro', 'iphone-17-pro-max']);
async function read(response, url) {
  if (typeof response === 'string') return response;
  if (!response?.ok) throw new Error(`HTTP ${response?.status || 'error'}: ${url}`);
  if (response.url && new URL(response.url).origin !== new URL(url).origin) throw new Error('iPhone catalogue redirected outside requested store');
  return response.text();
}

export function parseBigGeekIphones(html, pageUrl) {
  const $ = load(String(html));
  const title = $('h1').first().text().trim();
  if (!iphoneModel(title) || /чехол|case\b|стекло|защит|запчаст|кабел/i.test(title)) return [];
  const text = $('#product-properties-json').text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error('BigGeek invalid phone variant JSON'); }
  const picker = data?.variantCharacteristicPicker;
  if (!picker?.variantsMatrix?.length) {
    const extracted = extractProductPrice(String(html), pageUrl);
    if (extracted.error) throw new Error(extracted.error);
    const offer = parseProduct(extracted.title, pageUrl, 'BigGeek', extracted.amount, undefined, extracted.metadata);
    if (!offer) throw new Error('BigGeek unrecognized phone configuration');
    return [offer];
  }
  const ids = new Set();
  if (!/^\d+$/.test(String(data.productId || ''))) throw new Error('BigGeek invalid phone parent product id');
  return picker.variantsMatrix.map(variant => {
    const id = String(variant.id || '');
    if (!/^\d+$/.test(id) || ids.has(id)) throw new Error('BigGeek invalid or duplicate phone variant id');
    ids.add(id);
    const labels = [];
    for (const axis of picker.characteristics || []) {
      if (!/SIM/i.test(axis.name)) throw new Error(`BigGeek unsupported phone option: ${axis.name}`);
      const value = axis.values?.find(value => String(value.id) === String(variant.valueIds?.[axis.id]));
      if (!value) throw new Error('BigGeek missing selected phone option');
      labels.push(value.label || value.name);
    }
    const simType = iphoneSim(labels.join(' '));
    if (simType === 'unknown') throw new Error('BigGeek missing phone SIM type');
    const url = new URL(pageUrl); url.searchParams.set('variation_id', id);
    const offer = parseProduct(`${title} ${labels.join(' ')}`, url.href, 'BigGeek', price(variant.price), undefined, {
      externalId: `biggeek:${data.productId}:${id}`, sourceProductId: String(data.productId), sourceVariantId: id,
      simType, condition: 'new', priceType: 'full', paymentMethod: 'cash', buyerType: 'retail', minimumQuantity: 1,
      stock: variant.isNoOrder ? 'PreOrder' : variant.isAvailable === true ? 'InStock' : 'OutOfStock',
      evidence: { method: 'biggeek-phone-variants-v1', sourceProductTitle: title, sourceVariant: variant,
        priceMeaning: 'Цена выбранного варианта без доплаты за оплату картой' },
    });
    if (!offer) throw new Error(`BigGeek unrecognized phone variant ${id}`);
    return offer;
  });
}

async function fetchBigGeekIphones({ fetchPage, maxPages = 200 }) {
  const origin = 'https://biggeek.ru';
  const roots = ['/catalog/iphone_18_pro', '/catalog/iphone_18_pro_max', '/catalog/apple-iphone-17-pro', '/catalog/apple-iphone-17-pro-max'].map(path => origin + path);
  const offers = [], seen = new Set(roots), products = new Set();
  await crawlQueue(roots.map(url => ({ url, product: false })), async (item, add) => {
    const html = await read(await fetchPage(item.url), item.url), $ = load(html);
    if (item.product) { offers.push(...parseBigGeekIphones(html, item.url)); return; }
    const cards = $('a.catalog-card__title[href]');
    if (!cards.length) throw new Error('BigGeek incomplete iPhone catalogue: no product cards');
    cards.each((_, anchor) => {
      if (!iphoneModel($(anchor).text()) || /чехол|case\b|стекло|защит|запчаст|кабел/i.test($(anchor).text())) return;
      const url = new URL($(anchor).attr('href'), origin);
      if (url.origin !== origin || !url.pathname.startsWith('/products/') || url.username || url.password) throw new Error('BigGeek unsafe phone product URL');
      url.hash = ''; url.search = '';
      products.add(url.href);
      if (!seen.has(url.href)) { if (seen.size >= maxPages) throw new Error('BigGeek iPhone page limit reached'); seen.add(url.href); add({ url: url.href, product: true }); }
    });
    $('a[href],link[rel="next"]').each((_, anchor) => {
      const raw = $(anchor).attr('href'); if (!raw) return;
      const url = new URL(raw, item.url), current = new URL(item.url);
      if (url.origin !== origin || url.pathname !== current.pathname || !/^\d+$/.test(url.searchParams.get('page') || '')) return;
      const page = url.searchParams.get('page'); url.search = ''; url.searchParams.set('page', page); url.hash = '';
      if (!seen.has(url.href)) { if (seen.size >= maxPages) throw new Error('BigGeek iPhone page limit reached'); seen.add(url.href); add({ url: url.href, product: false }); }
    });
  });
  if (!offers.length || !products.size) throw new Error('BigGeek no priced iPhone variants');
  return { offers, failures: [], stats: { pagesFetched: seen.size, products: products.size, variants: offers.length } };
}

async function fetchTechnichnoIphones({ fetchPage, maxPages = 300 }) {
  const origin = 'https://nn.technichno.ru';
  const roots = [...phoneSlugs].map(slug => `${origin}/catalog/iphone/${slug}/`);
  const offers = [], seen = new Set(roots), products = new Set();
  await crawlQueue(roots.map(url => ({ url, product: false })), async (item, add) => {
    const html = await read(await fetchPage(item.url), item.url), $ = load(html);
    if (item.product) offers.push(productOffer(html, item.url));
    $('a[href],link[rel="next"]').each((_, anchor) => {
      const url = new URL($(anchor).attr('href'), item.url);
      const parts = url.pathname.split('/').filter(Boolean);
      if (url.origin !== origin || url.username || url.password || parts[0] !== 'catalog' || parts[1] !== 'iphone' || !phoneSlugs.has(parts[2])) return;
      const product = parts.length >= 4;
      if (product) { url.search = ''; url.hash = ''; products.add(url.href); }
      else {
        const params = [...url.searchParams].filter(([k, v]) => /^(PAGEN_\d+|page)$/.test(k) && /^\d+$/.test(v));
        url.search = ''; for (const [k, v] of params) url.searchParams.set(k, v);
      }
      url.hash = '';
      if (!seen.has(url.href)) { if (seen.size >= maxPages) throw new Error('Technichno iPhone page limit reached'); seen.add(url.href); add({ url: url.href, product }); }
    });
  });
  if (!offers.length) throw new Error('Technichno no priced iPhone products');
  return { offers, failures: [], stats: { pagesFetched: seen.size, products: products.size, variants: offers.length } };
}

export async function fetchRetailIphones(retailer, options = {}) {
  options = { fetchPage: url => fetch(url, { signal: AbortSignal.timeout(20000) }), ...options };
  let result;
  if (retailer === 'BigGeek') result = await fetchBigGeekIphones(options);
  else if (retailer === 'Technichno') result = await fetchTechnichnoIphones(options);
  else if (retailer === 'Айфория') result = await fetchIphoriyaOffers({ ...options, categorySlugs: phoneSlugs });
  else if (retailer === 'iMobile') result = await fetchImobileOffers({ ...options, catalogueUrl: 'https://imobile.market/iphone' });
  else if (retailer === 'Apple Store') result = await fetchAppleStoreOffers({ ...options, catalogueUrl: 'https://nn.stores-apple.com/catalog/iphones/' });
  else if (retailer === 'Rebro') result = await fetchRebroOffers({ ...options, catalogueUrl: 'https://nn.rebro-store.ru/catalog/iphone/' });
  else if (retailer === 'HitApple') result = await fetchHitappleOffers({ ...options, catalogueUrl: 'https://hitapple.ru/category/iphone/', maxPages: options.maxPages || 100 });
  else if (['ReSale', 'Madstore', 'Smart Device', 'AFM'].includes(retailer)) {
    const { fetchTildaIphones } = await import('./iphone-tilda.mjs');
    result = await fetchTildaIphones(retailer, options);
  } else throw new Error(`Unsupported iPhone retailer: ${retailer}`);
  return { ...result, offers: result.offers.filter(offer => iphoneModel(offer.model)) };
}
