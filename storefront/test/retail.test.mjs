import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {createHmac,randomBytes} from 'node:crypto';
import {openShopStore} from '../core.mjs';
import {openInbox} from '../inbox.mjs';
import {openRetail} from '../retail.mjs';
import {openAccounts} from '../accounts.mjs';
import {buildRecommendations} from '../prices.mjs';
import {inspectMacbook,importPriceCatalog} from '../macbook-catalog.mjs';
import {createDataSync} from '../data-sync.mjs';
import {createDispatcher} from '../integrations.mjs';
import {createShopService} from '../server.mjs';
const clock=Date.parse('2026-10-01T10:00:00Z');
const offer=(extra={})=>({model:'MacBook Air 13',chip:'M5',screenIn:13,ramGb:16,storageGb:512,color:'Silver',condition:'new',retailer:'Айфория',price:120000,currency:'RUB',stock:'InStock',url:'https://example.org/mac',fetchedAt:new Date(clock).toISOString(),...extra});
function setup(t){const dir=mkdtempSync(join(tmpdir(),'mb-retail-'));let time=clock;const store=openShopStore(join(dir,'shop.sqlite'),{now:()=>time}),inbox=openInbox(store),retail=openRetail(store),accounts=openAccounts(store,{env:{},origin:'https://shop.example'});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});store.refreshPrices(buildRecommendations([offer()],{now:time}));importPriceCatalog(store,{publish:true});return {store,inbox,retail,accounts,advance:n=>time+=n};}
const order=(store,s,input={})=>{const p=store.products()[0];store.setCart(s,{[p.id]:1});return store.placeOrder(s,{checkoutId:store.checkout(s).id,phone:'89991234567',consent:'on',...input});};

test('catalogue imports only current new valid models and repeats without duplicates or publication revisions',t=>{
 const {store}=setup(t); const id=store.products()[0].id,revision=store.product(id).revision;
 const r=importPriceCatalog(store,{publish:true});assert.equal(r.created,0);assert.equal(store.products().length,1);assert.equal(store.product(id).revision,revision);
 store.unpublish(id);importPriceCatalog(store,{publish:true});assert.equal(store.product(id).published,null);
 store.saveProduct(store.product(id).draft,{id,expectedRevision:store.product(id).revision,publish:true});
 assert.equal(inspectMacbook(offer({chip:'M4'})).ok,false);assert.equal(inspectMacbook(offer({condition:'used'})).ok,false);assert.equal(inspectMacbook(null).ok,false);
 assert.equal(inspectMacbook(offer({model:'MacBook Pro 14',screenIn:14,storageGb:1000,ramGb:32})).ok,true);
 assert.equal(inspectMacbook(offer({model:'MacBook Pro 16',screenIn:16,chip:'M5 Pro',storageGb:1000,ramGb:24,cpuCores:15,gpuCores:16})).ok,false);
 store.refreshPrices(buildRecommendations([offer({chip:'M4'}),offer({condition:'used'}),offer({model:'MacBook Pro 14',screenIn:14,chip:'M5 Max',ramGb:64,storageGb:2000})],{now:clock}));
 const skipped=importPriceCatalog(store,{publish:true});assert.equal(skipped.created,0);assert.equal(skipped.skipped,3);assert.equal(store.publicProduct(store.product(id)).priceRub,null);
});

