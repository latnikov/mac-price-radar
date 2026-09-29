import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AVITO, avitoUrl, normalizeAvitoListing, visibleAvitoOffer } from '../scripts/avito-policy.mjs';
import { parseAvitoSearch, parseAvitoDetail } from '../scripts/avito-parser.mjs';
import { collectAvitoSnapshot, createAvitoHttpTransport, runAvitoWorker } from '../scripts/avito-collector.mjs';
import { parseAvitoSnapshot, fetchAvitoOffers } from '../scripts/avito.mjs';
import { rankAvitoOffers, robustLogMarket } from '../scripts/avito-ranking.mjs';
import { openMasterStore } from '../scripts/master-store.mjs';
import { at, search, url, record, searchPage, detailPage, snapshot } from './fixtures/avito/sample.mjs';

const now = Date.parse(at);
const offer = overrides => normalizeAvitoListing(record(overrides)).offer;
test('Avito verifies city, condition and seller independently, including store aliases', () => {
  assert.equal(offer().retailer, AVITO);
  for (const name of ['МАКБУЧНАЯ', 'мкбчн', 'М К Б Ч Н', 'Макбучной', 'MacBookBro']) assert.equal(normalizeAvitoListing(record({ seller: { id: 'x', name } })).status, 'excluded');
  for (const condition of ['Б/у', 'Как новое', 'refurbished']) assert.equal(normalizeAvitoListing(record({ condition })).status, 'excluded');
  for (const city of ['Нижегородская область', 'Бор', 'Великий Новгород']) assert.equal(normalizeAvitoListing(record({ city })).status, 'excluded');
  for (const missing of [{ city: '' }, { condition: '' }]) assert.equal(normalizeAvitoListing(record(missing)).status, 'review');
  assert.equal(normalizeAvitoListing(record({ seller: { name: 'Магазин' } })).status, 'review');
  assert.equal(normalizeAvitoListing(record(), { sellerMap: { 'independent-shop': 'Макбучная' } }).status, 'excluded');
});
test('Avito rejects bait prices, mixed variants, used titles and configuration conflicts', () => {
  for (const title of ['MacBook Air 13 M4 16/256 Silver как новый', 'Чехол MacBook Air 13 M4 16/256 Silver', 'MacBook Air 13 M4 16/256 Silver б/у']) assert.equal(normalizeAvitoListing(record({ title })).status, 'excluded');
  assert.equal(normalizeAvitoListing(record({ priceText: 'от 100 000 ₽' })).status, 'review');
  assert.equal(normalizeAvitoListing(record({ priceType: 'installment' })).status, 'review');
  assert.equal(normalizeAvitoListing(record({ currency: 'USD' })).status, 'review');
  assert.equal(normalizeAvitoListing(record({ title: 'MacBook Air 13 M4 16/256 и 24/512 Silver' })).status, 'review');
  assert.equal(normalizeAvitoListing(record({ specs: { ramGb: 24 } })).status, 'review');
  assert.equal(normalizeAvitoListing(record({ description: 'Состояние: б/у, почти не пользовались' })).status, 'excluded');
  assert.equal(normalizeAvitoListing(record({ description: 'Новый. Также выкупаем б/у ноутбуки.' })).status, 'accepted');
  assert.equal(normalizeAvitoListing(record({ title: 'MacBook Air 13 M4 16/256 Silver не вскрыт' })).status, 'accepted');
  assert.equal(normalizeAvitoListing(record({ title: 'MacBook Air 13 M4 16/256', specs: { color: 'Silver' } })).status, 'accepted');
});
test('Avito never fills missing specs from slug or description and validates identities', () => {
  assert.equal(normalizeAvitoListing(record({ title: 'MacBook Air', description: 'M4 16/256 Silver', url: 'https://www.avito.ru/nizhniy_novgorod/noutbuki/macbook_m4_16_256_silver_1234567890' })).status, 'review');
  assert.equal(normalizeAvitoListing(record({ id: '9999999999' })).status, 'review');
  for (const link of ['https://evil.test/x_1234567890', 'https://avito.ru.evil.test/x_1234567890', 'http://www.avito.ru/x_1234567890', 'https://user:pass@www.avito.ru/x_1234567890']) assert.throws(() => avitoUrl(link));
});
test('Avito parses DOM and MFE JSON with count and strict pagination scope', () => {
  const page = parseAvitoSearch(searchPage(['1234567890'], 2, search + '&p=2'), search);
  assert.equal(page.items[0].price, 100000); assert.equal(page.total, 2); assert.equal(page.nextUrl, search + '&p=2');
  const data = { loaderData: { data: { catalog: { count: 1, items: [{ id: 1234567890, urlPath: url('1234567890'), title: 'MacBook', priceDetailed: { value: 100000 }, addressDetailed: { locationName: 'Нижний Новгород' } }] } } } };
  assert.equal(parseAvitoSearch(`<script type="mime/invalid" data-mfe-state="true">${JSON.stringify(data)}</script>`, search).items.length, 1);
  assert.throws(() => parseAvitoSearch(searchPage(['1234567890'], 2, search.replace('macbook', 'iphone') + '&p=2'), search), /область/);
  assert.throws(() => parseAvitoSearch('<title>Доступ ограничен</title>', search), { code: 'AVITO_BLOCKED' });
  assert.throws(() => parseAvitoSearch('<html>Changed markup</html>', search), /не распознан/);
});
test('Avito detail extracts condition, identity and immutable evidence hash', () => {
  const item = parseAvitoDetail(detailPage(), url('1234567890'), at);
  assert.equal(item.city, 'Нижний Новгород'); assert.equal(item.condition, 'Новое'); assert.equal(item.seller.id, 'independent-shop');
  assert.equal(item.documentHash.length, 64); assert.equal(normalizeAvitoListing(item).status, 'accepted');
  assert.equal(normalizeAvitoListing(parseAvitoDetail(detailPage('мкбчн'), url('1234567890'), at)).status, 'excluded');
});
test('live search layout coalesces promotional price variants, keeps the full count and preserves local priority', () => {
  const data = { loaderData: { data: { count: 1783, totalCount: 1500, searchCore: { localPriority: 1 },
    catalog: { items: [{ id: 1234567890, urlPath: url('1234567890'), title: 'MacBook Air 13 M4 16/256 Silver', priceDetailed: { value: 105000 } }],
      pager: { next: `${search}&context=opaque&p=2` } } } } };
  const html = searchPage(['1234567890'], 1783) + `<script type="mime/invalid" data-mfe-state="true">${JSON.stringify(data)}</script>`;
  const page = parseAvitoSearch(html, search + '&localPriority=1');
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0].priceVariants, [105000, 100000]);
  assert.equal(page.total, 1783);
  assert.equal(new URL(page.nextUrl).searchParams.get('localPriority'), '1');
  assert.equal(new URL(page.nextUrl).searchParams.get('p'), '2');
  const changed = structuredClone(data); changed.loaderData.data.catalog.pager.next = search.replace('macbook', 'iphone') + '&p=2';
  assert.throws(() => parseAvitoSearch(`<script type="mime/invalid" data-mfe-state="true">${JSON.stringify(changed)}</script>`, search + '&localPriority=1'), /область/);
});
test('hydrated detail address is tied to the requested ID; mixed-case models and explicit Air blue normalize consistently', () => {
  const item = { id: 1234567890, address: 'г.о. Нижний Новгород, площадь' };
  const state = { loaderData: { route: { data: { item } } } };
  const hydration = `<script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(JSON.stringify(state))});</script>`;
  const page = detailPage().replace('<div data-marker="item-view/item-address">Нижний Новгород, центр</div>', '')
    .replace('MacBook Air 13 M4 16/256 Silver новый', 'MacBook Air 13 M5 16/512 Новый')
    .replace('<li>Цвет: Silver</li>', '<li>Модель: Macbook Air 13 (2026, M5)</li><li>Процессор: Apple M5</li><li>Оперативная память, ГБ: 16</li><li>Объем накопителей, ГБ: 512</li><li>Цвет: Голубой</li>');
  const record = parseAvitoDetail(page + hydration, url('1234567890'), at);
  assert.equal(record.city, 'Нижний Новгород');
  const result = normalizeAvitoListing(record);
  assert.equal(result.status, 'accepted');
  assert.equal(result.offer.model, 'MacBook Air 13"');
  assert.equal(result.offer.color, 'Sky Blue');
  assert.equal(parseAvitoDetail(page + hydration, url('1234567891'), at).city, '');
});
test('search title disagreements remain rejected even though price promotions are allowed', () => {
  const html = searchPage(['1234567890']) + searchPage(['1234567890']).replaceAll('MacBook Air', 'MacBook Pro');
  assert.throws(() => parseAvitoSearch(html, search), { code: 'AVITO_CONFLICT' });
});
test('collector preserves observed cards and progress before access restriction without claiming completeness', async () => {
  const checkpoints = [], progress = [];
  await assert.rejects(collectAvitoSnapshot({ now: () => at,
    fetchPage: async u => u === search ? searchPage(['1234567890', '1234567891'])
      : u === url('1234567890') ? detailPage() : '<title>Доступ ограничен</title>',
    onProgress: async p => progress.push(p), onCheckpoint: async s => checkpoints.push(s),
  }), { code: 'AVITO_BLOCKED' });
  assert.equal(progress.at(-1).detailed, 1);
  assert.equal(checkpoints.at(-1).complete, false);
  assert.equal(checkpoints.at(-1).listings.length, 1);
  assert.equal(checkpoints.at(-1).listings[0].observedAt, at);
});
test('worker respects stored access cooldown without overwriting the last snapshot', async t => {
  const dir = await mkdtemp(`${tmpdir()}/avito-cooldown-`); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = { state: 'blocked', retryAfter: new Date(Date.now() + 3600000).toISOString() };
  await writeFile(`${dir}/state.json`, JSON.stringify(state));
  await writeFile(`${dir}/snapshot.json`, 'unchanged');
  assert.equal((await runAvitoWorker({ env: { AVITO_TRANSPORT: 'http', AVITO_DATA_DIR: dir } })).state, 'blocked');
  assert.equal(await readFile(`${dir}/snapshot.json`, 'utf8'), 'unchanged');
  assert.deepEqual(JSON.parse(await readFile(`${dir}/state.json`, 'utf8')), state);
});
test('Avito complete crawl follows every page and details; repeated pages fail', async () => {
  const pages = new Map([[search, searchPage(['1234567890'], 2, search + '&p=2')], [search + '&p=2', searchPage(['1234567891'], 2)],
    [url('1234567890'), detailPage()], [url('1234567891'), detailPage('Другой магазин')]]);
  const result = await collectAvitoSnapshot({ fetchPage: async u => pages.get(u), now: () => at });
  assert.equal(result.complete, true); assert.equal(result.pages, 2); assert.equal(result.listings.length, 2);
  pages.set(search + '&p=2', searchPage(['1234567890'], 2));
  await assert.rejects(collectAvitoSnapshot({ fetchPage: async u => pages.get(u), now: () => at }), /повторилась/);
});
test('Avito missing totals or detail errors are partial, never a complete empty success', async () => {
  const result = await collectAvitoSnapshot({ fetchPage: async u => u === search ? searchPage(['1234567890'], 2) : '<html>Changed markup</html>', now: () => at });
  assert.equal(result.complete, false); assert.equal(result.listings.length, 0); assert.equal(result.failures.length, 2);
});
test('Avito access blocks stop transport with one request, no retry or redirect following', async () => {
  let calls = 0;
  const get = createAvitoHttpTransport({ fetchImpl: async (_, options) => { calls++; assert.equal(options.redirect, 'manual'); return new Response('blocked', { status: 403 }); } });
  await assert.rejects(get(search), { code: 'AVITO_BLOCKED' }); assert.equal(calls, 1);
  await assert.rejects(collectAvitoSnapshot({ fetchPage: async u => u === search ? searchPage(['1234567890']) : '<title>captcha</title>', now: () => at }), { code: 'AVITO_BLOCKED' });
});
test('Avito snapshot validates completeness, unique IDs, and real observation times', () => {
  const good = snapshot([record()]);
  assert.equal(parseAvitoSnapshot(good, { now }).offers.length, 1);
  assert.throws(() => parseAvitoSnapshot(good, { now: now + 91 * 60000 }), /устарел/);
  assert.throws(() => parseAvitoSnapshot(snapshot([record(), record()]), { now }), /повтор/);
  assert.throws(() => parseAvitoSnapshot({ ...good, expectedTotal: 2 }, { now }), /полнота/);
  assert.throws(() => parseAvitoSnapshot(snapshot([record({ observedAt: '2026-09-25T00:00:00Z' })]), { now }), /дата/);
});
test('Avito worker defaults to no network and exposes an honest readiness state', async t => {
  const dir = await mkdtemp(`${tmpdir()}/avito-disabled-`); t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await runAvitoWorker({ env: { AVITO_DATA_DIR: dir } });
  assert.equal(result.state, 'not_configured');
  assert.equal(JSON.parse(await readFile(`${dir}/state.json`)).state, 'not_configured');
});
test('Avito complete snapshots withdraw omitted listings; partial snapshots preserve them and old prices remain in history', async t => {
  const dir = await mkdtemp(`${tmpdir()}/avito-snapshot-`); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = openMasterStore(':memory:'); t.after(() => store.close());
  const prior = { ...offer(), fetchedAt: '2026-09-26T11:00:00Z', observedAt: '2026-09-26T11:00:00Z' };
  store.ingestRun({ observations: [prior] });
  await writeFile(`${dir}/snapshot.json`, JSON.stringify(snapshot([], { complete: false, discovered: 1, expectedTotal: 1 })));
  const partial = await fetchAvitoOffers({ env: { AVITO_DATA_DIR: dir }, previous: [prior], now });
  assert.equal(partial.offers.length, 0);
  await writeFile(`${dir}/snapshot.json`, JSON.stringify(snapshot([])));
  const complete = await fetchAvitoOffers({ env: { AVITO_DATA_DIR: dir }, previous: [prior], now });
  assert.equal(complete.offers[0].stock, 'Discontinued');
  store.ingestRun({ observations: complete.offers });
  assert.equal(store.getOffers().filter(visibleAvitoOffer).length, 0);
  assert.equal(store.getHistory(prior.listingId).length, 2);
});

