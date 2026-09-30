import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APIFY_AVITO_ACTOR_ID, evaluateApifyBudget, fetchApifyDataset, runApifyWorker } from '../scripts/avito-apify-worker.mjs';

const start = '2026-09-30T12:00:00.000Z', end = '2026-10-07T12:00:00.000Z';
const now = Date.parse('2026-09-30T14:00:00.000Z');
const initialLedger = () => ({ schemaVersion: 1, periodStartedAt: start, periodEndsAt: end, limitUsd: 5,
  entries: [{ runId: 'initialTrial', status: 'SUCCEEDED', costUsd: 0.159, startedAt: start, importedAt: start }] });
const reply = (json, status = 200, headers = {}) => new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const run = (extra = {}) => ({ id: 'runTwo', actId: APIFY_AVITO_ACTOR_ID, status: 'SUCCEEDED',
  startedAt: new Date(now - 120_000).toISOString(), finishedAt: new Date(now - 60_000).toISOString(),
  defaultDatasetId: 'datasetTwo', usageTotalUsd: 0.365, ...extra });
async function fixture(t, ledger = initialLedger()) {
  const root = await mkdtemp(join(tmpdir(), 'avito-apify-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'apify-ledger.json'), JSON.stringify(ledger));
  return { root, ledgerPath: join(root, 'apify-ledger.json'), statePath: join(root, 'apify-state.json'),
    options: { root, env: { AVITO_DATA_DIR: root, APIFY_TOKEN: 'private-test-token' }, now: () => now, sleep: async () => {} } };
}

test('budget counts the seeded trial, all reservations and stops at the week, $5 or ten runs', () => {
  const ledger = initialLedger();
  assert.equal(evaluateApifyBudget(ledger, { now }).allowed, true);
  assert.equal(evaluateApifyBudget(ledger, { now }).budget.remainingUsd, 4.841);
  assert.equal(evaluateApifyBudget(ledger, { now: Date.parse(end) }).reason, 'period_ended');
  assert.equal(evaluateApifyBudget(ledger, { now: Date.parse(start) - 1 }).reason, 'period_not_started');
  assert.equal(evaluateApifyBudget(ledger, { now: Date.parse(start) + 59 * 60_000 }).reason, 'hourly_wait');
  ledger.entries.push({ runId: 'otherRun', status: 'SUCCEEDED', costUsd: 4.5, startedAt: start, importedAt: start });
  assert.equal(evaluateApifyBudget(ledger, { now }).reason, 'budget_limit');
  ledger.entries[1].costUsd = 0.365;
  for (let i = 0; i < 8; i++) ledger.entries.push({ runId: `oldRun${i}`, status: 'SUCCEEDED', costUsd: 0.01, startedAt: start, importedAt: start });
  assert.equal(evaluateApifyBudget(ledger, { now }).reason, 'run_limit');
  assert.equal(evaluateApifyBudget(ledger, { now }).budget.runsRemaining, 0);
});

test('an unknown POST holds its full reservation and cannot be retried automatically', () => {
  const ledger = initialLedger();
  ledger.entries.push({ status: 'POSTING', startedAt: start, reservationUsd: 0.4 });
  const gate = evaluateApifyBudget(ledger, { now });
  assert.equal(gate.reason, 'needs_reconciliation');
  assert.equal(gate.budget.spentUsd, 0.559);
  assert.equal(gate.budget.remainingUsd, 4.441);
});

test('the last allowed run imports its result and pauses instead of promising another hourly update', async t => {
  const ledger = initialLedger();
  for (let i = 0; i < 8; i++) ledger.entries.push({ runId: `pastRun${i}`, status: 'SUCCEEDED', costUsd: 0.365, startedAt: start, importedAt: start });
  const f = await fixture(t, ledger);
  let posts = 0;
  const result = await runApifyWorker({ ...f.options, fetchImpl: async (url, options) => {
    if (options.method === 'POST') { posts++; return reply({ data: run() }, 201); }
    return reply([]);
  }, importRun: async () => ({ counts: { accepted: 0 } }) });
  assert.equal(posts, 1);
  assert.equal(result.state, 'paused');
  assert.equal(result.schedule.enabled, false);
  assert.equal(result.budget.runsUsed, 10);
  assert.equal(result.nextRunAt, null);
});

test('successful execution persists a reservation before POST, imports safely and waits before another paid run', async t => {
  const f = await fixture(t), calls = [], imports = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method });
    assert.equal(options.headers.Authorization, 'Bearer private-test-token');
    assert.equal(options.redirect, 'error');
    assert.equal(url.includes('private-test-token'), false);
    if (options.method === 'POST') {
      const saved = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
      assert.equal(saved.entries.at(-1).status, 'POSTING');
      assert.equal(saved.entries.at(-1).reservationUsd, 0.4);
      const input = JSON.parse(options.body);
      assert.equal(input.maxResults, 45);
      assert.equal(input.sort, 'newest');
      assert.match(input.searchUrl, /nizhniy_novgorod\/noutbuki\?q=macbook&s=104$/);
      assert.equal(input.includeDetails, true);
      assert.equal(input.includePhone, false);
      assert.equal(input.includeReviews, false);
      assert.equal(new URL(url).searchParams.get('maxTotalChargeUsd'), '0.4');
      assert.equal(new URL(url).searchParams.get('restartOnError'), 'false');
      return reply({ data: run({ status: 'RUNNING', finishedAt: null, startedAt: new Date(now).toISOString() }) }, 201);
    }
    if (url.includes('/actor-runs/')) return reply({ data: run({ startedAt: new Date(now).toISOString() }) });
    return reply([{ id: 1234567890 }], 200, { 'x-apify-pagination-total': '1', 'x-apify-pagination-offset': '0', 'x-apify-pagination-count': '1' });
  };
  const result = await runApifyWorker({ ...f.options, fetchImpl, importRun: async args => { imports.push(args); return { counts: { accepted: 1 } }; } });
  assert.equal(result.state, 'partial');
  assert.equal(result.transport, 'apify');
  assert.equal(result.counts.accepted, 1);
  assert.equal(result.budget.spentUsd, 0.524);
  assert.equal(result.schedule.intervalMinutes, 60);
  assert.equal(result.nextRunAt, new Date(now + 3_600_000).toISOString());
  assert.equal(imports.length, 1);
  assert.equal(imports[0].root, f.root);
  assert.equal(imports[0].records.length, 1);
  assert.equal((await stat(f.ledgerPath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(f.root, 'apify-runs/runTwo.json'), 'utf8')).length, 1);
  assert.equal(JSON.stringify(result).includes('private-test-token'), false);
  const again = await runApifyWorker({ ...f.options, fetchImpl: async () => { assert.fail('hourly gate must not make API calls'); } });
  assert.equal(again.state, 'partial');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('a lost POST response is persisted, never leaks tokens, and blocks subsequent requests', async t => {
  const f = await fixture(t);
  let calls = 0;
  const result = await runApifyWorker({ ...f.options, fetchImpl: async () => { calls++; throw new Error('provider includes private-test-token'); } });
  assert.equal(result.state, 'needs_attention');
  assert.equal(result.schedule.enabled, false);
  assert.equal(result.budget.spentUsd, 0.559);
  assert.equal(JSON.stringify(result).includes('private-test-token'), false);
  const ledger = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
  assert.equal(ledger.entries.at(-1).status, 'POST_UNKNOWN');
  await runApifyWorker({ ...f.options, fetchImpl: async () => { calls++; assert.fail('ambiguous run must not retry'); } });
  assert.equal(calls, 1);
});

test('explicit API POST errors also halt without silently consuming another paid attempt', async t => {
  const f = await fixture(t);
  const result = await runApifyWorker({ ...f.options, fetchImpl: async () => reply({ error: { message: 'private-test-token' } }, 402) });
  assert.equal(result.state, 'needs_attention');
  assert.equal(result.budget.runsUsed, 2);
  assert.equal(result.message.includes('private-test-token'), false);
});

test('an existing paid run resumes with GET and imports even after the budget period ended', async t => {
  const ledger = initialLedger();
  ledger.entries.push({ runId: 'runTwo', status: 'RUNNING', reservationUsd: 0.4, startedAt: new Date(now).toISOString() });
  const f = await fixture(t, ledger), methods = [];
  let imported = 0;
  const result = await runApifyWorker({ ...f.options, now: () => Date.parse(end), fetchImpl: async (url, options) => {
    methods.push(options.method);
    return url.includes('/actor-runs/') ? reply({ data: run() }) : reply([]);
  }, importRun: async () => { imported++; return { counts: { accepted: 0 } }; } });
  assert.equal(imported, 1);
  assert.deepEqual(methods, ['GET', 'GET']);
  assert.equal(result.state, 'paused');
  assert.equal(result.schedule.enabled, false);
  assert.equal(result.budget.spentUsd, 0.524);
});

test('missing terminal costs retain the full reserved charge', async t => {
  const ledger = initialLedger();
  ledger.entries.push({ runId: 'runTwo', status: 'RUNNING', reservationUsd: 0.4, startedAt: new Date(now).toISOString() });
  const f = await fixture(t, ledger);
  const result = await runApifyWorker({ ...f.options, fetchImpl: async url => url.includes('/actor-runs/')
    ? reply({ data: run({ usageTotalUsd: null, startedAt: new Date(now).toISOString() }) }) : reply([]), importRun: async () => ({ counts: {} }) });
  assert.equal(result.budget.spentUsd, 0.559);
  assert.equal(result.budget.reservedUsd, 0.4);
  assert.equal(JSON.parse(await readFile(f.ledgerPath, 'utf8')).entries.at(-1).costUsd, undefined);
});

test('a preliminary terminal cost is not treated as final when the settled response omits cost', async t => {
  const ledger = initialLedger();
  ledger.entries.push({ runId: 'runTwo', status: 'RUNNING', reservationUsd: 0.4, startedAt: new Date(now).toISOString() });
  const f = await fixture(t, ledger);
  let reads = 0, waited = 0;
  const result = await runApifyWorker({ ...f.options, sleep: async ms => { waited += ms; }, fetchImpl: async url => {
    if (!url.includes('/actor-runs/')) return reply([]);
    reads++;
    return reply({ data: run({ startedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(), usageTotalUsd: reads === 1 ? 0.01 : null }) });
  }, importRun: async () => ({ counts: {} }) });
  assert.equal(waited, 10_000);
  assert.equal(reads, 2);
  assert.equal(result.budget.spentUsd, 0.559);
  const saved = JSON.parse(await readFile(f.ledgerPath, 'utf8')).entries.at(-1);
  assert.equal(saved.costUsd, 0.01);
  assert.equal(saved.costSettled, false);
});

test('cooldown, period end and missing-token ticks preserve last data timestamp and imported counts', async t => {
  const f = await fixture(t);
  const original = { state: 'partial', transport: 'apify', updatedAt: start, counts: { received: 20, accepted: 6, used: 3 } };
  await writeFile(f.statePath, JSON.stringify(original));
  const fetchImpl = async () => assert.fail('no network while waiting');
  const waitingAt = Date.parse(start) + 30 * 60_000;
  const waiting = await runApifyWorker({ ...f.options, now: () => waitingAt, fetchImpl });
  assert.equal(waiting.updatedAt, start);
  assert.equal(waiting.statusCheckedAt, new Date(waitingAt).toISOString());
  assert.deepEqual(waiting.counts, original.counts);
  const stopped = await runApifyWorker({ ...f.options, now: () => Date.parse(end), fetchImpl });
  assert.equal(stopped.updatedAt, start);
  assert.deepEqual(stopped.counts, original.counts);
  const noToken = await runApifyWorker({ ...f.options, env: { AVITO_DATA_DIR: f.root }, fetchImpl });
  assert.equal(noToken.state, 'not_configured');
  assert.equal(noToken.updatedAt, start);
  assert.deepEqual(noToken.counts, original.counts);
  assert.equal((await stat(f.ledgerPath)).mode & 0o777, 0o600);
});

test('the displayed next run aligns with the hourly timer without shortening the one-hour gate', () => {
  const ledger = initialLedger();
  ledger.entries[0].startedAt = '2026-09-30T12:41:36.898Z';
  ledger.entries[0].costUsd = 0.15882000000000002;
  const gate = evaluateApifyBudget(ledger, { now: Date.parse('2026-09-30T13:30:00.000Z') });
  assert.equal(gate.reason, 'hourly_wait');
  assert.equal(gate.nextRunAt, '2026-09-30T14:00:00.000Z');
  assert.equal(gate.budget.spentUsd, 0.15882);
});

test('GET failure keeps run identity so the next invocation can only resume, never replay POST', async t => {
  const ledger = initialLedger();
  ledger.entries.push({ runId: 'runTwo', status: 'RUNNING', reservationUsd: 0.4, startedAt: start });
  const f = await fixture(t, ledger);
  const result = await runApifyWorker({ ...f.options, fetchImpl: async (_, options) => {
    assert.equal(options.method, 'GET'); return reply({ token: 'private-test-token' }, 500);
  } });
  assert.equal(result.state, 'error');
  assert.equal(result.budget.spentUsd, 0.559);
  assert.equal(JSON.parse(await readFile(f.ledgerPath, 'utf8')).entries.at(-1).runId, 'runTwo');
});

test('failed actors stop later paid runs and preserve actual charges', async t => {
  const ledger = initialLedger();
  ledger.entries.push({ runId: 'runTwo', status: 'RUNNING', reservationUsd: 0.4, startedAt: start });
  const f = await fixture(t, ledger);
  const result = await runApifyWorker({ ...f.options, fetchImpl: async () => reply({ data: run({ status: 'TIMED-OUT', usageTotalUsd: 0.01 }) }) });
  assert.equal(result.state, 'needs_attention');
  assert.equal(result.budget.spentUsd, 0.169);
  assert.equal(result.schedule.enabled, false);
});

test('dataset pagination verifies offsets, totals and retrieves all pages', async () => {
  const offsets = [];
  const records = await fetchApifyDataset('dataset', { token: 'secret', pageSize: 2, fetchImpl: async url => {
    const offset = Number(new URL(url).searchParams.get('offset')); offsets.push(offset);
    const data = offset === 0 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }];
    return reply(data, 200, { 'x-apify-pagination-total': '3', 'x-apify-pagination-offset': String(offset), 'x-apify-pagination-count': String(data.length) });
  } });
  assert.equal(records.length, 3);
  assert.deepEqual(offsets, [0, 2]);
  await assert.rejects(fetchApifyDataset('dataset', { fetchImpl: async () => reply([], 200, { 'x-apify-pagination-total': '3001' }) }), /превышает/);
  await assert.rejects(fetchApifyDataset('dataset', { fetchImpl: async () => reply([], 200, { 'x-apify-pagination-total': '1' }) }), /не соответствует/);
  await assert.rejects(fetchApifyDataset('dataset', { fetchImpl: async () => reply([{ id: 1 }], 200, { 'x-apify-pagination-offset': '100' }) }), /противоречат/);
  await assert.rejects(fetchApifyDataset('dataset', { pageSize: 1, fetchImpl: async () => reply([{ id: 1 }]) }), /повторилась/);
});