test('delivery costs stay unknown until an immutable proposal is accepted; stale offers and forms fail',t=>{
 const {store,retail}=setup(t),s=store.session();const id=order(store,s,{deliveryMethod:'russia',deliveryCity:'Казань'});
 const snapshot=store.db.prepare('SELECT data FROM orders WHERE id=?').get(id).data;const original=JSON.parse(snapshot);assert.equal(original.grandTotalRub,null);assert.equal(retail.fulfillment(id).data.feeKopecks,null);
 assert.throws(()=>retail.updateShipment(id,{revision:1,state:'shipped',carrier:'СДЭК',tracking:'1'},'manager'),e=>e.status===409);
 const proposal=retail.propose(id,{revision:1,shippingRub:'1500',estimatedDate:'5 октября',address:'ПВЗ'},'manager');
 assert.equal(retail.orderData(store.db.prepare('SELECT * FROM orders WHERE id=?').get(id)).grandTotalRub,null);
 retail.accept(id,proposal,'customer');retail.accept(id,proposal,'customer');
 assert.equal(retail.orderData(store.db.prepare('SELECT * FROM orders WHERE id=?').get(id)).grandTotalRub,121000);assert.equal(retail.fulfillment(id).revision,2);
 assert.equal(store.db.prepare('SELECT data FROM orders WHERE id=?').get(id).data,snapshot);
 assert.throws(()=>retail.propose(id,{revision:1,shippingRub:'0',estimatedDate:'завтра'},'manager'),e=>e.status===409);
 const old=retail.propose(id,{revision:2,shippingRub:'1900',estimatedDate:'6 октября'},'manager');const latest=retail.propose(id,{revision:2,shippingRub:'1800',estimatedDate:'6 октября'},'manager');
 assert.throws(()=>retail.accept(id,old,'customer'),e=>e.status===409);retail.accept(id,latest,'customer');
 assert.equal(retail.economics(id).contributionKopecks,null);retail.saveCost(id,{status:'MANUAL',source:'Счёт поставщика',costRub:'100000',directRub:'1000'},'owner');assert.equal(retail.economics(id).recognized,false);
});

test('accounts log in by email or phone and never adopt orders merely matching their contacts',async t=>{
 const {store,accounts}=setup(t),guest=store.session();const id=order(store,guest);
 let own=await accounts.register({email:'owner@example.org',phone:'+79991234567',password:'a secure customer password',consent:'on'},guest);
 assert.equal(accounts.canViewOrder(id,own),true);assert.equal(accounts.orders(own).length,1);
 assert.notEqual(store.db.prepare('SELECT password_hash FROM customer_accounts').get().password_hash,'a secure customer password');
 let unrelated=store.session();const second=order(store,unrelated);own=accounts.logout(own);
 own=await accounts.login({identifier:'89991234567',password:'a secure customer password'},own);assert.equal(accounts.canViewOrder(id,own),true);assert.equal(accounts.canViewOrder(second,own),false);
 own=accounts.logout(own);own=await accounts.login({identifier:'OWNER@example.org',password:'a secure customer password'},own);assert.equal(accounts.orders(own).length,1);
 await assert.rejects(accounts.login({identifier:'owner@example.org',password:'wrong'},store.session()),e=>e.status===401);
 assert.throws(()=>accounts.support({orderId:second,body:'Чужой заказ'},own),e=>e.status===404);
});

test('password recovery is one-use, invalidates sessions and cannot re-send expired secrets',async t=>{
 const {store,advance}=setup(t);let payload;const accounts=openAccounts(store,{env:{STORE_MAIL_WEBHOOK_URL:'https://mailer.example/send',STORE_MAIL_WEBHOOK_TOKEN:'test'},origin:'https://shop.example',fetchImpl:async(url,options)=>{payload=JSON.parse(options.body);return Response.json({ok:true});}});
 let s=await accounts.register({email:'owner@example.org',phone:'89991234567',password:'a secure original password',consent:'on'},store.session());const old=s;
 accounts.requestReset('owner@example.org');await accounts.dispatchMail();const token=new URL(payload.text.split(' ').at(-1)).searchParams.get('token');
 assert.equal(store.db.prepare('SELECT data FROM customer_outbox').get().data,null);
 s=await accounts.reset(token,'a changed customer password',store.session());assert.equal(accounts.current(old),undefined);assert.ok(accounts.current(s));
 await assert.rejects(accounts.reset(token,'another very strong password',store.session()),e=>e.status===400);
 accounts.requestReset('owner@example.org');advance(21*60000);payload=null;await accounts.dispatchMail();assert.equal(payload,null);assert.equal(store.db.prepare("SELECT data FROM customer_outbox WHERE state='expired'").get().data,null);
});

