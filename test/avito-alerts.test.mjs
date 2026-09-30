import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendAvitoAlerts } from '../scripts/avito-alerts.mjs';
import { writeAvitoJson } from '../scripts/avito-storage.mjs';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk';
const env = { AVITO_ALERT_BOT_TOKEN: TOKEN, AVITO_ALERT_CHAT_ID: '987654321' };
const offer = (id = 1234567890, extra = {}) => ({
  dedupKey: `avito:${id}:8000000`, listingId: `avito:${id}`, title: 'MacBook Air M4 16/256 Silver',
  condition: 'used', marketplaceSellerType: 'private', comparisonKind: 'used-asking-price-spread', peerCount: 3, sellerName: 'Продавец', price: 80_000, referencePrice: 100_000,
  estimatedDeltaRub: 17_000, deltaPercent: 17, costReserveRub: 3_000,
  url: `https://www.avito.ru/nizhniy_novgorod/noutbuki/macbook_${id}?tracking=1`,
  observedAt: new Date(NOW).toISOString(), alertEligible: true, ...extra,
});
const opportunities = candidates => ({ candidates, thresholds: { costReserveRub: 3000, maxAgeHours: 4 } });
const response = (body = { ok: true, result: { message_id: 1 } }, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: new Headers() });
const temp = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'avito-alerts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const ledger = async dir => JSON.parse(await readFile(join(dir, 'alerts.json'), 'utf8'));

test('Russian procurement signals identify the new-device baseline and reject mismatched or stale quotes',async t=>{
  const dir=await temp(t);let text,calls=0;
  const procurement={retailer:'BSA',price:100000,condition:'new',observedAt:new Date(NOW).toISOString()};
  const candidate=offer(undefined,{comparisonKind:'russian-procurement-gap',peerCount:0,matchKind:'same_color',procurement});
  const result=await sendAvitoAlerts({env,dir,now:()=>NOW,opportunities:opportunities([candidate]),fetchImpl:async(url,options)=>{
    calls++;text=JSON.parse(options.body).text;return response();
  }});
  assert.equal(result.sentCount,1);assert.match(text,/Русский закуп нового MacBook · BSA/);assert.match(text,/не прибыль/);
  for(const extra of [{matchKind:'other_color'},{procurement:{...procurement,retailer:'BigGeek'}},
    {procurement:{...procurement,price:99999}},{procurement:{...procurement,observedAt:new Date(NOW-73*3600000).toISOString()}}]) {
    await sendAvitoAlerts({env,dir,now:()=>NOW,opportunities:opportunities([offer(1234567891,{...candidate,...extra,dedupKey:'avito:1234567891:8000000'})]),fetchImpl:async()=>{calls++;return response();}});
  }
  assert.equal(calls,1);
});

test('only the dedicated bot and explicit recipient enable alerts; business credentials are never reused', async t => {
  const dir = await temp(t);
  let calls = 0;
  for (const values of [{}, { TELEGRAM_BUSINESS_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '987654321' }, { AVITO_ALERT_BOT_TOKEN: TOKEN }, { AVITO_ALERT_CHAT_ID: '987654321' }]) {
    const state = await sendAvitoAlerts({ env: values, dir, opportunities: opportunities([offer()]), fetchImpl: async () => { calls++; } });
    assert.equal(state.enabled, false);
    assert.equal(state.channel, 'site');
    assert.equal(state.sentCount, 0);
    assert.deepEqual(Object.keys(state).sort(), ['channel', 'enabled', 'lastSentAt', 'message', 'sentCount']);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'alerts-state.json'), 'utf8')), state);
  }
  for (const chat of ['auto', 'https://t.me/example', 'name_without_at', '@a', '0', '1.5', '9007199254740992', '1\n2']) {
    const state = await sendAvitoAlerts({ env: { ...env, AVITO_ALERT_CHAT_ID: chat }, dir, fetchImpl: async () => { calls++; } });
    assert.equal(state.enabled, false);
    assert.equal(state.channel, 'telegram');
  }
  const invalid = await sendAvitoAlerts({ env: { ...env, AVITO_ALERT_BOT_TOKEN: `${TOKEN}/other` }, dir, fetchImpl: async () => { calls++; } });
  assert.equal(invalid.enabled, false);
  assert.equal(calls, 0);
});

