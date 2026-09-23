import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createMasterServer } from '../scripts/server.mjs';
import { openMasterStore } from '../scripts/master-store.mjs';

async function setup(t, options = {}) {
  const store=openMasterStore(':memory:');let refreshes=0;
  const server=await createMasterServer({store,refreshRunner:async()=>{refreshes++;},...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  const request=(path,options={})=>fetch(origin+path,options);
  const session=await (await request('/api/session')).json();
  const post=(path,body)=>request(path,{method:'POST',headers:{origin,'content-type':'application/json','x-csrf-token':session.csrfToken},body:JSON.stringify(body)});
  return {request,post,store,refreshes:()=>refreshes,origin};
}
test('AC17 project files and cross-site mutation are blocked; reading never refreshes',async t=>{
  const app=await setup(t);
  for(const path of ['/data/private/master.sqlite','/.git/config','/requirements.md','/data/cheapest.json','/package.json'])assert.equal((await app.request(path)).status,404,path);
  assert.equal((await app.request('/web/')).status,200);assert.equal((await app.request('/api/master')).status,200);assert.equal(app.refreshes(),0);
  assert.ok((await (await app.request('/api/session')).json()).retailers.includes('BSA'));
  assert.ok((await (await app.request('/api/session')).json()).retailers.includes('Дима'));
  assert.ok((await (await app.request('/api/session')).json()).retailers.includes('iMobile'));
  assert.ok((await (await app.request('/api/session')).json()).retailers.includes('ReSale'));
  assert.equal((await app.request('/api/quotes',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);
  const hostileHostStatus = await new Promise((resolve,reject)=>{const request=httpRequest(app.origin+'/api/session',{headers:{host:'evil.test'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();});
  assert.equal(hostileHostStatus,403);
  assert.equal((await app.post('/api/refresh',{retailer:'ReSale'})).status,202);
  assert.equal(app.refreshes(),1);
});
test('Telegram webhook requires its secret and bypasses browser CSRF only for that route',async t=>{
  const directory = await mkdtemp(`${tmpdir()}/server-webhook-`);
  t.after(async()=>{await rm(directory,{recursive:true,force:true});});
  const env={TELEGRAM_BUSINESS_WEBHOOK_SECRET:'telegram_webhook_secret',TELEGRAM_BSA_STATE_PATH:`${directory}/state.json`};
  const app=await setup(t,{env,telegramRefreshDelayMs:5});
  const body={update_id:50,business_message:{message_id:900,date:1800000600,chat:{id:-1001,type:'channel',username:'BigSaleApple'},text:'23/09/2026\nMDH74 Air 13 (M5 16/512) Silver-126.500'}};
  const send=secret=>app.request('/api/telegram/bsa-webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify(body)});
  assert.equal((await send('wrong')).status,403);
  const response=await send(env.TELEGRAM_BUSINESS_WEBHOOK_SECRET);
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).refreshScheduled,['BSA']);
  const saved=JSON.parse(await readFile(env.TELEGRAM_BSA_STATE_PATH,'utf8'));
  assert.equal(saved.messages[0].id,'900');
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(app.refreshes(),1);
  const dima={update_id:51,message:{message_id:901,date:1800000601,chat:{id:42,type:'private'},forward_origin:{type:'channel',chat:{id:-1003421701174,type:'channel',title:'прайс от Л'},message_id:634},text:'MacBook MDHH4 Air 13 Sky Blue (M5, 16GB, 512GB) 2026 123500'}};
  const dimaResponse=await app.request('/api/telegram/bsa-webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':env.TELEGRAM_BUSINESS_WEBHOOK_SECRET},body:JSON.stringify(dima)});
  assert.deepEqual((await dimaResponse.json()).refreshScheduled,['Дима']);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(app.refreshes(),2);
});
test('import commit applies only the reviewed payload, with a one-use expiring token',async t=>{
  const app=await setup(t);
  const input={supplier:'Private',actor:'tester',reason:'fixture',rows:[{externalId:'sku',title:'Known',price:100000,currency:'RUB'}]};
  const result=await (await app.post('/api/imports/dry-run',input)).json();assert.equal(app.store.getOffers().length,0);
  assert.equal((await app.post('/api/imports/commit',{token:result.token,rows:[{price:1}]})).status,200);
  assert.equal(app.store.getOffers()[0].price,100000);
  assert.equal((await app.post('/api/imports/commit',{token:result.token})).status,409);
});
