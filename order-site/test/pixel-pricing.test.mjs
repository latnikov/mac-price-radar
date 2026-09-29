import test from 'node:test';
import assert from 'node:assert/strict';
import { convertPixelCustomerTotal } from '../pixel-pricing.mjs';
const configuration = { model: 'pixel', phone: 'pixel-11', storage: 256 };
test('approved Pixel customer totals follow the same currency adjustment and rounding as Mac', () => {
  // Arithmetic fixture only, not a production customer price.
  assert.equal(convertPixelCustomerTotal(configuration, { 'pixel-11:256': 1000 }, 84.578, 4), 88578);
  assert.equal(convertPixelCustomerTotal(configuration, { 'pixel-11:256': 999.99 }, 84.578, 4), 88577);
  assert.equal(convertPixelCustomerTotal(configuration, {}, 84.578, 4), null);
  assert.equal(convertPixelCustomerTotal({ ...configuration, storage: 512 }, { 'pixel-11:256': 1000 }, 84.578, 4), null);
  for (const total of [null, 0, -1, NaN, Infinity, '1000', Number.MAX_VALUE]) {
    assert.throws(() => convertPixelCustomerTotal(configuration, { 'pixel-11:256': total }, 84.578, 4));
  }
});
