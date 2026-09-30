import { chmod, link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { writeAvitoJson } from './avito-storage.mjs';

export const APIFY_AVITO_ACTOR_ID = '4SsKYeXxLtIJLtzHp';
export const APIFY_AVITO_SEARCH_URL = 'https://www.avito.ru/nizhniy_novgorod/noutbuki?q=macbook&s=104';
const API = 'https://api.apify.com/v2';
const HOUR = 3_600_000;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const RUNNING = new Set(['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING']);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const at = value => typeof value === 'string' ? Date.parse(value) : NaN;
const usd = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) throw safeError('CONFIG', 'Apify: некорректный денежный лимит');
  return Math.ceil((value - Number.EPSILON) * 1_000_000);
};
const dollars = value => value / 1_000_000;
const safeError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

function validateLedger(ledger) {
  if (!ledger || ledger.schemaVersion !== 1 || !Array.isArray(ledger.entries)) throw safeError('LEDGER', 'Apify: журнал бюджета отсутствует или повреждён; нужен проверенный начальный расход');
  const ids = new Set();
  for (const entry of ledger.entries) {
    if (!entry || typeof entry !== 'object' || ![...RUNNING, ...TERMINAL, 'POSTING', 'POST_UNKNOWN'].includes(entry.status))
      throw safeError('LEDGER', 'Apify: повреждена запись журнала бюджета');
    if ((RUNNING.has(entry.status) || TERMINAL.has(entry.status)) && !validId(entry.runId))
      throw safeError('LEDGER', 'Apify: в журнале отсутствует ID уже запущенного сбора');
    if (entry.runId) {
      if (!validId(entry.runId) || ids.has(entry.runId)) throw safeError('LEDGER', 'Apify: некорректный или повторный ID запуска в журнале');
      ids.add(entry.runId);
    }
    if (entry.costUsd != null) usd(entry.costUsd);
    if (entry.reservationUsd != null) usd(entry.reservationUsd);
    if (entry.costUsd == null && entry.reservationUsd == null) throw safeError('LEDGER', 'Apify: у запуска нет учтённой стоимости или резерва');
  }
}

/** Pure, conservative budget gate. Unknown charges continue to consume their reservation. */
export function evaluateApifyBudget(ledger, {
  now = Date.now(), limitUsd = ledger?.limitUsd ?? 5, maxRunUsd = 0.40, runLimit = 10,
  periodStartedAt = ledger?.periodStartedAt, periodEndsAt = ledger?.periodEndsAt,
} = {}) {
  validateLedger(ledger);
  now = Number(now);
  const start = at(periodStartedAt), end = at(periodEndsAt);
  if (!Number.isFinite(now) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 7 * 24 * HOUR)
    throw safeError('CONFIG', 'Apify: нужен явно заданный период не длиннее семи дней');
  const limit = usd(limitUsd), perRun = usd(maxRunUsd);
  if (limit <= 0 || limit > 5_000_000 || perRun <= 0 || perRun > 400_000 || perRun > limit
    || !Number.isInteger(runLimit) || runLimit < 1 || runLimit > 10) throw safeError('CONFIG', 'Apify: лимиты превышают согласованные $5, $0.40 на запуск или 10 запусков');
  let spent = 0, reserved = 0;
  for (const entry of ledger.entries) {
    const cost = entry.costUsd == null ? null : usd(entry.costUsd);
    const reservation = entry.reservationUsd == null ? 0 : usd(entry.reservationUsd);
    const charge = TERMINAL.has(entry.status) && cost !== null && entry.costSettled !== false ? cost : Math.max(cost || 0, reservation);
    spent += charge;
    if (cost === null || entry.costSettled === false || !TERMINAL.has(entry.status)) reserved += Math.max(0, charge - (cost || 0));
  }
  const latest = Math.max(start - HOUR, ...ledger.entries.map(entry => at(entry.requestedAt || entry.startedAt)).filter(Number.isFinite));
  const next = Math.max(start, latest + HOUR);
  const scheduledNext = Math.ceil(Math.max(next, now) / HOUR) * HOUR;
  const unknown = ledger.entries.some(entry => !entry.runId && ['POSTING', 'POST_UNKNOWN'].includes(entry.status));
  const pending = ledger.entries.some(entry => entry.runId && (RUNNING.has(entry.status) || (entry.status === 'SUCCEEDED' && !entry.importedAt)));
  let reason = null;
  if (ledger.halted || unknown) reason = 'needs_reconciliation';
  else if (now >= end) reason = 'period_ended';
  else if (now < start) reason = 'period_not_started';
  else if (ledger.entries.length >= runLimit) reason = 'run_limit';
  else if (spent + perRun > limit) reason = 'budget_limit';
  else if (pending) reason = 'run_pending';
  else if (now < next) reason = 'hourly_wait';
  return {
    allowed: reason === null, reason, maxRunUsd: dollars(perRun),
    nextRunAt: ['period_ended', 'run_limit', 'budget_limit', 'needs_reconciliation'].includes(reason) || scheduledNext >= end ? null : new Date(scheduledNext).toISOString(),
    budget: { limitUsd: dollars(limit), spentUsd: dollars(spent), reservedUsd: dollars(reserved),
      remainingUsd: dollars(Math.max(0, limit - spent)), periodStartedAt, periodEndsAt,
      runLimit, runsUsed: ledger.entries.length, runsRemaining: Math.max(0, runLimit - ledger.entries.length) },
  };
}

