import test from 'node:test';
import assert from 'node:assert/strict';
import { crawlQueue } from '../scripts/crawl-queue.mjs';

test('a fast page starts newly discovered work while a slow page is still pending', async () => {
  const slow = Promise.withResolvers();
  let active = 0, peak = 0;
  const visited = [];
  await crawlQueue(['slow', 'fast'], async (item, enqueue) => {
    peak = Math.max(peak, ++active);
    visited.push(item);
    if (item === 'slow') await slow.promise;
    if (item === 'fast') enqueue('discovered');
    if (item === 'discovered') slow.resolve();
    active--;
  }, { concurrency: 2 });
  assert.deepEqual(visited, ['slow', 'fast', 'discovered']);
  assert.equal(peak, 2);
});

test('failed crawl starts no queued work and drains in-flight pages', async () => {
  const slow = Promise.withResolvers();
  const failed = Promise.withResolvers();
  const visited = [];
  let finished = false;
  const result = crawlQueue(['slow', 'failure', 'queued'], async (item, enqueue) => {
    visited.push(item);
    if (item === 'failure') { failed.resolve(); throw new Error('offline'); }
    if (item === 'slow') { await slow.promise; enqueue('late'); finished = true; }
  }, { concurrency: 2 });
  await failed.promise;
  await new Promise(resolve => setImmediate(resolve));
  slow.resolve();
  await assert.rejects(result, /offline/);
  assert.equal(finished, true);
  assert.deepEqual(visited, ['slow', 'failure']);
});
