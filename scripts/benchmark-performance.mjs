// Offline benchmark: synthetic pages and disposable SQLite, no shop requests.
// Usage: node scripts/benchmark-performance.mjs [baseline-checkout-directory]
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const measure = async fn => { const start = performance.now(); await fn(); return performance.now() - start; };
const observations = Array.from({ length: 2500 }, (_, i) => ({
  retailer: 'Benchmark', url: `https://benchmark.invalid/product/${i}`, price: 100000 + i,
  title: 'MacBook Air 13 M5 16GB 512GB Silver', model: 'MacBook Air 13"', chip: 'M5', ramGb: 16,
  storageGb: 512, currency: 'RUB', condition: 'new', fetchedAt: '2026-09-25T00:00:00Z',
}));
const origin = 'https://nn.technichno.ru';
const path = i => `/catalog/mac/macbook-air/group/product-${i}/`;
const product = i => `<div class="product-details__content" itemscope itemtype="https://schema.org/Product">
  <h1>MacBook Air 13 M5 16GB 512GB Silver</h1>
  <div itemscope itemtype="https://schema.org/Offer" itemprop="offers"><meta itemprop="price" content="${100000 + i}"></div></div>`;

async function benchmark(root) {
  const moduleAt = path => import(pathToFileURL(join(root, path)).href);
  const { openMasterStore } = await moduleAt('scripts/master-store.mjs');
  const { fetchTechnichnoOffers } = await moduleAt('scripts/technichno.mjs');
  const { createOrderService } = await moduleAt('order-site/server.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'parser-benchmark-'));
  const writes = [], crawls = [], httpBatches = [];
  let peak = 0;
  let service;
  try {
    for (let trial = 0; trial < 6; trial++) {
      const store = openMasterStore(join(directory, `master-${trial}.sqlite`));
      try { writes.push(await measure(() => store.ingestRun({ runId: 'benchmark', observations }))); }
      finally { store.close(); }
      let active = 0;
      crawls.push(await measure(async () => {
        const result = await fetchTechnichnoOffers({ fetchPage: async url => {
          peak = Math.max(peak, ++active);
          try {
            const index = Number(url.match(/product-(\d+)/)?.[1] ?? -1);
            await delay(index >= 0 && index % 3 === 0 ? 60 : 5);
            return index < 0 ? Array.from({ length: 12 }, (_, i) => `<a class="product-card__name" href="${path(i)}">Mac</a>`).join('') : product(index);
          } finally { active--; }
        } });
        if (result.offers.length !== 12 || result.stats.pagesFetched !== 13) throw new Error('Incomplete benchmark crawl');
      }));
    }
    service = createOrderService({ env: { ORDER_ACCEPTING: '0' }, dbPath: join(directory, 'orders.sqlite'), runWorker: false });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const paths = ['/app.js', '/api/quote?model=mini&chip=m6-12-12&memory=16&storage=256&ethernet=2.5'];
    for (let trial = 0; trial < 6; trial++) httpBatches.push(await measure(async () => {
      for (let batch = 0; batch < 10; batch++) await Promise.all(Array.from({ length: 20 }, async (_, i) => {
        const response = await fetch(base + paths[i % paths.length]);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await response.arrayBuffer();
      }));
    }));
    const first = await fetch(base + '/app.js'); await first.arrayBuffer();
    const repeat = await fetch(base + '/app.js', { headers: { 'If-None-Match': first.headers.get('etag') || '"none"' } });
    const repeatBytes = (await repeat.arrayBuffer()).byteLength;
    return {
      root, trials: 5, warmup: 1, node: process.version,
      ingest2500Ms: +median(writes.slice(1)).toFixed(1),
      crawl13PagesMs: +median(crawls.slice(1)).toFixed(1), crawlPeak: peak,
      order200RequestsMs: +median(httpBatches.slice(1)).toFixed(1),
      repeatAsset: { status: repeat.status, bytes: repeatBytes },
    };
  } finally { await service?.close(); await rm(directory, { recursive: true, force: true }); }
}

for (const root of [...(process.argv[2] ? [resolve(process.argv[2])] : []), process.cwd()]) {
  console.log(JSON.stringify(await benchmark(root), null, 2));
}
