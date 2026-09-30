import test from 'node:test';
import assert from 'node:assert/strict';
import { readView, writeView, searchTerms, offerSearchText, matchesSearch } from '../web/view-state.js';

test('shared view restores all filters, query, range and sorting without a server path', () => {
  const view = readView('#family=air&chip=M5&ram=16&ssd=512&screen=13&color=Silver&stock=in&q=Air+M5&min=90000&max=150000&sort=price-up');
  assert.deepEqual(readView(writeView(view)), view);
  assert.equal(view.filters.ram, '16');
  assert.equal(view.query, 'Air M5');
  assert.equal(writeView(readView('')), '');
  assert.equal(readView('#q=MDH74').filters.family, '*');
});

test('malformed links cannot inject fields or invalid numeric filters', () => {
  const view = readView('#family=invalid&ram=-1&min=Infinity&max=100000000000&sort=unknown&stock=unknown&token=secret');
  assert.equal(view.filters.family, null);
  assert.equal(view.filters.ram, '');
  assert.equal(view.min, ''); assert.equal(view.max, ''); assert.equal(view.sort, 'model');
  assert.equal(writeView(view).includes('secret'), false);
  assert.equal(readView('#q=' + 'a'.repeat(1000)).query.length, 120);
});

test('search matches article, hardware and seller across casing and punctuation', () => {
  const text = offerSearchText({ title: 'MacBook Air MDH74', chip: 'M5', ramGb: 16, storageGb: 1024, color: 'Silver', retailer: 'Айфория' });
  for (const query of ['air m5 16', 'mdh74', '1 ТБ silver', 'АЙФОРИЯ', 'air/m5']) assert.equal(matchesSearch(text, searchTerms(query)), true, query);
  assert.equal(matchesSearch(offerSearchText({ storageGb: 1000 }), searchTerms('1 ТБ')), true);
  assert.equal(matchesSearch(text, searchTerms('air 512')), false);
  assert.equal(matchesSearch(text, searchTerms('')), true);
});

test('old focus, layout and spread links no longer hide prices', () => {
  const view = readView('#family=*&chip=*&focus=opportunities&layout=compact&sort=spread');
  assert.equal(view.sort, 'model');
  assert.equal(writeView(view), '#family=*&chip=*');
});

test('chip phrases distinguish M5 Pro from a Pro laptop with M5 Max or M5 inside its article', () => {
  const terms = searchTerms('m5 pro');
  assert.equal(matchesSearch(offerSearchText({ model: 'MacBook Pro', chip: 'M5 Pro' }), terms), true);
  assert.equal(matchesSearch(offerSearchText({ model: 'MacBook Pro', chip: 'M5 Max' }), terms), false);
  assert.equal(matchesSearch(offerSearchText({ model: 'MacBook Pro', chip: 'M3 Max', article: 'Z1AZ000M5' }), terms), false);
});

test('Russian aliases, compact chips and typos find the intended hardware without numeric substring matches', () => {
  const offer = offerSearchText({ model: 'MacBook Pro 14"', chip: 'M5 Pro', ramGb: 24, storageGb: 512 });
  for (const query of ['pro 14 m5 pro', 'про 14 м5 про', 'макбук про 14 м 5 про', 'macbok pro 14 m5pro', 'macboook 14 m5 pro']) {
    assert.equal(matchesSearch(offer, searchTerms(query)), true, query);
  }
  for (const query of ['pro 16 m5 pro', 'pro 14 m4 pro', 'pro 14 m5 max', 'pro 14 12']) assert.equal(matchesSearch(offer, searchTerms(query)), false, query);
  assert.equal(matchesSearch(offerSearchText({ model: 'MacBook Pro 16"', chip: 'M5 Pro', sku: 'ABC14XYZ' }), searchTerms('pro 14 m5 pro')), false);
});
