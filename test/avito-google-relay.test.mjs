import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { googleRelayUrl, sendGoogleRelay } from '../scripts/avito-google-relay.mjs';
import { sendAvitoAlerts } from '../scripts/avito-alerts.mjs';

const secret='a'.repeat(64), url='https://script.google.com/macros/s/example/exec';
const env={AVITO_ALERT_RELAY_URL:url,AVITO_ALERT_RELAY_SECRET:secret};
const reply=(body,status=200,location)=>({ok:status===200,status,json:async()=>body,headers:new Headers(location?{location}:{})});

test('server authenticates Russian payload and redirects only to Google without forwarding secrets',async()=>{
  const requests=[];
  const result=await sendGoogleRelay({key:'avito:1234567890:8000000',text:'Б/у MacBook · 80 000 ₽',env,fetchImpl:async(u,options)=>{
    requests.push({u,options});
    return requests.length===1?reply(null,302,'https://script.googleusercontent.com/macros/echo?key=public'):reply({ok:true,result:{message_id:42}});
  }});
  const payload=JSON.parse(requests[0].options.body);
  assert.equal(payload.signature,createHmac('sha256',secret).update(JSON.stringify([1,payload.key,payload.text,payload.timestamp,payload.nonce])).digest('hex'));
  assert.equal(requests[0].options.redirect,'manual');
  assert.equal(requests[1].options.method,'GET');
  assert.equal(requests[1].options.body,undefined);
  assert.equal(JSON.stringify(requests).includes(secret),false);
  assert.equal(result.body.result.message_id,42);
});

test('invalid endpoints and redirects cannot receive relay credentials',async()=>{
  for(const endpoint of ['http://script.google.com/macros/s/id/exec','https://evil.test/macros/s/id/exec',url+'?token=a',url+'#token','https://user@script.google.com/macros/s/id/exec']) assert.equal(googleRelayUrl(endpoint),null);
  let calls=0;
  await assert.rejects(sendGoogleRelay({key:'test',text:'hi',env,fetchImpl:async()=>{calls++;return reply(null,302,'https://evil.test/echo');}}),/недопустимый/);
  assert.equal(calls,1);
});

async function app(fetchResult) {
  const properties=new Map([['AVITO_RELAY_SECRET',secret],['AVITO_ALERT_BOT_TOKEN','123456:synthetic'],['AVITO_ALERT_CHAT_ID','1234']]);
  let calls=0,locks=0;
  const ctx={Date,JSON,Number,Error,
    ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})},
    PropertiesService:{getScriptProperties:()=>({getProperty:key=>properties.get(key),setProperty:(key,value)=>properties.set(key,value),deleteProperty:key=>properties.delete(key)})},
    Utilities:{Charset:{UTF_8:'utf8'},computeHmacSha256Signature:(value,key)=>[...createHmac('sha256',key).update(value).digest()]},
    LockService:{getScriptLock:()=>({tryLock:()=>{locks++;return true;},releaseLock:()=>{locks--;}})},
    UrlFetchApp:{fetch:(endpoint,options)=>{calls++;assert.equal(endpoint,'https://api.telegram.org/bot123456:synthetic/sendMessage');const b=JSON.parse(options.payload);assert.equal(b.chat_id,'1234');assert.equal(b.allow_paid_broadcast,false);return fetchResult();}},
  };
  runInNewContext(await readFile(new URL('../apps-script/avito-alert-relay.gs',import.meta.url),'utf8'),ctx);
  const payload={version:1,key:'avito:1234567890:8000000',text:'Тест русского текста ₽',timestamp:Math.floor(Date.now()/1000),nonce:'a'.repeat(32)};
  payload.signature=createHmac('sha256',secret).update(JSON.stringify([1,payload.key,payload.text,payload.timestamp,payload.nonce])).digest('hex');
  return {send:(extra={})=>ctx.doPost({postData:{contents:JSON.stringify({...payload,...extra})}}),properties,calls:()=>calls,locks:()=>locks};
}

test('Google verifies signatures, freshness and deduplicates successful Telegram delivery',async()=>{
  const applet=await app(()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify({ok:true,result:{message_id:99}})}));
  for(const extra of [{signature:'0'.repeat(64)},{timestamp:0},{text:'changed'},{key:'invalid key'}]) assert.equal(applet.send(extra).ok,false);
  assert.equal(applet.calls(),0);
  assert.equal(applet.send().result.message_id,99);
  assert.equal(applet.send().duplicate,true);
  assert.equal(applet.calls(),1);
  assert.equal(applet.locks(),0);
});

test('Google persists uncertain delivery and retries only explicit rate limits',async()=>{
  const uncertain=await app(()=>{throw new Error('network');});
  assert.equal(uncertain.send().delivery_unknown,true);
  assert.equal(uncertain.send().error_code,409);
  assert.equal(uncertain.calls(),1);
  const limited=await app(()=>({getResponseCode:()=>429,getContentText:()=>JSON.stringify({ok:false,error_code:429,parameters:{retry_after:120}})}));
  assert.equal(limited.send().parameters.retry_after,120);
  assert.equal(limited.send().error_code,429);
  assert.equal(limited.calls(),2);
});

test('alerts work with relay-only credentials and bad relay configuration never falls back to direct Telegram',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'google-alerts-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  let calls=0;
  const options={dir,env,opportunities:{candidates:[{alertEligible:true,condition:'used',marketplaceSellerType:'private',comparisonKind:'used-asking-price-spread',peerCount:3,
    dedupKey:'avito:1234567890:8000000',price:80000,referencePrice:100000,deltaRub:17000,costReserveRub:3000,
    observedAt:new Date().toISOString(),url:'https://www.avito.ru/nizhniy_novgorod/noutbuki/macbook_1234567890'}]},
    fetchImpl:async endpoint=>{calls++;assert.equal(endpoint,url);return reply({ok:true,result:{message_id:1}});}};
  assert.equal((await sendAvitoAlerts(options)).sentCount,1);
  assert.equal((await sendAvitoAlerts(options)).sentCount,0);
  assert.equal(calls,1);
  assert.equal((await sendAvitoAlerts({...options,env:{...env,AVITO_ALERT_RELAY_URL:'https://evil.test',AVITO_ALERT_BOT_TOKEN:'123456:synthetic',AVITO_ALERT_CHAT_ID:'1234'}})).enabled,false);
  assert.equal(calls,1);
});

test('a relay waiting for Google deployment cannot fall back to direct Telegram even when old credentials exist', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'avito-pending-relay-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const result = await sendAvitoAlerts({dir,opportunities:{candidates:[]},env:{AVITO_ALERT_RELAY_SECRET:'a'.repeat(40),AVITO_ALERT_BOT_TOKEN:'123456:old_token',AVITO_ALERT_CHAT_ID:'1234567'},fetchImpl:async()=>assert.fail('no requests before relay deployment')});
  assert.equal(result.enabled,false);assert.equal(result.channel,'telegram');assert.match(result.message,/ожидаем разрешения/);
});
