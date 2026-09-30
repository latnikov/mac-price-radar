import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importApifyRun } from '../scripts/avito-apify-import.mjs';
import { readAvitoMonitor } from '../scripts/avito-monitor.mjs';
import { openMasterStore } from '../scripts/master-store.mjs';

const base = Date.parse('2026-09-30T12:00:00Z');
const iso = seconds => new Date(base + seconds * 1000).toISOString();
const run = sequence => ({ id: `synthetic-${sequence}`, actId: '4SsKYeXxLtIJLtzHp', status: 'SUCCEEDED',
  startedAt: iso(sequence * 60), finishedAt: iso(sequence * 60 + 50) });
const card = (sequence = 1, id = '1234567890', overrides = {}) => ({ id,
  url: `https://www.avito.ru/nizhniy_novgorod/noutbuki/macbook_${id}`,
  title: 'MacBook Air 13 M5 16/512 Sky Blue', address: 'Нижний Новгород',
  userType: 'private', price: 100000, currency: '₽', priceFormatted: '100 000 ₽', status: 'active',
  seller: { userKey: 'synthetic-seller', name: 'Алексей' },
  parameters: [{ name: 'Состояние', value: 'Отличное' }], scrapedAt: iso(sequence * 60 + 20), ...overrides });
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'apify-import-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, dir: join(root, 'data/private/avito'), now: base + 24 * 3600000 };
}
async function imported(work, sequence, records) { return importApifyRun({ ...work, run: run(sequence), records }); }
function inspect(root, fn) {
  const store = openMasterStore(join(root, 'data/private/master.sqlite'));
  try { return fn(store); } finally { store.close(); }
}
async function reviewIndex(work) { return JSON.parse(await readFile(join(work.dir, 'apify-review-index.json'), 'utf8')); }

test('archived Apify import preserves observation dates and receipt replay does not duplicate SQLite history', async t => {
  const work = await workspace(t), source = card();
  const first = await imported(work, 1, [source]);
  assert.equal(first.duplicate, false);
  let history = inspect(work.root, store => store.getHistory('avito:1234567890'));
  assert.equal(history.length, 1);
  assert.equal(history[0].observedAt, source.scrapedAt);
  assert.equal(history[0].fetchedAt, source.scrapedAt);
  assert.equal(history[0].validUntil, iso(80 + 4 * 3600));
  assert.equal(history[0].rejected, false);
  const current = await readAvitoMonitor({ ...work, offers: inspect(work.root, store => store.getOffers()), env: {} });
  assert.equal(current.opportunities.candidates.length, 0, 'archive must not generate fresh opportunities');
  await imported(work, 2, [card(2, '1234567890', { price: 90000, priceFormatted: '90 000 ₽' })]);
  const replay = await imported(work, 1, [source]);
  assert.equal(replay.duplicate, true);
  history = inspect(work.root, store => store.getHistory('avito:1234567890'));
  assert.equal(history.length, 2);
  assert.equal(history[0].price, 90000);
  assert.equal(history[0].previousPrice, 100000);
  const saved = JSON.parse(await readFile(join(work.dir, 'snapshot.json'), 'utf8'));
  assert.equal(saved.completedAt, run(2).finishedAt);
  assert.equal(saved.complete, false);
});

test('Apify run receipts reject changed datasets and changed run provenance', async t => {
  const work = await workspace(t), original = card();
  await imported(work, 1, [original]);
  await assert.rejects(imported(work, 1, [{ ...original, price: 110000, priceFormatted: '110 000 ₽' }]), /данные.*изменились/);
  await assert.rejects(importApifyRun({ ...work, records: [original], run: { ...run(1), finishedAt: iso(115) } }), /метаданные.*изменились/);
  await assert.rejects(importApifyRun({ ...work, records: [], run: { ...run(3), status: 'FAILED' } }), /успешный запуск/);
  await assert.rejects(importApifyRun({ ...work, records: [], run: { ...run(3), actId: 'different-actor' } }), /успешный запуск/);
  assert.equal(inspect(work.root, store => store.getHistory('avito:1234567890').length), 1);
});

