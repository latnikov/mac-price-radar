import { AVITO, avitoGroupKey, visibleAvitoOffer } from './avito-policy.mjs';
import { catalogConfigurationKey, NIZHNY_RETAILERS, findColorPriceLowTrust, colorPriceTrustKey, belowMarketReason } from '../web/retail-analytics.js';

export const AVITO_MODEL_VERSION = 'seller-robust-logprice-v1';
const median = values => { const a = [...values].sort((x, y) => x - y), n = a.length; return n ? (a[Math.floor((n - 1) / 2)] + a[Math.floor(n / 2)]) / 2 : null; };
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const rounded = x => Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
const hours = (o, now) => Math.max(0, (now - Date.parse(o.fetchedAt)) / 3600000);
const sellerKey = o => o.retailer === AVITO ? (o.matchedRetailer ? `store:${o.matchedRetailer}` : `avito:${o.marketplaceSellerId}`) : `store:${o.retailer}`;
const known = value => value != null && value !== '' && value !== 'unknown';
const coreCompatible = (a, b) => ['cpuCores', 'gpuCores'].every(k => !known(a[k]) || !known(b[k]) || a[k] === b[k]);
const avitoColorConfigurationKey = o => `${catalogConfigurationKey(o)}|${o.condition === 'used' ? 'used' : 'new'}`;
const usable = (o, now) => o.visibility !== 'private' && Number.isFinite(o.price) && o.price > 0 && !o.rejected && !o.latestAttempt?.rejected && o.validationStatus !== 'rejected'
  && (o.condition !== 'used' || o.retailer === AVITO) && !['refurbished', 'open_box', 'display'].includes(o.condition)
  && !['OutOfStock', 'Discontinued', 'SoldOut'].includes(o.stock)
  && Number.isFinite(Date.parse(o.fetchedAt)) && Date.parse(o.fetchedAt) <= now + 60000 && hours(o, now) <= 4;

// Huber M-estimator in log-price space. One observation per independent seller;
// MAD scale with a 3% floor keeps identical-price samples numerically stable.
export function robustLogMarket(samples) {
  if (!samples.length) return null;
  const values = samples.map(s => Math.log(s.price));
  let mu = median(values);
  const sigma = Math.max(0.03, 1.4826 * median(values.map(x => Math.abs(x - mu))));
  let weights = [];
  for (let iteration = 0; iteration < 12; iteration++) {
    weights = values.map((x, i) => samples[i].weight * Math.min(1, 1.345 / Math.max(1e-9, Math.abs((x - mu) / sigma))));
    const sum = weights.reduce((s, w) => s + w, 0);
    const next = values.reduce((s, x, i) => s + x * weights[i], 0) / sum;
    if (Math.abs(next - mu) < 1e-7) { mu = next; break; }
    mu = next;
  }
  const sum = weights.reduce((s, w) => s + w, 0);
  const effectiveN = sum ** 2 / weights.reduce((s, w) => s + w ** 2, 0);
  // Kish N measures concentration, while information also decreases with age.
  const information = Math.min(effectiveN, sum);
  return { mu, sigma, effectiveN, information, variance: sigma ** 2 / Math.max(information, 0.1) };
}

function marketFor(offer, candidates, now) {
  const clusters = new Map();
  for (const item of candidates) {
    if (sellerKey(item) === sellerKey(offer) || !coreCompatible(offer, item)) continue;
    const key = sellerKey(item), group = clusters.get(key) || [];
    group.push(item); clusters.set(key, group);
  }
  const shops = [], peers = [];
  for (const values of clusters.values()) {
    // A matched retailer's website and Avito placements never count twice.
    const shop = values.filter(x => x.retailer !== AVITO);
    const selected = shop.length ? shop : values;
    const entry = { price: median([...new Set(selected.map(x => x.price))]), weight: Math.min(...selected.map(x => Math.exp(-hours(x, now) / 6))) };
    (shop.length ? shops : peers).push(entry);
  }
  const a = robustLogMarket(shops), b = robustLogMarket(peers);
  if (!a && !b) return null;
  // Shrink the Avito centre toward independent local stores; the extra 8%
  // channel variance acknowledges that store and marketplace prices differ.
  const priorVariance = a ? a.variance + 0.08 ** 2 : null;
  const precisionA = a ? 1 / priorVariance : 0, precisionB = b ? 1 / b.variance : 0;
  const posteriorVariance = 1 / (precisionA + precisionB);
  const mu = ((a?.mu || 0) * precisionA + (b?.mu || 0) * precisionB) * posteriorVariance;
  const sigma = Math.max(a?.sigma || 0.03, b?.sigma || 0.03);
  const predictiveSigma = Math.sqrt(sigma ** 2 + posteriorVariance);
  return { mu, sigma, predictiveSigma, effectiveN: (a?.information || 0) + (b?.information || 0),
    independentSellers: clusters.size, shopCount: shops.length, peerCount: peers.length,
    // Preserve the existing >5% rule using one vote per shop. With no shop
    // baseline, use the robust peer centre, only with at least three sellers.
    reference: shops.length >= 2 ? shops.reduce((s, x) => s + x.price, 0) / shops.length : peers.length >= 3 ? Math.exp(b.mu) : null,
    lower: Math.exp(mu - 1.96 * predictiveSigma), upper: Math.exp(mu + 1.96 * predictiveSigma) };
}

