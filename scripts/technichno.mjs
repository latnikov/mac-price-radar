import { decode, parseProduct, price } from './offer-normalization.mjs';

const origin = 'https://nn.technichno.ru';
const rootUrl = `${origin}/catalog/mac/`;
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// A small HTML tokenizer keeps microdata inside its own Product/Offer scope.
// Matching the first price on the whole page would pick a credit or trade-in price.
function documentElements(html) {
  const source = String(html).replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const nodes = [];
  const stack = [];
  const tags = /<\/?([a-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  for (const match of source.matchAll(tags)) {
    const tag = match[1].toLowerCase();
    if (/^<\//.test(match[0])) {
      const index = stack.findLastIndex(node => node.tag === tag);
      if (index >= 0) {
        for (const node of stack.splice(index)) node.end = match.index;
      }
      continue;
    }
    const attrs = {};
    const attrSource = match[0].slice(match[1].length + 1).replace(/\/?\s*>$/, '');
    for (const attr of attrSource.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? '';
    }
    const node = { tag, attrs, start: match.index, body: match.index + match[0].length, end: source.length, parent: stack.at(-1) };
    nodes.push(node);
    if (!voidTags.has(tag) && !/\/\s*>$/.test(match[0])) stack.push(node);
    else node.end = node.body;
  }
  return { nodes, source };
}

const hasToken = (value, token) => String(value ?? '').split(/\s+/).includes(token);
const isType = (node, type) => String(node.attrs.itemtype ?? '').split(/\s+/).some(value => value.replace(/\/$/, '').endsWith(`/schema.org/${type}`));
const isWithin = (node, ancestor) => {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent === ancestor) return true;
  return false;
};
const owner = node => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ('itemscope' in parent.attrs) return parent;
  }
  return null;
};
const valueOf = (node, source) => node ? decode(node.attrs.content ?? node.attrs.href ?? source.slice(node.body, node.end)) : '';

