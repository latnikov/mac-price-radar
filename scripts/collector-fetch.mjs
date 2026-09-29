import { fetchResponseWithRetry } from './fetch-text.mjs';

// A fresh instance belongs to one source, so concurrent shops never mix metrics.
// Include body transfer in request time and timeout, not just response headers.
export function createCollectorFetch({ signal, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const metrics = { requests: 0, responses: 0, failedRequests: 0, retries: 0, bytes: 0, requestTimeMs: 0, maxConcurrent: 0 };
  let active = 0;
  const fetchResponse = async (url, options = {}) => {
    let attempt = 0;
    return fetchResponseWithRetry(url, {
      attempts: 2, baseDelayMs: 500, maxDelayMs: 5000, ...options, signal,
      fetchImpl: async (target, requestOptions) => {
        metrics.requests++;
        if (attempt++) metrics.retries++;
        metrics.maxConcurrent = Math.max(metrics.maxConcurrent, ++active);
        const started = performance.now();
        try {
          const response = await fetchImpl(target, {
            ...requestOptions,
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
            headers: { 'user-agent': 'Mozilla/5.0 MacPriceRadar/2.0', 'cache-control': 'no-cache, no-store', pragma: 'no-cache' },
          });
          if (!response.ok) { metrics.failedRequests++; return response; }
          const body = await response.text();
          metrics.responses++;
          metrics.bytes += Buffer.byteLength(body);
          return { ok: true, status: response.status, url: response.url, headers: response.headers,
            text: async () => body, json: async () => JSON.parse(body) };
        } catch (error) { metrics.failedRequests++; throw error; }
        finally { active--; metrics.requestTimeMs += Math.round(performance.now() - started); }
      },
    });
  };
  return { metrics, fetchResponse, fetchPage: async (url, options) => (await fetchResponse(url, options)).text() };
}
