import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverTechnichnoLinks, fetchTechnichnoOffers } from '../scripts/technichno.mjs';

const base = 'https://nn.technichno.ru';
const root = `${base}/catalog/mac/`;
const path = (storage = 256, color = 'serebristyy') => `/catalog/mac/macbook-neo/macbook-neo-13-early-2026-a18-pro/macbook-neo-13-early-2026-a18-pro-8gb-${storage}gb-${color}/`;
const card = href => `<div class="product-card"><a class='product-card__name block_row' href='${href}'><p>MacBook Neo 13 Early 2026 A18 Pro</p></a><span class="product-card-price__current">72&nbsp;990 &#8381;</span></div>`;
const detail = ({ storage = 256, color = 'Серебристый', amount = 72990, currency = 'RUB', stock = 'InStock', links = '', ownPrice = true } = {}) => `
  <div itemscope itemtype="https://schema.org/Product"><meta itemprop="price" content="1"></div>
  <div itemtype='https://schema.org/Product' class='product-details__content' itemscope>
    <span style='display:none' itemprop='name'>MacBook Neo 13 Early 2026 A18 Pro 8GB / ${storage}GB ${color}</span>
    <div style='display:none' itemtype='https://schema.org/Offer' itemscope itemprop='offers'>
      ${ownPrice ? `<meta content='${amount}' itemprop='price'>` : ''}
      <meta content='${currency}' itemprop='priceCurrency'>
      <link href='http://schema.org/${stock}' itemprop='availability'>
    </div>
    <h1 class='product-details__content--info__title'>MacBook Neo 13 Early 2026 A18 Pro 8GB / ${storage}GB ${color}</h1>
    <div class='product-details__content--info__variants'>${links}</div>
    <p>В рассрочку: <span>от 1&nbsp;825 &#8381;</span></p>
    <div itemscope itemtype='https://schema.org/Product'><div itemscope itemtype='https://schema.org/Offer' itemprop='offers'><meta content='123' itemprop='price'></div></div>
  </div>
  <div itemscope itemtype='https://schema.org/Product'><meta itemprop='price' content='42'></div>`;

test('discovers leaf variants with any attribute order, preserving URL casing and pagination only', () => {
  const html = `${card(path())}
    <a href='${path(512)}' class='product_customs__types-item'>512Gb</a>
    <a class='product-details__content--info__variants__colors' href='${path(256, 'Silver')}?utm_source=test#color'>Silver</a>
    <a href='${path()}'>duplicate</a>
    <a href='/catalog/mac/?sort=price&amp;PAGEN_1=2'>Next</a>
    <link href='/catalog/mac/?PAGEN_1=2' rel='next'>
    <a href='/catalog/mac/macbook-neo/'>Category</a>
    <a href='/catalog/mac/macbook-neo/macbook-neo-13-early-2026-a18-pro/'>Group breadcrumb</a>
    <a href='https://moscow.technichno.ru${path()}'>Other city</a>
    <a href='https://example.org${path()}'>External</a>
    <a href='/catalog/iphone/phone/group/variant/'>Other product</a>
    <script>const fake = "<a href='${path(999)}'>fake</a>";</script>`;
  assert.deepEqual(discoverTechnichnoLinks(html, root), {
    products: [base + path(), base + path(512), base + path(256, 'Silver')],
    pages: [`${root}?PAGEN_1=2`, `${root}macbook-neo/`],
  });
});

test('walks pagination and neighboring color/storage variants; uses each own full price', async () => {
  const silver256 = base + path();
  const blue256 = base + path(256, 'siniy');
  const silver512 = base + path(512);
  const blue512 = base + path(512, 'siniy');
  const pages = new Map([
    [root, `${card(path())}<a href='?PAGEN_1=2'>Next</a>`],
    [`${root}?PAGEN_1=2`, card(path(256, 'siniy'))],
    [silver256, detail({ links: `<div class='product-details__content--info__variants__item'><a href='${path(512)}' class=' '>512Gb</a></div>` })],
    [blue256, detail({ color: 'Синий', amount: 73990, links: `<a href='${path(512, 'siniy')}'>512Gb</a>` })],
    [silver512, detail({ storage: 512, amount: 82990, links: `<a href='${path(512, 'siniy')}'>Синий</a><a href='${path()}'>256Gb</a>` })],
    [blue512, detail({ storage: 512, color: 'Синий', amount: 83990, links: `<a href='${path(512)}'>Серебристый</a>` })],
  ]);
  const fetched = [];
  const { offers, stats } = await fetchTechnichnoOffers({ fetchPage: async url => { fetched.push(url); assert.ok(pages.has(url), url); return pages.get(url); } });
  assert.equal(new Set(fetched).size, 6);
  assert.equal(fetched.length, 6);
  assert.equal(offers.length, 4);
  assert.equal(offers.find(offer => offer.url === blue512).price, 83990);
  assert.equal(offers.find(offer => offer.url === silver512).storageGb, 512);
  assert.ok(offers.every(offer => offer.cpuCores === null && offer.gpuCores === null));
  assert.ok(offers.every(offer => offer.region === 'unknown' && offer.sourceCity === 'unknown' && offer.stock === 'InStock'));
  assert.deepEqual(stats, { pagesFetched: 6, catalogPagesFetched: 2, catalogCards: 1, productsDiscovered: 4, productsFetched: 4, offers: 4 });
});

