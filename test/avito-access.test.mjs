import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { avitoAccessFailure,publicAvitoState } from '../scripts/avito-access.mjs';
import { avitoRoute,avitoSession,createAvitoHttpTransport } from '../scripts/avito-transport.mjs';
import { collectAvitoBatch } from '../scripts/avito-batch.mjs';
import { at,search,url,detailPage,searchPage } from './fixtures/avito/sample.mjs';
const now=Date.parse(at),later='2026-09-26T12:20:00.000Z';
const temp=async t=>{const dir=await mkdtemp(join(tmpdir(),'avito-access-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};

test('access diagnosis distinguishes IP, geography, rate limit, challenge and unknown denial',()=>{
  assert.equal(avitoAccessFailure({status:429,html:'<h1>Доступ ограничен: проблема с IP</h1>'}).reason,'ip_restriction');
  assert.equal(avitoAccessFailure({status:403,html:'<h1>Доступ ограничен</h1><p>Сайт недоступен в вашей стране</p>'}).reason,'region_restriction');
  assert.equal(avitoAccessFailure({html:'<title>Проверка браузера</title>'}).reason,'captcha');
  assert.equal(avitoAccessFailure({status:403}).reason,'access_denied');
  assert.equal(avitoAccessFailure({status:429,now,retryAfter:'43200'}).retryAfter,new Date(now+12*3600000).toISOString());
  assert.equal(avitoAccessFailure({html:'<h1>MacBook Air</h1><p>В описании упомянута captcha</p>'}),null);
  const state=publicAvitoState({state:'blocked',routeKey:'private',cookie:'private',proxyUrl:'secret',access:{reason:'ip_restriction',status:429,raw:'secret'},counts:{pages:2,proxyPassword:'secret'}});
  assert.doesNotMatch(JSON.stringify(state),/private|secret|cookie|routeKey/);
});

test('anonymous cookies survive restart, stay on Avito and reset for a different route',async t=>{
  const dir=await temp(t),path=join(dir,'session.json');
  let session=await avitoSession(path,'route-a');let calls=0;
  const fetchImpl=async(target,options)=>{calls++;assert.equal(new URL(target).hostname,'www.avito.ru');if(calls===2)assert.equal(options.headers.cookie,'sid=anonymous');return new Response('<title>MacBook</title>',{headers:{'content-type':'text/html','set-cookie':'sid=anonymous; Secure; HttpOnly; Path=/'}});};
  const first=createAvitoHttpTransport({session,fetchImpl});await first(search);await first.close();
  session=await avitoSession(path,'route-a');const second=createAvitoHttpTransport({session,fetchImpl});await second(search);await second.close();
  assert.equal((await avitoSession(path,'route-b')).jar.getCookieStringSync(search),'');
  assert.equal(session.jar.getCookieStringSync('https://evil.example/'),'');
  assert.equal((await readFile(path,'utf8')).includes('anonymous'),true);
});

test('proxy secrets are passed only to its dispatcher; failures never fall back to direct',async t=>{
  const dir=await temp(t),file=join(dir,'proxy');await writeFile(file,'http://login:password@127.0.0.1:1234');
  const route=await avitoRoute({AVITO_PROXY_URL_FILE:file});assert.equal(route.kind,'proxy');assert.match(route.key,/^[a-f0-9]{64}$/);
  assert.notEqual(route.key,(await avitoRoute({})).key);let calls=0;const dispatcher={close:async()=>{}};
  const fetchPage=createAvitoHttpTransport({proxyUrl:route.proxyUrl,dispatcherFactory:uri=>{assert.equal(uri,route.proxyUrl);return dispatcher;},fetchImpl:async(target,options)=>{calls++;assert.equal(options.dispatcher,dispatcher);assert.ok(!JSON.stringify(options.headers).includes('password'));throw new Error('password should never be logged');}});
  await assert.rejects(fetchPage(search),e=>e.code==='AVITO_NETWORK'&&!e.message.includes('password'));
  await assert.rejects(fetchPage(search),{code:'AVITO_NETWORK'});assert.equal(calls,1);await fetchPage.close();
  await assert.rejects(avitoRoute({AVITO_PROXY_URL:'https://proxy.test/path'}),/прокси/);
});

test('transport serializes requests, observes interval and budget, and latches an access block',async()=>{
  let clock=now,calls=0;const sleeps=[];
  const fetchPage=createAvitoHttpTransport({now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms;},intervalMs:10000,maxRequests:2,fetchImpl:async()=>{calls++;return new Response('<h1>MacBook</h1>',{headers:{'content-type':'text/html'}});}});
  await Promise.all([fetchPage(search),fetchPage(search)]);assert.deepEqual(sleeps,[10000]);await assert.rejects(fetchPage(search),{code:'AVITO_BUDGET'});assert.equal(calls,2);
  calls=0;const blocked=createAvitoHttpTransport({fetchImpl:async()=>{calls++;return new Response('<title>Доступ ограничен: проблема с IP</title>',{status:429,headers:{'content-type':'text/html'}});}});
  await assert.rejects(blocked(search),e=>e.access.reason==='ip_restriction');await assert.rejects(blocked(search),{code:'AVITO_BLOCKED'});assert.equal(calls,1);
});

test('small batches advance discovery and unvisited details without renewing old observation dates',async()=>{
  const ids=['1234567890','1234567891','1234567892'],visits=[];let discovery,queue;
  const fetchPage=async target=>{visits.push(target);return target===search?searchPage(ids.slice(0,2),3,search+'&p=2'):target===search+'&p=2'?searchPage(ids.slice(2),3):detailPage();};
  const callbacks={onDiscovery:async d=>{discovery=d;},onQueue:async q=>{queue=q;}};
  const a=await collectAvitoBatch({fetchPage,searchUrl:search,now:()=>at,maxDetails:1,...callbacks});
  assert.deepEqual(visits,[search,url(ids[0])]);assert.equal(a.complete,false);assert.equal(a.listings[0].observedAt,at);
  visits.length=0;const b=await collectAvitoBatch({fetchPage,searchUrl:search,now:()=>later,maxDetails:2,previousDiscovery:discovery,previousQueue:queue,...callbacks});
  assert.deepEqual(visits,[search,search+'&p=2',url(ids[1]),url(ids[2])]);assert.equal(b.complete,false);assert.equal(b.listings.length,2);assert.ok(b.listings.every(l=>l.observedAt===later));
  assert.equal(discovery.items[0].price,undefined);assert.equal(queue.entries.find(e=>e.id===ids[0]).lastObservedAt,at);
});

test('batch saves received cards on a block and ignores poisoned discovery URLs',async()=>{
  const ids=['1234567890','1234567891'];let snapshot;const visits=[];
  await assert.rejects(collectAvitoBatch({searchUrl:search,now:()=>at,onCheckpoint:async s=>{snapshot=s;},previousDiscovery:{schemaVersion:1,searchUrl:search,updatedAt:at,nextUrl:'https://evil.example/',items:[{id:'9999999999',url:'https://evil.example/item_9999999999',discoveredAt:at}]},fetchPage:async target=>{visits.push(target);if(target===search)return searchPage(ids);if(target===url(ids[0]))return detailPage();return '<title>captcha</title>';}}),{code:'AVITO_BLOCKED'});
  assert.deepEqual(visits,[search,...ids.map(url)]);assert.equal(snapshot.listings.length,1);assert.equal(snapshot.complete,false);
});

test('only a current fully verified tiny search can claim completeness',async()=>{
  const id='1234567890';const s=await collectAvitoBatch({searchUrl:search,now:()=>at,fetchPage:async target=>target===search?searchPage([id]):detailPage()});assert.equal(s.complete,true);
});

test('route-specific cooldown allows an explicitly configured new route and remembers the blocked one',async t=>{
  const {runAvitoWorker}=await import('../scripts/avito-collector.mjs');const dir=await temp(t),proxy='http://name:secret@proxy.example:1234';
  let calls=0;const factory=options=>{assert.equal(options.proxyUrl,proxy+'/');const fn=async target=>{calls++;return target===search?searchPage(['1234567890']):detailPage();};fn.close=async()=>{};fn.stats=()=>({requests:calls});return fn;};
  const retryAfter=new Date(Date.now()+3600000).toISOString();await writeFile(join(dir,'state.json'),JSON.stringify({state:'blocked',retryAfter}));
  const direct=await runAvitoWorker({env:{AVITO_TRANSPORT:'http',AVITO_DATA_DIR:dir},transportFactory:()=>{throw new Error('must not connect');}});assert.equal(direct.state,'blocked');
  const result=await runAvitoWorker({env:{AVITO_TRANSPORT:'http',AVITO_DATA_DIR:dir,AVITO_PROXY_URL:proxy,AVITO_SEARCH_URL:search},transportFactory:factory});assert.equal(result.state,'ready');assert.equal(calls,2);
  const back=await runAvitoWorker({env:{AVITO_TRANSPORT:'http',AVITO_DATA_DIR:dir},transportFactory:()=>{throw new Error('cooldown must survive switching back');}});assert.equal(back.state,'blocked');assert.equal(JSON.parse(await readFile(join(dir,'state.json'),'utf8')).state,'blocked');
});

test('partial batches may add fresh observations without withdrawing a larger previous catalogue',async t=>{
  const {fetchAvitoOffers}=await import('../scripts/avito.mjs');const {normalizeAvitoListing}=await import('../scripts/avito-policy.mjs');const {record,snapshot}=await import('./fixtures/avito/sample.mjs');
  const dir=await temp(t);const previous=Array.from({length:20},(_,i)=>normalizeAvitoListing(record({id:String(1234567800+i),url:url(String(1234567800+i))})).offer);
  await writeFile(join(dir,'snapshot.json'),JSON.stringify(snapshot([record()],{complete:false,expectedTotal:100})));
  const result=await fetchAvitoOffers({env:{AVITO_DATA_DIR:dir},previous,now});assert.equal(result.offers.length,1);assert.equal(result.offers[0].stock,'source_reported');
});

test('real proxy connector targets only Avito, authenticates the tunnel, and does not retry a broken proxy',async t=>{
  const {createServer}=await import('node:http');let tunnels=0;const sockets=new Set();
  const proxy=createServer();proxy.on('connect',(req,socket)=>{tunnels++;assert.equal(req.url,'www.avito.ru:443');assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('user:secret').toString('base64'));socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');});
  proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const fetchPage=createAvitoHttpTransport({proxyUrl:`http://user:secret@127.0.0.1:${proxy.address().port}`});
  t.after(async()=>{for(const socket of sockets)socket.destroy();await fetchPage.close();await new Promise(r=>proxy.close(r));});
  await assert.rejects(fetchPage(search),e=>e.code==='AVITO_NETWORK'&&!e.message.includes('secret'));
  await assert.rejects(fetchPage(search),{code:'AVITO_NETWORK'});assert.equal(tunnels,1);
});

test('status explains partial coverage and distinguishes configured proxy from proven access',async()=>{
  const {avitoStatus}=await import('../web/avito-status.js');
  assert.match(avitoStatus({state:'blocked',transport:'proxy',access:{reason:'ip_restriction'},retryAfter:new Date(now+3600000).toISOString()},now),/через отдельный прокси.*ограничил IP/);
  assert.match(avitoStatus({state:'partial',counts:{detailed:8}}),/8 карточек.*Полный охват не подтверждён/);
});
