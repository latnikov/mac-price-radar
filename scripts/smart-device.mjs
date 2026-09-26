import { decode, parseProduct, price } from './offer-normalization.mjs';
import { canonicalStorageGb } from './domain.mjs';
import { crawlQueue } from './crawl-queue.mjs';

const origin = 'https://smart-device.shop';
const catalogUrl = `${origin}/mac`;
const categoryPath = /^\/(?:mac-(?:air|pro|mini|studio)|macbook-(?:air|pro|neo)|imac)(?:-[a-z0-9-]+)?\/?$/i;
const fail = message => new Error(`Smart Device: ${message}`);
const clean = value => decode(value).replace(/Sky Blu[еe]/gi, 'Sky Blue');

async function responseText(response, url) {
  if (typeof response === 'string') return response;
  if (!response?.ok) throw fail(`HTTP ${response?.status ?? 'unknown'}: ${url}`);
  if (response.url && new URL(response.url).origin !== new URL(url).origin) throw fail('redirected outside requested site');
  return response.text();
}

export function discoverSmartDeviceCategories(html) {
  const urls = new Set();
  for (const match of String(html).matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    let url;
    try { url = new URL(decode(match[2]), catalogUrl); } catch { continue; }
    if (url.origin !== origin || url.username || url.password || !categoryPath.test(url.pathname)) continue;
    urls.add(`${origin}${url.pathname.replace(/\/$/, '')}`);
  }
  if (!urls.size) throw fail('incomplete crawl: Mac category links not found');
  return [...urls];
}

