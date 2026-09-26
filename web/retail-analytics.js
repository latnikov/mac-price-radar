export const PROCUREMENT_RETAILERS = ['Дима', 'BSA'];
export const NIZHNY_RETAILERS = ['Айфория', 'Technichno', 'iMobile', 'ReSale', 'Apple Store', 'Rebro', 'Madstore', 'Smart Device'];

export const RETAILER_TRUST = Object.freeze({
  ReSale: Object.freeze({
    level: 'low',
    label: 'низкий',
    reason: 'Цена и наличие на сайте требуют ручной проверки',
  }),
});

const average = values => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
const canonicalStorage = value => ({ 1024: 1000, 2048: 2000, 4096: 4000, 8192: 8000, 16384: 16000 })[Number(value)] ?? value;

// Retailers frequently omit CPU/GPU core counts. Those optional details must
// not split one sellable configuration into duplicate catalogue rows.
export const catalogConfigurationKey = offer => [
  offer.model,
  offer.chip,
  offer.screenIn,
  offer.ramGb,
  canonicalStorage(offer.storageGb),
].map(value => value ?? 'unknown').join('|');

function usableOffer(offer) {
  return offer && Number.isFinite(offer.price) && offer.price > 0 && !['OutOfStock', 'Discontinued', 'SoldOut'].includes(offer.stock);
}

function lowestByRetailer(offers, retailerNames) {
  const allowed = new Set(retailerNames);
  const result = new Map();
  for (const offer of offers) {
    if (!allowed.has(offer.retailer) || !usableOffer(offer)) continue;
    const current = result.get(offer.retailer);
    if (!current || offer.price < current.price) result.set(offer.retailer, offer);
  }
  return result;
}

export const colorPriceTrustKey = (offer, configurationKey) => [offer.retailer, configurationKey(offer), offer.color].join('\u0000');

export function findColorPriceLowTrust(offers, configurationKey) {
  if (typeof configurationKey !== 'function') throw new TypeError('configurationKey must be a function');
  const groups = new Map();
  for (const offer of offers) {
    if (!usableOffer(offer) || !offer.retailer || !offer.color || offer.color === 'unknown') continue;
    const groupKey = [offer.retailer, configurationKey(offer)].join('\u0000');
    if (!groups.has(groupKey)) groups.set(groupKey, new Map());
    const colors = groups.get(groupKey);
    const current = colors.get(offer.color);
    if (!current || offer.price < current.price) colors.set(offer.color, offer);
  }

  const lowTrust = new Map();
  for (const colors of groups.values()) {
    if (colors.size < 2) continue;
    const comparisonPrice = Math.max(...[...colors.values()].map(offer => offer.price));
    for (const offer of colors.values()) {
      if (offer.price >= comparisonPrice) continue;
      lowTrust.set(colorPriceTrustKey(offer, configurationKey), {
        level: 'low',
        label: 'низкий',
        price: offer.price,
        comparisonPrice,
        reason: `Цвет ${offer.color} стоит дешевле другого цвета той же конфигурации`,
      });
    }
  }
  return lowTrust;
}

export function calculateRetailAnalytics(offers, { undercutRub = 500, additionalLowTrust = new Map() } = {}) {
  const procurement = lowestByRetailer(offers, PROCUREMENT_RETAILERS);
  const nizhny = lowestByRetailer(offers, NIZHNY_RETAILERS);
  const staticallyTrustedNizhny = [...nizhny.values()].filter(offer => RETAILER_TRUST[offer.retailer]?.level !== 'low' && !additionalLowTrust.has(offer.retailer));
  const nizhnyReferenceAverage = average(staticallyTrustedNizhny.map(offer => offer.price));
  const dynamicallyLowTrust = new Set(staticallyTrustedNizhny
    .filter(offer => nizhnyReferenceAverage != null && offer.price < nizhnyReferenceAverage * 0.95)
    .map(offer => offer.retailer));
  const trustedNizhny = staticallyTrustedNizhny.filter(offer => !dynamicallyLowTrust.has(offer.retailer));
  const procurementBenchmark = [...procurement.values()].sort((a, b) => a.price - b.price)[0] || null;
  const minimumProcurement = procurementBenchmark?.price ?? null;
  const averageRetail = average(trustedNizhny.map(offer => offer.price));
  const difference = minimumProcurement == null || averageRetail == null ? null : averageRetail - minimumProcurement;
  const markupPercent = difference == null || !minimumProcurement ? null : difference / minimumProcurement * 100;
  const benchmark = trustedNizhny.sort((a, b) => a.price - b.price)[0] || null;
  const recommendedPrice = benchmark ? Math.max(0, benchmark.price - undercutRub) : null;
  const lowTrustRetailers = new Set([
    ...[...nizhny.values()].filter(offer => RETAILER_TRUST[offer.retailer]?.level === 'low').map(offer => offer.retailer),
    ...[...additionalLowTrust.keys()].filter(retailer => nizhny.has(retailer)),
    ...dynamicallyLowTrust,
  ]);
  const lowTrustReasons = new Map([...lowTrustRetailers].map(retailer => [retailer,
    RETAILER_TRUST[retailer]?.reason
      || additionalLowTrust.get(retailer)?.reason
      || 'Цена ниже среднего ориентира по Нижнему Новгороду более чем на 5%',
  ]));

  return {
    minimumProcurement,
    procurementBenchmark,
    averageRetail,
    difference,
    markupPercent,
    recommendedPrice,
    benchmark,
    nizhnyReferenceAverage,
    lowTrustRetailers,
    lowTrustReasons,
    procurementCount: procurement.size,
    retailCount: trustedNizhny.length,
    ignoredLowTrustCount: lowTrustRetailers.size,
  };
}
