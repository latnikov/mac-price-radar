import { createHash } from 'node:crypto';

export const normalize = value => String(value ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
export const known = value => value !== undefined && value !== null && value !== '' && value !== 'unknown';
export const identityFields = ['model', 'chip', 'cpuCores', 'gpuCores', 'ramGb', 'storageGb', 'screenIn', 'color', 'keyboard', 'region', 'displayType', 'bundle'];
export const canonicalModelName = value => /^MacBook\s+Neo(?:\s+13(?:["”]|\s*дюйм)?)?$/i.test(String(value ?? '').trim()) ? 'MacBook Neo 13"' : value;
export const canonicalStorageGb = value => ({ 1024: 1000, 2048: 2000, 4096: 4000, 8192: 8000, 16384: 16000 })[Number(value)] ?? value;
export const inPublicSourceScope = offer => {
  if (offer?.retailer !== 'BSA') return true;
  const title = String(offer.title || offer.rawTitle || '');
  if (/\b(?:Mac\s*Mini|Mac\s*Studio|Studio\s*Display|Pro\s*Display)\b/i.test(title)) return false;
  if (/\biMac\b/i.test(title) && !/^iMac\b/i.test(String(offer.model || ''))) return false;
  return true;
};
export const canonicalUrl = value => {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|gclid|fbclid)/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href.replace(/\/$/, '');
  } catch { return null; }
};
export const stableId = (prefix, value) => `${prefix}_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;

// Integer minor units are the only arithmetic representation for money.
export function moneyMinor(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 && Number.isSafeInteger(Math.round(input * 100)) && Math.abs(input * 100 - Math.round(input * 100)) < 1e-6 ? Math.round(input * 100) : null;
  let value = String(input ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').trim();
  value = value.replace(/^(?:RUB|₽|руб\.?)\s*|\s*(?:RUB|₽|руб\.?)$/gi, '').trim();
  if (!value || /[^\d\s.,]/.test(value)) return null;
  if (/\s/.test(value)) {
    if (!/^\d{1,3}(?:[\s\u00a0\u202f]\d{3})+(?:[.,]\d{2})?$/.test(value)) return null;
    value = value.replace(/\s/g, '');
  }
  // A single separator followed by three digits is ambiguous (99.990).
  if (!/^\d+(?:[.,]\d{2})?$/.test(value)) return null;
  const [whole, fraction = '00'] = value.split(/[.,]/);
  const minor = Number(whole) * 100 + Number(fraction);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

export function variantKey(offer) {
  const parts = identityFields.map(field => normalize(offer[field]));
  if (identityFields.some(field => !known(offer[field])) || offer.qualityWarnings?.length) {
    parts.push('unresolved', normalize(offer.retailer), canonicalUrl(offer.url) || offer.url || offer.id || offer.name || 'catalog');
  }
  return parts.join('|');
}

export function assessOffer(offer, { now = Date.now(), staleAfterMs = 2 * 3600_000, expireAfterMs = 4 * 3600_000 } = {}) {
  const reasons = [...(offer.qualityWarnings || [])];
  if (/MacBook Air/i.test(offer.model || '') && offer.chip === 'M5' && offer.storageGb < 512) reasons.push('Конфликт спецификации Apple: Air M5 — SSD от 512 GB');
  if (/MacBook Pro/i.test(offer.model || '') && ((offer.chip === 'M5 Pro' && offer.storageGb < 1000) || (offer.chip === 'M5 Max' && offer.storageGb < 2000))) reasons.push('Конфликт спецификации Apple: SSD M5 Pro от 1 TB, M5 Max от 2 TB');
  if (offer.rejected || offer.validationStatus === 'rejected') reasons.push('Наблюдение отклонено при проверке');
  if (offer.latestAttempt?.rejected) reasons.push(`Последняя проверка отклонена: ${[...(offer.latestAttempt.qualityWarnings || []), ...(offer.latestAttempt.validationIssues || [])].join('; ')}`);
  const missing = identityFields.filter(field => !known(offer[field]));
  if (missing.length) reasons.push(`Не проверены характеристики: ${missing.join(', ')}`);
  if (offer.condition !== 'new') reasons.push(`Состояние: ${offer.condition || 'unknown'}`);
  if (moneyMinor(offer.price) === null) reasons.push('Цена отсутствует или некорректна');
  if (offer.dataKind === 'demo' || offer.isDemo) reasons.push('Демонстрационные данные');
  if (!canonicalUrl(offer.url) && offer.visibility !== 'private') reasons.push('Некорректная ссылка');
  if (offer.priceType !== 'full') reasons.push(`Тип цены: ${offer.priceType || 'unknown'}`);
  if (!known(offer.paymentMethod) || !known(offer.buyerType)) reasons.push('Не подтверждены условия оплаты/покупателя');
  if (offer.minimumQuantity !== 1) reasons.push('Не подтверждена цена одной штуки');
  if (!['InStock', 'source_reported', 'confirmed'].includes(offer.stock)) reasons.push(`Наличие: ${offer.stock || 'unknown'}`);
  const timestamp = Date.parse(offer.observedAt || offer.fetchedAt);
  const age = Number(now) - timestamp;
  const invalidTime = !Number.isFinite(age) || age < -60_000;
  const expired = (offer.validUntil && (!Number.isFinite(Date.parse(offer.validUntil)) || Date.parse(offer.validUntil) <= now)) || age > expireAfterMs;
  if (invalidTime) reasons.push('Нет достоверного времени наблюдения');
  else if (expired) reasons.push('Истёк срок актуальности');
  const priceStatus = invalidTime ? 'unknown' : expired ? 'expired' : age > staleAfterMs ? 'stale' : 'fresh';
  return { matchStatus: missing.length || reasons.some(reason => /Конфликт|Непроверенное|отклонено/.test(reason)) ? 'needs_review' : 'exact', priceStatus, qualityReasons: [...new Set(reasons)], marketEligible: reasons.length === 0, procurementEligible: false };
}
