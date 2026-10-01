import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { avitoUrl } from './avito-policy.mjs';
import { writeAvitoJson } from './avito-storage.mjs';
import { googleRelayUrl, sendGoogleRelay } from './avito-google-relay.mjs';
import { isIphone } from './iphone.mjs';
import { canonicalStorageGb, known, normalize } from './domain.mjs';

const MAX_ALERTS = 5;
const SITE_URL = 'https://dev.macbookbro.ru/web/avito.html';
const publicWrites = new Map();
const amount = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const rubles = value => `${amount.format(value)} ₽`;
const oneLine = (value, max) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const atMoscow = value => new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' МСК';

function publicState({ enabled = false, channel = 'site', lastSentAt = null, message, sentCount = 0 }) {
  return { enabled, channel, lastSentAt, message, sentCount };
}

function validChat(value) {
  if (/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)) return true;
  return /^-?[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
}

function formatCandidate(candidate, opportunities, now) {
  const procurement = candidate?.comparisonKind === 'russian-procurement-gap'
    && candidate.matchKind === 'same_color' && candidate.procurement?.condition === 'new'
    && ['Дима','BSA'].includes(candidate.procurement?.retailer)
    && candidate.procurement.price === candidate.referencePrice
    && Number.isFinite(Date.parse(candidate.procurement.observedAt))
    && Date.parse(candidate.procurement.observedAt) <= now + 60_000
    && now - Date.parse(candidate.procurement.observedAt) <= 72*3_600_000;
  const peers = candidate?.comparisonKind === 'used-asking-price-spread' && Number.isInteger(candidate.peerCount) && candidate.peerCount >= 3;
  if (isIphone(candidate)) {
    const fields = ['model', 'storageGb', 'color', 'simType', 'region'];
    const value = (offer, field) => field === 'storageGb' ? canonicalStorageGb(offer[field]) : offer[field];
    const samePhone = other => other && fields.every(field => known(value(candidate, field)) && known(value(other, field)) && normalize(value(candidate, field)) === normalize(value(other, field)));
    if (procurement ? !samePhone(candidate.procurement) : !peers || !Array.isArray(candidate.evidence) || candidate.evidence.length < 3 || !candidate.evidence.every(samePhone)) return null;
  }
  if (!candidate || candidate.alertEligible !== true || candidate.condition !== 'used'
    || candidate.marketplaceSellerType !== 'private' || (!procurement && !peers)
    || typeof candidate.dedupKey !== 'string' || !/^avito:\d+:\d+$/.test(candidate.dedupKey)
    || candidate.dedupKey.length > 150 || !positive(candidate.price) || !positive(candidate.referencePrice)) return null;
  const delta = candidate.estimatedDeltaRub ?? candidate.deltaRub;
  const reserve = candidate.costReserveRub ?? opportunities?.thresholds?.costReserveRub ?? opportunities?.threshold?.costReserveRub;
  if (!positive(delta) || typeof reserve !== 'number' || !Number.isFinite(reserve) || reserve < 0) return null;
  const observedAt = Date.parse(candidate.observedAt || candidate.fetchedAt);
  const maxAgeHours = opportunities?.thresholds?.maxAgeHours ?? opportunities?.threshold?.maxAgeHours ?? 4;
  if (!positive(maxAgeHours) || !Number.isFinite(observedAt) || observedAt > now + 60_000 || now - observedAt > maxAgeHours * 3_600_000) return null;
  let url;
  try { url = avitoUrl(candidate.url, { listing: true }); } catch { return null; }
  if (url.length > 1500) return null;
  const title = oneLine(candidate.title, 240) || 'Устройство на Авито';
  const seller = oneLine(candidate.sellerName, 100) || 'не указан';
  const fraction = Number.isFinite(candidate.deltaPercent) ? ` (${percent.format(candidate.deltaPercent)}% от ориентира)` : '';
  const text = [
    'Авито Сигналы · стоит проверить', title, `Б/у · частный продавец: ${seller}.`, '',
    `Цена Авито: ${rubles(candidate.price)}`,
    procurement ? `Русский закуп нового ${/^iPhone\b/i.test(candidate.model || '') ? 'iPhone' : 'MacBook'} · ${candidate.procurement.retailer}: ${rubles(candidate.referencePrice)}`
      : `Минимальная цена сопоставимых б/у у других частников: ${rubles(candidate.referencePrice)}`,
    `Резерв на дополнительные расходы: ${rubles(reserve)}`,
    `Разница после резерва: ${rubles(delta)}${fraction}`,
    '', procurement ? 'Б/у сравнивается с закупом нового устройства. Это разница цен, не прибыль. Проверьте состояние, аккумулятор и ремонт.'
      : 'Ориентир — цены объявлений, а не состоявшихся сделок. Проверьте состояние, аккумулятор, ремонт и комплектацию.',
    `Объявление проверено: ${atMoscow(observedAt)}`, '', url, `Таблица: ${SITE_URL}`,
  ].join('\n');
  return { key: candidate.dedupKey, text };
}