test('missing ledger, changed budget period and live locks cannot launch', async t => {
  const f = await fixture(t);
  const fetchImpl = async () => assert.fail('must not access API');
  const changed = await runApifyWorker({ ...f.options, env: { ...f.options.env, AVITO_APIFY_PERIOD_END: '2026-10-08T12:00:00.000Z' }, fetchImpl });
  assert.equal(changed.state, 'error');
  assert.equal(changed.schedule.enabled, false);
  await writeFile(join(f.root, 'apify-worker.lock'), JSON.stringify({ pid: process.pid, token: 'owner' }));
  assert.equal((await runApifyWorker({ ...f.options, fetchImpl })).state, 'locked');
  await rm(join(f.root, 'apify-worker.lock'));
  await rm(f.ledgerPath);
  const missing = await runApifyWorker({ ...f.options, fetchImpl });
  assert.equal(missing.state, 'error');
  assert.equal(missing.schedule.enabled, false);
});

test('stale PID locks can be recovered without ignoring budget gates', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'apify-worker.lock'), JSON.stringify({ pid: 2_147_483_647, token: 'dead' }));
  const result = await runApifyWorker({ ...f.options, now: () => Date.parse(end), fetchImpl: async () => assert.fail('expired period') });
  assert.equal(result.state, 'paused');
  await assert.rejects(stat(join(f.root, 'apify-worker.lock')), { code: 'ENOENT' });
});

