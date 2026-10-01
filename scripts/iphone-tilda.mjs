import { decode, price } from './offer-normalization.mjs';
import { iphoneModel, iphoneStorage, iphoneColor, iphoneSim, parseIphone } from './iphone.mjs';
import { crawlQueue } from './crawl-queue.mjs';

const sources = {
  ReSale: { origin: 'https://resale52.ru', catalog: '/iphone', id: 'resale-iphone', cash: /цены на сайте указаны.{0,30}скидкой за наличный расчет/i },
  Madstore: { origin: 'https://madstore.ru', catalog: '/iphone', id: 'madstore-iphone', categories: /^\/price-iphone-(17|18)-pro(?:-max)?\/?$/i },
  'Smart Device': { origin: 'https://smart-device.shop', catalog: '/apple-iphone', id: 'smart-device-iphone', categories: /^\/iphone-(17|18)pro(?:max)?\/?$/i, cash: /при оплате по карте\s*\/\s*qr-коду стоимость выше на 20% от указанной/i },
  AFM: { origin: 'https://afmcenter.ru', catalog: '/shop/iphone', id: 'afm-iphone' },
};
const baseEditionKeys = new Set(['uid', 'externalid', 'sku', 'price', 'priceold', 'quantity', 'img']);
const fields = {
  storage: ['память', 'memory', 'объем памяти', 'объём памяти', 'объем памяти в gb', 'объём памяти в gb', 'storage'],
  color: ['цвет', 'color'], sim: ['sim', 'версия sim', 'тип sim', 'sim version'],
  payment: ['оплата', 'способ оплаты', 'payment'], condition: ['состояние', 'condition'], region: ['регион', 'region'],
};
const optionKeys = new Set(Object.values(fields).flat());
const fail = (retailer, message) => new Error(`${retailer} iPhone: ${message}`);
const configFor = retailer => { if (!sources[retailer]) throw fail(retailer, 'unsupported Tilda retailer'); return sources[retailer]; };
const key = value => decode(value).toLocaleLowerCase('ru-RU');
function field(object, names) {
  const entry = Object.entries(object || {}).find(([name, value]) => names.includes(key(name)) && String(value ?? '').trim());
  return entry ? decode(entry[1]) : '';
}
function characteristic(product, names) {
  return decode((product.characteristics || []).find(item => names.includes(key(item.title)))?.value);
}

async function responseText(response, url, retailer) {
  if (typeof response === 'string') return response;
  if (!response?.ok) throw fail(retailer, `HTTP ${response?.status ?? 'unknown'}: ${url}`);
  if (response.url && new URL(response.url).origin !== new URL(url).origin) throw fail(retailer, 'redirect outside requested site');
  return response.text();
}

