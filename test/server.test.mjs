import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createMasterServer } from '../scripts/server.mjs';
import { openMasterStore } from '../scripts/master-store.mjs';
import { normalizeAvitoListing } from '../scripts/avito-policy.mjs';
import { record as avitoRecord } from './fixtures/avito/sample.mjs';
import { avitoSellerColumns, groupOffersByPriceColumn } from '../web/avito-columns.js';

test('Avito API exposes ranked seller prices, honest readiness and no excluded sellers', async t => {
  const app = await setup(t, { env: {} });
  const offer = normalizeAvitoListing(avitoRecord({ observedAt: new Date().toISOString() })).offer;
  app.store.ingestRun({ observations: [offer, { ...offer, listingId: 'excluded', sellerName: 'Макбучная' },
    { ...offer, listingId: 'gone', stock: 'Discontinued' }, { ...offer, listingId: 'private', visibility: 'private' }] });
  const table = await (await app.request('/api/table')).json();
  assert.equal(table.offers.length, 1);
  assert.equal(table.offers[0].sellerName, 'Магазин техники');
  assert.equal(table.offers[0].avitoRank.version, 'seller-robust-logprice-v1');
  assert.equal(table.offers[0].avitoRank.independentSellers, 0);
  assert.equal((await (await app.request('/api/status')).json()).avito.state, 'not_configured');
  assert.ok((await (await app.request('/api/session')).json()).retailers.includes('Авито НН'));
});

test('table API preserves marketplace profile IDs for per-seller Air M5 15 comparison', async t => {
  const app = await setup(t, { env: {} });
  const observations = ['seller-a', 'seller-b', 'seller-a'].map((id, index) => {
    const externalId = String(1234567800 + index);
    return normalizeAvitoListing(avitoRecord({ id: externalId,
      url: `https://www.avito.ru/nizhniy_novgorod/noutbuki/macbook_${externalId}`,
      title: 'MacBook Air 15 M5 16/512 Silver новый', price: 130000 + index * 1000,
      priceText: `${130000 + index * 1000} ₽`, seller: { id, name: 'Apple' },
      observedAt: new Date().toISOString() })).offer;
  });
  assert.ok(observations.every(Boolean));
  app.store.ingestRun({ observations });
  const { offers } = await (await app.request('/api/table')).json();
  assert.equal(offers.length, 3);
  assert.equal(avitoSellerColumns(offers).length, 2);
  assert.deepEqual([...groupOffersByPriceColumn(offers).values()].map(items => items.length).sort(), [1, 2]);
  assert.ok(offers.every(item => item.avitoRank && item.url && item.screenIn === 15 && item.chip === 'M5'));
});

