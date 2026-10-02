import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { openShopStore } from '../core.mjs';
import { buildRecommendations, recommendationKey } from '../prices.mjs';
import { calculateRetailAnalytics } from '../../web/retail-analytics.js';
import { createShopService } from '../server.mjs';
import { createDispatcher, yandexFeed } from '../integrations.mjs';
import { page, productView, catalogue, cartView, checkoutView } from '../views.mjs';

const clock = Date.parse('2026-09-28T10:00:00Z');
const offer = (extra={})=>({model:'MacBook Air 13',chip:'M5',screenIn:13,ramGb:16,storageGb:512,color:'Silver',condition:'new',retailer:'Айфория',price:120000,currency:'RUB',stock:'InStock',url:'https://example.org/mac',fetchedAt:new Date(clock).toISOString(),...extra});
const productInput = (extra={})=>({title:'MacBook Air M5',specification:'16 ГБ · 512 ГБ · Silver',description:'Новый компьютер.',recommendationKey:recommendationKey(offer()),mappingConfirmed:true,channels:['telegram','yandex'],...extra});
function setup(t){const dir=mkdtempSync(join(tmpdir(),'mb-shop-test-'));let time=clock;const store=openShopStore(join(dir,'shop.sqlite'),{now:()=>time});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});store.refreshPrices(buildRecommendations([offer()],{now:time}));return {dir,store,advance:n=>{time+=n;}};}

test('uses dev recommended price, preserves Trust, never uses lowest or discounts twice',()=>{
  const rows=[offer(),offer({retailer:'Technichno',price:122000}),offer({retailer:'ReSale',price:90000})];
  const result=buildRecommendations(rows,{now:clock})[0];
  assert.equal(result.priceRub,calculateRetailAnalytics(rows).recommendedPrice);assert.equal(result.priceRub,119500);
  assert.equal(buildRecommendations([offer({fetchedAt:'2020-01-01'})],{now:clock})[0].priceRub,null);
  assert.equal(buildRecommendations([offer({url:'https://macbookbro.ru/p/me'})],{now:clock}).length,0);
  assert.equal(buildRecommendations([offer({keyboard:'RU'}),offer({retailer:'Technichno',keyboard:'US'})],{now:clock})[0].priceRub,null);
});

test('storefront excludes the same rejected and conditional prices as the dev table', () => {
  const invalid = offer({ rejected: true, validationStatus: 'rejected', priceType: 'installment', minimumQuantity: 5 });
  const row = buildRecommendations([invalid], { now: clock })[0];
  assert.equal(row.priceRub, null);
  assert.equal(row.recommendedRub, null);
  assert.equal(buildRecommendations([offer({ displayType: 'standard' }), offer({ retailer: 'Technichno', displayType: 'nano-texture' })], { now: clock })[0].priceRub, null);
});

test('commercial specifications changing after checkout require a fresh confirmation', t => {
  const { store } = setup(t);
  const original = productInput();
  const p = store.saveProduct(original, { publish: true });
  const s = store.session(); store.setCart(s, { [p.id]: 1 });
  const quote = store.checkout(s);
  store.saveProduct({ ...original, specification: 'Другая клавиатура' }, { id: p.id, publish: true, expectedRevision: p.revision });
  assert.throws(() => store.placeOrder(s, { checkoutId: quote.id, phone: '+79991234567', consent: 'on' }), error => error.status === 409);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
});

test('draft does not publish; publication queues atomically; price change and withdrawal supersede old work',t=>{
  const {store}=setup(t);const draft=store.saveProduct(productInput());
  assert.equal(store.publicProduct(draft),null);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
  const published=store.saveProduct(productInput(),{id:draft.id,publish:true,expectedRevision:draft.revision});
  assert.equal(store.publicProduct(published).priceRub,119500);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE state='queued'").get().n,2);
  assert.match(yandexFeed(store,'https://shop.example'),/119500/);
  assert.doesNotMatch(yandexFeed(store,'https://shop.example'),/stock|benchmark|retailer|fetchedAt/);
  store.refreshPrices(buildRecommendations([offer({price:125000})],{now:clock}));
  assert.equal(store.publicProduct(store.product(draft.id)).priceRub,124500);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE state='queued'").get().n,2);
  store.unpublish(draft.id);assert.equal(store.publicProduct(store.product(draft.id)),null);
  assert.doesNotMatch(yandexFeed(store,'https://shop.example'),/<offer /);
});

test('price expiry cannot be renewed by source failures or a server restart',t=>{
  const {store,advance}=setup(t);const p=store.saveProduct(productInput(),{publish:true});
  advance(5*3600000);assert.equal(store.publicProduct(store.product(p.id)).priceRub,null);
  store.reconcilePrices();assert.equal(store.product(p.id).published.priceRub,null);
});