test('partial Apify runs preserve missing listings instead of marking them sold', async t => {
  const work = await workspace(t);
  await imported(work, 1, [card(1), card(1, '1234567891')]);
  await imported(work, 2, [card(2)]);
  const offers = inspect(work.root, store => store.getOffers());
  assert.equal(offers.length, 2);
  const missing = offers.find(offer => offer.externalId === '1234567891');
  assert.equal(missing.observedAt, card(1).scrapedAt);
  assert.equal(missing.stock, 'source_reported');
  assert.equal(inspect(work.root, store => store.getHistory('avito:1234567891').length), 1);
});

test('new review and exclusion observations keep exact card dates, independent IDs and prior valid prices', async t => {
  const work = await workspace(t);
  await imported(work, 1, [card()]);
  const uncertain = card(2, '1234567890', { title: 'MacBook Air 13 M5' });
  await imported(work, 2, [uncertain]);
  let history = inspect(work.root, store => store.getHistory('avito:1234567890'));
  assert.equal(history.length, 2);
  assert.notEqual(history[0].observationId, history[1].observationId);
  assert.equal(history[0].observedAt, uncertain.scrapedAt);
  assert.equal(history[0].rejected, true);
  const retained = inspect(work.root, store => store.getOffers({ includeRejected: true }))[0];
  assert.equal(retained.observedAt, card().scrapedAt);
  assert.equal(retained.latestAttempt.observedAt, uncertain.scrapedAt);
  assert.equal(retained.latestAttempt.rejected, true);
  assert.equal((await reviewIndex(work))['1234567890'].city, 'Нижний Новгород');
  const broken = card(3, '1234567890', { parameters: [{ name: 'Состояние', value: 'Не работает' }] });
  await imported(work, 3, [broken]);
  history = inspect(work.root, store => store.getHistory('avito:1234567890'));
  assert.equal(history.length, 3);
  assert.equal(history[0].observedAt, broken.scrapedAt);
  assert.equal(history[0].stock, 'Discontinued');
  assert.equal(history[0].priceObservedAt, card().scrapedAt);
  assert.equal(history[0].rejected, false);
  assert.equal((await reviewIndex(work))['1234567890'], undefined);
  assert.equal((await imported(work, 3, [broken])).duplicate, true);
});

test('review index includes unresolved NN Intel cards but excludes non-NN and unknown localities', async t => {
  const work = await workspace(t);
  const intel = card(1, '1234567890', { title: 'MacBook Pro 13 Intel i5 8/256 Silver', parameters: [{ name: 'Состояние', value: 'Отличное' }] });
  const outside = card(1, '1234567891', { seller: {}, address: 'Москва' });
  const unknown = card(1, '1234567892', { seller: {}, address: undefined });
  await imported(work, 1, [intel, outside, unknown]);
  const index = await reviewIndex(work);
  assert.deepEqual(Object.keys(index), ['1234567890']);
  assert.equal(index['1234567890'].title, intel.title);
  const publicView = await readAvitoMonitor({ ...work, env: {}, offers: [] });
  assert.equal(publicView.review.length, 1);
  assert.equal(publicView.review[0].id, intel.id);
});

test('replaying older review after a newer accepted or excluded card does not resurrect it', async t => {
  const work = await workspace(t);
  const oldReview = card(1, '1234567890', { title: 'MacBook Pro 13 Intel i5 8/256 Silver', parameters: [{ name: 'Состояние', value: 'Отличное' }] });
  await imported(work, 1, [oldReview]);
  await imported(work, 2, [card(2, '1234567890', { parameters: [{ name: 'Состояние', value: 'Не работает' }] })]);
  await imported(work, 1, [oldReview]);
  assert.equal((await reviewIndex(work))['1234567890'], undefined);
  const laterReview = card(3, '1234567891', { seller: {} });
  await imported(work, 3, [laterReview]);
  await imported(work, 4, [card(4, '1234567891')]);
  await imported(work, 3, [laterReview]);
  assert.equal((await reviewIndex(work))['1234567891'], undefined);
});

