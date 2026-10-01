import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openShopStore} from '../core.mjs';import {openInbox} from '../inbox.mjs';import {openRetail,crmDate} from '../retail.mjs';
import {openCrmDesk} from '../crm-desk.mjs';import {importTelegramExport} from '../telegram-export.mjs';
import {createTelegramBusinessCrm} from '../telegram-business-crm.mjs';import {createDataSync} from '../data-sync.mjs';
import {accountingEvidence,currencyAmount} from '../crm-accounting.mjs';import {inboxDialog} from '../inbox-views.mjs';
const clock=Date.parse('2026-10-01T10:00:00Z'),owner='123';
const env={STORE_CRM_TELEGRAM_BOT_TOKEN:'private-test-token',STORE_CRM_TELEGRAM_EXPECTED_BOT:'mbroadmin_bot',STORE_TELEGRAM_ACCOUNT_ID:owner};
const connection={id:'work',user:{id:Number(owner)},rights:{can_reply:true},is_enabled:true};
function setup(t){const dir=mkdtempSync(join(tmpdir(),'mb-desk-'));let time=clock;const store=openShopStore(join(dir,'shop.sqlite'),{now:()=>time}),inbox=openInbox(store),retail=openRetail(store),desk=openCrmDesk(store,inbox,retail);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,inbox,retail,desk,advance:n=>time+=n};}
function archive(){return {personal_information:{user_id:123,username:'macbookbro'},chats:{list:[{id:999,name:'Александр',type:'personal_chat',messages:[{id:1,type:'message',from_id:'user999',date_unixtime:String(clock/1000-3600),text:['Выбираю ',{text:'MacBook'}]},{id:2,type:'service',date_unixtime:String(clock/1000-3500),action:'joined'}]},{id:555,name:'Private group',type:'private_group',messages:[]}]}};}
function message(updateId=2,extra={}){return {update_id:updateId,business_message:{business_connection_id:'work',message_id:10,date:clock/1000,chat:{id:999,type:'private',first_name:'Александр'},from:{id:999},text:'Вопрос клиента',...extra}};}
function botFetch(updates=[],{onCall=()=>{},conn=connection,webhook='',failConnection=false}={}){return async (url,options)=>{const method=url.split('/').at(-1),body=JSON.parse(options.body);onCall(method,body);let result;
 if(method==='getMe')result={id:77,is_bot:true,username:'mbroadmin_bot'};else if(method==='getWebhookInfo')result={url:webhook};else if(method==='getUpdates')result=updates;
 else if(method==='getBusinessConnection'){if(failConnection)return Response.json({ok:false},{status:503});result=conn;}else if(method==='sendMessage')result={message_id:50,date:clock/1000};else throw new Error('Unexpected method');return Response.json({ok:true,result});};}

test('Telegram archive excludes groups, checks owner, keeps unknown read state and survives repeat import without overwriting live data',t=>{
 const {store,inbox,retail,desk}=setup(t),data=archive();assert.throws(()=>importTelegramExport(store,inbox,desk,data,'x','456'),e=>e.status===400);
 const report=importTelegramExport(store,inbox,desk,data,'one',owner);assert.deepEqual(report,{dialogs:1,messages:2,excluded:1});const d=inbox.list()[0],c=desk.context(d.id).customer;
 assert.equal(d.unread,-1);assert.equal(d.history_complete,0);assert.equal(inbox.dialog(d.id).archive_messages,2);assert.equal(desk.context(d.id).profile.suggested_segment,'Mac');
 retail.saveCustomer({id:c.id,note:'Заметка менеджера',segment:'Повторный клиент'},'manager');
 inbox.saveMessages(d.id,[{id:1,direction:'in',body:'Изменено в Telegram',kind:'text',createdAt:clock}]);store.db.prepare("UPDATE inbox_accounts SET state='live'").run();
 importTelegramExport(store,inbox,desk,data,'one',owner);assert.equal(inbox.messages(d.id).find(m=>m.remote_id==='1').body,'Изменено в Telegram');assert.equal(inbox.accounts()[0].state,'live');assert.equal(retail.customer(c.id).note,'Заметка менеджера');assert.equal(desk.contacts({}).total,1);
 assert.equal(desk.contacts({q:'АЛЕКСАНДР'}).total,1);assert.equal(inbox.list({q:'изменено'}).length,1);
});