function configuration(env, ledger) {
  const number = (name, fallback) => env[name] == null || env[name] === '' ? fallback : Number(env[name]);
  const periodStartedAt = env.AVITO_APIFY_PERIOD_START || ledger.periodStartedAt;
  const periodEndsAt = env.AVITO_APIFY_PERIOD_END || ledger.periodEndsAt;
  // Moving a period must never silently reset the ledger or resurrect a budget.
  if (at(periodStartedAt) !== at(ledger.periodStartedAt) || at(periodEndsAt) !== at(ledger.periodEndsAt))
    throw safeError('CONFIG', 'Apify: период окружения не совпадает с сохранённым журналом бюджета');
  const limitUsd = Math.min(number('AVITO_APIFY_BUDGET_USD', 5), ledger.limitUsd ?? 5);
  const maxResults = number('AVITO_APIFY_MAX_RESULTS', 45);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 3000) throw safeError('CONFIG', 'Apify: число результатов должно быть от 1 до 3000');
  return { periodStartedAt, periodEndsAt, limitUsd, maxResults,
    maxRunUsd: number('AVITO_APIFY_MAX_RUN_USD', 0.40), runLimit: number('AVITO_APIFY_RUN_LIMIT', 10) };
}

// fsync the reservation before allowing the paid POST to leave this process.
async function saveLedger(path, ledger) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(ledger)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
  finally { await directory.close(); }
}

async function readLedger(path) {
  try { const ledger = JSON.parse(await readFile(path, 'utf8')); validateLedger(ledger); await chmod(path, 0o600); return ledger; }
  catch { throw safeError('LEDGER', 'Apify: журнал бюджета отсутствует или повреждён; новые платные запуски остановлены'); }
}