test('public monitor whitelists fields, local review cards and strips credentials from diagnostics', async t => {
  const work = await workspace(t);
  await mkdir(work.dir, { recursive: true });
  const token = 'apify_api_SYNTHETIC_SECRET';
  await writeFile(join(work.dir, 'apify-state.json'), JSON.stringify({ state: 'failed', token,
    message: `Request https://api.apify.com/x?token=${token} failed`, transport: 'apify',
    access: { reason: { token }, status: 403, challenge: false },
    counts: { total: 20, accepted: 6, token }, budget: { limitUsd: 5, spentUsd: 0.2, remainingUsd: 4.8, token } }));
  await writeFile(join(work.dir, 'alerts-state.json'), JSON.stringify({ enabled: true, channel: 'telegram', token,
    message: `Authorization: Bearer ${token}`, lastSentAt: { token }, chatId: 'private-chat' }));
  await writeFile(join(work.dir, 'apify-review-index.json'), JSON.stringify({ a: {
    id: '1234567890', title: `MacBook ${token}`, city: 'Нижний Новгород', reason: `token=${token}`,
    url: `https://www.avito.ru/noutbuki/macbook_1234567890?token=${token}`, observedAt: iso(80), price: 50000,
    condition: 'Отличное', sellerType: 'private', sellerName: 'Алексей', token, privateNotes: 'PRIVATE_EXTRA' }, b: { id: '1234567891', city: 'Москва', token },
    c: { id: '1234567892', city: 'Нижний Новгород', url: 'https://evil.test/a', observedAt: iso(80) } }));
  const result = await readAvitoMonitor({ ...work, env: {}, offers: [] });
  const publicJson = JSON.stringify(result);
  for (const secret of [token, 'private-chat', 'PRIVATE_EXTRA']) assert.equal(publicJson.includes(secret), false, secret);
  assert.equal(result.state.budget.limitUsd, 5);
  assert.equal(result.review.length, 1);
  assert.equal(result.review[0].url, 'https://www.avito.ru/noutbuki/macbook_1234567890');
  assert.equal(result.notifications.lastSentAt, null);
  assert.equal(result.notifications.enabled, true);
});

test('public monitor safely handles missing or malformed state files', async t => {
  const work = await workspace(t);
  await mkdir(work.dir, { recursive: true });
  await writeFile(join(work.dir, 'apify-state.json'), 'null');
  await writeFile(join(work.dir, 'apify-review-index.json'), 'not-json');
  assert.equal((await readAvitoMonitor({ ...work, env: {} })).state.state, 'not_configured');
});

test('policy migration reparses a paid archive without making the observation fresh or reusing legacy receipt', async t => {
  const work = await workspace(t), source = card(), metadata = run(1);
  const legacy = {sourceId:'avito:nn',sellerId:'avito:marketplace',sourceType:'marketplace',listingId:'avito:1234567890',externalId:'1234567890',retailer:'Авито НН',url:source.url,
    model:'MacBook Air 13"',chip:'M5',screenIn:13,ramGb:16,storageGb:512,color:'Sky Blue',
    price:100000,currency:'RUB',condition:'used',stock:'source_reported',priceType:'full',
    sellerName:'Алексей',marketplaceSellerId:'synthetic-seller',fetchedAt:source.scrapedAt,observedAt:source.scrapedAt};
  inspect(work.root, store=>store.ingestRun({runId:`apify:${metadata.id}`,observations:[legacy]}));
  await mkdir(join(work.dir,'apify-runs'),{recursive:true});
  await writeFile(join(work.dir,'apify-runs',`${metadata.id}-import.json`),JSON.stringify({payload:{runId:`apify:${metadata.id}`,observations:[legacy]}}));
  const result=await imported(work,1,[source]);
  assert.equal(result.duplicate,false);
  assert.equal(result.counts.accepted,1);
  const offer=inspect(work.root,store=>store.getOffers())[0];
  assert.equal(offer.marketplaceSellerType,'private');
  assert.equal(offer.observedAt,source.scrapedAt);
  assert.equal((await imported(work,1,[source])).duplicate,true);
});
