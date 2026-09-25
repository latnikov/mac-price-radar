import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteLoader } from '../public/quote-client.mjs';

test('revisited prices are immediate but expire; failed requests are never cached', async () => {
  let clock = 0, calls = 0, failed = false;
  const load = createQuoteLoader({ now: () => clock, fetchImpl: async () => {
    calls++;
    return failed ? new Response('{"error":"offline"}', { status: 503 }) : Response.json({ priceRub: 100, stepPricesRub: {} });
  } });
  await load({ memory: 16 }); await load({ memory: 16 });
  assert.equal(calls, 1);
  clock = 30001; await load({ memory: 16 }); assert.equal(calls, 2);
  failed = true; await assert.rejects(load({ memory: 32 }), /offline/);
  failed = false; await load({ memory: 32 }); assert.equal(calls, 4);
});

test('switching configurations aborts the previous network request', async () => {
  let calls = 0;
  const load = createQuoteLoader({ fetchImpl: async (url, { signal }) => {
    if (++calls === 1) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return Response.json({ priceRub: 200, stepPricesRub: {} });
  } });
  const first = load({ memory: 16 });
  const aborted = assert.rejects(first, { name: 'AbortError' });
  assert.equal((await load({ memory: 32 })).priceRub, 200);
  await aborted;
});
