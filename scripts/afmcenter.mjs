import { decode, parseProduct, price } from './offer-normalization.mjs';
import { crawlQueue } from './crawl-queue.mjs';

const origin = 'https://afmcenter.ru';
const catalogUrl = `${origin}/shop/mac`;
const fail = message => new Error(`AFM: ${message}`);
const clean = value => decode(value).replace(/ГБ/gi, 'GB').replace(/ТБ/gi, 'TB');
const macTitle = /^(?:Apple\s+)?(?:MacBook\s+(?:Air|Pro|Neo)|iMac|Mac\s+(?:mini|Studio))\b/i;
const neoSpecs = 'https://support.apple.com/en-ie/126322';

async function responseText(response, url) {
  if (typeof response === 'string') return response;
  if (!response?.ok) throw fail(`HTTP ${response?.status ?? 'unknown'}: ${url}`);
  if (response.url && new URL(response.url).origin !== new URL(url).origin) throw fail('redirect outside requested site');
  return response.text();
}

export function discoverAfmStore(html) {
  // The page also contains a separate ROOT for all products; use the Mac block.
  const matches = [...String(html).matchAll(/\bvar\s+options\s*=\s*\{\s*recid\s*:\s*['"](\d+)['"][\s\S]{0,2500}?\bstorepart\s*:\s*['"](\d+)['"]/gi)];
  if (matches.length !== 1) throw fail('incomplete crawl: expected one Mac catalogue reference');
  return { recid: matches[0][1], storepartuid: matches[0][2] };
}

function productUrl(value, editionId) {
  let url;
  try { url = new URL(String(value || ''), catalogUrl); } catch { throw fail('invalid product URL'); }
  if (url.origin !== origin || url.username || url.password || !/^\/shop\/(?:mac\/[^/]+|mac-air-[^/]+)\/?$/.test(url.pathname)) throw fail('product URL outside Mac catalogue');
  url.hash = ''; url.search = '';
  if (editionId) url.searchParams.set('editionuid', editionId);
  return url.href;
}

function needsDetails(product) {
  return /^MacBook\s+Neo\b/i.test(clean(product.title)) || /^iMac\s+(?!24\b|27\b)/i.test(clean(product.title));
}

export async function parseAfmDetails(html) {
  const { load } = await import('cheerio');
  const $ = load(String(html));
  $('script,style,noscript').remove();
  const title = clean($('.t744__title, .js-store-prod-name').first().text());
  const description = clean($('.t744__descr').text());
  return { title, description };
}

function variantTitle(product, edition, details) {
  // Convert the CPU/GPU pair before the shared memory parser sees a slash.
  let title = clean(product.title).replace(/(\d+)\s*\/\s*(\d+)\s*ядер/gi, '$1-core CPU $2-core GPU');
  let specificationSource = null;
  if (/^MacBook\s+Neo\b/i.test(title)) {
    if (!/^MacBook\s+Neo\b/i.test(details?.title || '') || !/\bA18\s+Pro\b/i.test(details?.description || '') || !/13\s*["″”]/.test(details.description)) throw fail(`unverified Neo configuration: ${product.uid}`);
    const storage = title.match(/\b(256|512)\s*GB\b/i)?.[1];
    if (!storage || !/^MacBook\s+Neo\s+(?:256|512)\s*GB$/i.test(title)) throw fail(`unrecognized Neo memory: ${product.title}`);
    // This exact A18 Pro model has one RAM configuration (Apple tech specs).
    title = `MacBook Neo 13" A18 Pro 6-core CPU 5-core GPU RAM 8GB SSD ${storage}GB`;
    specificationSource = neoSpecs;
  } else if (/^iMac\s+(?!24\b|27\b)/i.test(title)) {
    const screen = details?.title.match(/^iMac\s+(24|27)\s*["″”]/i)?.[1];
    if (!screen) throw fail(`missing iMac screen: ${product.uid}`);
    title = title.replace(/^iMac\b/i, `iMac ${screen}"`);
  }
  let color = clean(edition['Цвет'] || edition.Color || '');
  if (/^(Полночь|Тёмная ночь|Темная ночь)$/i.test(color)) color = 'Midnight';
  if (/^Небесно-(?:синий|голубой)$/i.test(color)) color = 'Sky Blue';
  if (/^Ж[её]лтый$/i.test(color) && /^MacBook\s+Neo\b/i.test(title)) color = 'Citrus';
  return { title: `${title} ${color}`.trim(), specificationSource };
}

export function parseAfmProducts(products, { fetchedAt = new Date().toISOString(), details = new Map(), storepartuid = null, unpriced = [] } = {}) {
  if (!Array.isArray(products)) throw fail('incomplete crawl: products is not an array');
  const offers = [], productIds = new Set(), editionIds = new Set();
  for (const product of products) {
    const id = String(product?.uid ?? '');
    if (!/^\d+$/.test(id) || productIds.has(id)) throw fail('invalid or duplicate product id');
    productIds.add(id);
    if (!macTitle.test(clean(product.title))) throw fail(`unrecognized Mac product: ${product.title}`);
    const url = productUrl(product.url);
    const editions = Array.isArray(product.editions) && product.editions.length ? product.editions : [product];
    let cashVariants = 0;
    for (const edition of editions) {
      const editionId = String(edition?.uid ?? '');
      if (!/^\d+$/.test(editionId) || editionIds.has(editionId)) throw fail('invalid or duplicate edition id');
      editionIds.add(editionId);
      if (edition !== product && Object.keys(edition).some(key => !['uid', 'externalid', 'sku', 'price', 'priceold', 'quantity', 'img', 'Цвет', 'Color', 'Оплата'].includes(key))) throw fail(`unsupported variant option: ${editionId}`);
      const payment = decode(edition['Оплата']);
      if (payment && !/^Наличные$/i.test(payment)) continue;
      const cashEvidence = /цен[аы]\s+при\s+оплате\s+наличными/i.test(decode(product.descr));
      if (!payment && !cashEvidence) throw fail(`cash price not confirmed: ${id}`);
      cashVariants++;
      const rawPrice = String(edition.price ?? '').trim();
      // AFM explicitly lists some colors without a price ("по запросу"). Never
      // borrow the parent minimum or a different color's amount for those.
      if (rawPrice === '' || /^0(?:[.,]0+)?$/.test(rawPrice)) {
        unpriced.push({ productId: id, editionId, url: productUrl(url, editionId), title: product.title, color: edition['Цвет'] || edition.Color || null });
        continue;
      }
      const amount = price(rawPrice.replace(/([.,]\d{2})00$/, '$1'));
      if (!amount) throw fail(`invalid current price: ${editionId}`);
      const detail = details.get(id);
      const { title, specificationSource } = variantTitle(product, edition, detail);
      const quantity = String(edition.quantity ?? product.quantity ?? '').trim();
      const stock = quantity === '' ? 'source_reported' : /^\d+(?:\.0+)?$/.test(quantity) ? (Number(quantity) > 0 ? 'InStock' : 'OutOfStock') : 'unknown';
      const offer = parseProduct(title, productUrl(url, edition !== product ? editionId : null), 'AFM', amount, fetchedAt, {
        externalId: `afm:${id}:${editionId}`, sourceProductId: id, sourceVariantId: editionId,
        sourceCity: 'Нижний Новгород', sourceSite: 'afmcenter.ru', rawPrice: edition.price,
        condition: 'new', region: 'unknown', keyboard: 'unknown', displayType: 'standard', bundle: 'standard',
        priceType: 'full', paymentMethod: 'cash', buyerType: 'retail', minimumQuantity: 1, stock,
        evidence: { method: 'tilda-store-api-v1', catalogPage: catalogUrl, storepartuid,
          sourceProductTitle: product.title, sourceVariant: edition, sourceDescription: decode(product.descr),
          ...(detail ? { detailPage: url, detailTitle: detail.title, detailDescription: detail.description } : {}),
          ...(specificationSource ? { specificationSource, supplementedFields: ['ramGb', 'cpuCores', 'gpuCores'] } : {}),
          priceMeaning: 'Цена выбранного цвета при оплате наличными; без кредита, trade-in и доплат за другие способы оплаты',
          availabilityMeaning: 'Публикация в каталоге; AFM просит уточнять наличие и цену у менеджера' },
      });
      if (!offer) throw fail(`unrecognized configuration: ${title}`);
      if (!offer.screenIn && /^(?:MacBook|iMac)/i.test(offer.model)) throw fail(`missing screen: ${id}`);
      offers.push(offer);
    }
    if (!cashVariants) throw fail(`no cash-price variant: ${id}`);
  }
  return offers;
}

export async function fetchAfmOffers({ fetchPage = url => fetch(url, { signal: AbortSignal.timeout(20000) }), pageSize = 100, maxSlices = 20 } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(maxSlices) || maxSlices < 1 || maxSlices > 50) throw fail('invalid pagination limits');
  const reference = discoverAfmStore(await responseText(await fetchPage(catalogUrl), catalogUrl));
  const products = [], ids = new Set();
  let total, apiPagesFetched = 0;
  for (let slice = 1; slice <= maxSlices; slice++) {
    const url = new URL('https://store.tildaapi.com/api/getproductslist/');
    for (const [key, value] of Object.entries({ ...reference, slice, size: pageSize, getparts: 'true', getoptions: 'true', flag_root: 'withroot' })) url.searchParams.set(key, String(value));
    let payload;
    try { payload = JSON.parse(await responseText(await fetchPage(url.href), url.href)); } catch (error) { throw fail(`incomplete crawl: ${error.message}`); }
    if (!Array.isArray(payload.products)) throw fail('incomplete crawl: products is not an array');
    const count = Number(payload.total);
    if (payload.total == null || payload.total === '' || !Number.isInteger(count) || count < 0 || count > pageSize * maxSlices) throw fail('incomplete crawl: invalid total');
    if (total === undefined) total = count;
    else if (count !== total) throw fail('incomplete crawl: total changed');
    apiPagesFetched++;
    for (const product of payload.products) {
      const id = String(product?.uid ?? '');
      if (!/^\d+$/.test(id) || ids.has(id)) throw fail('incomplete crawl: missing or repeated product id');
      ids.add(id); products.push(product);
    }
    if (products.length >= total) break;
    if (!payload.products.length) throw fail('incomplete crawl: pagination stopped early');
  }
  if (products.length !== total) throw fail(`incomplete crawl: received ${products.length} of ${total}`);
  const details = new Map();
  await crawlQueue(products.filter(needsDetails), async product => {
    const url = productUrl(product.url);
    details.set(String(product.uid), await parseAfmDetails(await responseText(await fetchPage(url), url)));
  });
  const unpriced = [];
  const offers = parseAfmProducts(products, { details, storepartuid: reference.storepartuid, unpriced });
  if (!offers.length) throw fail('incomplete crawl: no priced Mac variants');
  return { offers, failures: [], unpriced, stats: { catalogPagesFetched: 1, apiPagesFetched, productPagesFetched: details.size, products: products.length, variants: offers.length, unpricedVariants: unpriced.length } };
}
