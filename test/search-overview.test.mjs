import test from 'node:test';
import assert from 'node:assert/strict';
import { searchScore, searchTerms, offerSearchText } from '../web/view-state.js';
import { buildPriceTable, prepareTableOffers, selectTablePage, searchOverview } from '../web/price-table.js';
const now = Date.now();
const base = { model: 'MacBook Pro 14"', screenIn: 14, chip: 'M5 Pro', ramGb: 24, storageGb: 1000, color: 'Silver', stock: 'InStock', fetchedAt: new Date(now).toISOString(), retailer: 'iMobile', price: 200000 };
const build = offers => buildPriceTable(prepareTableOffers(offers), { now });

test('exact matches rank before prefix and typo matches across pagination', () => {
  const terms = searchTerms('pro');
  const exact = searchScore(offerSearchText(base), terms);
  const prefix = searchScore('professional', terms);
  const fuzzy = searchScore('por', terms);
  assert.ok(exact > prefix && prefix > fuzzy && fuzzy >= 0);
  const page = selectTablePage([{ key: 'a', offers: [], minimumPrice: 1, searchScore: fuzzy }, { key: 'z', offers: [], minimumPrice: 200, searchScore: exact }], { sort: 'relevance', pageSize: 1 });
  assert.equal(page.rows[0].key, 'z');
  assert.equal(page.pages, 2);
});

test('overview excludes procurement, stale, out-of-stock and Moscow prices; compares same variant once per shop', () => {
  const groups = build([base, { ...base, retailer: 'ReSale', price: 220000 }, { ...base, retailer: 'ReSale', price: 230000 },
    { ...base, retailer: 'Дима', price: 100000 }, { ...base, retailer: 'BigGeek', price: 110000 },
    { ...base, retailer: 'AFM', price: 120000, stock: 'OutOfStock' },
    { ...base, retailer: 'Rebro', price: 130000, fetchedAt: new Date(now - 5 * 3600000).toISOString() },
    { ...base, retailer: 'ReSale', price: 300000, ramGb: 48 }]);
  const overview = searchOverview(groups, now).replace(/\s/g, ' ');
  assert.match(overview, /iMobile — 200 000 ₽/);
  assert.match(overview, /средняя цена — 210 000 ₽/);
  assert.match(overview, /разброс — 20 000 ₽/);
  assert.match(overview, /Всего в выдаче: 2/);
  assert.doesNotMatch(overview, /100 000|110 000|120 000|130 000/);
});

test('overview handles no fresh evidence and tied minima', () => {
  assert.match(searchOverview(build([{ ...base, fetchedAt: '2020-01-01' }]), now), /Свежих цен.*нет/);
  assert.match(searchOverview(build([base, { ...base, retailer: 'ReSale' }]), now), /iMobile, ReSale/);
});
