import { readFile, writeFile } from 'node:fs/promises';
const offers = JSON.parse(await readFile('data/offers.json', 'utf8'));
const catalog = JSON.parse(await readFile('data/catalog.json', 'utf8'));
const reference=await readFile('apps-script/reference.gs','utf8').catch(()=> '');
const bigGeekSlugs=Object.fromEntries([...reference.matchAll(/['"]([A-Z0-9]+)['"]\s*:\s*['"]([^'"]+)['"]/g)].map(m=>[m[1],m[2]]));
const decode = s => s.replace(/&nbsp;|&#160;/g,' ').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#8381;|₽|руб\.?/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const price = s => { const n=decode(s).replace(/\s/g,'').match(/\d[\d,.]*/); return n ? Number(n[0].replace(/,/g,'')) : null; };
const get=async url=>{const c=new AbortController();const t=setTimeout(()=>c.abort(),10000);try{return await fetch(url,{signal:c.signal,headers:{'user-agent':'MacPriceRadar/1.0'}})}finally{clearTimeout(t)}};
const rawFetch=fetch;globalThis.fetch=async(url,options={})=>{const c=new AbortController();const t=setTimeout(()=>c.abort(),10000);try{return await rawFetch(url,{...options,signal:c.signal,headers:{'user-agent':'MacPriceRadar/1.0',...(options.headers||{})}})}finally{clearTimeout(t)}};
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
  const colorMap=[['Sky Blue','sky blue|sky-blue|небесно-голуб|goluboe'],['Midnight','midnight|полуноч|temnaa-noc'],['Starlight','starlight|сияющ|zvezda'],['Silver','silver|серебрист|serebr'],['Space Black','space black|space-black|черн|cernyj|kosmos']];
  const color=(colorMap.find(([,pattern])=>new RegExp(pattern,'i').test(combined))||[])[0]||'unknown';
  const corePair=combined.match(/(\d+)[- ]?core[- ]gpu[- ](\d+)[- ]?core/i);
  const cpuCores=Number((corePair?.[1]||(combined.match(/(\d+)[- ]?Core[^,)]*CPU/i)||[])[1]))||null;
  const gpuCores=Number((corePair?.[2]||(combined.match(/(\d+)[- ]?Core[^,)]*GPU/i)||[])[1]))||null;
  return {retailer,title:t,url,price:amount,currency:'RUB',fetchedAt:new Date().toISOString(),condition:'new',model,chip:chip.replace(/\s+/g,' '),ramGb,storageGb,color,cpuCores,gpuCores};
}
async function fetchLive() {
  const out=[];
  const target=process.env.RETAILER||'all';
  // Refresh previously discovered product URLs first. This keeps a known SKU
  // current even when a retailer hides its catalogue behind client-side JS.
  for (const seed of offers.filter(o=>(!process.env.RETAILER||process.env.RETAILER==='all'?['BigGeek','Айфория'].includes(o.retailer):o.retailer===process.env.RETAILER) && o.url.includes('/products/'))) {
    try {
      const page=await (await fetch(seed.url)).text();
      const title=(page.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||seed.title;
      const amount=(page.match(/(?:data-price|data-card-price)="(\d+)"/i)||[])[1];
      const o=parseProduct(title,seed.url,seed.retailer,price(amount)); if(o) out.push(o);
    } catch(e) { console.warn(`${seed.retailer} product refresh failed: ${e.message}`) }
  }
  if(target==='BigGeek') {
    const entries=Object.entries(bigGeekSlugs);
    const queue=entries.slice();
    const worker=async()=>{while(queue.length){const [,slug]=queue.shift();const url='https://biggeek.ru/products/'+slug;try{let html='',response;for(let attempt=0;attempt<3;attempt++){response=await fetch(url);if(response.ok){html=await response.text();break}await new Promise(r=>setTimeout(r,500*(attempt+1)))}if(!html)continue;const json=[...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];let amount=price((html.match(/data-price="(\d+)"/i)||[])[1]);for(const m of json){try{const data=JSON.parse(m[1]);for(const item of (Array.isArray(data)?data:[data])){const n=Number(item?.offers?.price);if(n>1000&&n<1000000)amount=n}}catch{}}const title=(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||slug;const o=parseProduct(title,url,'BigGeek',amount)||parseProduct(slug,url,'BigGeek',amount);if(o)out.push(o)}catch{}}};await Promise.all(Array.from({length:3},worker));
    const home=await (await fetch('https://biggeek.ru/')).text();
    const paths=[...new Set([...home.matchAll(/href="(\/catalog\/macbook-[^"]+)"/gi)].map(m=>m[1]))];
    for(const path of paths){const html=await (await fetch('https://biggeek.ru'+path)).text();const re=/<a href="(\/products\/[^\"]+)" class="catalog-card__title[^>]*>([\s\S]*?)<\/a>[\s\S]*?catalog-card__price[^>]*>[\s\S]*?cart-modal-count[^>]*>([\s\S]*?)<\//gi;for(const m of html.matchAll(re)){const o=parseProduct(m[2],'https://biggeek.ru'+m[1],'BigGeek',price(m[3]));if(o)out.push(o)}}
    return [...new Map(out.map(o=>[o.url,o])).values()];
  }
  const rifaHome=await (await fetch('https://rifastore.ru/')).text();
  const rifaPaths=[...new Set([...rifaHome.matchAll(/href="(\/categories\/macbook-[^"]+)"/gi)].map(m=>m[1]))];
  for(const path of rifaPaths){const html=await (await fetch('https://rifastore.ru'+path)).text();const re=/<a[^>]+class="products-view-name-link"[^>]*title="([^"]+)"[^>]*>.*?<div class="price-number">([^<]+)/gis;for(const m of html.matchAll(re)){const href=(m[0].match(/href="(https:\/\/rifastore\.ru\/products\/[^\"]+)/)||[])[1];const o=parseProduct(m[1],href||'https://rifastore.ru'+path,'RifaStore',price(m[2]));if(o)out.push(o)}}
  if(target==='RifaStore') return out;
  for(const path of ['/catalog/mac/macbook-pro/','/catalog/mac/macbook-air-13-15/','/catalog/mac/macbook-neo/']){const html=await (await fetch('https://nn.technichno.ru'+path)).text();const re=/<a[^>]+href="([^"]+)"[^>]+class="product-card__name[^>]*>[\s\S]*?<p[^>]*>([^<]+)<\/p>[\s\S]*?<span class="product-card-price__current[^"]*">([\s\S]*?)<\/span>/gi;for(const m of html.matchAll(re)){const o=parseProduct(m[2],'https://nn.technichno.ru'+m[1],'Technichno',price(m[3]));if(o)out.push(o)}}
  if(target==='Technichno') return out;
  // Each retailer has its own adapter. BigGeek and Iphoriya are intentionally
  // isolated here: their catalogue markup changes independently of Technichno.
  const adapters=[
    {retailer:'BigGeek',base:'https://biggeek.ru',paths:['/'],category:/href="(\/catalog\/macbook-[^"]+)"/gi,link:/href="([^"]*\/products\/[^\"]+)"/gi,price:/(?:data-price|data-card-price)="(\d+)"|((?:\d[\s]?){4,7})\s*(?:₽|руб)/gi},
    {retailer:'Айфория',base:'https://iphoriya.ru',paths:['/'],link:/href="([^"]*(?:macbook|mac-book)[^"]*)"/gi,price:/((?:\d[\s]?){4,7})\s*(?:₽|руб)/gi}
  ];
  for(const adapter of adapters){
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
let live=[]; if(process.env.LIVE==='1'){try{live=await fetchLive();console.log(`Fetched ${live.length} live offers`)}catch(e){console.warn(`Live fetch failed: ${e.message}`)}}
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