async function acquireLock(path) {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw safeError('LOCK', 'Apify: не удалось создать блокировку сборщика');
      let prior, original;
      try { original = await stat(path); prior = JSON.parse(await readFile(path, 'utf8')); }
      catch { throw safeError('LOCK', 'Apify: блокировка требует ручной проверки'); }
      if (!Number.isInteger(prior.pid) || prior.pid <= 0) throw safeError('LOCK', 'Apify: блокировка требует ручной проверки');
      let dead = false;
      try { process.kill(prior.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
      if (!dead) throw safeError('LOCK', 'Apify: другой сбор уже выполняется');
      // Only one contender may reap an abandoned lock. An atomic hard-link
      // claim prevents another stale reader from deleting a new owner's lock.
      const claim = `${path}.reap`;
      try { await link(path, claim); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw safeError('LOCK', 'Apify: восстановление блокировки уже выполняется или требует проверки');
      }
      try {
        const current = await stat(path).catch(() => null);
        if (current && current.ino === original.ino) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      } finally { await unlink(claim).catch(() => {}); }
      continue;
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); }
    finally { await handle.close(); }
    return async () => {
      const current = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
      if (current?.token === token) await unlink(path).catch(() => {});
    };
  }
  throw safeError('LOCK', 'Apify: не удалось получить блокировку сборщика');
}

async function apiJson(path, { token, fetchImpl, method = 'GET', body, timeoutMs = 40_000 } = {}) {
  let response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { throw safeError('API_NETWORK', 'Apify: запрос не подтверждён; повторный платный запуск не выполнен'); }
  if (!response.ok) throw safeError('API_HTTP', `Apify: API вернул HTTP ${Number(response.status) || 0}`, { httpStatus: Number(response.status) || 0 });
  let json;
  try { json = await response.json(); } catch { throw safeError('API_RESPONSE', 'Apify: API вернул некорректный ответ'); }
  return { json, headers: response.headers };
}

function checkedRun(json, expectedId) {
  const run = json?.data;
  if (!run || !validId(run.id) || (expectedId && run.id !== expectedId)
    || (run.actId && run.actId !== APIFY_AVITO_ACTOR_ID) || ![...RUNNING, ...TERMINAL].includes(run.status))
    throw safeError('API_RESPONSE', 'Apify: не удалось подтвердить ID, Actor или статус запуска');
  return run;
}

/** Read all dataset pages, including error rows; never label a truncated result complete. */
export async function fetchApifyDataset(datasetId, { token, fetchImpl = fetch, pageSize = 1000, maxItems = 3000 } = {}) {
  if (!validId(datasetId) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 3000)
    throw safeError('DATASET', 'Apify: некорректные параметры выгрузки');
  const records = [], signatures = new Set();
  let total = null;
  const headerNumber = (headers, name) => {
    const value = headers?.get(name);
    if (value == null) return null;
    if (!/^\d+$/.test(value)) throw safeError('DATASET', 'Apify: некорректные данные пагинации');
    return Number(value);
  };
  for (;;) {
    const limit = Math.min(pageSize, maxItems - records.length + 1);
    const { json: page, headers } = await apiJson(`/datasets/${datasetId}/items?format=json&clean=false&offset=${records.length}&limit=${limit}`, { token, fetchImpl });
    if (!Array.isArray(page) || page.length > limit) throw safeError('DATASET', 'Apify: некорректная страница выгрузки');
    const foundTotal = headerNumber(headers, 'x-apify-pagination-total');
    const foundOffset = headerNumber(headers, 'x-apify-pagination-offset');
    const foundCount = headerNumber(headers, 'x-apify-pagination-count');
    if ((foundOffset !== null && foundOffset !== records.length) || (foundCount !== null && foundCount !== page.length)
      || (total !== null && foundTotal !== null && foundTotal !== total)) throw safeError('DATASET', 'Apify: страницы выгрузки противоречат друг другу');
    total ??= foundTotal;
    if ((total !== null && total > maxItems) || records.length + page.length > maxItems) throw safeError('DATASET', 'Apify: выгрузка превышает 3000 карточек; требуется ручная проверка');
    if (page.length) {
      const signature = createHash('sha256').update(JSON.stringify(page)).digest('hex');
      if (signatures.has(signature)) throw safeError('DATASET', 'Apify: повторилась страница выгрузки');
      signatures.add(signature);
      records.push(...page);
    }
    if (total !== null) {
      if (records.length === total) return records;
      if (records.length > total || !page.length) throw safeError('DATASET', 'Apify: выгрузка не соответствует заявленному количеству карточек');
    } else if (page.length < limit) return records;
  }
}

