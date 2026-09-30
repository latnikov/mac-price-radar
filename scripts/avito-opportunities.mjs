import { canonicalModelName, canonicalStorageGb, canonicalUrl, known, moneyMinor, normalize } from './domain.mjs';
import { AVITO, avitoUrl, excludedSeller, businessSellerName } from './avito-policy.mjs';

export const AVITO_OPPORTUNITIES_VERSION = 'private-used-asking-spread-v2';
const BASIC_FIELDS = ['model', 'chip', 'screenIn', 'ramGb', 'storageGb', 'color'];
const EXTRA_FIELDS = ['cpuCores', 'gpuCores', 'keyboard', 'region', 'displayType', 'bundle'];
const AVAILABLE = new Set(['InStock', 'source_reported', 'confirmed']);
const timestamp = offer => Date.parse(offer.observedAt || offer.fetchedAt);
const field = (offer, name) => name === 'storageGb' ? canonicalStorageGb(offer[name])
  : name === 'model' ? canonicalModelName(offer[name]) : offer[name];
const configKey = offer => BASIC_FIELDS.map(name => normalize(field(offer, name))).join('|');
const compatible = (a, b) => EXTRA_FIELDS.every(name => !known(a[name]) || !known(b[name]) || normalize(a[name]) === normalize(b[name]));
const minor = (value, name) => {
  const result = value === 0 ? 0 : typeof value === 'number' ? moneyMinor(value) : null;
  if (result === null) throw new TypeError(`${name} must be a non-negative amount in RUB with at most two decimals`);
  return result;
};
const percentage = (value, name) => {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new TypeError(`${name} must be between 0 and 100`);
  return value;
};

function usable(offer, now, maxAgeHours) {
  const at = timestamp(offer);
  return offer && offer.visibility !== 'private' && offer.currency === 'RUB'
    && typeof offer.price === 'number' && moneyMinor(offer.price) !== null
    && offer.condition === 'used' && offer.marketplaceSellerType === 'private' && !offer.matchedRetailer && offer.priceType === 'full'
    && AVAILABLE.has(offer.stock) && offer.active !== false && !offer.withdrawn
    && !offer.rejected && !['rejected', 'invalid'].includes(offer.validationStatus)
    && offer.status !== 'rejected' && offer.matchStatus !== 'rejected'
    && !offer.latestAttempt?.rejected && !['rejected', 'invalid'].includes(offer.latestAttempt?.validationStatus)
    && !['withdrawn', 'rejected'].includes(offer.latestAttempt?.status)
    && !offer.isDemo && !offer.demo && !offer.seed && offer.dataKind !== 'demo'
    && !offer.qualityWarnings?.length && !offer.validationIssues?.length
    && BASIC_FIELDS.every(name => known(field(offer, name)))
    && ['screenIn', 'ramGb', 'storageGb'].every(name => Number.isFinite(field(offer, name)) && field(offer, name) > 0)
    && (offer.minimumQuantity == null || offer.minimumQuantity === 1)
    && Number.isFinite(at) && at <= now + 60_000 && now - at <= maxAgeHours * 3_600_000
    && (!offer.validUntil || (Number.isFinite(Date.parse(offer.validUntil)) && Date.parse(offer.validUntil) > now))
    && Boolean(canonicalUrl(offer.url));
}

// A listing may be supplied more than once by import/retry paths. Choose its
// latest observation BEFORE eligibility checks, so a newer withdrawal wins.
function uniqueListings(offers) {
  const result = new Map();
  for (const offer of offers) {
    if (!offer || typeof offer !== 'object') continue;
    const key = `${offer.retailer}|${offer.externalId || canonicalUrl(offer.url) || offer.listingId || offer.id}`;
    const previous = result.get(key);
    if (!previous || timestamp(offer) >= timestamp(previous) || !Number.isFinite(timestamp(previous))) result.set(key, offer);
  }
  return [...result.values()];
}

