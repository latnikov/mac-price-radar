import { decode, parseProduct, price } from './offer-normalization.mjs';

const origin = 'https://nn.rebro-store.ru';
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

function safeCatalogUrl(value, { pagination = false } = {}) {
  let url;
  try { url = new URL(decode(value), catalogUrl); }
  catch { throw new Error('Rebro catalogue has an invalid URL'); }
  if (url.origin !== origin || url.username || url.password || !url.pathname.startsWith('/catalog/mac/')) {
    throw new Error('Rebro catalogue URL points outside the Nizhny Novgorod Mac catalogue');
  }
  url.hash = '';
  if (pagination) {
    if (url.pathname !== '/catalog/mac/') throw new Error('Rebro pagination points outside the Mac catalogue');
    const page = url.searchParams.get('PAGEN_1');
    if (!/^\d+$/.test(page || '') || Number(page) < 2) throw new Error('Rebro pagination has an invalid page number');
    for (const key of [...url.searchParams.keys()]) if (key !== 'PAGEN_1') url.searchParams.delete(key);
  } else {
    url.search = '';
  }
  return url.href;
}

function responseText(response, url) {
  if (typeof response === 'string') return response;
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}: ${url}`);
  if (response.url && new URL(response.url).origin !== origin) throw new Error('Rebro redirected outside the Nizhny Novgorod store');
  return response.text();
}

function normalizeTitle(title) {
  return title.replace(/\b(\d{1,2})\s*C\s*\/\s*(\d{1,2})\s*C\b/gi, '$1-Core CPU / $2-Core GPU');
}

function childTag(card, tagName, className) {
  const expression = new RegExp(`<${tagName}\\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  for (const match of card.matchAll(expression)) {
    const attrs = attributes(`<${tagName} ${match[1]}>`);
    if (hasClass(attrs, className)) return { attrs, html: match[2] };
  }
  return null;
}

