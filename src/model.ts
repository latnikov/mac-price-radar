export type Condition = 'new' | 'used' | 'display' | 'refurbished' | 'unknown';
export type Offer = {
  retailer: string; title: string; url: string; price: number | null; currency: 'RUB';
  fetchedAt: string; stock?: string; condition: Condition; warranty?: string;
  sku?: string; model?: string; chip?: string; ramGb?: number; storageGb?: number; screenIn?: number;
};

export const normalize = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
export function key(o: Offer) {
  if (o.sku) return `sku:${normalize(o.sku)}`;
  return [o.model, o.chip, o.ramGb, o.storageGb, o.screenIn].map(x => normalize(String(x ?? ''))).join('|');
}
export function cheapest(offers: Offer[]) {
  const eligible = offers.filter(o => o.price != null && o.condition === 'new' && o.currency === 'RUB');
  const groups = new Map<string, Offer[]>();
  for (const offer of eligible) { const k = key(offer); groups.set(k, [...(groups.get(k) ?? []), offer]); }
  return [...groups].map(([productKey, items]) => ({ productKey, best: items.reduce((a,b) => (a.price! <= b.price! ? a : b)), offers: items.sort((a,b) => a.price! - b.price!) }));
}
