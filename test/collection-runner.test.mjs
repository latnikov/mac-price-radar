import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSources, collectionFailures, scheduleSources } from '../scripts/collection-runner.mjs';

test('unavailable sources cannot be reported as an entirely successful run', () => {
  assert.deepEqual(collectionFailures([{ status: 'success' }, { status: 'not_ready' }, { status: 'partial' }]), [{ status: 'not_ready' }, { status: 'partial' }]);
  const sources = ['fast', 'unknown', 'slow'];
  assert.deepEqual(scheduleSources(sources, [{ retailer: 'slow', durationMs: 100 }, { retailer: 'fast', durationMs: 10 }]), ['slow', 'fast', 'unknown']);
  assert.deepEqual(sources, ['fast', 'unknown', 'slow']);
});

test('sources overlap within the limit, isolate failures, and serialize progress', async () => {
  let active = 0, peak = 0, reporting = 0;
  let firstWaveStarted = 0, releaseFirstWave;
  const firstWave = new Promise(resolve => { releaseFirstWave = resolve; });
  const progress = [];
  const results = await collectSources(['a', 'b', 'c', 'd', 'e'], async retailer => {
    peak = Math.max(peak, ++active);
    if (['a', 'b', 'c'].includes(retailer)) {
      if (++firstWaveStarted === 3) releaseFirstWave();
      await firstWave;
    }
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