test('treats every price as rubles and preserves unavailable status', async () => {
  const { offers } = await fetchTechnichnoOffers({ fetchPage: async url => url === root ? card(path()) : detail({ currency: 'USD', stock: 'OutOfStock' }) });
  assert.equal(offers[0].currency, 'RUB');
  assert.equal(offers[0].availability, 'http://schema.org/OutOfStock');
  assert.equal(offers[0].stock, 'OutOfStock');
  assert.equal(offers[0].title, 'MacBook Neo 13 Early 2026 A18 Pro 8GB / 256GB Серебристый');
});

test('does not borrow installment or unrelated nested Product prices when own price is absent', async () => {
  await assert.rejects(fetchTechnichnoOffers({ fetchPage: async url => url === root ? card(path()) : detail({ ownPrice: false }) }), /incomplete crawl:.*missing or invalid product price/);
});

test('rejects HTTP failures and unparseable products instead of returning partial data', async () => {
  await assert.rejects(fetchTechnichnoOffers({ fetchPage: async url => url === root ? `${card(path())}${card(path(512))}` : url === base + path() ? detail() : new Response('Failure', { status: 503 }) }), /incomplete crawl:.*HTTP 503/);
  await assert.rejects(fetchTechnichnoOffers({ fetchPage: async url => url === root ? card(path()) : '<h1>Access denied</h1>' }), /missing product details/);
});

test('rejects discovery truncation and empty catalogues explicitly', async () => {
  await assert.rejects(fetchTechnichnoOffers({ maxPages: 2, fetchPage: async () => `${card(path())}${card(path(512))}` }), /more than 2 pages discovered/);
  await assert.rejects(fetchTechnichnoOffers({ fetchPage: async () => '<h1>Mac</h1>' }), /no priced products discovered/);
});

test('bounds concurrent requests to three and accepts successful Response objects', async () => {
  let active = 0;
  let peak = 0;
  const variants = ['serebristyy', 'siniy', 'rozovyy', 'zheltyy', 'Silver', 'Blush', 'Indigo'];
  const { offers } = await fetchTechnichnoOffers({ fetchPage: async url => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return new Response(url === root ? variants.map(color => card(path(256, color))).join('') : detail());
  } });
  assert.equal(offers.length, 7);
  assert.equal(peak, 3);
});

test('flags source RAM conflicts without correcting the reported product specification', async () => {
  const group = '/catalog/mac/macbook-pro/macbook-pro-14-late-2025-24gb/';
  const product = `${group}apple-macbook-pro-14-2025-m5-23gb-1tb-seryy-kosmos/`;
  const html = `<ol class="breadcrumbs"><li>
    <a class="breadcrumb-item__title" href="${group}">MacBook Pro 14 Late 2025 M5 24GB</a>
    </li></ol>${detail().replaceAll('MacBook Neo 13 Early 2026 A18 Pro 8GB / 256GB Серебристый', 'Apple MacBook Pro 14 2025 M5 23GB 1TB Серый космос')}`;
  const { offers } = await fetchTechnichnoOffers({ fetchPage: async url => url === root ? card(product) : html });
  assert.equal(offers[0].ramGb, 23);
  assert.equal(offers[0].sourceReportedRam, 23);
  assert.equal(offers[0].sourceGroupRamGb, 24);
  assert.equal(offers[0].sourceGroupUrl, base + group);
  assert.equal(offers[0].sourceGroupTitle, 'MacBook Pro 14 Late 2025 M5 24GB');
  assert.match(offers[0].qualityWarnings.join('; '), /карточка товара указывает 23 GB.*24 GB/);
});

test('checks group URL RAM when breadcrumbs are absent and keeps consistent offers unflagged', async () => {
  const product = '/catalog/mac/macbook-pro/macbook-pro-14-late-2025-24gb/macbook-pro-14-m5-23gb-1tb-silver/';
  const html = detail().replaceAll('MacBook Neo 13 Early 2026 A18 Pro 8GB / 256GB Серебристый', 'MacBook Pro 14 M5 23GB 1TB Silver');
  const mismatch = await fetchTechnichnoOffers({ fetchPage: async url => url === root ? card(product) : html });
  assert.equal(mismatch.offers[0].sourceGroupRamGb, 24);
  assert.ok(mismatch.offers[0].qualityWarnings.some(w => w.includes('Конфликт RAM')));
  const consistent = await fetchTechnichnoOffers({ fetchPage: async url => url === root ? card(product) : html.replaceAll('23GB', '24GB') });
  assert.ok(consistent.offers[0].qualityWarnings.some(w => w.includes('Конфликт ram'))); // title 24GB still conflicts with 23GB URL
});
