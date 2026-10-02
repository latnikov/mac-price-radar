import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createShopService } from '../server.mjs';
import { parserOrigin, staffDestination } from '../parser-routes.mjs';
import { createMasterServer } from '../../scripts/server.mjs';
import { openMasterStore } from '../../scripts/master-store.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'mb-parser-workspace-'));
  await cp(resolve('web'), join(root, 'web'), { recursive: true });
  await mkdir(join(root, 'data/private'), { recursive: true });
  await writeFile(join(root, 'data/catalog.json'), '[]');
  const store = openMasterStore(join(root, 'data/private/master.sqlite'));
  let refreshes = 0, time = Date.now();
  const parser = await createMasterServer({ root, store, env: {}, refreshRunner: async () => { refreshes++; } });
  await new Promise(r => parser.listen(0, '127.0.0.1', r));
  const target = 'http://127.0.0.1:' + parser.address().port;
  const origin = 'http://127.0.0.1:4199';
  const shop = createShopService({ env: { STORE_ORIGIN: origin, STORE_PARSER_ORIGIN: target, STORE_ADMIN_PASSWORD: 'test-owner-password-2026', STORE_MANAGER_PASSWORD: 'test-manager-password-2026', STORE_REQUESTS_PER_MINUTE: '1000' }, dbPath: join(root, 'shop.sqlite'), runWorkers: false, now: () => time });
  await new Promise(r => shop.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await shop.close(); await new Promise(r => parser.close(r)); store.close(); await rm(root, { recursive: true, force: true }); });
  function client() {
    let cookies = '';
    const call = (path, { form, json, headers = {}, method } = {}) => new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: shop.server.address().port, path, method: method || (form || json ? 'POST' : 'GET'), headers: { Host: '127.0.0.1:4199', Cookie: cookies, ...(form || json ? { Origin: origin, 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
          cookies = res.headers['set-cookie']?.[0]?.split(';')[0] || cookies;
          resolve({ status: res.statusCode, headers: res.headers, html: Buffer.concat(chunks).toString() });
        });
      }); req.on('error', reject); req.end(form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined);
    });
    const login = async (password = 'test-manager-password-2026', next = '/crm/parser/') => {
      const r = await call('/crm/login?next=' + encodeURIComponent(next));
      return call('/crm/login', { form: { csrf: r.html.match(/name="csrf" value="([^"]+)"/)[1], password, next } });
    };
    return { call, login };
  }
  return { client, shop, store, target, stopParser: () => new Promise(r => parser.close(r)), get refreshes() { return refreshes; }, expire: () => { time += 3 * 3600000; } };
}

test('parser uses the CRM login, preserves its destination, and serves all three sheets in the authenticated workspace', async t => {
  const app = await setup(t), user = app.client();
  const anonymous = await user.call('/crm/parser/web/foreign.html');
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.location, '/crm/login?next=%2Fcrm%2Fparser%2Fweb%2Fforeign.html');
  const login = await user.login(undefined, '/crm/parser/web/foreign.html');
  assert.equal(login.headers.location, '/crm/parser/web/foreign.html');
  for (const path of ['/crm/parser/', '/crm/parser/web/index.html', '/crm/parser/web/foreign.html', '/crm/parser/web/avito.html']) {
    const r = await user.call(path); assert.equal(r.status, 200);
    assert.match(r.html, /class="sidebar"/); assert.match(r.html, /href="\/crm\/parser\/" aria-current="page"/);
    assert.match(r.html, /src="\/crm\/parser\/web\/(app|foreign)\.js"/);
    assert.doesNotMatch(r.html, /<iframe|<base/);
    assert.equal((r.html.match(/<main\b/g) || []).length, 1);
  }
  const avito = await user.call('/crm/parser/web/avito.html'); assert.match(avito.html, /data-sheet="avito"/);
  assert.equal((await user.call('/crm/parser/web/styles.css')).status, 200);
  assert.equal((await user.call('/crm/parser/web/app.js')).status, 200);
  assert.equal(JSON.parse((await user.call('/crm/parser/public-config.json')).html).mode, 'local');
  const session = await user.call('/crm/parser/api/session'); assert.ok(JSON.parse(session.html).csrfToken);
  assert.equal((await user.call('/crm/parser/api/table')).status, 200);
  const csrf = JSON.parse(session.html).csrfToken;
  assert.equal((await user.call('/crm/parser/api/refresh', { json: {}, headers: { 'x-csrf-token': csrf } })).status, 202);
  assert.equal(app.refreshes, 1);
  assert.equal((await user.call('/crm/parser/api/refresh', { json: {}, headers: { 'x-csrf-token': 'invalid' } })).status, 403);
  assert.equal((await user.call('/crm/parser/api/refresh', { json: {}, headers: { 'x-csrf-token': csrf, Origin: 'https://other.test' } })).status, 403);
  assert.equal(app.refreshes, 1);
  assert.equal((await user.call('/crm/parser/api/imports/commit', { json: {}, headers: { 'x-csrf-token': csrf } })).status, 403);
  assert.equal((await user.call('/crm/parser/api/telegram/bsa-webhook', { json: {} })).status, 404);
  assert.equal((await user.call('/crm/parser/web/../../data/private/master.sqlite')).status, 404);
});

test('logout and expiration revoke every parser request, including JSON and assets; a stopped parser leaves a useful CRM screen', async t => {
  const app = await setup(t), user = app.client(), guest = app.client();
  assert.equal((await guest.call('/crm/parser/api/table')).status, 401);
  assert.equal((await guest.call('/crm/parser/web/app.js')).status, 303);
  await user.login('test-owner-password-2026', 'dev');
  const crm = await user.call('/crm');
  await user.call('/crm/logout', { form: { csrf: crm.html.match(/name="csrf" value="([^"]+)"/)[1] } });
  assert.equal((await user.call('/crm/parser/api/session')).status, 401);
  await user.login(); app.expire();
  assert.equal((await user.call('/crm/parser/')).status, 303);
  assert.equal((await user.call('/crm/parser/api/table')).status, 401);
  assert.equal((await user.call('/crm/parser/web/styles.css')).status, 303);
  await user.login(); await app.stopParser();
  const offline = await user.call('/crm/parser/');
  assert.equal(offline.status, 503); assert.match(offline.html, /class="sidebar"/);
  assert.match(offline.html, /Повторить/);
  const apiOffline = await user.call('/crm/parser/api/table');
  assert.equal(apiOffline.status, 503); assert.match(JSON.parse(apiOffline.html).error, /временно недоступен/);
});

test('login destinations cannot leave CRM, and parser targets cannot access external hosts or private endpoints', () => {
  assert.equal(staffDestination('dev'), '/crm/parser/');
  assert.equal(staffDestination('/crm/parser/web/avito.html?q=air'), '/crm/parser/web/avito.html?q=air');
  for (const path of ['https://evil.test', '//evil.test', '/crm/../account', '/crm/../../evil', '/crm/login', '/crm/logout', '/crm/parser/api/table', '/crm\\evil', '/crm%2F..%2Faccount']) assert.equal(staffDestination(path), '/crm');
  assert.equal(parserOrigin({ STORE_DEV_URL: 'http://127.0.0.1:4174/api/table' }), 'http://127.0.0.1:4174');
  for (const url of ['https://127.0.0.1', 'http://example.org', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/private', 'http://127.0.0.1?url=private']) assert.throws(() => parserOrigin({ STORE_PARSER_ORIGIN: url }));
});
