import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createMasterServer } from '../scripts/server.mjs';
import { openMasterStore } from '../scripts/master-store.mjs';

async function setup(t) {
  const store=openMasterStore(':memory:');let refreshes=0;
  const server=await createMasterServer({store,refreshRunner:async()=>{refreshes++;}});
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
  assert.equal((await app.request('/api/quotes',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);
  const hostileHostStatus = await new Promise((resolve,reject)=>{const request=httpRequest(app.origin+'/api/session',{headers:{host:'evil.test'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();});
  assert.equal(hostileHostStatus,403);
  assert.equal((await app.post('/api/refresh',{retailer:'Technichno'})).status,202);
  assert.equal(app.refreshes(),1);
});
test('import commit applies only the reviewed payload, with a one-use expiring token',async t=>{
  const app=await setup(t);
  const input={supplier:'Private',actor:'tester',reason:'fixture',rows:[{externalId:'sku',title:'Known',price:100000,currency:'RUB'}]};
  const result=await (await app.post('/api/imports/dry-run',input)).json();assert.equal(app.store.getOffers().length,0);
  assert.equal((await app.post('/api/imports/commit',{token:result.token,rows:[{price:1}]})).status,200);
  assert.equal(app.store.getOffers()[0].price,100000);
  assert.equal((await app.post('/api/imports/commit',{token:result.token})).status,409);
});
