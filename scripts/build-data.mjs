import { readFile, writeFile, rename, mkdir, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseProduct, price } from './offer-normalization.mjs';
import { findRifaCategoryUrls, findRifaPageUrls, parseRifaCategory } from './rifastore.mjs';
import { fetchTechnichnoOffers } from './technichno.mjs';
import { fetchBsaOffers } from './bsa.mjs';
import { fetchDimaOffers } from './dima.mjs';
import { buildCatalogRows } from './catalog-rows.mjs';
import { assessCollection, knownProductUrls } from './collection-policy.mjs';
import { extractProductPrice } from './structured-price.mjs';
import { openMasterStore } from './master-store.mjs';
import { inPublicSourceScope } from './domain.mjs';

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
  const retailers = ['BigGeek', 'Айфория', 'RifaStore', 'Technichno', 'BSA', 'Дима'];
  const selected = process.env.RETAILER && process.env.RETAILER !== 'all' ? [...new Set(process.env.RETAILER.split(',').map(x => x.trim() === 'Iphoriya' ? 'Айфория' : x.trim()))] : retailers;
  if (selected.some(x => !retailers.includes(x))) throw new Error('Неизвестный источник RETAILER');
  const runId = randomUUID(), startedAt = new Date().toISOString();
  const sources = [], observations = [];
  const reference = await readFile('apps-script/reference.gs', 'utf8');
  const slugs = name => {
    const block = reference.match(new RegExp(`var\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`))?.[1] || '';
    return [...block.matchAll(/['"]([A-Z0-9]+)['"]\s*:\s*['"]([^'"]+)['"]/g)].map(match => match[2]);
  };
  const runSignal = AbortSignal.timeout(12 * 60_000);
  const fetchPage = async url => {
    const response = await fetch(url, { signal: AbortSignal.any([runSignal, AbortSignal.timeout(20000)]), headers: { 'user-agent': 'Mozilla/5.0 MacPriceRadar/2.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response.text();
  };
  const failedObservation = (retailer, url, title, error) => ({ retailer, url, title: title || url, price: null, priceMinor: null, currency: 'RUB', condition: 'unknown', fetchedAt: new Date().toISOString(), dataKind: 'live', visibility: 'public', validationStatus: 'rejected', qualityWarnings: [error] });
  async function collect(retailer) {
    const out = [], failures = [];
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
    if (retailer === 'RifaStore') {
      const home = 'https://rifastore.ru/';
      const queue = findRifaCategoryUrls(await fetchPage(home), home), seen = new Set();
      while (queue.length) {
        const url = queue.shift(); if (seen.has(url)) continue;
        if (seen.size >= 400) { failures.push('Достигнут лимит страниц'); break; }
        seen.add(url);
        try {
          const html = await fetchPage(url);
          for (const item of parseRifaCategory(html, url)) {
            const offer = parseProduct(item.title, item.url, retailer, price(item.priceText), undefined, { rawPrice: item.priceText, evidence: { method: 'rifastore-category-card-v1', categoryUrl: url, rawPrice: item.priceText } });
            out.push(offer || failedObservation(retailer, item.url, item.title, 'Не распознана цена/конфигурация'));
          }
          for (const next of findRifaPageUrls(html, url)) if (!seen.has(next)) queue.push(next);
        } catch (error) { failures.push(error.message); }
      }
      return { offers: out, failures, counts: { pagesFetched: seen.size, found: out.length } };
    }
    const urls = knownProductUrls(store.getOffers({ includeRejected: true }), retailer);
    for (const slug of slugs(retailer === 'BigGeek' ? 'SLUGS_BIGGEEK' : 'SLUGS_IPHORIYA')) {
      if (retailer === 'Айфория' && !slug.startsWith('apple-macbook')) continue;
      urls.add((retailer === 'BigGeek' ? 'https://biggeek.ru/products/' : 'https://iphoriya.ru/product/') + slug);
    }
    if (retailer === 'Айфория') {
      try {
        const html = await fetchPage('https://iphoriya.ru/product-category/mac/macbook-neo/');
        for (const match of html.matchAll(/href=["'](https:\/\/iphoriya\.ru\/product\/[^"']*macbook-neo[^"']*)["']/gi)) urls.add(match[1]);
      } catch (error) { failures.push(error.message); }
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
    for (const retailer of selected) {
      await atomicJson('data/status.json', { state: 'running', stage: 'fetching', source: retailer, completed: sources.length, total: selected.length, runId, startedAt, sources });
      try {
        const result = await collect(retailer);
        const assessment = assessCollection(store.getOffers({ includeRejected: true }).filter(o => o.retailer === retailer && o.visibility !== 'private'), result.offers, result.failures);
        sources.push({ retailer, status: assessment.status, counts: { ...result.counts, ...assessment.counts }, error: assessment.error });
        observations.push(...assessment.observations.map(offer => ({ ...offer, visibility: 'public', dataKind: 'live' })));
      } catch (error) { sources.push({ retailer, status: 'failed', error: error.message, counts: { published: 0 } }); }
    }
    store.ingestRun({ runId, startedAt, observations, sources, actor: 'parser', reason: 'Обновление публичных наблюдений' });
  }
  const result = buildCatalogRows(catalog, store.getOffers({ includeRejected: true }).filter(offer => offer.visibility !== 'private' && inPublicSourceScope(offer)).map(({ raw, evidence, ...summary }) => summary));
  await atomicJson('data/cheapest.json', result);
  const failures = sources.filter(source => ['failed', 'degraded', 'partial'].includes(source.status));
  await atomicJson('data/status.json', { state: failures.length ? 'degraded' : 'ready', stage: 'complete', completed: sources.length, total: sources.length, sources, runId, startedAt, updatedAt: new Date().toISOString(), error: failures.length ? failures.map(x => `${x.retailer}: ${x.error || x.status}`).join('; ') : null });
  console.log(`Мастер-база: ${result.length} строк, ${result.reduce((n, r) => n + r.offers.length, 0)} наблюдений; ${failures.length} источников требуют проверки`);
} finally {
  store?.close();
  await unlink(lockPath);
}
