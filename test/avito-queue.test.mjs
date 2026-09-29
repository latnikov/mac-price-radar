import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { collectAvitoSnapshot } from '../scripts/avito-collector.mjs';
import { createAvitoDetailQueue } from '../scripts/avito-queue.mjs';
import { writeAvitoJson } from '../scripts/avito-storage.mjs';
import { parseAvitoSnapshot } from '../scripts/avito.mjs';
import { at, search, url, searchPage, detailPage } from './fixtures/avito/sample.mjs';

const ids = ['1234567890', '1234567891', '1234567892'];
const later = '2026-09-26T19:00:00.000Z';

test('persisted queue resumes with unvisited cards after a blocked run; only fresh detail responses enter the next snapshot', async t => {
  const dir = await mkdtemp(`${tmpdir()}/avito-queue-`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(collectAvitoSnapshot({ now: () => at,
    fetchPage: async target => target === search ? searchPage(ids) : target === url(ids[0]) ? detailPage() : '<title>Доступ ограничен</title>',
    onQueue: queue => writeAvitoJson(`${dir}/queue.json`, queue),
  }), { code: 'AVITO_BLOCKED' });
  const saved = JSON.parse(await readFile(`${dir}/queue.json`, 'utf8'));
  assert.equal(saved.entries[0].lastObservedAt, at);
  assert.equal(saved.entries[1].lastAttemptAt, null);
  const visits = [];
  const result = await collectAvitoSnapshot({ previousQueue: saved, now: () => later,
    fetchPage: async target => {
      visits.push(target);
      return target === search ? searchPage(ids) : detailPage();
    },
  });
  assert.deepEqual(visits, [search, url(ids[1]), url(ids[2]), url(ids[0])]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.listings.map(item => item.observedAt), [later, later, later]);
  assert.equal(parseAvitoSnapshot(result, { now: Date.parse(later) }).offers.length, 3);
});

test('deadline preserves all received cards since the last periodic checkpoint and stops before another request', async () => {
  const controller = new AbortController(), checkpoints = [], visits = [];
  let saved;
  await assert.rejects(collectAvitoSnapshot({ signal: controller.signal, now: () => at,
    fetchPage: async target => { visits.push(target); return target === search ? searchPage(ids) : detailPage(); },
    onQueue: async queue => { saved = queue; },
    onCheckpoint: async value => { checkpoints.push(value); },
    onProgress: async progress => { if (progress.inspected === 2) controller.abort(new Error('time budget')); },
  }), /time budget/);
  assert.deepEqual(visits, [search, url(ids[0]), url(ids[1])]);
  assert.equal(checkpoints.at(-1).listings.length, 2);
  assert.equal(checkpoints.at(-1).complete, false);
  assert.ok(checkpoints.at(-1).failures.includes('Сбор прерван; неполный срез'));
  assert.equal(saved.entries[1].lastObservedAt, at);
  assert.equal(saved.entries[2].lastAttemptAt, null);
});

test('an in-flight abort is not swallowed as an ordinary detail parse failure', async () => {
  const controller = new AbortController();
  let saved;
  await assert.rejects(collectAvitoSnapshot({ signal: controller.signal, now: () => at,
    fetchPage: async target => {
      if (target === search) return searchPage(ids);
      controller.abort(new Error('time budget'));
      controller.signal.throwIfAborted();
    },
    onQueue: async queue => { saved = queue; },
  }), /time budget/);
  assert.ok(saved.entries.every(entry => entry.lastAttemptAt === null));
});

test('unparseable cards do not starve unvisited ones and never receive observation timestamps', async () => {
  let saved;
  await assert.rejects(collectAvitoSnapshot({ now: () => at,
    fetchPage: async target => target === search ? searchPage(ids) : target === url(ids[0]) ? '<html>Unknown layout</html>' : '<title>captcha</title>',
    onQueue: async queue => { saved = queue; },
  }), { code: 'AVITO_BLOCKED' });
  assert.equal(saved.entries[0].lastAttemptAt, at);
  assert.equal(saved.entries[0].lastObservedAt, null);
  assert.deepEqual(createAvitoDetailQueue(ids.map(id => ({ id })), { previous: saved, searchUrl: search, startedAt: later }).ordered.map(item => item.id), [ids[1], ids[2], ids[0]]);
});

test('queue is scoped to the current search and uses only current discovery URLs', () => {
  const items = ids.slice(0, 2).map(id => ({ id, url: url(id) }));
  const previous = { schemaVersion: 1, searchUrl: search, entries: [
    { id: ids[0], url: 'https://untrusted.invalid/', lastAttemptAt: at, lastObservedAt: at },
    { id: ids[2], lastAttemptAt: at, lastObservedAt: at },
  ] };
  const queue = createAvitoDetailQueue(items, { previous, searchUrl: search, startedAt: later });
  assert.deepEqual(queue.ordered.map(item => item.url), [url(ids[1]), url(ids[0])]);
  assert.equal(queue.serialize(later).entries.length, 2);
  assert.deepEqual(createAvitoDetailQueue(items, { previous, searchUrl: search + '&localPriority=1', startedAt: later }).ordered, items);
});

test('invalid and future queue dates cannot indefinitely postpone a card', () => {
  const items = ids.map(id => ({ id }));
  for (const entries of [null, [null, { id: ids[0], lastAttemptAt: 'invalid' }, { id: ids[1], lastAttemptAt: '2099-01-01' }]]) {
    const queue = createAvitoDetailQueue(items, { previous: { schemaVersion: 1, searchUrl: search, entries }, searchUrl: search, startedAt: later });
    assert.deepEqual(queue.ordered, items);
    assert.ok(queue.serialize(later).entries.every(entry => entry.lastAttemptAt === null));
  }
});
