// Synthetic contract fixtures, not a capture of the live Avito site.
export const at = '2026-09-26T12:00:00.000Z';
export const search = 'https://www.avito.ru/nizhniy_novgorod/noutbuki?q=macbook';
export const url = id => `https://www.avito.ru/nizhniy_novgorod/noutbuki/macbook_${id}`;
export const record = (overrides = {}) => ({ id: '1234567890', url: url('1234567890'), title: 'MacBook Air 13 M4 16/256 Silver б/у',
  price: 100000, priceType: 'full', priceText: '100 000 ₽', currency: 'RUB', city: 'Нижний Новгород', condition: 'Б/у',
  seller: { id: 'independent-person', name: 'Алексей', type: 'private' }, observedAt: at, ...overrides });
export const searchPage = (ids, total = ids.length, next = '') => `<html><head><title>MacBook</title></head><body><span data-marker="page-title/count">${total}</span>
  ${ids.map(id => `<div data-marker="item"><a data-marker="item-title" href="${url(id)}">MacBook Air 13 M4 16/256 Silver</a><meta itemprop="price" content="100000"><div data-marker="item-address">Нижний Новгород</div></div>`).join('')}
  ${next ? `<a data-marker="pagination-button/next" href="${next.replaceAll('&', '&amp;')}">Далее</a>` : ''}</body></html>`;
export const detailPage = (seller = 'Магазин техники', condition = 'Новое') => `<html><head><title>MacBook</title></head><body>
  <h1 data-marker="item-view/title-info">MacBook Air 13 M4 16/256 Silver новый</h1>
  <meta itemprop="price" content="100000"><meta itemprop="priceCurrency" content="RUB"><span data-marker="item-view/item-price">100 000 ₽</span>
  <div data-marker="item-view/item-address">Нижний Новгород, центр</div>
  <div data-marker="seller-info/name"><a href="/brands/independent-shop">${seller}</a></div>
  <ul data-marker="item-view/item-params"><li>Состояние: ${condition}</li><li>Цвет: Silver</li></ul>
  <div data-marker="item-view/item-description">Новый, запечатанный.</div></body></html>`;
export const snapshot = (listings, overrides = {}) => ({ schemaVersion: 1, scope: 'avito-nizhny-macbook', startedAt: at, completedAt: at,
  complete: true, discovered: listings.length, expectedTotal: listings.length, pages: 1, listings, failures: [], ...overrides });
