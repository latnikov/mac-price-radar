/** Server -> Google Apps Script -> dedicated Telegram bot.
 * Script Properties: AVITO_ALERT_BOT_TOKEN, AVITO_ALERT_CHAT_ID,
 * AVITO_RELAY_SECRET (the same secret as AVITO_ALERT_RELAY_SECRET on dev).
 * No Drive, mail, calendar or spreadsheet permission is needed.
 */
function avitoJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() { return avitoJson_({ok: true, service: 'macbookbro-avito-signals', version: 1}); }
function avitoEqual_(a, b) {
  var difference = a.length ^ b.length;
  for (var i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
function doPost(e) {
  var input;
  try {
    if (!e || !e.postData || e.postData.contents.length > 20000) throw new Error();
    input = JSON.parse(e.postData.contents);
  } catch (_) { return avitoJson_({ok: false, error_code: 400}); }
  var properties = PropertiesService.getScriptProperties();
  var secret = properties.getProperty('AVITO_RELAY_SECRET');
  var token = properties.getProperty('AVITO_ALERT_BOT_TOKEN');
  var chat = properties.getProperty('AVITO_ALERT_CHAT_ID');
  if (!secret || secret.length < 32 || !token || !chat) return avitoJson_({ok: false, error_code: 503});
  if (input.version !== 1 || typeof input.key !== 'string' || !/^[A-Za-z0-9:_-]{1,150}$/.test(input.key)
    || typeof input.text !== 'string' || input.text.length < 1 || input.text.length > 4000
    || !Number.isSafeInteger(input.timestamp) || Math.abs(Date.now() / 1000 - input.timestamp) > 300
    || !/^[a-f0-9]{32}$/.test(input.nonce || '') || !/^[a-f0-9]{64}$/.test(input.signature || '')) return avitoJson_({ok: false, error_code: 401});
  var canonical = JSON.stringify([input.version, input.key, input.text, input.timestamp, input.nonce]);
  var signature = Utilities.computeHmacSha256Signature(canonical, secret, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
  if (!avitoEqual_(signature, input.signature)) return avitoJson_({ok: false, error_code: 401});
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return avitoJson_({ok: false, error_code: 429, parameters: {retry_after: 60}});
  try {
    var propertyKey = 'AVITO_SENT_' + input.key;
    var prior = properties.getProperty(propertyKey);
    if (prior) {
      var old = JSON.parse(prior);
      if (old.status === 'sent') return avitoJson_({ok: true, duplicate: true, result: {message_id: old.messageId}});
      return avitoJson_({ok: false, error_code: 409, delivery_unknown: true});
    }
    // A persisted pending key prevents a lost response or concurrent call from
    // sending the same message a second time.
    properties.setProperty(propertyKey, JSON.stringify({status: 'pending', at: Date.now()}));
    var body;
    try {
      var response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true, followRedirects: false,
        payload: JSON.stringify({chat_id: chat, text: input.text, link_preview_options: {is_disabled: true}, allow_paid_broadcast: false})
      });
      body = JSON.parse(response.getContentText() || '{}');
      if (response.getResponseCode() === 200 && body.ok === true) {
        properties.setProperty(propertyKey, JSON.stringify({status: 'sent', at: Date.now(), messageId: body.result.message_id}));
        return avitoJson_({ok: true, result: {message_id: body.result.message_id}});
      }
      if (body.error_code === 429) {
        properties.deleteProperty(propertyKey);
        return avitoJson_({ok: false, error_code: 429, parameters: {retry_after: Number(body.parameters && body.parameters.retry_after) || 60}});
      }
      properties.setProperty(propertyKey, JSON.stringify({status: 'unknown', at: Date.now()}));
      return avitoJson_({ok: false, error_code: Number(body.error_code) || 502, delivery_unknown: true});
    } catch (_) {
      properties.setProperty(propertyKey, JSON.stringify({status: 'unknown', at: Date.now()}));
      return avitoJson_({ok: false, error_code: 502, delivery_unknown: true});
    }
  } finally { lock.releaseLock(); }
}