test('Avito detail schema drift preserves the last price with low trust instead of withdrawing the item', async t => {
  const dir = await mkdtemp(`${tmpdir()}/avito-review-`); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = openMasterStore(':memory:'); t.after(() => store.close());
  const prior = { ...offer(), fetchedAt: '2026-09-26T11:00:00Z', observedAt: '2026-09-26T11:00:00Z' };
  store.ingestRun({ observations: [prior] });
  await writeFile(`${dir}/snapshot.json`, JSON.stringify(snapshot([record({ seller: {} })])));
  const result = await fetchAvitoOffers({ env: { AVITO_DATA_DIR: dir }, previous: [prior], now });
  assert.equal(result.offers[0].rejected, true);
  store.ingestRun({ observations: result.offers });
  const shown = rankAvitoOffers(store.getOffers({ includeRejected: true, summary: true }), { now });
  assert.equal(shown.length, 1); assert.equal(shown[0].fetchedAt, prior.fetchedAt.replace('Z', '.000Z'));
  assert.equal(shown[0].avitoRank.level, 'low');
  assert.ok(shown[0].avitoRank.reasons.some(r => r.includes('Последняя проверка')));
});

test('Avito explicitly used item is withdrawn even when other pages failed', async t => {
  const dir = await mkdtemp(`${tmpdir()}/avito-used-`); t.after(() => rm(dir, { recursive: true, force: true }));
  const prior = { ...offer(), fetchedAt: '2026-09-26T11:00:00Z', observedAt: '2026-09-26T11:00:00Z' };
  await writeFile(`${dir}/snapshot.json`, JSON.stringify(snapshot([record({ condition: 'Б/у' })], { complete: false, discovered: 2, expectedTotal: 2 })));
  const result = await fetchAvitoOffers({ env: { AVITO_DATA_DIR: dir }, previous: [prior], now });
  assert.equal(result.offers[0].stock, 'Discontinued');
});