test('MoySklad cursor only advances after complete pagination and stock snapshots replace vanished records',async t=>{
 const {store,inbox}=setup(t);let failSecond=true,stockRows=[{meta:{href:'https://api.moysklad.ru/api/remap/1.2/entity/product/stock-1'},stock:2}],phase=0;
 const sync=createDataSync(store,inbox,{env:{STORE_MOYSKLAD_TOKEN:'test'},fetchImpl:async(url)=>{const u=new URL(url);if(u.pathname.endsWith('/counterparty')){if(u.searchParams.get('offset')==='100'&&failSecond)return Response.json({}, {status:503});if(u.searchParams.get('offset')==='0')return Response.json({meta:{size:100},rows:Array.from({length:100},(_,i)=>({id:'c'+i,name:'Клиент '+i,phone:'89991234567',updated:'2026-10-01 10:00:00'}))});}
 if(u.pathname.endsWith('/stock/all')){if(phase===2)return Response.json({}, {status:503});return Response.json({rows:stockRows});}return Response.json({rows:[]});}});
 await sync.sync();let state=store.db.prepare("SELECT * FROM sync_state WHERE channel='МойСклад · counterparty'").get();assert.equal(state.state,'error');assert.equal(state.cursor,null);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM customers').get().n,100);
 const c=store.db.prepare("SELECT id FROM customers WHERE moysklad_id='c0'").get();store.db.prepare("UPDATE customers SET note='Локальная заметка' WHERE id=?").run(c.id);failSecond=false;await sync.sync();state=store.db.prepare("SELECT * FROM sync_state WHERE channel='МойСклад · counterparty'").get();assert.equal(state.state,'ready');assert.equal(JSON.parse(state.cursor).updated,'2026-10-01 10:00:00');assert.equal(store.db.prepare('SELECT note FROM customers WHERE id=?').get(c.id).note,'Локальная заметка');
 stockRows=[];await sync.sync();assert.equal(store.db.prepare("SELECT COUNT(*) n FROM ms_objects WHERE type='stock'").get().n,0);stockRows=[{meta:{href:'https://api.moysklad.ru/api/remap/1.2/entity/product/stock-2'},stock:5}];await sync.sync();phase=2;await sync.sync();assert.equal(store.db.prepare("SELECT COUNT(*) n FROM ms_objects WHERE type='stock'").get().n,1);assert.equal(store.db.prepare("SELECT state FROM sync_state WHERE channel='МойСклад · остатки'").get().state,'error');
});

test('accepted delivery and goods reach MoySklad at original prices and personalized customer identity',async t=>{
 const {store,retail}=setup(t),p=store.products()[0];store.saveProduct({...p.draft,moyskladId:'11111111-1111-4111-8111-111111111111'},{id:p.id,expectedRevision:p.revision,publish:true});const s=store.session(),id=order(store,s,{deliveryMethod:'russia',deliveryCity:'Казань'});
 const calls=[];const dispatcher=createDispatcher(store,{env:{STORE_MOYSKLAD_TOKEN:'test',STORE_MOYSKLAD_ORGANIZATION:'org',STORE_MOYSKLAD_DELIVERY_SERVICE:'delivery'},origin:'https://shop.example',fetchImpl:async(url,opts)=>{const body=opts.body&&JSON.parse(opts.body);calls.push({url,body});return Response.json(opts.method==='POST'?{id:url.endsWith('/counterparty')?'personal-agent':'order-id'}:{rows:[]});}});
 await dispatcher.dispatch();assert.equal(calls.length,0);const proposal=retail.propose(id,{revision:1,shippingRub:'1500',estimatedDate:'завтра'},'manager');retail.accept(id,proposal,'customer');await dispatcher.dispatch();const body=calls.find(c=>c.url.endsWith('/customerorder')&&c.body).body;assert.equal(body.positions[0].price,11950000);assert.equal(body.positions[1].price,150000);assert.ok(body.agent.meta.href.endsWith('personal-agent'));
});

