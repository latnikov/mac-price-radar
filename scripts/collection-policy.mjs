import { canonicalUrl } from './domain.mjs';
// Discovery uses known card addresses, independently of price validation.
export function knownProductUrls(offers, retailer) {
  const root = { BigGeek: 'https://biggeek.ru/products/', 'Айфория': 'https://iphoriya.ru/product/' }[retailer];
  return new Set(offers.filter(o => o.retailer === retailer && o.visibility !== 'private')
    .map(o => canonicalUrl(o.url)).filter(url => root && url?.startsWith(root)));
}
function uniquePricedCards(offers) {
  const cards = new Map();
  for (const offer of offers) {
    if (!Number.isFinite(offer.price) || offer.price <= 0) continue;
    const key = canonicalUrl(offer.url) || offer.listingId;
    if (!key) continue;
    const prior = cards.get(key);
    if (!prior || (Date.parse(offer.fetchedAt) || 0) >= (Date.parse(prior.fetchedAt) || 0)) cards.set(key, offer);
  }
  return [...cards.values()];
}
export function summarizeCollectionErrors(errors) {
  const httpCounts = new Map(), other = [];
  for (const value of errors) {
    const error = String(value || '').trim();
    const match = error.match(/^HTTP\s+(\d{3}):\s+https?:\/\//i);
    if (match) httpCounts.set(match[1], (httpCounts.get(match[1]) || 0) + 1);
    else if (error) other.push(error);
  }
  const summaries = [...httpCounts].map(([status, count]) => status === '503'
    ? `Магазин временно отклонил запросы: ${count} (HTTP 503)`
    : status === '429'
      ? `Магазин ограничил частоту запросов: ${count} (HTTP 429)`
      : `Не загрузились карточки: ${count} (HTTP ${status})`);
  return [...summaries, ...other].join('; ').slice(0, 3000);
}
export function assessCollection(previous, incoming, errors = []) {
  const priced = uniquePricedCards(incoming);
  const prior = uniquePricedCards(previous);
  const degraded = prior.length >= 10 && priced.length < prior.length * 0.5;
  const status = !priced.length ? 'failed' : degraded ? 'degraded' : errors.length ? 'partial' : 'success';
  const byUrl = new Map(prior.map(offer => [canonicalUrl(offer.url), offer]));
  const observations = incoming.map(offer => {
    const warnings = [...(offer.qualityWarnings || [])];
    if (status === 'failed' || degraded) warnings.push('Запуск источника не прошёл проверку покрытия');
    const old = byUrl.get(canonicalUrl(offer.url));
    const anomaly = old && offer.price > 0 && (offer.price < old.price * 0.6 || offer.price > old.price * 1.8);
    if (anomaly) warnings.push(`Аномальное изменение цены: ${old.price} → ${offer.price}; требуется подтверждение`);
    return { ...offer, qualityWarnings: warnings, ...(anomaly || degraded || status === 'failed' ? { validationStatus: 'rejected' } : {}) };
  });
  return { status, observations, error: summarizeCollectionErrors(errors) || (degraded ? 'Покрытие упало более чем на 50%; сохранены предыдущие цены' : null), counts: { previous: prior.length, parsed: priced.length, published: observations.filter(o => o.price > 0 && o.validationStatus !== 'rejected').length } };
}