test('an import failure retains raw data and never marks the already-paid result imported', async t => {
  const ledger = initialLedger();
  ledger.entries.push({ runId: 'runTwo', status: 'RUNNING', reservationUsd: 0.4, startedAt: start });
  const f = await fixture(t, ledger);
  const result = await runApifyWorker({ ...f.options, fetchImpl: async url => url.includes('/actor-runs/') ? reply({ data: run() }) : reply([{ id: 1 }]),
    importRun: async () => { throw new Error('private-test-token'); } });
  assert.equal(result.state, 'error');
  assert.equal(result.message.includes('private-test-token'), false);
  assert.equal(JSON.parse(await readFile(f.ledgerPath, 'utf8')).entries.at(-1).importedAt, undefined);
  assert.equal(JSON.parse(await readFile(join(f.root, 'apify-runs/runTwo.json'), 'utf8')).length, 1);
});

test('paging actor uses all pages, private sellers and stable incremental state while sharing the total budget', async t => {
  const f = await fixture(t), actor = 'km2oo0mCahDBKPOa6';
  f.options.env = { ...f.options.env, AVITO_APIFY_ACTOR_ID: actor, AVITO_APIFY_MAX_RESULTS: '0', AVITO_APIFY_RUN_LIMIT: '168', AVITO_APIFY_MAX_RUN_USD: '3' };
  let posts = 0;
  const result = await runApifyWorker({ ...f.options, fetchImpl: async (url, options) => {
    if (options.method === 'POST') {
      posts++; const input = JSON.parse(options.body);
      assert.match(url, new RegExp(`/acts/${actor}/runs`));
      assert.equal(new URL(url).searchParams.get('maxTotalChargeUsd'), '3');
      assert.equal(new URL(url).searchParams.get('memory'), '1024');
      assert.deepEqual(input.regions, ['nizhniy_novgorod']);
      assert.equal(input.ownerOnly, true); assert.equal(input.maxListings, 0);
      assert.equal(input.incrementalMode, true); assert.equal(input.emitUnchanged, false);
      assert.equal(input.maxPages, undefined);
      return reply({ data: run({ actId: actor, usageTotalUsd: 0.1 }) });
    }
    return reply([]);
  }, importRun: async () => ({ counts: { accepted: 0 } }) });
  assert.equal(posts, 1); assert.equal(result.budget.spentUsd, 0.259);
  assert.equal(JSON.parse(await readFile(f.ledgerPath, 'utf8')).entries.at(-1).actorId, actor);
});

