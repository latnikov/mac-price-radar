import { writeFile, readFile } from 'node:fs/promises';
import { cheapest, type Offer } from './model.js';
import { technichno, rifastore } from './adapters.js';
const demo: Offer[] = JSON.parse(await readFile('data/offers.json','utf8'));
const live = process.env.LIVE === '1' ? (await Promise.all([technichno.fetchOffers(), rifastore.fetchOffers()])).flat() : [];
const offers = [...demo, ...live];
await writeFile('data/offers.json', JSON.stringify(offers, null, 2));
await writeFile('data/cheapest.json', JSON.stringify(cheapest(offers), null, 2));
console.log(`Wrote ${offers.length} offers and ${cheapest(offers).length} product groups`);
