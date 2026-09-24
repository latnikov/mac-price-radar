const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function retryAfterMilliseconds(response, fallback, maximum) {
  const value = response.headers?.get?.('retry-after');
  if (value) {
    const seconds = Number(value);
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, maximum);
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
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImpl(url, options);
    if (response.ok) return response;
    if (!TRANSIENT_STATUSES.has(response.status) || attempt === attempts) throw new Error(`HTTP ${response.status}: ${url}`);
    await response.body?.cancel?.().catch(() => {});
    await sleep(retryAfterMilliseconds(response, baseDelayMs * 2 ** (attempt - 1), maxDelayMs));
  }
  throw new Error(`Не удалось загрузить: ${url}`);
}

export async function fetchTextWithRetry(url, options = {}) {
  return (await fetchResponseWithRetry(url, options)).text();
}
