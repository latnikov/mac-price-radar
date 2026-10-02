import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createShopService } from '../server.mjs';

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mb-catalog-redesign-'));
  const origin = 'http://catalog.test';
  const service = createShopService({ env: { STORE_ORIGIN: origin, STORE_REQUESTS_PER_MINUTE: '250' }, dbPath: join(dir, 'shop.sqlite'), runWorkers: false });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  const cookies = new Map();
  const call = (path, form, method = form ? 'POST' : 'GET') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: service.server.address().port, path, method, headers: {
      Host: 'catalog.test', Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      ...(form ? { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        for (const cookie of res.headers['set-cookie'] || []) {
          const [key, value] = cookie.split(';')[0].split('='); cookies.set(key, value);
        }
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, html: bytes.toString(), bytes: bytes.length });
      });
    });
    req.on('error', reject); req.end(form ? new URLSearchParams(form).toString() : undefined);
  });
  const publish = (overrides = {}) => service.store.saveProduct({
    title: 'MacBook Air fixture', specification: 'M5 · 16 ГБ · 512 ГБ', vendor: 'Apple', category: 'MacBook', channels: [],
    configuration: { model: 'MacBook Air 13', chip: 'M5', screenIn: 13, ramGb: 16, storageGb: 512, color: 'Silver', condition: 'new' },
    ...overrides,
  }, { publish: true });
  return { service, call, publish, origin };
}