function macUrl(value, pageUrl) {
  try {
    const url = new URL(String(value).replace(/&amp;/gi, '&').replace(/&#38;/g, '&'), pageUrl);
    if (url.origin !== origin || !url.pathname.startsWith('/catalog/mac/') || url.username || url.password) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}

export function discoverTechnichnoLinks(html, pageUrl = rootUrl) {
  const products = new Set();
  const pages = new Set();
  for (const node of documentElements(html).nodes) {
    if (!['a', 'link'].includes(node.tag) || !node.attrs.href) continue;
    const url = macUrl(node.attrs.href, pageUrl);
    if (!url) continue;
    const segments = url.pathname.split('/').filter(Boolean);
    // A product URL is /catalog/mac/<family>/<group>/<variant>/.
    // Breadcrumbs and model-group links are not individual priced offers.
    if (segments.length >= 5 && /^macbook-/i.test(segments[2])) {
      url.search = '';
      products.add(url.href);
    } else if (segments.length <= 4) {
      const pageParams = [...url.searchParams].filter(([key, value]) => /^(?:PAGEN_\d+|page)$/i.test(key) && /^\d+$/.test(value));
      const isCategory = segments.length === 3 && /^macbook-/i.test(segments[2]);
      if (pageParams.length || isCategory) {
        url.search = '';
        for (const [key, value] of pageParams) url.searchParams.set(key, value);
        pages.add(url.href);
      }
    }
  }
  return { products: [...products], pages: [...pages] };
}

function productOffer(html, url) {
  const { nodes, source } = documentElements(html);
  const products = nodes.filter(node => isType(node, 'Product'));
  const product = products.find(node => hasToken(node.attrs.class, 'product-details__content'))
    ?? products.find(node => nodes.some(child => child.tag === 'h1' && isWithin(child, node)));
  if (!product) throw new Error('missing product details/schema.org Product');
  const heading = nodes.find(node => node.tag === 'h1' && isWithin(node, product));
  const name = nodes.find(node => owner(node) === product && hasToken(node.attrs.itemprop, 'name'));
  const title = valueOf(heading, source) || valueOf(name, source);
  if (!title) throw new Error('missing product title');
  const offerScope = nodes.find(node => owner(node) === product && isType(node, 'Offer') && hasToken(node.attrs.itemprop, 'offers'));
  if (!offerScope) throw new Error('missing product Offer');
  const field = property => valueOf(nodes.find(node => owner(node) === offerScope && hasToken(node.attrs.itemprop, property)), source);
  const amount = price(field('price'));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('missing or invalid product price');
  const offer = parseProduct(title, url, 'Technichno', amount);
  if (!offer) throw new Error(`unrecognized product configuration: ${title}`);
  const availability = field('availability') || null;
  const sourceGroupUrl = new URL('../', url).href;
  const groupLink = nodes.find(node => node.tag === 'a'
    && hasToken(node.attrs.class, 'breadcrumb-item__title')
    && macUrl(node.attrs.href, url)?.href === sourceGroupUrl);
  const sourceGroupTitle = groupLink ? decode(source.slice(groupLink.body, groupLink.end)) || null : null;
  const groupSlug = decodeURIComponent(new URL(sourceGroupUrl).pathname.split('/').filter(Boolean).at(-1)).replace(/[-_]+/g, ' ');
  const groupMemory = (sourceGroupTitle || groupSlug).match(/(?:^|\s)(\d{1,3})\s*(?:GB|ГБ)(?=\s|\/|$)/i);
  const sourceGroupRamGb = groupMemory ? Number(groupMemory[1]) : null;
  const qualityWarnings = [...(offer.qualityWarnings || [])];
  if (sourceGroupRamGb && offer.ramGb !== sourceGroupRamGb) {
    qualityWarnings.push(`Конфликт RAM у источника: карточка товара указывает ${offer.ramGb} GB, группа «${sourceGroupTitle || groupSlug}» — ${sourceGroupRamGb} GB. Требуется проверка магазина.`);
  }
  return {
    ...offer,
    title,
    currency: 'RUB',
    region: 'unknown',
    sourceCity: 'unknown',
    sourceSite: 'nn.technichno.ru',
    priceType: 'full',
    rawPrice: field('price'),
    evidence: { ...offer.evidence, method: 'product-microdata-v1', availability },
    availability,
    stock: availability ? availability.split('/').filter(Boolean).at(-1) : 'unknown',
    sourceGroupUrl,
    sourceGroupTitle,
    sourceGroupRamGb,
    sourceReportedRam: offer.ramGb,
    qualityWarnings,
  };
}

/** Fetches all discovered variants or fails; never returns a silently partial refresh. */
export async function fetchTechnichnoOffers({ fetchPage = url => fetch(url), maxPages = 200 } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) throw new Error('Technichno maxPages must be between 1 and 200');
  const queue = [{ url: rootUrl, product: false }];
  const seen = new Set([rootUrl]);
  const productUrls = new Set();
  const offers = [];
  const stats = { pagesFetched: 0, catalogPagesFetched: 0, catalogCards: 0, productsDiscovered: 0, productsFetched: 0, offers: 0 };
  const enqueue = (url, product) => {
    if (product) productUrls.add(url);
    if (seen.has(url)) return;
    if (seen.size >= maxPages) throw new Error(`Technichno incomplete crawl: more than ${maxPages} pages discovered`);
    seen.add(url);
    queue.push({ url, product });
  };
  while (queue.length) {
    const batch = queue.splice(0, 3);
    const results = await Promise.allSettled(batch.map(async item => {
      try {
        const response = await fetchPage(item.url);
        let html;
        if (typeof response === 'string') html = response;
        else {
          if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
          if (response.url && !macUrl(response.url, item.url)) throw new Error('redirect outside Mac catalogue');
          html = await response.text();
        }
        const links = discoverTechnichnoLinks(html, item.url);
        return { item, links, offer: item.product ? productOffer(html, item.url) : null, html };
      } catch (error) { throw new Error(`${item.url}: ${error.message}`); }
    }));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
    if (errors.length) throw new Error(`Technichno incomplete crawl: ${errors.join('; ')}`);
    for (const { value } of results) {
      stats.pagesFetched += 1;
      if (value.item.product) { stats.productsFetched += 1; offers.push(value.offer); }
      else {
        stats.catalogPagesFetched += 1;
        if (value.item.url === rootUrl) {
          stats.catalogCards = documentElements(value.html).nodes.filter(node => node.tag === 'a' && hasToken(node.attrs.class, 'product-card__name')).length;
        }
      }
      for (const url of value.links.products) enqueue(url, true);
      for (const url of value.links.pages) enqueue(url, false);
    }
  }
  if (!offers.length) throw new Error('Technichno incomplete crawl: no priced products discovered');
  stats.productsDiscovered = productUrls.size;
  stats.offers = offers.length;
  return { offers, stats };
}