test('Business updates reject foreign owners, identify bot replies, respect disabled rights and the 24-hour reply window',async t=>{
 const {store,inbox,desk,advance}=setup(t),calls=[];let conn=connection;const bot=createTelegramBusinessCrm(store,inbox,desk,{env,fetchImpl:(u,o)=>botFetch([],{conn,onCall:(m,b)=>calls.push(m)})(u,o)});
 assert.throws(()=>bot.apply({update_id:1,business_connection:{...connection,user:{id:456}}}),e=>e.status===403);
 bot.apply({update_id:1,business_connection:connection});bot.apply(message());const d=inbox.list()[0];assert.equal(bot.capability(d).allowed,true);
 bot.apply(message(3,{message_id:11,from:{id:77},sender_business_bot:{id:77},text:'Наш ответ'}));assert.equal(inbox.messages(d.id).find(m=>m.remote_id==='11').direction,'out');
 conn={...connection,rights:{can_reply:false},can_reply:true};await assert.rejects(bot.send(d,'No send'),e=>e.status===403);assert.equal(calls.includes('sendMessage'),false);assert.equal(bot.capability(d).allowed,false);
 bot.apply({update_id:4,business_connection:connection});advance(86400000);assert.equal(bot.capability(d).allowed,false);
 bot.apply({update_id:5,business_connection:{...connection,is_enabled:false}});assert.equal(bot.capability(d).allowed,false);
});

test('Business deletion creates tombstones that an older archive cannot resurrect',t=>{
 const {store,inbox,desk}=setup(t),bot=createTelegramBusinessCrm(store,inbox,desk,{env});bot.apply({update_id:1,business_connection:connection});
 bot.apply({update_id:2,deleted_business_messages:{business_connection_id:'work',chat:{id:999},message_ids:[1]}});
 importTelegramExport(store,inbox,desk,archive(),'old',owner);const d=inbox.list()[0];assert.equal(inbox.messages(d.id).find(m=>m.remote_id==='1').kind,'deleted');
});

test('Telegram persists offsets only with durable events and retries deferred events without blocking valid ones',async t=>{
 const {store,inbox,desk,advance}=setup(t);const updates=[message(1),{update_id:2,business_connection:{...connection,id:'foreign',user:{id:456}}},{update_id:3,business_connection:connection},message(4,{message_id:11})];
 const bot=createTelegramBusinessCrm(store,inbox,desk,{env,fetchImpl:botFetch(updates,{failConnection:true})});await bot.poll();
 assert.equal(store.setting('crm_telegram_offset'),5);assert.equal(store.db.prepare("SELECT state FROM telegram_update_queue WHERE update_id=1").get().state,'pending');assert.equal(store.db.prepare("SELECT state FROM telegram_update_queue WHERE update_id=2").get().state,'ignored');
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM inbox_messages').get().n,1);assert.equal(store.db.prepare('SELECT payload FROM telegram_update_queue WHERE update_id=4').get().payload,'{}');
 advance(16000);const restart=createTelegramBusinessCrm(store,inbox,desk,{env,fetchImpl:botFetch([])});await restart.poll();assert.equal(store.db.prepare('SELECT COUNT(*) n FROM inbox_messages').get().n,2);assert.equal(store.db.prepare("SELECT COUNT(*) n FROM telegram_update_queue WHERE state='pending'").get().n,0);
 await restart.poll();assert.equal(store.db.prepare('SELECT COUNT(*) n FROM inbox_messages').get().n,2);
});

test('an existing Telegram webhook is retained and prevents polling; identity mismatch prevents any consumption',async t=>{
 const {store,inbox,desk}=setup(t),calls=[];const bot=createTelegramBusinessCrm(store,inbox,desk,{env,fetchImpl:botFetch([],{webhook:'https://owner.example/webhook',onCall:m=>calls.push(m)})});await bot.poll();assert.equal(calls.includes('getUpdates'),false);assert.equal(calls.includes('deleteWebhook'),false);assert.equal(store.setting('crm_telegram_status').state,'error');
});

