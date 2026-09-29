import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createResponseCache, sendCached } from '../scripts/response-cache.mjs';

function reply(value, headers = {}, method = 'GET') {
  const result = {};
  sendCached({ headers, method }, { writeHead: (status, headers) => Object.assign(result, { status, headers }), end: body => { result.body = body; } }, value, 'application/json', {});
  return result;
}

test('large representations share one asynchronous compression and negotiate gzip', async () => {
  const cache = createResponseCache(); let builds = 0;
  const build = () => { builds++; return { values: Array(2000).fill('MacBook Air M5') }; };
  const [first, second] = await Promise.all([cache('table', 1, build), cache('table', 1, build)]);
  assert.equal(first, second); assert.equal(builds, 1);
  const plain = reply(first), compressed = reply(first, { 'accept-encoding': 'gzip, deflate' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.equal(compressed.headers.vary, 'Accept-Encoding');
  assert.ok(compressed.body.length < plain.body.length / 10);
  assert.deepEqual(gunzipSync(compressed.body), plain.body);
  assert.notEqual(plain.headers.etag, compressed.headers.etag);
});

test('revalidation uses representation-specific tags and HEAD returns no body', async () => {
  const value = await createResponseCache()('table', 1, () => Array(1000).fill('payload'));
  const gz = reply(value, { 'accept-encoding': 'gzip' });
  const hit = reply(value, { 'accept-encoding': 'gzip', 'if-none-match': `W/${gz.headers.etag}` });
  assert.equal(hit.status, 304); assert.equal(hit.body, undefined);
  assert.equal(reply(value, { 'if-none-match': gz.headers.etag }).status, 200);
  const head = reply(value, { 'accept-encoding': 'gzip' }, 'HEAD');
  assert.equal(head.body, undefined); assert.equal(head.headers['content-length'], gz.body.length);
  assert.equal(reply(value, { 'accept-encoding': '*;q=1, gzip;q=0' }).headers['content-encoding'], undefined);
  assert.equal(reply(value, { 'accept-encoding': 'GZIP; q=0.5' }).headers['content-encoding'], 'gzip');
});

test('failed builds can retry and old completions cannot evict a newer revision', async () => {
  const cache = createResponseCache(), pending = Promise.withResolvers();
  const old = cache('key', 1, () => pending.promise);
  const current = await cache('key', 2, () => ({ value: 2 }));
  pending.reject(new Error('failed'));
  await assert.rejects(old, /failed/);
  assert.equal(await cache('key', 2, () => assert.fail('already cached')), current);
  await assert.rejects(cache('other', 1, () => { throw new Error('temporary'); }), /temporary/);
  assert.ok(await cache('other', 1, () => ({ ok: true })));
});
