import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { calculateEconomics, minorUnits, validateQuote } from './procurement.mjs';
import { canonicalModelName, canonicalStorageGb } from './domain.mjs';

export const SCHEMA_VERSION = 1;
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const id = (prefix, value) => `${prefix}_${digest(value).slice(0, 24)}`;
const now = () => new Date().toISOString();
const required = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`); return value.trim(); };
const date = (value, fallback) => { const result = value ?? fallback; if (!Number.isFinite(Date.parse(result))) throw new TypeError(`Invalid timestamp: ${result}`); return new Date(result).toISOString(); };
const rowJSON = row => row ? JSON.parse(row.json) : null;
const secretKeys = /^(?:password|secret|token|accessToken|refreshToken|authorization|cookie|apiKey)$/i;
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKeys.test(key)).map(([key, child]) => [key, sanitize(child)]));
  return value;
}
function canonicalURL(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported URL protocol');
    if (parsed.username || parsed.password) throw new Error('Credentials in URL are not allowed');
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) parsed.searchParams.delete(key);
    parsed.searchParams.sort();
    return parsed.href.replace(/\/$/, '');
  } catch { throw new TypeError(`Invalid listing URL: ${value}`); }
}
function identity(offer) {
  const retailer = required(offer.retailer ?? offer.supplier, 'retailer');
  const sellerId = offer.sellerId ?? id('seller', retailer.trim().toLowerCase());
  const sourceType = offer.sourceType ?? 'website';
  const sourceId = offer.sourceId ?? id('source', [sellerId, sourceType]);
  const url = canonicalURL(offer.url);
  const externalId = offer.externalId ?? offer.sourceProductId ?? offer.sellerSku ?? offer.sku;
  const optionId = [offer.optionId ?? offer.sourceVariantId ?? offer.listingVariantKey ?? '', offer.paymentMethod ?? 'unknown', offer.minimumQuantity ?? offer.moq ?? 'unknown', offer.priceType ?? 'unknown'];
  if (!offer.listingId && !externalId && !url) throw new TypeError('Listing requires listingId, externalId or URL');
  const listingId = offer.listingId ?? id('listing', [sourceId, externalId ? ['external', String(externalId)] : ['url', url], optionId]);
  return { retailer, sellerId, sourceId, sourceType, listingId, externalId: externalId == null ? null : String(externalId), url };
}
function isRejected(offer) {
  return offer.rejected === true || ['rejected', 'invalid'].includes(offer.validationStatus) || offer.status === 'rejected' || offer.matchStatus === 'rejected';
}

/** Preserve the original legacy input exactly once; identical retry returns the same file. */
export function preserveInitialSnapshot(filePath, backupDirectory) {
  const contents = readFileSync(filePath);
  const sha256 = digest(contents);
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const path = resolve(backupDirectory, `initial-${sha256}.json`);
  if (!existsSync(path)) {
    copyFileSync(filePath, path, constants.COPYFILE_EXCL);
    chmodSync(path, 0o400);
  } else if (digest(readFileSync(path)) !== sha256) throw new Error('Initial backup integrity check failed');
  return { path, sha256 };
}

export function openMasterStore(dbPath = 'data/private/master.sqlite') {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sellers (id TEXT PRIMARY KEY, name TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL REFERENCES sellers(id), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), external_id TEXT, url TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, payload_hash TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS observations (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), listing_id TEXT NOT NULL REFERENCES listings(id), observed_at TEXT NOT NULL, received_at TEXT NOT NULL, rejected INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS observations_listing ON observations(listing_id, observed_at DESC, seq DESC);
    CREATE INDEX IF NOT EXISTS observations_run ON observations(run_id);
    CREATE TABLE IF NOT EXISTS source_runs (run_id TEXT NOT NULL REFERENCES runs(id), source_id TEXT NOT NULL REFERENCES sources(id), json TEXT NOT NULL, PRIMARY KEY(run_id, source_id));
    CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quote_revisions (id TEXT NOT NULL, version INTEGER NOT NULL, operation_key TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(id,version));
    CREATE TABLE IF NOT EXISTS price_decisions (id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(id,version));
    CREATE TRIGGER IF NOT EXISTS prices_no_update BEFORE UPDATE ON price_decisions BEGIN SELECT RAISE(ABORT,'Price history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS prices_no_delete BEFORE DELETE ON price_decisions BEGIN SELECT RAISE(ABORT,'Price history is append-only'); END;
    CREATE TABLE IF NOT EXISTS calculations (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS price_decisions (id TEXT NOT NULL, version INTEGER NOT NULL, operation_key TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(id,version));
    CREATE TRIGGER IF NOT EXISTS observations_no_update BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,'Observations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT,'Observations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS quotes_no_update BEFORE UPDATE ON quote_revisions BEGIN SELECT RAISE(ABORT,'Quote history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS quotes_no_delete BEFORE DELETE ON quote_revisions BEGIN SELECT RAISE(ABORT,'Quote history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS decisions_no_update BEFORE UPDATE ON price_decisions BEGIN SELECT RAISE(ABORT,'Price decision history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS decisions_no_delete BEFORE DELETE ON price_decisions BEGIN SELECT RAISE(ABORT,'Price decision history is append-only'); END;
  `);
  const existingVersion = db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value;
  if (existingVersion && Number(existingVersion) !== SCHEMA_VERSION) { db.close(); throw new Error(`Unsupported master schema version ${existingVersion}`); }
  db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('schema_version',?)").run(String(SCHEMA_VERSION));
  if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
  const transaction = callback => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  function audit(actor, reason, entityType, entityId, before, after) {
    const at = now();
    db.prepare('INSERT INTO audit(at,actor,reason,entity_type,entity_id,json) VALUES (?,?,?,?,?,?)').run(at, actor, reason, entityType, entityId, JSON.stringify({ at, actor, reason, entityType, entityId, before, after }));
  }
  function registerSource(input) {
    const retailer = required(input.retailer ?? input.supplier, 'source.retailer');
    const sellerId = input.sellerId ?? id('seller', retailer.toLowerCase());
    const sourceType = input.sourceType ?? 'website';
    const sourceId = input.sourceId ?? id('source', [sellerId, sourceType]);
    const seller = { id: sellerId, name: retailer, verificationStatus: input.verificationStatus ?? 'unverified' };
    db.prepare('INSERT INTO sellers VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,json=excluded.json').run(sellerId, retailer, JSON.stringify(seller));
    const previous = rowJSON(db.prepare('SELECT json FROM sources WHERE id=?').get(sourceId));
    const source = { ...previous, id: sourceId, sourceId, sellerId, retailer, sourceType, visibility: input.visibility ?? (sourceType === 'private_price_list' ? 'private' : previous?.visibility ?? 'public'), adapterVersion: input.adapterVersion ?? previous?.adapterVersion ?? 'unknown', ...sanitize(input) };
    db.prepare('INSERT INTO sources VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(sourceId, sellerId, JSON.stringify(source));
    return { sourceId, sellerId, retailer, sourceType };
  }
  function ingestRun(input) {
    if (!Array.isArray(input.observations ?? [])) throw new TypeError('observations must be an array');
    const payload = sanitize(input);
    const runId = input.runId ?? `run_${randomUUID()}`;
    const payloadHash = digest(payload);
    return transaction(() => {
      const previous = db.prepare('SELECT payload_hash,json FROM runs WHERE id=?').get(runId);
      if (previous) {
        if (previous.payload_hash !== payloadHash) throw new Error(`Run ${runId} already exists with different input`);
        return { ...rowJSON(previous), duplicate: true };
      }
      const actor = input.actor ?? 'collector';
      const reason = input.reason ?? 'Source observation';
      const startedAt = date(input.startedAt, now());
      const receivedAt = now();
      const run = { runId, startedAt, finishedAt: receivedAt, actor, reason, importPayloadHash: input.importPayloadHash, sources: input.sources ?? [], counts: { received: (input.observations ?? []).length, accepted: 0, rejected: 0, duplicates: 0 }, duplicate: false };
      db.prepare('INSERT INTO runs VALUES (?,?,?,?,?)').run(runId, startedAt, receivedAt, payloadHash, JSON.stringify(run));
      const knownSources = new Map();
      for (const source of input.sources ?? []) {
        const registered = registerSource({ ...source, lastAttemptAt: receivedAt, lastRunId: runId });
        knownSources.set(registered.sourceId, { ...source, ...registered });
      }
      for (const [index, sourceOffer] of (input.observations ?? []).entries()) {
        if (!sourceOffer || typeof sourceOffer !== 'object') throw new TypeError(`Observation ${index} must be an object`);
        const offer = sanitize(sourceOffer);
        offer.currency = 'RUB';
        offer.model = canonicalModelName(offer.model);
        offer.storageGb = canonicalStorageGb(offer.storageGb);
        if (offer.dataKind === 'demo' || offer.seed || offer.demo || offer.isDemo || offer.environment === 'demo' || offer.dataKind === 'demo') throw new Error('Demonstration data cannot enter the master store');
        const ids = identity(offer);
        if (!knownSources.has(ids.sourceId)) {
          registerSource({ retailer: ids.retailer, sellerId: ids.sellerId, sourceId: ids.sourceId, sourceType: ids.sourceType, visibility: offer.visibility, lastAttemptAt: receivedAt, lastRunId: runId });
          knownSources.set(ids.sourceId, { ...ids, status: 'partial' });
        }
        const existingListing = db.prepare('SELECT source_id FROM listings WHERE id=?').get(ids.listingId);
        if (existingListing && existingListing.source_id !== ids.sourceId) throw new Error('listingId cannot move between sources');
        const listing = { ...ids, title: offer.title ?? null, variantId: offer.variantId ?? null, matchStatus: offer.matchStatus ?? 'needs_review' };
        db.prepare('INSERT INTO listings VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id,url=excluded.url,json=excluded.json').run(ids.listingId, ids.sourceId, ids.externalId, ids.url, JSON.stringify(listing));
        const observedAt = date(offer.observedAt ?? offer.fetchedAt, startedAt);
        let rejected = isRejected(offer);
        const amountMinor = offer.priceMinor ?? minorUnits(offer.price);
        const validationIssues = [...(offer.validationIssues ?? [])];
        if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) { rejected = true; validationIssues.push('invalid_price'); }
        const observationId = offer.observationId ?? id('observation', [runId, ids.listingId, observedAt, digest(offer)]);
        const observation = { ...offer, ...ids, observationId, offerId: ids.listingId, runId, observedAt, fetchedAt: observedAt, receivedAt, visibility: offer.visibility ?? (ids.sourceType === 'private_price_list' ? 'private' : 'public'), priceMinor: Number.isSafeInteger(amountMinor) ? amountMinor : null, validationStatus: rejected ? 'rejected' : offer.validationStatus ?? 'needs_review', rejected, validationIssues, raw: offer.raw ?? offer, provenance: { ...offer.provenance, runId, sourceId: ids.sourceId, receivedAt, adapterVersion: offer.adapterVersion ?? offer.normalizationVersion ?? 'unknown' } };
        const priorObservation = db.prepare('SELECT run_id,json FROM observations WHERE id=?').get(observationId);
        if (priorObservation) {
          if (priorObservation.run_id !== runId || rowJSON(priorObservation).listingId !== ids.listingId) throw new Error('observationId collision');
          run.counts.duplicates++;
          continue;
        }
        db.prepare('INSERT INTO observations(id,run_id,listing_id,observed_at,received_at,rejected,json) VALUES (?,?,?,?,?,?,?)').run(observationId, runId, ids.listingId, observedAt, receivedAt, rejected ? 1 : 0, JSON.stringify(observation));
        run.counts[rejected ? 'rejected' : 'accepted']++;
      }
      run.sources = [...knownSources.values()];
      for (const source of run.sources) db.prepare('INSERT INTO source_runs VALUES (?,?,?)').run(runId, source.sourceId, JSON.stringify(source));
      db.prepare('UPDATE runs SET json=? WHERE id=?').run(JSON.stringify(run), runId);
      audit(actor, reason, 'run', runId, null, run);
      return run;
    });
  }
  function getOffers({ includeRejected = false } = {}) {
    // A failed fetch must not erase even an unverified legacy price from the table.
    // Such a fallback remains rejected; it is never promoted to an accepted offer.
    const rows = db.prepare(`SELECT o.json FROM observations o WHERE o.seq = COALESCE((SELECT good.seq FROM observations good WHERE good.listing_id=o.listing_id AND good.rejected=0 ORDER BY good.observed_at DESC,good.seq DESC LIMIT 1), ${includeRejected ? "(SELECT rejected.seq FROM observations rejected WHERE rejected.listing_id=o.listing_id ORDER BY CASE WHEN json_extract(rejected.json,'$.price') > 0 THEN 0 ELSE 1 END,rejected.observed_at DESC,rejected.seq DESC LIMIT 1)" : 'NULL'}) ORDER BY o.listing_id`).all();
    return rows.map(row => {
      const offer = rowJSON(row);
      offer.currency = 'RUB';
      offer.model = canonicalModelName(offer.model);
      offer.storageGb = canonicalStorageGb(offer.storageGb);
      const latest = rowJSON(db.prepare('SELECT json FROM observations WHERE listing_id=? ORDER BY observed_at DESC,seq DESC LIMIT 1').get(offer.listingId));
      if (latest.observationId !== offer.observationId) offer.latestAttempt = { observationId: latest.observationId, observedAt: latest.observedAt, receivedAt: latest.receivedAt, rejected: latest.rejected, validationStatus: latest.validationStatus, validationIssues: latest.validationIssues, qualityWarnings: latest.qualityWarnings ?? [], runId: latest.runId };
      return offer;
    });
  }
  function getHistory(reference, { limit = 1000 } = {}) {
    const value = typeof reference === 'string' ? { listingId: reference } : reference ?? {};
    let listingId = value.listingId ?? value.offerId;
    if (!listingId && value.retailer && value.url) {
      const url = canonicalURL(value.url);
      const listings = db.prepare('SELECT json FROM listings WHERE url=?').all(url).map(rowJSON).filter(item => item.retailer === value.retailer);
      return listings.flatMap(item => getHistory(item.listingId, { limit })).sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    }
    if (!listingId) return [];
    return db.prepare('SELECT json FROM observations WHERE listing_id=? ORDER BY observed_at DESC,seq DESC LIMIT ?').all(listingId, Math.max(1, Math.min(10000, Number(limit) || 1000))).map(rowJSON);
  }
  function previewImport(input) {
    if (!Array.isArray(input.rows)) throw new TypeError('rows must be an array');
    if (input.rows.length > 10000) throw new RangeError('Import is limited to 10000 rows');
    const rows = input.rows.map((row, index) => {
      const issues = [];
      if (!row || typeof row !== 'object' || Array.isArray(row)) return { index, status: 'rejected', issues: ['invalid_row'], offer: { raw: row } };
      const offer = { ...sanitize(row), retailer: row.retailer ?? input.retailer ?? input.supplier, sourceType: 'private_price_list', visibility: 'private', sourceId: row.sourceId ?? input.sourceId };
      offer.model = canonicalModelName(offer.model);
      offer.storageGb = canonicalStorageGb(offer.storageGb);
      try { Object.assign(offer, identity(offer)); } catch (error) { issues.push(error.message); }
      const amount = offer.priceMinor ?? minorUnits(offer.price);
      if (!Number.isSafeInteger(amount) || amount <= 0) issues.push('invalid_price');
      offer.currency = 'RUB';
      if (offer.seed || offer.demo || offer.isDemo || offer.dataKind === 'demo') issues.push('demonstration_data');
      // An import is evidence, not automatic validation of the manufacturer's exact variant.
      offer.matchStatus = 'needs_review';
      offer.validationStatus = issues.length ? 'rejected' : 'needs_review';
      offer.priceMinor = amount;
      if (amount !== null) offer.price = amount / 100;
      return { index, status: issues.length ? 'rejected' : 'accepted', issues, offer };
    });
    const payloadHash = digest(sanitize({ rows: input.rows, retailer: input.retailer ?? input.supplier, sourceId: input.sourceId }));
    return { importId: input.importId ?? id('import', payloadHash), payloadHash, rows, accepted: rows.filter(row => row.status === 'accepted').length, rejected: rows.filter(row => row.status === 'rejected').length, counts: { received: rows.length, accepted: rows.filter(row => row.status === 'accepted').length, rejected: rows.filter(row => row.status === 'rejected').length } };
  }
  function commitImport(input) {
    const actor = required(input.actor, 'actor'), reason = required(input.reason, 'reason');
    const preview = previewImport(input);
    const prior = rowJSON(db.prepare('SELECT json FROM runs WHERE id=?').get(preview.importId));
    if (prior) {
      if (prior.importPayloadHash !== preview.payloadHash) throw new Error('Import ID already used with different file content');
      return { ...prior, importId: preview.importId, duplicate: true, previewCounts: preview.counts };
    }
    // Rejected rows are retained under deterministic quarantine listing IDs, including missing keys.
    const observations = preview.rows.map(row => ({ ...row.offer, retailer: row.offer.retailer || input.supplier || input.retailer || 'Неуказанный поставщик', sourceId: row.offer.sourceId ?? input.sourceId, listingId: row.offer.listingId ?? id('quarantine', [preview.importId, row.index]), url: row.issues.some(issue => issue.startsWith('Invalid listing URL')) ? undefined : row.offer.url, raw: sanitize(input.rows[row.index]), dataKind: 'private_import', seed: false, demo: false, isDemo: false, dataKind: 'import', environment: 'private_import', rejected: row.status === 'rejected', validationIssues: row.issues }));
    const run = ingestRun({ runId: preview.importId, importPayloadHash: preview.payloadHash, observations, sources: [], actor, reason });
    return { ...run, importId: preview.importId, previewCounts: preview.counts };
  }
  function saveQuote(input) {
    const actor = required(input.actor, 'actor'), reason = required(input.reason, 'reason');
    const clean = sanitize(input), payloadHash = digest(clean);
    return transaction(() => {
      const quoteId = input.id ?? (input.idempotencyKey ? id('quote', input.idempotencyKey) : `quote_${randomUUID()}`);
      const operationKey = input.idempotencyKey ?? `${quoteId}:${input.expectedVersion ?? 0}`;
      const priorOperation = db.prepare('SELECT payload_hash,json FROM quote_revisions WHERE operation_key=?').get(operationKey);
      if (priorOperation) {
        if (priorOperation.payload_hash !== payloadHash) throw new Error('Idempotency key already used with different quote input');
        return { ...rowJSON(priorOperation), duplicate: true };
      }
      const previous = rowJSON(db.prepare('SELECT json FROM quote_revisions WHERE id=? ORDER BY version DESC LIMIT 1').get(quoteId));
      if (previous && input.expectedVersion !== previous.version) throw new Error(`Quote version conflict: expected ${previous.version}`);
      if (!previous && input.expectedVersion != null && input.expectedVersion !== 0) throw new Error('Quote does not exist');
      const quote = { ...previous, ...clean, variantId: clean.variantId || previous?.variantId || (clean.variant ? id('variant', clean.variant) : null), id: quoteId, version: (previous?.version ?? 0) + 1, updatedAt: now() };
      Object.assign(quote, validateQuote(quote));
      db.prepare('INSERT INTO quote_revisions VALUES (?,?,?,?,?)').run(quoteId, quote.version, operationKey, payloadHash, JSON.stringify(quote));
      audit(actor, reason, 'quote', quoteId, previous, quote);
      return quote;
    });
  }
  function listQuotes({ history = false } = {}) {
    return db.prepare(`SELECT q.json FROM quote_revisions q ${history ? '' : 'WHERE q.version=(SELECT MAX(v.version) FROM quote_revisions v WHERE v.id=q.id)'} ORDER BY rowid DESC`).all().map(row => { const quote = rowJSON(row); return { ...quote, ...validateQuote(quote) }; });
  }
  function saveCalculation(input) {
    const actor = required(input.actor, 'actor'), reason = required(input.reason, 'reason');
    const calculation = calculateEconomics(input);
    const calculationId = input.id ?? id('calculation', sanitize(input));
    const payloadHash = digest(input);
    return transaction(() => {
      const previous = db.prepare('SELECT payload_hash,json FROM calculations WHERE id=?').get(calculationId);
      if (previous) {
        if (previous.payload_hash !== payloadHash) throw new Error('Calculation ID already used with different input');
        return { ...rowJSON(previous), duplicate: true };
      }
      const result = { ...calculation, id: calculationId, calculatedAt: now(), actor, reason };
      db.prepare('INSERT INTO calculations VALUES (?,?,?)').run(calculationId, payloadHash, JSON.stringify(result));
      audit(actor, reason, 'calculation', calculationId, null, result);
      return result;
    });
  }
  function evaluatePriceDecision(decision) {
    const blockers = [];
    const quote = rowJSON(db.prepare('SELECT json FROM quote_revisions WHERE id=? ORDER BY version DESC LIMIT 1').get(decision.quoteId));
    const calculation = rowJSON(db.prepare('SELECT json FROM calculations WHERE id=?').get(decision.calculationId));
    if (!quote || validateQuote(quote).status !== 'confirmed') blockers.push('unconfirmed:supply');
    if (quote && quote.version !== decision.quoteVersion) blockers.push('changed:quoteVersion');
    if (!calculation || !calculation.publishable) blockers.push('unconfirmed:economics');
    if (quote && calculation) {
      const input = calculation.input;
      if (input.quoteId !== quote.id || input.purchasePriceMinor !== quote.unitPriceMinor || input.currency !== quote.currency || input.destination !== quote.destination || input.quantity !== quote.quantity) blockers.push('mismatch:quoteCalculation');
      // Delivery in the quote is the whole shipment; calculation uses per-unit amounts.
      if (input.inboundDeliveryMinor * quote.quantity < quote.deliveryMinor) blockers.push('mismatch:delivery');
      if (decision.variantId !== quote.variantId) blockers.push('mismatch:variant');
      if (Date.parse(decision.validUntil) > Date.parse(quote.validUntil)) blockers.push('invalid:validUntil');
      if (decision.salePriceMinor !== input.salePriceMinor) blockers.push('mismatch:salePrice');
    }
    if (!Number.isFinite(Date.parse(decision.validUntil)) || Date.parse(decision.validUntil) <= Date.now()) blockers.push('expired:decision');
    if (decision.status !== 'approved') blockers.push('unapproved:decision');
    return { ...decision, blockers, publishable: blockers.length === 0, supplyConfirmed: !!quote && validateQuote(quote).status === 'confirmed' && quote.version === decision.quoteVersion };
  }
  function savePriceDecision(input) {
    const actor = required(input.actor, 'actor'), reason = required(input.reason, 'reason');
    const quoteId = required(input.quoteId, 'quoteId'), calculationId = required(input.calculationId, 'calculationId');
    return transaction(() => {
      const quote = rowJSON(db.prepare('SELECT json FROM quote_revisions WHERE id=? ORDER BY version DESC LIMIT 1').get(quoteId));
      const calculation = rowJSON(db.prepare('SELECT json FROM calculations WHERE id=?').get(calculationId));
      if (!quote || !calculation) throw new Error('Quote or calculation not found');
      const decisionId = input.id || id('price', [quoteId, calculationId, input.validUntil, input.publicTitle]);
      const previous = rowJSON(db.prepare('SELECT json FROM price_decisions WHERE id=? ORDER BY version DESC LIMIT 1').get(decisionId));
      if (previous && input.expectedVersion !== previous.version) throw new Error('Price decision version conflict');
      const decision = evaluatePriceDecision({ id: decisionId, version: (previous?.version || 0) + 1, publicTitle: required(input.publicTitle, 'publicTitle'), variantId: input.variantId, quoteId, quoteVersion: quote.version, calculationId, currency: quote.currency, destination: quote.destination, salePriceMinor: calculation.input.salePriceMinor, validUntil: input.validUntil, status: input.status || 'draft', actor, reason, approvedAt: now() });
      if (!['approved','draft','revoked'].includes(decision.status)) throw new Error('Invalid price decision status');
      if (decision.status === 'approved' && !decision.publishable) throw new Error(`Price approval blocked: ${decision.blockers.join(', ')}`);
      db.prepare('INSERT INTO price_decisions VALUES (?,?,?)').run(decisionId,decision.version,JSON.stringify(decision));
      audit(actor,reason,'price_decision',decisionId,previous,decision);
      return decision;
    });
  }
  function listPriceDecisions() {
    return db.prepare('SELECT p.json FROM price_decisions p WHERE p.version=(SELECT MAX(v.version) FROM price_decisions v WHERE v.id=p.id) ORDER BY rowid DESC').all().map(rowJSON).map(evaluatePriceDecision);
  }
  function backup(targetPath) {
    if (dbPath === ':memory:') throw new Error('Use a persistent database for backups');
    const target = resolve(targetPath);
    if (existsSync(target)) throw new Error('Backup already exists; immutable backups cannot be overwritten');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // SQLite creates a consistent database even while other connections read/write WAL.
    db.prepare('VACUUM INTO ?').run(target);
    chmodSync(target, 0o400);
    const manifest = { path: target, sha256: digest(readFileSync(target)), schemaVersion: SCHEMA_VERSION, createdAt: now(), counts: { observations: db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, runs: db.prepare('SELECT COUNT(*) AS n FROM runs').get().n } };
    writeFileSync(`${target}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
    return manifest;
  }
  return {
    dbPath, ingestRun, getOffers, getHistory, previewImport, commitImport, saveQuote, listQuotes, saveCalculation, savePriceDecision, listPriceDecisions, backup,
    getRuns: ({ limit = 50 } = {}) => db.prepare('SELECT json FROM runs ORDER BY started_at DESC,rowid DESC LIMIT ?').all(Math.max(1, Math.min(1000, Number(limit) || 50))).map(rowJSON),
    getSources: () => db.prepare('SELECT json FROM sources ORDER BY id').all().map(rowJSON),
    getAudit: ({ limit = 100 } = {}) => db.prepare('SELECT json FROM audit ORDER BY seq DESC LIMIT ?').all(Math.max(1, Math.min(10000, Number(limit) || 100))).map(rowJSON),
    getCalculations: () => db.prepare('SELECT json FROM calculations ORDER BY rowid DESC').all().map(rowJSON),
    close: () => db.close(),
  };
}