export function discoverSmartDeviceStoreParts(html) {
  const references = new Map();
  for (const match of String(html).matchAll(/\bvar\s+options\s*=\s*\{\s*recid\s*:\s*['"](\d+)['"][\s\S]{0,2500}?\bstorepart\s*:\s*['"](\d+)['"]/gi)) {
    references.set(`${match[1]}:${match[2]}`, { recid: match[1], storepartuid: match[2] });
  }
  if (!references.size) throw fail('incomplete crawl: Tilda catalogue reference not found');
  return [...references.values()];
}

function productUrl(value, editionId) {
  let url;
  try { url = new URL(String(value || ''), catalogUrl); } catch { throw fail('invalid product URL'); }
  const category = url.pathname.split('/tproduct/');
  if (url.origin !== origin || url.username || url.password || category.length !== 2 || !categoryPath.test(category[0]) || !category[1]) throw fail('product URL outside Mac catalogue');
  url.hash = ''; url.search = '';
  if (editionId) url.searchParams.set('editionuid', editionId);
  return url.href;
}

function field(object, names) {
  const key = Object.keys(object || {}).find(key => names.includes(clean(key).toLowerCase()));
  return key ? clean(object[key]) : '';
}

function gigabytes(value) {
  const match = value.match(/^(\d+)\s*(TB|ТБ|GB|ГБ)?$/i);
  if (!match) throw fail(`invalid variant memory: ${value}`);
  return canonicalStorageGb(Number(match[1]) * (/^(TB|ТБ)$/i.test(match[2] || '') ? 1000 : 1));
}

// Tilda emits four decimal places for simple products. Never round real fractions
// of a kopeck or interpret the crossed-out price as the current price.
function currentPrice(value) {
  const normalized = String(value ?? '').trim().replace(/([.,]\d{2})00$/, '$1');
  const amount = price(normalized);
  if (!amount) throw fail(`invalid current price: ${value}`);
  return amount;
}

export function parseSmartDeviceProducts(products, { fetchedAt = new Date().toISOString(), sections = new Map() } = {}) {
  if (!Array.isArray(products)) throw fail('incomplete crawl: products is not an array');
  const offers = [], ids = new Set(), productIds = new Set();
  for (const product of products) {
    const productId = String(product?.uid ?? '');
    if (!/^\d+$/.test(productId) || productIds.has(productId)) throw fail(`invalid or duplicate product id: ${productId}`);
    productIds.add(productId);
    const baseUrl = productUrl(product.url);
    const colorCharacteristic = (product.characteristics || []).find(item => clean(item.title).toLowerCase() === 'цвет')?.value;
    const base = parseProduct(`${clean(product.title)} ${clean(colorCharacteristic)}`, baseUrl, 'Smart Device', 1);
    if (!base) throw fail(`unrecognized Mac configuration: ${product.title}`);
    const editions = Array.isArray(product.editions) && product.editions.length ? product.editions : [product];
    const before = offers.length;
    for (const edition of editions) {
      const editionId = String(edition.uid ?? '');
      const id = `smart-device:${productId}:${editionId}`;
      if (!/^\d+$/.test(editionId) || ids.has(id)) throw fail(`invalid or duplicate edition id: ${editionId}`);
      ids.add(id);
      const payment = field(edition, ['способ оплаты', 'оплата']);
      if (payment && !/^наличными$|^наличные$/i.test(payment)) continue;
      const amount = currentPrice(edition.price);
      let ram = base.ramGb, storage = base.storageGb;
      const memory = field(edition, ['память', 'memory']);
      if (memory) {
        const pair = memory.match(/^(\d+)\s*(?:GB|ГБ)?\s*\/\s*(\d+\s*(?:TB|ТБ|GB|ГБ)?)$/i);
        if (!pair) throw fail(`ambiguous variant memory: ${memory}`);
        ram = Number(pair[1]); storage = gigabytes(pair[2]);
      }
      const ramOption = field(edition, ['оперативная память', 'ram']);
      const ssdOption = field(edition, ['объем памяти', 'объём памяти', 'ssd', 'storage']);
      if (ramOption) ram = gigabytes(ramOption);
      if (ssdOption) storage = gigabytes(ssdOption);
      const color = field(edition, ['цвет', 'color']) || base.color;
      const cores = [base.cpuCores ? `${base.cpuCores}-core CPU` : '', base.gpuCores ? `${base.gpuCores}-core GPU` : ''].join(' ');
      const title = `${base.model} ${base.chip} RAM ${ram}GB SSD ${storage}GB ${cores} ${color}`;
      const quantity = String(edition.quantity ?? product.quantity ?? '').trim();
      const stock = quantity === '' ? 'source_reported' : /^\d+(?:\.0+)?$/.test(quantity) ? (Number(quantity) > 0 ? 'InStock' : 'OutOfStock') : 'unknown';
      const offer = parseProduct(title, productUrl(product.url, editionId), 'Smart Device', amount, fetchedAt, {
        externalId: id, sourceProductId: productId, sourceVariantId: editionId,
        sourceCity: 'Нижний Новгород', sourceSite: 'smart-device.shop', rawPrice: edition.price,
        condition: base.condition === 'unknown' ? 'new' : base.condition,
        region: 'unknown', keyboard: base.keyboard, displayType: 'standard', bundle: 'standard',
        priceType: 'full', paymentMethod: 'cash', buyerType: 'retail', minimumQuantity: 1, stock,
        evidence: {
          method: 'tilda-store-api-v1', catalogPage: catalogUrl, categoryPages: sections.get(productId) || [],
          sourceProductTitle: product.title, sourceVariant: edition, sourceCharacteristics: product.characteristics || [],
          priceMeaning: 'Цена при оплате наличными; на сайте оплата картой/QR дороже на 20%',
          availabilityMeaning: 'Публикация в каталоге; магазин просит уточнять наличие и стоимость',
        },
      });
      if (!offer) throw fail(`unrecognized variant: ${id}`);
      offers.push(offer);
    }
    if (offers.length === before) throw fail(`no cash-price variant for product ${productId}`);
  }
  return offers;
}

function productsEndpoint(reference, slice, size) {
  const url = new URL('https://store.tildaapi.com/api/getproductslist/');
  for (const [key, value] of Object.entries({ ...reference, size, slice, getparts: 'true', getoptions: 'true', flag_root: 'withroot' })) url.searchParams.set(key, String(value));
  return url.href;
}

export async function fetchSmartDeviceOffers({ fetchPage = url => fetch(url, { signal: AbortSignal.timeout(20000) }), pageSize = 100, maxSlices = 20, maxCategoryPages = 20 } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(maxSlices) || maxSlices < 1 || maxSlices > 50) throw fail('invalid pagination limits');
  const root = await responseText(await fetchPage(catalogUrl), catalogUrl);
  const categories = discoverSmartDeviceCategories(root);
  if (categories.length > maxCategoryPages) throw fail('incomplete crawl: too many category pages');
  const references = new Map();
  await crawlQueue(categories, async url => {
    const html = await responseText(await fetchPage(url), url);
    for (const reference of discoverSmartDeviceStoreParts(html)) {
      const key = `${reference.recid}:${reference.storepartuid}`;
      const entry = references.get(key) || { reference, pages: [] };
      entry.pages.push(url); references.set(key, entry);
    }
  });
  if (references.size > maxCategoryPages * 3) throw fail('incomplete crawl: too many catalogue sections');
  const products = new Map(), sections = new Map();
  let apiPagesFetched = 0, sectionProducts = 0;
  await crawlQueue([...references.values()], async ({ reference, pages }) => {
    const sectionIds = new Set();
    let total;
    for (let slice = 1; slice <= maxSlices; slice++) {
      const url = productsEndpoint(reference, slice, pageSize);
      let payload;
      try { payload = JSON.parse(await responseText(await fetchPage(url), url)); } catch (error) { throw fail(`incomplete crawl: catalogue response: ${error.message}`); }
      if (!Array.isArray(payload.products)) throw fail('incomplete crawl: products is not an array');
      const reportedTotal = Number(payload.total);
      if (payload.total == null || payload.total === '' || !Number.isInteger(reportedTotal) || reportedTotal < 0 || reportedTotal > pageSize * maxSlices) throw fail('incomplete crawl: invalid product total');
      if (total === undefined) total = reportedTotal;
      else if (total !== reportedTotal) throw fail('incomplete crawl: product total changed');
      apiPagesFetched++;
      for (const product of payload.products) {
        const id = String(product?.uid ?? '');
        if (!/^\d+$/.test(id) || sectionIds.has(id)) throw fail('incomplete crawl: missing or repeated product id');
        sectionIds.add(id);
        const previous = products.get(id);
        const signature = p => JSON.stringify([p.title, p.url, p.price, p.quantity, p.editions, p.characteristics]);
        if (previous && signature(previous) !== signature(product)) throw fail(`incomplete crawl: conflicting product ${id}`);
        products.set(id, product);
        sections.set(id, [...new Set([...(sections.get(id) || []), ...pages])]);
      }
      if (sectionIds.size >= total) break;
      if (!payload.products.length) throw fail('incomplete crawl: pagination stopped early');
    }
    if (sectionIds.size !== total) throw fail(`incomplete crawl: received ${sectionIds.size} of ${total} products`);
    sectionProducts += total;
  });
  const ordered = [...products.values()].sort((a, b) => String(a.uid).localeCompare(String(b.uid)));
  const offers = parseSmartDeviceProducts(ordered, { sections });
  if (!offers.length) throw fail('incomplete crawl: no priced Mac variants discovered');
  return { offers, failures: [], stats: {
    catalogPagesFetched: 1 + categories.length, catalogueSections: references.size,
    apiPagesFetched, sectionProducts, uniqueProducts: products.size,
    duplicatePlacements: sectionProducts - products.size, variants: offers.length,
  } };
}