test('a requested manual scan may bypass the hourly wait but cannot bypass money or resume into a second paid run', async t => {
  const f = await fixture(t), waitingNow = Date.parse(start) + 10 * 60_000;
  let posts = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === 'POST') { posts++; return reply({ data: run({ startedAt: start, finishedAt: start }) }); }
    return reply([]);
  };
  await runApifyWorker({ ...f.options, now: () => waitingNow, manualRun: true, fetchImpl, importRun: async () => ({ counts: {} }) });
  assert.equal(posts, 1);
  const ledger = initialLedger(); ledger.entries.push({runId:'runTwo',status:'RUNNING',reservationUsd:0.4,startedAt:start});
  await writeFile(f.ledgerPath, JSON.stringify(ledger));
  await runApifyWorker({ ...f.options, manualRun: true, fetchImpl: async url => url.includes('/actor-runs/') ? reply({data:run()}) : reply([]), importRun: async () => ({counts:{}}) });
  assert.equal(posts, 1);
  ledger.entries[0].costUsd = 4.9; ledger.entries.splice(1);
  await writeFile(f.ledgerPath, JSON.stringify(ledger));
  const stopped = await runApifyWorker({ ...f.options, manualRun: true, fetchImpl: async () => assert.fail('budget must not be bypassed') });
  assert.equal(stopped.state, 'paused'); assert.equal(stopped.budget.spentUsd, 4.9);
});

