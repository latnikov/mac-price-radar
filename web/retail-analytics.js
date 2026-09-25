export const PROCUREMENT_RETAILERS = ['Дима', 'BSA'];
export const NIZHNY_RETAILERS = ['Айфория', 'Technichno', 'iMobile', 'ReSale', 'Apple Store', 'Rebro'];

export const RETAILER_TRUST = Object.freeze({
  ReSale: Object.freeze({
    level: 'low',
    label: 'низкий',
    reason: 'Цена и наличие на сайте требуют ручной проверки',
  }),
});

const average = values => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;

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

export function calculateRetailAnalytics(offers, { undercutRub = 500 } = {}) {
  const procurement = lowestByRetailer(offers, PROCUREMENT_RETAILERS);
  const nizhny = lowestByRetailer(offers, NIZHNY_RETAILERS);
  const trustedNizhny = [...nizhny.values()].filter(offer => RETAILER_TRUST[offer.retailer]?.level !== 'low');
  const averageProcurement = average([...procurement.values()].map(offer => offer.price));
  const averageRetail = average(trustedNizhny.map(offer => offer.price));
  const averageDifference = averageProcurement == null || averageRetail == null ? null : averageRetail - averageProcurement;
  const averageMarkupPercent = averageDifference == null || !averageProcurement ? null : averageDifference / averageProcurement * 100;
  const benchmark = trustedNizhny.sort((a, b) => a.price - b.price)[0] || null;
  const recommendedPrice = benchmark ? Math.max(0, benchmark.price - undercutRub) : null;

  return {
    averageProcurement,
    averageRetail,
    averageDifference,
    averageMarkupPercent,
    recommendedPrice,
    benchmark,
    procurementCount: procurement.size,
    retailCount: trustedNizhny.length,
    ignoredLowTrustCount: [...nizhny.values()].filter(offer => RETAILER_TRUST[offer.retailer]?.level === 'low').length,
  };
}
