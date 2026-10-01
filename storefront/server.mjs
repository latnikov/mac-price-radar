import http from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { openShopStore, fail, hash, opaque, CHANNELS, ORDER_STATES } from './core.mjs';
import { buildRecommendations, readPriceSource } from './prices.mjs';
import { yandexFeed, avitoFeed, avitoOptions, createDispatcher } from './integrations.mjs';
import { esc, rub, when, hidden, csrf, page, catalogue, productView, cartView, checkoutView, editor, channelNames, stateNames } from './views.mjs';
import { openInbox } from './inbox.mjs';
import { inboxList, inboxDialog } from './inbox-views.mjs';
import { createAvitoInboxApi } from './avito-inbox.mjs';
import { openRetail } from './retail.mjs';
import { openAccounts } from './accounts.mjs';
import { createDataSync, configuredSecret } from './data-sync.mjs';
import { importPriceCatalog } from './macbook-catalog.mjs';
import { customerRoutes } from './customer-routes.mjs';
import { retailRoutes } from './retail-routes.mjs';
import { telegramIngest } from './telegram-ingest.mjs';
import { inboxCustomerLink } from './retail-views.mjs';
import { openCrmDesk } from './crm-desk.mjs';
import { contactLinkView, deskView, deskSummary, contactDirectory } from './crm-desk-views.mjs';
import { createTelegramBusinessCrm } from './telegram-business-crm.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const equal=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);};
const objectForm=form=>{const data={};for(const key of new Set(form.keys())) data[key]=key==='channels'?form.getAll(key):form.get(key);return data;};
const tokenFrom=req=>String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('mb_session='))?.slice(11);
const textField=(v,n=80)=>String(v||'').slice(0,n);