async function readLedger(path) {
  try {
    const ledger = JSON.parse(await readFile(path, 'utf8'));
    if (!ledger || ledger.schemaVersion !== 1 || !ledger.entries || typeof ledger.entries !== 'object' || Array.isArray(ledger.entries)
      || Object.values(ledger.entries).some(entry => !entry || !['pending', 'sent', 'unknown', 'rate_limited', 'error'].includes(entry.status))) throw new Error('Invalid alert ledger');
    return ledger;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, entries: {}, lastSentAt: null };
    // A damaged deduplication ledger must never be replaced by an empty ledger.
    return null;
  }
}

/**
 * Sends at most five NEW signals using a dedicated, explicitly configured bot.
 * The ledger deliberately favors avoiding duplicate messages: a pending request
 * after a crash or a response lost in transit needs manual verification and is
 * never automatically replayed. The caller owns bot registration and secrets.
 */
export async function sendAvitoAlerts({ opportunities, env = process.env,
  dir = env.AVITO_DATA_DIR || 'data/private/avito', now = Date.now(), fetchImpl = fetch } = {}) {
  const report = async state => {
    const path = join(dir, 'alerts-state.json');
    // The lock-contention path can report alongside an active send in this
    // process. Serialize that small public file's writes as well.
    const pending = (publicWrites.get(path) || Promise.resolve()).catch(() => {}).then(() => writeAvitoJson(path, state));
    publicWrites.set(path, pending);
    try { await pending; }
    finally { if (publicWrites.get(path) === pending) publicWrites.delete(path); }
    return state;
  };
  const token = String(env.AVITO_ALERT_BOT_TOKEN || '').trim();
  const chat = String(env.AVITO_ALERT_CHAT_ID || '').trim();
  const relay = Boolean(env.AVITO_ALERT_RELAY_URL || env.AVITO_ALERT_RELAY_SECRET);
  if (relay && !env.AVITO_ALERT_RELAY_URL) return report(publicState({ channel: 'telegram',
    message: 'Реле Google подготовлено; ожидаем разрешения владельца и публикации. Доставка ещё не включена.' }));
  if (!relay && (!token || !chat)) return report(publicState({ message: 'Отдельный бот Авито пока не подключён. Предложения доступны на сайте.' }));
  if (relay ? !googleRelayUrl(env.AVITO_ALERT_RELAY_URL) || String(env.AVITO_ALERT_RELAY_SECRET || '').length < 32
    : !/^\d{4,16}:[A-Za-z0-9_-]{20,100}$/.test(token) || !validChat(chat)) {
    return report(publicState({ channel: 'telegram', message: 'Уведомления Telegram остановлены: проверьте настройки отдельного бота Авито и получателя.' }));
  }
  const time = typeof now === 'function' ? now() : now;
  const timestamp = typeof time === 'string' ? Date.parse(time) : Number(time);
  if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) throw new TypeError('A valid alert timestamp is required');
  const at = new Date(timestamp).toISOString();
  const fingerprint = createHash('sha256').update(relay ? `${env.AVITO_ALERT_RELAY_URL}\n${env.AVITO_ALERT_RELAY_SECRET}` : `${token}\n${chat}`).digest('hex');
  const path = join(dir, 'alerts.json');
  const lockPath = join(dir, 'alerts.lock');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return report(publicState({ enabled: true, channel: 'telegram', message: 'Отправку уведомлений уже выполняет другой запуск. Если статус не меняется, проверьте остановленный процесс.' }));
  }

  try {
    const ledger = await readLedger(path);
    if (!ledger) return report(publicState({ channel: 'telegram', message: 'Уведомления остановлены: история отправки повреждена или недоступна. Нужна ручная проверка перед повторным запуском.' }));
    let sentCount = 0;
    const finish = async (message, enabled = true) => {
      const state = publicState({ enabled, channel: 'telegram', lastSentAt: ledger.lastSentAt || null, message, sentCount });
      ledger.updatedAt = at; ledger.publicState = state;
      await writeAvitoJson(path, ledger);
      return report(state);
    };
    for (const entry of Object.values(ledger.entries)) {
      if (entry.status === 'pending') { entry.status = 'unknown'; entry.reason = 'interrupted'; }
    }
    if (ledger.disabled?.fingerprint === fingerprint) return finish('Уведомления Telegram остановлены после отказа сервиса. Проверьте бота и получателя, затем снимите остановку вручную.', false);
    if (ledger.disabled) delete ledger.disabled;
    if (Date.parse(ledger.retryAfter) > timestamp) return finish(`Telegram ограничил частоту отправки. Следующая попытка не раньше ${atMoscow(ledger.retryAfter)}.`);
    delete ledger.retryAfter;
    const candidates = Array.isArray(opportunities?.candidates) ? opportunities.candidates : [];
    for (const candidate of candidates) {
      if (sentCount >= MAX_ALERTS) break;
      const alert = formatCandidate(candidate, opportunities, timestamp);
      if (!alert) continue;
      const previous = ledger.entries[alert.key];
      if (previous && !['rate_limited', 'error'].includes(previous.status)) continue;
      if (previous?.status === 'error' && previous.fingerprint === fingerprint) continue;
      if (previous?.status === 'rate_limited' && Date.parse(previous.retryAfter) > timestamp) continue;

      const entry = { status: 'pending', attemptedAt: at, fingerprint };
      ledger.entries[alert.key] = entry;
      // Never perform the external side effect unless its intent is persisted.
      await writeAvitoJson(path, ledger);
      let response, body;
      try {
        if (relay) ({ response, body } = await sendGoogleRelay({ key: alert.key, text: alert.text, env, now: timestamp, fetchImpl }));
        else { response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text: alert.text, link_preview_options: { is_disabled: true }, allow_paid_broadcast: false }),
        });
        try { body = await response.json(); } catch { body = null; }
        }
      } catch {
        // Fetch errors can contain the token-bearing URL. Never persist or log them.
        entry.status = 'unknown'; entry.reason = 'network_outcome_unknown';
        return finish('Ответ Telegram не получен: доставка последнего сигнала неизвестна. Проверьте чат вручную; этот сигнал повторно не отправляется.');
      }
      if (response.ok && body?.ok === true) {
        entry.status = 'sent'; entry.sentAt = at;
        ledger.lastSentAt = at; sentCount++;
        await writeAvitoJson(path, ledger);
        continue;
      }
      const errorCode = Number.isInteger(body?.error_code) ? body.error_code : response.status;
      if (body?.delivery_unknown) {
        entry.status = 'unknown'; entry.reason = 'relay_delivery_unknown';
        return finish('Реле Google не подтвердило доставку. Автоматический повтор заблокирован; проверьте чат.');
      }
      if (errorCode === 429) {
        const seconds = Number(body?.parameters?.retry_after ?? response.headers?.get?.('retry-after'));
        const retryAfter = new Date(timestamp + (Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, 604_800) : 60) * 1000).toISOString();
        entry.status = 'rate_limited'; entry.retryAfter = retryAfter; ledger.retryAfter = retryAfter;
        return finish(`Telegram ограничил частоту отправки. Следующая попытка не раньше ${atMoscow(retryAfter)}.`);
      }
      if (errorCode >= 400 && errorCode < 500) {
        entry.status = 'error'; entry.errorCode = errorCode;
        ledger.disabled = { fingerprint, at, errorCode };
        return finish('Уведомления Telegram остановлены после отказа сервиса. Проверьте отдельного бота Авито и получателя; повторная отправка требует исправления настроек или ручной проверки.', false);
      }
      entry.status = 'unknown'; entry.reason = 'response_outcome_unknown';
      return finish('Telegram вернул неопределённый результат. Проверьте доставку вручную; этот сигнал повторно не отправляется.');
    }
    const uncertain = Object.values(ledger.entries).some(entry => entry.status === 'unknown'
      && !(entry.resolution?.kind === 'excluded_by_current_policy' && Number.isFinite(Date.parse(entry.resolution.at))));
    return finish(`${sentCount ? `Отправлено новых сигналов: ${sentCount}.` : 'Новых сигналов для отправки нет.'}${uncertain ? ' Есть сигналы с неподтверждённой доставкой: проверьте чат вручную, автоматического повтора не будет.' : ''}`);
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
