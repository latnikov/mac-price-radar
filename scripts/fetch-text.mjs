const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

import { setTimeout as delay } from 'node:timers/promises';
const wait = (milliseconds, signal) => delay(milliseconds, undefined, { signal });

function retryAfterMilliseconds(response, fallback, maximum) {
  const value = response.headers?.get?.('retry-after');
  if (value) {
    const seconds = Number(value);
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    // Never shorten a server cooldown into an early retry.
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return Math.min(fallback, maximum);
}

export async function fetchResponseWithRetry(url, {
  attempts = 1,
  baseDelayMs = 500,
  maxDelayMs = 5000,
  fetchImpl = fetch,
  sleep = wait,
  ...options
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError('Invalid fetch attempts');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    const response = await fetchImpl(url, options);
    if (response.ok) return response;
    await response.body?.cancel?.().catch(() => {});
    if (!TRANSIENT_STATUSES.has(response.status) || attempt === attempts) throw new Error(`HTTP ${response.status}: ${url}`);
    const delayMs = retryAfterMilliseconds(response, baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
    if (delayMs > maxDelayMs) throw new Error(`HTTP ${response.status}: ${url} (Retry-After exceeds retry budget)`);
    await sleep(delayMs, options.signal);
  }
  throw new Error(`Не удалось загрузить: ${url}`);
}

export async function fetchTextWithRetry(url, options = {}) {
  return (await fetchResponseWithRetry(url, options)).text();
}
