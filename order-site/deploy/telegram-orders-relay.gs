/**
 * Standalone Google Apps Script. Do not put secrets in source.
 * Script Properties: ORDER_API_ORIGIN, ORDER_RELAY_KEY, ORDER_TELEGRAM_BOT_TOKEN.
 * Run installOrderRelay once and authorize its time trigger / external requests.
 * No web-app deployment and no publicly exposed Google endpoint are needed.
 */
function orderApi_(path, body, props) {
  const origin = props.getProperty('ORDER_API_ORIGIN');
  const key = props.getProperty('ORDER_RELAY_KEY');
  if (!origin || !origin.startsWith('https://') || !key) throw new Error('Configure ORDER_API_ORIGIN and ORDER_RELAY_KEY');
  const response = UrlFetchApp.fetch(origin.replace(/\/$/, '') + path, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + key }, followRedirects: false, muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) throw new Error('Order API HTTP ' + response.getResponseCode());
  return JSON.parse(response.getContentText());
}
function pollOrderNotifications() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  const props = PropertiesService.getScriptProperties();
  try {
    const token = props.getProperty('ORDER_TELEGRAM_BOT_TOKEN');
    if (!token) throw new Error('Configure ORDER_TELEGRAM_BOT_TOKEN');
    // A sent notification is acknowledged first on the next run if the previous
    // acknowledgement failed. This reduces duplicates on transient API outages.
    const pending = props.getProperty('ORDER_PENDING_ACK');
    if (pending) {
      orderApi_('/api/relay/ack', JSON.parse(pending), props);
      props.deleteProperty('ORDER_PENDING_ACK');
    }
    const batch = orderApi_('/api/relay/claim', {}, props);
    for (const item of batch.notifications) {
      const response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ chat_id: item.chatId, text: item.text, link_preview_options: { is_disabled: true } }),
        muteHttpExceptions: true,
      });
      const result = JSON.parse(response.getContentText());
      if (response.getResponseCode() !== 200 || !result.ok) throw new Error('Telegram delivery failed');
      const ack = { orderId: item.orderId, lease: item.lease };
      props.setProperty('ORDER_PENDING_ACK', JSON.stringify(ack));
      orderApi_('/api/relay/ack', ack, props);
      props.deleteProperty('ORDER_PENDING_ACK');
    }
    props.setProperty('ORDER_LAST_SUCCESS', new Date().toISOString());
    props.deleteProperty('ORDER_LAST_ERROR');
  } catch (_) {
    // Never log request URLs, tokens, or customers' data.
    props.setProperty('ORDER_LAST_ERROR', new Date().toISOString() + ' Delivery incomplete; will retry');
    throw new Error('Order relay failed. Check its settings and service availability.');
  } finally { lock.releaseLock(); }
}
function installOrderRelay() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ORDER_RELAY_KEY')) {
    const token = props.getProperty('ORDER_TELEGRAM_BOT_TOKEN');
    if (!token) throw new Error('Configure ORDER_TELEGRAM_BOT_TOKEN');
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'macbookbro-orders-relay:' + token, Utilities.Charset.UTF_8);
    props.setProperty('ORDER_RELAY_KEY', digest.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join(''));
  }
  pollOrderNotifications();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'pollOrderNotifications').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('pollOrderNotifications').timeBased().everyMinutes(1).create();
}