const gateMessage = reason => ({
  needs_reconciliation: 'Новые запуски остановлены: требуется сверить последний запуск и расходы в Apify',
  period_ended: 'Согласованная неделя завершена; платные запуски остановлены',
  period_not_started: 'Ожидаем начала согласованного периода',
  run_limit: 'Достигнут предел 10 запусков бесплатного Actor; новые запуски остановлены',
  budget_limit: 'Остатка бюджета недостаточно для полного резерва следующего запуска',
  run_pending: 'Продолжается ранее оплаченный запуск Apify',
  hourly_wait: 'Результат сохранён; следующее обновление не чаще чем через час после предыдущего запуска',
}[reason] || 'Сбор готов к следующему запуску');

export async function runApifyWorker({
  env = process.env, root = process.cwd(), fetchImpl = fetch, now = () => Date.now(),
  sleep = delay, maxPolls = 7, importRun, onImported,
} = {}) {
  root = resolve(root);
  const dir = resolve(root, env.AVITO_DATA_DIR || 'data/private/avito');
  const statePath = resolve(dir, 'apify-state.json'), ledgerPath = resolve(dir, 'apify-ledger.json');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const time = () => Number(typeof now === 'function' ? now() : now);
  let release, ledger, config, counts = {}, gate, startedAt, updatedAt;
  const state = async (name, message, extra = {}) => {
    if (ledger && config) gate = evaluateApifyBudget(ledger, { ...config, now: time() });
    const enabled = Boolean(gate && !['period_ended', 'run_limit', 'budget_limit', 'needs_reconciliation'].includes(gate.reason));
    const result = { state: name, transport: 'apify', message, statusCheckedAt: new Date(time()).toISOString(),
      ...(updatedAt ? { updatedAt } : {}),
      ...(startedAt ? { startedAt } : {}), counts,
      ...(gate ? { budget: gate.budget, nextRunAt: enabled ? gate.nextRunAt : null } : {}),
      schedule: { enabled, intervalMinutes: 60 }, ...extra };
    await writeAvitoJson(statePath, result);
    return result;
  };
  try {
    release = await acquireLock(resolve(dir, 'apify-worker.lock'));
    const prior = await readFile(statePath, 'utf8').then(JSON.parse).catch(() => ({}));
    if (prior.counts && typeof prior.counts === 'object') counts = Object.fromEntries(Object.entries(prior.counts).filter(([, value]) => Number.isFinite(value)));
    if (Number.isFinite(at(prior.updatedAt))) updatedAt = prior.updatedAt;
    ledger = await readLedger(ledgerPath);
    config = configuration(env, ledger);
    gate = evaluateApifyBudget(ledger, { ...config, now: time() });
    const lastImported = ledger.entries.filter(entry => entry.importedAt).sort((a, b) => at(a.importedAt) - at(b.importedAt)).at(-1);
    updatedAt ||= lastImported?.importedAt;
    if (!Object.keys(counts).length && lastImported?.counts) counts = Object.fromEntries(Object.entries(lastImported.counts).filter(([, value]) => Number.isFinite(value)));
    if (!env.APIFY_TOKEN) return state('not_configured', 'Apify: токен API не настроен', { schedule: { enabled: false, intervalMinutes: 60 }, nextRunAt: null });
    if (gate.reason === 'needs_reconciliation') return state('needs_attention', gateMessage(gate.reason));
    const token = String(env.APIFY_TOKEN);
    const getRun = async id => checkedRun((await apiJson(`/actor-runs/${id}?waitForFinish=30`, { token, fetchImpl })).json, id);
    const persistRun = async (entry, run, settled = false) => {
      Object.assign(entry, { runId: run.id, status: run.status, startedAt: run.startedAt || entry.startedAt,
        ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
        ...(run.defaultDatasetId ? { datasetId: run.defaultDatasetId } : {}) });
      if (TERMINAL.has(run.status) && typeof run.usageTotalUsd === 'number' && Number.isFinite(run.usageTotalUsd) && run.usageTotalUsd >= 0) {
        entry.costUsd = dollars(usd(run.usageTotalUsd)); entry.costSettled = settled;
      }
      await saveLedger(ledgerPath, ledger);
    };
    const finish = async (entry, initialRun) => {
      let run = initialRun;
      for (let poll = 0; poll < maxPolls && (!run || !TERMINAL.has(run.status)); poll++) {
        run = await getRun(entry.runId);
        await persistRun(entry, run);
        if (!TERMINAL.has(run.status)) await state('running', 'Apify собирает объявления; новый оплачиваемый запуск не создаётся');
      }
      if (!run || !TERMINAL.has(run.status)) return false;
      // Apify documents costs in the first terminal response as preliminary.
      const elapsed = time() - at(run.finishedAt);
      if (!Number.isFinite(elapsed) || elapsed < 10_000) {
        await sleep(Number.isFinite(elapsed) ? Math.max(0, 10_000 - elapsed) : 10_000);
        run = await getRun(entry.runId);
        if (!TERMINAL.has(run.status)) throw safeError('API_RESPONSE', 'Apify: завершение запуска не подтверждено повторной проверкой');
      }
      await persistRun(entry, run, true);
      if (entry.costUsd != null && entry.reservationUsd != null && usd(entry.costUsd) > usd(entry.reservationUsd)) {
        ledger.halted = { code: 'CHARGE_EXCEEDED', at: new Date(time()).toISOString() };
        await saveLedger(ledgerPath, ledger);
      }
      if (run.status !== 'SUCCEEDED') {
        ledger.halted = { code: 'RUN_FAILED', at: new Date(time()).toISOString(), runId: run.id };
        await saveLedger(ledgerPath, ledger);
        throw safeError('RUN_FAILED', `Apify: запуск завершился со статусом ${run.status}; новые платные запуски остановлены`);
      }
      if (entry.importedAt) return true;
      const records = await fetchApifyDataset(run.defaultDatasetId, { token, fetchImpl });
      await writeAvitoJson(resolve(dir, 'apify-runs', `${run.id}.json`), records);
      await writeAvitoJson(resolve(dir, 'apify-runs', `${run.id}-run.json`), run);
      const importer = importRun || (await import('./avito-apify-import.mjs')).importApifyRun;
      let result;
      try { result = await importer({ records, run, root, dir }); }
      catch { throw safeError('IMPORT', 'Apify: результат сохранён, но импорт не завершён; новый платный запуск не выполняется'); }
      counts = { received: records.length, ...Object.fromEntries(Object.entries(result?.counts || {}).filter(([, value]) => Number.isFinite(value))) };
      entry.importedAt = new Date(time()).toISOString();
      updatedAt = entry.importedAt;
      entry.counts = counts;
      await saveLedger(ledgerPath, ledger);
      if (onImported) {
        try { await onImported({ root, dir, run, result, env }); }
        catch { throw safeError('NOTIFICATION', 'Данные Apify импортированы; отправку уведомления нужно проверить'); }
      }
      return true;
    };
    const pending = ledger.entries.filter(entry => entry.runId && (RUNNING.has(entry.status)
      || (TERMINAL.has(entry.status) && (entry.costSettled === false || entry.costUsd == null))
      || (entry.status === 'SUCCEEDED' && !entry.importedAt)));
    for (const entry of pending) {
      startedAt = entry.startedAt;
      if (!await finish(entry)) return state('running', 'Ранее запущенный сбор ещё выполняется; продолжим проверку без нового платного запуска');
    }
    gate = evaluateApifyBudget(ledger, { ...config, now: time() });
    if (!gate.allowed) return state(['run_limit', 'budget_limit', 'period_ended'].includes(gate.reason) ? 'paused' : 'partial', gateMessage(gate.reason));
    startedAt = new Date(time()).toISOString();
    const entry = { attemptId: randomUUID(), status: 'POSTING', startedAt, requestedAt: startedAt, reservationUsd: config.maxRunUsd };
    ledger.entries.push(entry);
    await saveLedger(ledgerPath, ledger);
    await state('running', 'Бюджет зарезервирован; запускаем сбор Apify');
    let run;
    try {
      const response = await apiJson(`/acts/${APIFY_AVITO_ACTOR_ID}/runs?maxTotalChargeUsd=${config.maxRunUsd}&waitForFinish=0&timeout=180&restartOnError=false`, {
        token, fetchImpl, method: 'POST', body: {
          searchUrl: APIFY_AVITO_SEARCH_URL, sort: 'newest', query: 'MacBook', location: 'Нижний Новгород', category: 'laptops',
          maxResults: config.maxResults, includeDetails: true, includePhone: false, includeReviews: false, includeComparables: false,
        },
      });
      // Even a malformed status with an ID is resumable; persist that ID first.
      if (validId(response.json?.data?.id)) { entry.runId = response.json.data.id; entry.status = 'RUNNING'; await saveLedger(ledgerPath, ledger); }
      run = checkedRun(response.json, entry.runId);
      await persistRun(entry, run);
    } catch (error) {
      if (!entry.runId) {
        entry.status = 'POST_UNKNOWN';
        // Even explicit errors halt retries. A status alone is not proof that
        // a run and its charge were never created upstream.
        ledger.halted = { code: 'POST_UNKNOWN', at: new Date(time()).toISOString() };
        await saveLedger(ledgerPath, ledger);
      }
      throw safeError('POST_UNKNOWN', 'Apify: запуск не подтверждён. Расход зарезервирован; перед новым запуском нужна сверка в Apify');
    }
    if (!await finish(entry, run)) return state('running', 'Сбор Apify продолжается; новый платный запуск не создаётся');
    gate = evaluateApifyBudget(ledger, { ...config, now: time() });
    const finalState = gate.reason === 'needs_reconciliation' ? 'needs_attention'
      : ['run_limit', 'budget_limit', 'period_ended'].includes(gate.reason) ? 'paused' : 'partial';
    return state(finalState,
      gate.reason === 'needs_reconciliation' ? gateMessage(gate.reason) : `Выгрузка Apify импортирована. ${gateMessage(gate.reason)}`);
  } catch (error) {
    if (error.code === 'LOCK') return { state: 'locked', transport: 'apify', message: error.message };
    const safeCodes = ['CONFIG', 'LEDGER', 'API_NETWORK', 'API_HTTP', 'API_RESPONSE', 'DATASET', 'RUN_FAILED', 'IMPORT', 'NOTIFICATION', 'POST_UNKNOWN'];
    const message = safeCodes.includes(error.code) ? error.message : 'Apify: локальная ошибка; платный повторный запуск не выполнен';
    // Invalid configuration must not cause a second exception while publishing
    // the safe state, and no provider response or credential is echoed.
    if (['CONFIG', 'LEDGER'].includes(error.code)) config = null;
    return state(['POST_UNKNOWN', 'RUN_FAILED'].includes(error.code) ? 'needs_attention' : 'error', message,
      { ...(config ? {} : { schedule: { enabled: false, intervalMinutes: 60 }, nextRunAt: null }) });
  } finally { await release?.(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runApifyWorker().then(result => {
    console.log(JSON.stringify(result));
    if (['error', 'needs_attention'].includes(result.state)) process.exitCode = 1;
  }).catch(() => { console.error('Apify: сборщик не завершился; проверьте локальное состояние'); process.exitCode = 1; });
}
