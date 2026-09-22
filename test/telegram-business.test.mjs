import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBusinessUpdates, configureBusinessWebhook, ingestBusinessUpdate, pollBusinessUpdates } from '../scripts/telegram-business.mjs';

test('Business API cache accepts direct BSA channel updates and ignores other channels', () => {
  const result = applyBusinessUpdates(null, [
    {
      update_id: 10,
      business_connection: { id: 'connection', user: { id: 42 }, date: 1_800_000_000, is_enabled: true },
    },
    {
      update_id: 11,
      business_message: {
        business_connection_id: 'connection',
        message_id: 501,
        date: 1_800_000_100,
        chat: { id: -1001, type: 'channel', username: 'BigSaleApple' },
        text: '23/09/2026\nMDH74 Air 13 (M5 16/512) Silver-126.500',
      },
    },
    {
      update_id: 12,
      business_message: {
        business_connection_id: 'connection',
        message_id: 99,
        date: 1_800_000_200,
        chat: { id: -1002, type: 'channel', username: 'OtherChannel' },
        text: 'не наш прайс',
      },
    },
  ]);
  assert.equal(result.state.lastUpdateId, 13);
  assert.equal(result.state.businessConnection.isEnabled, true);
  assert.equal(result.state.messages.length, 1);
  assert.equal(result.state.messages[0].id, '501');
});

test('Business API cache accepts a forwarded BSA post and replaces its edited copy', () => {
  const forwarded = text => ({
    business_connection_id: 'connection',
    message_id: 700,
    date: 1_800_000_300,
    chat: { id: 42, type: 'private' },
    forward_origin: {
      type: 'channel',
      chat: { id: -1001, type: 'channel', username: 'BigSaleApple' },
      message_id: 502,
      date: 1_800_000_000,
    },
    text,
  });
  const first = applyBusinessUpdates(null, [{ update_id: 20, business_message: forwarded('23/09/2026\nAir-100.000') }]);
  const edited = applyBusinessUpdates(first.state, [{ update_id: 21, edited_business_message: forwarded('23/09/2026\nAir-99.000') }]);
  assert.equal(edited.state.messages.length, 1);
  assert.equal(edited.state.messages[0].id, '502');
  assert.match(edited.state.messages[0].text, /99\.000/);
});

test('Bot API polling persists BSA messages without persisting the bot token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bsa-business-'));
  const statePath = join(directory, 'state.json');
  const token = '123456:abcdefghijklmnopqrstuvwxyz';
  let request;
  try {
    const result = await pollBusinessUpdates({
      env: { TELEGRAM_BUSINESS_BOT_TOKEN: token },
      statePath,
      fetchImpl: async (url, options) => {
        request = { url, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            update_id: 30,
            message: {
              message_id: 701,
              date: 1_800_000_400,
              chat: { id: 42, type: 'private' },
              forward_origin: {
                type: 'channel',
                chat: { id: -1001, type: 'channel', username: 'BigSaleApple' },
                message_id: 503,
              },
              text: '23/09/2026\nMDH74 Air 13 (M5 16/512) Silver-126.500',
            },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    assert.match(request.url, /\/getUpdates$/);
    assert.ok(request.body.allowed_updates.includes('business_message'));
    assert.ok(request.body.allowed_updates.includes('message'));
    assert.equal(result.state.messages[0].id, '503');
    const saved = await readFile(statePath, 'utf8');
    assert.doesNotMatch(saved, new RegExp(token));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Business webhook ingestion writes a forwarded BSA post', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bsa-webhook-'));
  const statePath = join(directory, 'state.json');
  try {
    const result = await ingestBusinessUpdate({
      update_id: 40,
      business_message: {
        business_connection_id: 'connection',
        message_id: 801,
        date: 1_800_000_500,
        chat: { id: -1001, type: 'channel', username: 'BigSaleApple' },
        text: '23/09/2026\nMDH74 Air 13 (M5 16/512) Silver-126.500',
      },
    }, { statePath });
    assert.equal(result.changed, true);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).messages[0].id, '801');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Webhook setup registers only the expected URL and update types', async () => {
  const calls = [];
  const env = {
    TELEGRAM_BUSINESS_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
    TELEGRAM_BUSINESS_WEBHOOK_URL: 'https://dev.example.test/api/telegram/bsa-webhook',
    TELEGRAM_BUSINESS_WEBHOOK_SECRET: 'secret_for_telegram',
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const result = url.endsWith('/getWebhookInfo')
      ? { url: env.TELEGRAM_BUSINESS_WEBHOOK_URL, pending_update_count: 0 }
      : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await configureBusinessWebhook({ env, fetchImpl });
  assert.equal(result.url, env.TELEGRAM_BUSINESS_WEBHOOK_URL);
  assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), ['setWebhook', 'getWebhookInfo']);
  assert.ok(calls[0].body.allowed_updates.includes('business_connection'));
  assert.equal(calls[0].body.secret_token, env.TELEGRAM_BUSINESS_WEBHOOK_SECRET);
});
