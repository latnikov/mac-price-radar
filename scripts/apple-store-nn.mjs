import { decode, parseProduct, price } from './offer-normalization.mjs';

const origin = 'https://nn.stores-apple.com';
const catalogUrl = `${origin}/catalog/mac/`;

function attributes(tag) {
  const result = {};
  const source = String(tag).replace(/^<\/?[a-z][\w:-]*/i, '').replace(/\/?\s*>$/, '');
  for (const match of source.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const key = match[1].toLowerCase();
    if (!(key in result)) result[key] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return result;
}

const hasClass = (attrs, name) => String(attrs.class || '').split(/\s+/).includes(name);

function productUrl(value) {
  let url;
  try { url = new URL(decode(value), catalogUrl); }
  catch { throw new Error('Apple Store NN product has invalid URL'); }
  if (url.origin !== origin || !url.pathname.startsWith('/catalog/') || url.username || url.password) {
    throw new Error('Apple Store NN product URL is outside the catalogue');
  }
  url.hash = '';
  url.search = '';
  return url.href;
}

function paginationUrl(value) {
  let url;
  try { url = new URL(decode(value), catalogUrl); }
  catch { throw new Error('Apple Store NN pagination has invalid URL'); }
  const page = url.searchParams.get('PAGEN_4');
  if (url.origin !== origin || url.pathname !== '/catalog/mac/' || url.username || url.password
    || !/^\d+$/.test(page || '') || Number(page) < 2) {
    throw new Error('Apple Store NN pagination points outside the catalogue');
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (key !== 'PAGEN_4') url.searchParams.delete(key);
  return url.href;
}

function responseText(response, url) {
  if (typeof response === 'string') return response;
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}: ${url}`);
  if (response.url && new URL(response.url).origin !== origin) throw new Error('Apple Store NN redirected outside the store');
  return response.text();
}

function normalizeTitle(title) {
  if (/\bMacBook\s+Neo\b/i.test(title) && !/\bA18\s+Pro\b/i.test(title)) {
    return `${title} A18 Pro 6-Core CPU / 5-Core GPU`;
  }
  return title;
}

function salePrice(card) {
  const match = card.match(/class\s*=\s*["'][^"']*\bprice_value_sale\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*>\s*([\d\s\u00a0\u202f]+)\s*<span\b/i);
  return match ? price(match[1]) : null;
}

function parseCard(card, openingTag, pageUrl, stock) {
  const cardAttrs = attributes(openingTag);
  const externalId = String(cardAttrs['data-id'] || '').trim();
  if (!externalId) throw new Error('Apple Store NN catalogue card has no product id');

  const titleMatch = card.match(/<div\b[^>]*class\s*=\s*["'][^"']*\bitem-title\b[^"']*["'][^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>/i);
  if (!titleMatch) throw new Error(`Apple Store NN card ${externalId} has no title`);
  const title = decode(titleMatch[2]);
  if (!/\bApple\s+MacBook\s+(?:Air|Pro|Neo)\b/i.test(title)) return { externalId, offer: null };

  const link = attributes(`<a ${titleMatch[1]}>`).href;
  if (!link) throw new Error(`Apple Store NN MacBook ${externalId} has no URL`);
  const url = productUrl(link);
  const priceTag = [...card.matchAll(/<div\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)]
    .map(match => ({ tag: match[0], attrs: attributes(match[0]) }))
    .find(item => hasClass(item.attrs, 'price') && item.attrs['data-value']);
  const amount = price(priceTag?.attrs['data-value']);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Apple Store NN MacBook ${externalId} has invalid retail price`);
  if (String(priceTag.attrs['data-currency'] || 'RUB').toUpperCase() !== 'RUB') throw new Error(`Apple Store NN MacBook ${externalId} price is not RUB`);

  const conditionalWarrantyPrice = salePrice(card);
  const parsed = parseProduct(normalizeTitle(title), url, 'Apple Store', amount, undefined, {
    externalId,
    sourceProductId: externalId,
    sourceCity: 'Нижний Новгород',
    sourceSite: 'nn.stores-apple.com',
    rawPrice: String(priceTag.attrs['data-value']),
    condition: 'new',
    region: 'unknown',
    displayType: 'standard',
    bundle: 'standard',
    priceType: 'full',
    paymentMethod: 'any',
    buyerType: 'retail',
    minimumQuantity: 1,
    stock,
    evidence: {
      method: 'bitrix-catalog-card-v1',
      catalogPage: pageUrl,
      sourceProductTitle: title,
      sourceProductId: externalId,
      rawRetailPrice: String(priceTag.attrs['data-value']),
      conditionalWarrantyPrice,
      priceMeaning: 'Обычная розничная цена; условная акция при покупке гарантии исключена',
    },
  });
  if (!parsed) throw new Error(`Apple Store NN unrecognized MacBook ${externalId}: ${title}`);
  return { externalId, offer: parsed };
}