export function createShopService({env=process.env,dbPath=env.STORE_DB||resolve(root,'../data/private/storefront/shop.sqlite'),now=Date.now,fetchImpl=fetch,priceLoader,runWorkers=true}={}) {
  env={...env,STORE_MOYSKLAD_TOKEN:configuredSecret(env,'STORE_MOYSKLAD_TOKEN')};
  const origin=env.STORE_ORIGIN||'http://127.0.0.1:4190';
  const originUrl=new URL(origin);
  if(!['http:','https:'].includes(originUrl.protocol)||originUrl.pathname!=='/')throw new Error('STORE_ORIGIN must be an origin');
  const mediaDir=env.STORE_MEDIA_DIR||resolve(dirname(dbPath),'media');mkdirSync(mediaDir,{recursive:true,mode:0o700});
  const store=openShopStore(dbPath,{now});
  const inbox=openInbox(store);
  const retail=openRetail(store);
  const desk=openCrmDesk(store,inbox,retail);
  desk.reconcileDialogs();
  const telegramCrm=createTelegramBusinessCrm(store,inbox,desk,{env,fetchImpl});
  const accounts=openAccounts(store,{env,fetchImpl,origin});
  const dataSync=createDataSync(store,inbox,{env,fetchImpl});
  const ingestTelegram=telegramIngest(store,dataSync,configuredSecret(env,'STORE_TELEGRAM_INGEST_TOKEN'));
  const avitoApis=new Map();
  for(const prefix of ['AVITO','AVITO_2']){
    if(env[`${prefix}_CLIENT_ID`]&&env[`${prefix}_CLIENT_SECRET`]){
      // Identity binding is explicit: an account cannot send using another profile's credentials.
      const remoteId=String(env[`${prefix}_ACCOUNT_ID`]||'');
      if(remoteId)avitoApis.set(remoteId,createAvitoInboxApi({clientId:env[`${prefix}_CLIENT_ID`],clientSecret:env[`${prefix}_CLIENT_SECRET`],fetchImpl}));
    }
  }
  const replyAdapter=d=>d.channel==='telegram'&&env.STORE_TELEGRAM_SEND_ENABLED==='1'&&telegramCrm.capability(d).allowed
    ?telegramCrm.send:d.channel==='avito'&&env.STORE_INBOX_SEND_ENABLED==='1'&&avitoApis.has(d.account_remote_id)
    ? async(dialog,body)=>avitoApis.get(dialog.account_remote_id).send(dialog.account_remote_id,dialog.remote_id,body) : null;
  const readPassword=(kind)=>env[`STORE_${kind}_PASSWORD_FILE`]?readFileSync(env[`STORE_${kind}_PASSWORD_FILE`],'utf8').trim():env[`STORE_${kind}_PASSWORD`]||'';
  const ownerPassword=readPassword('ADMIN'),managerPassword=readPassword('MANAGER');
  const proxySecret=env.STORE_PROXY_AUTH_TOKEN_FILE?readFileSync(env.STORE_PROXY_AUTH_TOKEN_FILE,'utf8').trim():env.STORE_PROXY_AUTH_TOKEN||'';
  if(ownerPassword&&ownerPassword.length<16)throw new Error('Administrator password must be at least 16 characters');
  if(managerPassword&&managerPassword.length<16)throw new Error('Manager password must be at least 16 characters');
  const loginSalt=store.setting('login_salt')||opaque();store.setSetting('login_salt',loginSalt);
  const ownerHash=ownerPassword?scryptSync(ownerPassword,loginSalt,32):null;
  const managerHash=managerPassword?scryptSync(managerPassword,loginSalt,32):null;
  const ipSalt=store.setting('ip_salt')||opaque();store.setSetting('ip_salt',ipSalt);
  const dispatcher=createDispatcher(store,{env,origin,fetchImpl});
  let refreshing=false;
  async function syncPrices(){
    if(refreshing)return;refreshing=true;
    try{const offers=await(priceLoader?priceLoader():readPriceSource(env,fetchImpl));
      store.refreshPrices(buildRecommendations(offers,{now:now(),maxAgeMs:Number(env.STORE_PRICE_MAX_AGE_MS)||4*3600000,ownSellerIds:(env.STORE_OWN_SELLER_IDS||'').split(',').filter(Boolean)}));
      if(env.STORE_AUTO_CATALOG==='1'||store.setting('catalog_auto_import'))importPriceCatalog(store,{publish:true,actor:'price_sync'});
    }catch{store.setSetting('price_sync',{ok:false,at:now(),message:'Не удалось обновить прайс dev. Сохранены исходные даты цен.'});store.reconcilePrices();}
    finally{refreshing=false;}
  }
  function cookie(res,s){res.setHeader('Set-Cookie',`mb_session=${s.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${originUrl.protocol==='https:'?'; Secure':''}`);}
  function send(req,res,status,body,type='text/html; charset=utf-8'){
    let data=Buffer.from(body);
    res.setHeader('Content-Type',type);
    if(data.length>512&&/\bgzip\b/.test(req.headers['accept-encoding']||'')){data=gzipSync(data);res.setHeader('Content-Encoding','gzip');}
    res.setHeader('Vary','Accept-Encoding');res.setHeader('Content-Length',data.length);res.writeHead(status);res.end(req.method==='HEAD'?undefined:data);
  }
  const redirect=(res,path)=>{res.writeHead(303,{Location:path});res.end();};
  async function body(req,multipart=false){
    const chunks=[];let length=0;const limit=multipart?5*1024*1024+16384:24000;
    for await(const chunk of req){length+=chunk.length;if(length>limit)throw fail(413,'Слишком большой запрос.');chunks.push(chunk);}
    const buffer=Buffer.concat(chunks);
    if(multipart){try{return objectForm(await new Request(`${origin}/upload`,{method:'POST',headers:{'content-type':req.headers['content-type']},body:buffer}).formData());}catch{throw fail(400,'Не удалось прочитать фотографию.');}}
    if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type']||''))throw fail(415,'Нужна обычная форма сайта.');
    return objectForm(new URLSearchParams(buffer.toString()));
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    let s,url;
    try{
      if(req.headers.host!==originUrl.host)throw fail(400,'Неверный адрес сайта.');
      url=new URL(req.url,origin);const path=url.pathname;
      if(!['GET','HEAD','POST'].includes(req.method))throw fail(405,'Метод не поддерживается.');
      const peer=req.socket.remoteAddress||'';
      const trusted=env.STORE_TRUST_PROXY==='loopback'&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer);
      const ip=trusted?String(req.headers['x-forwarded-for']||peer).split(',').at(-1).trim():peer;
      const ipKey=createHmac('sha256',ipSalt).update(ip).digest('hex');
      if(path==='/internal/inbox/telegram'&&req.method==='POST')return await ingestTelegram(req,res);
      if(path==='/healthz'){store.db.prepare('SELECT 1').get();return send(req,res,200,'{"ok":true}','application/json');}
      // Separate feed access from browser budgets. Secrets are never written to access logs here.
      const feed=path.match(/^\/feeds\/(yandex|avito)\/([A-Za-z0-9_-]+)\.xml$/);
      if(feed){
        if(req.method!=='GET'&&req.method!=='HEAD')throw fail(405,'Метод не поддерживается.');
        if(!env.STORE_FEED_TOKEN||env.STORE_FEED_TOKEN.length<32||!equal(feed[2],env.STORE_FEED_TOKEN))throw fail(404,'Страница не найдена.');
        if(!store.limit(`feed:${ipKey}`,30,60000))throw fail(429,'Попробуйте позже.');
        if(feed[1]==='avito'&&env.STORE_AVITO_FEED_ENABLED!=='1')throw fail(503,'Автозагрузка Авито ещё не настроена.');
        store.reconcilePrices();
        const value=feed[1]==='yandex'?yandexFeed(store,origin):avitoFeed(store,avitoOptions(env,origin));
        res.setHeader('X-Robots-Tag','noindex, nofollow');
        if(req.method==='GET'){
          store.setSetting(`${feed[1]}_feed_served`,{at:now(),sha256:hash(value)});
          store.db.prepare("UPDATE jobs SET state='served',error=NULL WHERE channel=? AND state IN ('queued','retry','ready')").run(feed[1]);
        }
        return send(req,res,200,value,'application/xml; charset=utf-8');
      }
      if(!store.limit(`browse:${ipKey}`,Number(env.STORE_REQUESTS_PER_MINUTE)||90,60000)){res.setHeader('Retry-After','60');throw fail(429,'Слишком много запросов. Подождите минуту.');}
      s=store.session(tokenFrom(req));s.ipKey=ipKey;cookie(res,s);
      if(path.startsWith('/crm')&&trusted&&proxySecret.length>=32&&equal(req.headers['x-store-admin-key']||'',proxySecret)){
        if(s.role!=='owner'){s=store.rotateSession(s,'owner');cookie(res,s);}
      }
      const cartCount=Object.values(s.cart).reduce((a,b)=>a+b,0);
      const render=(title,content,options={})=>send(req,res,options.status||200,page(title,content,{cart:cartCount,...options}));
      const adminRender=(title,content,options={})=>render(title,content,{admin:true,role:s.role,...options});
      let form;
      if(req.method==='POST'){
        if(req.headers.origin!==origin)throw fail(403,'Отправьте форму с сайта магазина.');
        if(!store.limit(`write:${ipKey}`,30,60000))throw fail(429,'Подождите минуту перед повтором.');
        form=await body(req,/^multipart\/form-data/.test(req.headers['content-type']||''));
        if(!equal(form.csrf||'',s.csrf))throw fail(403,'Обновите страницу и повторите действие.');
      }
      if(await customerRoutes({path,req,res,url,s,form,store,accounts,retail,render,redirect,cookie}))return;
      if(path==='/crm/login'){
        if(req.method==='POST'){
          if(!store.limit(`login:${ipKey}`,8,15*60000))throw fail(429,'Слишком много попыток входа. Попробуйте через 15 минут.');
          const supplied=scryptSync(textField(form.password,256),loginSalt,32);
          const role=ownerHash&&timingSafeEqual(supplied,ownerHash)?'owner':managerHash&&timingSafeEqual(supplied,managerHash)?'manager':null;
          if(!role)return render('Вход',loginForm(s),{status:401,notice:ownerHash?'Пароль не подошёл.':'Доступ CRM ещё не настроен на сервере.',error:true});
          s=store.rotateSession(s,role);cookie(res,s);store.audit(role,'login','crm');return redirect(res,'/crm');
        }
        return render('Вход',loginForm(s));
      }
      if(path.startsWith('/crm')){
        res.setHeader('X-Robots-Tag','noindex, nofollow');
        if(!s.role)return redirect(res,'/crm/login');
        const deskWrite=/^\/crm\/desk\/[a-f0-9]{64}\/(customer|deal|remind|link)$/;
        const managerWrite=/^\/crm\/(?:orders\/MB-[A-F0-9]{12}(?:\/(?:shipment|propose|accept))?|inbox\/[a-f0-9]{64}\/(?:profile|draft|send|link)|customers\/save|deals\/save|deals\/[a-f0-9-]{36}\/document|tasks\/save|tasks\/[a-f0-9-]{36}\/done|requests\/[a-f0-9-]{36}\/reply)$/;
        if(req.method==='POST'&&path!=='/crm/logout'&&!managerWrite.test(path)&&!deskWrite.test(path)&&s.role!=='owner')throw fail(403,'Действие доступно владельцу.');
        if(path==='/crm/desk/link'&&req.method!=='POST') return adminRender('Связь с клиентом',contactLinkView(desk,textField(url.searchParams.get('dialog'),64),{q:textField(url.searchParams.get('q'),100),offset:Math.max(0,Math.trunc(Number(url.searchParams.get('offset')))||0)},s));
        if(path==='/crm/desk'&&req.method!=='POST'){
          const dialogId=textField(url.searchParams.get('dialog'),64),d=dialogId?inbox.dialog(dialogId):null;
          if(dialogId&&!d)throw fail(404,'Диалог не найден.');
          const reason=d?.channel==='telegram'?telegramCrm.capability(d).reason:d&&!replyAdapter(d)?'Отправка Авито ждёт проверки прав и тарифа этого профиля.':'';
          return adminRender('Единая переписка',deskView(inbox,desk,s,{dialogId,q:textField(url.searchParams.get('q'),100),accountId:textField(url.searchParams.get('account'),64),unread:url.searchParams.get('unread')==='1',offset:Math.max(0,Math.trunc(Number(url.searchParams.get('offset')))||0)},d?inboxDialog(inbox,d,s,{compact:true,canSend:Boolean(replyAdapter(d)),offset:Math.max(0,Math.trunc(Number(url.searchParams.get('messageOffset')))||0)}):'',reason));
        }
        if(path==='/crm/sales'&&req.method!=='POST')return adminRender('Воронка и метрики',deskSummary(desk));
        if(path==='/crm/contacts'&&req.method!=='POST')return adminRender('Контакты',contactDirectory(desk,{q:textField(url.searchParams.get('q'),100),segment:textField(url.searchParams.get('segment'),100),kind:textField(url.searchParams.get('kind'),40),offset:Math.max(0,Math.trunc(Number(url.searchParams.get('offset')))||0)},s));
        const deskAction=path.match(deskWrite);
        if(deskAction&&req.method==='POST'){
          const id=desk.ensureCustomer(path.split('/')[3]),customer=retail.customer(id),action=deskAction[1];
          if(action==='customer'){store.tx(()=>{retail.saveCustomer({id,segment:form.segment,note:form.note},s.role);desk.setKind(id,form.kind,s.role);});}
          if(action==='deal')retail.saveDeal({customerId:id,title:form.title,state:'new'},s.role);
          if(action==='remind')desk.remind(id,form,s.role);
          if(action==='link')desk.linkContact(path.split('/')[3],form.customerId,s.role);
          return redirect(res,`/crm/desk?dialog=${path.split('/')[3]}`);
        }
        if(await retailRoutes({path,req,res,url,s,form,store,retail,desk,adminRender,redirect,sync:()=>background(dataSync.sync)}))return;
        if(path==='/crm/logout'&&req.method==='POST'){store.db.prepare('UPDATE sessions SET role=NULL,auth_until=0 WHERE id=?').run(s.id);return redirect(res,'/');}
        if(path==='/crm/inbox'&&req.method!=='POST')return adminRender('Переписка',inboxList(inbox,{
          q:textField(url.searchParams.get('q'),100),accountId:textField(url.searchParams.get('account'),64),
          unread:url.searchParams.get('unread')==='1',offset:Math.max(0,Number(url.searchParams.get('offset'))||0),
        }));
        const inboxPath=path.match(/^\/crm\/inbox\/([a-f0-9]{64})(?:\/(profile|draft|send))?$/);
        if(inboxPath){
          const d=inbox.dialog(inboxPath[1]);if(!d)throw fail(404,'Диалог не найден.');
          if(req.method==='POST'){
            if(inboxPath[2]==='profile')inbox.edit(d.id,form,s.role);
            else if(inboxPath[2]==='draft')inbox.draft(d.id,form.body,s.role);
            else if(inboxPath[2]==='send'){
              if(!inbox.outgoing(d.id).some(m=>m.id===form.replyId))throw fail(404,'Ответ не найден в этом диалоге.');
              await inbox.send(form.replyId,replyAdapter(d),s.role);
            }else throw fail(405,'Метод не поддерживается.');
            return redirect(res,`/crm/desk?dialog=${d.id}`);
          }
          if(inboxPath[2])throw fail(405,'Метод не поддерживается.');
          const linked=store.db.prepare('SELECT customer_id FROM dialog_customers WHERE dialog_id=?').get(d.id);
          return adminRender('Диалог',inboxDialog(inbox,d,s,{offset:Math.max(0,Number(url.searchParams.get('offset'))||0),canSend:Boolean(replyAdapter(d))})+inboxCustomerLink(d,linked?retail.customer(linked.customer_id):null,retail.customers(),s));
        }
        if(path==='/crm'&&req.method!=='POST'){
          const counts=store.db.prepare("SELECT COUNT(*) AS total,SUM(state='new') AS fresh,MIN(CASE WHEN state='new' THEN created_at END) AS oldest_new FROM orders").get();
          const problemJobs=store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('blocked','unknown','retry')").get().n;
          const priceSync=store.setting('price_sync');
          const oldestWaitMinutes=counts.oldest_new==null?null:Math.max(0,Math.floor((now()-counts.oldest_new)/60000));
          return adminRender('Обзор',`<h2>Рабочий стол</h2><div class="row"><div class="box"><b>${counts.fresh||0}</b> новых заказов<br><a href="/crm/orders">Открыть заказы →</a></div><div class="box"><b>${store.products().filter(p=>p.published).length}</b> опубликованных товаров<br><a href="/crm/products">Управлять каталогом →</a></div></div>${oldestWaitMinutes!==null?`<p class="notice">Старейший новый заказ ожидает ${oldestWaitMinutes} мин.</p>`:''}${problemJobs?`<p class="notice">Операций обмена требуют проверки: ${problemJobs}. <a href="/crm/channels">Открыть обмен →</a></p>`:''}<p class="notice">${priceSync?.ok?`Прайс dev получен ${when(priceSync.at)}. Конфигураций: ${priceSync.count}.`:priceSync?.message||'Подключите прайс dev, затем добавьте свои компьютеры.'}</p><p>Порядок работы: карточка → рекомендованная цена → сайт → выбранные каналы.</p><p><a href="/crm/customers">Клиенты</a> · <a href="/crm/integrations">Проверить получение данных</a> · <a href="/crm/requests">Обращения из кабинета</a></p><form action="/crm/logout" method="post">${csrf(s)}<button>Выйти</button></form>`);
        }
        if(path==='/crm/products'&&req.method!=='POST'){
          return adminRender('Товары',`<h2>Каталог новых MacBook</h2>${s.role==='owner'?`<form method="post" action="/crm/products/import">${csrf(s)}<label><input type="checkbox" name="publish" checked> Публиковать и обновлять актуальные конфигурации из цен dev</label><button>Загрузить каталог из ценников</button></form><p class="muted">${store.setting('catalog_import')?`Последний импорт: создано ${store.setting('catalog_import').created}, обновлено ${store.setting('catalog_import').updated}, пропущено ${store.setting('catalog_import').skipped}.`: 'Публикуются только новые модели актуальной линейки с проверенной свежей ценой.'}</p>`:''}<p><a class="button primary" href="/crm/products/new">Добавить компьютер</a></p>${store.products().map(p=>`<div class="box"><a href="/crm/products/${p.id}">${esc(p.draft.title)}</a><p>${p.published?'Опубликован на сайте':'Черновик'} · ${rub(store.publicProduct(p)?.priceRub)}</p></div>`).join('')||'<p>Создайте первую карточку. Цены конкурентов сами по себе не создают товары магазина.</p>'}`);
        }
        if(path==='/crm/products/new'&&req.method!=='POST')return adminRender('Новый компьютер',editor(null,allRecommendations(),s));
        if(path==='/crm/products/save'&&req.method==='POST'){
          const escapedSize=['title','description','specification','warranty'].reduce((v,k)=>v+Buffer.byteLength(esc(form[k]||'')),0);
          if(escapedSize>6000)throw fail(400,'Сократите описание и характеристики: карточка должна загружаться быстро.');
          const p=store.saveProduct(form,{id:form.id||undefined,actor:s.role,publish:form.action==='publish',expectedRevision:form.revision});
          return redirect(res,`/crm/products/${p.id}`);
        }
        const productPath=path.match(/^\/crm\/products\/([a-f0-9-]{36})(?:\/(photo|unpublish))?$/);
        if(productPath){
          const p=store.product(productPath[1]);if(!p)throw fail(404,'Товар не найден.');
          if(productPath[2]==='unpublish'&&req.method==='POST'){store.unpublish(p.id,s.role);return redirect(res,`/crm/products/${p.id}`);}
          if(productPath[2]==='photo'&&req.method==='POST'){
            if(p.draft.photos.length>=6)throw fail(400,'Допускается до шести фотографий.');
            if(!form.photo?.arrayBuffer)throw fail(400,'Выберите фотографию.');
            const data=Buffer.from(await form.photo.arrayBuffer());
            const ext=data.subarray(0,3).equals(Buffer.from([255,216,255]))?'jpg':data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP'?'webp':null;
            if(!ext||data.length>5*1024*1024||data.length<32)throw fail(400,'Нужна фотография JPEG, PNG или WebP до 5 МБ.');
            const filename=`${hash(data)}.${ext}`;writeFileSync(resolve(mediaDir,filename),data,{mode:0o600});
            store.addPhoto(p.id,filename,form.revision,s.role);
            return redirect(res,`/crm/products/${p.id}`);
          }
          if(!productPath[2]&&req.method!=='POST')return adminRender(p.draft.title,editor(p,allRecommendations(),s));
        }
        if(path==='/crm/prices/refresh'&&req.method==='POST'){await syncPrices();return redirect(res,'/crm/prices');}
        if(path==='/crm/prices'&&req.method!=='POST'){
          const q=textField(url.searchParams.get('q')).toLowerCase(),rows=allRecommendations().filter(r=>r.label.toLowerCase().includes(q));
          return adminRender('Цены dev',`<h2>Рекомендованные цены</h2><form method="post" action="/crm/prices/refresh">${csrf(s)}<button>Обновить из dev</button></form><form><label>Поиск конфигурации<input name="q" value="${esc(q)}"></label><button>Найти</button></form><p class="muted">Та же формула, что в колонке «Рекоменд. цена». Без повторной скидки.</p>${rows.slice(0,100).map(r=>`<div class="box"><b>${esc(r.label)}</b><p>${rub(r.recommendedRub)} · ${esc(r.issues.join('; ')||'Можно публиковать')}</p><small>${esc(r.benchmark?.retailer||'Нет ориентира')} · Наблюдения: ${when(r.observedAt)}</small></div>`).join('')||'<p>Пока нет данных. Настройте источник dev на сервере.</p>'}${rows.length>100?'<p>Уточните поиск, чтобы увидеть остальные конфигурации.</p>':''}`);
        }
        if(path==='/crm/orders'&&req.method!=='POST'){
          const q=textField(url.searchParams.get('q')).toLowerCase();
          const orders=store.db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all().filter(o=>`${o.id} ${JSON.parse(o.data).phone} ${JSON.parse(o.data).name}`.toLowerCase().includes(q));
          return adminRender('Заказы',`<h2>Заказы</h2><form><label>Номер, телефон или имя<input name="q" value="${esc(q)}"></label><button>Найти</button></form>${orders.slice(0,100).map(o=>`<div class="box"><a href="/crm/orders/${o.id}">${o.id}</a> · ${esc(stateNames[o.state])}<p>${esc(JSON.parse(o.data).name||'Покупатель')} · ${esc(JSON.parse(o.data).phone)} · ${rub(JSON.parse(o.data).totalRub)}</p><small>${when(o.created_at)}</small></div>`).join('')||'<p>Новых заказов пока нет.</p>'}`);
        }
        if(path==='/crm/channels/run'&&req.method==='POST'){await dispatcher.dispatch();return redirect(res,'/crm/channels');}
        const reconcile=path.match(/^\/crm\/jobs\/(\d+)\/reconcile$/);
        if(reconcile&&req.method==='POST'){
          const job=store.db.prepare('SELECT * FROM jobs WHERE id=?').get(Number(reconcile[1]));
          if(!job||job.state!=='unknown')throw fail(409,'Эта отправка не требует сверки.');
          let remoteId=String(form.remoteId||'').trim();
          if(job.channel==='telegram'){
            if(!/^\d{1,16}$/.test(remoteId)||!env.STORE_TELEGRAM_CHANNEL)throw fail(400,'Укажите номер сообщения в настроенном канале.');
            remoteId=JSON.stringify({chatId:env.STORE_TELEGRAM_CHANNEL,messageId:Number(remoteId),kind:form.kind==='photo'?'photo':'text'});
          }else if(job.channel==='moysklad'){
            if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(remoteId))throw fail(400,'Укажите UUID записи МойСклад.');
          }else throw fail(400,'У этого канала нет отдельного идентификатора публикации.');
          store.tx(()=>{
            store.db.prepare('INSERT INTO publications VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(entity,entity_id,channel) DO UPDATE SET remote_id=excluded.remote_id,revision=excluded.revision,state=excluded.state,updated_at=excluded.updated_at').run(job.entity,job.entity_id,job.channel,remoteId,job.revision,'published',null,now());
            store.db.prepare("UPDATE jobs SET state='published',error=NULL WHERE id=?").run(job.id);
            store.db.prepare("UPDATE jobs SET state='queued',next_at=0,error=NULL WHERE entity=? AND entity_id=? AND channel=? AND state='blocked'").run(job.entity,job.entity_id,job.channel);
            store.audit(s.role,'delivery_reconciled',String(job.id));
          });return redirect(res,'/crm/channels');
        }
        const retry=path.match(/^\/crm\/jobs\/(\d+)\/retry$/);
        if(retry&&req.method==='POST'){
          const job=store.db.prepare('SELECT * FROM jobs WHERE id=?').get(Number(retry[1]));if(!job)throw fail(404,'Операция не найдена.');
          if(job.state==='unknown'&&form.confirmedAbsent!=='on')throw fail(409,'Проверьте площадку: публикация могла быть создана.');
          store.db.prepare("UPDATE jobs SET state='queued',next_at=0,error=NULL WHERE id=?").run(job.id);store.audit(s.role,'delivery_retry',String(job.id));return redirect(res,'/crm/channels');
        }
        if(path==='/crm/channels'&&req.method!=='POST'){
          const jobs=store.db.prepare("SELECT * FROM jobs WHERE state<>'superseded' ORDER BY id DESC LIMIT 100").all();
          const feedToken=env.STORE_FEED_TOKEN;
          return adminRender('Каналы',`<h2>Публикации и обмен</h2><p>Сначала товар появляется на сайте. Затем обновляется каждый выбранный канал.</p><div class="box"><b>Telegram:</b> ${env.STORE_TELEGRAM_TOKEN&&env.STORE_TELEGRAM_CHANNEL?'Подключение задано':'Нужны бот и канал'}<br><b>МойСклад:</b> ${env.STORE_MOYSKLAD_TOKEN?'Подключение задано':'Нужен доступ к аккаунту'}<br><b>Авито:</b> ${env.STORE_AVITO_FEED_ENABLED==='1'?'Файл автозагрузки включён':'Нужна проверка формата и настройка автозагрузки'}<br><b>Яндекс:</b> <a href="https://yandex.ru/maps/-/CXUEqIZC" rel="noreferrer">Карточка, указанная владельцем</a><p>${s.role==='owner'&&feedToken?`Ссылка для Яндекс Бизнеса:<br><code>${esc(`${origin}/feeds/yandex/${feedToken}.xml`)}</code>`:'Для ссылки выгрузки настройте серверный ключ.'}</p><small>Готовый или запрошенный файл ещё не подтверждает публикацию в Картах.</small></div><form method="post" action="/crm/channels/run">${csrf(s)}<button>Обработать очередь</button></form>${jobs.map(j=>`<div class="box"><b>${channelNames[j.channel]}</b> · ${esc(stateNames[j.state]||j.state)}<p>${esc(j.entity_id)} · версия ${j.revision}</p>${j.error?`<p>${esc(j.error)}</p>`:''}${['blocked','retry','unknown'].includes(j.state)&&s.role==='owner'?`<form method="post" action="/crm/jobs/${j.id}/retry">${csrf(s)}${j.state==='unknown'?'<label><input type="checkbox" name="confirmedAbsent" required> Проверил площадку: публикация точно не создана</label>':''}<button>Повторить</button></form>${j.state==='unknown'?`<form method="post" action="/crm/jobs/${j.id}/reconcile">${csrf(s)}<label>Уже создано: ${j.channel==='telegram'?'номер сообщения':'UUID записи'}<input name="remoteId" required></label>${j.channel==='telegram'?'<label>Формат<select name="kind"><option value="text">Текст</option><option value="photo">Фото с подписью</option></select></label>':''}<button>Связать с существующей публикацией</button></form>`:''}`:''}</div>`).join('')||'<p>Публикаций пока нет.</p>'}`);
        }
        if(path==='/crm/exports/avito.xml'&&req.method!=='POST'&&s.role==='owner')return send(req,res,200,avitoFeed(store,avitoOptions(env,origin)),'application/xml; charset=utf-8');
        throw fail(404,'Страница CRM не найдена.');
      }
      const media=path.match(/^\/media\/([a-f0-9]{64}\.(jpg|png|webp))$/);
      if(media&&req.method!=='POST'){
        const allowed=store.products().some(p=>p.published?.photos.includes(media[1])||(s.role&&p.draft.photos.includes(media[1])));
        if(!allowed||!existsSync(resolve(mediaDir,media[1])))throw fail(404,'Фотография не найдена.');
        return send(req,res,200,readFileSync(resolve(mediaDir,media[1])),`image/${media[2]==='jpg'?'jpeg':media[2]}`);
      }
      if(req.method==='POST'){
        if(path==='/cart/add'){
          const p=store.publicProduct(store.product(String(form.id)));if(!p)throw fail(404,'Предложение закрыто.');
          if(Object.keys(s.cart).length>=4&&!s.cart[p.id])throw fail(400,'В одном заказе можно выбрать до четырёх разных компьютеров.');
          const cap=store.product(p.id).published.individual?1:10;
          store.setCart(s,{...s.cart,[p.id]:Math.min(cap,(s.cart[p.id]||0)+1)});return redirect(res,'/cart');
        }
        if(path==='/cart/update'){
          const cart={};for(const id of Object.keys(s.cart)){const qty=Number(form[`qty_${id}`]);const cap=store.product(id)?.published?.individual?1:10;if(!Number.isInteger(qty)||qty<0||qty>cap)throw fail(400,`Для этой позиции количество должно быть от 0 до ${cap}.`);if(qty)cart[id]=qty;}
          store.setCart(s,cart);return redirect(res,'/cart');
        }
        if(path==='/checkout'){
          if(env.STORE_ACCEPTING_ORDERS==='0')throw fail(503,'Приём заказов временно приостановлен.');
          try{const id=store.placeOrder(s,form);return redirect(res,`/orders/${id}`);}
          catch(e){if(e.status===400||e.status===409){let quote;try{quote=store.checkout(s);}catch{return render('Проверьте корзину',cartView(store.cartLines(s),s),{status:e.status,notice:e.message,error:true});}return render('Проверьте заказ',checkoutView(quote,s,{phone:textField(form.phone,24),name:textField(form.name,100),email:textField(form.email,254),deliveryMethod:form.deliveryMethod,deliveryCity:textField(form.deliveryCity,100),deliveryAddress:textField(form.deliveryAddress,250),comment:textField(form.comment,600),payment:form.payment}),{status:e.status,notice:e.message,error:true});}throw e;}
        }
        throw fail(404,'Страница не найдена.');
      }
      if(path==='/'||path==='/catalog'){
        const q=textField(url.searchParams.get('q')),family=textField(url.searchParams.get('family'),10),category=textField(url.searchParams.get('category'),40),p=Math.max(1,Math.min(10000,Math.trunc(Number(url.searchParams.get('p')))||1));
        const all=store.products().map(store.publicProduct).filter(Boolean);
        const selected=all.filter(o=>(!family||o.family===family)&&(!category||o.category===category)&&`${o.title} ${o.specification} ${o.configuration.color}`.toLowerCase().includes(q.toLowerCase()));
        return render('Компьютеры',catalogue(selected.slice((p-1)*4,p*4),{q,category,family,p,total:selected.length,categories:[...new Set(all.map(p=>p.category))].slice(0,10)}));
      }
      const detail=path.match(/^\/p\/([a-f0-9-]{36})(\/photos)?$/);
      if(detail){const p=store.publicProduct(store.product(detail[1]));if(!p)throw fail(404,'Предложение закрыто. Посмотрите другие компьютеры в каталоге.');return render(p.title,detail[2]?`<h2>${esc(p.title)}</h2><p><a href="/p/${p.id}">← Вернуться к карточке</a></p>${p.photos.map(f=>`<p><img src="/media/${f}" alt="${esc(p.title)}"></p>`).join('')}`:productView(p,s));}
      if(path==='/cart')return render('Корзина',cartView(store.cartLines(s),s));
      if(path==='/checkout'){const a=accounts.current(s);return render('Оформление',checkoutView(store.checkout(s),s,{email:a?.email,phone:a?.phone}));}
      if(path==='/contacts')return render('Контакты',`<h2>Приходите в Макбучную</h2><p>г. Нижний Новгород, ул. Грузинская, 41а</p><p><a href="https://yandex.ru/maps/-/CXUEqIZC" rel="noreferrer">Открыть в Яндекс Картах →</a></p>${env.STORE_CONTACT_PHONE?`<p>Телефон: ${esc(env.STORE_CONTACT_PHONE)}</p>`:''}${env.STORE_OPENING_HOURS?`<p>${esc(env.STORE_OPENING_HOURS)}</p>`:''}`);
      if(path==='/terms')return render('Условия заказа','<h2>Как заказать</h2><p>Выберите компьютер, добавьте его в корзину и оставьте телефон. Мы свяжемся с вами, подтвердим комплектацию, стоимость, срок и способ получения.</p><p>При оформлении деньги не списываются. Оплата после подтверждения: наличные или счёт для ИП и организации.</p><p>Условия гарантии указаны в карточке компьютера. Дополнительные вопросы можно указать в комментарии к заказу.</p>');
      if(path==='/privacy')return render('Обработка данных',`<h2>Данные для заказа</h2><p>Мы используем телефон, имя и комментарий для связи и исполнения вашего заказа. Данные сохраняются в закрытой системе магазина и доступны сотрудникам, которые работают с заказами.</p><p>При подключённом товарном учёте сведения заказа передаются в МойСклад. В товарные публикации Авито, Telegram и Яндекс Карт контакты покупателей не включаются.</p><p>Для корзины и защиты форм используется необходимый файл cookie. Рекламные скрипты не загружаются.</p><p>${esc(env.STORE_SELLER_DETAILS||'По вопросам обработки данных обратитесь в магазин: Нижний Новгород, Грузинская, 41а.')}</p>`);
      if(path==='/robots.txt')return send(req,res,200,`User-agent: *\nDisallow: /crm\nDisallow: /feeds/\nDisallow: /cart\nDisallow: /checkout\nDisallow: /orders/\nDisallow: /account\nDisallow: /internal/\nSitemap: ${origin}/sitemap.xml\n`,'text/plain');
      if(path==='/sitemap.xml')return send(req,res,200,`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${esc(origin)}/</loc></url>${store.products().map(store.publicProduct).filter(Boolean).map(p=>`<url><loc>${esc(origin)}/p/${p.id}</loc></url>`).join('')}</urlset>`,'application/xml');
      throw fail(404,'Страница не найдена.');
    }catch(e){
      const status=e.status||500;
      if(status===429)res.setHeader('Retry-After','60');
      send(req,res,status,page(status===404?'Не найдено':'Не удалось выполнить действие',`<h2>${status===404?'Страница не найдена':'Проверьте действие'}</h2><p>${esc(status<500?e.message:'Не удалось выполнить действие. Попробуйте ещё раз.')}</p><p><a href="${url?.pathname.startsWith('/crm')?'/crm':'/'}">Вернуться →</a></p>`));
    }
  });
  function allRecommendations(){return store.db.prepare('SELECT data FROM recommendations ORDER BY key').all().map(r=>JSON.parse(r.data)).sort((a,b)=>a.label.localeCompare(b.label,'ru',{numeric:true}));}
  const loginForm=s=>`<h2>Вход для сотрудников</h2><form action="/crm/login" method="post">${csrf(s)}<label>Пароль<input type="password" name="password" autocomplete="current-password" required maxlength="256"></label><button class="primary">Войти</button></form>`;
  const timers=[],pending=new Set();
  const background=fn=>{const task=Promise.resolve().then(fn).catch(()=>{store.setSetting('worker_error',{at:now(),message:'Фоновое обновление не завершено. Проверьте обмен.'});}).finally(()=>pending.delete(task));pending.add(task);};
  if(runWorkers){background(syncPrices);background(dataSync.sync);background(telegramCrm.poll);timers.push(setInterval(()=>background(telegramCrm.poll),5000));timers.push(setInterval(()=>background(async()=>desk.reconcileDialogs()),60000));timers.push(setInterval(()=>background(dataSync.sync),Math.max(60000,Number(env.STORE_DATA_SYNC_INTERVAL_MS)||60000)));timers.push(setInterval(()=>background(accounts.dispatchMail),15000));timers.push(setInterval(()=>background(syncPrices),Number(env.STORE_SYNC_INTERVAL_MS)||60000));timers.push(setInterval(()=>background(dispatcher.dispatch),15000));for(const t of timers)t.unref();}
  return {server,store,inbox,retail,desk,telegramCrm,accounts,dataSync,origin,syncPrices,dispatch:dispatcher.dispatch,close:async()=>{for(const t of timers)clearInterval(t);await new Promise(r=>server.listening?server.close(r):r());await Promise.allSettled([...pending]);store.close();}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const service=createShopService();
  const port=Number(process.env.STORE_PORT)||4190;
  service.server.listen(port,'127.0.0.1',()=>console.log(`Магазин: ${service.origin} · CRM: ${service.origin}/crm`));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void service.close().then(()=>process.exit(0));});
}