test('Avito integrates snapshot, hourly build, SQLite and catalogue without touching the network', async t => {
  const root = await mkdtemp(`${tmpdir()}/avito-build-`); t.after(() => rm(root, { recursive: true, force: true }));
  await cp(resolve('scripts'), join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'data/private/avito'), { recursive: true }); await mkdir(join(root, 'apps-script'));
  await writeFile(join(root, 'apps-script/reference.gs'), '');
  for (const file of ['catalog', 'offers', 'cheapest']) await writeFile(join(root, `data/${file}.json`), '[]');
  const observedAt = new Date().toISOString();
  await writeFile(join(root, 'data/private/avito/snapshot.json'), JSON.stringify(snapshot([record({ observedAt })], { startedAt: observedAt, completedAt: observedAt })));
  execFileSync(process.execPath, ['scripts/build-data.mjs'], { cwd: root, env: { ...process.env, LIVE: '1', RETAILER: AVITO, AVITO_DATA_DIR: 'data/private/avito' } });
  const store = openMasterStore(join(root, 'data/private/master.sqlite')); t.after(() => store.close());
  assert.equal(store.getOffers().length, 1);
  const status = JSON.parse(await readFile(join(root, 'data/status.json')));
  assert.equal(status.sources[0].status, 'success'); assert.equal(status.sources[0].counts.accepted, 1);
  assert.equal(JSON.parse(await readFile(join(root, 'data/cheapest.json')))[0].offers[0].retailer, AVITO);
});