function inScope(offer, now, maxAgeHours) {
  if (offer.retailer !== AVITO || offer.sourceCity !== 'Нижний Новгород' || !offer.marketplaceSellerId || !offer.sellerName
    || excludedSeller(offer.sellerName) || businessSellerName(offer.sellerName) || excludedSeller(offer.marketplaceSellerId) || !usable(offer, now, maxAgeHours)
    || offer.avitoRisks?.some(reason => /под\s*заказ|предзаказ|срок\s+поставки/i.test(reason))) return false;
  try {
    const url = avitoUrl(offer.url, { listing: true });
    const externalId = new URL(url).pathname.match(/_(\d+)$/)[1];
    return !known(offer.externalId) || String(offer.externalId) === externalId;
  } catch { return false; }
}

/**
 * Screen only USED MacBooks from PRIVATE sellers in Nizhny Novgorod. Compare
 * with the LOWEST asking price from at least three OTHER independent private
 * sellers, selecting one minimum per seller. Asking prices are not completed
 * sales or a resale/profit prediction. deltaPercent is after the reserve,
 * divided by that conservative reference. No network or input mutation occurs.
 */
export function calculateAvitoOpportunities(offers, {
  now = Date.now(), minDeltaRub = 10_000, minDeltaPercent = 10,
  maxAgeHours = 4, costReserveRub = 3_000,
} = {}) {
  if (!Array.isArray(offers)) throw new TypeError('offers must be an array');
  now = Number(now);
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new TypeError('now must be a valid timestamp');
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new TypeError('maxAgeHours must be positive');
  const minimumMinor = minor(minDeltaRub, 'minDeltaRub'), reserveMinor = minor(costReserveRub, 'costReserveRub');
  percentage(minDeltaPercent, 'minDeltaPercent');
  const all = uniqueListings(offers);
  const avito = all.filter(offer => offer.retailer === AVITO);
  const scoped = avito.filter(offer => inScope(offer, now, maxAgeHours));
  const byConfig = new Map();
  for (const offer of scoped) {
    if (offer.avitoRisks?.length) continue;
    const key = configKey(offer), items = byConfig.get(key) || [];
    items.push(offer); byConfig.set(key, items);
  }
  const candidates = [];
  let insufficientBaselineCount = 0;
  for (const offer of scoped) {
    const url = avitoUrl(offer.url, { listing: true });
    const externalId = new URL(url).pathname.match(/_(\d+)$/)[1];
    const independent = new Map();
    for (const peer of byConfig.get(configKey(offer)) || []) {
      const sellerId = String(peer.marketplaceSellerId);
      if (sellerId === String(offer.marketplaceSellerId) || !compatible(offer, peer)) continue;
      const prior = independent.get(sellerId);
      if (!prior || peer.price < prior.price || (peer.price === prior.price && timestamp(peer) > timestamp(prior))) independent.set(sellerId, peer);
    }
    const evidence = [...independent.values()].sort((a, b) => a.price - b.price || String(a.marketplaceSellerId).localeCompare(String(b.marketplaceSellerId))).map(peer => ({
      retailer: AVITO, sellerId: String(peer.marketplaceSellerId), marketplaceSellerId: String(peer.marketplaceSellerId),
      sellerName: peer.sellerName, listingId: peer.listingId || null, condition: 'used', marketplaceSellerType: 'private',
      url: avitoUrl(peer.url, { listing: true }), price: peer.price, observedAt: new Date(timestamp(peer)).toISOString(),
      cpuCores: peer.cpuCores ?? null, gpuCores: peer.gpuCores ?? null,
    }));
    if (evidence.length < 3) { insufficientBaselineCount++; continue; }
    const priceMinor = moneyMinor(offer.price), referenceMinor = moneyMinor(evidence[0].price);
    const grossMinor = referenceMinor - priceMinor, deltaMinor = grossMinor - reserveMinor;
    const deltaPercent = deltaMinor / referenceMinor * 100;
    if (deltaMinor < minimumMinor || deltaPercent < minDeltaPercent) continue;
    const reviewReasons = [...(offer.avitoRisks || [])];
    reviewReasons.push('Б/у от частного продавца: проверить состояние, аккумулятор, ремонт и комплектацию; цены других объявлений не подтверждают цену сделки или прибыль');
    const missingCores = ['cpuCores', 'gpuCores'].filter(name => !known(offer[name]) || evidence.some(peer => !known(peer[name])));
    if (missingCores.length) reviewReasons.push(`Проверить число ядер CPU/GPU: не все сопоставимые карточки указывают ${missingCores.join(', ')}`);
    const priceAnomaly = priceMinor < referenceMinor * 0.6;
    if (priceAnomaly) reviewReasons.push('Цена более чем на 40% ниже самого дешёвого сопоставимого объявления других частников; проверить цену и состояние вручную');
    const priceJump = typeof offer.previousPrice === 'number' && offer.previousPrice > 0 && Math.abs(offer.price / offer.previousPrice - 1) > 0.25;
    if (priceJump) reviewReasons.push('Цена изменилась более чем на 25%; требуется ручная проверка');
    const baselineSpread = evidence.at(-1).price > evidence[0].price * 1.4;
    if (baselineSpread) reviewReasons.push('Цены сопоставимых объявлений частников расходятся более чем на 40%; проверить состояние и конфигурации');
    const observedAt = new Date(timestamp(offer)).toISOString();
    candidates.push({
      listingId: offer.listingId || `avito:${externalId}`, externalId, url,
      title: offer.title || offer.rawTitle || '', sellerName: offer.sellerName,
      condition: 'used', marketplaceSellerType: 'private', sellerType: 'private',
      comparisonKind: 'used-asking-price-spread',
      comparisonNote: 'Разница с минимальной запрашиваемой ценой других независимых частных продавцов б/у MacBook после резерва расходов. Это цены объявлений, не состоявшихся сделок; цена перепродажи и прибыль не определены.',
      marketplaceSellerId: offer.marketplaceSellerId, matchedRetailer: null,
      configurationKey: configKey(offer), model: offer.model, chip: offer.chip,
      ramGb: offer.ramGb, storageGb: canonicalStorageGb(offer.storageGb), screenIn: offer.screenIn, color: offer.color,
      price: offer.price, referencePrice: referenceMinor / 100, grossDeltaRub: grossMinor / 100,
      costReserveRub, deltaRub: deltaMinor / 100, estimatedDeltaRub: deltaMinor / 100,
      deltaPercent: Math.round(deltaPercent * 100) / 100,
      shopCount: 0, peerCount: evidence.length, independentSellerCount: evidence.length,
      evidence, baselineMethod: 'lowest-independent-private-used-asking-price',
      observedAt, fetchedAt: observedAt,
      dedupKey: `avito:${externalId}:${priceMinor}`,
      requiresReview: reviewReasons.length > 0, reviewReasons, reasons: [...reviewReasons],
      alertEligible: !priceAnomaly && !priceJump && !baselineSpread && !offer.avitoRisks?.length,
      status: reviewReasons.length ? 'needs_review' : 'candidate',
    });
  }
  candidates.sort((a, b) => b.deltaRub - a.deltaRub || a.listingId.localeCompare(b.listingId));
  return {
    version: AVITO_OPPORTUNITIES_VERSION, generatedAt: new Date(now).toISOString(),
    thresholds: { minDeltaRub, minDeltaPercent, maxAgeHours, costReserveRub },
    note: 'Только б/у MacBook частных продавцов Нижнего Новгорода. Ориентир — минимальная запрашиваемая цена минимум трёх других независимых частников с сопоставимой конфигурацией и цветом. Разница после резерва расходов не является гарантированной ценой перепродажи, выручкой или прибылью; состояние и фактическую цену сделки нужно проверить.',
    candidates,
    summary: { avitoCount: avito.length, eligibleCount: scoped.length, insufficientBaselineCount, candidateCount: candidates.length, alertEligibleCount: candidates.filter(candidate => candidate.alertEligible).length },
  };
}
