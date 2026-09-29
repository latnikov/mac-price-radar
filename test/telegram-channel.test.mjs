import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTelegramChannel } from '../scripts/telegram-channel.mjs';
import { telegramSource, telegramSources } from '../scripts/telegram-sources.mjs';
import { applyBusinessUpdates } from '../scripts/telegram-business.mjs';
import { buildPriceTable } from '../web/price-table.js';

const source = telegramSource({ sourceChatId: '-100998877', sourceTitle: 'Новый поставщик' }, {});
const message = (id, text, date = '2026-09-28T10:00:00Z') => ({ id, date, text, ...source });

test('new private channel parses undated forwarded lists using their original date and real post link', () => {
  const result = parseTelegramChannel([message(10, 'MacBook MDHH4 Air 13 Sky Blue (M5, 16GB, 512GB) 2026 116500\nMacBook MGED4 Pro 16 Space Black (M5 Max,36GB,2TB)2026 326000')], source);
  assert.equal(result.offers.length, 2);
  assert.equal(result.offers[0].price, 116500);
  assert.equal(result.offers[0].condition, 'unknown');
  assert.equal(result.offers[0].fetchedAt, '2026-09-28T10:00:00.000Z');
  assert.match(result.offers[0].url, /^https:\/\/t.me\/c\/998877\/10\?item=/);
  assert.equal(result.offers[0].sourceType, 'telegram_channel');
  assert.equal(result.offers[1].storageGb, 2000);
});

test('newer price wins even when higher; different colors and CPU/GPU variants survive', () => {
  const result = parseTelegramChannel([
    message(1, 'MacBook Pro 14 M4 Pro 12 CPU 16 GPU 24GB 512GB Silver — 180000', '2026-09-28T09:00:00Z'),
    message(2, 'MacBook Pro 14 M4 Pro 12 CPU 16 GPU 24GB 512GB Silver — 195000\nMacBook Pro 14 M4 Pro 14 CPU 20 GPU 24GB 512GB Silver — 215000\nMacBook Pro 14 M4 Pro 12 CPU 16 GPU 24GB 512GB Space Black — 196000'),
  ], source);
  assert.equal(result.offers.length, 3);
  assert.deepEqual(result.offers.map(offer => offer.price), [195000, 215000, 196000]);
  const earlier = parseTelegramChannel([message(1, 'MacBook Pro 14 M4 Pro 12 CPU 16 GPU 24GB 512GB Silver — 180000')], source);
  assert.equal(result.offers[0].externalId, earlier.offers[0].externalId);
});

test('channel identity survives title changes and separates identical titles', () => {
  const renamed = telegramSource({ ...source, sourceTitle: 'Новое имя', sourceUsername: 'renamed' }, {});
  assert.equal(renamed.retailer, source.retailer);
  const second = telegramSource({ ...source, sourceChatId: '-100998878' }, {});
  assert.notEqual(second.retailer, source.retailer);
  assert.equal(telegramSource({ sourceChatId: '-1001291236326', sourceUsername: 'renamedBsa' }, {}).retailer, 'BSA');
  assert.equal(telegramSources({ messages: [message(1, '', '2026-09-27'), { ...message(2, ''), sourceTitle: 'Новое имя' }] }, {})[0].sourceTitle, 'Новое имя');
});

test('forward retries preserve original age and cannot undo an edit', () => {
  const update = (updateId, text) => ({ update_id: updateId, message: { message_id: 50, date: 1800005000,
    forward_origin: { type: 'channel', date: 1800000000, chat: { id: -100998877, title: 'Новый поставщик' }, message_id: 10 }, text } });
  const first = applyBusinessUpdates(null, [update(100, 'MacBook Air M5 16/512 — 100000')]);
  assert.equal(first.state.messages[0].date, new Date(1800000000000).toISOString());
  assert.equal(applyBusinessUpdates(first.state, [update(101, 'MacBook Air M5 16/512 — 100000')]).acceptedMessages, 0);
  const edited = applyBusinessUpdates(first.state, [update(102, 'MacBook Air M5 16/512 — 120000')]);
  const retry = applyBusinessUpdates(edited.state, [update(100, 'MacBook Air M5 16/512 — 100000')]);
  assert.match(retry.state.messages[0].text, /120000/);
  assert.equal(retry.acceptedMessages, 0);
});

test('unsupported messages report an empty source, and conditional prices cannot drive analytics', () => {
  const empty = parseTelegramChannel([message(1, 'Чехол MacBook — 12000')], source);
  assert.equal(empty.offers.length, 0);
  assert.match(empty.failures[0], /не найдены/);
  const conditional = parseTelegramChannel([message(2, 'MacBook Air 13 M5 16/512 Silver от 100000')], source);
  assert.ok(conditional.offers[0].qualityWarnings.length);
});

test('new Telegram source participates in procurement analytics and old messages expire', () => {
  const [offer] = parseTelegramChannel([message(2, 'MacBook Air 13 M5 16/512 Silver — 100000')], source).offers;
  const market = ['iMobile', 'Apple Store'].map((retailer, i) => ({ ...offer, sourceType: 'website', retailer, price: 120000 + i * 1000, url: `https://shop.test/${i}` }));
  const [row] = buildPriceTable([offer, ...market], { now: Date.parse('2026-09-28T10:01:00Z') });
  assert.equal(row.offers.length, 3);
  assert.equal(row.analytics.averageRetail, 120500);
  assert.equal(row.offers[0].retailer, source.retailer);
  assert.equal(buildPriceTable([offer, ...market], { now: Date.parse('2026-09-29T10:01:00Z') })[0].analytics.averageRetail, null);
});
