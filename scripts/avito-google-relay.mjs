import { createHmac, randomBytes } from 'node:crypto';

export function googleRelayUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || url.port || url.username || url.password
      || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
}

export async function sendGoogleRelay({ key, text, env = process.env, now = Date.now(), fetchImpl = fetch }) {
  const url = googleRelayUrl(env.AVITO_ALERT_RELAY_URL);
  const secret = String(env.AVITO_ALERT_RELAY_SECRET || '');
  if (!url || secret.length < 32 || !/^[A-Za-z0-9:_-]{1,150}$/.test(key) || typeof text !== 'string' || text.length > 4000) throw new Error('Настройки реле Google некорректны');
  const payload = { version: 1, key, text, timestamp: Math.floor(Number(now) / 1000), nonce: randomBytes(16).toString('hex') };
  const canonical = JSON.stringify([payload.version, payload.key, payload.text, payload.timestamp, payload.nonce]);
  payload.signature = createHmac('sha256', secret).update(canonical).digest('hex');
  const signal = AbortSignal.timeout(30000);
  let response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), redirect: 'manual', signal });
  if ([302, 303].includes(response.status)) {
    const next = new URL(response.headers.get('location'), url);
    if (next.protocol !== 'https:' || next.hostname !== 'script.googleusercontent.com' || next.port || next.username || next.password) throw new Error('Реле Google вернуло недопустимый переход');
    response = await fetchImpl(next.href, { method: 'GET', redirect: 'error', signal });
  }
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}