test('manual contact linking works past the first hundred contacts and preserves notes, deals and customer access',t=>{
 const {store,inbox,desk,retail}=setup(t),a=inbox.saveAccount('telegram',owner,'@macbookbro'),d=inbox.saveDialog(a.id,{id:999,title:'Клиент'}),source=desk.ensureCustomer(d.id),target=retail.saveCustomer({name:'Контрагент'},'owner');
 retail.saveCustomer({id:source,note:'Оригинальная заметка'},'manager');const deal=retail.saveDeal({customerId:source,title:'Компьютер'},'manager');for(let i=0;i<130;i++)retail.saveCustomer({name:'Промежуточный '+i},'import');
 assert.equal(desk.contacts({q:'КОНТРАГЕНТ'}).rows[0].id,target.id);desk.linkContact(d.id,target.id,'manager');assert.equal(desk.context(d.id).customer.id,target.id);assert.equal(retail.customer(source).note,'Оригинальная заметка');assert.equal(store.db.prepare('SELECT customer_id FROM deals WHERE id=?').get(deal).customer_id,source);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM account_orders').get().n,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM crm_merges').get().n,1);
});

test('accounting uses conducted 2026 documents and their currency IDs, subtracts returns, never invents historical FX or cost',t=>{
 const {store,inbox,desk,retail}=setup(t),sync=createDataSync(store,inbox,{env:{}});sync.ingestMoysklad('currency',[{id:'rub',isoCode:'RUB'},{id:'usd',isoCode:'USD',rate:85,multiplicity:1}]);
 const c=retail.saveCustomer({name:'Покупатель'},'owner');store.db.prepare('UPDATE customers SET moysklad_id=? WHERE id=?').run('agent',c.id);
 const doc={applicable:true,moment:'2026-10-01 12:00:00',agent:{meta:{href:'https://api.moysklad.ru/api/remap/1.2/entity/counterparty/agent'}},rate:{currency:{meta:{href:'https://api.moysklad.ru/api/remap/1.2/entity/currency/rub'}}},sum:100000};
 sync.ingestMoysklad('demand',[{...doc,id:'sale'},{...doc,id:'unposted',applicable:false},{...doc,id:'old',moment:'2025-12-31 12:00:00'},{...doc,id:'usd',rate:{value:80,currency:{id:'usd'}},sum:10000}]);sync.ingestMoysklad('salesreturn',[{...doc,id:'return',sum:1000}]);
 const e=desk.accounting(c.id);assert.equal(e.sales,2);assert.equal(e.returns,1);assert.equal(e.knownRubKopecks,99000);assert.equal(e.netKopecks,null);assert.equal(e.unknown,1);assert.equal(e.complete,false);assert.equal(currencyAmount(store,{sum:100,_crmCurrency:'RUB'}).rubKopecks,null);
 assert.throws(()=>desk.setKind(retail.saveCustomer({name:'Supplier'},'owner').id,'customer','owner'),e=>e.status===400);
});

test('deal stages keep a history, filters paginate, and reminders use Moscow time',t=>{
 const {store,retail,desk}=setup(t),c=retail.saveCustomer({name:'Клиент'},'owner');const id=retail.saveDeal({customerId:c.id,title:'Заказ'},'manager');retail.saveDeal({id,revision:1,state:'offered',title:'Заказ',nextAt:'2026-10-02T12:00'},'manager');
 assert.equal(retail.deals({state:'new'}).length,0);assert.equal(retail.deals({state:'offered'}).length,1);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM deal_events WHERE deal_id=?').get(id).n,2);
 assert.throws(()=>retail.saveDeal({id,revision:1,state:'won'},'manager'),e=>e.status===409);
 const task=desk.remind(c.id,{title:'Позвонить',dueAt:'2026-10-02T12:00'},'manager');assert.equal(retail.tasks()[0].due_at,Date.parse('2026-10-02T09:00:00Z'));retail.finishTask(task,'manager');assert.equal(retail.tasks().length,0);assert.equal(retail.tasks({state:'done'}).length,1);assert.throws(()=>crmDate('tomorrow'),e=>e.status===400);
});

test('desk history pagination preserves selected dialog and renders imported HTML as text',t=>{
 const {inbox}=setup(t),a=inbox.saveAccount('telegram',owner,'@macbookbro'),d=inbox.saveDialog(a.id,{id:999,title:'<script>bad</script>',unread:null});inbox.saveMessages(d.id,Array.from({length:101},(_,i)=>({id:i+1,direction:'in',body:'<img onerror=bad>',createdAt:clock+i})));
 const html=inboxDialog(inbox,d,{csrf:'safe'},{compact:true});assert.ok(html.includes(`/crm/desk?dialog=${d.id}&messageOffset=100#history`));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img onerror'));assert.ok(!html.includes(`/crm/inbox/${d.id}/profile`));
});