test('price changes require another confirmation and accepted order remains immutable/idempotent',t=>{
  const {store}=setup(t);const p=store.saveProduct(productInput(),{publish:true});const s=store.session();store.setCart(s,{[p.id]:1});
  const first=store.checkout(s);store.refreshPrices(buildRecommendations([offer({price:125000})],{now:clock}));
  const contact={phone:'+7 999 123-45-67',name:'Тест',consent:'on',checkoutId:first.id};
  assert.throws(()=>store.placeOrder(s,contact),e=>e.status===409);
  contact.checkoutId=store.checkout(s).id;const id=store.placeOrder(s,contact);
  assert.equal(store.placeOrder(s,contact),id);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM orders').get().n,1);
  store.refreshPrices(buildRecommendations([offer({price:135000})],{now:clock}));
  assert.equal(JSON.parse(store.db.prepare('SELECT data FROM orders WHERE id=?').get(id).data).totalRub,124500);
});

test('outgoing ambiguous creation is not automatically repeated, including new revisions',async t=>{
  const {store}=setup(t);const p=store.saveProduct(productInput({channels:['telegram']}),{publish:true});let calls=0;
  const dispatcher=createDispatcher(store,{env:{STORE_TELEGRAM_TOKEN:'test',STORE_TELEGRAM_CHANNEL:'@test'},origin:'https://shop.example',fetchImpl:async()=>{calls++;throw new Error('response lost');}});
  await dispatcher.dispatch();assert.equal(calls,1);assert.equal(store.db.prepare('SELECT state FROM jobs').get().state,'unknown');
  store.saveProduct(productInput({channels:['telegram'],description:'Обновили текст'}),{id:p.id,publish:true,expectedRevision:p.revision});
  await dispatcher.dispatch();assert.equal(calls,1);assert.equal(store.db.prepare('SELECT state FROM jobs ORDER BY id DESC').get().state,'blocked');
});

test('ordinary public HTML and inline styles stay below 14,000 bytes with full permitted content',()=>{
  const s={csrf:'x'.repeat(43)},p={id:'a'.repeat(36),title:'Я'.repeat(120),specification:'Я'.repeat(200),description:'Я'.repeat(1700),warranty:'Я'.repeat(250),photos:['a.jpg'],priceRub:119500};
  const lines=Array.from({length:4},(_,i)=>({id:String(i),title:p.title,qty:10,priceRub:119500,active:true}));
  const cases={product:productView(p,s),catalog:catalogue(Array(4).fill(p),{total:10}),cart:cartView(lines,s),checkout:checkoutView({id:'q',lines},s)};
  for(const [name,body]of Object.entries(cases)){const html=page('Магазин',body);assert.ok(Buffer.byteLength(html)<14000,`${name}: ${Buffer.byteLength(html)} bytes`);assert.doesNotMatch(html,/<script|rel="stylesheet"/);}
});

test('HTTP checkout without JS; receipt isolation, CSRF, CRM auth and rate limits',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mb-http-test-'));
  const env={STORE_ORIGIN:'http://127.0.0.1:4199',STORE_ADMIN_PASSWORD:'a-secure-test-password',STORE_REQUESTS_PER_MINUTE:'250'};
  const service=createShopService({env,dbPath:join(dir,'shop.sqlite'),runWorkers:false,now:()=>clock,priceLoader:async()=>[offer()]});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
  await service.syncPrices();const p=service.store.saveProduct(productInput(),{publish:true});
  let cookie='';const base=`http://127.0.0.1:${service.server.address().port}`;
  async function request(path,form,extra={}){return new Promise((resolve,reject)=>{const req=httpRequest(base+path,{method:form?'POST':'GET',headers:{Host:'127.0.0.1:4199',Cookie:cookie,...(form?{Origin:env.STORE_ORIGIN,'Content-Type':'application/x-www-form-urlencoded'}:{}),...extra}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{cookie=res.headers['set-cookie']?.[0].split(';')[0]||cookie;resolve({response:{status:res.statusCode,headers:{get:key=>res.headers[key]}},text:Buffer.concat(chunks).toString()});});});req.on('error',reject);req.end(form?new URLSearchParams(form).toString():undefined);});}
  let r=await request(`/p/${p.id}`);assert.equal(r.response.status,200);let token=r.text.match(/name="csrf" value="([^"]+)"/)[1];
  r=await request('/cart/add',{id:p.id,csrf:'bad'});assert.equal(r.response.status,403);
  r=await request('/cart/add',{id:p.id,csrf:token});assert.equal(r.response.status,303);
  r=await request('/checkout');const checkoutId=r.text.match(/name="checkoutId" value="([^"]+)"/)[1];
  r=await request('/checkout',{csrf:token,checkoutId,phone:'+79991234567',consent:'on'});assert.equal(r.response.status,303);
  const receipt=r.response.headers.get('location');r=await request(receipt);assert.match(r.text,/Спасибо/);
  const savedCookie=cookie;cookie='';r=await request(receipt);assert.equal(r.response.status,404);cookie=savedCookie;
  r=await request('/crm');assert.equal(r.response.status,303);
  r=await request('/crm/login',{csrf:token,password:env.STORE_ADMIN_PASSWORD});assert.equal(r.response.status,303);
  r=await request('/crm');assert.match(r.text,/Старейший новый заказ ожидает 0 мин/);
  r=await request('/crm/orders');assert.match(r.text,/\+79991234567/);
  r=await request('/data/private/shop.sqlite');assert.equal(r.response.status,404);
});

