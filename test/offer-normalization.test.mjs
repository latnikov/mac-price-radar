import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProduct } from '../scripts/offer-normalization.mjs';

const parse = (title, url = 'https://example.test/product') => parseProduct(title, url, 'Test', 70000, '2026-09-15T00:00:00.000Z');

test('keeps both MacBook Neo storage configurations', () => {
  const small = parse('Apple MacBook Neo 13 Early 2026 A18 Pro 6-core, GPU 5-core, 8GB, 256GB, Silver');
  const large = parse('MacBook Neo 13" A18 Pro 6-Core, GPU 5-Core, 8GB, 512GB, Silver');
  assert.deepEqual([small.model, small.cpuCores, small.gpuCores, small.ramGb, small.storageGb], ['MacBook Neo 13"', 6, 5, 8, 256]);
  assert.deepEqual([large.cpuCores, large.gpuCores], [6, 5]);
  assert.equal(large.storageGb, 512);
});

test('normalizes every MacBook Neo color and retailer aliases', () => {
  const samples = [
    ['Silver', 'Серебристый', 'serebristyi-silver'],
    ['Blush', 'Розовый румянец', 'rozovyi-rumianets'],
    ['Indigo', 'Синий индиго', 'sinii-indigo'],
    ['Citrus', 'Жёлтый цитрус', 'zheltyi-tsitrus'],
  ];
  for (const [expected, label, slug] of samples) {
    const offer = parse(`MacBook Neo A18 Pro (6c CPU, 5c GPU) RAM 8 ГБ, SSD 256 ГБ, ${label}`, `https://example.test/${slug}`);
    assert.equal(offer.color, expected);
  }
});

test('accepts compact RAM/storage configurations without merging them', () => {
  assert.equal(parse('MacBook Neo 13 A18 Pro 6c CPU 5c GPU 8/256 Blue').storageGb, 256);
  assert.equal(parse('MacBook Neo 13 A18 Pro 6c CPU 5c GPU 8/512 Yellow').storageGb, 512);
});