export function rankAvitoOffers(offers, { now = Date.now() } = {}) {
  const local = new Set(NIZHNY_RETAILERS), buckets = new Map();
  const websiteColorTrust = findColorPriceLowTrust(offers.filter(o => o.retailer !== AVITO && usable(o, now)), catalogConfigurationKey);
  const sellerColors = findColorPriceLowTrust(offers.filter(o => o.retailer === AVITO && visibleAvitoOffer(o) && usable(o, now))
    .map(o => ({ ...o, retailer: sellerKey(o) })), avitoColorConfigurationKey);
  for (const o of offers) {
    if ((!local.has(o.retailer) && o.retailer !== AVITO) || !usable(o, now) || !visibleAvitoOffer(o)) continue;
    if (o.avitoRisks?.length) continue;
    const colorKey = o.retailer === AVITO ? colorPriceTrustKey({ ...o, retailer: sellerKey(o) }, avitoColorConfigurationKey) : colorPriceTrustKey(o, catalogConfigurationKey);
    if ((o.retailer === AVITO ? sellerColors : websiteColorTrust).has(colorKey)) continue;
    const key = avitoGroupKey(o), group = buckets.get(key) || [];
    group.push(o); buckets.set(key, group);
  }
  const marketCache = new Map();
  const output = offers.filter(visibleAvitoOffer).map(o => {
    if (o.retailer !== AVITO) return o;
    const marketKey = [avitoGroupKey(o), sellerKey(o), o.cpuCores, o.gpuCores].join('\u0000');
    if (!marketCache.has(marketKey)) marketCache.set(marketKey, marketFor(o, buckets.get(avitoGroupKey(o)) || [], now));
    const market = marketCache.get(marketKey);
    const reasons = [...(o.avitoRisks || [])], age = hours(o, now);
    const colorTrust = sellerColors.get(colorPriceTrustKey({ ...o, retailer: sellerKey(o) }, avitoColorConfigurationKey));
    if (colorTrust) reasons.push(colorTrust.reason);
    if (market?.reference != null && o.price < market.reference * 0.95) reasons.push(belowMarketReason(o.price, market.reference));
    const z = market ? (Math.log(o.price) - market.mu) / market.predictiveSigma : null;
    if (z != null && Math.abs(z) > 3.5) reasons.push('Цена существенно отличается от сопоставимых предложений');
    if (!Number.isFinite(age) || age > 4) reasons.push('Проверка старше четырёх часов');
    if (o.previousPrice > 0 && Math.abs(o.price / o.previousPrice - 1) > 0.25) reasons.push('Изменение цены более чем на 25%; требуется проверка');
    if (o.latestAttempt?.rejected) reasons.push('Последняя проверка не подтвердила карточку; показана прежняя цена');
    const match = ['cpuCores', 'gpuCores', 'keyboard'].filter(k => known(o[k])).length / 3;
    const freshness = Number.isFinite(age) ? Math.exp(-age / 6) : 0;
    const support = market ? 1 - Math.exp(-market.effectiveN / 3) : 0;
    const priceFit = z == null ? 0.5 : Math.exp(-0.5 * Math.max(0, Math.abs(z) - 1) ** 2);
    let score = Math.round(100 * (0.4 * priceFit + 0.25 * freshness + 0.25 * support + 0.1 * match));
    if (reasons.length) score = Math.min(49, Math.max(0, score - reasons.length * 12));
    const sparse = !market || market.independentSellers < 3 || market.effectiveN < 2;
    if (sparse) score = Math.min(score, 69);
    const level = reasons.length || score < 50 ? 'low' : score >= 80 && !sparse ? 'high' : 'medium';
    if (sparse) reasons.push('Мало независимых сопоставимых цен');
    return { ...o, avitoRank: { version: AVITO_MODEL_VERSION, score, level, reasons: [...new Set(reasons)],
      referencePrice: market?.reference != null ? Math.round(market.reference) : null,
      marketPrice: market ? Math.round(Math.exp(market.mu)) : null,
      modelRange: market ? [Math.round(market.lower), Math.round(market.upper)] : null,
      independentSellers: market?.independentSellers || 0, effectiveSellers: rounded(market?.effectiveN || 0),
      z: rounded(z), components: { priceFit: rounded(priceFit), freshness: rounded(freshness), support: rounded(support), match: rounded(match) },
      adjustedPrice: Math.round(o.price / Math.sqrt(Math.max(0.1, score / 100))) } };
  });
  const rankedGroups = new Map();
  for (const o of output) if (o.retailer === AVITO) { const k = avitoGroupKey(o), list = rankedGroups.get(k) || []; list.push(o); rankedGroups.set(k, list); }
  for (const list of rankedGroups.values()) {
    list.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.avitoRank.level] - ({ high: 0, medium: 1, low: 2 })[b.avitoRank.level]
      || a.avitoRank.adjustedPrice - b.avitoRank.adjustedPrice || String(a.listingId).localeCompare(String(b.listingId)));
    list.forEach((o, i) => { o.avitoRank.position = i + 1; });
  }
  return output;
}