const shop = (retailer, price = 100000) => ({ ...offer(), retailer, price, listingId: retailer, marketplaceSellerId: undefined, sellerName: undefined });
test('Avito robust log model is finite for equal prices and resistant to a large outlier', () => {
  const m = robustLogMarket([100000, 100000, 100000, 1000000].map(price => ({ price, weight: 1 })));
  assert.ok(Math.exp(m.mu) < 110000); assert.ok(Number.isFinite(m.variance));
});
test('Avito five-percent rule uses independent shop reference and ranks trustworthy offers ahead of bait', () => {
  const a = offer(), cheap = offer({ id: '1234567891', url: url('1234567891'), price: 80000, seller: { id: 'cheap', name: 'Дешёвый' } });
  const ranked = rankAvitoOffers([a, cheap, shop('Айфория'), shop('Technichno'), shop('iMobile')], { now }).filter(o => o.retailer === AVITO);
  assert.equal(ranked[1].avitoRank.level, 'low'); assert.equal(ranked[1].avitoRank.referencePrice, 100000);
  assert.ok(ranked[1].avitoRank.reasons.includes('Ниже рынка на ~20%'));
  assert.ok(ranked[0].avitoRank.position < ranked[1].avitoRank.position);
  const border = rankAvitoOffers([{ ...a, price: 95000 }, shop('Айфория'), shop('Technichno')], { now })[0];
  assert.equal(border.avitoRank.reasons.some(x => x.startsWith('Ниже рынка')), false);
});
test('ReSale has the same market weight and no permanent penalty for its mapped Avito profile', () => {
  const source = offer();
  const mapped = rankAvitoOffers([{ ...source, matchedRetailer: 'ReSale' }, shop('Айфория'), shop('Technichno'), shop('iMobile')], { now })[0];
  const other = rankAvitoOffers([{ ...source, matchedRetailer: 'Apple Store' }, shop('Айфория'), shop('Technichno'), shop('iMobile')], { now })[0];
  assert.equal(mapped.avitoRank.score, other.avitoRank.score);
  assert.deepEqual(mapped.avitoRank.reasons, other.avitoRank.reasons);
  const reference = rankAvitoOffers([source, shop('ReSale'), shop('Technichno')], { now })[0];
  assert.equal(reference.avitoRank.independentSellers, 2);
  assert.equal(reference.avitoRank.referencePrice, 100000);
});
test('Avito duplicates never increase support, and mapped website/Avito sellers count once', () => {
  const target = offer(), peer = offer({ id: '1234567891', url: url('1234567891'), seller: { id: 'peer', name: 'Другой' }, price: 102000 });
  const shops = [shop('Айфория'), shop('Technichno')];
  const baseline = rankAvitoOffers([target, peer, ...shops], { now })[0].avitoRank;
  const duplicates = Array.from({ length: 100 }, (_, i) => ({ ...peer, listingId: `duplicate-${i}` }));
  const multiplied = rankAvitoOffers([target, peer, ...duplicates, ...shops], { now })[0].avitoRank;
  assert.deepEqual(multiplied, baseline);
  const mapped = rankAvitoOffers([target, { ...peer, matchedRetailer: 'Айфория' }, ...shops], { now })[0].avitoRank;
  assert.equal(mapped.independentSellers, 2);
});
test('Avito self seller is excluded, sparse market never earns high trust; stale prices lose trust', () => {
  const one = offer();
  assert.equal(rankAvitoOffers([one, { ...one, listingId: 'duplicate' }], { now })[0].avitoRank.independentSellers, 0);
  assert.notEqual(rankAvitoOffers([one], { now })[0].avitoRank.level, 'high');
  assert.equal(rankAvitoOffers([one, shop('Айфория'), shop('Technichno')], { now: now + 5 * 3600000 })[0].avitoRank.level, 'low');
});
test('Avito color trust is per seller, and known conflicting cores never enter the reference', () => {
  const one = { ...offer(), cpuCores: 8, gpuCores: 8 };
  const otherColor = { ...one, color: 'Midnight', price: 110000, listingId: 'other-color' };
  const ranked = rankAvitoOffers([one, otherColor, { ...shop('Айфория'), cpuCores: 10 }], { now });
  assert.equal(ranked[0].avitoRank.level, 'low'); assert.equal(ranked[0].avitoRank.independentSellers, 0);
  assert.ok(ranked[0].avitoRank.reasons.some(r => r.includes('цвет')));
  assert.equal(rankAvitoOffers([one, { ...otherColor, marketplaceSellerId: 'another' }], { now })[0].avitoRank.reasons.some(r => r.includes('цвет')), false);
});
