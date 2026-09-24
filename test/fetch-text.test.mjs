import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTextWithRetry } from '../scripts/fetch-text.mjs';

test('retries a temporary 503 and returns the recovered page', async () => {
  const responses = [new Response('busy', { status: 503 }), new Response('ready')];
  const delays = [];
  const text = await fetchTextWithRetry('https://shop.test/product', {
    attempts: 3,
    baseDelayMs: 600,
    fetchImpl: async () => responses.shift(),
    sleep: async milliseconds => delays.push(milliseconds),
  });
  assert.equal(text, 'ready');
  assert.deepEqual(delays, [600]);
});

test('does not retry permanent HTTP failures', async () => {
  let calls = 0;
  await assert.rejects(fetchTextWithRetry('https://shop.test/missing', {
    attempts: 3,
    fetchImpl: async () => { calls += 1; return new Response('missing', { status: 404 }); },
    sleep: async () => {},
  }), /HTTP 404/);
  assert.equal(calls, 1);
});
