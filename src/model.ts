// The CLI and master-table use the same identity and quality rules.
import { variantKey, assessOffer } from '../scripts/domain.mjs';
export { normalize } from '../scripts/domain.mjs';
export type Condition = 'new' | 'used' | 'display' | 'refurbished' | 'open_box' | 'unknown';
export type Offer = {
  retailer: string; title: string; url: string; price: number | null; currency: string;
  fetchedAt: string; stock?: string; condition: Condition; warranty?: string;
  sku?: string; model?: string; chip?: string; ramGb?: number; storageGb?: number; screenIn?: number;
  color?: string; cpuCores?: number | null; gpuCores?: number | null; keyboard?: string; region?: string;
  displayType?: string; bundle?: string; priceType?: string; paymentMethod?: string; buyerType?: string; minimumQuantity?: number;
  [field: string]: unknown;
};
export const key = (offer: Offer): string => variantKey(offer);
export function cheapest(offers: Offer[]) {
  const groups = new Map<string, Offer[]>();
  for (const offer of offers) {
    if (!assessOffer(offer).marketEligible) continue;
    const k = key(offer); groups.set(k, [...(groups.get(k) ?? []), offer]);
  }
  return [...groups].map(([productKey, items]) => ({ productKey, best: items.reduce((a,b) => a.price! <= b.price! ? a : b), offers: items.sort((a,b) => a.price! - b.price!) }));
}
