import { canonicalModelName, canonicalStorageGb, canonicalUrl, known, moneyMinor, normalize } from './domain.mjs';
import { AVITO, avitoUrl, excludedSeller } from './avito-policy.mjs';
import { NIZHNY_RETAILERS } from '../web/retail-analytics.js';

export const AVITO_OPPORTUNITIES_VERSION = 'independent-shop-spread-v1';
const BASIC_FIELDS = ['model', 'chip', 'screenIn', 'ramGb', 'storageGb', 'color'];
const EXTRA_FIELDS = ['cpuCores', 'gpuCores', 'keyboard', 'region', 'displayType', 'bundle'];
const AVAILABLE = new Set(['InStock', 'source_reported', 'confirmed']);
const LOCAL_SHOPS = new Set(NIZHNY_RETAILERS);
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

function usable(offer, now, maxAgeHours, { allowUsed = false } = {}) {
  const at = timestamp(offer);
  return offer && offer.visibility !== 'private' && offer.currency === 'RUB'
    && typeof offer.price === 'number' && moneyMinor(offer.price) !== null
    && (offer.condition === 'new' || (allowUsed && offer.condition === 'used')) && offer.priceType === 'full'
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

// Collapse aliases connected by either a retailer name OR a real seller ID.
// Marketplace-wide IDs are never used as independent shop identities.
function independentShops(offers) {
  const groups = [];
  for (const offer of offers) {
    const aliases = new Set([`retailer:${normalize(offer.retailer)}`]);
    if (known(offer.sellerId) && offer.sellerId !== 'avito:marketplace') aliases.add(`seller:${offer.sellerId}`);
    const related = groups.filter(group => [...aliases].some(alias => group.aliases.has(alias)));
    const group = { aliases, offers: [offer] };
    for (const previous of related) {
      for (const alias of previous.aliases) group.aliases.add(alias);
      group.offers.push(...previous.offers);
      groups.splice(groups.indexOf(previous), 1);
    }
    groups.push(group);
  }
  return groups;
}

/**
 * Screen Avito listings for a potential spread against the LOWEST independent
 * local shop price. This is a lead for human review, never a sale-price promise
 * or a profit calculation. deltaPercent is after the reserve, divided by the
 * reference retail price. No network, persistence or input mutation occurs.
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
  const shops = all.filter(offer => LOCAL_SHOPS.has(offer.retailer)
    && (!offer.sourceType || offer.sourceType === 'website') && usable(offer, now, maxAgeHours)
    && !/(^|\.)avito\.ru$/i.test(new URL(offer.url).hostname));
  const shopGroups = independentShops(shops), byConfig = new Map();
  for (const group of shopGroups) for (const offer of group.offers) {
    const key = configKey(offer), items = byConfig.get(key) || [];
    items.push({ offer, group }); byConfig.set(key, items);
  }
  const avito = all.filter(offer => offer.retailer === AVITO);
  const candidates = [];
  let eligibleCount = 0, insufficientBaselineCount = 0;
  for (const offer of avito) {
    if (offer.sourceCity !== 'Нижний Новгород' || !offer.marketplaceSellerId || !offer.sellerName
      || excludedSeller(offer.sellerName) || excludedSeller(offer.marketplaceSellerId) || excludedSeller(offer.matchedRetailer)
      || !usable(offer, now, maxAgeHours, { allowUsed: true })
      || offer.avitoRisks?.some(reason => /под\s*заказ|предзаказ|срок\s+поставки/i.test(reason))) continue;
    let url;
    try { url = avitoUrl(offer.url, { listing: true }); } catch { continue; }
    const externalId = new URL(url).pathname.match(/_(\d+)$/)[1];
    if (known(offer.externalId) && String(offer.externalId) !== externalId) continue;
    eligibleCount++;
    const independent = new Map();
    for (const { offer: shop, group } of byConfig.get(configKey(offer)) || []) {
      if (!compatible(offer, shop)) continue;
      if (offer.matchedRetailer && group.aliases.has(`retailer:${normalize(offer.matchedRetailer)}`)) continue;
      if (known(offer.sellerId) && offer.sellerId !== 'avito:marketplace' && group.aliases.has(`seller:${offer.sellerId}`)) continue;
      const prior = independent.get(group);
      if (!prior || shop.price < prior.price || (shop.price === prior.price && timestamp(shop) > timestamp(prior))) independent.set(group, shop);
    }
    const evidence = [...independent.values()].sort((a, b) => a.price - b.price || a.retailer.localeCompare(b.retailer)).map(shop => ({
      retailer: shop.retailer, sellerId: shop.sellerId || null, listingId: shop.listingId || null,
      url: canonicalUrl(shop.url), price: shop.price, observedAt: new Date(timestamp(shop)).toISOString(),
      cpuCores: shop.cpuCores ?? null, gpuCores: shop.gpuCores ?? null,
    }));
    if (evidence.length < 2) { insufficientBaselineCount++; continue; }
    const priceMinor = moneyMinor(offer.price), referenceMinor = moneyMinor(evidence[0].price);
    const grossMinor = referenceMinor - priceMinor, deltaMinor = grossMinor - reserveMinor;
    const deltaPercent = deltaMinor / referenceMinor * 100;
    if (deltaMinor < minimumMinor || deltaPercent < minDeltaPercent) continue;
    const reviewReasons = [...(offer.avitoRisks || [])];
    if (offer.condition === 'used') reviewReasons.push('Б/у: сравнение с новым товаром показывает только скидку; проверить состояние, аккумулятор, ремонт и реальную цену перепродажи');
    const missingCores = ['cpuCores', 'gpuCores'].filter(name => !known(offer[name]) || evidence.some(shop => !known(shop[name])));
    if (missingCores.length) reviewReasons.push(`Проверить число ядер CPU/GPU: не все сопоставимые карточки указывают ${missingCores.join(', ')}`);
    const priceAnomaly = priceMinor < referenceMinor * 0.6;
    if (priceAnomaly) reviewReasons.push('Цена более чем на 40% ниже самой низкой цены магазинов; проверить цену и комплектацию вручную');
    const priceJump = typeof offer.previousPrice === 'number' && offer.previousPrice > 0 && Math.abs(offer.price / offer.previousPrice - 1) > 0.25;
    if (priceJump) reviewReasons.push('Цена изменилась более чем на 25%; требуется ручная проверка');
    const baselineSpread = evidence.at(-1).price > evidence[0].price * 1.4;
    if (baselineSpread) reviewReasons.push('Цены сопоставимых магазинов расходятся более чем на 40%; проверить конфигурации');
    const observedAt = new Date(timestamp(offer)).toISOString();
    candidates.push({
      listingId: offer.listingId || `avito:${externalId}`, externalId, url,
      title: offer.title || offer.rawTitle || '', sellerName: offer.sellerName,
      condition: offer.condition,
      comparisonKind: offer.condition === 'used' ? 'discount-from-new-retail' : 'potential-retail-spread',
      comparisonNote: offer.condition === 'used'
        ? 'Скидка к цене нового MacBook после резерва расходов; цена перепродажи б/у не определена, прибыль не рассчитана.'
        : 'Потенциальная разница с ценой нового MacBook после резерва расходов; не гарантированная прибыль.',
      marketplaceSellerId: offer.marketplaceSellerId, matchedRetailer: offer.matchedRetailer || null,
      configurationKey: configKey(offer), model: offer.model, chip: offer.chip,
      ramGb: offer.ramGb, storageGb: canonicalStorageGb(offer.storageGb), screenIn: offer.screenIn, color: offer.color,
      price: offer.price, referencePrice: referenceMinor / 100, grossDeltaRub: grossMinor / 100,
      costReserveRub, deltaRub: deltaMinor / 100, estimatedDeltaRub: deltaMinor / 100,
      deltaPercent: Math.round(deltaPercent * 100) / 100,
      shopCount: evidence.length, evidence, baselineMethod: 'lowest-independent-local-shop',
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
    note: 'Сравнение с минимальной ценой нового MacBook в независимых магазинах после резерва расходов. Для б/у это только скидка к новому товару. Это не гарантированная цена продажи, выручка или чистая прибыль; перед покупкой проверить состояние, объявление и затраты.',
    candidates,
    summary: { avitoCount: avito.length, eligibleCount, insufficientBaselineCount, candidateCount: candidates.length, alertEligibleCount: candidates.filter(candidate => candidate.alertEligible).length },
  };
}
