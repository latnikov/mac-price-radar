import { NIZHNY_RETAILERS, calculateRetailAnalytics, colorPriceTrustKey, findColorPriceLowTrust } from './retail-analytics.js';
import { priceColumnKey } from './avito-columns.js';

const collator = new Intl.Collator('ru', { numeric: true });
const normalized = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const known = value => value != null && value !== '' && value !== 'unknown';
const storage = value => ({ 1024: 1000, 2048: 2000, 4096: 4000, 8192: 8000, 16384: 16000 })[Number(value)] ?? Number(value);
const models = ['MacBook Air', 'MacBook Pro', 'MacBook Neo', 'Mac mini', 'Mac Studio', 'iMac'];
const comparisonFields = ['cpuCores', 'gpuCores', 'condition', 'keyboard', 'region', 'displayType', 'bundle'];
const colors = ['Silver', 'Space Gray', 'Space Black', 'Midnight', 'Starlight', 'Sky Blue', 'Gold', 'Blush', 'Citrus', 'Indigo', 'Blue', 'Green', 'Orange', 'Yellow', 'Pink', 'Purple'];
export const TABLE_PAGE_SIZE = 30;

export function normalizeTableOffer(offer) {
  const name = String(offer.model || offer.title || 'Не распознано').trim();
  const base = models.find(model => normalized(name).startsWith(normalized(model))) || name;
  const screenIn = Number(offer.screenIn) || Number(name.match(/\b(13|14|15|16|24|27)\b/)?.[1]) || null;
  return { ...offer, model: models.includes(base) && screenIn ? `${base} ${screenIn}"` : base,
    screenIn, ramGb: Number(offer.ramGb) || null, storageGb: storage(offer.storageGb) || null,
    chip: String(offer.chip || 'unknown').trim().replace(/\s+/g, ' ').toUpperCase().replace(/ PRO$/, ' Pro').replace(/ MAX$/, ' Max').replace(/ ULTRA$/, ' Ultra'),
    color: colors.find(color => normalized(color) === normalized(offer.color)) || String(offer.color || 'unknown').trim(),
  };
}

// Model, memory and storage form a base; colors and incompatible specifications stay separate.
export const tableConfigurationKey = offer => JSON.stringify([
  normalized(offer.model), offer.screenIn, normalized(offer.chip), offer.ramGb, storage(offer.storageGb),
]);
export const tableHardwareKey = offer => JSON.stringify([tableConfigurationKey(offer),
  ...comparisonFields.map(field => known(offer[field]) ? normalized(offer[field]) : 'unknown'),
]);
export const tableVariantKey = offer => JSON.stringify([tableHardwareKey(offer), normalized(offer.color)]);

function listingKey(offer, index) {
  let url;
  try {
    const parsed = new URL(offer.url); parsed.hash = '';
    for (const name of [...parsed.searchParams.keys()]) if (/^(utm_|gclid$|fbclid$)/i.test(name)) parsed.searchParams.delete(name);
    parsed.searchParams.sort();
    parsed.pathname = parsed.pathname.replace(/\/$/, '') || '/';
    url = parsed.href;
  } catch { url = offer.listingId || `missing:${index}`; }
  return JSON.stringify([priceColumnKey(offer), url, tableVariantKey(offer), offer.sourceVariantId ?? offer.optionId ?? null,
    offer.paymentMethod || 'unknown', offer.priceType || 'unknown', offer.minimumQuantity ?? 1]);
}

export function prepareTableOffers(input) {
  const unique = new Map();
  for (const [index, value] of input.entries()) {
    const offer = normalizeTableOffer(value), key = listingKey(offer, index), previous = unique.get(key);
    // The newest observation wins; a previous lower price must not survive as a duplicate.
    if (!previous || (Date.parse(offer.fetchedAt) || 0) > (Date.parse(previous.fetchedAt) || 0)
      || ((Date.parse(offer.fetchedAt) || 0) === (Date.parse(previous.fetchedAt) || 0) && offer.price > previous.price)) unique.set(key, offer);
  }
  return [...unique.values()];
}

export function currentPrice(offer, now = Date.now()) {
  const age = now - Date.parse(offer.fetchedAt);
  return Number.isFinite(offer.price) && offer.price > 0 && Number.isFinite(age) && age >= -60000 && age <= 4 * 3600000
    && (!offer.validUntil || Date.parse(offer.validUntil) > now)
    && !['OutOfStock', 'Discontinued', 'SoldOut'].includes(offer.stock)
    && offer.validationStatus !== 'rejected' && !offer.rejected && !offer.withdrawn && offer.latestAttempt?.status !== 'withdrawn' && !offer.qualityWarnings?.length
    && !['installment', 'from'].includes(offer.priceType) && !(offer.minimumQuantity > 1);
}

