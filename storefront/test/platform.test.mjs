import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createShopService } from '../server.mjs';
import { maintainShop } from '../maintenance.mjs';
import { syncLegacyOrders } from '../legacy-orders.mjs';
import { createOrderService } from '../../order-site/server.mjs';

async function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'mb-platform-')),file=join(dir,'staff.json');
  const users=['Vlad','VladJr','Max','Sasha'].map(username=>({username,role:username==='Max'?'owner':'manager',salt:'1'.repeat(32),hash:scryptSync(username,'1'.repeat(32),32).toString('hex')}));
  writeFileSync(file,JSON.stringify(users),{mode:0o600});
  let clock=Date.parse('2026-10-01T12:00:00Z');
  const env={STORE_ORIGIN:'https://macbookbro.ru',STORE_CRM_ORIGIN:'https://crm.macbookbro.ru',STORE_STAFF_COOKIE_DOMAIN:'macbookbro.ru',STORE_STAFF_USERS_FILE:file,STORE_TRUST_PROXY:'loopback',STORE_REQUESTS_PER_MINUTE:'1000'};
  const service=createShopService({env,dbPath:join(dir,'shop.sqlite'),now:()=>clock,runWorkers:false});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
  function client(host='crm.macbookbro.ru') {
    const cookies=new Map();
    const call=(path,form,extra={})=>new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port:service.server.address().port,path,method:form?'POST':'GET',headers:{Host:host,Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...(form?{Origin:'https://'+host,'Content-Type':'application/x-www-form-urlencoded'}:{}),...extra}},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{for(const cookie of res.headers['set-cookie']||[]){const [key,value]=cookie.split(';')[0].split('=');cookies.set(key,value);}resolve({status:res.statusCode,headers:res.headers,html:Buffer.concat(chunks).toString()});});
      });req.on('error',reject);req.end(form?new URLSearchParams(form).toString():undefined);
    });
    return {call,cookies};
  }
  return {dir,service,client,advance:ms=>clock+=ms};
}
const csrf=r=>r.html.match(/name="csrf" value="([^"]+)"/)[1];

test('four named employees authenticate, rotate sessions and record individual actors; owner rights stay separate',async t=>{
  const {service,client}=await setup(t);
  for(const name of ['Vlad','VladJr','Max','Sasha']){
    const browser=client();const login=await browser.call('/crm/login'),old=browser.cookies.get('mb_session');
    assert.match(login.html,/autocomplete="username"/);
    assert.equal((await browser.call('/crm/login',{username:name,password:name,csrf:csrf(login)})).status,303);
    assert.notEqual(browser.cookies.get('mb_session'),old);
    const page=await browser.call('/crm');assert.equal(page.status,200);assert.match(page.html,new RegExp(name));
    const internal=client('macbookbro.ru');internal.cookies.set('mb_staff_session',browser.cookies.get('mb_staff_session'));
    assert.equal((await internal.call('/internal/staff-auth')).status,204);
    const result=await browser.call('/crm/integrations/run',{csrf:csrf(page)});
    assert.equal(result.status,name==='Max'?303:403);
    assert.ok(service.store.db.prepare("SELECT 1 FROM audit WHERE actor=? AND event='login'").get(name));
  }
});

test('CRM blocks forged proxy credentials, wrong origin, bad CSRF and repeated guesses; stale employee cookies do not prevent login',async t=>{
  const {client}=await setup(t),browser=client();
  assert.equal((await browser.call('/crm',null,{'X-Store-Admin-Key':'forged'})).status,303);
  const login=await browser.call('/crm/login');
  assert.equal((await browser.call('/crm/login',{username:'Max',password:'Max',csrf:csrf(login)},{Origin:'https://dev.macbookbro.ru'})).status,403);
  assert.equal((await browser.call('/crm/login',{username:'Max',password:'Max',csrf:'bad'})).status,403);
  for(let i=0;i<8;i++)assert.equal((await browser.call('/crm/login',{username:'unknown',password:'wrong',csrf:csrf(login)})).status,401);
  assert.equal((await browser.call('/crm/login',{username:'unknown',password:'wrong',csrf:csrf(login)})).status,429);
  const fresh=client();fresh.cookies.set('mb_staff_session','invalid-old-token');
  const form=await fresh.call('/crm/login');assert.equal(form.status,200);
  assert.equal((await fresh.call('/crm/login',{username:'Max',password:'Max',csrf:csrf(form)},{'X-Forwarded-For':'192.0.2.22'})).status,303);
});

