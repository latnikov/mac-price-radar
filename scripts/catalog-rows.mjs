import { variantKey, assessOffer } from './domain.mjs';
export const offerKey = variantKey;

// A partial crawl never proves that an omitted listing has disappeared.
export function mergeLiveOffers(previous, incoming) {
  const byIdentity = new Map();
  for (const offer of [...previous, ...incoming]) {
    const id = `${offer.retailer}|${offer.url}|${offer.paymentMethod || 'unknown'}|${offer.minimumQuantity || 'unknown'}`;
    const prior = byIdentity.get(id);
    if (!prior || (offer.fetchedAt || '') >= (prior.fetchedAt || '')) byIdentity.set(id, offer);
  }
  return [...byIdentity.values()];
}

export function buildCatalogRows(catalog, offers, options = {}) {
  const rows = new Map();
  for (const product of catalog) {
    for (const color of product.colors) {
      const productKey = offerKey({ ...product, model: product.name, color });
      rows.set(productKey, { productKey, product, color, offers: [], best: null, emptyReason: product.reviewStatus === 'conflict' ? 'Конфликт справочника — требуется проверка' : 'Нет точного сопоставления с проверенным предложением' });
    }
  }
  for (const original of offers) {
    if (original.dataKind === 'demo' || original.isDemo) continue;
    const offer = { ...original, ...assessOffer(original, options) };
    const productKey = offerKey(offer);
    if (!rows.has(productKey)) {
      rows.set(productKey, {
        productKey,
        product: {
          id: offer.variantId || `discovered:${productKey}`, name: offer.model || offer.title || 'Не распознан', chip: offer.chip,
          ramGb: offer.ramGb, storageGb: offer.storageGb, colors: [offer.color],
          cpuCores: offer.cpuCores, gpuCores: offer.gpuCores, keyboard: offer.keyboard, region: offer.region,
          discovered: true, reviewStatus: offer.matchStatus,
          verificationNote: offer.qualityReasons.join('; ') || 'Характеристики указаны источником',
        },
        color: offer.color, offers: [], best: null,
      });
    }
    rows.get(productKey).offers.push(offer);
  }
  for (const row of rows.values()) {
    row.offers.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || String(a.url).localeCompare(String(b.url)));
    row.best = row.offers.find(offer => offer.marketEligible) || null;
    row.marketReference = row.best;
    row.procurement = null;
    row.status = !row.offers.length ? 'catalog_review' : row.best ? 'market_observation' : 'needs_review';
    if (row.offers.length && !row.best) row.emptyReason = 'Нет сопоставимого свежего рыночного предложения';
  }
  return [...rows.values()];
}
