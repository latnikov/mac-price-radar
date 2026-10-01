import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PHONE_FAMILIES, productFamily, productScreen, configurationBadges } from '../web/product-families.js';

test('all requested iPhone families have independent selection and storage/SIM badges', () => {
  for (const [key, model] of Object.entries(PHONE_FAMILIES)) {
    const offer = { model, storageGb: 1000, simType: 'SIM + eSIM', keyboard: 'not_applicable' };
    assert.equal(productFamily(offer), key);
    assert.equal(productScreen(offer), null);
    assert.deepEqual(configurationBadges(offer), ['1 TB', 'SIM + eSIM']);
  }
  assert.equal(productFamily({ model: 'MacBook Pro 14"' }), 'pro');
  assert.deepEqual(configurationBadges({ model: 'MacBook Pro 14"', chip: 'M5', ramGb: 16, storageGb: 512 }), ['14″', 'M5', 'RAM 16 GB', 'SSD 512 GB']);
  assert.deepEqual(configurationBadges({ model: 'iPhone 17 Pro', storageGb: 256, simType: 'unknown', chip: 'unknown' }), ['256 GB', 'SIM не указан']);
});

test('both Russian price sheets expose every phone family and a SIM control', async () => {
  for (const filename of ['index.html', 'avito.html']) {
    const html = await readFile(new URL(`../web/${filename}`, import.meta.url), 'utf8');
    for (const key of Object.keys(PHONE_FAMILIES)) assert.ok(html.includes(`data-value="${key}"`), `${filename}: ${key}`);
    assert.ok(html.includes('id="sim-options"'));
  }
});