test('persists intent before POST, sends plain Russian text, keeps secrets private, and deduplicates listing and price', async t => {
  const dir = await temp(t), sent = [];
  const first = offer(1234567890, { title: '<b>MacBook</b>\nдругая строка' });
  const used = offer(1234567891, { condition: 'used' });
  const run = async candidates => sendAvitoAlerts({ env: { ...env, AVITO_ALERT_CHAT_ID: '@avito_alerts' }, dir, now: NOW, opportunities: opportunities(candidates), fetchImpl: async (url, options) => {
    assert.equal(url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(options.body);
    const saved = await ledger(dir);
    assert.equal(Object.values(saved.entries).filter(entry => entry.status === 'pending').length, 1);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(body.chat_id, '@avito_alerts');
    assert.equal(body.parse_mode, undefined);
    assert.equal(body.allow_paid_broadcast, false);
    assert.deepEqual(body.link_preview_options, { is_disabled: true });
    assert.ok(body.text.length <= 4096);
    sent.push(body.text);
    return response();
  } });
  const result = await run([first, first, used, offer(1234567892, { alertEligible: false })]);
  assert.equal(result.sentCount, 2);
  assert.equal(result.lastSentAt, new Date(NOW).toISOString());
  assert.match(sent[0], /<b>MacBook<\/b> другая строка/);
  assert.match(sent[0], /Минимальная цена сопоставимых б\/у/);
  assert.match(sent[0], /Разница после резерва/);
  assert.match(sent[0], /dev\.macbookbro\.ru\/web\/avito\.html/);
  assert.doesNotMatch(sent[0], /tracking=/);
  assert.match(sent[1], /Б\/у · частный продавец/);
  assert.match(sent[1], /цены объявлений, а не состоявшихся сделок/);
  assert.equal((await run([first, used])).sentCount, 0);
  assert.equal((await run([offer(1234567890, { price: 79_000, dedupKey: 'avito:1234567890:7900000' })])).sentCount, 1);
  const saved = await readFile(join(dir, 'alerts.json'), 'utf8');
  assert.equal(saved.includes(TOKEN), false);
  assert.equal(saved.includes('@avito_alerts'), false);
  assert.equal(JSON.stringify(result).includes('987654321'), false);
  assert.equal((await stat(join(dir, 'alerts.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, 'alerts-state.json'))).mode & 0o777, 0o600);
});

test('at most five signals are sent per invocation and the next invocation resumes without repeats', async t => {
  const dir = await temp(t), candidates = Array.from({ length: 8 }, (_, i) => offer(1234567800 + i));
  let calls = 0;
  const run = () => sendAvitoAlerts({ env, dir, now: NOW, opportunities: opportunities(candidates), fetchImpl: async () => { calls++; return response(); } });
  assert.equal((await run()).sentCount, 5);
  assert.equal(calls, 5);
  assert.equal((await run()).sentCount, 3);
  assert.equal(calls, 8);
  assert.equal((await run()).sentCount, 0);
});

test('a network failure is recorded as unknown and never replayed even when the provider may have delivered it', async t => {
  const dir = await temp(t), first = offer(), next = offer(1234567891);
  const failed = await sendAvitoAlerts({ env, dir, now: NOW, opportunities: opportunities([first, next]), fetchImpl: async () => {
    throw new Error(`Request to https://api.telegram.org/bot${TOKEN}/sendMessage failed for ${env.AVITO_ALERT_CHAT_ID}`);
  } });
  assert.equal(failed.sentCount, 0);
  assert.match(failed.message, /доставка последнего сигнала неизвестна/);
  assert.equal((await ledger(dir)).entries[first.dedupKey].status, 'unknown');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'alerts-state.json'), 'utf8')), failed);
  let calls = 0;
  const retry = await sendAvitoAlerts({ env, dir, now: NOW + 60_000, opportunities: opportunities([first, next]), fetchImpl: async () => { calls++; return response(); } });
  assert.equal(calls, 1);
  assert.equal(retry.sentCount, 1);
  assert.match(retry.message, /неподтверждённой доставкой/);
  const contents = await readFile(join(dir, 'alerts.json'), 'utf8');
  assert.equal(contents.includes(TOKEN), false);
  assert.equal(contents.includes(env.AVITO_ALERT_CHAT_ID), false);
});

test('an interrupted pending send is uncertain rather than retried, and malformed server responses are also uncertain', async t => {
  const dir = await temp(t), first = offer(), next = offer(1234567891);
  await writeAvitoJson(join(dir, 'alerts.json'), { schemaVersion: 1, entries: { [first.dedupKey]: { status: 'pending', attemptedAt: new Date(NOW).toISOString() } } });
  let calls = 0;
  const result = await sendAvitoAlerts({ env, dir, now: NOW, opportunities: opportunities([first, next]), fetchImpl: async () => {
    calls++; return { ok: false, status: 502, json: async () => { throw new Error('bad JSON'); } };
  } });
  assert.equal(calls, 1);
  assert.equal(result.sentCount, 0);
  const saved = await ledger(dir);
  assert.equal(saved.entries[first.dedupKey].status, 'unknown');
  assert.equal(saved.entries[next.dedupKey].status, 'unknown');
});

test('Telegram 429 is persisted and retried only after the requested delay, without looping in the same run', async t => {
  const dir = await temp(t), candidates = opportunities([offer()]);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls === 1 ? response({ ok: false, error_code: 429, parameters: { retry_after: 120 } }, 429) : response();
  };
  const run = now => sendAvitoAlerts({ env, dir, now, opportunities: candidates, fetchImpl });
  assert.equal((await run(NOW)).sentCount, 0);
  assert.equal(calls, 1);
  assert.equal((await ledger(dir)).retryAfter, new Date(NOW + 120_000).toISOString());
  assert.equal((await run(NOW + 60_000)).sentCount, 0);
  assert.equal(calls, 1);
  assert.equal((await run(NOW + 120_000)).sentCount, 1);
  assert.equal(calls, 2);
  assert.equal((await ledger(dir)).entries[offer().dedupKey].status, 'sent');
});