test('manual price-range collection uses documented filters and cannot repay an already saved request', async t => {
  const f = await fixture(t); let posts = 0;
  f.options.env = {...f.options.env,AVITO_APIFY_PRICE_MIN:'0',AVITO_APIFY_PRICE_MAX:'49999'};
  const options = {...f.options,manualRun:true,requestKey:'initial:under50k',importRun:async()=>({counts:{accepted:0}}),fetchImpl:async(url,options)=>{
    if(options.method==='POST') {posts++;const input=JSON.parse(options.body);assert.equal(input.searchUrl,undefined);assert.equal(input.priceMin,0);assert.equal(input.priceMax,49999);return reply({data:run()});}
    return reply([]);
  }};
  await runApifyWorker(options); await runApifyWorker(options);
  assert.equal(posts,1);
  const entry=JSON.parse(await readFile(f.ledgerPath,'utf8')).entries.at(-1);
  assert.equal(entry.requestKey,'initial:under50k');assert.deepEqual(entry.scope,{priceMin:0,priceMax:49999});
});

test('actor lifetime allowance is separate from the shared $5 expense of every tested provider', () => {
  const ledger=initialLedger();
  for(let i=0;i<2;i++)ledger.entries.push({runId:`probe${i}`,actorId:'km2oo0mCahDBKPOa6',status:'SUCCEEDED',costUsd:0.06,startedAt:start,importedAt:start});
  const gate=evaluateApifyBudget(ledger,{now,actorId:APIFY_AVITO_ACTOR_ID});
  assert.equal(gate.budget.runsUsed,1);assert.equal(gate.budget.spentUsd,0.279);
  assert.equal(gate.budget.runsRemaining,9);
});
