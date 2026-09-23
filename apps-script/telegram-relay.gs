/**
 * Polling-релей Telegram Bot API -> dev.macbookbro.ru.
 *
 * Script Properties:
 *   TELEGRAM_BOT_TOKEN   токен бота (никогда не добавлять в исходный код)
 *   DEV_WEBHOOK_URL      https://dev.macbookbro.ru/api/telegram/bsa-webhook
 *   DEV_WEBHOOK_SECRET   секрет заголовка dev webhook
 *   TELEGRAM_LAST_UPDATE_ID заполняется автоматически
 */

const TELEGRAM_ALLOWED_UPDATES_ = [
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
];

function jsonResponse_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  const properties = PropertiesService.getScriptProperties();
  return jsonResponse_({
    ok: true,
    service: 'mac-price-radar-telegram-poller',
    lastPollAt: properties.getProperty('TELEGRAM_LAST_POLL_AT'),
    lastUpdateId: properties.getProperty('TELEGRAM_LAST_UPDATE_ID'),
    lastError: properties.getProperty('TELEGRAM_LAST_ERROR'),
  });
}

function relayUpdate_(update, properties) {
  const webhookUrl = properties.getProperty('DEV_WEBHOOK_URL');
  const webhookSecret = properties.getProperty('DEV_WEBHOOK_SECRET');
  if (!webhookUrl || !webhookSecret) {
    throw new Error('DEV_WEBHOOK_URL/DEV_WEBHOOK_SECRET are not configured');
  }
  if (!Number.isSafeInteger(Number(update && update.update_id))) {
    throw new Error('Telegram returned an invalid update');
  }

  const response = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(update),
    headers: { 'X-Telegram-Bot-Api-Secret-Token': webhookSecret },
    followRedirects: false,
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error('Dev webhook returned HTTP ' + status);
  }
}

function pollTelegram() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, skipped: 'already_running' };
  const properties = PropertiesService.getScriptProperties();
  try {
    const token = properties.getProperty('TELEGRAM_BOT_TOKEN');
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    const offset = Number(properties.getProperty('TELEGRAM_LAST_UPDATE_ID') || 0);
    const response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        offset: offset,
        limit: 100,
        timeout: 0,
        allowed_updates: TELEGRAM_ALLOWED_UPDATES_,
      }),
      muteHttpExceptions: true,
    });
    const body = JSON.parse(response.getContentText() || '{}');
    if (response.getResponseCode() !== 200 || !body.ok || !Array.isArray(body.result)) {
      throw new Error('Telegram getUpdates failed with HTTP ' + response.getResponseCode());
    }

    let nextOffset = offset;
    for (const update of body.result) {
      relayUpdate_(update, properties);
      nextOffset = Number(update.update_id) + 1;
      // Confirm only an update that the dev server has already accepted.
      properties.setProperty('TELEGRAM_LAST_UPDATE_ID', String(nextOffset));
    }
    properties.setProperties({
      TELEGRAM_LAST_POLL_AT: new Date().toISOString(),
      TELEGRAM_LAST_ERROR: '',
    });
    return { ok: true, received: body.result.length, nextOffset: nextOffset };
  } catch (error) {
    properties.setProperty('TELEGRAM_LAST_ERROR', String(error && error.message || error).slice(0, 500));
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function installTelegramPoller() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === 'pollTelegram') ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger('pollTelegram').timeBased().everyMinutes(1).create();
  return pollTelegram();
}

function removeTelegramPoller() {
  let removed = 0;
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === 'pollTelegram') {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  }
  return { ok: true, removed: removed };
}
