import { readFile, writeFile } from 'node:fs/promises';
const offers = JSON.parse(await readFile('data/offers.json', 'utf8'));
const eligible = offers.filter(o => o.price != null && o.condition === 'new' && o.currency === 'RUB');
const key = o => o.sku || [o.model,o.chip,o.ramGb,o.storageGb,o.screenIn].map(x => String(x ?? '').toLowerCase().replace(/[^a-zа-я0-9]+/gi, ' ').trim()).join('|');
const groups = new Map();
for (const offer of eligible) { const k=key(offer); groups.set(k, [...(groups.get(k)||[]), offer]); }
const result=[...groups].map(([productKey,items])=>({productKey,best:[...items].sort((a,b)=>a.price-b.price)[0],offers:[...items].sort((a,b)=>a.price-b.price)}));
await writeFile('data/cheapest.json', JSON.stringify(result,null,2));
console.log(`Built ${result.length} product groups from ${offers.length} offers`);
