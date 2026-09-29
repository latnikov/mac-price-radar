import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { CookieJar } from 'tough-cookie';
import { avitoUrl } from './avito-policy.mjs';
import { avitoAccessFailure, accessError } from './avito-access.mjs';
import { writeAvitoJson } from './avito-storage.mjs';

export async function avitoRoute(env = process.env) {
  let value;
  try { value = (env.AVITO_PROXY_URL_FILE ? await readFile(env.AVITO_PROXY_URL_FILE, 'utf8') : env.AVITO_PROXY_URL || '').trim(); }
  catch { throw new Error('Авито: не удалось прочитать файл прокси'); }
  if (value) {
    let url; try { url = new URL(value); } catch { throw new Error('Авито: неверный адрес прокси'); }
    if (!['http:','https:','socks5:'].includes(url.protocol) || !url.hostname || url.pathname !== '' && url.pathname !== '/' || url.search || url.hash)
      throw new Error('Авито: нужен HTTP, HTTPS или SOCKS5-прокси без пути и параметров');
    value = url.href;
  }
  return { proxyUrl: value || null, kind: value ? 'proxy' : 'direct',
    key: createHash('sha256').update(`${env.AVITO_ROUTE_ID || 'default'}|${value || 'direct'}|MacPriceRadar/3.1`).digest('hex') };
}

export async function avitoSession(path, routeKey) {
  let saved;
  try { const text=await readFile(path,'utf8'); if(Buffer.byteLength(text)>128*1024)throw new Error('oversized'); saved=JSON.parse(text); }
  catch(e) { if(e.code!=='ENOENT')throw new Error('Авито: файл сессии повреждён'); }
  let jar = new CookieJar();
  if(saved?.routeKey===routeKey){try{jar=CookieJar.deserializeSync(saved.jar);}catch{throw new Error('Авито: файл сессии повреждён');}}
  return { jar, async save() {
    const data=jar.serializeSync();
    data.cookies=data.cookies.filter(c=>/^(?:www\.)?avito\.ru$/.test(c.domain)).slice(-100);
    await writeAvitoJson(path,{schemaVersion:1,routeKey,jar:data});
  } };
}

// One stable route and one anonymous session for a run. No direct fallback when
// a configured proxy fails; no automatic IP rotation or CAPTCHA solving.
export function createAvitoHttpTransport({ fetchImpl = undiciFetch, proxyUrl, session, intervalMs = 10000, maxRequests = Infinity, sleep = delay, signal, now = Date.now, dispatcherFactory } = {}) {
  let lastRequest = null, requests = 0, stopped = null, tail = Promise.resolve();
  const dispatcher = dispatcherFactory ? dispatcherFactory(proxyUrl) : fetchImpl === undiciFetch ? (proxyUrl ? new ProxyAgent({uri:proxyUrl,connections:1}) : new Agent({connections:1})) : undefined;
  const run = async url => {
    const target = avitoUrl(url); signal?.throwIfAborted();
    if(stopped)throw stopped;
    if(requests>=maxRequests)throw Object.assign(new Error('Авито: порция запросов завершена'),{code:'AVITO_BUDGET'});
    const pause=lastRequest===null?0:lastRequest+Math.max(2000,intervalMs)-now();
    if(pause>0)await sleep(pause,undefined,{signal});
    signal?.throwIfAborted();lastRequest=now();requests++;
    const headers={'user-agent':'MacPriceRadar/3.1 (+https://dev.macbookbro.ru)',accept:'text/html','accept-language':'ru-RU'};
    const cookie=session?.jar.getCookieStringSync(target);if(cookie)headers.cookie=cookie;
    let response;
    try { response=await fetchImpl(target,{redirect:'manual',dispatcher,signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(25000)]),headers}); }
    catch { signal?.throwIfAborted(); stopped=Object.assign(new Error(proxyUrl?'Авито: ошибка соединения через настроенный прокси':'Авито: ошибка сетевого соединения'),{code:'AVITO_NETWORK'}); throw stopped; }
    const chunks=[];let bytes=0;const limit=response.ok?12*1024*1024:256*1024;
    try {
      for await(const chunk of response.body||[]) {bytes+=chunk.length;if(bytes>limit){if(response.ok)throw new Error('Авито: документ слишком большой');break;}chunks.push(chunk);}
    }catch {signal?.throwIfAborted();stopped=Object.assign(new Error('Авито: передача страницы прервана'),{code:'AVITO_NETWORK'});throw stopped;}
    const html=Buffer.concat(chunks).toString('utf8');
    const access=avitoAccessFailure({status:response.status,html,retryAfter:response.headers.get('retry-after'),now:now()});
    if(access){stopped=accessError(access);throw stopped;}
    if(!response.ok)throw Object.assign(new Error(`Авито: HTTP ${response.status}`),{code:'AVITO_HTTP',status:response.status});
    if(!/text\/html/i.test(response.headers.get('content-type')||''))throw new Error('Авито: ожидалась HTML-страница');
    if(session){
      for(const cookie of response.headers.getSetCookie?.()||[]) {if(cookie.length<=4096)session.jar.setCookieSync(cookie,target,{ignoreError:true});}
      await session.save();
    }
    return html;
  };
  const fetchPage=url=>{const pending=tail.then(()=>run(url));tail=pending.catch(()=>{});return pending;};
  fetchPage.close=async()=>{await tail;await dispatcher?.close?.();};
  fetchPage.stats=()=>({requests});
  return fetchPage;
}
