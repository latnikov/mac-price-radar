import { mkdir, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openMasterStore } from './master-store.mjs';

// Explicit allowlist: observations, quotes, sources and internal economics can
// never reach the public artifact, even when private fields are added later.
export function publicContract(decisions, now = Date.now()) {
  return { schemaVersion: 1, generatedAt: new Date(now).toISOString(), prices: decisions.filter(item => item.status === 'approved' && item.publishable === true && Date.parse(item.validUntil) > now && item.supplyConfirmed === true && Number.isSafeInteger(item.salePriceMinor) && item.salePriceMinor > 0 && item.variantId && item.currency === 'RUB').map(item => ({ id: item.id, variantId: item.variantId, title: String(item.publicTitle || item.variantId), priceMinor: item.salePriceMinor, currency: item.currency, city: String(item.destination || ''), validUntil: item.validUntil, availability: 'confirmed' })) };
}
export async function exportPublic({ dbPath = 'data/private/master.sqlite', output = 'data/public-prices.json' } = {}) {
  const store = openMasterStore(dbPath);
  try {
    const payload = publicContract(store.listPriceDecisions?.() || []);
    const temporary = `${output}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(payload, null, 2));
    await rename(temporary, output);
    return payload;
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mkdir('data', { recursive: true });
  const result = await exportPublic();
  console.log(`Публичный контракт: ${result.prices.length} утверждённых цен`);
}
