export function normalize(value: unknown): string;
export function variantKey(offer: object): string;
export function assessOffer(offer: object, options?: object): { marketEligible: boolean; matchStatus: string; priceStatus: string; qualityReasons: string[]; procurementEligible: boolean };
export function moneyMinor(value: unknown): number | null;