function parseCard(card, openingTag, pageUrl) {
  const outer = attributes(openingTag);
  const externalId = String(outer.id || '').match(/^bx_\d+_(\d+)$/)?.[1];
  if (!externalId) throw new Error('Rebro catalogue card has no product id');

  const titleNode = childTag(card, 'a', 'link-head');
  if (!titleNode) throw new Error(`Rebro card ${externalId} has no product title`);
  const title = decode(titleNode.html);
  const url = safeCatalogUrl(titleNode.attrs.href);
  const supported = /\bApple\s+(?:MacBook\s+(?:Air|Pro|Neo)|iMac)\b/i.test(title);
  const unavailable = /Нет\s+в\s+наличии/i.test(decode(card));
  const currentPrice = childTag(card, 'b', 'product-price__price');
  if (!currentPrice) {
    if (!unavailable) throw new Error(`Rebro card ${externalId} has neither a current price nor an out-of-stock marker`);
    return { externalId, supported, stock: 'OutOfStock', offer: null };
  }

  const rawPrice = decode(currentPrice.html);
  const amount = price(rawPrice);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Rebro card ${externalId} has an invalid current price`);
  const stock = /data-role\s*=\s*["']basket-add["']/i.test(card) ? 'InStock' : 'PreOrder';
  if (!supported) return { externalId, supported, stock, offer: null };

  const oldPriceNode = childTag(card, 's', 'product-price__sale1');
  const ordinaryPrice = oldPriceNode ? price(decode(oldPriceNode.html)) : null;
  const parsed = parseProduct(normalizeTitle(title), url, 'Rebro', amount, undefined, {
    externalId,
    sourceProductId: externalId,
    sourceCity: 'Нижний Новгород',
    sourceSite: 'nn.rebro-store.ru',
    rawPrice,
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
      method: 'rebro-bitrix-catalog-card-v1',
      catalogPage: pageUrl,
      sourceProductTitle: title,
      sourceProductId: externalId,
      rawCurrentPrice: rawPrice,
      ordinaryPrice,
      priceMeaning: 'Текущая цена каталога с учётом опубликованных магазином акций',
    },
  });
  if (!parsed) throw new Error(`Rebro unrecognized product ${externalId}: ${title}`);
  return { externalId, supported, stock, offer: parsed };
}

/** Parses one server-rendered Rebro catalogue page and ignores crossed-out prices. */
export function parseRebroPage(html, pageUrl = catalogUrl) {
  const source = String(html);
  const totalMatch = source.match(/<span\b[^>]*id\s*=\s*["']catalog-top__count["'][^>]*>\s*([\d\s\u00a0\u202f]+)\s*<\/span>/i);
  if (!totalMatch) throw new Error('Rebro catalogue total not found');
  const total = Number(totalMatch[1].replace(/\s/g, ''));
  if (!Number.isInteger(total) || total < 1) throw new Error('Rebro catalogue total is invalid');

  const starts = [...source.matchAll(/<div\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)]
    .map(match => ({ index: match.index, tag: match[0], attrs: attributes(match[0]) }))
    .filter(node => hasClass(node.attrs, 'col-6') && hasClass(node.attrs, 'col-md-4') && hasClass(node.attrs, 'col-xl-3') && /^bx_\d+_\d+$/.test(node.attrs.id || ''));
  if (!starts.length) throw new Error('Rebro catalogue page has no product cards');
  const entries = starts.map((node, index) => parseCard(source.slice(node.index, starts[index + 1]?.index ?? source.length), node.tag, pageUrl));

  let next = null;
  for (const match of source.matchAll(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attrs = attributes(`<a ${match[1]}>`);
    if (!hasClass(attrs, 'pagination__arrow') || !hasClass(attrs, '_next')) continue;
    if (!attrs.href) throw new Error('Rebro next page has no URL');
    next = safeCatalogUrl(attrs.href, { pagination: true });
    break;
  }
  return {
    total,
    next,
    entries,
    cardCount: entries.length,
    offers: entries.flatMap(entry => entry.offer ? [entry.offer] : []),
  };
}

/** Loads every current Rebro Mac card and publishes priced MacBook/iMac offers. */
export async function fetchRebroOffers({ fetchPage = url => fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 MacPriceRadar/2.0' } }), maxPages = 20 } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 30) throw new Error('Rebro maxPages must be between 1 and 30');
  const seenPages = new Set();
  const seenProducts = new Set();
  const offers = [];
  let url = catalogUrl;
  let total = null;
  let cards = 0;
  let supported = 0;
  let outOfStock = 0;
  while (url) {
    if (seenPages.has(url)) throw new Error('Rebro incomplete crawl: pagination loop');
    if (seenPages.size >= maxPages) throw new Error(`Rebro incomplete crawl: more than ${maxPages} pages`);
    seenPages.add(url);
    const page = parseRebroPage(await responseText(await fetchPage(url), url), url);
    if (total === null) total = page.total;
    else if (page.total !== total) throw new Error('Rebro incomplete crawl: catalogue total changed during refresh');
    cards += page.cardCount;
    for (const entry of page.entries) {
      if (seenProducts.has(entry.externalId)) throw new Error(`Rebro duplicate product id: ${entry.externalId}`);
      seenProducts.add(entry.externalId);
      if (entry.supported) supported++;
      if (entry.supported && entry.stock === 'OutOfStock') outOfStock++;
      if (entry.offer) offers.push(entry.offer);
    }
    url = page.next;
  }
  if (cards !== total || seenProducts.size !== total) throw new Error(`Rebro incomplete crawl: received ${cards} of ${total} catalogue cards`);
  if (!offers.length) throw new Error('Rebro incomplete crawl: no priced MacBook or iMac cards discovered');
  return {
    offers,
    stats: {
      catalogPagesFetched: seenPages.size,
      catalogCards: cards,
      supportedProducts: supported,
      priced: offers.length,
      inStock: offers.filter(offer => offer.stock === 'InStock').length,
      preOrder: offers.filter(offer => offer.stock === 'PreOrder').length,
      outOfStock,
    },
  };
}
