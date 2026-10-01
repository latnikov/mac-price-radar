import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { avitoRoute, avitoSession, createAvitoHttpTransport } from './avito-transport.mjs';
import { avitoUrl } from './avito-policy.mjs';
import { parseAvitoSearch, parseAvitoDetail } from './avito-parser.mjs';
import { writeAvitoJson } from './avito-storage.mjs';
import { createAvitoDetailQueue } from './avito-queue.mjs';
import { collectAvitoBatch } from './avito-batch.mjs';
import { AVITO_SEARCH_TARGETS } from './avito-search-targets.mjs';

export const AVITO_SEARCH = 'https://www.avito.ru/nizhniy_novgorod/noutbuki?q=macbook';
export { createAvitoHttpTransport } from './avito-transport.mjs';

export async function collectAvitoSnapshot({ fetchPage, searchUrl = AVITO_SEARCH, maxPages = 100, maxListings = 3000, signal, previousQueue, now = () => new Date().toISOString(), onProgress = async () => {}, onCheckpoint = async () => {}, onQueue = async () => {} } = {}) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage is required');
  const startedAt = now(), items = new Map(), pages = new Set(), signatures = new Set(), listings = [], failures = [];
  let next = avitoUrl(searchUrl), expectedTotal = null, duplicates = 0;
  const snapshot = (complete = false) => ({ schemaVersion: 1, scope: 'avito-nizhny-macbook', searchUrl: avitoUrl(searchUrl), startedAt, completedAt: now(), complete,
    expectedTotal, discovered: items.size, pages: pages.size, duplicates, listings: [...listings], failures: [...new Set(failures)] });
  while (next) {
    signal?.throwIfAborted();
    if (pages.size >= maxPages || pages.has(next)) throw new Error('Авито: обход выдачи не завершён');
    const page = parseAvitoSearch(await fetchPage(next), next);
    pages.add(next);
    const signature = page.items.map(x => x.id).sort().join(',');
    if (signatures.has(signature)) throw new Error('Авито: повторилась страница выдачи');
    signatures.add(signature);
    if (page.total !== null) {
      if (expectedTotal !== null && expectedTotal !== page.total) failures.push('Количество объявлений изменилось во время обхода');
      expectedTotal ??= page.total;
    }
    for (const item of page.items) {
      if (items.has(item.id)) {
        duplicates++;
        if (items.get(item.id).price !== item.price) failures.push('Цена дубля изменилась во время обхода');
      }
      items.set(item.id, item);
    }
    if (items.size > maxListings) throw new Error('Авито: превышен лимит объявлений');
    await onProgress({ stage: 'search', pages: pages.size, discovered: items.size, detailed: 0, expectedTotal });
    next = page.nextUrl;
  }
  if (expectedTotal == null) failures.push('Не удалось подтвердить общее число объявлений');
  else if (items.size !== expectedTotal) failures.push(`Неполная выдача: ${items.size} из ${expectedTotal}`);
  const queue = createAvitoDetailQueue([...items.values()], { previous: previousQueue, searchUrl: avitoUrl(searchUrl), startedAt });
  await onQueue(queue.serialize(now()));
  let inspected = 0;
  try {
    for (const item of queue.ordered) {
      signal?.throwIfAborted();
      // The city in the URL alone is not sufficient evidence. Detail parsing
      // independently verifies the seller, condition and actual location.
      let observedAt;
      try {
        const listing = parseAvitoDetail(await fetchPage(item.url), item.url, now());
        listings.push(listing);
        observedAt = listing.observedAt;
      } catch (error) {
        if (error.code === 'AVITO_BLOCKED' || signal?.aborted) throw error;
        failures.push(`Не разобрана карточка ${item.id}`);
      }
      queue.attempted(item.id, now(), observedAt);
      // Persist every attempted card, including changed markup. A run cut
      // short must not repeatedly spend its entire budget on the same prefix.
      await onQueue(queue.serialize(now()));
      inspected++;
      await onProgress({ stage: 'details', pages: pages.size, discovered: items.size, detailed: listings.length, inspected, remaining: items.size - inspected, expectedTotal });
      if (listings.length && (inspected === 1 || inspected % 25 === 0)) await onCheckpoint({ ...snapshot(), failures: [...new Set([...failures, 'Сбор продолжается; промежуточный срез'])] });
    }
  } catch (error) {
    if (listings.length) await onCheckpoint({ ...snapshot(), failures: [...new Set([...failures,
      error.code === 'AVITO_BLOCKED' ? 'Авито ограничил доступ; неполный срез' : 'Сбор прерван; неполный срез'])] });
    throw error;
  }
  if (listings.length && inspected % 25 !== 0) await onCheckpoint(snapshot());
  return snapshot(failures.length === 0);
}

