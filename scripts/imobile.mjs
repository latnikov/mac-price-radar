import { crawlQueue } from './crawl-queue.mjs';
import { decode, parseProduct, price } from './offer-normalization.mjs';

const origin = 'https://imobile.market';
const rootUrl = `${origin}/mac`;

function macbookUrl(value, pageUrl) {
  try {
    // Every catalogue page declares <base href="https://imobile.market/">.
    // Resolving against the current nested URL would turn `cart` into a fake
    // /mac/.../cart page and make a complete crawl fail on its 404 response.
    const url = new URL(decode(value).replace(/&amp;/gi, '&').replace(/&#38;/g, '&'), `${origin}/`);
    if (url.origin !== origin || url.username || url.password) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'mac' || !segments.some(segment => /macbook/i.test(segment))) return null;
    url.hash = '';
    url.search = '';
    return url.href;
  } catch { return null; }
}

export function discoverImobileLinks(html, pageUrl = rootUrl) {
  const source = String(html).replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const links = new Set();
  for (const match of source.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
    const url = macbookUrl(match[2], pageUrl);
    if (url) links.add(url);
  }
  return [...links];
}

function productArray(html) {
  const match = String(html).match(/\bconst\s+products\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!match) return null;
  let products;
  try { products = JSON.parse(match[1]); }
  catch { throw new Error('invalid products JSON'); }
  if (!Array.isArray(products)) throw new Error('products payload is not an array');
  return products;
}

function normalizedVariantTitle(product) {
  let title = decode(product.title)
    .replace(/\bА18\b/gi, 'A18')
    .replace(/(\d+)\s*[TТ][BВБ]\b/gi, '$1TB')
    .replace(/(\d+)\s*C\s*\/\s*(\d+)\s*C\b/gi, '$1-Core CPU / $2-Core GPU')
    .replace(/(\d+)\s*-?\s*Core(?=\s*[,/]\s*GPU\b)/gi, '$1-Core CPU');
  if (/MacBook\s+Neo/i.test(title) && !/\b\d+\s*(?:GB|ГБ)\s*(?:RAM|ОЗУ)\b/i.test(title)) title += ' 8GB RAM';
  return title;
}

export function parseImobileProducts(html, pageUrl) {
  const products = productArray(html);
  if (products === null) return [];
  const offers = [];
  for (const product of products) {
    const externalId = String(product?.id ?? '').trim();
    const amount = price(product?.price);
    const title = normalizedVariantTitle(product || {});
    if (!externalId) throw new Error('product variant without id');
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`variant ${externalId} has invalid price`);
    const offer = parseProduct(title, pageUrl, 'iMobile', amount, undefined, {
      externalId,
      sourceVariantId: externalId,
      sourceProductCode: String(product.code_model || '').trim() || null,
      sourceCity: 'Нижний Новгород',
      sourceSite: 'imobile.market',
      rawPrice: String(product.price),
      condition: 'new',
      region: 'unknown',
      keyboard: 'unknown',
      displayType: 'standard',
      bundle: 'standard',
      priceType: 'full',
      paymentMethod: 'cash',
      buyerType: 'retail',
      minimumQuantity: 1,
      stock: 'source_reported',
      evidence: {
        method: 'imobile-products-array-v1',
        productPage: pageUrl,
        sourceVariant: product,
        priceMeaning: 'Стоимость без карты лояльности',
      },
    });
    if (!offer) throw new Error(`unrecognized product configuration for variant ${externalId}: ${title}`);
    offers.push({ ...offer, model: offer.model.replace(/^Macbook\b/i, 'MacBook') });
  }
  return offers;
}

/** Crawls the current MacBook catalogue and fails rather than publishing a partial refresh. */
export async function fetchImobileOffers({ fetchPage = url => fetch(url), maxPages = 100 } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('iMobile maxPages must be between 1 and 100');
  const seen = new Set([rootUrl]);
  const byVariant = new Map();
  const stats = { pagesFetched: 0, productPages: 0, variants: 0 };
  const enqueue = (url, add) => {
    if (seen.has(url)) return;
    if (seen.size >= maxPages) throw new Error(`iMobile incomplete crawl: more than ${maxPages} pages discovered`);
    seen.add(url);
    add(url);
  };
  await crawlQueue([rootUrl], async (url, add) => {
    try {
      const response = await fetchPage(url);
      let html;
      if (typeof response === 'string') html = response;
      else {
        if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
        if (response.url && new URL(response.url).origin !== origin) throw new Error('redirect outside iMobile');
        html = await response.text();
      }
      const offers = parseImobileProducts(html, url);
      stats.pagesFetched += 1;
      if (offers.length) stats.productPages += 1;
      for (const offer of offers) {
        const prior = byVariant.get(offer.externalId);
        if (prior && (prior.url !== offer.url || prior.price !== offer.price || prior.title !== offer.title)) throw new Error(`iMobile variant ${offer.externalId} is inconsistent across pages`);
        byVariant.set(offer.externalId, offer);
      }
      for (const next of discoverImobileLinks(html, url)) enqueue(next, add);
    } catch (error) { throw new Error(`iMobile incomplete crawl: ${url}: ${error.message}`); }
  });
  const offers = [...byVariant.values()];
  if (!offers.length) throw new Error('iMobile incomplete crawl: no priced MacBook variants discovered');
  stats.variants = offers.length;
  return { offers, stats };
}
