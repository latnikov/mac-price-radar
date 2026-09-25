import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMasterStore, preserveInitialSnapshot } from '../scripts/master-store.mjs';

const at = '2026-09-16T10:00:00.000Z';
const offer = (overrides = {}) => ({ retailer: 'Shop', externalId: 'p1', title: 'MacBook', url: 'https://example.com/mac', price: 99990, currency: 'RUB', fetchedAt: at, condition: 'unknown', ...overrides });
function memory(t) { const store = openMasterStore(':memory:'); t.after(() => store.close()); return store; }

test('summary preserves prices and failed-attempt evidence; revisions track writes from other connections', t => {
  const directory = mkdtempSync(join(tmpdir(), 'master-revision-'));
  const reader = openMasterStore(join(directory, 'master.sqlite'));
  const writer = openMasterStore(join(directory, 'master.sqlite'));
  t.after(() => { reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }); });
  const before = reader.getRevision();
  writer.ingestRun({ runId: 'accepted', observations: [offer({ raw: { payload: 'large' }, evidence: { method: 'test' } })] });
  assert.notEqual(reader.getRevision(), before);
  writer.ingestRun({ runId: 'failed', observations: [offer({ price: null, fetchedAt: '2026-09-16T11:00:00Z' })] });
  const full = reader.getOffers({ includeRejected: true });
  const summary = reader.getOffers({ includeRejected: true, summary: true });
  assert.deepEqual(summary, full.map(({ raw, evidence, ...rest }) => rest));
  assert.equal(summary[0].latestAttempt.rejected, true);
  const localBefore = reader.getRevision();
  reader.ingestRun({ runId: 'local', observations: [offer({ price: 99000, fetchedAt: '2026-09-16T12:00:00Z' })] });
  assert.notEqual(reader.getRevision(), localBefore);
});

test('atomic ingestion preserves earlier sources and immutable history on partial failure', t => {
  const store = memory(t);
  store.ingestRun({ runId: 'one', observations: [offer(), offer({ retailer: 'Other', price: 100000 })], sources: [{ retailer: 'Shop', status: 'success' }, { retailer: 'Other', status: 'success' }] });
  const shop = store.getOffers().find(row => row.retailer === 'Shop');
  store.ingestRun({ runId: 'two', observations: [offer({ price: 101000, fetchedAt: '2026-09-16T11:00:00Z' })], sources: [{ retailer: 'Shop', status: 'partial' }, { retailer: 'Other', status: 'failed', error: 'timeout' }] });
  assert.equal(store.getOffers().length, 2);
  assert.equal(store.getOffers().find(row => row.retailer === 'Other').observedAt, at);
  assert.equal(store.getHistory(shop.listingId).length, 2);
  assert.equal(store.getHistory(shop.listingId)[0].price, 101000);
  assert.equal(store.getRuns().length, 2);
  assert.equal(store.getSources().find(row => row.retailer === 'Other').status, 'failed');
});

test('retry is idempotent; a new run confirms freshness without duplicating listings', t => {
  const store = memory(t);
  const input = { runId: 'retry', observations: [offer(), offer()] };
  assert.equal(store.ingestRun(input).counts.duplicates, 1);
  assert.equal(store.ingestRun(input).duplicate, true);
  assert.equal(store.getOffers().length, 1);
  assert.throws(() => store.ingestRun({ ...input, observations: [offer({ price: 1 })] }), /different input/);
  store.ingestRun({ runId: 'new-check', observations: [offer({ fetchedAt: '2026-09-16T11:00:00Z' })] });
  assert.equal(store.getHistory(store.getOffers()[0].listingId).length, 2);
});

test('failed transaction rolls back run, source changes, and every observation', t => {
  const store = memory(t);
  assert.throws(() => store.ingestRun({ runId: 'broken', observations: [offer(), { ...offer(), url: 'javascript:alert(1)' }] }), /Invalid listing URL/);
  assert.deepEqual(store.getRuns(), []);
  assert.deepEqual(store.getOffers({ includeRejected: true }), []);
  assert.deepEqual(store.getSources(), []);
  assert.deepEqual(store.getAudit(), []);
});

test('rejected checks are recorded without replacing previous accepted price or freshness', t => {
  const store = memory(t);
  store.ingestRun({ runId: 'good', observations: [offer()] });
  store.ingestRun({ runId: 'bad', observations: [offer({ price: -1, fetchedAt: '2026-09-16T11:00:00Z', raw: { title: 'bad price' } })] });
  assert.equal(store.getOffers()[0].price, 99990);
  assert.equal(store.getOffers()[0].observedAt, at);
  assert.equal(store.getOffers({ includeRejected: true })[0].latestAttempt.rejected, true);
  assert.equal(store.getHistory({ retailer: 'Shop', url: 'https://example.com/mac' }).length, 2);
  assert.deepEqual(store.getHistory(store.getOffers()[0].listingId)[0].raw, { title: 'bad price' });
});

