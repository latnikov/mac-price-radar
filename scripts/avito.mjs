import { readFile } from 'node:fs/promises';
import { AVITO, AVITO_VERSION, normalizeAvitoListing } from './avito-policy.mjs';
import { writeAvitoJson } from './avito-storage.mjs';

export function parseAvitoSnapshot(snapshot, { now = Date.now(), sellerMap = {} } = {}) {
  if (snapshot?.schemaVersion !== 1 || snapshot.scope !== 'avito-nizhny-macbook' || !Array.isArray(snapshot.listings)
    || typeof snapshot.complete !== 'boolean' || !Number.isInteger(snapshot.discovered) || snapshot.discovered < snapshot.listings.length
    || snapshot.listings.length > 3000) throw new Error('Авито: неверный формат снимка');
  const timestamp = Date.parse(snapshot.completedAt), started = Date.parse(snapshot.startedAt);
  if (!Number.isFinite(timestamp) || !Number.isFinite(started) || started > timestamp || timestamp > now + 60000 || now - timestamp > 90 * 60000) throw new Error('Авито: снимок устарел или дата некорректна');
  if (snapshot.complete && (snapshot.expectedTotal !== snapshot.discovered || snapshot.listings.length !== snapshot.discovered)) throw new Error('Авито: полнота снимка не подтверждена');
  const offers = [], review = [], excluded = [], seen = new Set();
  for (const item of snapshot.listings) {
    if (!item || !/^\d{6,}$/.test(String(item.id)) || seen.has(String(item.id))) throw new Error('Авито: нет ID или повтор объявления');
    seen.add(String(item.id));
    const observed = Date.parse(item.observedAt);
    if (!Number.isFinite(observed) || observed < started || observed > timestamp || now - observed > 2 * 3600000) throw new Error('Авито: некорректная дата карточки');
    const result = normalizeAvitoListing(item, { sellerMap });
    if (result.status === 'accepted') offers.push({ ...result.offer, validUntil: new Date(observed + 4 * 3600000).toISOString() });
    else (result.status === 'review' ? review : excluded).push(result);
  }
  return { offers, review, excluded, complete: snapshot.complete, seenIds: [...seen], stats: { discovered: snapshot.discovered,
    detailed: snapshot.listings.length, accepted: offers.length, review: review.length, excluded: excluded.length,
    complete: snapshot.complete, pages: snapshot.pages, snapshotAt: snapshot.completedAt } };
}

export async function fetchAvitoOffers({ env = process.env, previous = [], now = Date.now() } = {}) {
  const dir = env.AVITO_DATA_DIR || 'data/private/avito';
  let snapshot;
  try { snapshot = JSON.parse(await readFile(`${dir}/snapshot.json`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw Object.assign(new Error('Серверный сборщик Авито ещё не получил первый срез'), { code: 'AVITO_NOT_READY' }); throw error; }
  const sellerMap = env.AVITO_SELLER_MAP_FILE ? JSON.parse(await readFile(env.AVITO_SELLER_MAP_FILE, 'utf8')) : {};
  const result = parseAvitoSnapshot(snapshot, { now, sellerMap });
  const prior = new Map(previous.filter(o => o.retailer === AVITO).map(o => [o.listingId, o]));
  const priorActive = [...prior.values()].filter(o => o.stock !== 'Discontinued').length;
  if (result.complete && priorActive >= 10 && snapshot.discovered < priorActive * 0.5) throw new Error('Авито: резкое падение покрытия; прежние объявления сохранены');
  for (const offer of result.offers) {
    const old = prior.get(offer.listingId);
    if (old && Date.parse(old.fetchedAt) < Date.parse(offer.fetchedAt)) { offer.previousPrice = old.price; offer.previousPriceAt = old.fetchedAt; }
    else if (old) { offer.previousPrice = old.previousPrice; offer.previousPriceAt = old.previousPriceAt; }
  }
  await writeAvitoJson(`${dir}/review.json`, { checkedAt: new Date(now).toISOString(), review: result.review, excluded: result.excluded, stats: result.stats });
  // Withdraw only after a verified complete search. A disappeared item on a
  // partial run or a failed fetch never proves that its old price is gone.
  const current = new Set(result.offers.map(o => o.listingId));
  const uncertain = new Set(result.review.map(item => `avito:${item.id}`));
  const explicitlyExcluded = new Set(result.excluded.map(item => `avito:${item.id}`));
  for (const item of result.review) {
    const old = prior.get(`avito:${item.id}`);
    if (!old || Date.parse(old.fetchedAt) >= Date.parse(snapshot.completedAt)) continue;
    result.offers.push({ ...old, observedAt: snapshot.completedAt, fetchedAt: snapshot.completedAt,
      validationStatus: 'rejected', rejected: true, qualityWarnings: [item.reason], evidence: { method: 'avito-review-v1' } });
  }
  for (const old of previous) {
    if (!result.complete && !explicitlyExcluded.has(old.listingId)) continue;
    if (old.retailer !== AVITO || current.has(old.listingId) || uncertain.has(old.listingId) || old.stock === 'Discontinued' || Date.parse(old.fetchedAt) >= Date.parse(snapshot.completedAt)) continue;
    result.offers.push({ ...old, priceObservedAt: old.priceObservedAt || old.fetchedAt, stock: 'Discontinued', validationStatus: 'accepted', rejected: false,
      fetchedAt: snapshot.completedAt, observedAt: snapshot.completedAt, adapterVersion: AVITO_VERSION, qualityWarnings: [],
      evidence: { method: 'avito-complete-withdrawal-v1', snapshotAt: snapshot.completedAt } });
  }
  return { ...result, failures: snapshot.complete ? [] : ['Неполный обход Авито; пропавшие объявления не удалены'] };
}