async function setup(t, options = {}) {
  const store=openMasterStore(':memory:');let refreshes=0;
  const directory=await mkdtemp(`${tmpdir()}/server-state-`);
  const server=await createMasterServer({store,refreshRunner:async()=>{refreshes++;},...options,env:{TELEGRAM_BSA_STATE_PATH:`${directory}/telegram.json`,...options.env,AVITO_DATA_DIR:`${directory}/avito`}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();await rm(directory,{recursive:true,force:true});});
  const request=(path,options={})=>fetch(origin+path,options);
  const session=await (await request('/api/session')).json();
  const post=(path,body)=>request(path,{method:'POST',headers:{origin,'content-type':'application/json','x-csrf-token':session.csrfToken},body:JSON.stringify(body)});
  return {request,post,store,refreshes:()=>refreshes,origin};
}
test('Avito and retail sheets separate data and cache while preserving combined API', async t => {
  const app = await setup(t, { env: {} });
  const offer = normalizeAvitoListing(avitoRecord({ observedAt: new Date().toISOString() })).offer;
  app.store.ingestRun({ observations: [offer, {
    retailer: 'BigGeek', externalId: 'retail-sheet', title: 'MacBook Air 13 M5 16GB 512GB Silver',
    model: 'MacBook Air', url: 'https://biggeek.ru/products/retail-sheet', price: 100000,
    fetchedAt: new Date().toISOString(), visibility: 'public', dataKind: 'live',
  }] });
  const avitoResponse = await app.request('/api/table?sheet=avito');
  const avito = await avitoResponse.json();
  assert.equal(avito.offers.length, 1);
  assert.equal(avito.offers[0].retailer, 'Авито НН');
  assert.ok(avito.offers[0].avitoRank);
  assert.deepEqual(avito.telegramSources, []);
  const retailResponse = await app.request('/api/table?sheet=retail', { headers: { 'if-none-match': avitoResponse.headers.get('etag') } });
  assert.equal(retailResponse.status, 200);
  const retail = await retailResponse.json();
  assert.equal(retail.offers.length, 1);
  assert.equal(retail.offers[0].retailer, 'BigGeek');
  assert.equal((await (await app.request('/api/table')).json()).offers.length, 2);
  assert.equal((await app.request('/api/table?sheet=invalid')).status, 400);
  assert.equal((await app.request('/web/avito.html')).status, 200);
});
test('foreign sheet has separate API and refresh through existing CSRF protection', async t => {
  const root = await mkdtemp(`${tmpdir()}/foreign-api-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = await setup(t, { root });
  assert.deepEqual((await (await app.request('/api/foreign-prices')).json()).rows, []);
  assert.equal(app.refreshes(), 0);
  assert.equal((await app.post('/api/refresh', { retailer: 'AppleInsider' })).status, 202);
  assert.equal(app.refreshes(), 1);
  assert.deepEqual((await (await app.request('/api/table')).json()).offers, []);
});
test('AC17 project files and cross-site mutation are blocked; reading never refreshes',async t=>{
  const app=await setup(t);
  for(const path of ['/data/private/master.sqlite','/.git/config','/requirements.md','/data/cheapest.json','/package.json'])assert.equal((await app.request(path)).status,404,path);
  assert.equal((await app.request('/web/')).status,200);assert.equal((await app.request('/api/master')).status,200);assert.equal(app.refreshes(),0);
  assert.ok((await (await app.request('/api/session')).json()).retailers.includes('BSA'));
  assert.ok((await (await app.request('/api/session')).json()).retailers.includes('Дима'));
  assert.ok((await (await app.request('/api/session')).json()).retailers.includes('iMobile'));
  assert.ok((await (await app.request('/api/session')).json()).retailers.includes('ReSale'));
  assert.ok((await (await app.request('/api/session')).json()).retailers.includes('Apple Store'));
  assert.ok((await (await app.request('/api/session')).json()).retailers.includes('Rebro'));
  assert.ok((await (await app.request('/api/session')).json()).retailers.includes('Madstore'));
  assert.ok((await (await app.request('/api/session')).json()).retailers.includes('Smart Device'));
  assert.equal((await app.request('/api/quotes',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);
  const session = await (await app.request('/api/session')).json();
  assert.equal((await app.request('/api/refresh',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json','x-csrf-token':session.csrfToken},body:'{}'})).status,403);
  assert.equal((await app.request('/api/refresh',{method:'POST',headers:{origin:'https://macbookbro.ru','content-type':'application/json','x-csrf-token':session.csrfToken},body:JSON.stringify({retailer:'Unknown'})})).status,400);
  const hostileHostStatus = await new Promise((resolve,reject)=>{const request=httpRequest(app.origin+'/api/session',{headers:{host:'evil.test'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();});
  assert.equal(hostileHostStatus,403);
  assert.equal((await app.post('/api/refresh',{retailer:'ReSale'})).status,202);
  assert.equal(app.refreshes(),1);
});
test('desktop price API preserves 50 workbook totals and separate CPU/GPU configurations', async t => {
  const app = await setup(t);
  const data = await (await app.request('/api/desktop-prices')).json();
  assert.equal(data.currency, 'USD');
  assert.equal(data.rows.length, 50);
  assert.equal(new Set(data.rows.map(row => [row.model, row.chip, row.cpuCores, row.gpuCores, row.ramGb, row.storageGb].join('|'))).size, 50);
  for (const row of data.rows) assert.equal(row.appleUsd + row.deliveryUsd + row.customsUsd + row.serviceUsd, row.totalUsd);
  assert.equal(data.rows[0].totalUsd, 1189);
  assert.equal(data.rows.at(-1).totalUsd, 14404);
});
test('table cache revalidates unchanged data and invalidates after a write; private offers stay private', async t => {
  const app = await setup(t);
  const offer = { retailer: 'Shop', externalId: 'one', title: 'MacBook Air', model: 'MacBook Air', url: 'https://shop.test/mac', price: 100000, fetchedAt: '2026-09-25T10:00:00Z' };
  app.store.ingestRun({ runId: 'first', observations: [offer, { ...offer, externalId: 'private', visibility: 'private' }] });
  let reads = 0;
  const getOffers = app.store.getOffers;
  app.store.getOffers = (...args) => { reads++; return getOffers(...args); };
  const responses = await Promise.all(Array.from({ length: 8 }, () => app.request('/api/table')));
  assert.equal(reads, 1);
  const etag = responses[0].headers.get('etag');
  const data = await responses[0].json();
  assert.equal(data.offers.length, 1);
  assert.equal(data.offers[0].price, 100000);
  assert.equal(Object.hasOwn(data.offers[0], 'raw'), false);
  assert.equal((await app.request('/api/table', { headers: { 'if-none-match': etag } })).status, 304);
  app.store.ingestRun({ runId: 'second', observations: [{ ...offer, price: 90000, fetchedAt: '2026-09-25T11:00:00Z' }] });
  const updated = await app.request('/api/table', { headers: { 'if-none-match': etag } });
  assert.equal(updated.status, 200);
  assert.notEqual(updated.headers.get('etag'), etag);
  assert.equal((await updated.json()).offers[0].price, 90000);
  assert.equal(reads, 2);
});
test('assets and desktop prices revalidate while sessions remain uncached', async t => {
  const app = await setup(t);
  for (const path of ['/web/', '/web/app.js', '/web/price-status.js', '/web/avito-columns.js', '/web/avito-status.js', '/web/view-state.js', '/web/price-table.js', '/web/styles.css', '/api/desktop-prices']) {
    const response = await app.request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-cache');
    const cached = await app.request(path, { headers: { 'if-none-match': `W/${response.headers.get('etag')}` } });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), '');
  }
  assert.equal((await app.request('/api/session')).headers.get('cache-control'), 'no-store');
});
test('SEO assets, custom 404 and privacy-preserving analytics are served', async t => {
  const directory = await mkdtemp(`${tmpdir()}/server-analytics-`);
  t.after(async()=>{await rm(directory,{recursive:true,force:true});});
  const analyticsPath = `${directory}/analytics.ndjson`;
  const app = await setup(t, { analyticsPath });
  assert.match(await (await app.request('/robots.txt')).text(), /Sitemap: https:\/\/dev\.macbookbro\.ru\/sitemap\.xml/);
  assert.match(await (await app.request('/sitemap.xml')).text(), /<loc>https:\/\/dev\.macbookbro\.ru\/web\/<\/loc>/);
  assert.equal((await app.request('/web/og-image.jpg')).headers.get('content-type'), 'image/jpeg');
  const missing = await app.request('/definitely-missing');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /<h1>404!<\/h1>/);
  assert.equal((await app.post('/api/analytics', { event: 'page_view', path: '/web/' })).status, 200);
  const records = (await readFile(analyticsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records[0].event, 'page_view');
  assert.equal(records[0].path, '/web/');
  assert.equal(Object.hasOwn(records[0], 'ip'), false);
});
test('automatic collection runs without browser input and shares the active-job lock', async t => {
  let runs = 0;
  let release;
  const app = await setup(t, { autoRefreshIntervalMs: 25, refreshRunner: () => { runs++; return new Promise(resolve => { release = resolve; }); } });
  assert.equal(runs, 1);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(runs, 1);
  assert.equal((await app.post('/api/refresh', {})).status, 409);
  const status = await (await app.request('/api/status')).json();
  assert.equal(status.autoRefreshIntervalMs, 25);
  assert.ok(Date.parse(status.nextRefreshAt));
  release();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(runs, 2);
  release();
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


test('manual refresh includes Smart Device and accepts a source-only refresh', async t => {
  const runs=[];
  const app=await setup(t,{refreshRunner:async ({retailers})=>{runs.push(retailers);}});
  assert.equal((await app.post('/api/refresh',{})).status,202);
  assert.ok(runs[0].includes('Smart Device'));
  assert.equal((await app.post('/api/refresh',{retailer:'Smart Device'})).status,202);
  assert.deepEqual(runs[1],['Smart Device']);
});

test('AFM is available in the session, full refresh and source-only refresh', async t => {
  const runs = [];
  const app = await setup(t, { refreshRunner: async ({ retailers }) => { runs.push(retailers); } });
  assert.ok((await (await app.request('/api/session')).json()).retailers.includes('AFM'));
  assert.equal((await app.post('/api/refresh', {})).status, 202);
  assert.ok(runs[0].includes('AFM'));
  assert.equal((await app.post('/api/refresh', { retailer: 'AFM' })).status, 202);
  assert.deepEqual(runs[1], ['AFM']);
});

test('new forwarded channel runs the real collector and appears in table API without configuration', async t => {
  const root = await mkdtemp(`${tmpdir()}/telegram-end-to-end-`);
  await mkdir(`${root}/data/private`, { recursive: true });
  await mkdir(`${root}/apps-script`, { recursive: true });
  await copyFile('data/catalog.json', `${root}/data/catalog.json`);
  await copyFile('apps-script/reference.gs', `${root}/apps-script/reference.gs`);
  const store = openMasterStore(`${root}/data/private/master.sqlite`);
  store.ingestRun({ runId: 'test-initialized', observations: [] });
  const env = { ...process.env, TELEGRAM_BUSINESS_WEBHOOK_SECRET: 'fixture_secret', TELEGRAM_BSA_STATE_PATH: `${root}/data/private/telegram.json` };
  let run;
  const server = await createMasterServer({ root, store, env, telegramRefreshDelayMs: 1,
    refreshRunner: ({ retailers }) => run = promisify(execFile)(process.execPath, [resolve('scripts/build-data.mjs')], { cwd: root, env: { ...env, RETAILER: retailers.join(','), LIVE: '1' } }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await run?.catch(() => {}); store.close(); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const before = await fetch(`${origin}/api/table`);
  const etag = before.headers.get('etag'); await before.arrayBuffer();
  const now = Math.floor(Date.now() / 1000);
  const forward = (updateId, title, text) => fetch(`${origin}/api/telegram/bsa-webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': env.TELEGRAM_BUSINESS_WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: updateId, message: { message_id: updateId, date: now,
      forward_origin: { type: 'channel', date: now, chat: { id: -100998877, title }, message_id: 10 }, text } }),
  });
  const response = await forward(1, 'Новый канал', 'MacBook Air 13 M5 16/512 Silver — 100000');
  assert.deepEqual((await response.json()).refreshScheduled, ['Telegram:-100998877']);
  for (let attempt = 0; !run && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(run); await run;
  const changed = await fetch(`${origin}/api/table`, { headers: { 'if-none-match': etag } });
  assert.equal(changed.status, 200);
  const data = await changed.json();
  assert.equal(data.telegramSources[0].sourceTitle, 'Новый канал');
  assert.equal(data.offers.length, 1);
  assert.equal(data.offers[0].price, 100000);
  assert.equal(data.offers[0].sourceType, 'telegram_channel');
  assert.match(data.offers[0].url, /t.me\/c\/998877\/10/);
  const retry = await forward(2, 'Новый канал', 'MacBook Air 13 M5 16/512 Silver — 100000');
  assert.deepEqual((await retry.json()).refreshScheduled, []);
  const rename = await forward(3, 'Новое название', 'MacBook Air 13 M5 16/512 Silver — 100000');
  assert.equal(rename.status, 200);
  const renamed = await (await fetch(`${origin}/api/table`)).json();
  assert.equal(renamed.telegramSources.length, 1);
  assert.equal(renamed.telegramSources[0].sourceTitle, 'Новое название');
});