test('a deferred older business edit cannot resurrect a newer deletion or restore disabled connection rights',t=>{
 const {store,inbox,desk}=setup(t),bot=createTelegramBusinessCrm(store,inbox,desk,{env});bot.apply({update_id:10,business_connection:connection});bot.apply(message(11));
 bot.apply({update_id:13,deleted_business_messages:{business_connection_id:'work',chat:{id:999},message_ids:[10]}});
 const edit=message(12,{text:'Old edit'});bot.apply({update_id:12,edited_business_message:edit.business_message});assert.equal(inbox.messages(inbox.list()[0].id)[0].kind,'deleted');
 bot.apply({update_id:15,business_connection:{...connection,is_enabled:false}});bot.apply({update_id:14,business_connection:connection});assert.equal(store.db.prepare("SELECT enabled FROM telegram_connections WHERE id='work'").get().enabled,0);
});

test('manager HTTP desk, contact search, stage filters and document linking remain authenticated and CSRF protected',async t=>{
 const {createShopService}=await import('../server.mjs'),{request}=await import('node:http');const dir=mkdtempSync(join(tmpdir(),'mb-desk-http-'));
 const service=createShopService({env:{STORE_ORIGIN:'http://127.0.0.1:4199',STORE_MANAGER_PASSWORD:'manager-crm-test-password-2026',STORE_REQUESTS_PER_MINUTE:'1000'},dbPath:join(dir,'shop.sqlite'),runWorkers:false,now:()=>clock});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
 const {store,inbox,retail,desk,dataSync}=service,a=inbox.saveAccount('telegram',owner,'@macbookbro'),d=inbox.saveDialog(a.id,{id:999,title:'Тестовый клиент',unread:null}),id=desk.ensureCustomer(d.id);
 const client=()=>{let cookie='';return async(path,form)=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:service.server.address().port,path,method:form?'POST':'GET',headers:{Host:'127.0.0.1:4199',Cookie:cookie,...(form?{Origin:'http://127.0.0.1:4199','Content-Type':'application/x-www-form-urlencoded'}:{})}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{cookie=res.headers['set-cookie']?.[0].split(';')[0]||cookie;resolve({status:res.statusCode,body,location:res.headers.location});});});req.on('error',reject);req.end(form?new URLSearchParams(form).toString():undefined);});};
 const manager=client(),guest=client();assert.equal((await guest('/crm/desk')).location,'/crm/login');let r=await manager('/crm/login');let csrf=r.body.match(/name="csrf" value="([^"]+)"/)[1];await manager('/crm/login',{csrf,password:'manager-crm-test-password-2026'});
 r=await manager('/crm/desk?dialog='+d.id);assert.equal(r.status,200);csrf=r.body.match(/name="csrf" value="([^"]+)"/)[1];assert.match(r.body,/crm-workspace/);
 assert.equal((await manager(`/crm/desk/${d.id}/deal`,{title:'No CSRF'})).status,403);assert.equal((await manager(`/crm/desk/${d.id}/deal`,{csrf,title:'Подбор компьютера'})).status,303);
 assert.equal((await manager('/crm/contacts?q='+encodeURIComponent('ТЕСТОВЫЙ'))).status,200);assert.match((await manager('/crm/contacts?q='+encodeURIComponent('ТЕСТОВЫЙ'))).body,/клиенты · 1/);
 const deal=retail.deals()[0];assert.match((await manager(`/crm/deals/${deal.id}`)).body,/История этапов/);assert.doesNotMatch((await manager('/crm/deals?state=won')).body,/Подбор компьютера/);
 assert.equal((await manager(`/crm/desk/link?dialog=${d.id}`)).status,200);assert.equal((await manager(`/crm/deals/${deal.id}/document`,{csrf,document:'demand:foreign'})).status,400);
 store.db.prepare('UPDATE customers SET moysklad_id=? WHERE id=?').run('agent',id);dataSync.ingestMoysklad('currency',[{id:'rub',isoCode:'RUB'}]);dataSync.ingestMoysklad('demand',[{id:'sale',applicable:true,moment:'2026-10-01 10:00:00',sum:100,agent:{id:'agent'},rate:{currency:{id:'rub'}}}]);
 assert.equal((await manager(`/crm/deals/${deal.id}/document`,{csrf,document:'demand:sale'})).status,303);assert.equal((await manager(`/crm/customers/${id}/accounting`)).status,200);assert.equal((await manager('/crm/integrations')).status,200);
});
