import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSources } from '../scripts/collection-runner.mjs';

test('sources overlap within the limit, isolate failures, and serialize progress', async () => {
  let active = 0, peak = 0, reporting = 0;
  const progress = [];
  const results = await collectSources(['a', 'b', 'c', 'd', 'e'], async retailer => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, retailer === 'a' ? 15 : 2));
    active--;
    if (retailer === 'b') throw new Error('offline');
    return retailer;
  }, { concurrency: 3, onProgress: async value => {
    assert.equal(++reporting, 1);
    await new Promise(resolve => setTimeout(resolve, 1));
    progress.push(value);
    reporting--;
  } });
  assert.equal(peak, 3);
  assert.deepEqual(results.map(result => result.retailer), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(results[1].error.message, 'offline');
  assert.equal(results[4].value, 'e');
  assert.deepEqual(progress.at(-1), { active: [], completed: 5, total: 5 });
  assert.ok(progress.every((value, i) => !i || value.completed >= progress[i - 1].completed));
});

test('progress failure drains active sources before releasing the caller', async () => {
  let finished = false;
  await assert.rejects(collectSources(['slow', 'fast'], async retailer => {
    if (retailer === 'slow') {
      await new Promise(resolve => setTimeout(resolve, 20));
      finished = true;
    }
  }, { concurrency: 2, onProgress: async value => {
    if (value.completed > 0) throw new Error('status disk failure');
  } }), /status disk failure/);
  assert.equal(finished, true);
});
