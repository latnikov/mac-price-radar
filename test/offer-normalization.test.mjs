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
    assert.equal(offer.model, 'MacBook Neo 13"');
  }
});

test('accepts compact RAM/storage configurations without merging them', () => {
  assert.equal(parse('MacBook Neo 13 A18 Pro 6c CPU 5c GPU 8/256 Blue').storageGb, 256);
  assert.equal(parse('MacBook Neo 13 A18 Pro 6c CPU 5c GPU 8/512 Yellow').storageGb, 512);
});

test('Technichno detail title takes precedence over stale or mistyped URL specifications', () => {
  const result = parse('MacBook Pro 14 Late 2025 M5 24GB / 1TB Серый космос', 'https://nn.technichno.ru/catalog/mac/16gb-512gb/macbook-pro-14-m5-23gb-1tb-seryy-kosmos/');
  assert.deepEqual([result.ramGb, result.storageGb, result.color], [24, 1000, 'Space Gray']);
  assert.equal(parse('MacBook Air 13 M5 16/1TB Silver').storageGb, 1000);
  assert.equal(parse('MacBook Air 13 M5 16GB 1024GB Silver').storageGb, 1000);
  assert.deepEqual([parse('MacBook Air 13 M5 512GB SSD 24GB RAM Silver').ramGb, parse('MacBook Air 13 M5 512GB SSD 24GB RAM Silver').storageGb], [24, 512]);
});

test('Technichno colors work in full titles and transliterated leaf slugs', () => {
  for (const [suffix, color] of [['nebesno-goluboy', 'Sky Blue'], ['polunochnyy-chernyy', 'Midnight'], ['cerebristyy', 'Silver'], ['seryy-kosmos', 'Space Gray']]) {
    assert.equal(parse('MacBook Air 13 M5 16GB', `https://example.test/macbook-air-13-m5-16gb-512gb-${suffix}/`).color, color);
  }
  assert.equal(parse('MacBook Air 13 M5 16GB / 512GB Небесно голубой').color, 'Sky Blue');
});
