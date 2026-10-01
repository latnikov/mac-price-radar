import { load } from 'cheerio';
import { CookieJar } from 'tough-cookie';
import { parseProduct, price } from './offer-normalization.mjs';
import { createCollectorFetch } from './collector-fetch.mjs';
import { crawlQueue } from './crawl-queue.mjs';

const origin = 'https://store77.net';
const catalogUrl = `${origin}/apple_macbook_air_m5/`;
const categoryPath = /^\/apple_macbook_(?:air_m\d+|pro_m\d+|neo)\/$/;
const fail = message => new Error(`Store77: ${message}`);
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const document = html => load(html, { scriptingEnabled: false });
const normalizedTitle = title => title.replace(/(MacBook\s+(?:Air|Pro)\s+)(13\.6|14\.2|15\.3|16\.2)/i, (_, prefix, screen) => prefix + Math.floor(Number(screen)))
  .replace(/Старлайт/gi, 'Starlight')
  .replace(/Т[её]мно[ -]синий/gi, /MacBook Air/i.test(title) ? 'Midnight' : 'Space Black');
function correctAirColor(offer, title) {
  if (/MacBook Air/i.test(title) && /Т[её]мно[ -]синий/i.test(title) && /temno_siniy/i.test(offer.url)) {
    offer.qualityWarnings = offer.qualityWarnings.filter(warning => warning !== 'Конфликт цвета: Midnight, URL Indigo');
  }
  return offer;
}

// Store77 sets a cookie and redirects to the same URL on the first request.
// Native fetch does not retain that cookie, so automatic redirects loop forever.
export function createStore77Fetch({ fetchImpl = fetch, maxRedirects = 6 } = {}) {
  const jar = new CookieJar();
  return async (input, options = {}) => {
    let target = new URL(input);
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      if (target.origin !== origin || target.username || target.password) throw fail('redirect outside Store77');
      options.signal?.throwIfAborted();
      const headers = new Headers(options.headers);
      const cookie = jar.getCookieStringSync(target.href);
      if (cookie) headers.set('cookie', cookie);
      const response = await fetchImpl(target.href, { ...options, headers, redirect: 'manual' });
      for (const value of response.headers.getSetCookie?.() || []) jar.setCookieSync(value, target.href, { ignoreError: true });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      await response.body?.cancel?.();
      const location = response.headers.get('location');
      if (!location) throw fail('redirect without Location');
      target = new URL(location, target);
    }
    throw fail('redirect limit exceeded');
  };
}

function siteUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw fail('invalid catalogue URL'); }
  if (url.origin !== origin || url.username || url.password) throw fail('URL outside Store77');
  url.hash = '';
  return url;
}

export function discoverStore77Categories(html) {
  const $ = document(html), urls = new Set();
  $('a[href]').each((_, node) => {
    let url;
    try { url = siteUrl($(node).attr('href'), catalogUrl); } catch { return; }
    if (categoryPath.test(url.pathname)) urls.add(`${origin}${url.pathname}`);
  });
  if (!urls.has(`${origin}/apple_macbook_air_m5/`)) throw fail('MacBook Air M5 category missing');
  return [...urls];
}

