import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { apifySnapshot } from './avito-apify.mjs';
import { parseAvitoSnapshot } from './avito.mjs';
import { AVITO, avitoUrl, avitoSellerType, avitoUsedCondition } from './avito-policy.mjs';
import { writeAvitoJson } from './avito-storage.mjs';
import { openMasterStore } from './master-store.mjs';
export const APIFY_IMPORT_VERSION = 'private-used-v2';

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

// Replaying an archived export never changes its original observation times.
// Freshness checks in the table/signals still use the real current clock.
export async function importApifyRun({ records, run, root = process.cwd(), dir = resolve(root, 'data/private/avito'), now = Date.now() }) {
  if (run?.status !== 'SUCCEEDED' || (run.actId && run.actId !== '4SsKYeXxLtIJLtzHp')) throw new Error('Apify: нужен успешный запуск нашего парсера');
  const snapshot = apifySnapshot(records, { runId: run.id, startedAt: run.startedAt, finishedAt: run.finishedAt, now });
  const result = parseAvitoSnapshot(snapshot, { now: Date.parse(run.finishedAt) });
  const digest = createHash('sha256').update(JSON.stringify(records)).digest('hex');
  const runFingerprint = createHash('sha256').update(JSON.stringify({ id: run.id, actId: run.actId, status: run.status,
    startedAt: run.startedAt, finishedAt: run.finishedAt })).digest('hex');
  const receipts = join(dir, 'apify-runs');
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const receiptPath = join(receipts, `${run.id}-${APIFY_IMPORT_VERSION}-import.json`);
  const receipt = await readJson(receiptPath, null);
  if (receipt && receipt.digest !== digest) throw new Error('Apify: данные ранее импортированного запуска изменились');
  if (receipt?.runFingerprint && receipt.runFingerprint !== runFingerprint) throw new Error('Apify: метаданные ранее импортированного запуска изменились');
  const store = openMasterStore(resolve(root, 'data/private/master.sqlite'));
  const byId = new Map(snapshot.listings.map(item => [String(item.id), item]));
  let ingested, currentObservations;
  try {
    let payload = receipt?.payload;
    if (!payload) {
      const prior = new Map(store.getOffers({ includeRejected: true, summary: true }).filter(item => item.retailer === AVITO).map(item => [item.listingId, item]));
      const observations = result.offers.map(offer => {
        const old = prior.get(offer.listingId);
        return { ...offer, ...(old && Date.parse(old.fetchedAt) < Date.parse(offer.fetchedAt) ? { previousPrice: old.price, previousPriceAt: old.fetchedAt } : {}), visibility: 'public', dataKind: 'live' };
      });
      for (const rejected of [...result.review, ...result.excluded]) {
        const old = prior.get(`avito:${rejected.id}`);
        const observedAt = byId.get(String(rejected.id))?.observedAt;
        if (!old || !observedAt || Date.parse(old.fetchedAt) > Date.parse(observedAt)) continue;
        const excluded = rejected.status === 'excluded';
        // A new check gets its own append-only identity. Copying the prior
        // observationId would collide with its row in the master store.
        const { observationId, runId, receivedAt, latestAttempt, raw, provenance, ...previousOffer } = old;
        observations.push({ ...previousOffer, observedAt, fetchedAt: observedAt,
          ...(excluded ? { stock: 'Discontinued', rejected: false, validationStatus: 'accepted',
            priceObservedAt: old.priceObservedAt || old.fetchedAt, qualityWarnings: [] }
            : { rejected: true, validationStatus: 'rejected', qualityWarnings: [rejected.reason] }),
          evidence: { method: 'apify-observed-rejection-v1', reason: rejected.reason } });
      }
      payload = { runId: `apify:${run.id}:${APIFY_IMPORT_VERSION}`, startedAt: run.startedAt, observations,
        sources: [{ sourceId: 'avito:nn', sellerId: 'avito:marketplace', retailer: AVITO, status: 'partial', counts: result.stats }],
        actor: 'apify', reason: 'Импорт наблюдений Apify; неполный охват, исходные даты сохранены' };
      // Persist the exact replay payload before committing to SQLite.
      await writeAvitoJson(receiptPath, { digest, runFingerprint, payload });
    }
    ingested = store.ingestRun(payload);
    currentObservations = new Map(store.getOffers({ includeRejected: true, summary: true }).filter(item => item.retailer === AVITO)
      .map(item => [String(item.externalId), Math.max(Date.parse(item.observedAt), Date.parse(item.latestAttempt?.observedAt) || 0)]));
  } finally { store.close(); }
  const latest = await readJson(join(dir, 'snapshot.json'), null);
  if (!latest || Date.parse(latest.completedAt) <= Date.parse(run.finishedAt)) {
    await writeAvitoJson(join(dir, 'snapshot.json'), snapshot);
    await writeAvitoJson(join(dir, 'review.json'), { checkedAt: new Date(now).toISOString(), review: result.review, excluded: result.excluded, stats: result.stats });
  }
  const index = await readJson(join(dir, 'apify-review-index.json'), {});
  const watermarks = await readJson(join(dir, 'apify-review-watermarks.json'), {});
  const review = new Map(result.review.map(item => [String(item.id), item]));
  for (const [id, item] of byId) {
    const observed = Date.parse(item.observedAt);
    if (Math.max(Date.parse(watermarks[id]) || 0, Date.parse(index[id]?.observedAt) || 0, currentObservations.get(id) || 0) > observed) continue;
    watermarks[id] = item.observedAt;
    delete index[id];
    if (!review.has(id) || item.city !== 'Нижний Новгород' || !avitoUsedCondition(item.condition) || avitoSellerType(item) !== 'private') continue;
    // Keep unresolved local cards accessible without treating them as prices
    // suitable for comparisons or sending them as automatic opportunities.
    let url;
    try { url = avitoUrl(item.url); } catch { continue; }
    if (!url || !new URL(url).pathname.match(new RegExp(`(?:_|/)${id}$`))) continue;
    index[id] = { id, title: String(item.title || '').slice(0, 300), url, city: item.city, sellerType: 'private', sellerName: item.seller.name,
      price: Number.isFinite(item.price) ? item.price : null, condition: item.condition,
      reason: review.get(id).reason, observedAt: item.observedAt };
  }
  await writeAvitoJson(join(dir, 'apify-review-index.json'), index);
  await writeAvitoJson(join(dir, 'apify-review-watermarks.json'), watermarks);
  return { counts: { total: snapshot.discovered, accepted: result.offers.length, review: result.review.length,
    excluded: result.excluded.length, detailed: snapshot.diagnostics.detailed },
    snapshotAt: run.finishedAt, runId: run.id, duplicate: ingested.duplicate,
    coverage: { complete: false, message: 'Только б/у MacBook частных продавцов в Нижнем Новгороде. Получена ограниченная порция выдачи; полный охват не подтверждён.' } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [recordsPath, runPath] = process.argv.slice(2);
  if (!recordsPath || !runPath) throw new Error('Укажите JSON выгрузки и JSON метаданных запуска');
  console.log(JSON.stringify(await importApifyRun({ records: JSON.parse(await readFile(recordsPath, 'utf8')),
    run: JSON.parse(await readFile(runPath, 'utf8')), dir: resolve(process.env.AVITO_DATA_DIR || 'data/private/avito') })));
}
