export const AVITO = 'Авито НН';
const collator = new Intl.Collator('ru', { numeric: true });
const sellerId = offer => String(offer.marketplaceSellerId ?? '').trim();

// The source-level sellerId is shared by the whole marketplace. Columns must
// use the actual profile ID, never a display name or a matched website shop.
export function priceColumnKey(offer) {
  if (offer.retailer !== AVITO) return JSON.stringify(['store', offer.retailer]);
  const id = sellerId(offer);
  return id ? JSON.stringify(['avito', id]) : null;
}

export function avitoSellerColumns(offers) {
  const sellers = new Map();
  for (const offer of offers) {
    if (offer.retailer !== AVITO || !sellerId(offer)) continue;
    const key = priceColumnKey(offer), previous = sellers.get(key);
    // A renamed profile keeps its column. Prefer its latest observed name.
    if (!previous || (Date.parse(offer.fetchedAt) || 0) > (Date.parse(previous.fetchedAt) || 0)
      || ((Date.parse(offer.fetchedAt) || 0) === (Date.parse(previous.fetchedAt) || 0)
        && collator.compare(offer.sellerName || '', previous.sellerName || '') < 0)) sellers.set(key, offer);
  }
  const columns = [...sellers].map(([key, offer]) => ({
    key, name: AVITO, sellerId: sellerId(offer),
    label: offer.sellerName || 'Продавец', matchedRetailer: offer.matchedRetailer || null,
  })).sort((a, b) => collator.compare(a.label, b.label) || collator.compare(a.sellerId, b.sellerId));
  const names = new Map();
  for (const column of columns) {
    const name = column.label.normalize('NFKC').trim().toLocaleLowerCase('ru');
    const group = names.get(name) || [];
    group.push(column); names.set(name, group);
  }
  // Namesakes are visibly separate even when Avito gives them identical names.
  for (const group of names.values()) if (group.length > 1) {
    group.forEach((column, index) => { column.profileLabel = `Профиль ${index + 1}`; });
  }
  return columns;
}

export function groupOffersByPriceColumn(offers) {
  const groups = new Map();
  for (const offer of offers) {
    const key = priceColumnKey(offer);
    if (!key) continue;
    const items = groups.get(key) || [];
    items.push(offer); groups.set(key, items);
  }
  // Like the store columns, show the lowest price. Its Trust remains visible;
  // a low score must not silently hide that seller's cheapest advertisement.
  for (const items of groups.values()) items.sort((a, b) => a.price - b.price
    || (Date.parse(b.fetchedAt) || 0) - (Date.parse(a.fetchedAt) || 0)
    || String(a.listingId || a.url).localeCompare(String(b.listingId || b.url)));
  return groups;
}
