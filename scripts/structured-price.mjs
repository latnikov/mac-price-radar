import { canonicalUrl, moneyMinor, normalize } from './domain.mjs';

const decodeEntities = value => String(value).replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|nbsp|lt|gt);/gi, (entity, code) => {
  const names = { quot: '"', apos: "'", amp: '&', nbsp: ' ', lt: '<', gt: '>' };
  if (!code.startsWith('#')) return names[code.toLowerCase()];
  const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
  return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
});

// Price evidence must belong to the current Product, never a page-wide minimum.
export function extractProductPrice(html, pageUrl) {
  const products = [];
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if ([].concat(value['@type'] || []).includes('Product')) products.push(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  const parseErrors = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1])); } catch { parseErrors.push('Некорректный JSON-LD'); }
  }
  const title = decodeEntities((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/<[^>]+>/g, '')).trim();
  const sameUrl = value => {
    try { return canonicalUrl(new URL(typeof value === 'object' ? value['@id'] : value, pageUrl).href) === canonicalUrl(pageUrl); }
    catch { return false; }
  };
  const candidates = products.filter(product => sameUrl(product.url || product['@id']) || (!product.url && !product['@id'] && title && normalize(product.name) === normalize(title)));
  if (candidates.length !== 1) return { error: 'Не найден однозначный Product текущей карточки', title, warnings: parseErrors };
  const product = candidates[0];
  const offers = [].concat(product.offers || []).filter(offer => offer && offer['@type'] === 'Offer' && (!offer.url || sameUrl(offer.url)));
  // Multiple prices can mean installments, volume tiers or buyer conditions.
  if (offers.length !== 1) return { error: 'Неоднозначные условия или число Offer', title: product.name || title };
  const offer = offers[0];
  const amount = moneyMinor(offer.price);
  if (!amount || amount < 100_000 || amount > 200_000_000) return { error: 'Некорректная цена Product Offer', title: product.name || title };
  const priceSpecifications = offer.priceSpecification == null ? [] : [].concat(offer.priceSpecification);
  const conditionalSpecification = priceSpecifications.length > 1 || priceSpecifications.some(specification => {
    if (!specification || typeof specification !== 'object') return true;
    const specifiedAmount = specification.price == null ? amount : moneyMinor(specification.price);
    const conditionalFields = ['billingDuration', 'billingIncrement', 'eligibleQuantity', 'eligibleTransactionVolume', 'referenceQuantity', 'unitCode', 'unitText', 'minPrice', 'maxPrice'];
    return specifiedAmount !== amount || conditionalFields.some(field => specification[field] != null);
  });
  // Some stores duplicate the full product price in PriceSpecification only to
  // disclose VAT. That is still the same cash price, not a separate tariff.
  if (conditionalSpecification || offer.eligibleQuantity || offer.eligibleCustomerType) return { error: 'Цена содержит отдельные условия, требуется разбор', title: product.name || title };
  const condition = String(offer.itemCondition || product.itemCondition || '').split('/').at(-1);
  return {
    title: product.name || title, amount: amount / 100,
    metadata: {
      rawPrice: String(offer.price), currency: 'RUB',
      condition: ({ NewCondition: 'new', UsedCondition: 'used', RefurbishedCondition: 'refurbished', DamagedCondition: 'used' })[condition] || 'unknown',
      stock: String(offer.availability || 'unknown').split('/').at(-1), priceType: 'full',
      validUntil: offer.priceValidUntil ? `${offer.priceValidUntil}T23:59:59.000Z` : null,
      evidence: { method: 'jsonld-product-offer-v1', productUrl: product.url || product['@id'] || null, productName: product.name, offer },
    },
  };
}
