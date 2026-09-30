import test from 'node:test';
import assert from 'node:assert/strict';
import { foreignSpecs, matchesForeignRow, emptyForeignFilters } from '../web/foreign-filters.js';

const air = { category: 'Mac', model: 'M5 MacBook Air 15-inch', configuration: 'M5, 16GB, 512GB, Sky Blue', guideUrl: 'https://prices.appleinsider.com/macbook-air-15-inch-m5', rub: 123711 };
test('foreign specifications distinguish memory, storage, size and compound colors', () => {
  assert.deepEqual(foreignSpecs(air), { family: 'air', chip: 'M5', screen: '15″', ram: '16', storage: '512', color: 'Sky Blue', connection: '' });
  const max = { ...air, model: 'M5 Pro & M5 Max MacBook Pro 14-inch', guideUrl: 'https://prices.appleinsider.com/macbook-pro-14-inch-m5-pro', configuration: 'M5 Max, 18C CPU, 32C GPU, 36GB, 2TB, Silver' };
  assert.equal(foreignSpecs(max).chip, 'M5 Max');
  assert.equal(foreignSpecs(max).storage, '2048');
  assert.equal(foreignSpecs(max).ram, '36');
  assert.equal(foreignSpecs(max).screen, '14″');
});
test('iPad storage is not misclassified as RAM and Watch size retains millimeters', () => {
  const ipad = foreignSpecs({ ...air, category: 'iPad', model: 'M5 iPad Pro 11-inch', guideUrl: 'https://prices.appleinsider.com/ipad-pro-11-inch-m5', configuration: '1TB 11" iPad Pro, M5, Wi-Fi + Cellular, Silver' });
  assert.equal(ipad.ram, ''); assert.equal(ipad.storage, '1024'); assert.equal(ipad.connection, 'Wi-Fi + Cellular');
  const watch = foreignSpecs({ ...air, category: 'Apple Watch', model: 'Apple Watch Series 12', guideUrl: 'https://prices.appleinsider.com/apple-watch-series-12', configuration: '42mm S12 GPS + Cellular, Black Aluminum Case, Black Sport Band S/M' });
  assert.equal(watch.screen, '42 мм'); assert.equal(watch.connection, 'GPS + Cellular');
});
test('button filters combine with price range and Russian search', () => {
  const filters = { ...emptyForeignFilters(), family: 'air', chip: 'M5', ram: '16', storage: '512', color: 'Sky Blue' };
  assert.ok(matchesForeignRow(air, filters, { query: 'эйр м5 16гб', min: '100000', max: '130000' }));
  assert.ok(!matchesForeignRow(air, { ...filters, screen: '13″' }));
  assert.ok(!matchesForeignRow(air, filters, { max: '100000' }));
  assert.ok(!matchesForeignRow(air, { ...filters, category: 'iPhone' }));
  assert.ok(!matchesForeignRow({ ...air, rub: null }, filters, { min: '1' }));
});
