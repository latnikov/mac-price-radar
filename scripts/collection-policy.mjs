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
  return { status, observations, error: errors.join('; ').slice(0, 3000) || (degraded ? 'Покрытие упало более чем на 50%; сохранены предыдущие цены' : null), counts: { previous: prior.length, parsed: priced.length, published: observations.filter(o => o.price > 0 && o.validationStatus !== 'rejected').length } };
}