test('failed check preserves rejected legacy price and its time without accepting it', t => {
  const store = memory(t);
  store.ingestRun({runId:'legacy',observations:[offer({currency:'unknown',dataKind:'legacy',validationStatus:'rejected'})]});
  store.ingestRun({runId:'failed',observations:[offer({currency:'unknown',price:null,priceMinor:null,fetchedAt:'2026-09-21T12:00:00Z',validationStatus:'rejected'})]});
  assert.equal(store.getOffers().length,0);
  const [saved]=store.getOffers({includeRejected:true});
  assert.equal(saved.price,99990);assert.equal(saved.fetchedAt,at);assert.equal(saved.rejected,true);
  assert.equal(saved.latestAttempt.observedAt,'2026-09-21T12:00:00.000Z');
  assert.equal(store.getHistory(saved.listingId).length,2);
});

test('missing currency never rejects a ruble price', t => {
  const store=memory(t);
  store.ingestRun({runId:'rubles',observations:[offer({currency:undefined})]});
  assert.equal(store.getOffers()[0].currency,'RUB');
  assert.equal(store.getOffers()[0].rejected,false);
});

test('master output uses one Apple model and storage vocabulary', t => {
  const store=memory(t);
  store.ingestRun({runId:'canonical-product',observations:[offer({model:'MacBook Neo',storageGb:1024})]});
  const saved=store.getOffers()[0];
  assert.equal(saved.model,'MacBook Neo 13"');
  assert.equal(saved.storageGb,1000);
});

test('external IDs survive URL and title changes; explicit options separate same URL', t => {
  const store = memory(t);
  store.ingestRun({ runId: 'first', observations: [offer()] });
  const listingId = store.getOffers()[0].listingId;
  store.ingestRun({ runId: 'renamed', observations: [offer({ title: 'New title', url: 'https://example.com/new', fetchedAt: '2026-09-16T11:00:00Z' })] });
  assert.equal(store.getOffers()[0].listingId, listingId);
  store.ingestRun({ runId: 'options', observations: [offer({ optionId: '16/512' }), offer({ optionId: '24/512' })] });
  assert.equal(store.getOffers().length, 3);
});

test('Technichno keeps navigable URLs and merges unknown/full listing profiles', t => {
  const store = memory(t);
  const url = 'https://nn.technichno.ru/catalog/mac/macbook-neo/group/product';
  const first = { ...offer({ retailer: 'Technichno', externalId: undefined, url, priceType: 'unknown' }), sourceId: 'technichno-source' };
  store.ingestRun({ runId: 'technichno-legacy', observations: [first] });
  const saved = store.getOffers()[0];
  assert.equal(saved.url, `${url}/`);
  store.ingestRun({ runId: 'technichno-live', observations: [{ ...first, priceType: 'full', price: 101000, fetchedAt: '2026-09-16T11:00:00Z' }] });
  assert.equal(store.getOffers().length, 1);
  assert.equal(store.getOffers()[0].listingId, saved.listingId);
  assert.equal(store.getOffers()[0].price, 101000);
  assert.equal(store.getHistory({ retailer: 'Technichno', url }).length, 2);
});

test('Technichno read model hides pre-existing legacy/live duplicate listings', t => {
  const store = memory(t);
  const url = 'https://nn.technichno.ru/catalog/mac/macbook-neo/group/product';
  const base = { ...offer({ retailer: 'Technichno', externalId: undefined, url }), sourceId: 'technichno-source' };
  store.ingestRun({ runId: 'old-listing', observations: [{ ...base, listingId: 'legacy-listing', dataKind: 'legacy' }] });
  store.ingestRun({ runId: 'new-listing', observations: [{ ...base, listingId: 'live-listing', dataKind: 'live', price: 101000, fetchedAt: '2026-09-16T11:00:00Z' }] });
  assert.equal(store.getOffers().length, 1);
  assert.equal(store.getOffers()[0].listingId, 'live-listing');
  assert.equal(store.getHistory({ retailer: 'Technichno', url: `${url}/` }).length, 2);
});
test('Iphoriya keeps URL identity when WooCommerce ids appear and hides existing migration duplicates', t => {
  const store = openMasterStore(':memory:'); t.after(() => store.close());
  const url = 'https://iphoriya.ru/product/macbook-air';
  const first = { ...offer({ retailer: 'Айфория', externalId: undefined, url }), sourceId: 'iphoriya-source' };
  const legacy = store.ingestRun({ runId: 'iphoriya-legacy', observations: [first] });
  const current = store.ingestRun({ runId: 'iphoriya-current', observations: [{ ...first, externalId: 'iphoriya:42', price: 101000, fetchedAt: '2026-09-16T11:00:00Z' }] });
  assert.equal(store.getOffers().length, 1);
  assert.equal(store.getOffers()[0].listingId, store.getHistory({ retailer: 'Айфория', url })[0].listingId);
  store.ingestRun({ runId: 'iphoriya-migration-duplicate', observations: [{ ...first, listingId: 'temporary-external-id-listing', price: 102000, fetchedAt: '2026-09-16T12:00:00Z' }] });
  assert.equal(store.getOffers().length, 1);
  assert.equal(store.getOffers()[0].price, 102000);
  assert.equal(legacy.counts.accepted, 1);
  assert.equal(current.counts.accepted, 1);
});