test('logout and expiration revoke parser access; anonymous catalogue creates no session and uses conditional responses',async t=>{
  const {service,client,advance}=await setup(t),publicClient=client('macbookbro.ru');
  let r=await publicClient.call('/');assert.equal(r.status,200);assert.equal(r.headers['set-cookie'],undefined);
  assert.equal(service.store.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);
  assert.equal((await publicClient.call('/',null,{'If-None-Match':r.headers.etag})).status,304);
  const browser=client(),login=await browser.call('/crm/login');await browser.call('/crm/login',{username:'Max',password:'Max',csrf:csrf(login)});
  const auth=client('macbookbro.ru');auth.cookies.set('mb_staff_session',browser.cookies.get('mb_staff_session'));
  assert.equal((await auth.call('/internal/staff-auth')).status,204);
  const crm=await browser.call('/crm');await browser.call('/crm/logout',{csrf:csrf(crm)});
  assert.equal((await auth.call('/internal/staff-auth')).status,303);
  advance(3*3600000);assert.equal((await browser.call('/crm')).status,303);
});

test('legacy orders import once with original ID and quoted sum, reject mutated accepted data and never enqueue outgoing publication',async t=>{
  const {dir,service}=await setup(t),path=join(dir,'legacy.sqlite'),db=new DatabaseSync(path);
  db.exec('CREATE TABLE orders(id TEXT PRIMARY KEY,payload TEXT,request_key TEXT,created_at INTEGER)');
  const payload={phone:'+79991234567',name:'Test',configurationDescription:'Mac mini M4',priceRub:100000,paymentMethod:'cash',consentVersion:'old'};
  db.prepare('INSERT INTO orders VALUES(?,?,?,?)').run('MB-AABBCCDD',JSON.stringify(payload),'legacy-request-key',1);
  assert.equal(syncLegacyOrders(service.store,service.retail,path),1);
  assert.equal(syncLegacyOrders(service.store,service.retail,path),0);
  const saved=service.store.db.prepare('SELECT data FROM orders').get().data;
  assert.equal(JSON.parse(saved).totalRub,100000);assert.equal(JSON.parse(saved).delivery.state,'pending');
  assert.equal(service.store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
  service.store.db.prepare("UPDATE orders SET note='manager note'").run();syncLegacyOrders(service.store,service.retail,path);
  assert.equal(service.store.db.prepare('SELECT note FROM orders').get().note,'manager note');
  db.prepare('UPDATE orders SET payload=?').run(JSON.stringify({...payload,priceRub:200000}));
  assert.throws(()=>syncLegacyOrders(service.store,service.retail,path),/changed/);assert.equal(service.store.db.prepare('SELECT data FROM orders').get().data,saved);db.close();
  const before=service.store.db.prepare('SELECT COUNT(*) n FROM orders').get().n;
  const expired=service.store.session();service.store.db.prepare('UPDATE sessions SET expires=0 WHERE id=?').run(expired.id);
  maintainShop(service.store);assert.equal(service.store.db.prepare('SELECT COUNT(*) n FROM orders').get().n,before);
});

test('early legacy configurations retain unknown prices; the historical relay fixture is not a customer order',async t=>{
  const {dir,service}=await setup(t),path=join(dir,'early.sqlite'),db=new DatabaseSync(path);
  db.exec('CREATE TABLE orders(id TEXT PRIMARY KEY,payload TEXT,request_key TEXT,created_at INTEGER)');
  const configuration={model:'mini',chip:'m4',memory:16,storage:256,ethernet:1};
  const payload={configuration,phone:'+79991234567',name:'Test',consentVersion:'old'};
  const insert=db.prepare('INSERT INTO orders VALUES(?,?,?,?)');
  insert.run('MB-RELAY-TEST',JSON.stringify(payload),'relay-test',1);
  insert.run('MB-01234567',JSON.stringify(payload),'early-real',2);
  assert.equal(syncLegacyOrders(service.store,service.retail,path),1);
  const order=JSON.parse(service.store.db.prepare('SELECT data FROM orders').get().data);
  assert.equal(order.totalRub,null);assert.deepEqual(order.legacyConfiguration,configuration);
  assert.equal(order.lines[0].specification,JSON.stringify(configuration));
  assert.equal(service.store.setting('legacy_orders_sync').skippedTests,1);
  assert.equal(service.store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
  db.close();
});

test('mounted order application serves relative assets and rejects POSTs from the former subdomain',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mb-mounted-'));
  const service=createOrderService({env:{ORDER_BASE_PATH:'/order',ORDER_ORIGIN:'https://macbookbro.ru'},dbPath:join(dir,'orders.sqlite'),runWorker:false});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+service.server.address().port;
  const r=await fetch(base+'/order/');assert.equal(r.status,200);assert.match(await r.text(),/href="\.\/style.css"/);
  assert.equal((await fetch(base+'/order/app.js')).status,200);assert.equal((await fetch(base+'/order/api/status')).status,200);
  assert.equal((await fetch(base+'/order/api/orders',{method:'POST',headers:{Origin:'https://order.macbookbro.ru','Content-Type':'application/json'},body:'{}'})).status,403);
});