export function discoverTildaIphoneParts(html, retailer) {
  const references = new Map();
  for (const match of String(html).matchAll(/\bvar\s+options\s*=\s*\{\s*recid\s*:\s*['"](\d+)['"][\s\S]{0,2500}?\bstorepart\s*:\s*['"](\d+)['"]/gi)) {
    references.set(`${match[1]}:${match[2]}`, { recid: match[1], storepartuid: match[2] });
  }
  if (!references.size) throw fail(retailer, 'incomplete crawl: Tilda catalogue reference not found');
  return [...references.values()];
}

export function discoverTildaIphoneCategories(html, retailer) {
  const config = configFor(retailer), urls = new Set();
  if (!config.categories) return [];
  for (const match of String(html).matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    let url;
    try { url = new URL(decode(match[2]), config.origin + config.catalog); } catch { continue; }
    if (url.origin !== config.origin || url.username || url.password || !config.categories.test(url.pathname)) continue;
    urls.add(config.origin + url.pathname.replace(/\/$/, ''));
  }
  if (!urls.size) throw fail(retailer, 'incomplete crawl: iPhone Pro category links not found');
  return [...urls];
}

function productUrl(value, editionId, retailer) {
  const config = configFor(retailer);
  let url;
  try { url = new URL(String(value || ''), config.origin + config.catalog); } catch { throw fail(retailer, 'invalid product URL'); }
  const validPath = retailer === 'ReSale' ? /^\/iphone\/[^/]+\/[^/]+\/?$/.test(url.pathname)
    : retailer === 'AFM' ? /^\/shop\/iphone\/[a-z0-9-]+(?:\/[a-z0-9-]+)?\/?$/i.test(url.pathname)
    // Madstore has older phones under /catalog or a legacy category, so the
    // public Tilda product ID and same-site origin are the stable URL boundary.
    : /^\/[a-z0-9-]+\/tproduct\/\d+-\d+-[a-z0-9-]+\/?$/i.test(url.pathname);
  if (url.origin !== config.origin || url.username || url.password || !validPath) throw fail(retailer, 'product URL outside iPhone catalogue');
  url.hash = ''; url.search = '';
  if (editionId) url.searchParams.set('editionuid', editionId);
  return url.href;
}

function condition(value) {
  if (/б\s*\/\s*у|\bused\b/i.test(value)) return 'used';
  if (/refurb|восстановлен/i.test(value)) return 'refurbished';
  if (/предактив|вскрыт|open.?box|asis\+?/i.test(value)) return 'open_box';
  return 'new';
}
function variantStorage(value, retailer, id) {
  if (!value) return null;
  const normalized = /^\d+$/.test(value) ? `${value}GB` : value;
  const result = iphoneStorage(normalized);
  if (!result) throw fail(retailer, `invalid variant memory: ${id}`);
  return result;
}
function cashVariant(product, edition, retailer, cashPolicyVerified) {
  const payment = field(edition, fields.payment);
  if (payment) return /^наличн(?:ые|ыми)$/i.test(payment);
  if (retailer === 'Madstore') throw fail(retailer, `cash-price edition not confirmed: ${product.uid}`);
  if (retailer === 'AFM') {
    if (!/цен[аы] указана.{0,140}при оплате наличными/i.test(decode(product.descr))) throw fail(retailer, `cash price not confirmed: ${product.uid}`);
    return true;
  }
  if (!cashPolicyVerified) throw fail(retailer, `cash policy not confirmed: ${product.uid}`);
  return true;
}

/** Parse only the requested Pro families, retaining every independently priced edition. */
export function parseTildaIphoneProducts(retailer, products, { fetchedAt = new Date().toISOString(), sections = new Map(), cashPolicyVerified = false, unpriced = [] } = {}) {
  const config = configFor(retailer);
  if (!Array.isArray(products)) throw fail(retailer, 'incomplete crawl: products is not an array');
  const offers = [], productIds = new Set(), editionIds = new Set();
  for (const product of products) {
    const model = iphoneModel(decode(product?.title));
    if (!model || /чехол|case\b|стекло|защит|запчаст|кабел/i.test(decode(product.title))) continue;
    const productId = String(product.uid ?? '');
    if (!/^\d+$/.test(productId) || productIds.has(productId)) throw fail(retailer, 'invalid or duplicate product id');
    productIds.add(productId);
    const baseUrl = productUrl(product.url, null, retailer);
    const editions = Array.isArray(product.editions) && product.editions.length ? product.editions : [product];
    let cashVariants = 0;
    for (const edition of editions) {
      const editionId = String(edition.uid ?? '');
      const id = `${config.id}:${productId}:${editionId}`;
      if (!/^\d+$/.test(editionId) || editionIds.has(id)) throw fail(retailer, 'invalid or duplicate edition id');
      editionIds.add(id);
      if (edition !== product && Object.keys(edition).some(name => !baseEditionKeys.has(name) && !optionKeys.has(key(name)))) throw fail(retailer, `unsupported variant option: ${editionId}`);
      if (!cashVariant(product, edition, retailer, cashPolicyVerified)) continue;
      cashVariants++;
      const url = productUrl(baseUrl, editionId, retailer);
      const rawPrice = String(edition.price ?? '').trim();
      if (!rawPrice || /^0(?:[.,]0+)?$/.test(rawPrice)) { unpriced.push({ externalId: id, productId, editionId, url, title: product.title }); continue; }
      const amount = price(rawPrice.replace(/([.,]\d{2})00$/, '$1'));
      if (!Number.isFinite(amount) || amount <= 0) throw fail(retailer, `invalid current price: ${editionId}`);
      const rawTitle = decode(product.title);
      const storage = variantStorage(field(edition, fields.storage), retailer, editionId) || iphoneStorage(rawTitle)
        || variantStorage(characteristic(product, fields.storage), retailer, editionId);
      if (!storage) throw fail(retailer, `missing phone memory: ${editionId}`);
      const colorValue = field(edition, fields.color) || characteristic(product, fields.color) || rawTitle;
      const color = iphoneColor(colorValue, model);
      const simValue = field(edition, fields.sim) || rawTitle;
      let simType = iphoneSim(simValue);
      if (simType === 'unknown' && retailer === 'AFM') simType = iphoneSim(decode(product.descr));
      const sourceCondition = field(edition, fields.condition) || rawTitle;
      const quantity = String(edition.quantity ?? product.quantity ?? '').trim();
      const stock = quantity === '' ? 'source_reported' : /^\d+(?:\.0+)?$/.test(quantity) ? Number(quantity) > 0 ? 'InStock' : 'OutOfStock' : 'unknown';
      const storageLabel = storage >= 1000 ? `${storage / 1000}TB` : `${storage}GB`;
      const title = [model, storageLabel, color !== 'unknown' ? color : '', simType !== 'unknown' ? simType : ''].filter(Boolean).join(' ');
      const qualityWarnings = [];
      const characteristicModel = iphoneModel(characteristic(product, ['модель', 'model']));
      if (characteristicModel && characteristicModel !== model) qualityWarnings.push('Конфликт модели между заголовком и характеристиками магазина');
      const offer = parseIphone(title, url, retailer, amount, fetchedAt, {
        externalId: id, sourceProductId: productId, sourceVariantId: editionId, sourceEditionId: editionId,
        sourceCity: 'Нижний Новгород', sourceSite: new URL(config.origin).hostname,
        rawPrice, rawTitle, condition: condition(sourceCondition), region: field(edition, fields.region) || 'unknown',
        displayType: 'standard', bundle: 'standard', priceType: 'full', paymentMethod: 'cash', buyerType: 'retail', minimumQuantity: 1, stock, simType, qualityWarnings,
        evidence: { method: 'tilda-store-api-v1', catalogPage: config.origin + config.catalog,
          categoryPages: sections.get(productId) || [], sourceProductTitle: product.title,
          sourceVariant: edition, sourceCharacteristics: product.characteristics || [],
          sourceDescription: decode(product.descr), sourceText: decode(product.text),
          priceMeaning: 'Цена выбранной конфигурации при оплате наличными; без стоимости оплаты картой и дополнительных опций',
          availabilityMeaning: 'Публикация в каталоге; наличие и стоимость магазин просит уточнять' },
      });
      if (!offer) throw fail(retailer, `unrecognized phone configuration: ${editionId}`);
      // Keep the original source title separately from the assembled edition title.
      offer.rawTitle = rawTitle;
      offers.push(offer);
    }
    if (!cashVariants) throw fail(retailer, `no cash-price variant: ${productId}`);
  }
  return offers;
}

function productsEndpoint(reference, slice, size) {
  const url = new URL('https://store.tildaapi.com/api/getproductslist/');
  for (const [name, value] of Object.entries({ ...reference, slice, size, getparts: 'true', getoptions: 'true', flag_root: 'withroot' })) url.searchParams.set(name, String(value));
  return url.href;
}
function productSignature(product) {
  return JSON.stringify([product.title, product.url, product.price, product.quantity, product.editions, product.characteristics, product.descr, product.text]);
}

/** Fetch every Tilda catalogue page for the four requested iPhone Pro families. */
export async function fetchTildaIphones(retailer, { fetchPage = url => fetch(url, { signal: AbortSignal.timeout(20000) }), fetchedAt = new Date().toISOString(), pageSize = 100, maxSlices = 20, maxCategoryPages = 20, maxStoreParts = 40 } = {}) {
  const config = configFor(retailer);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(maxSlices) || maxSlices < 1 || maxSlices > 50) throw fail(retailer, 'invalid pagination limits');
  const catalogUrl = config.origin + config.catalog;
  const root = await responseText(await fetchPage(catalogUrl), catalogUrl, retailer);
  const categoryUrls = config.categories ? discoverTildaIphoneCategories(root, retailer) : [catalogUrl];
  if (categoryUrls.length > maxCategoryPages) throw fail(retailer, 'incomplete crawl: too many category pages');
  let cashPolicyVerified = config.cash ? config.cash.test(decode(root)) : false;
  const references = new Map();
  await crawlQueue(categoryUrls, async url => {
    const html = url === catalogUrl ? root : await responseText(await fetchPage(url), url, retailer);
    cashPolicyVerified ||= config.cash ? config.cash.test(decode(html)) : false;
    for (const reference of discoverTildaIphoneParts(html, retailer)) {
      const id = `${reference.recid}:${reference.storepartuid}`;
      const item = references.get(id) || { reference, pages: [] };
      item.pages.push(url); references.set(id, item);
    }
  });
  if (references.size > maxStoreParts) throw fail(retailer, 'incomplete crawl: too many catalogue sections');
  const products = new Map(), sections = new Map();
  let apiPagesFetched = 0, sectionProducts = 0;
  await crawlQueue([...references.values()], async ({ reference, pages }) => {
    const sectionIds = new Set();
    let total;
    for (let slice = 1; slice <= maxSlices; slice++) {
      const url = productsEndpoint(reference, slice, pageSize);
      let payload;
      try {
        const response = await fetchPage(url);
        payload = response && typeof response === 'object' && !('ok' in response) ? response : JSON.parse(await responseText(response, url, retailer));
      } catch (error) { throw fail(retailer, `incomplete crawl: catalogue response: ${error.message}`); }
      if (!Array.isArray(payload.products)) throw fail(retailer, 'incomplete crawl: products is not an array');
      const count = Number(payload.total);
      if (payload.total == null || payload.total === '' || !Number.isInteger(count) || count < 0 || count > pageSize * maxSlices) throw fail(retailer, 'incomplete crawl: invalid product total');
      if (total === undefined) total = count;
      else if (count !== total) throw fail(retailer, 'incomplete crawl: product total changed');
      apiPagesFetched++;
      for (const product of payload.products) {
        const id = String(product?.uid ?? '');
        if (!/^\d+$/.test(id) || sectionIds.has(id)) throw fail(retailer, 'incomplete crawl: missing or repeated product id');
        sectionIds.add(id);
        const previous = products.get(id);
        if (previous && productSignature(previous) !== productSignature(product)) throw fail(retailer, `incomplete crawl: conflicting product ${id}`);
        products.set(id, product); sections.set(id, [...new Set([...(sections.get(id) || []), ...pages])]);
      }
      if (sectionIds.size >= total) break;
      if (!payload.products.length) throw fail(retailer, 'incomplete crawl: pagination stopped early');
    }
    if (sectionIds.size !== total) throw fail(retailer, `incomplete crawl: received ${sectionIds.size} of ${total} products`);
    sectionProducts += total;
  });
  for (const pages of sections.values()) pages.sort((a, b) => categoryUrls.indexOf(a) - categoryUrls.indexOf(b));
  const unpriced = [];
  const offers = parseTildaIphoneProducts(retailer, [...products.values()].sort((a, b) => String(a.uid).localeCompare(String(b.uid))), { fetchedAt, sections, cashPolicyVerified, unpriced });
  return { offers, failures: [], unpriced, stats: { catalogPagesFetched: config.categories ? 1 + categoryUrls.length : 1,
    catalogueSections: references.size, apiPagesFetched, sectionProducts, uniqueProducts: products.size,
    duplicatePlacements: sectionProducts - products.size, variants: offers.length, unpricedVariants: unpriced.length } };
}