export function parseStore77Category(html, pageUrl, { fetchedAt = new Date().toISOString() } = {}) {
  const page = siteUrl(pageUrl, catalogUrl), $ = document(html);
  const cards = $('.wrap_list_prod .blocks_product'), offers = [], failures = [], pages = new Set();
  if (!cards.length) throw fail(`catalogue cards missing: ${pageUrl}`);
  $('.pagination_catalog a[href]').each((_, node) => {
    const href = $(node).attr('href');
    if (href === '#') return;
    const url = siteUrl(href, page);
    if (url.pathname !== page.pathname || [...url.searchParams].some(([key, value]) => !/^PAGEN_\d+$/.test(key) || !/^[1-9]\d*$/.test(value))) throw fail('unexpected pagination link');
    for (const [key, value] of url.searchParams) if (value === '1') url.searchParams.delete(key);
    pages.add(url.href);
  });
  let unpriced = 0;
  cards.each((_, node) => {
    const card = $(node), link = card.find('.bp_text_info a').first();
    const sourceTitle = clean(link.text());
    if (!/MacBook\s+(?:Air|Pro|Neo)\b/i.test(sourceTitle) || !/\b(?:M\d+|A18\s+Pro)\b/i.test(sourceTitle)) return;
    try {
      const url = siteUrl(link.attr('href'), page);
      if (url.pathname.split('/').filter(Boolean).length < 2 || url.search) throw fail('invalid product URL');
      const rawPrice = clean(card.find('.bp_text_price').first().clone().find('del,s,.old_price,.price_old').remove().end().text()).replace(/\s*[—–-]\s*$/, '');
      const amount = price(rawPrice);
      if (!amount) { unpriced++; return; }
      const buy = card.find('[data-type="addBasket"][data-id][data-price]:not(.out-of-stock)').first();
      const basketPrice = buy.attr('data-price');
      if (basketPrice != null && price(basketPrice) !== amount) throw fail(`catalogue/basket price mismatch: ${url.href}`);
      const productId = buy.attr('data-id') || card.find('.favorite_product').attr('data-elid');
      if (!/^\d+$/.test(productId || '')) throw fail('missing product ID');
      const localized = /русифицир|rusifitsirov/i.test(`${sourceTitle} ${url.pathname}`);
      const warrantyYears = Number(sourceTitle.match(/(\d+)\s*(?:год[а-я]*|лет)\s*гарант/i)?.[1]) || null;
      const title = normalizedTitle(sourceTitle);
      const stockText = clean(card.find('.bp_hover_text_dostavka,.bp_hover_text_but').text());
      const stock = /под заказ|предзаказ/i.test(stockText) ? 'PreOrder' : buy.length ? 'InStock' : /нет в наличии|сообщить|уведомить|распродан/i.test(card.text()) ? 'OutOfStock' : 'unknown';
      const offer = parseProduct(title, url.href, 'Store77', amount, fetchedAt, {
        externalId: `store77:${productId}`, sourceProductId: productId,
        sourceCity: 'Москва', sourceSite: 'store77.net', rawPrice,
        keyboardLocalization: localized ? 'localized' : 'none', keyboard: localized ? 'RU-localized' : 'unknown',
        warrantyYears, condition: 'new', displayType: 'standard', bundle: warrantyYears ? `${warrantyYears} года гарантии` : 'standard',
        region: 'unknown', priceType: 'full', paymentMethod: 'unknown', buyerType: 'retail', minimumQuantity: 1, stock,
        evidence: { method: 'store77-catalog-v1', catalogPage: pageUrl, sourceProductTitle: sourceTitle,
          localizationMeaning: localized ? 'Магазин явно помечает товар как русифицированный; способ русификации не указан' : 'Карточка без отметки о русификации; раскладка не подтверждена',
          availabilityMeaning: stockText, priceMeaning: 'Полная цена карточки каталога; способ оплаты не указан' },
      });
      if (!offer) throw fail(`unrecognized configuration: ${sourceTitle}`);
      // Store77 calls the Air's Midnight finish "Тёмно-синий" in both title
      // and slug. The generic normalizer reads that slug as Neo's Indigo.
      offers.push(correctAirColor(offer, sourceTitle));
    } catch (error) { failures.push(error.message); }
  });
  return { offers, failures, pages: [...pages], cards: cards.length, unpriced };
}