/** Parses one server-rendered Bitrix catalogue page without trusting unrelated prices. */
export function parseAppleStorePage(html, pageUrl = catalogUrl) {
  const source = String(html);
  const divs = [...source.matchAll(/<div\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)]
    .map(match => ({ index: match.index, tag: match[0], attrs: attributes(match[0]) }));
  const countNode = divs.find(node => hasClass(node.attrs, 'item-cnt') && /^\d+$/.test(node.attrs['data-count'] || ''));
  if (!countNode) throw new Error('Apple Store NN catalogue total not found');
  const total = Number(countNode.attrs['data-count']);
  if (!Number.isInteger(total) || total < 1) throw new Error('Apple Store NN catalogue total is invalid');

  const headings = divs.filter(node => hasClass(node.attrs, 'catalogPage__title'));
  const cards = divs.filter(node => hasClass(node.attrs, 'item-parent') && hasClass(node.attrs, 'catalog-block-view__item'));
  if (!cards.length) throw new Error('Apple Store NN catalogue page has no cards');
  const entries = [];
  for (const [index, node] of cards.entries()) {
    const end = cards[index + 1]?.index ?? source.length;
    const heading = headings.findLast(item => item.index < node.index);
    if (!heading) throw new Error('Apple Store NN catalogue card is outside a stock section');
    const stock = hasClass(heading.attrs, 'catalogPage__title_instock') ? 'InStock' : 'PreOrder';
    entries.push(parseCard(source.slice(node.index, end), node.tag, pageUrl, stock));
  }

  let next = null;
  for (const match of source.matchAll(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    if (!/\brel\s*=\s*(?:["'][^"']*\bnext\b[^"']*["']|next\b)/i.test(match[0])) continue;
    const href = attributes(match[0]).href;
    if (!href) throw new Error('Apple Store NN next page has no URL');
    next = paginationUrl(href);
    break;
  }
  return { total, next, entries, cardCount: cards.length, offers: entries.flatMap(entry => entry.offer ? [entry.offer] : []) };
}

/** Loads every current MacBook card from all public catalogue pages. */
export async function fetchAppleStoreOffers({ fetchPage = url => fetch(url), maxPages = 10 } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 25) throw new Error('Apple Store NN maxPages must be between 1 and 25');
  const seenPages = new Set();
  const seenProducts = new Set();
  const offers = [];
  let url = catalogUrl;
  let total = null;
  let cards = 0;
  while (url) {
    if (seenPages.has(url)) throw new Error('Apple Store NN incomplete crawl: pagination loop');
    if (seenPages.size >= maxPages) throw new Error(`Apple Store NN incomplete crawl: more than ${maxPages} pages`);
    seenPages.add(url);
    const page = parseAppleStorePage(await responseText(await fetchPage(url), url), url);
    if (total === null) total = page.total;
    else if (page.total !== total) throw new Error('Apple Store NN incomplete crawl: catalogue total changed during refresh');
    cards += page.cardCount;
    for (const entry of page.entries) {
      if (seenProducts.has(entry.externalId)) throw new Error(`Apple Store NN duplicate product id: ${entry.externalId}`);
      seenProducts.add(entry.externalId);
      if (entry.offer) offers.push(entry.offer);
    }
    url = page.next;
  }
  if (cards !== total || seenProducts.size !== total) throw new Error(`Apple Store NN incomplete crawl: received ${cards} of ${total} catalogue cards`);
  if (!offers.length) throw new Error('Apple Store NN incomplete crawl: no priced MacBook cards discovered');
  return {
    offers,
    stats: {
      catalogPagesFetched: seenPages.size,
      catalogCards: cards,
      macbooks: offers.length,
      inStock: offers.filter(offer => offer.stock === 'InStock').length,
      preOrder: offers.filter(offer => offer.stock === 'PreOrder').length,
    },
  };
}
