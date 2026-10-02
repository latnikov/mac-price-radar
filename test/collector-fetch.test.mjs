import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollectorFetch } from '../scripts/collector-fetch.mjs';

test('source network metrics include retries, body bytes and overlapping requests', async () => {
  let calls = 0;
  const client = createCollectorFetch({ fetchImpl: async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return ++calls === 1 ? new Response('busy', { status: 503 }) : new Response('{"цена":42}');
  } });
  const [first, second] = await Promise.all([client.fetchResponse('https://one.test', { baseDelayMs: 0 }), client.fetchPage('https://two.test')]);
  assert.deepEqual(await first.json(), { цена: 42 });
  assert.equal(second, '{"цена":42}');
  assert.equal(client.metrics.requests, 3);
  assert.equal(client.metrics.responses, 2);
  assert.equal(client.metrics.failedRequests, 1);
  assert.equal(client.metrics.retries, 1);
  assert.equal(client.metrics.maxConcurrent, 2);
  assert.equal(client.metrics.bytes, 2 * Buffer.byteLength(second));
  assert.ok(client.metrics.requestTimeMs > 0);
});

test('request timeout covers stalled response bodies and abort starts no request', async () => {
  const client = createCollectorFetch({ timeoutMs: 10, fetchImpl: async (_, { signal }) => ({
    ok: true, status: 200,
    text: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  }) });
  const keepAlive = setInterval(() => {}, 20);
  try { await assert.rejects(client.fetchPage('https://slow.test', { baseDelayMs: 0 }), { name: 'TimeoutError' }); }
  finally { clearInterval(keepAlive); }
  assert.equal(client.metrics.failedRequests, 2);
  assert.equal(client.metrics.retries, 1);
  const stopped = createCollectorFetch({ signal: AbortSignal.abort(), fetchImpl: async () => assert.fail('no request') });
  await assert.rejects(stopped.fetchPage('https://slow.test'), { name: 'AbortError' });
  assert.equal(stopped.metrics.requests, 0);
});