// Replays captured HTML through exactly the same parser, with no network.
export async function replayAvitoCapture(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const root = dirname(resolve(manifestPath));
  return collectAvitoSnapshot({ searchUrl: manifest.searchUrl, now: () => manifest.capturedAt,
    fetchPage: async url => {
      const relative = manifest.pages?.[url];
      if (typeof relative !== 'string') throw new Error('В захвате нет запрошенной страницы');
      const path = resolve(root, relative);
      if (!path.startsWith(root + '/')) throw new Error('Страница вне каталога захвата');
      return readFile(path, 'utf8');
    } });
}

export async function runAvitoWorker({ env = process.env, transportFactory = createAvitoHttpTransport } = {}) {
  const dir = env.AVITO_DATA_DIR || 'data/private/avito';
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = `${dir}/worker.lock`, statePath = `${dir}/state.json`;
  let handle;
  try { handle = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Авито: другой сбор уже выполняется или осталась блокировка после аварии'); throw error; }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const prior = await readFile(statePath, 'utf8').then(JSON.parse).catch(() => ({}));
    const automaticSearch = !env.AVITO_SEARCH_URL && !env.AVITO_CAPTURE_MANIFEST;
    const targetIndex = automaticSearch && Number.isInteger(prior.nextSearchTarget) && prior.nextSearchTarget >= 0 ? prior.nextSearchTarget % AVITO_SEARCH_TARGETS.length : 0;
    const searchUrl = env.AVITO_SEARCH_URL || `${AVITO_SEARCH_TARGETS[targetIndex].searchUrl}&localPriority=1`;
    const queueSuffix = automaticSearch && targetIndex ? `-${targetIndex}` : '';
    const queuePath = `${dir}/queue${queueSuffix}.json`, discoveryPath = `${dir}/discovery${queueSuffix}.json`;
    // A complete single query does not prove that listings in the other four
    // catalogue searches disappeared. Partial snapshots retain their prices.
    const scopedSnapshot = snapshot => automaticSearch ? { ...snapshot, complete: false,
      failures: [...new Set([...snapshot.failures, 'Обновлён один из целевых запросов MacBook/iPhone; полнота общего обхода не подтверждена'])] } : snapshot;
    if (env.AVITO_TRANSPORT !== 'http' && !env.AVITO_CAPTURE_MANIFEST) {
      await writeAvitoJson(statePath, { state: 'not_configured', message: 'Серверный сборщик установлен; доступ к Авито ещё не подтверждён', updatedAt: new Date().toISOString() });
      return { state: 'not_configured' };
    }
    const route = await avitoRoute(env);
    const accessPath = `${dir}/access.json`;
    const accessStates = await readFile(accessPath, 'utf8').then(JSON.parse).catch(e => { if(e.code === 'ENOENT')return {};throw new Error('Авито: не удалось прочитать состояние доступа'); });
    if (!prior.routeKey && Date.parse(prior.retryAfter) > Date.now()) {
      const direct = await avitoRoute({});
      if(!accessStates[direct.key]) {accessStates[direct.key]={retryAfter:prior.retryAfter};await writeAvitoJson(accessPath,accessStates);}
    }
    const previousAccess = accessStates[route.key] || ((!prior.routeKey && route.kind === 'direct') || prior.routeKey === route.key ? prior : {});
    if (!env.AVITO_CAPTURE_MANIFEST && Date.parse(previousAccess.retryAfter) > Date.now()) {
      if(prior.routeKey && prior.routeKey !== route.key)await writeAvitoJson(statePath,{state:'blocked',transport:route.kind,routeKey:route.key,access:previousAccess.access,message:previousAccess.access?.message||'Авито ограничил доступ по этому маршруту',retryAfter:previousAccess.retryAfter,updatedAt:new Date().toISOString()});
      return { state: 'blocked', retryAfter: previousAccess.retryAfter };
    }
    const startedAt = new Date().toISOString();
    let counts = {}, transport;
    const routeState = { transport: route.kind, routeKey: route.key, ...(automaticSearch ? { nextSearchTarget: (targetIndex + 1) % AVITO_SEARCH_TARGETS.length, searchQuery: AVITO_SEARCH_TARGETS[targetIndex].query } : {}) };
    await writeAvitoJson(statePath, { state: 'running', startedAt, ...routeState });
    try {
      const signal = AbortSignal.timeout(55 * 60000);
      const previousQueue = await readFile(queuePath, 'utf8').then(JSON.parse).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw new Error('Авито: не удалось прочитать сохранённую очередь', { cause: error });
      });
      const previousDiscovery = await readFile(discoveryPath, 'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return undefined;throw new Error('Авито: не удалось прочитать сохранённую выдачу');});
      const limit=(name,fallback,min,max)=>{const value=Number(env[name]);return Number.isFinite(value)&&value>=min&&value<=max?Math.trunc(value):fallback;};
      const maxRequests=limit('AVITO_MAX_REQUESTS',60,3,3000);
      if(!env.AVITO_CAPTURE_MANIFEST)transport=transportFactory({signal,proxyUrl:route.proxyUrl,
        session:await avitoSession(`${dir}/session.json`,route.key),intervalMs:limit('AVITO_INTERVAL_MS',10000,2000,60000),maxRequests});
      const snapshot = scopedSnapshot(env.AVITO_CAPTURE_MANIFEST ? await replayAvitoCapture(env.AVITO_CAPTURE_MANIFEST)
        : await collectAvitoBatch({ searchUrl, signal, previousQueue, previousDiscovery, fetchPage: transport,maxDetails:maxRequests-1,
          onProgress: async progress => { counts = progress; await writeAvitoJson(statePath, { state: 'running', startedAt, updatedAt: new Date().toISOString(), ...routeState, counts }); },
          onQueue: queue => writeAvitoJson(queuePath, queue),
          onDiscovery: discovery=>writeAvitoJson(discoveryPath,discovery),
          onCheckpoint: partial => writeAvitoJson(`${dir}/snapshot.json`, scopedSnapshot(partial)) }));
      if(snapshot.listings.length||snapshot.complete)await writeAvitoJson(`${dir}/snapshot.json`, snapshot);
      const state = { state: snapshot.complete ? 'ready' : 'partial', ...routeState, updatedAt: snapshot.completedAt,
        counts: { pages: snapshot.pages, discovered: snapshot.discovered, detailed: snapshot.listings.length,...transport?.stats() }, failures: snapshot.failures };
      await writeAvitoJson(statePath, state);
      return state;
    } catch (error) {
      const blocked=error.code==='AVITO_BLOCKED';
      const state={state:blocked?'blocked':'error',message:error.message,startedAt,counts,...routeState,updatedAt:new Date().toISOString(),
        ...(blocked?{access:error.access,retryAfter:error.access?.retryAfter||new Date(Date.now()+6*3600000).toISOString()}:{})};
      if(blocked){accessStates[route.key]={retryAfter:state.retryAfter,access:state.access};await writeAvitoJson(accessPath,accessStates);}
      await writeAvitoJson(statePath,state);
      throw error;
    } finally {await transport?.close();}
  } finally { await handle.close(); await unlink(lockPath); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAvitoWorker().then(state => console.log(JSON.stringify({state:state.state,counts:state.counts,retryAfter:state.retryAfter}))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