test('permanent refusal stops all sends until configuration changes; service error text is never persisted', async t => {
  const dir = await temp(t), candidates = opportunities([offer(), offer(1234567891)]);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls === 1 ? response({ ok: false, error_code: 403, description: `Secret ${TOKEN}` }, 403) : response();
  };
  const run = values => sendAvitoAlerts({ env: values, dir, now: NOW, opportunities: candidates, fetchImpl });
  assert.equal((await run(env)).enabled, false);
  assert.equal((await run(env)).enabled, false);
  assert.equal(calls, 1);
  assert.equal((await run({ ...env, AVITO_ALERT_CHAT_ID: '-100987654321' })).sentCount, 2);
  assert.equal(calls, 3);
  assert.equal((await readFile(join(dir, 'alerts.json'), 'utf8')).includes(TOKEN), false);
});

test('corrupt deduplication data fails closed instead of sending the same alerts again', async t => {
  const dir = await temp(t);
  await writeFile(join(dir, 'alerts.json'), '{broken', { mode: 0o600 });
  let calls = 0;
  const state = await sendAvitoAlerts({ env, dir, now: NOW, opportunities: opportunities([offer()]), fetchImpl: async () => { calls++; return response(); } });
  assert.equal(state.enabled, false);
  assert.equal(calls, 0);
  assert.equal(await readFile(join(dir, 'alerts.json'), 'utf8'), '{broken');
});

test('concurrent invocations cannot send the same alert twice', async t => {
  const dir = await temp(t), candidates = opportunities([offer()]);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const options = { env, dir, now: NOW, opportunities: candidates, fetchImpl: async () => { calls++; entered(); await wait; return response(); } };
  const first = sendAvitoAlerts(options);
  await started;
  const second = await sendAvitoAlerts(options);
  assert.equal(second.sentCount, 0);
  assert.match(second.message, /другой запуск/);
  release();
  assert.equal((await first).sentCount, 1);
  assert.equal(calls, 1);
});

test('stale, incomplete, unsafe-link and non-eligible candidates never generate a message', async t => {
  const dir = await temp(t);
  const candidates = [offer(1234567890, { observedAt: new Date(NOW - 5 * 3_600_000).toISOString() }),
    offer(1234567891, { url: 'https://avito.ru.evil.test/noutbuki/macbook_1234567891' }),
    offer(1234567892, { alertEligible: false }), offer(1234567893, { condition: 'unknown' }),
    offer(1234567894, { estimatedDeltaRub: null }), offer(1234567895, { price: 0 }),
    offer(1234567896, { dedupKey: '__proto__' }), offer(1234567897, {condition: 'new'}),
    offer(1234567898, {marketplaceSellerType: 'company'}), offer(1234567899, {peerCount: 2})];
  let calls = 0;
  const state = await sendAvitoAlerts({ env, dir, now: NOW, opportunities: opportunities(candidates), fetchImpl: async () => { calls++; return response(); } });
  assert.equal(state.sentCount, 0);
  assert.equal(calls, 0);
});

test('source-verified retirement of an excluded legacy signal keeps deduplication and does not hide current uncertain delivery', async t => {
  const dir=await temp(t),first=offer(),next=offer(1234567891);
  await writeAvitoJson(join(dir,'alerts.json'),{schemaVersion:1,entries:{[first.dedupKey]:{status:'unknown',resolution:{kind:'excluded_by_current_policy',at:new Date(NOW).toISOString()}}}});
  let calls=0;
  const run=candidates=>sendAvitoAlerts({env,dir,now:NOW,opportunities:opportunities(candidates),fetchImpl:async()=>{calls++;return response();}});
  const retired=await run([first]);
  assert.equal(calls,0);assert.doesNotMatch(retired.message,/неподтверждённой доставкой/);
  const history=await ledger(dir);history.entries[next.dedupKey]={status:'unknown'};
  await writeAvitoJson(join(dir,'alerts.json'),history);
  const unresolved=await run([first,next]);
  assert.equal(calls,0);assert.match(unresolved.message,/неподтверждённой доставкой/);
  assert.equal((await ledger(dir)).entries[first.dedupKey].status,'unknown');
  assert.equal((await run([offer(1234567892)])).sentCount,1);assert.equal(calls,1);
});
