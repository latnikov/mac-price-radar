import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { openShopStore } from '../core.mjs';
import { openInbox } from '../inbox.mjs';
import { importAvitoInbox, createAvitoInboxApi } from '../avito-inbox.mjs';
import { inboxDialog } from '../inbox-views.mjs';
import { createShopService } from '../server.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crm-inbox-'));
  const store = openShopStore(join(dir, 'shop.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, inbox: openInbox(store) };
}

test('same remote chat/message IDs from two accounts never merge; retries keep notes and deduplicate history', t => {
  const { inbox } = setup(t);
  const a = inbox.saveAccount('avito', '1', 'Первый'), b = inbox.saveAccount('avito', '2', 'Второй');
  const d1 = inbox.saveDialog(a.id, { id: 'same', title: 'Клиент', unread: true });
  const d2 = inbox.saveDialog(b.id, { id: 'same', title: 'Клиент', unread: false });
  inbox.saveMessages(d1.id, [{ id: 'same-message', direction: 'in', body: 'Первый', createdAt: 100 }]);
  inbox.saveMessages(d2.id, [{ id: 'same-message', direction: 'in', body: 'Второй', createdAt: 100 }]);
  inbox.edit(d1.id, { note: 'Важная заметка', segment: 'VIP' }, 'owner');
  inbox.saveDialog(a.id, { id: 'same', unread: false });
  inbox.saveMessages(d1.id, [{ id: 'same-message', direction: 'in', body: 'Первый исправлен', createdAt: 100 }]);
  assert.notEqual(d1.id, d2.id);
  assert.equal(inbox.messages(d1.id).length, 1);
  assert.equal(inbox.messages(d1.id)[0].body, 'Первый исправлен');
  assert.equal(inbox.messages(d2.id)[0].body, 'Второй');
  assert.equal(inbox.dialog(d1.id).note, 'Важная заметка');
  assert.equal(inbox.list({ unread: true }).length, 0);
});

test('all chat and message pages imported, read and unread retained without read-mark requests', async t => {
  const { store, inbox } = setup(t);
  const pages = [], historyPages = [];
  const api = {
    account: async () => ({ id: 1 }),
    chats: async (_id, offset) => {
      pages.push(offset);
      return offset === 0 ? { chats: [{ id: 'read', updated: 1, last_message: { id: 'r', direction: 'in', read: true, created: 1, type: 'text', content: { text: 'read' } } }], meta: { has_more: true } }
        : { chats: [{ id: 'unread', updated: 2, last_message: { id: 'u', direction: 'in', read: false, created: 2, type: 'text', content: { text: 'unread' } } }], meta: { has_more: false } };
    },
    history: async (_id, chat, offset) => {
      historyPages.push([chat, offset]);
      return { messages: [{ id: `${chat}-${offset}`, direction: 'in', created: offset + 1, type: 'text', content: { text: 'history' } }], meta: { has_more: offset === 0 } };
    },
  };
  const result = await importAvitoInbox(store, inbox, api);
  assert.equal(result.complete, true);
  assert.deepEqual(pages, [0, 1]);
  assert.equal(historyPages.length, 4);
  assert.equal(inbox.list().length, 2);
  assert.equal(inbox.list({ unread: true }).length, 1);
  assert.ok(inbox.list().every(d => d.history_complete));
  await importAvitoInbox(store, inbox, api);
  assert.equal(inbox.messages(inbox.list()[0].id).length, 3);
});

test('tariff failure preserves chat list and records incomplete history rather than claiming success', async t => {
  const { store, inbox } = setup(t);
  const api = { account: async () => ({ id: 1 }), chats: async () => ({ chats: [{ id: 'x' }], meta: { has_more: false } }), history: async () => { throw Error('HTTP 402'); } };
  await assert.rejects(importAvitoInbox(store, inbox, api));
  assert.equal(inbox.accounts()[0].state, 'partial');
  assert.equal(inbox.list()[0].history_complete, 0);
  assert.equal(inbox.list()[0].unread, -1);
  assert.equal(inbox.list({ unread: true }).length, 0);
});

test('uncertain send never repeats; a successful reply uses original account identity', async t => {
  const { inbox } = setup(t);
  const a = inbox.saveAccount('avito', '123', 'Аккаунт');
  const d = inbox.saveDialog(a.id, { id: 'chat' });
  const reply = inbox.draft(d.id, 'Здравствуйте', 'manager');
  let calls = 0;
  const broken = async () => { calls++; throw Error('connection lost'); };
  await assert.rejects(inbox.send(reply, broken, 'manager'), e => e.status === 502);
  await assert.rejects(inbox.send(reply, broken, 'manager'), e => e.status === 409);
  assert.equal(calls, 1); assert.equal(inbox.outgoing(d.id)[0].state, 'unknown');
  const good = inbox.draft(d.id, 'Другой ответ', 'manager');
  await inbox.send(good, async target => { assert.equal(target.account_remote_id, '123'); return { id: 'remote' }; }, 'manager');
  assert.equal(inbox.messages(d.id)[0].body, 'Другой ответ');
  assert.ok(inboxDialog(inbox, inbox.dialog(d.id), { csrf: 'csrf' }).includes('Проверьте отправку'));
});

test('API tariff errors exclude raw payload and credentials', async () => {
  const api = createAvitoInboxApi({ clientId: 'id-secret', clientSecret: 'secret', fetchImpl: async url =>
    url.endsWith('/token') ? new Response(JSON.stringify({ access_token: 'private-token' }))
      : new Response(JSON.stringify({ message: 'secret-private-token' }), { status: 402 }) });
  await assert.rejects(api.account(), e => e.message.includes('402') && !e.message.includes('secret') && !e.message.includes('private-token'));
});

test('inbox requires CRM login, prevents CSRF, supports manager drafts, escapes message HTML', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-inbox-http-'));
  const env = { STORE_ORIGIN: 'http://127.0.0.1:4190', STORE_MANAGER_PASSWORD: 'manager-long-password' };
  const service = createShopService({ env, dbPath: join(dir, 'shop.sqlite'), runWorkers: false });
  await new Promise(r => service.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  // Use the public HTTP boundary with the configured Host, as behind a reverse proxy.
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const call = (path, options = {}) => new Promise((resolve, reject) => {
    const request = httpRequest(base + path, { method: options.method || 'GET', headers: { Host: '127.0.0.1:4190', ...options.headers } }, response => {
      const chunks = [];response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: async () => Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);request.end(options.body?.toString());
  });
  assert.equal((await call('/crm/inbox')).status, 303);
  const account = service.inbox.saveAccount('avito', '1', '<script>account</script>');
  const d = service.inbox.saveDialog(account.id, { id: 'chat', title: '<script>customer</script>' });
  service.inbox.saveMessages(d.id, [{ id: 'm', direction: 'in', body: '<script>message</script>' }]);
  const session = service.store.session();
  const manager = service.store.rotateSession(session, 'manager');
  const headers = { Cookie: `mb_session=${manager.token}` };
  const response = await call(`/crm/inbox/${d.id}`, { headers });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.includes('&lt;script&gt;message&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  const post = body => call(`/crm/inbox/${d.id}/draft`, { method: 'POST', headers: { ...headers, Origin: env.STORE_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  assert.equal((await post({ body: 'Ответ', csrf: 'wrong' })).status, 403);
  assert.equal((await post({ body: 'Ответ', csrf: manager.csrf })).status, 303);
  assert.equal(service.inbox.outgoing(d.id).length, 1);
});
