import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { calculateRetailAnalytics, catalogConfigurationKey, colorPriceTrustKey, findColorPriceLowTrust, NIZHNY_RETAILERS } from '../web/retail-analytics.js';

export const PRICE_POLICY = 'dev-recommended-v1';
const normalizedModel = o => String(o.model || o.title || '').replace(/\s+/g, ' ').trim();
export const configurationKey = o => catalogConfigurationKey({ ...o, model: normalizedModel(o), screenIn: o.screenIn || Number(normalizedModel(o).match(/\b(13|14|15|16|24|27)\b/)?.[1]) || null });
export const recommendationKey = o => createHash('sha256').update(`${configurationKey(o)}|${o.color ?? 'unknown'}`).digest('hex').slice(0, 32);
const known = v => v != null && v !== '' && v !== 'unknown';

// This is the unfiltered dev table's algorithm, including its color Trust rules.
// We never substitute the lowest offer or subtract 500 a second time.
export function buildRecommendations(input, { now = Date.now(), maxAgeMs = 4 * 3600000, ownSellerIds = [] } = {}) {
  if (!Array.isArray(input)) throw new Error('invalid_price_snapshot');
  const own = new Set(ownSellerIds.map(String));
  const offers = input.filter(o => o && !o.isDemo && o.dataKind !== 'demo' && o.visibility !== 'private' && Number.isFinite(o.price) && o.price > 0)
    .filter(o => {
      let host = ''; try { host = new URL(o.url).hostname; } catch { /* No external link is required for a stored observation. */ }
      return !/(^|\.)macbookbro\.ru$/i.test(host) && !/макбучная|macbookbro|мкбчн/i.test(`${o.retailer || ''} ${o.sellerName || ''}`) && !own.has(String(o.marketplaceSellerId));
    });
  const colors = findColorPriceLowTrust(offers.filter(o => o.retailer !== 'Авито НН'), configurationKey);
  const groups = new Map(), configurations = new Map();
  for (const o of offers) { const key=configurationKey(o); if(!configurations.has(key))configurations.set(key,[]); configurations.get(key).push(o); }
  for (const o of offers) { const key = recommendationKey(o); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(o); }
  return [...groups].map(([key, rows]) => {
    const sample = rows[0], additionalLowTrust = new Map();
    for (const o of rows) { const reason = colors.get(colorPriceTrustKey(o, configurationKey)); if (reason) additionalLowTrust.set(o.retailer, reason); }
    const analytics = calculateRetailAnalytics(rows, { additionalLowTrust });
    const participants = configurations.get(configurationKey(sample)).filter(o => NIZHNY_RETAILERS.includes(o.retailer) && !['OutOfStock', 'Discontinued', 'SoldOut'].includes(o.stock));
    // Old observations must not become fresh just because the import ran again.
    const times = participants.map(o => Date.parse(o.fetchedAt));
    const observedAt = times.length && times.every(t => Number.isFinite(t) && t <= now + 60000) ? Math.min(...times) : 0;
    const expiresAt = observedAt ? Math.min(observedAt + maxAgeMs, ...participants.map(o => o.validUntil ? Date.parse(o.validUntil) || 0 : Infinity)) : 0;
    const value = analytics.recommendedPrice;
    const issues = [];
    if (!Number.isSafeInteger(value) || value <= 0) issues.push('Нет рекомендованной цены');
    if (expiresAt <= now) issues.push('Нужно обновить наблюдения dev');
    for (const field of ['cpuCores', 'gpuCores', 'keyboard', 'region', 'condition']) {
      if (new Set(rows.map(o => o[field]).filter(known)).size > 1) issues.push(`Различаются ${field}`);
    }
    const configuration = Object.fromEntries(['model', 'chip', 'screenIn', 'ramGb', 'storageGb', 'color', 'cpuCores', 'gpuCores', 'keyboard', 'region', 'condition'].map(field => [field, sample[field] ?? null]));
    configuration.model = normalizedModel(sample);
    return { key, configuration, label: [configuration.model, sample.chip, `${sample.ramGb || '?'} / ${sample.storageGb || '?'} ГБ`, sample.color].filter(Boolean).join(' · '),
      recommendedRub: value, priceRub: issues.length ? null : value, observedAt, expiresAt, issues, policy: PRICE_POLICY,
      benchmark: analytics.benchmark ? { retailer: analytics.benchmark.retailer, url: analytics.benchmark.url, priceRub: analytics.benchmark.price, observedAt: analytics.benchmark.fetchedAt } : null };
  }).sort((a, b) => a.label.localeCompare(b.label, 'ru', { numeric: true }));
}

export async function readPriceSource(env, fetchImpl = fetch) {
  let data;
  if (env.STORE_DEV_FILE) data = JSON.parse(await readFile(env.STORE_DEV_FILE, 'utf8'));
  else {
    if (!env.STORE_DEV_URL) throw new Error('price_source_not_configured');
    const response = await fetchImpl(env.STORE_DEV_URL, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: env.STORE_DEV_AUTH ? { Authorization: env.STORE_DEV_AUTH } : {} });
    if (!response.ok) throw new Error('price_source_unavailable');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 20 * 1024 * 1024) throw new Error('price_snapshot_too_large'); chunks.push(chunk); }
    data = JSON.parse(Buffer.concat(chunks).toString());
  }
  const offers = Array.isArray(data) ? data : data.offers;
  if (!Array.isArray(offers) || offers.length > 50000) throw new Error('invalid_price_snapshot');
  return offers;
}