export function parseStore77Product(html, reference, { fetchedAt = new Date().toISOString() } = {}) {
  const $ = document(html), box = $('.b-big-offer-popup__info').first();
  const sourceTitle = clean($('h1').first().text());
  if (!sourceTitle || clean(box.find('.bp_text_info').text()) !== sourceTitle) throw fail(`product title missing or inconsistent: ${reference.url}`);
  const canonical = siteUrl($('link[rel="canonical"]').attr('href'), reference.url);
  if (canonical.href !== reference.url) throw fail(`product redirected: ${reference.url}`);
  const rawPrice = clean(box.find('.bp_text_price').first().text()).replace(/\s*[—–-]\s*$/, '');
  const amount = price(rawPrice);
  if (!amount) throw fail(`product price missing: ${reference.url}`);
  const buy = box.find('[data-type="addBasket"][data-id][data-price]:not(.out-of-stock)').first();
  if (buy.length && (buy.attr('data-id') !== reference.sourceProductId || price(buy.attr('data-price')) !== amount)) throw fail(`product/basket mismatch: ${reference.url}`);
  const localized = /русифицир|rusifitsirov/i.test(`${sourceTitle} ${reference.url}`);
  const stockText = clean(box.find('.bp_hover_text_dostavka,.bp_hover_text_but').text());
  const stock = /под заказ|предзаказ/i.test(stockText) ? 'PreOrder' : buy.length ? 'InStock' : /нет в наличии|сообщить|уведомить|распродан/i.test(box.text()) ? 'OutOfStock' : 'unknown';
  const offer = parseProduct(normalizedTitle(sourceTitle), reference.url, 'Store77', amount, fetchedAt, {
    ...reference, rawPrice, stock, qualityWarnings: [],
    evidence: { ...reference.evidence, method: 'store77-product-v1', sourceProductTitle: sourceTitle,
      catalogPrice: reference.price, productPrice: amount, availabilityMeaning: stockText },
  });
  if (!offer || localized !== (reference.keyboardLocalization === 'localized') || ['model', 'chip', 'ramGb', 'storageGb', 'color'].some(field => offer[field] !== reference[field])) throw fail(`product configuration mismatch: ${reference.url}`);
  return correctAirColor(offer, sourceTitle);
}

export async function fetchStore77Offers({ fetchPage = createCollectorFetch({ fetchImpl: createStore77Fetch() }).fetchPage, maxPages = 200 } = {}) {
  const text = async url => {
    const response = await fetchPage(url);
    if (typeof response === 'string') return response;
    if (!response?.ok || (response.url && new URL(response.url).origin !== origin)) throw fail(`invalid response: ${url}`);
    return response.text();
  };
  const initial = await text(catalogUrl);
  const categories = discoverStore77Categories(initial);
  const seen = new Set(categories), offers = new Map(), failures = [];
  if (seen.size > maxPages) throw fail('catalogue page limit exceeded');
  let pagesFetched = 0, catalogCards = 0, unpriced = 0;
  await crawlQueue(categories, async (url, enqueue) => {
    const result = parseStore77Category(url === catalogUrl ? initial : await text(url), url);
    pagesFetched++; catalogCards += result.cards; unpriced += result.unpriced;
    failures.push(...result.failures);
    for (const offer of result.offers) {
      const previous = offers.get(offer.externalId);
      if (previous && previous.url !== offer.url) throw fail(`conflicting product URLs: ${offer.externalId}`);
      offers.set(offer.externalId, offer);
    }
    for (const page of result.pages) {
      if (seen.has(page)) continue;
      if (seen.size >= maxPages) throw fail('catalogue page limit exceeded');
      seen.add(page); enqueue(page);
    }
  }, { concurrency: 2 });
  if (!offers.size) throw fail('no priced MacBook offers');
  const values = [];
  await crawlQueue([...offers.values()], async reference => {
    try { values.push(parseStore77Product(await text(reference.url), reference)); }
    catch (error) { failures.push(error.message); }
  }, { concurrency: 2 });
  if (!values.length) throw fail('no verified product prices');
  return { offers: values, failures, stats: { catalogPagesFetched: pagesFetched, categories: categories.length, catalogCards,
    products: offers.size, productPagesFetched: offers.size, variants: values.length, localized: values.filter(o => o.keyboardLocalization === 'localized').length,
    inStock: values.filter(o => o.stock === 'InStock').length, outOfStock: values.filter(o => o.stock === 'OutOfStock').length, unpriced } };
}
