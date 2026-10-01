export const PHONE_FAMILIES = {
  'iphone-18-pro': 'iPhone 18 Pro', 'iphone-18-pro-max': 'iPhone 18 Pro Max',
  'iphone-17-pro': 'iPhone 17 Pro', 'iphone-17-pro-max': 'iPhone 17 Pro Max',
};
export const isPhone = offer => /^iPhone\b/i.test(String(offer?.model || offer?.title || ''));
export function phoneModelName(value) {
  const match = String(value || '').match(/^iPhone\s+(17|18)\s+Pro(?:\s+(Max))?\b/i);
  return match ? `iPhone ${match[1]} Pro${match[2] ? ' Max' : ''}` : null;
}
export function productFamily(offer) {
  const name = String(offer.model || offer.title || '');
  const phone = phoneModelName(name);
  if (phone) return Object.keys(PHONE_FAMILIES).find(key => PHONE_FAMILIES[key] === phone);
  return /^Mac mini/i.test(name) ? 'mini' : /^Mac Studio/i.test(name) ? 'studio' : /MacBook\s+Air/i.test(name) ? 'air'
    : /MacBook\s+Pro/i.test(name) ? 'pro' : /MacBook\s+Neo/i.test(name) ? 'neo' : /^iMac\b/i.test(name) ? 'imac' : 'other';
}
export const productScreen = offer => isPhone(offer) ? null : offer.screenIn || Number(String(offer.model || '').match(/\b(13|14|15|16|24|27)\b/)?.[1]) || null;
export const storageLabel = value => value >= 1024 && value % 1024 === 0 ? `${value / 1024} TB` : value >= 1000 && value % 1000 === 0 ? `${value / 1000} TB` : value ? `${value} GB` : '—';
export function configurationBadges(offer) {
  const phone = isPhone(offer);
  return [!phone && productScreen(offer) ? `${productScreen(offer)}″` : null,
    !phone && offer.chip && offer.chip !== 'unknown' ? offer.chip : null,
    !phone && offer.ramGb ? `RAM ${offer.ramGb} GB` : null,
    offer.storageGb ? `${phone ? '' : 'SSD '}${storageLabel(offer.storageGb)}` : null,
    phone ? offer.simType && offer.simType !== 'unknown' ? offer.simType : 'SIM не указан' : null,
  ].filter(Boolean);
}
