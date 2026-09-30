import { readFile, writeFile, rename, mkdir, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseProduct, price } from './offer-normalization.mjs';
import { findRifaCategoryUrls, findRifaPageUrls, parseRifaCategory, deduplicateRifaOffers } from './rifastore.mjs';
import { fetchTechnichnoOffers } from './technichno.mjs';
import { fetchBsaOffers } from './bsa.mjs';
import { fetchDimaOffers } from './dima.mjs';
import { readTelegramSources } from './telegram-sources.mjs';
import { fetchTelegramChannel } from './telegram-channel.mjs';
import { fetchImobileOffers } from './imobile.mjs';
import { fetchResale52Offers } from './resale52.mjs';
import { fetchAppleStoreOffers } from './apple-store-nn.mjs';
import { fetchRebroOffers } from './rebro.mjs';
import { fetchIphoriyaOffers } from './iphoriya.mjs';
import { fetchMadstoreOffers } from './madstore.mjs';
import { fetchSmartDeviceOffers } from './smart-device.mjs';
import { fetchAfmOffers } from './afmcenter.mjs';
import { afmWithdrawalObservations } from './afm-withdrawals.mjs';
import { fetchAvitoOffers } from './avito.mjs';
import { AVITO, visibleAvitoOffer } from './avito-policy.mjs';
import { buildCatalogRows } from './catalog-rows.mjs';
import { assessCollection, knownProductUrls } from './collection-policy.mjs';
import { extractProductPrice } from './structured-price.mjs';
import { openMasterStore } from './master-store.mjs';
import { inPublicSourceScope } from './domain.mjs';
import { createCollectorFetch } from './collector-fetch.mjs';
import { collectSources, collectionFailures, scheduleSources } from './collection-runner.mjs';
import { crawlQueue } from './crawl-queue.mjs';
const FOREIGN_SOURCE = 'AppleInsider';

