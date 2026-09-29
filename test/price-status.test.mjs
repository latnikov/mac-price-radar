import test from 'node:test';
import assert from 'node:assert/strict';
test('Avito without first live slice is not reported as a successful update', () => {
  const summary = priceStatus({ state: 'ready', avito: { state: 'not_configured' } }, []);
  assert.equal(summary.tone, 'warning');
  assert.match(summary.detail, /доступ к объявлениям ещё не подтверждён/);
  assert.doesNotMatch(summary.detail, /предыдущие цены сохранены/);
});
import { priceStatus } from '../web/price-status.js';
const now = Date.parse('2026-09-26T08:00:00Z');
const offer = (retailer, validFrom) => ({ retailer, validFrom });
const failed = (retailer, eligibleMessages = 0) => ({ retailer, status: 'failed', counts: { eligibleMessages }, error: 'Покрытие упало более чем на 50%; сохранены предыдущие цены' });
const status = { state: 'degraded', sources: [failed('BSA'), failed('Дима')], error: 'BSA: Покрытие упало более чем на 50%', autoRefreshIntervalMs: 3600000, nextRefreshAt: '2026-09-26T08:51:10Z' };
test('combines yesterday procurement failures and the next update into one readable status', () => {
  const value = priceStatus(status, [offer('BSA', '2026-09-25'), offer('Дима', '2026-09-25')], now);
  assert.equal(value.title, 'Закупочные цены — за вчера');
  assert.match(value.detail, /Свежие прайсы BSA и Димы пока не получены/);
  assert.equal(value.schedule, 'Автообновление каждый час · следующее в 11:51 мск');
  assert.doesNotMatch(JSON.stringify(value), /Покрытие|50%/);
});
test('does not claim all saved prices are from yesterday when older prices remain', () => {
  const value = priceStatus(status, [offer('BSA', '2026-09-25'), offer('Дима', '2026-09-23')], now);
  assert.equal(value.title, 'Закупочные цены — за вчера и ранее');
});
test('distinguishes partially stale procurement from entirely stale procurement', () => {
  const value = priceStatus({}, [offer('BSA', '2026-09-26'), offer('Дима', '2026-09-25')], now);
  assert.equal(value.title, 'Часть закупочных цен — за вчера');
  assert.doesNotMatch(value.detail, /Свежие прайсы BSA/);
});
test('uses Moscow day boundaries and price validity before fetch time', () => {
  const value = priceStatus({}, [{ ...offer('BSA', '2026-09-25'), fetchedAt: '2026-09-25T22:00:00Z' }], Date.parse('2026-09-25T22:30:00Z'));
  assert.equal(value.title, 'Закупочные цены — за вчера');
});
test('handles a procurement failure without assuming prices are yesterday', () => {
  const value = priceStatus(status, [], now);
  assert.equal(value.title, 'Закупочные цены обновились не полностью');
  assert.doesNotMatch(value.detail, /вчера/);
});
test('keeps retail failures visible alongside old procurement prices', () => {
  const value = priceStatus({ ...status, sources: [...status.sources, failed('BigGeek')] }, [offer('BSA', '2026-09-25')], now);
  assert.match(value.detail, /Не обновились: BigGeek/);
});
test('running collection preserves procurement freshness and real progress', () => {
  const value = priceStatus({ state: 'running', completed: 3, total: 12 }, [offer('BSA', '2026-09-25')], now);
  assert.equal(value.tone, 'loading');
  assert.match(value.detail, /3 из 12/);
  assert.match(value.detail, /за вчера/);
});
test('healthy, unknown-date and interrupted states do not invent freshness', () => {
  assert.equal(priceStatus({}, [offer('BSA', '2026-09-26')], now).tone, 'success');
  assert.equal(priceStatus({}, [offer('BSA', 'invalid')], now).title, 'Дата части закупочных цен неизвестна');
  assert.equal(priceStatus({ state: 'interrupted' }, [], now).title, 'Обновление цен не завершилось');
  assert.doesNotMatch(priceStatus(status, [], Date.parse('2026-09-27')).schedule, /следующее/);
});
