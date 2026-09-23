import { decode, parseProduct, price } from './offer-normalization.mjs';

const origin = 'https://resale52.ru';
const catalogUrl = `${origin}/mac`;
const apiOrigin = 'https://store.tildaapi.com';

async function responseText(response, url) {
  if (typeof response === 'string') return response;
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}: ${url}`);
  return response.text();
}

export function discoverResale52Store(html) {
  const match = String(html).match(/\bvar\s+options\s*=\s*\{\s*recid\s*:\s*['"](\d+)['"][\s\S]{0,2500}?\bstorepart\s*:\s*['"](\d+)['"]/i);
  if (!match) throw new Error('ReSale incomplete crawl: Tilda catalogue reference not found');
  return { recid: match[1], storepartuid: match[2] };
}

function safeProductUrl(value, editionUid) {
  let url;
  try { url = new URL(String(value || ''), catalogUrl); }
  catch { throw new Error('MacBook product has invalid URL'); }
  if (url.origin !== origin || !url.pathname.startsWith('/mac/') || url.username || url.password) throw new Error('MacBook product URL is outside ReSale catalogue');
  url.hash = '';
  url.search = '';
  if (editionUid) url.searchParams.set('editionuid', String(editionUid));
  return url.href;
}

function editionField(edition, names) {
  for (const name of names) {
    const key = Object.keys(edition || {}).find(candidate => candidate.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'));
    if (key && String(edition[key]).trim()) return decode(edition[key]);
  }
  return '';
}

function variantTitle(product, edition) {
  let title = decode(product.title).replace(/\s*,\s*/g, ' ');
  if (/^MacBook\s+Neo\b/i.test(title)) title = 'MacBook Neo 13 A18 Pro 6-core CPU / 5-core GPU';
  const memory = editionField(edition, ['Память', 'Memory']);
  let color = editionField(edition, ['Цвет', 'Color']);
  const cores = editionField(edition, ['Количество ядер', 'Cores']);
  if (/^MacBook\s+Pro\b/i.test(title) && /^Black$/i.test(color)) color = 'Space Black';
  return [title, memory, color, cores].filter(Boolean).join(' ');
}

function parsePayload(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value)); }
  catch { throw new Error('ReSale incomplete crawl: invalid Tilda catalogue JSON'); }
}

export function parseResale52Products(value, { fetchedAt = new Date().toISOString(), storepartuid = null } = {}) {
  const payload = parsePayload(value);
  if (!Array.isArray(payload.products)) throw new Error('ReSale incomplete crawl: products payload is not an array');
  const offers = [];
  const externalIds = new Set();
  for (const product of payload.products) {
    if (!/^MacBook\s+(?:Air|Pro|Neo)\b/i.test(decode(product?.title))) continue;
    const editions = Array.isArray(product.editions) && product.editions.length ? product.editions : [product];
    for (const edition of editions) {
      const editionUid = String(edition?.uid ?? '').trim();
      const externalId = String(edition?.externalid ?? editionUid ?? '').trim();
      if (!externalId) throw new Error(`ReSale MacBook product ${product.uid ?? 'unknown'} has a variant without id`);
      if (externalIds.has(externalId)) throw new Error(`ReSale duplicate MacBook variant id: ${externalId}`);
      externalIds.add(externalId);
      const rawPrice = String(edition?.price || product?.price || '').trim();
      const amount = price(rawPrice);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error(`ReSale variant ${externalId} has invalid price`);
      const title = variantTitle(product, edition);
      const url = safeProductUrl(product.url, editionUid && edition !== product ? editionUid : null);
      const quantity = String(edition?.quantity ?? product?.quantity ?? '').trim();
      const offer = parseProduct(title, url, 'ReSale', amount, fetchedAt, {
        externalId,
        sourceVariantId: editionUid || externalId,
        sourceProductId: String(product.uid ?? '').trim() || null,
        sourceCity: 'Нижний Новгород',
        sourceSite: 'resale52.ru',
        rawPrice,
        condition: 'new',
        region: 'unknown',
        keyboard: 'unknown',
        displayType: 'standard',
        bundle: 'standard',
        priceType: 'full',
        paymentMethod: 'cash',
        buyerType: 'retail',
        minimumQuantity: 1,
        stock: quantity === '0' ? 'OutOfStock' : 'source_reported',
        evidence: {
          method: 'tilda-store-api-v1',
          catalogPage: catalogUrl,
          storepartuid: storepartuid ? String(storepartuid) : null,
          sourceProductTitle: product.title,
          sourceProductUid: product.uid,
          sourceVariant: edition,
          priceMeaning: 'Цена со скидкой за наличный расчёт',
        },
      });
      if (!offer) throw new Error(`ReSale unrecognized MacBook variant ${externalId}: ${title}`);
      offers.push(offer);
    }
  }
  return offers;
}

function productsEndpoint({ recid, storepartuid }, slice, size) {
  const url = new URL('/api/getproductslist/', apiOrigin);
  url.searchParams.set('storepartuid', storepartuid);
  url.searchParams.set('recid', recid);
  url.searchParams.set('size', String(size));
  url.searchParams.set('slice', String(slice));
  url.searchParams.set('getparts', 'true');
  url.searchParams.set('getoptions', 'true');
  url.searchParams.set('flag_root', 'withroot');
  return url.href;
}

/** Loads every current MacBook edition from the public Tilda catalogue. */
export async function fetchResale52Offers({ fetchPage = url => fetch(url), pageSize = 100, maxSlices = 20 } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('ReSale pageSize must be between 1 and 100');
  if (!Number.isInteger(maxSlices) || maxSlices < 1 || maxSlices > 50) throw new Error('ReSale maxSlices must be between 1 and 50');
  const html = await responseText(await fetchPage(catalogUrl), catalogUrl);
  const reference = discoverResale52Store(html);
  const products = [];
  const productIds = new Set();
  let total = null;
  let apiPagesFetched = 0;
  for (let slice = 1; slice <= maxSlices; slice += 1) {
    const url = productsEndpoint(reference, slice, pageSize);
    const payload = parsePayload(await responseText(await fetchPage(url), url));
    if (!Array.isArray(payload.products)) throw new Error('ReSale incomplete crawl: products payload is not an array');
    const reportedTotal = Number(payload.total);
    if (!Number.isInteger(reportedTotal) || reportedTotal < 0 || reportedTotal > pageSize * maxSlices) throw new Error('ReSale incomplete crawl: invalid product total');
    if (total === null) total = reportedTotal;
    else if (total !== reportedTotal) throw new Error('ReSale incomplete crawl: product total changed during refresh');
    apiPagesFetched += 1;
    let added = 0;
    for (const product of payload.products) {
      const id = String(product?.uid ?? '').trim();
      if (!id) throw new Error('ReSale incomplete crawl: product without id');
      if (productIds.has(id)) continue;
      productIds.add(id);
      products.push(product);
      added += 1;
    }
    if (products.length >= total) break;
    if (!payload.products.length || !added) throw new Error('ReSale incomplete crawl: catalogue pagination stopped early');
  }
  if (products.length !== total) throw new Error(`ReSale incomplete crawl: received ${products.length} of ${total} products`);
  const fetchedAt = new Date().toISOString();
  const offers = parseResale52Products({ products }, { fetchedAt, storepartuid: reference.storepartuid });
  if (!offers.length) throw new Error('ReSale incomplete crawl: no priced MacBook variants discovered');
  return {
    offers,
    stats: {
      catalogPagesFetched: 1,
      apiPagesFetched,
      products: products.length,
      macbookProducts: products.filter(product => /^MacBook\s+(?:Air|Pro|Neo)\b/i.test(decode(product.title))).length,
      variants: offers.length,
    },
  };
}
