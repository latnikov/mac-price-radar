import { readFile, writeFile } from 'node:fs/promises';
import { parseProduct, price } from './offer-normalization.mjs';
import { findRifaCategoryUrls, findRifaNextPage, parseRifaCategory } from './rifastore.mjs';
const offers = JSON.parse(await readFile('data/offers.json', 'utf8'));
const catalog = JSON.parse(await readFile('data/catalog.json', 'utf8'));
const reference=await readFile('apps-script/reference.gs','utf8').catch(()=> '');
const bigGeekSlugs=Object.fromEntries([...reference.matchAll(/['"]([A-Z0-9]+)['"]\s*:\s*['"]([^'"]+)['"]/g)].map(m=>[m[1],m[2]]));
const iphoriyaSlugs=Object.fromEntries([...reference.matchAll(/['"]([A-Z0-9]+)['"]\s*:\s*['"]([^'"]+)['"]/g)].map(m=>[m[1],m[2]]));
const rawFetch=fetch;globalThis.fetch=async(url,options={})=>{const c=new AbortController();const t=setTimeout(()=>c.abort(),10000);try{return await rawFetch(url,{...options,signal:c.signal,headers:{'user-agent':'MacPriceRadar/1.0',...(options.headers||{})}})}finally{clearTimeout(t)}};
async function fetchLive() {
  const out=[];
  const target=process.env.RETAILER||'all';
  const selected=new Set(target.split(',').map(value=>value.trim()).filter(Boolean));
  const wants=retailer=>target==='all'||selected.has(retailer)||(retailer==='Айфория'&&selected.has('Iphoriya'));
  // Refresh previously discovered product URLs first. This keeps a known SKU
  // current even when a retailer hides its catalogue behind client-side JS.
  for (const seed of offers.filter(o=>wants(o.retailer) && o.url.includes('/products/'))) {
    try {
      const page=await (await fetch(seed.url)).text();
      const title=(page.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||seed.title;
      const amount=(page.match(/(?:data-price|data-card-price)="(\d+)"/i)||[])[1];
      const o=parseProduct(title,seed.url,seed.retailer,price(amount)); if(o) out.push(o);
    } catch(e) { console.warn(`${seed.retailer} product refresh failed: ${e.message}`) }
  }
  if(wants('Айфория')) {
    const entries=Object.entries(iphoriyaSlugs).filter(([,slug])=>slug.startsWith('apple-macbook'));
    const queue=entries.slice();
    const worker=async()=>{while(queue.length){const [,slug]=queue.shift();const url='https://iphoriya.ru/product/'+slug;try{const html=await (await fetch(url)).text();const json=[...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];let amount=null;for(const m of json){try{const data=JSON.parse(m[1]);for(const item of (Array.isArray(data)?data:[data])){const n=Number(item?.offers?.price);if(n>1000&&n<1000000)amount=n}}catch{}}const title=(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||slug;const o=parseProduct(title,url,'Айфория',amount)||parseProduct(slug,url,'Айфория',amount);if(o)out.push(o)}catch{}}};await Promise.all(Array.from({length:4},worker));
  }
  if(wants('BigGeek')) {
    const entries=Object.entries(bigGeekSlugs);
    const queue=entries.slice();
    const worker=async()=>{while(queue.length){const [,slug]=queue.shift();const url='https://biggeek.ru/products/'+slug;try{let html='',response;for(let attempt=0;attempt<3;attempt++){response=await fetch(url);if(response.ok){html=await response.text();break}await new Promise(r=>setTimeout(r,500*(attempt+1)))}if(!html)continue;const json=[...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];let amount=price((html.match(/data-price="(\d+)"/i)||[])[1]);for(const m of json){try{const data=JSON.parse(m[1]);for(const item of (Array.isArray(data)?data:[data])){const n=Number(item?.offers?.price);if(n>1000&&n<1000000)amount=n}}catch{}}const title=(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||slug;const o=parseProduct(title,url,'BigGeek',amount)||parseProduct(slug,url,'BigGeek',amount);if(o)out.push(o)}catch{}}};await Promise.all(Array.from({length:3},worker));
    const home=await (await fetch('https://biggeek.ru/')).text();
    const paths=[...new Set([...home.matchAll(/href="(\/catalog\/macbook-[^"]+)"/gi)].map(m=>m[1]))];
    for(const path of paths){const html=await (await fetch('https://biggeek.ru'+path)).text();const re=/<a href="(\/products\/[^\"]+)" class="catalog-card__title[^>]*>([\s\S]*?)<\/a>[\s\S]*?catalog-card__price[^>]*>[\s\S]*?cart-modal-count[^>]*>([\s\S]*?)<\//gi;for(const m of html.matchAll(re)){const o=parseProduct(m[2],'https://biggeek.ru'+m[1],'BigGeek',price(m[3]));if(o)out.push(o)}}
  }
  if(wants('RifaStore')) {
    const homeUrl='https://rifastore.ru/';
    const rifaHome=await (await fetch(homeUrl)).text();
    const queue=findRifaCategoryUrls(rifaHome,homeUrl);
    const seen=new Set();
    while(queue.length){
      const url=queue.shift();
      if(seen.has(url)||seen.size>=400)continue;
      seen.add(url);
      const html=await (await fetch(url)).text();
      for(const item of parseRifaCategory(html,url)){
        const offer=parseProduct(item.title,item.url,'RifaStore',price(item.priceText));
        if(offer)out.push(offer);
      }
      const next=findRifaNextPage(html,url);
      if(next&&!seen.has(next))queue.push(next);
    }
  }
  if(wants('Technichno')) {
    for(const path of ['/catalog/mac/macbook-pro/','/catalog/mac/macbook-air-13-15/','/catalog/mac/macbook-neo/']){const html=await (await fetch('https://nn.technichno.ru'+path)).text();const re=/<a[^>]+href="([^"]+)"[^>]+class="product-card__name[^>]*>[\s\S]*?<p[^>]*>([^<]+)<\/p>[\s\S]*?<span class="product-card-price__current[^"]*">([\s\S]*?)<\/span>/gi;for(const m of html.matchAll(re)){const o=parseProduct(m[2],'https://nn.technichno.ru'+m[1],'Technichno',price(m[3]));if(o)out.push(o)}}
  }
  // Each retailer has its own adapter. BigGeek and Iphoriya are intentionally
  // isolated here: their catalogue markup changes independently of Technichno.
  const adapters=[
    {retailer:'BigGeek',base:'https://biggeek.ru',paths:['/'],category:/href="(\/catalog\/macbook-[^"]+)"/gi,link:/href="([^"]*\/products\/[^\"]+)"/gi,price:/(?:data-price|data-card-price)="(\d+)"|((?:\d[\s]?){4,7})\s*(?:₽|руб)/gi},
    {retailer:'Айфория',base:'https://iphoriya.ru',paths:['/'],link:/href="([^"]*(?:macbook|mac-book)[^"]*)"/gi,price:/((?:\d[\s]?){4,7})\s*(?:₽|руб)/gi}
  ];
  for(const adapter of target==='all'?adapters:[]){
    try{
      for(const path of adapter.paths){
        const html=await (await fetch(adapter.base+path)).text();
        if(adapter.category) adapter.paths.push(...[...html.matchAll(adapter.category)].map(m=>m[1]));
        const links=[...html.matchAll(adapter.link)].map(m=>m[1].startsWith('http')?m[1]:adapter.base+m[1]).filter(url=>url.includes('/products/'));
        for(const url of [...new Set(links)].slice(0,80)){
          const page=await (await fetch(url)).text();
          const title=(page.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||url;
          const amounts=[...page.matchAll(adapter.price)].map(m=>price(m[1]||m[2])).filter(Boolean);
          const o=parseProduct(title,url,adapter.retailer,amounts[0]); if(o) out.push(o);
        }
      }
    }catch(e){console.warn(`${adapter.retailer} live fetch failed: ${e.message}`)}
  }
  return out;
}
let live=[];
if(process.env.LIVE==='1'){
  try{
    live=await fetchLive();
    const requested=(process.env.RETAILER||'').split(',').map(value=>value.trim()).filter(Boolean);
    const missing=requested.filter(retailer=>!live.some(offer=>offer.retailer===retailer||(retailer==='Iphoriya'&&offer.retailer==='Айфория')));
    if(missing.length)throw new Error(`No live offers fetched for: ${missing.join(', ')}`);
    console.log(`Fetched ${live.length} live offers`);
  }catch(e){
    console.error(`Live fetch failed: ${e.message}`);
    process.exitCode=1;
  }
}
const liveRetailers=new Set(live.map(o=>o.retailer));
const baseOffers=liveRetailers.size?[...offers.filter(o=>!liveRetailers.has(o.retailer)),...live]:[...offers,...live];
const allOffers=[...new Map(baseOffers.map(o=>[`${o.retailer}|${o.url}|${o.price}`,o])).values()];
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
