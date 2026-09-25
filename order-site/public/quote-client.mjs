// A short session-only cache makes revisiting configurations instant. The order
// endpoint always calculates its own price before saving an order.
export function createQuoteLoader({ fetchImpl = fetch, now = Date.now, ttlMs = 30000 } = {}) {
  const cache = new Map();
  let controller;
  return async configuration => {
    controller?.abort();
    controller = new AbortController();
    const query = new URLSearchParams(Object.entries(configuration).map(([key, value]) => [key, String(value)]));
    const key = query.toString();
    const saved = cache.get(key);
    if (saved && saved.expiresAt > now()) return saved.data;
    const response = await fetchImpl(`/api/quote?${query}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось рассчитать цену.');
    if (!Number.isInteger(data.priceRub) || !data.stepPricesRub) throw new Error('Не удалось рассчитать цену.');
    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    cache.set(key, { data, expiresAt: now() + ttlMs });
    return data;
  };
}
