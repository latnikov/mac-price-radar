import { readFile, writeFile } from 'node:fs/promises';
const offers = JSON.parse(await readFile('data/offers.json', 'utf8'));
const catalog = JSON.parse(await readFile('data/catalog.json', 'utf8'));
const decode = s => s.replace(/&nbsp;|&#160;/g,' ').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#8381;|₽|руб\.?/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const price = s => { const n=decode(s).replace(/\s/g,'').match(/\d[\d,.]*/); return n ? Number(n[0].replace(/,/g,'')) : null; };
function parseProduct(title, url, retailer, amount) {
  const t=decode(title).replace(/\([^)]*\)/g,'').replace(/, английская раскладка.*$/i,'').trim();
  if(!amount) return null;
  const combined=`${t} ${url}`;
  const chip=(combined.match(/\b(A18 Pro|M[45](?:\s+(?:Pro|Max))?)\b/i)||[])[1];
  const modelMatch=t.match(/(MacBook\s+(?:Air|Pro|Neo)(?:\s+(?:13|14|15|16)\s*(?:["”]|дюйм)?|\s*\d{2}\s*Early\s*\d{4})?)/i);
  if(!chip||!modelMatch) return null;
  const model=modelMatch[1].replace(/Early\s*\d{4}/i,'').replace(/\s*дюйм/i,'').replace(/\s*["”]/,'"').replace(/\s+/g,' ').trim();
  const ramMatch=combined.match(/(?:RAM\s*)?(\d+)\s*(?:ГБ|GB|gb)/i);
  const storageMatches=[...combined.matchAll(/(\d+)\s*(?:ТБ|TB|тб|tb|ГБ|GB|гб|gb)/gi)].map(m=>({n:Number(m[1]),tb:/тб|tb/i.test(m[0])}));
  const storage=storageMatches.length ? storageMatches.at(-1) : null;
  const ramGb=ramMatch ? Number(ramMatch[1]) : null;
  const storageGb=storage ? storage.n*(storage.tb?1024:1) : null;
  if(!ramGb||!storageGb) return null;
  const colorMap=[['Sky Blue','sky blue|sky-blue|небесно-голуб'],['Midnight','midnight|полуноч'],['Starlight','starlight|сияющ'],['Silver','silver|серебрист'],['Space Black','space black|space-black|черн']];
  const color=(colorMap.find(([,pattern])=>new RegExp(pattern,'i').test(combined))||[])[0]||'unknown';
  return {retailer,title:t,url,price:amount,currency:'RUB',fetchedAt:new Date().toISOString(),condition:'new',model,chip:chip.replace(/\s+/g,' '),ramGb,storageGb,color};
}
async function fetchLive() {
  const out=[];
  const rifaHome=await (await fetch('https://rifastore.ru/')).text();
  const rifaPaths=[...new Set([...rifaHome.matchAll(/href="(\/categories\/macbook-[^"]+)"/gi)].map(m=>m[1]))];
  for(const path of rifaPaths){const html=await (await fetch('https://rifastore.ru'+path)).text();const re=/<a[^>]+class="products-view-name-link"[^>]*title="([^"]+)"[^>]*>.*?<div class="price-number">([^<]+)/gis;for(const m of html.matchAll(re)){const href=(m[0].match(/href="(https:\/\/rifastore\.ru\/products\/[^\"]+)/)||[])[1];const o=parseProduct(m[1],href||'https://rifastore.ru'+path,'RifaStore',price(m[2]));if(o)out.push(o)}}
  for(const path of ['/catalog/mac/macbook-pro/','/catalog/mac/macbook-air-13-15/','/catalog/mac/macbook-neo/']){const html=await (await fetch('https://nn.technichno.ru'+path)).text();const re=/<a[^>]+href="([^"]+)"[^>]+class="product-card__name[^>]*>[\s\S]*?<p[^>]*>([^<]+)<\/p>[\s\S]*?<span class="product-card-price__current[^"]*">([\s\S]*?)<\/span>/gi;for(const m of html.matchAll(re)){const o=parseProduct(m[2],'https://nn.technichno.ru'+m[1],'Technichno',price(m[3]));if(o)out.push(o)}}
  return out;
}
let live=[]; if(process.env.LIVE==='1'){try{live=await fetchLive();console.log(`Fetched ${live.length} live offers`)}catch(e){console.warn(`Live fetch failed: ${e.message}`)}}
const allOffers=[...new Map([...offers,...live].map(o=>[`${o.retailer}|${o.url}|${o.price}`,o])).values()];
const key = o => [o.model,o.chip,o.ramGb,o.storageGb,o.color].map(x => String(x ?? '').toLowerCase().replace(/[^a-zа-я0-9]+/gi, ' ').trim()).join('|');
const eligible = allOffers.filter(o => o.price != null && o.condition === 'new' && o.currency === 'RUB');
const byKey = new Map();
for (const offer of eligible) { const k=key(offer); byKey.set(k, [...(byKey.get(k)||[]), offer]); }
const result = catalog.flatMap(item => item.colors.map(color => {
  const productKey = key({model:item.name,chip:item.chip,ramGb:item.ramGb,storageGb:item.storageGb,color});
  const items = [...(byKey.get(productKey)||[])].sort((a,b)=>a.price-b.price);
  return {productKey, product:item, color, offers:items, best:items[0]||null};
}));
await writeFile('data/cheapest.json', JSON.stringify(result,null,2));
console.log(`Built ${result.length} catalog rows from ${allOffers.length} offers`);
