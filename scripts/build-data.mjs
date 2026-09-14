import { readFile, writeFile } from 'node:fs/promises';
const offers = JSON.parse(await readFile('data/offers.json', 'utf8'));
const catalog = JSON.parse(await readFile('data/catalog.json', 'utf8'));
const decode = s => s.replace(/&nbsp;|&#160;/g,' ').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#8381;|₽|руб\.?/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const price = s => { const n=decode(s).replace(/\s/g,'').match(/\d[\d,.]*/); return n ? Number(n[0].replace(/,/g,'')) : null; };
function parseProduct(title, url, retailer, amount) {
  const t=decode(title).replace(/\([^)]*\)/g,'').replace(/, английская раскладка.*$/i,'').trim();
  const m=t.match(/(MacBook (?:Air|Pro|Neo)[^,]*).*?\b(M[45](?: Pro| Max)?)\b.*?RAM\s*(\d+)\s*ГБ.*?SSD\s*(\d+)\s*(?:ГБ|ТБ)/i);
  if(!m||!amount) return null;
  const model=m[1].replace(/,?\s*$/,'').replace(/\s+/g,' '); const gb=m[4].toLowerCase().includes('тб')?Number(m[4])*1024:Number(m[4]);
  const color=(t.match(/,\s*(Midnight|Starlight|Silver|Sky Blue|Space Black|небесно-голубой|полуночный черный|сияющая звезда|серебристый)/i)||[])[1]||'unknown';
  return {retailer,title:t,url,price:amount,currency:'RUB',fetchedAt:new Date().toISOString(),condition:'new',model,chip:m[2],ramGb:Number(m[3]),storageGb:gb,color};
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
const allOffers=[...offers,...live];
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
