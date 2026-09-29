import { readFileSync } from 'node:fs';

export const xml = value => String(value ?? '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const node = (tag, value) => `<${tag}>${xml(value)}</${tag}>`;
const readyProducts = (store, channel) => store.products().filter(p=>p.published?.channels.includes(channel)).map(p=>({ ...store.publicProduct(p), internal:p.published })).filter(p=>p.priceRub>0);

export function yandexFeed(store, origin) {
  const products = readyProducts(store,'yandex');
  const categories = [...new Set(products.map(p=>p.category))].sort();
  const offers = products.map(p=>`<offer id="${xml(p.id)}">${node('name',p.title)}${node('vendor',p.vendor)}${node('price',p.priceRub)}${node('currencyId','RUB')}${node('categoryId',categories.indexOf(p.category)+1)}${node('description',p.description)}${node('url',`${origin}/p/${p.id}`)}${p.photos[0]?node('picture',`${origin}/media/${p.photos[0]}`):''}</offer>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><yml_catalog><shop>${node('name','Макбучная')}${node('company','Макбучная')}${node('url',origin)}<categories>${categories.map((c,i)=>`<category id="${i+1}">${xml(c)}</category>`).join('')}</categories><offers>${offers}</offers></shop></yml_catalog>`;
}

// Autoload fields are category-specific. Production serving requires an explicit
// server setting after validating this export in the merchant's Avito account.
export function avitoFeed(store, { origin, address, extraFields = {} }) {
  for (const key of Object.keys(extraFields)) if (!/^[A-Z][A-Za-z0-9]*$/.test(key) || ['Id','Title','Price','Images','Description'].includes(key)) throw new Error('invalid_avito_fields');
  const ads=readyProducts(store,'avito').map(p=>`<Ad>${node('Id',p.id)}${node('Category',p.internal.avitoCategory)}${node('Title',p.title)}${node('Description',[p.description,p.specification,p.warranty].filter(Boolean).join('\n\n'))}${node('Price',p.priceRub)}${node('Address',address)}${Object.entries(extraFields).map(([k,v])=>node(k,v)).join('')}<Images>${p.photos.map(f=>`<Image url="${xml(`${origin}/media/${f}`)}"/>`).join('')}</Images></Ad>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Ads formatVersion="3" target="Avito.ru">${ads}</Ads>`;
}

class DeliveryError extends Error { constructor(message,state='retry'){super(message);this.state=state;} }
function configError(message){throw new DeliveryError(message,'blocked');}
async function api(fetchImpl,url,{method='GET',headers={},body,create=false}={}) {
  let response;
  try { response=await fetchImpl(url,{method,redirect:'error',headers,body:body==null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)}); }
  catch { throw new DeliveryError(create?'Результат создания неизвестен: нужна проверка':'Нет ответа площадки',create?'unknown':'retry'); }
  let result; try { result=await response.json(); } catch { throw new DeliveryError('Не удалось прочитать ответ',create?'unknown':'retry'); }
  if(!response.ok || result.ok===false) {
    if(!create && response.status===400 && /^Bad Request: message is not modified/.test(result.description||'')) return {ok:true,result:true};
    const status=response.status;
    throw new DeliveryError(status===429?'Площадка ограничила частоту запросов':status===401||status===403?'Проверьте права подключения':'Площадка отклонила запрос',create&&status>=500?'unknown':status>=400&&status<500&&status!==429?'blocked':'retry');
  }
  return result;
}

export function createDispatcher(store,{env=process.env,origin,fetchImpl=fetch}={}) {
  let working=false;
  const msRoot='https://api.moysklad.ru/api/remap/1.2';
  const msHeaders=()=>({'Authorization':`Bearer ${env.STORE_MOYSKLAD_TOKEN}`,'Content-Type':'application/json','Accept-Encoding':'gzip'});
  const meta=(type,id)=>({meta:{href:`${msRoot}/entity/${type}/${id}`,type,mediaType:'application/json'}});
  async function telegram(job,p,publication) {
    if(!env.STORE_TELEGRAM_TOKEN||!env.STORE_TELEGRAM_CHANNEL) configError('Укажите бота и Telegram-канал');
    const url=`https://api.telegram.org/bot${env.STORE_TELEGRAM_TOKEN}/`;
    const active=p?.published?.channels.includes('telegram')&&store.publicProduct(p)?.priceRub>0;
    const remote=publication?.remote_id?JSON.parse(publication.remote_id):null;
    if(!active&&!remote) return {state:'closed'};
    const publicP=active?store.publicProduct(p):null;
    const text=active?`${publicP.title}\n${publicP.specification}\n\n${publicP.priceRub.toLocaleString('ru-RU')} ₽\n\n${publicP.description}\n\n${origin}/p/${p.id}`:'Предложение закрыто';
    const photo=active&&publicP.photos[0]?`${origin}/media/${publicP.photos[0]}`:null;
    const caption=active?`${publicP.title}\n${publicP.specification.slice(0,250)}\n\n${publicP.priceRub.toLocaleString('ru-RU')} ₽\n\n${publicP.description.slice(0,250)}\n\n${origin}/p/${p.id}`:'Предложение закрыто';
    let method,kind=remote?.kind||'text';
    const body={chat_id:remote?.chatId || env.STORE_TELEGRAM_CHANNEL};
    if(remote) body.message_id=remote.messageId;
    if(photo){
      kind='photo';
      if(remote){method='editMessageMedia';body.media={type:'photo',media:photo,caption};}
      else {method='sendPhoto';body.photo=photo;body.caption=caption;}
    }else if(remote?.kind==='photo'){method='editMessageCaption';body.caption=caption;}
    else {method=remote?'editMessageText':'sendMessage';body.text=text.slice(0,4000);body.link_preview_options={is_disabled:true};}
    const result=await api(fetchImpl,`${url}${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body,create:!remote});
    return {state:active?'published':'closed',remoteId:JSON.stringify({chatId:remote?.chatId||result.result.chat.id,messageId:remote?.messageId||result.result.message_id,kind})};
  }
  async function moysklad(job,p,publication) {
    if(!env.STORE_MOYSKLAD_TOKEN) configError('Укажите доступ к МойСклад');
    if(job.entity==='product') {
      if(!p?.published?.channels.includes('moysklad')||!store.publicProduct(p).priceRub) return {state:'closed'};
      const d=p.published;
      if(!d.moyskladId||!env.STORE_MOYSKLAD_PRICE_TYPE) configError('Укажите товар и тип цены МойСклад');
      const target=`${msRoot}/entity/${d.moyskladType}/${d.moyskladId}`;
      const existing=await api(fetchImpl,target,{headers:msHeaders()});
      const salePrices=(existing.salePrices||[]).filter(x=>x.priceType?.id!==env.STORE_MOYSKLAD_PRICE_TYPE);
      salePrices.push({value:store.publicProduct(p).priceRub*100,priceType:{id:env.STORE_MOYSKLAD_PRICE_TYPE}});
      await api(fetchImpl,target,{method:'PUT',headers:msHeaders(),body:{salePrices}});
      return {state:'published',remoteId:d.moyskladId};
    }
    if(!env.STORE_MOYSKLAD_ORGANIZATION||!env.STORE_MOYSKLAD_COUNTERPARTY) configError('Укажите организацию и контрагента для заказов МойСклад');
    const order=store.db.prepare('SELECT * FROM orders WHERE id=?').get(job.entity_id);
    if(['cancelled','returned'].includes(order.state))return {state:'closed'};
    const d=JSON.parse(order.data);
    if(d.totalRub==null) configError('Сначала согласуйте цену заказа');
    const positions=d.lines.map(line=>{
      const product=store.product(line.id), current=product?.published||product?.draft;
      const data=line.moyskladId?line:(current?.recommendationKey===line.recommendationKey?current:null);
      if(!data?.moyskladId) configError('Сопоставьте все товары заказа с МойСклад');
      return {quantity:line.qty,price:line.priceRub*100,assortment:meta(data.moyskladType,data.moyskladId)};
    });
    const found=await api(fetchImpl,`${msRoot}/entity/customerorder?filter=${encodeURIComponent(`externalCode=${order.id}`)}`,{headers:msHeaders()});
    if(found.rows?.length>1) configError('В МойСклад несколько заказов с этим кодом');
    if(found.rows?.length===1) return {state:'published',remoteId:found.rows[0].id};
    const result=await api(fetchImpl,`${msRoot}/entity/customerorder`,{method:'POST',headers:msHeaders(),create:true,body:{name:order.id,externalCode:order.id,organization:meta('organization',env.STORE_MOYSKLAD_ORGANIZATION),agent:meta('counterparty',env.STORE_MOYSKLAD_COUNTERPARTY),positions,description:`Заказ сайта ${order.id}\n${d.name}\n${d.phone}\n${d.comment}`}});
    return {state:'published',remoteId:result.id};
  }
  async function dispatch() {
    if(working)return; working=true;
    try {
      store.maintenance();
      const jobs=store.db.prepare("SELECT * FROM jobs WHERE state IN ('queued','retry') AND next_at<=? ORDER BY id LIMIT 20").all(store.now());
      for(const job of jobs) {
        const p=job.entity==='product'?store.product(job.entity_id):null;
        if(p&&p.revision!==job.revision) {store.db.prepare("UPDATE jobs SET state='superseded' WHERE id=?").run(job.id);continue;}
        // An unresolved create blocks later revisions too, until a remote ID is reconciled.
        const unresolved=store.db.prepare("SELECT id FROM jobs WHERE entity=? AND entity_id=? AND channel=? AND state='unknown' AND id<>?").get(job.entity,job.entity_id,job.channel,job.id);
        if(unresolved){store.db.prepare("UPDATE jobs SET state='blocked',error='Сначала проверьте предыдущую отправку' WHERE id=?").run(job.id);continue;}
        const publication=store.db.prepare('SELECT * FROM publications WHERE entity=? AND entity_id=? AND channel=?').get(job.entity,job.entity_id,job.channel);
        store.db.prepare("UPDATE jobs SET state='working',attempts=attempts+1 WHERE id=?").run(job.id);
        try {
          let result;
          if(job.channel==='telegram') result=await telegram(job,p,publication);
          else if(job.channel==='moysklad') result=await moysklad(job,p,publication);
          else {
            if(!env.STORE_FEED_TOKEN || env.STORE_FEED_TOKEN.length<32) configError('Настройте защищённую ссылку выгрузки');
            if(job.channel==='avito'&&env.STORE_AVITO_FEED_ENABLED!=='1') configError('Проверьте формат Авито и включите автозагрузку');
            result={state:'ready'};
          }
          store.db.prepare('UPDATE jobs SET state=?,error=NULL WHERE id=?').run(result.state,job.id);
          store.db.prepare('INSERT INTO publications VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(entity,entity_id,channel) DO UPDATE SET remote_id=COALESCE(excluded.remote_id,publications.remote_id),revision=excluded.revision,state=excluded.state,detail=excluded.detail,updated_at=excluded.updated_at')
            .run(job.entity,job.entity_id,job.channel,result.remoteId||publication?.remote_id||null,job.revision,result.state,null,store.now());
        }catch(e){
          const state=e.state||'unknown';
          store.db.prepare('UPDATE jobs SET state=?,error=?,next_at=? WHERE id=?').run(state,e instanceof DeliveryError?e.message:'Нужна проверка результата интеграции',store.now()+Math.min(3600000,15000*2**Math.min(job.attempts,8)),job.id);
        }
      }
    }finally{working=false;}
  }
  return {dispatch};
}

export function avitoOptions(env,origin) {
  return {origin,address:env.STORE_ADDRESS||'Нижний Новгород, Грузинская, 41а',extraFields:env.STORE_AVITO_FIELDS_FILE?JSON.parse(readFileSync(env.STORE_AVITO_FIELDS_FILE,'utf8')):{}};
}
