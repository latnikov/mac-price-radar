import { decode, parseProduct, price } from './offer-normalization.mjs';

const origin = 'https://madstore.ru';
const catalogUrl = `${origin}/macbook`;
const apiOrigin = 'https://store.tildaapi.com';

async function responseText(response, url) {
  if (typeof response === 'string') return response;
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}: ${url}`);
  if (response.url && new URL(response.url).origin !== new URL(url).origin) throw new Error('Madstore redirected outside the requested site');
  return response.text();
}

async function responsePayload(response, url) {
  if (response && typeof response === 'object' && !('ok' in response)) return response;
  const text = await responseText(response, url);
  try { return JSON.parse(text); }
  catch { throw new Error('Madstore incomplete crawl: invalid Tilda catalogue JSON'); }
}

function safeCategoryUrl(value) {
  let url;
  try { url = new URL(decode(value), catalogUrl); }
  catch { return null; }
  if (url.origin !== origin || url.username || url.password || !/^\/macbook(?:-[^/]+)?\/?$/.test(url.pathname)) return null;
  url.hash = '';
  url.search = '';
  return url.pathname.replace(/\/$/, '') === '/macbook' ? null : url.href;
}

export function discoverMadstoreCategoryUrls(html) {
  const urls = new Set();
  for (const match of String(html).matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    const url = safeCategoryUrl(match[2]);
    if (url) urls.add(url);
  }
  if (!urls.size) throw new Error('Madstore incomplete crawl: MacBook category links not found');
  return [...urls];
}

export function discoverMadstoreStoreParts(html) {
  const references = [];
  for (const match of String(html).matchAll(/\bvar\s+options\s*=\s*\{\s*recid\s*:\s*['"](\d+)['"][\s\S]{0,2500}?\bstorepart\s*:\s*['"](\d+)['"]/gi)) {
    references.push({ recid: match[1], storepartuid: match[2] });
  }
  const unique = [...new Map(references.map(reference => [`${reference.recid}:${reference.storepartuid}`, reference])).values()];
  if (!unique.length) throw new Error('Madstore incomplete crawl: Tilda catalogue reference not found');
  return unique;
}

function characteristic(product, names) {
  const wanted = names.map(name => name.toLocaleLowerCase('ru-RU'));
  const item = (product.characteristics || []).find(entry => wanted.includes(decode(entry?.title).toLocaleLowerCase('ru-RU')));
  return decode(item?.value);
}

function gigabytes(value, label) {
  const match = decode(value).match(/^(\d+)\s*(TB|ТБ|GB|ГБ)$/i);
  if (!match) throw new Error(`Madstore product has invalid ${label}`);
  return Number(match[1]) * (/^(?:TB|ТБ)$/i.test(match[2]) ? 1000 : 1);
}

function positiveCore(value, type) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 64) throw new Error(`Madstore product has invalid ${type} core count`);
  return number;
}

function canonicalChip(title, processor) {
  const source = `${decode(title)} ${decode(processor)}`.replace(/М(?=\d)/gi, 'M');
  const match = source.match(/\b(A18\s+Pro|M\d+(?:\s+(?:Pro|Max|Ultra))?)\b/i);
  if (!match) throw new Error('Madstore product has no recognizable chip');
  return match[1].replace(/\s+/g, ' ');
}

function canonicalProductTitle(product) {
  const rawTitle = decode(product.title);
  const family = rawTitle.match(/\bMacBook\s+(Air|Pro|Neo)\b/i)?.[1];
  const diagonal = characteristic(product, ['Диагональ дисплея', 'Диагональ']);
  const titleScreen = Number(rawTitle.match(/MacBook\s+(?:Air|Pro|Neo)\s+(\d{2})/i)?.[1]);
  const characteristicScreen = Math.trunc(Number(diagonal.match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(',', '.')));
  const screen = titleScreen || characteristicScreen;
  if (!family || ![13, 14, 15, 16].includes(screen)) throw new Error(`Madstore unrecognized MacBook model: ${rawTitle}`);
  const chip = canonicalChip(rawTitle, characteristic(product, ['Процессор']));
  const characteristicRam = gigabytes(characteristic(product, ['Оперативная память']), 'RAM');
  const characteristicStorage = gigabytes(characteristic(product, ['Объем памяти', 'Объём памяти']), 'storage');
  const titleMemory = rawTitle.match(/(\d+)\s*(TB|ТБ|GB|ГБ)\s*\/\s*(\d+)\s*(?:GB|ГБ)\b/i);
  const titleStorage = titleMemory ? Number(titleMemory[1]) * (/^(?:TB|ТБ)$/i.test(titleMemory[2]) ? 1000 : 1) : null;
  const titleRam = titleMemory ? Number(titleMemory[3]) : null;
  const ram = titleRam || characteristicRam;
  const storage = titleStorage || characteristicStorage;
  const titleCpu = Number(rawTitle.match(/(\d+)\s*(?:-\s*)?CPU\b/i)?.[1]);
  const titleGpu = Number(rawTitle.match(/(\d+)\s*(?:-\s*)?GPU\b/i)?.[1]);
  const characteristicCpu = positiveCore(characteristic(product, ['Core CPU']) || titleCpu, 'CPU');
  const characteristicGpu = positiveCore(characteristic(product, ['Core GPU']) || titleGpu, 'GPU');
  const cpu = titleCpu || characteristicCpu;
  const gpu = titleGpu || characteristicGpu;
  const color = characteristic(product, ['Цвет']) || decode(product.sku).replace(/^Цвет\s*:\s*/i, '');
  if (!color) throw new Error('Madstore product has no color');
  const qualityWarnings = [];
  if (titleScreen && characteristicScreen && titleScreen !== characteristicScreen) qualityWarnings.push(`Конфликт диагонали у Madstore: заголовок ${titleScreen}, характеристика ${characteristicScreen}`);
  if (titleRam && titleRam !== characteristicRam) qualityWarnings.push(`Конфликт RAM у Madstore: заголовок ${titleRam} GB, характеристика ${characteristicRam} GB`);
  if (titleStorage && titleStorage !== characteristicStorage) qualityWarnings.push(`Конфликт SSD у Madstore: заголовок ${titleStorage} GB, характеристика ${characteristicStorage} GB`);
  if (titleCpu && titleCpu !== characteristicCpu) qualityWarnings.push(`Конфликт CPU у Madstore: заголовок ${titleCpu}, характеристика ${characteristicCpu}`);
  if (titleGpu && titleGpu !== characteristicGpu) qualityWarnings.push(`Конфликт GPU у Madstore: заголовок ${titleGpu}, характеристика ${characteristicGpu}`);
  return { title: `MacBook ${family} ${screen}" ${chip} RAM ${ram}GB SSD ${storage}GB ${cpu}-core CPU ${gpu}-core GPU ${color}`, qualityWarnings };
}