test('HTTP account checkout, manager proposal, customer acceptance and signed ingestion are isolated',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mb-full-http-')),env={STORE_ORIGIN:'http://127.0.0.1:4199',STORE_ADMIN_PASSWORD:'owner-password-for-test-1234',STORE_MANAGER_PASSWORD:'manager-password-for-test-1234',STORE_TELEGRAM_INGEST_TOKEN:'t'.repeat(40),STORE_REQUESTS_PER_MINUTE:'1000'};
 const service=createShopService({env,dbPath:join(dir,'shop.sqlite'),now:()=>clock,priceLoader:()=>[offer()],runWorkers:false});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});await service.syncPrices();importPriceCatalog(service.store,{publish:true});const p=service.store.products()[0];
 const base=`http://127.0.0.1:${service.server.address().port}`;
 const client=()=>{let cookie='';return async(path,form,headers={},raw)=>new Promise((resolve,reject)=>{const req=httpRequest(base+path,{method:form||raw?'POST':'GET',headers:{Host:'127.0.0.1:4199',Cookie:cookie,...(form?{Origin:env.STORE_ORIGIN,'Content-Type':'application/x-www-form-urlencoded'}:{}),...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{cookie=res.headers['set-cookie']?.[0].split(';')[0]||cookie;resolve({status:res.statusCode,headers:res.headers,html:Buffer.concat(chunks).toString()});});});req.on('error',reject);req.end(raw||(form?new URLSearchParams(form).toString():undefined));});};
 const csrf=r=>r.html.match(/name="csrf" value="([^"]+)"/)[1];const customer=client(),manager=client(),stranger=client();
 let r=await customer('/account/register'),token=csrf(r);r=await customer('/account/register',{csrf:token,email:'client@example.org',phone:'89991234567',password:'secure customer password',consent:'on'});assert.equal(r.status,303);r=await customer(`/p/${p.id}`);token=csrf(r);await customer('/cart/add',{csrf:token,id:p.id});r=await customer('/checkout');assert.match(r.html,/client@example.org/);const checkoutId=r.html.match(/name="checkoutId" value="([^"]+)"/)[1];r=await customer('/checkout',{csrf:token,checkoutId,phone:'89991234567',consent:'on',deliveryMethod:'russia',deliveryCity:'Казань'});assert.equal(r.status,303);const receipt=r.headers.location,id=receipt.split('/').at(-1);assert.equal((await stranger(receipt)).status,404);
 r=await manager('/crm/login');await manager('/crm/login',{csrf:csrf(r),password:env.STORE_MANAGER_PASSWORD});r=await manager(`/crm/orders/${id}`);const mt=csrf(r);assert.doesNotMatch(r.html,/name="costRub"/);assert.equal((await manager(`/crm/orders/${id}/cost`,{csrf:mt,status:'FACT',costRub:'0',source:'free'})).status,403);
 r=await manager(`/crm/orders/${id}/propose`,{csrf:mt,revision:1,shippingRub:'1500',estimatedDate:'5 октября'});assert.equal(r.status,303);r=await customer(receipt);assert.match(r.html,/Подтвердить эти условия/);const proposalId=r.html.match(/name="proposalId" value="([^"]+)"/)[1];assert.equal((await customer(receipt+'/accept',{csrf:token,proposalId})).status,303);assert.match((await customer(receipt)).html,/121.*000/);assert.match((await customer('/account')).html,new RegExp(id));
 const packet=Buffer.from(JSON.stringify({accountId:'123',username:'macbookbro',dialogs:[],complete:true})),nonce=randomBytes(16).toString('hex'),stamp=String(clock);const signature=createHmac('sha256',env.STORE_TELEGRAM_INGEST_TOKEN).update(stamp+'\n'+nonce+'\n').update(packet).digest('hex'),headers={'Content-Type':'application/json','X-MB-Timestamp':stamp,'X-MB-Nonce':nonce,'X-MB-Signature':signature};
 assert.equal((await stranger('/internal/inbox/telegram',null,headers,packet)).status,200);assert.equal((await stranger('/internal/inbox/telegram',null,headers,packet)).status,409);assert.equal((await stranger('/internal/inbox/telegram',null,{...headers,'X-MB-Signature':'a'.repeat(64)},packet)).status,403);
});
