import { avitoUrl } from './avito-policy.mjs';
import { parseAvitoSearch, parseAvitoDetail } from './avito-parser.mjs';
import { createAvitoDetailQueue } from './avito-queue.mjs';

function sameSearch(candidate, searchUrl) {
  const a=new URL(avitoUrl(candidate)),b=new URL(avitoUrl(searchUrl));
  if(Number(a.searchParams.get('p')||1)<1||Number(a.searchParams.get('p')||1)>100)return false;
  for(const u of [a,b]){u.searchParams.delete('p');u.searchParams.delete('context');u.searchParams.sort();}
  return a.href===b.href;
}

// A small live batch revisits page 1, advances one saved search page, and spends
// the remaining requests on details. Cached discovery contains targets, NEVER
// prices to import. Only freshly fetched detail HTML produces observations.
export async function collectAvitoBatch({fetchPage,searchUrl,previousDiscovery,previousQueue,signal,now=()=>new Date().toISOString(),discoveryMaxAgeMs=6*3600000,
  maxListings=3000,maxDetails=58,onProgress=async()=>{},onQueue=async()=>{},onDiscovery=async()=>{},onCheckpoint=async()=>{}}) {
  searchUrl=avitoUrl(searchUrl);
  const startedAt=now(),started=Date.parse(startedAt),items=new Map(),listings=[],failures=[];
  let pages=0,expectedTotal=null,inspected=0,nextUrl=null,firstPage;
  const prior=previousDiscovery?.schemaVersion===1&&previousDiscovery.searchUrl===searchUrl&&Array.isArray(previousDiscovery.items)?previousDiscovery:null;
  if(prior){
    for(const item of prior.items.slice(0,maxListings)) {
      if(!item||!/^\d{6,}$/.test(String(item.id))||!Number.isFinite(Date.parse(item.discoveredAt))||Date.parse(item.discoveredAt)>started||started-Date.parse(item.discoveredAt)>discoveryMaxAgeMs)continue;
      try{const url=avitoUrl(item.url,{listing:true});if(!url.endsWith(`_${item.id}`))continue;items.set(item.id,{id:item.id,url,discoveredAt:item.discoveredAt});}catch{/* Invalid saved discovery never causes a request. */}
    }
    if(started-Date.parse(prior.updatedAt)<=discoveryMaxAgeMs&&Date.parse(prior.updatedAt)<=started&&prior.nextUrl){try{if(sameSearch(prior.nextUrl,searchUrl))nextUrl=avitoUrl(prior.nextUrl);}catch{/* Reset a corrupt cursor. */}}
  }
  const discovery=()=>({schemaVersion:1,searchUrl,updatedAt:now(),nextUrl,items:[...items.values()]});
  const snapshot=(complete=false)=>({schemaVersion:1,scope:'avito-nizhny-macbook',startedAt,completedAt:now(),complete,
    expectedTotal,discovered:items.size,pages,duplicates:0,listings:[...listings],failures:[...new Set(failures)].slice(0,100)});
  const progress=()=>onProgress({stage:'details',pages,discovered:items.size,detailed:listings.length,inspected,remaining:items.size-inspected,expectedTotal,...fetchPage.stats?.()});
  const ingest=page=>{
    pages++;expectedTotal=page.total??expectedTotal;
    for(const item of page.items){if(items.size>=maxListings&&!items.has(item.id))items.delete(items.keys().next().value);items.set(item.id,{id:item.id,url:item.url,discoveredAt:now()});}
  };
  signal?.throwIfAborted();firstPage=parseAvitoSearch(await fetchPage(searchUrl),searchUrl);ingest(firstPage);
  const continuation=nextUrl&&nextUrl!==searchUrl&&firstPage.nextUrl?nextUrl:null;
  nextUrl=continuation||firstPage.nextUrl;
  await onDiscovery(discovery());
  if(continuation){
    signal?.throwIfAborted();const page=parseAvitoSearch(await fetchPage(continuation),continuation);ingest(page);nextUrl=page.nextUrl;await onDiscovery(discovery());
  }
  const queue=createAvitoDetailQueue([...items.values()],{previous:previousQueue,searchUrl,startedAt});
  await onQueue(queue.serialize(now()));await progress();
  try {
    for(const item of queue.ordered.slice(0,maxDetails)) {
      signal?.throwIfAborted();let observedAt;
      try{const listing=parseAvitoDetail(await fetchPage(item.url),item.url,now());listings.push(listing);observedAt=listing.observedAt;}
      catch(error){if(['AVITO_BLOCKED','AVITO_NETWORK','AVITO_BUDGET'].includes(error.code)||signal?.aborted)throw error;failures.push(`Не разобрана карточка ${item.id}`);}
      queue.attempted(item.id,now(),observedAt);inspected++;
      await onQueue(queue.serialize(now()));await progress();
      if(listings.length&&(inspected===1||inspected%5===0))await onCheckpoint({...snapshot(),failures:[...new Set([...failures,'Порционный сбор; полный обход не подтверждён'])]});
    }
  } catch(error) {
    failures.push(error.code==='AVITO_BLOCKED'?'Авито ограничил доступ; неполный срез':'Порционный сбор прерван; неполный срез');
    if(listings.length)await onCheckpoint(snapshot());
    if(error.code!=='AVITO_BUDGET')throw error;
  }
  const complete=pages===1&&!firstPage.nextUrl&&firstPage.total===items.size&&firstPage.items.length===items.size&&listings.length===items.size&&!failures.length;
  if(!complete)failures.push('Порционный сбор; полный обход не подтверждён');
  return snapshot(complete);
}