function safeProductUrl(value, editionUid) {
  let url;
  try { url = new URL(String(value || ''), catalogUrl); }
  catch { throw new Error('Madstore product has invalid URL'); }
  if (url.origin !== origin || url.username || url.password || !url.pathname.startsWith('/macbook') || !url.pathname.includes('/tproduct/')) {
    throw new Error('Madstore product URL is outside the MacBook catalogue');
  }
  url.hash = '';
  url.search = '';
  url.searchParams.set('editionuid', String(editionUid));
  return url.href;
}

function cashEdition(product) {
  const editions = Array.isArray(product.editions) ? product.editions : [];
  const cash = editions.filter(edition => decode(edition?.['Способ оплаты']).toLocaleLowerCase('ru-RU') === 'наличными');
  if (cash.length !== 1) throw new Error(`Madstore product ${product.uid ?? 'unknown'} must have exactly one cash-price edition`);
  return cash[0];
}

export function parseMadstoreProducts(products, { fetchedAt = new Date().toISOString(), sections = new Map() } = {}) {
  if (!Array.isArray(products)) throw new Error('Madstore incomplete crawl: products payload is not an array');
  const offers = [];
  const productIds = new Set();
  for (const product of products) {
    const productId = String(product?.uid ?? '').trim();
    if (!/^\d+$/.test(productId)) throw new Error('Madstore product has invalid id');
    if (productIds.has(productId)) throw new Error(`Madstore duplicate product id: ${productId}`);
    productIds.add(productId);
    const edition = cashEdition(product);
    const editionUid = String(edition?.uid ?? '').trim();
    if (!/^\d+$/.test(editionUid)) throw new Error(`Madstore product ${productId} has invalid cash edition id`);
    const amount = price(edition.price);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Madstore product ${productId} has invalid cash price`);
    const canonical = canonicalProductTitle(product);
    const url = safeProductUrl(product.url, editionUid);
    const quantity = String(edition.quantity ?? product.quantity ?? '').trim();
    const stock = quantity === '0' ? 'OutOfStock' : /^\d+$/.test(quantity) ? 'InStock' : 'source_reported';
    const offer = parseProduct(canonical.title, url, 'Madstore', amount, fetchedAt, {
      externalId: `madstore:${productId}`,
      sourceVariantId: 'cash',
      sourceProductId: productId,
      sourceEditionId: editionUid,
      sourceCity: 'Нижний Новгород',
      sourceSite: 'madstore.ru',
      rawPrice: edition.price,
      condition: 'new',
      region: 'unknown',
      keyboard: 'unknown',
      displayType: 'standard',
      bundle: 'standard',
      priceType: 'full',
      paymentMethod: 'cash',
      buyerType: 'retail',
      minimumQuantity: 1,
      stock,
      qualityWarnings: canonical.qualityWarnings,
      evidence: {
        method: 'tilda-store-api-v1',
        catalogPage: catalogUrl,
        categoryPages: sections.get(productId) || [],
        sourceProductTitle: product.title,
        sourceProductUid: productId,
        sourceEdition: edition,
        sourceCharacteristics: product.characteristics || [],
        priceMeaning: 'Цена при оплате наличными',
        availabilityMeaning: 'Позиция опубликована в каталоге; магазин просит уточнять наличие',
      },
    });
    if (!offer) throw new Error(`Madstore unrecognized MacBook ${productId}: ${product.title}`);
    offers.push(offer);
  }
  return offers;
}

function productsEndpoint(reference, slice, size) {
  const url = new URL('/api/getproductslist/', apiOrigin);
  url.searchParams.set('storepartuid', reference.storepartuid);
  url.searchParams.set('recid', reference.recid);
  url.searchParams.set('size', String(size));
  url.searchParams.set('slice', String(slice));
  url.searchParams.set('getparts', 'true');
  url.searchParams.set('getoptions', 'true');
  url.searchParams.set('flag_root', 'withroot');
  return url.href;
}

function productSignature(product) {
  const edition = cashEdition(product);
  return JSON.stringify([product.title, product.sku, product.url, edition.uid, edition.price, edition.quantity, product.characteristics]);
}

/** Loads every current MacBook product from every catalogue section linked by Madstore. */
export async function fetchMadstoreOffers({ fetchPage = url => fetch(url), pageSize = 100, maxCategoryPages = 20, maxStoreParts = 30, maxSlices = 20 } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('Madstore pageSize must be between 1 and 100');
  const rootHtml = await responseText(await fetchPage(catalogUrl), catalogUrl);
  const categoryUrls = discoverMadstoreCategoryUrls(rootHtml);
  if (categoryUrls.length > maxCategoryPages) throw new Error(`Madstore incomplete crawl: more than ${maxCategoryPages} category pages`);
  const references = [];
  for (const url of categoryUrls) {
    const html = await responseText(await fetchPage(url), url);
    for (const reference of discoverMadstoreStoreParts(html)) references.push({ ...reference, categoryUrl: url });
  }
  const uniqueReferences = [...new Map(references.map(reference => [`${reference.recid}:${reference.storepartuid}`, reference])).values()];
  if (uniqueReferences.length > maxStoreParts) throw new Error(`Madstore incomplete crawl: more than ${maxStoreParts} catalogue sections`);

  const products = new Map();
  const sections = new Map();
  let apiPagesFetched = 0;
  let sectionProducts = 0;
  for (const reference of uniqueReferences) {
    let total = null;
    const sectionIds = new Set();
    for (let slice = 1; slice <= maxSlices; slice += 1) {
      const url = productsEndpoint(reference, slice, pageSize);
      const payload = await responsePayload(await fetchPage(url), url);
      if (!Array.isArray(payload.products)) throw new Error('Madstore incomplete crawl: products payload is not an array');
      const reportedTotal = Number(payload.total);
      if (!Number.isInteger(reportedTotal) || reportedTotal < 0 || reportedTotal > pageSize * maxSlices) throw new Error('Madstore incomplete crawl: invalid product total');
      if (total === null) total = reportedTotal;
      else if (total !== reportedTotal) throw new Error('Madstore incomplete crawl: product total changed during refresh');
      apiPagesFetched += 1;
      let added = 0;
      for (const product of payload.products) {
        const id = String(product?.uid ?? '').trim();
        if (!/^\d+$/.test(id)) throw new Error('Madstore incomplete crawl: product without valid id');
        if (sectionIds.has(id)) throw new Error(`Madstore duplicate product id inside catalogue section: ${id}`);
        sectionIds.add(id);
        const previous = products.get(id);
        if (previous && productSignature(previous) !== productSignature(product)) throw new Error(`Madstore conflicting copies of product ${id}`);
        if (!previous) products.set(id, product);
        const pages = sections.get(id) || [];
        if (!pages.includes(reference.categoryUrl)) pages.push(reference.categoryUrl);
        sections.set(id, pages);
        added += 1;
      }
      if (sectionIds.size >= total) break;
      if (!payload.products.length || !added) throw new Error('Madstore incomplete crawl: catalogue pagination stopped early');
    }
    if (sectionIds.size !== total) throw new Error(`Madstore incomplete crawl: received ${sectionIds.size} of ${total} products in section ${reference.storepartuid}`);
    sectionProducts += total;
  }
  const fetchedAt = new Date().toISOString();
  const offers = parseMadstoreProducts([...products.values()], { fetchedAt, sections });
  if (!offers.length) throw new Error('Madstore incomplete crawl: no priced MacBook products discovered');
  return {
    offers,
    failures: [],
    stats: {
      catalogPagesFetched: 1 + categoryUrls.length,
      categoryPages: categoryUrls.length,
      catalogueSections: uniqueReferences.length,
      apiPagesFetched,
      sectionProducts,
      duplicatePlacements: sectionProducts - products.size,
      uniqueProducts: products.size,
      variants: offers.length,
    },
  };
}
