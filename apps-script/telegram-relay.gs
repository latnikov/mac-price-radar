/**
 * Тонкий webhook-релей Telegram -> dev.macbookbro.ru.
 *
 * Script Properties:
 *   TELEGRAM_RELAY_KEY   случайный ключ из URL Telegram webhook
 *   DEV_WEBHOOK_URL      https://dev.macbookbro.ru/api/telegram/bsa-webhook
 *   DEV_WEBHOOK_SECRET   секрет заголовка dev webhook
 */

function jsonResponse_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return jsonResponse_({ ok: true, service: 'mac-price-radar-telegram-relay' });
}

function doPost(e) {
  const properties = PropertiesService.getScriptProperties();
  const expectedKey = properties.getProperty('TELEGRAM_RELAY_KEY');
  const suppliedKey = String(e && e.parameter && e.parameter.key || '');
  if (!expectedKey || suppliedKey !== expectedKey) {
    return jsonResponse_({ ok: false, error: 'forbidden' });
  }

  const webhookUrl = properties.getProperty('DEV_WEBHOOK_URL');
  const webhookSecret = properties.getProperty('DEV_WEBHOOK_SECRET');
  const payload = String(e && e.postData && e.postData.contents || '');
  if (!webhookUrl || !webhookSecret || !payload) {
    return jsonResponse_({ ok: false, error: 'relay_not_configured' });
  }

  try {
    const update = JSON.parse(payload);
    if (!Number.isSafeInteger(Number(update && update.update_id))) {
      return jsonResponse_({ ok: false, error: 'invalid_update' });
    }
  } catch (_) {
    return jsonResponse_({ ok: false, error: 'invalid_json' });
  }

  const response = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: payload,
    headers: { 'X-Telegram-Bot-Api-Secret-Token': webhookSecret },
    followRedirects: false,
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  return jsonResponse_({ ok: status >= 200 && status < 300, upstreamStatus: status });
}
