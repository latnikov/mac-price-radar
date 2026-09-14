import type { Offer } from './model.js';

export interface RetailerAdapter { name: string; url: string; fetchOffers(): Promise<Offer[]>; }
const now = () => new Date().toISOString();
const rub = (s: string) => { const n = s.replace(/\s/g,'').match(/[0-9]+/); return n ? Number(n[0]) : null; };

export function textOffers(retailer: string, html: string, baseUrl: string): Offer[] {
  // Conservative fallback: useful for simple server-rendered cards. Product-specific
  // selectors belong in adapters because retailers change markup independently.
  const out: Offer[] = [];
  const re = /(?:MacBook[^<]{0,180})/gi;
  for (const m of html.match(re) ?? []) {
    const price = rub(m);
    if (price && price > 10000) out.push({ retailer, title: m.replace(/\s+/g,' ').trim(), url: baseUrl, price, currency:'RUB', fetchedAt:now(), condition:'new' });
  }
  return out;
}

export const technichno: RetailerAdapter = { name:'Technichno', url:'https://nn.technichno.ru/', async fetchOffers(){ const r=await fetch(this.url); return textOffers(this.name, await r.text(), this.url); } };
export const rifastore: RetailerAdapter = { name:'RifaStore', url:'https://rifastore.ru/', async fetchOffers(){ const r=await fetch(this.url); return textOffers(this.name, await r.text(), this.url); } };