test('manual import previews without mutation, isolates bad rows and retries without duplicates', t => {
  const store = memory(t);
  const input = { supplier: 'Private', actor: 'max', reason: 'Supplier emailed price list', rows: [offer({ retailer: 'Private', externalId: 'sku1' }), { price: -5, currency: 'RUB' }, { url: 'javascript:bad', currency: 'RUB', price: 50000 }] };
  const preview = store.previewImport(input);
  assert.equal(preview.accepted, 1);
  assert.equal(preview.rejected, 2);
  assert.equal(store.getRuns().length, 0);
  assert.equal(store.commitImport(input).duplicate, false);
  assert.equal(store.commitImport({ ...input, actor: 'another reviewer', reason: 'Retry' }).duplicate, true);
  assert.equal(store.getOffers({ includeRejected: true }).length, 3);
  assert.equal(store.getOffers().length, 1);
  assert.equal(store.getOffers()[0].visibility, 'private');
  assert.equal(store.getAudit()[0].actor, 'max');
  assert.throws(() => store.commitImport({ ...input, actor: '' }), /actor/);
});

test('quotes maintain immutable versions, stale updates fail and expired confirmations are drafts', t => {
  const store = memory(t);
  const input = { id: 'q1', actor: 'max', reason: 'phone confirmation', supplier: 'Private', unitPriceMinor: 9000000, currency: 'RUB', quantity: 1, availableQuantity: 1, validUntil: '2099-01-01T00:00:00Z', confirmedAt: at, destination: 'NN', deliveryMinor: 150000, paymentMethod: 'bank', documents: 'invoice', variantId: 'verified1', matchStatus: 'exact', variant:{model:'MacBook Air 13',chip:'M4',cpuCores:10,gpuCores:10,ramGb:16,storageGb:512,screenIn:13,color:'Silver',keyboard:'US',region:'US',displayType:'standard',bundle:'standard'},variantConfirmation:{confirmed:true,actor:'max',reason:'verified specs',evidence:'manufacturer SKU',confirmedAt:at}, condition:'new', warranty:'12 months supplier', origin:'Moscow',deliveryDays:1 };
  const first = store.saveQuote(input);
  assert.equal(first.version, 1);
  assert.equal(first.status, 'confirmed');
  assert.equal(store.saveQuote(input).duplicate, true);
  const changed = store.saveQuote({ ...input, expectedVersion: 1, unitPriceMinor: 9100000 });
  assert.equal(changed.version, 2);
  assert.throws(() => store.saveQuote({ ...input, expectedVersion: 1, unitPriceMinor: 9200000 }), /different quote|conflict/);
  assert.equal(store.listQuotes({ history: true }).length, 2);
  const expired = store.saveQuote({ ...input, id: 'expired', validUntil: '2020-01-01T00:00:00Z' });
  assert.equal(expired.status, 'draft');
  assert.ok(expired.blockers.includes('expired:validUntil'));
});

test('consistent immutable backup restores observations and quote audit', t => {
  const dir = mkdtempSync(join(tmpdir(), 'master-store-'));
  const original = openMasterStore(join(dir, 'live.sqlite'));
  t.after(() => { original.close(); rmSync(dir, { recursive: true, force: true }); });
  original.ingestRun({ runId: 'backup-run', observations: [offer()] });
  original.saveQuote({ id: 'draft', actor: 'max', reason: 'draft', supplier: 'Private', quantity: 1, unitPriceMinor: 9000000, currency: 'RUB' });
  const backup = original.backup(join(dir, 'backup.sqlite'));
  assert.equal(backup.sha256.length, 64);
  assert.throws(() => original.backup(backup.path), /already exists/);
  const restoredPath = join(dir, 'restored.sqlite');
  copyFileSync(backup.path, restoredPath);
  chmodSync(restoredPath, 0o600);
  const restored = openMasterStore(restoredPath);
  assert.deepEqual(restored.getOffers(), original.getOffers());
  assert.deepEqual(restored.getAudit(), original.getAudit());
  assert.deepEqual(restored.listQuotes(), original.listQuotes());
  restored.close();
  writeFileSync(join(dir, 'legacy.json'), '{"legacy":true}\n');
  const legacy = preserveInitialSnapshot(join(dir, 'legacy.json'), join(dir, 'backups'));
  assert.deepEqual(preserveInitialSnapshot(join(dir, 'legacy.json'), join(dir, 'backups')), legacy);
  assert.equal(readFileSync(legacy.path, 'utf8'), '{"legacy":true}\n');
});