const decode = text => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const plain = html => decode(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
const productIds = html => [...new Set([...html.matchAll(/href="\/p\/([a-f0-9-]{36})"/g)].map(match => match[1]))];
const linkFor = (html, label) => decode([...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].find(match => plain(match[2]) === label || decode(match[2].match(/<img\b[^>]*alt="([^"]*)"/)?.[1] || '') === label)?.[1] || '');
const lightPage = response => {
  assert.equal(response.status, 200);
  assert.ok(response.bytes < 14000, `HTML and inline styles: ${response.bytes} bytes`);
  assert.doesNotMatch(response.html, /<script\b|<iframe\b|<object\b|<embed\b|rel=["']stylesheet["']|@import\b/i);
  for (const match of response.html.matchAll(/<img\b[^>]*src="([^"]+)"/g)) assert.match(match[1], /^\/brands\/[a-z-]+\.svg$/);
  for (const match of response.html.matchAll(/url\(([^)]+)\)/g)) assert.ok(['https://www.apple.com','https://store.storeimages.cdn-apple.com'].includes(new URL(match[1]).origin));
};

test('catalogue serves the requested story order, shop actions and footer within the 14 KB HTML budget', async t => {
  const { call, publish } = await setup(t);
  for (let i = 0; i < 4; i++) publish({ title: `MacBook Air fixture ${i}` });
  const response = await call('/');
  assert.equal(response.status, 200);
  assert.equal(response.headers['set-cookie'], undefined, 'anonymous browsing should not create a session');
  const stories = response.html.match(/<section\b[^>]*aria-label="Разделы магазина"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  assert.ok(stories, 'story navigation is present');
  assert.deepEqual([...stories.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)].map(match => plain(match[1])), [
    'Личный кабинет', 'Новые Mac mini и Mac Studio', 'MacBook Air', 'MacBook Pro', 'Аксессуары',
  ]);
  assert.equal(linkFor(stories, 'Войти'), '/account/login');
  assert.equal(linkFor(stories, 'Мои заказы'), '/account');
  assert.match(stories, /href="https:\/\/macbookbro\.ru\/order"/);
  const header = response.html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1] || '';
  for (const path of ['/cart', '/account']) assert.ok(header.includes(`href="${path}"`));
  assert.doesNotMatch(response.html, /Избранное|favorites/);
  assert.match(header, /name="q"/);
  assert.match(header, /popovertarget="categories"/);
  assert.match(header, /id="categories" popover/);
  for(const category of ['Ноутбуки','Настольные компьютеры','Аксессуары','Смартфоны'])assert.ok(plain(header).includes(category));
  assert.doesNotMatch(stories,/Лёгкость каждый день|Больше возможностей|Всё, что нужно/);
  assert.match(stories,/<h2>MacBook<br>Pro<\/h2>/);
  assert.doesNotMatch(plain(response.html), /Сравнение|Персональная подборка|Сезонные товары|Новости|Блоги|Обзоры|Вы недавно смотрели/i);
  assert.doesNotMatch(response.html, /header-top|chat-widget|chatbot/i);
  const footer = response.html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)?.[1] || '';
  for (const path of ['/contacts', '/delivery', '/privacy', '/terms']) assert.ok(footer.includes(`href="${path}"`));
  assert.match(plain(footer), /Грузинская, 41а/);
  assert.doesNotMatch(footer, /<h3>Каталог<\/h3>/);
  lightPage(response);
});

test('reviewed brand SVGs load without sessions and cannot expose arbitrary files or accept writes', async t => {
  const { call, service } = await setup(t);
  for (const name of ['apple', 'anker', 'ugreen', 'logitech', 'rayban-meta']) {
    const asset = await call(`/brands/${name}.svg`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['content-type'], 'image/svg+xml');
    assert.match(asset.headers['cache-control'], /max-age/);
    assert.equal(asset.headers['set-cookie'], undefined);
    assert.match(asset.html, /<svg\b/);
    assert.doesNotMatch(asset.html, /<(?:script|style|foreignObject|image)\b|\bon\w+=|\b(?:href|src)=|url\((?!#)/i);
  }
  assert.equal(service.store.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
  const head = await call('/brands/apple.svg', undefined, 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.bytes, 0); assert.ok(Number(head.headers['content-length']) > 0);
  assert.equal((await call('/brands/apple.svg', {}, 'POST')).status, 405);
  for (const path of ['/brands/server.mjs', '/brands/%2fetc%2fpasswd.svg']) assert.equal((await call(path)).status, 404);
});

test('MacBook photographs match family and diagonal and their URLs survive CSS compaction', async () => {
  const { macbookPhotoClass, page, catalogue } = await import('../views.mjs');
  for (const [family, size] of [['air', 13], ['air', 15], ['pro', 14], ['pro', 16], ['neo', 13]])
    assert.equal(macbookPhotoClass({ family, configuration: { screenIn: size } }), family + size);
  assert.equal(macbookPhotoClass({ title: 'USB-C charger' }), '');
  const html = page('Каталог', catalogue([['air',13],['air',15],['pro',14],['pro',16],['neo',13]].map(([family,size])=>({family,configuration:{screenIn:size},id:'photo',title:'MacBook',specification:'',priceRub:0}))));
  const urls = [...html.matchAll(/url\(([^)]+)\)/g)].map(m => m[1]);
  assert.equal(urls.length, 5);
  for (const url of urls) { assert.ok(['https://www.apple.com','https://store.storeimages.cdn-apple.com'].includes(new URL(url).origin)); assert.ok(url.endsWith('.jpg') || new URL(url).searchParams.get('fmt') === 'png-alpha'); }
});

test('family, brand, category and search filters select real products and survive pagination', async t => {
  const { call, publish, origin } = await setup(t);
  const vendor = 'Fixture & "Brand"', category = 'Test MacBooks', q = 'matched';
  const selected = Array.from({ length: 6 }, (_, i) => publish({ title: `MacBook Air matched ${i}`, vendor, category }));
  const otherVendor = publish({ title: 'MacBook Air matched other vendor', vendor: 'Other fixture', category });
  publish({ title: 'MacBook Air different search', vendor, category });
  publish({ title: 'MacBook Air matched other category', vendor, category: 'Other category' });
  publish({ title: 'MacBook Pro matched', vendor, category, configuration: { model: 'MacBook Pro 14', chip: 'M5', screenIn: 14, ramGb: 16, storageGb: 1024, color: 'Silver', condition: 'new' } });
  const query = new URLSearchParams({ family: 'air', vendor, category, q });
  const first = await call('/?' + query);
  assert.equal(first.status, 200);
  const ids = productIds(first.html);
  assert.equal(ids.length, 4);
  assert.ok(ids.every(id => selected.some(product => product.id === id)));
  const next = new URL(linkFor(first.html, 'Дальше →'), origin);
  assert.equal(next.pathname, '/');
  for (const [key, value] of query) assert.equal(next.searchParams.get(key), value, `${key} survives the next-page link`);
  assert.equal(next.searchParams.get('p'), '2');
  const second = await call(next.pathname + next.search);
  assert.equal(second.status, 200);
  const otherIds = productIds(second.html);
  assert.equal(otherIds.length, 2);
  assert.deepEqual(new Set([...ids, ...otherIds]), new Set(selected.map(product => product.id)));
  const previous = new URL(linkFor(second.html, '← Назад'), origin);
  for (const [key, value] of query) assert.equal(previous.searchParams.get(key), value);
  assert.equal(previous.searchParams.get('p'), '1');
  const brands = first.html.match(/<section\b[^>]*aria-label="Бренды"[^>]*>([\s\S]*?)<\/section>/)?.[1] || '';
  for(const name of ['Apple','Anker','UGREEN','Logitech','Ray-Ban Meta'])assert.equal(new URL(linkFor(brands,name),origin).searchParams.get('vendor'),name);
  const apple=publish({title:'MacBook Air Apple'});
  const brand = new URL(linkFor(brands, 'Apple'), origin);
  const brandPage = await call(brand.pathname + brand.search);
  assert.equal(brandPage.status, 200);
  assert.deepEqual(productIds(brandPage.html),[apple.id]);

});

test('escaped maximum-length catalogue query parameters remain safe and below 14 KB over HTTP', async t => {
  const { call } = await setup(t);
  const q = ('\"><script>alert(1)</script>&').repeat(4).slice(0, 80);
  const params = new URLSearchParams({ q, vendor: '"&'.repeat(25), category: '<>'.repeat(20), family: 'x'.repeat(10), p: '2' });
  const response = await call('/?' + params);
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.html, /<script>/i);
  const input = response.html.match(/<input\b[^>]*name="q"[^>]*value="([^"]*)"/);
  assert.ok(input, 'search preserves the escaped query');
  assert.equal(decode(input[1]), q);
  const previous = new URL(linkFor(response.html, '← Назад'), 'http://catalog.test');
  for (const [key, value] of params) assert.equal(previous.searchParams.get(key), key === 'p' ? '1' : value);
  lightPage(response);
});

test('accessory story reaches a usable enquiry form and submits a real CRM request', async t => {
  const { call, service, publish } = await setup(t);
  publish();
  const catalogue = await call('/?' + new URLSearchParams({ category: 'Аксессуары' }));
  assert.equal(catalogue.status, 200);
  assert.deepEqual(productIds(catalogue.html), [], 'MacBooks must not appear as accessories');
  const href = linkFor(catalogue.html, 'Оставить заявку →');
  assert.equal(new URL(href, 'http://catalog.test').pathname, '/request');
  const requestUrl = new URL(href, 'http://catalog.test');
  const form = await call(requestUrl.pathname + requestUrl.search);
  assert.equal(form.status, 200);
  assert.match(form.html, /<textarea\b[^>]*name="description"[^>]*>Аксессуары<\/textarea>/);
  assert.doesNotMatch(plain(form.html), /Какой MacBook вы ищете/);
  const token = form.html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(token);
  const description = 'Аксессуары: адаптер USB-C для MacBook';
  const submitted = await call('/request', { csrf: token, description, phone: '+7 999 123-45-67', name: 'Тест каталога', consent: 'on' });
  assert.equal(submitted.status, 200);
  assert.match(plain(submitted.html), /Запрос получен/);
  const deals = service.store.db.prepare('SELECT title FROM deals').all();
  assert.equal(deals.length, 1);
  assert.equal(deals[0].title, description);
});

test('full permitted product text and escaped catalogue previews stay within the raw byte budget', async () => {
  const { page, catalogue, productView } = await import('../views.mjs');
  const s = { csrf: 'x'.repeat(43) };
  const p = { id: 'a'.repeat(36), title: '&'.repeat(120), specification: '&'.repeat(200), description: '&'.repeat(800), warranty: '&'.repeat(80), priceRub: null, photos: ['a.jpg'] };
  // Exactly the existing 6,000-byte publication budget after escaping fields.
  const detail = page(p.title, productView(p, s), { cart: 40 });
  assert.ok(Buffer.byteLength(detail) < 14000, `complete product: ${Buffer.byteLength(detail)}`);
  const home = page('Компьютеры', catalogue(Array(4).fill(p), { total: 100, brands: Array.from({ length: 6 }, (_, i) => '漢'.repeat(49) + i) }), { cart: 40 });
  assert.ok(Buffer.byteLength(home) < 14000, `complete catalogue: ${Buffer.byteLength(home)}`);
  const description = 'class="primary" and .product-detail should remain ordinary customer text.';
  const literal = page('Товар', productView({ ...p, description }, s));
  assert.ok(literal.includes(description), 'style compaction must not rewrite content');
});