const privateDir = 'data/private';
await mkdir(`${privateDir}/backups`, { recursive: true, mode: 0o700 });
const lockPath = `${privateDir}/build.lock`;
async function acquireLock() {
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(await readFile(lockPath, 'utf8')); } catch { throw new Error('Нечитаемая блокировка сборщика; требуется проверка'); }
    try { process.kill(owner.pid, 0); } catch (probe) {
      if (probe.code === 'ESRCH') { await unlink(lockPath); return acquireLock(); }
      throw probe;
    }
    throw new Error(`Сборщик уже работает (PID ${owner.pid})`);
  }
}
await acquireLock();
const atomicJson = async (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
};
let store;
try {
  const catalog = JSON.parse(await readFile('data/catalog.json', 'utf8'));
  store = openMasterStore(`${privateDir}/master.sqlite`);
  if (!store.getRuns().length) {
    const snapshot = await readFile('data/cheapest.json', 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error; });
    await writeFile(`${privateDir}/backups/before-master-migration-${Date.now()}.json`, snapshot, { flag: 'wx', mode: 0o600 });
    const seeds = JSON.parse(await readFile('data/offers.json', 'utf8'));
    const seedIds = new Set(seeds.map(o => `${o.retailer}|${o.url}|${o.fetchedAt}`));
    const observations = JSON.parse(snapshot).flatMap(row => row.offers || []).filter(o => !seedIds.has(`${o.retailer}|${o.url}|${o.fetchedAt}`)).map(o => {
      // Keep historical condition evidence and timestamps; all prices use RUB.
      const parsed = parseProduct(o.rawTitle || o.title, o.url, o.retailer, o.price, o.fetchedAt);
      return { ...o, ...parsed, currency: 'RUB', region: 'unknown', stock: o.stock || 'unknown', condition: parsed?.condition || 'unknown', qualityWarnings: [...new Set([...(o.qualityWarnings || []), ...(parsed?.qualityWarnings || [])])], visibility: 'public', dataKind: 'legacy', evidence: { ...parsed?.evidence, original: o, migration: 'legacy-unverified-v1' } };
    });
    store.ingestRun({ runId: 'legacy-migration-v1', observations, sources: [...new Set(observations.map(o => o.retailer))].map(retailer => ({ retailer, status: 'partial' })), actor: 'migration', reason: 'Сохранение исходного снимка; прежние предположения требуют проверки' });
  }
  const retailers = ['BigGeek', 'Айфория', 'RifaStore', 'Technichno', 'iMobile', 'ReSale', 'Apple Store', 'Rebro', 'Madstore', 'Smart Device', 'AFM', 'BSA', 'Дима', AVITO, FOREIGN_SOURCE];
  const telegram = new Map((await readTelegramSources()).map(source => [source.retailer, source]));
  retailers.push(...[...telegram.keys()].filter(retailer => !retailers.includes(retailer)));
  const selected = process.env.RETAILER && process.env.RETAILER !== 'all' ? [...new Set(process.env.RETAILER.split(',').map(x => x.trim() === 'Iphoriya' ? 'Айфория' : x.trim()))] : retailers;
  if (selected.some(x => !retailers.includes(x))) throw new Error('Неизвестный источник RETAILER');
  const runId = randomUUID(), startedAt = new Date().toISOString();
  const sources = [], observations = [];
  const reference = await readFile('apps-script/reference.gs', 'utf8');
  const slugs = name => {
    const block = reference.match(new RegExp(`var\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`))?.[1] || '';
    return [...block.matchAll(/['"]([A-Z0-9]+)['"]\s*:\s*['"]([^'"]+)['"]/g)].map(match => match[2]);
  };
  const previousOffers = store.getOffers({ includeRejected: true, summary: true });
  const previousStatus = await readFile('data/status.json', 'utf8').then(JSON.parse).catch(() => ({}));
  const networkBySource = new Map();
  const runSignal = AbortSignal.timeout(12 * 60_000);
  const iphoriyaFetchOptions = { attempts: 3, baseDelayMs: 5000, maxDelayMs: 5000 };
  const failedObservation = (retailer, url, title, error) => ({ retailer, url, title: title || url, price: null, priceMinor: null, currency: 'RUB', condition: 'unknown', fetchedAt: new Date().toISOString(), dataKind: 'live', visibility: 'public', validationStatus: 'rejected', qualityWarnings: [error] });
  async function collect(retailer) {
    const { fetchPage, fetchResponse, metrics } = createCollectorFetch({ signal: runSignal });
    networkBySource.set(retailer, metrics);
    const out = [], failures = [];
    if (retailer === FOREIGN_SOURCE) {
      const { refreshForeignPrices } = await import('./foreign-prices.mjs');
      const snapshot = await refreshForeignPrices({ fetchPage });
      return { foreign: true, offers: [], counts: { published: snapshot.rows.length, guides: snapshot.guides } };
    }
    if (retailer.startsWith('Telegram:') && telegram.has(retailer)) {
      const result = await fetchTelegramChannel(telegram.get(retailer));
      return { offers: result.offers, failures: result.failures, counts: result.stats };
    }
    if (retailer === AVITO) {
      const result = await fetchAvitoOffers({ previous: previousOffers });
      return { offers: result.offers, failures: result.failures, counts: result.stats };
    }
    if (retailer === 'BSA') {
      const result = await fetchBsaOffers({});
      return { offers: result.offers, failures: result.failures, counts: result.stats };
    }
    if (retailer === 'Дима') {
      const result = await fetchDimaOffers({});
      return { offers: result.offers, failures: result.failures, counts: result.stats };
    }
    if (retailer === 'Technichno') {
      const result = await fetchTechnichnoOffers({ fetchPage });
      return { offers: result.offers, failures, counts: result.stats };
    }
    if (retailer === 'iMobile') {
      const result = await fetchImobileOffers({ fetchPage });
      return { offers: result.offers, failures, counts: result.stats };
    }
    if (retailer === 'ReSale') {
      const result = await fetchResale52Offers({ fetchPage });
      return { offers: result.offers, failures, counts: result.stats };
    }
    if (retailer === 'Apple Store') {
      const result = await fetchAppleStoreOffers({ fetchPage });
      return { offers: result.offers, failures, counts: result.stats };
    }
    if (retailer === 'Rebro') {
      const result = await fetchRebroOffers({ fetchPage });
      return { offers: result.offers, failures, counts: result.stats };
    }
    if (retailer === 'AFM') {
      const result = await fetchAfmOffers({ fetchPage });
      return { offers: result.offers, failures: result.failures, counts: result.stats, unpriced: result.unpriced };
    }
    if (retailer === 'Smart Device') {
      const result = await fetchSmartDeviceOffers({ fetchPage });
      return { offers: result.offers, failures: result.failures, counts: result.stats };
    }
    if (retailer === 'Madstore') {
      const result = await fetchMadstoreOffers({ fetchPage });
      return { offers: result.offers, failures: result.failures, counts: result.stats };
    }
    if (retailer === 'Айфория') {
      const result = await fetchIphoriyaOffers({ fetchPage: url => fetchResponse(url, iphoriyaFetchOptions) });
      return { offers: result.offers, failures: result.failures, counts: result.stats };
    }
    if (retailer === 'RifaStore') {
      const home = 'https://rifastore.ru/';
      const initial = findRifaCategoryUrls(await fetchPage(home), home), seen = new Set();
      let limitReached = false, cardsFound = 0, pagesFetched = 0;
      const parsedCards = new Set();
      if (!initial.length) failures.push('Не найдены категории RifaStore');
      const enqueue = (url, add) => {
        if (seen.has(url)) return;
        if (seen.size >= 400) {
          if (!limitReached) failures.push('Достигнут лимит страниц');
          limitReached = true;
          return;
        }
        seen.add(url); add(url);
      };
      const queue = [];
      for (const url of initial) enqueue(url, url => queue.push(url));
      await crawlQueue(queue, async (url, add) => {
        try {
          const html = await fetchPage(url);
          pagesFetched++;
          for (const item of parseRifaCategory(html, url)) {
            cardsFound++;
            const key = JSON.stringify([item.url, item.title, price(item.priceText)]);
            if (parsedCards.has(key)) continue;
            parsedCards.add(key);
            const offer = parseProduct(item.title, item.url, retailer, price(item.priceText), undefined, { rawPrice: item.priceText, evidence: { method: 'rifastore-category-card-v1', categoryUrl: url, rawPrice: item.priceText } });
            out.push(offer || failedObservation(retailer, item.url, item.title, 'Не распознана цена/конфигурация'));
          }
          for (const next of findRifaPageUrls(html, url)) enqueue(next, add);
        } catch (error) { failures.push(error.message); }
      });
      const unique = deduplicateRifaOffers(out);
      return { offers: unique, failures, counts: { pagesDiscovered: seen.size, pagesFetched, found: cardsFound, unique: unique.length, duplicateCards: cardsFound - unique.length } };
    }
    const urls = knownProductUrls(previousOffers, retailer);
    for (const slug of slugs(retailer === 'BigGeek' ? 'SLUGS_BIGGEEK' : 'SLUGS_IPHORIYA')) {
      urls.add((retailer === 'BigGeek' ? 'https://biggeek.ru/products/' : 'https://iphoriya.ru/product/') + slug);
    }
    const queue = [...urls];
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const url = queue.shift();
        try {
          const html = await fetchPage(url);
          const extracted = extractProductPrice(html, url);
          if (extracted.error) { out.push(failedObservation(retailer, url, extracted.title, extracted.error)); continue; }
          const parsed = parseProduct(extracted.title, url, retailer, extracted.amount, undefined, extracted.metadata);
          out.push(parsed || failedObservation(retailer, url, extracted.title, 'Не распознана конфигурация'));
        } catch (error) { failures.push(error.message); }
      }
    }));
    return { offers: out, failures, counts: { found: urls.size, parsed: out.filter(o => o.price).length, rejected: out.filter(o => !o.price).length } };
  }
  if (process.env.LIVE === '1') {
    const collected = await collectSources(scheduleSources(selected, previousStatus.sources), collect, {
      concurrency: 3,
      onProgress: progress => atomicJson('data/status.json', {
        state: 'running', stage: 'fetching', source: progress.active.join(', '),
        ...progress, runId, startedAt,
      }),
    });
    for (const { retailer, value: result, error, durationMs } of collected) {
      if (error) { sources.push({ retailer, durationMs, status: error.code === 'AVITO_NOT_READY' ? 'not_ready' : 'failed', error: error.message, counts: { published: 0 } }); continue; }
      if (result.foreign) {
        sources.push({ retailer, durationMs, status: 'success', counts: result.counts, error: null });
        continue;
      }
      if (retailer === AVITO) {
        sources.push({ retailer, sourceId: 'avito:nn', sellerId: 'avito:marketplace', sourceType: 'marketplace', durationMs,
          status: result.counts.complete ? 'success' : 'partial', counts: { ...result.counts, published: result.offers.filter(visibleAvitoOffer).length }, error: result.failures.join('; ') || null });
        observations.push(...result.offers.map(offer => ({ ...offer, visibility: 'public', dataKind: 'live' })));
        continue;
      }
      const unpricedAfmIds = retailer === 'AFM' ? new Set((result.unpriced || []).map(item => `afm:${item.productId}:${item.editionId}`)) : new Set();
      const previousForAssessment = previousOffers.filter(o => o.retailer === retailer && o.visibility !== 'private' && !unpricedAfmIds.has(o.externalId));
      const assessment = assessCollection(previousForAssessment, result.offers, result.failures);
      if (retailer === 'AFM' && result.counts?.products > 0 && result.offers.length === 0 && result.unpriced?.length > 0 && !result.failures.length) {
        assessment.status = 'success';
        assessment.error = null;
      }
      const channel = telegram.get(retailer);
      sources.push({ retailer, ...channel, ...(retailer.startsWith('Telegram:') ? { sourceId: `telegram:${channel.sourceChatId}`, sellerId: `telegram:${channel.sourceChatId}` } : {}), durationMs, status: assessment.status, counts: { ...result.counts, ...assessment.counts }, error: assessment.error });
      observations.push(...assessment.observations.map(offer => ({ ...offer, visibility: 'public', dataKind: 'live' })));
      if (retailer === 'AFM' && result.counts?.products > 0 && !result.failures.length) {
        observations.push(...afmWithdrawalObservations(previousOffers, result.unpriced || []));
      }
    }
    for (const source of sources) source.network = networkBySource.get(source.retailer);
    store.ingestRun({ runId, startedAt, observations, sources, actor: 'parser', reason: 'Обновление публичных наблюдений' });
  }
  const result = buildCatalogRows(catalog, store.getOffers({ includeRejected: true, summary: true }).filter(offer => offer.visibility !== 'private' && inPublicSourceScope(offer) && visibleAvitoOffer(offer)));
  await atomicJson('data/cheapest.json', result);
  const failures = collectionFailures(sources);
  await atomicJson('data/status.json', { state: failures.length ? 'degraded' : 'ready', stage: 'complete', completed: sources.length, total: sources.length, sources, runId, startedAt, updatedAt: new Date().toISOString(), error: failures.length ? failures.map(x => `${x.retailer}: ${x.error || x.status}`).join('; ') : null });
  console.log(`Мастер-база: ${result.length} строк, ${result.reduce((n, r) => n + r.offers.length, 0)} наблюдений; ${failures.length} источников требуют проверки`);
} finally {
  store?.close();
  await unlink(lockPath);
}
