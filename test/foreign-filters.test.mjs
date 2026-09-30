import test from 'node:test';
import assert from 'node:assert/strict';
import { foreignSpecs, foreignModelLabel, foreignBadges, selectForeignPage, matchesForeignRow, emptyForeignFilters } from '../web/foreign-filters.js';

const air = { category: 'Mac', model: 'M5 MacBook Air 15-inch', configuration: 'M5, 16GB, 512GB, Sky Blue', guideUrl: 'https://prices.appleinsider.com/macbook-air-15-inch-m5', rub: 123711 };
test('foreign specifications distinguish memory, storage, size and compound colors', () => {
  assert.deepEqual(foreignSpecs(air), { family: 'air', chip: 'M5', screen: '15″', ram: '16', storage: '512', cpu: '', gpu: '', display: '', color: 'Sky Blue', connection: '' });
  const max = { ...air, model: 'M5 Pro & M5 Max MacBook Pro 14-inch', guideUrl: 'https://prices.appleinsider.com/macbook-pro-14-inch-m5-pro', configuration: 'M5 Max, 18C CPU, 32C GPU, 36GB, 2TB, Silver' };
  assert.equal(foreignSpecs(max).chip, 'M5 Max');
  assert.equal(foreignSpecs(max).storage, '2048');
  assert.equal(foreignSpecs(max).ram, '36');
  assert.equal(foreignSpecs(max).screen, '14″');
  assert.equal(foreignSpecs(max).cpu, '18');
  assert.equal(foreignSpecs(max).gpu, '32');
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

test('Mac capacities respect explicit labels and never use a lone RAM amount as storage', () => {
  const reversed = foreignSpecs({ ...air, configuration: 'M5, 1TB SSD, 24GB Unified Memory, Silver' });
  assert.equal(reversed.ram, '24'); assert.equal(reversed.storage, '1024');
  const prefixes = foreignSpecs({ ...air, configuration: 'M5, SSD: 2TB, RAM: 32GB' });
  assert.equal(prefixes.ram, '32'); assert.equal(prefixes.storage, '2048');
  const adjacent = foreignSpecs({ ...air, configuration: 'M5 16GB RAM 512GB SSD' });
  assert.equal(adjacent.ram, '16'); assert.equal(adjacent.storage, '512');
  const ramOnly = foreignSpecs({ ...air, configuration: 'M5, 16GB RAM' });
  assert.equal(ramOnly.ram, '16'); assert.equal(ramOnly.storage, '');
  const diskOnly = foreignSpecs({ ...air, configuration: '512GB SSD' });
  assert.equal(diskOnly.ram, ''); assert.equal(diskOnly.storage, '512');
});

test('hardware badges and filters distinguish CPU/GPU bins, display finishes and Ethernet options', () => {
  const standard = { ...air, configuration: 'M5, 10-core CPU, 8-core GPU, 16GB RAM, 512GB SSD, Standard Glass, Silver' };
  const nano = { ...standard, configuration: 'M5, 10C CPU, 10C GPU, 16GB, 512GB, Nano-texture Display, Silver' };
  assert.equal(foreignSpecs(standard).cpu, '10'); assert.equal(foreignSpecs(standard).gpu, '8');
  assert.equal(foreignSpecs(standard).display, 'Standard'); assert.equal(foreignSpecs(nano).display, 'Nano-texture');
  assert.ok(matchesForeignRow(nano, { ...emptyForeignFilters(), gpu: '10', display: 'Nano-texture' }));
  assert.ok(!matchesForeignRow(standard, { ...emptyForeignFilters(), gpu: '10' }));
  assert.ok(!matchesForeignRow(standard, { ...emptyForeignFilters(), display: 'Nano-texture' }));
  assert.deepEqual(foreignBadges(nano).filter(badge => ['cpu', 'gpu', 'display'].includes(badge.key)), [
    { key: 'cpu', value: '10', label: 'CPU 10' }, { key: 'gpu', value: '10', label: 'GPU 10' }, { key: 'display', value: 'Nano-texture', label: 'Нанотекстура' },
  ]);
  const mini = { ...air, model: 'Mac mini M6, M5 Pro', guideUrl: 'https://prices.appleinsider.com/mac-mini-m6', configuration: 'M6, 16GB, 512GB, 10GbE' };
  assert.equal(foreignSpecs(mini).connection, '10GbE');
  assert.equal(foreignSpecs({ ...mini, configuration: '16GB, 512GB' }).chip, '');
  assert.equal(foreignSpecs({ ...mini, configuration: 'M6, 16GB, 512GB' }).connection, '');
});

test('missing Neo specifications and accessory chips remain unknown; iPad chip can come from its model', () => {
  const neo = { ...air, model: 'MacBook Neo', guideUrl: 'https://prices.appleinsider.com/macbook-neo', configuration: '256GB MacBook Neo, Blush' };
  const specs = foreignSpecs(neo);
  assert.equal(specs.chip, ''); assert.equal(specs.screen, ''); assert.equal(specs.ram, ''); assert.equal(specs.storage, '256');
  assert.deepEqual(foreignBadges(neo).map(badge => badge.key), ['storage', 'color']);
  assert.equal(foreignBadges(neo)[0].label, 'SSD 256 GB');
  const ipad = { ...air, category: 'iPad', model: 'M4 iPad Pro 11-inch', guideUrl: 'https://prices.appleinsider.com/ipad-pro-11-inch-2024', configuration: '256GB, Wi-Fi, Silver' };
  assert.equal(foreignSpecs(ipad).chip, 'M4');
  assert.equal(foreignBadges(ipad).find(badge => badge.key === 'storage').label, '256 GB');
  assert.equal(foreignSpecs({ ...ipad, configuration: 'Apple Pencil Pro' }).chip, '');
  assert.equal(foreignSpecs({ ...ipad, configuration: 'Apple Magic Keyboard for 11-inch iPad Pro M4, Black' }).chip, '');
  assert.equal(foreignSpecs({ ...ipad, category: 'Vision Pro', model: 'Apple Vision Pro Accessories', configuration: 'ANNAPRO A2 Head Strap' }).chip, '');
  assert.equal(foreignModelLabel(air), 'MacBook Air');
  assert.equal(foreignModelLabel(ipad), 'M4 iPad Pro 11-inch');
});

test('configuration pages sort by family, numeric chip generation and hardware without merging variants', () => {
  const row = (configuration, id, extra = {}) => ({ ...air, configuration, id, ...extra });
  const rows = [
    row('M5, 16GB, 512GB, Silver', 'm5'),
    row('M10, 16GB, 512GB, Silver', 'm10'),
    row('M5 Max, 18C CPU, 32C GPU, 36GB, 1TB, Standard Display, Silver', 'pro-standard', { model: 'M5 Pro & M5 Max MacBook Pro 14-inch', guideUrl: 'https://prices.appleinsider.com/macbook-pro-14-inch-m5-pro' }),
    row('M5 Max, 18C CPU, 32C GPU, 36GB, 1TB, Nano-texture Display, Silver', 'pro-nano', { model: 'M5 Pro & M5 Max MacBook Pro 14-inch', guideUrl: 'https://prices.appleinsider.com/macbook-pro-14-inch-m5-pro' }),
    row('M5, 16GB, 512GB, Silver', 'mini', { model: 'Mac mini', guideUrl: 'https://prices.appleinsider.com/mac-mini-m5' }),
  ];
  const first = selectForeignPage(rows, { pageSize: 2 });
  assert.deepEqual(first.rows.map(row => row.id), ['m10', 'm5']);
  assert.equal(first.total, 5); assert.equal(first.pages, 3); assert.equal(first.start, 1); assert.equal(first.end, 2);
  const last = selectForeignPage(rows, { pageSize: 2, page: 100 });
  assert.deepEqual(last.rows.map(row => row.id), ['mini']); assert.equal(last.page, 3); assert.equal(last.start, 5); assert.equal(last.end, 5);
  assert.equal(first.allRows.filter(row => row.id.startsWith('pro-')).length, 2);
  assert.deepEqual(rows.map(row => row.id), ['m5', 'm10', 'pro-standard', 'pro-nano', 'mini']);
  const tiers = selectForeignPage(['M5 Ultra', 'M5 Max', 'M5 Pro', 'M5'].map(chip => row(`${chip}, 16GB, 512GB`, chip)));
  assert.deepEqual(tiers.rows.map(row => row.id), ['M5', 'M5 Pro', 'M5 Max', 'M5 Ultra']);
});

test('price pages use configuration for ties, keep missing prices last and preserve identical row order', () => {
  const m4 = { ...air, configuration: 'M4, 16GB, 512GB', rub: 100, id: 'm4' };
  const m5 = { ...m4, configuration: 'M5, 16GB, 512GB', id: 'm5' };
  const unknown = { ...m5, rub: null, id: 'unknown' };
  const expensive = { ...m4, rub: 200, id: 'expensive' };
  const input = [unknown, m4, expensive, m5];
  assert.deepEqual(selectForeignPage(input, { sort: 'price' }).rows.map(row => row.id), ['m5', 'm4', 'expensive', 'unknown']);
  assert.deepEqual(selectForeignPage(input, { sort: 'price-down' }).rows.map(row => row.id), ['expensive', 'm5', 'm4', 'unknown']);
  const identical = [{ ...m4, mark: 1 }, { ...m4, mark: 2 }];
  assert.deepEqual(selectForeignPage(identical).rows.map(row => row.mark), [1, 2]);
  const empty = selectForeignPage([], { page: -1, pageSize: 0 });
  assert.deepEqual(empty.rows, []); assert.equal(empty.page, 1); assert.equal(empty.start, 0); assert.equal(empty.end, 0);
});