test('Telegram keeps one message through price changes, photo additions and closure',async t=>{
  const {store}=setup(t),calls=[];let p=store.saveProduct(productInput({channels:['telegram']}),{publish:true});
  const dispatcher=createDispatcher(store,{env:{STORE_TELEGRAM_TOKEN:'test',STORE_TELEGRAM_CHANNEL:'@test'},origin:'https://shop.example',fetchImpl:async(url,options)=>{calls.push({method:url.split('/').at(-1),body:JSON.parse(options.body)});return Response.json({ok:true,result:{message_id:42,chat:{id:-1001}}});}});
  await dispatcher.dispatch();assert.equal(calls[0].method,'sendMessage');
  store.addPhoto(p.id,'a'.repeat(64)+'.jpg',p.revision);p=store.product(p.id);store.saveProduct(p.draft,{id:p.id,publish:true,expectedRevision:p.revision});
  await dispatcher.dispatch();assert.equal(calls[1].method,'editMessageMedia');assert.equal(calls[1].body.message_id,42);
  store.unpublish(p.id);await dispatcher.dispatch();assert.equal(calls[2].method,'editMessageCaption');assert.equal(calls[2].body.caption,'Предложение закрыто');
});

test('MoySklad uses accepted configuration and price even after catalogue edits',async t=>{
  const {store}=setup(t),original='11111111-1111-4111-8111-111111111111',changed='22222222-2222-4222-8222-222222222222';
  let p=store.saveProduct(productInput({channels:[],moyskladId:original}),{publish:true});const s=store.session();store.setCart(s,{[p.id]:2});
  const id=store.placeOrder(s,{checkoutId:store.checkout(s).id,phone:'89991234567',consent:'on'});
  store.saveProduct(productInput({channels:[],moyskladId:changed,specification:'Другая конфигурация'}),{id:p.id,publish:true,expectedRevision:p.revision});
  const calls=[];const dispatcher=createDispatcher(store,{env:{STORE_MOYSKLAD_TOKEN:'test',STORE_MOYSKLAD_ORGANIZATION:original,STORE_MOYSKLAD_COUNTERPARTY:changed},origin:'https://shop.example',fetchImpl:async(url,options)=>{calls.push({url,body:options.body&&JSON.parse(options.body)});return Response.json(options.method==='POST'?{id:'remote-order'}:{rows:[]});}});
  await dispatcher.dispatch();const payload=calls.find(x=>x.body)?.body;
  assert.equal(payload.externalCode,id);assert.equal(payload.positions[0].price,11950000);assert.equal(payload.positions[0].quantity,2);assert.ok(payload.positions[0].assortment.meta.href.endsWith(original));
  assert.equal(JSON.parse(store.db.prepare('SELECT data FROM orders WHERE id=?').get(id).data).lines[0].specification,'16 ГБ · 512 ГБ · Silver');
});

test('photo edits reject stale forms; completed individual orders withdraw the offer atomically',t=>{
  const {store}=setup(t);const p=store.saveProduct(productInput({individual:true}),{publish:true});
  store.addPhoto(p.id,'x.jpg',p.revision);assert.throws(()=>store.saveProduct(productInput(),{id:p.id,expectedRevision:p.revision}),e=>e.status===409);
  const s=store.session();store.setCart(s,{[p.id]:1});const id=store.placeOrder(s,{checkoutId:store.checkout(s).id,phone:'79991234567',consent:'on'});
  store.updateOrder(id,'completed','Выдан');assert.equal(store.product(p.id).published,null);assert.equal(store.db.prepare('SELECT state FROM orders WHERE id=?').get(id).state,'completed');
});

test('public byte budget holds for escaped input at accepted limits',()=>{
  const s={csrf:'x'.repeat(43)},p={id:'a'.repeat(36),title:'"'.repeat(120),specification:'"'.repeat(130),description:'Я'.repeat(1500),warranty:'',photos:[],priceRub:119500};
  const lines=Array.from({length:4},(_,i)=>({...p,id:String(i),qty:10,active:true}));
  const cases={product:productView(p,s),catalog:catalogue(Array(4).fill(p),{q:'"'.repeat(80),category:'"'.repeat(40),categories:Array.from({length:10},(_,i)=>'"'.repeat(39)+i),p:2,total:100}),cart:cartView(lines,s),checkout:checkoutView({id:'q'.repeat(43),lines},s,{name:'"'.repeat(100),comment:'"'.repeat(600),phone:'"'.repeat(24)})};
  for(const [name,body]of Object.entries(cases)){const html=page(p.title,body);assert.ok(Buffer.byteLength(html)<14000,`${name}: ${Buffer.byteLength(html)} bytes`);}
});

test('anti-scraping budget persists across new browser sessions',t=>{
  const {store}=setup(t);for(let i=0;i<90;i++){store.session();assert.equal(store.limit('browse:one-ip',90,60000),true);}assert.equal(store.limit('browse:one-ip',90,60000),false);assert.equal(store.limit('browse:another-ip',90,60000),true);
});
