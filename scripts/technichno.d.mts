import type { Offer } from '../src/model.js';

export type TechnichnoStats = {
  pagesFetched: number;
  catalogPagesFetched: number;
  catalogCards: number;
  productsDiscovered: number;
  productsFetched: number;
  offers: number;
};

export function fetchTechnichnoOffers(options?: {
  fetchPage?: (url: string) => Promise<Response | string>;
  maxPages?: number;
}): Promise<{ offers: Offer[]; stats: TechnichnoStats }>;
