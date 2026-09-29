import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog } from '../catalog.mjs';
import { readSelection, selectionHash } from '../public/selection-link.mjs';

test('every catalog configuration survives a shared link', () => {
  for (const model of catalog.models) for (const chip of model.chips) for (const memory of chip.memory) for (const storage of chip.storage) for (const ethernet of model.ethernet) {
    const configuration = { model: model.id, chip: chip.id, memory, storage, ethernet };
    assert.deepEqual(readSelection(selectionHash(configuration)), configuration);
  }
  for (const phone of catalog.pixelModels) for (const storage of phone.storage) {
    const configuration = { model: 'pixel', phone: phone.id, storage };
    assert.deepEqual(readSelection(selectionHash(configuration)), configuration);
  }
});

test('invalid catalog links fall back safely and links contain no customer data', () => {
  assert.equal(readSelection('#model=mini&chip=m6-12-12&memory=999&storage=256&ethernet=2.5'), null);
  assert.equal(readSelection('#model=pixel&phone=unknown&storage=256'), null);
  assert.equal(readSelection('#model=unknown'), null);
  assert.equal(readSelection(''), null);
  const value = { model: 'mini', chip: 'm6-12-12', memory: 16, storage: 256, ethernet: 2.5 };
  const hash = selectionHash({ ...value, name: 'Private', phone: '+79999999999', consent: true, priceRub: 1 });
  assert.deepEqual(readSelection(hash), value);
  assert.doesNotMatch(hash, /Private|79999999999|consent|priceRub/);
  assert.equal(selectionHash({ model: 'other', description: 'Private custom request' }), '#model=other');
  assert.deepEqual(readSelection('#model=other&description=Private'), { model: 'other' });
});