export function buildPriceTable(offers, { now = Date.now(), contextOffers = offers } = {}) {
  const colorTrust = findColorPriceLowTrust(contextOffers.filter(offer => currentPrice(offer, now) && offer.retailer !== 'Авито НН'), tableHardwareKey);
  const baseKey = offer => JSON.stringify([tableConfigurationKey(offer), normalized(offer.color)]);
  const context = new Map();
  for (const offer of contextOffers) {
    const key = baseKey(offer);
    if (!context.has(key)) context.set(key, new Map(comparisonFields.map(field => [field, new Map()])));
    for (const field of comparisonFields) if (known(offer[field])) context.get(key).get(field).set(normalized(offer[field]), offer[field]);
  }
  const groups = new Map();
  for (const offer of offers) {
    const sample = { ...offer };
    // An omitted detail can join one unambiguous value, but never two conflicting
    // CPU/GPU bins, conditions, regions or keyboard layouts.
    for (const field of comparisonFields) {
      const values = context.get(baseKey(offer))?.get(field);
      if (!known(sample[field]) && values?.size === 1) sample[field] = values.values().next().value;
    }
    const key = tableVariantKey(sample);
    if (!groups.has(key)) groups.set(key, { key, sample, offers: [] });
    groups.get(key).offers.push(offer);
  }
  return [...groups.values()].map(group => {
    const current = group.offers.filter(offer => currentPrice(offer, now));
    group.minimumPrice = Math.min(...(current.length ? current : group.offers).map(offer => offer.price));
    group.latestAt = Math.max(0, ...group.offers.map(offer => Date.parse(offer.fetchedAt) || 0));
    group.sellerCount = new Set(group.offers.map(priceColumnKey).filter(Boolean)).size;
    const shops = new Map();
    for (const offer of current) {
      if (!NIZHNY_RETAILERS.includes(offer.retailer)) continue;
      if (!shops.has(offer.retailer) || offer.price < shops.get(offer.retailer).price) shops.set(offer.retailer, offer);
    }
    const prices = [...shops.values()].map(offer => offer.price);
    const lowTrust = new Map();
    for (const offer of current) {
      const trust = colorTrust.get(colorPriceTrustKey(offer, tableHardwareKey));
      if (trust) lowTrust.set(offer.retailer, trust);
    }
    const recommendation = calculateRetailAnalytics(current, { additionalLowTrust: lowTrust });
    const averageRetail = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;
    // The difference must use the same average that is visible in this row.
    const difference = averageRetail == null || recommendation.minimumProcurement == null ? null : averageRetail - recommendation.minimumProcurement;
    group.lowTrust = lowTrust;
    group.analytics = {
      minimumProcurement: recommendation.minimumProcurement,
      procurementBenchmark: recommendation.procurementBenchmark,
      procurementCount: recommendation.procurementCount,
      difference,
      markupPercent: difference == null ? null : difference / recommendation.minimumProcurement * 100,
      minimumRetail: prices.length ? Math.min(...prices) : null,
      averageRetail,
      retailCount: prices.length,
      recommendedPrice: recommendation.recommendedPrice,
      benchmark: recommendation.benchmark,
      lowTrustRetailers: recommendation.lowTrustRetailers,
      lowTrustReasons: recommendation.lowTrustReasons,
      nizhnyReferenceAverage: recommendation.nizhnyReferenceAverage,
    };
    return group;
  });
}

export function selectTablePage(groups, { sort = 'model', page = 1, pageSize = TABLE_PAGE_SIZE } = {}) {
  const selected = [...groups];
  selected.sort((a, b) => (sort === 'price-up' ? a.minimumPrice - b.minimumPrice
    : sort === 'price-down' ? b.minimumPrice - a.minimumPrice
      : sort === 'fresh' ? b.latestAt - a.latestAt
        : sort === 'coverage' ? b.sellerCount - a.sellerCount : 0) || collator.compare(a.key, b.key));
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : TABLE_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(selected.length / size));
  const currentPage = Math.max(1, Math.min(pages, Math.trunc(Number(page)) || 1));
  return { rows: selected.slice((currentPage - 1) * size, currentPage * size), allRows: selected,
    offerCount: selected.reduce((sum, group) => sum + group.offers.length, 0), total: selected.length, pages, page: currentPage };
}
