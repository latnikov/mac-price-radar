import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { avitoUrl } from './avito-policy.mjs';
import { avitoAccessFailure, accessError } from './avito-access.mjs';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const amount = value => {
  const v = String(value ?? '').replace(/[\s\u00a0₽]/g, '').replace(/руб\.?/gi, '');
  return /^\d+(?:[.,]\d{1,2})?$/.test(v) && Number(v.replace(',', '.')) > 0 ? Number(v.replace(',', '.')) : null;
};
const integer = value => /^\d+$/.test(String(value ?? '').replace(/\s/g, '')) ? Number(String(value).replace(/\s/g, '')) : null;
function document(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 12 * 1024 * 1024) throw new Error('Авито: недопустимый размер документа');
  const $ = load(html);
  const access = avitoAccessFailure({html});
  if (access) throw accessError(access);
  return $;
}
// Format researched in Duff89/parser_avito (see docs/avito-research.md).
// Decode only JSON; never execute scripts from an advertisement.
function catalogs($) {
  const found = [];
  $('script[type="mime/invalid"][data-mfe-state="true"], script[type="application/json"]').each((_, el) => {
    try {
      const raw = $(el).text();
      let payload;
      try { payload = JSON.parse(raw); } catch { payload = JSON.parse(load(`<body>${raw}</body>`)('body').text()); }
      const data = payload.loaderData?.data || payload;
      for (const candidate of [data.catalog, data.result?.catalog, data.result, data]) if (Array.isArray(candidate?.items)) found.push({
        ...candidate,
        // count is the full result count; totalCount may be capped at 1500.
        totalCount: candidate.count ?? data.count ?? candidate.totalCount,
        searchCore: data.searchCore,
        canonicalUrl: data.url,
      });
    } catch { /* Other page scripts are unrelated. */ }
  });
  return found;
}

export function parseAvitoSearch(html, pageUrl) {
  const url = new URL(avitoUrl(pageUrl));
  if (!url.pathname.startsWith('/nizhniy_novgorod/')) throw new Error('Авито: выдача должна быть из Нижнего Новгорода');
  const $ = document(html), items = new Map();
  const put = item => {
    try {
      const link = avitoUrl(item.url, { listing: true });
      const id = new URL(link).pathname.match(/_(\d+)$/)[1];
      if (!item.title || !Number.isFinite(item.price)) return;
      const entry = { ...item, id, url: link };
      const old = items.get(id);
      if (old && old.title !== entry.title) throw Object.assign(new Error('Авито: конфликт заголовков дубля на странице'), { code: 'AVITO_CONFLICT' });
      if (old) {
        // Search cards can contain a promotion while the JSON has the full
        // price. Neither is published: the collector always opens the detail.
        old.priceVariants = [...new Set([...(old.priceVariants || [old.price]), entry.price])];
      } else items.set(id, entry);
    } catch (error) { if (error.code === 'AVITO_CONFLICT') throw error; }
  };
  let total = null, pagerNext = null, searchCore = null;
  for (const catalog of catalogs($)) {
    const count = integer(catalog.totalCount ?? catalog.count);
    if (count != null) total = count;
    pagerNext ||= catalog.pager?.next;
    searchCore ||= catalog.searchCore;
    for (const raw of catalog.items) {
      const item = raw.value?.id ? raw.value : raw;
      if (!item.id || !item.urlPath) continue;
      put({ id: String(item.id), url: item.urlPath, title: clean(item.title), price: amount(item.priceDetailed?.value),
        city: clean(item.addressDetailed?.locationName || item.location?.name), priceText: clean(item.priceDetailed?.string) });
    }
  }
  $('[data-marker="item"]').each((_, element) => {
    const card = $(element), link = card.find('a[data-marker="item-title"]').first();
    put({ url: link.attr('href'), title: clean(link.text() || link.attr('title')),
      price: amount(card.find('[itemprop="price"]').attr('content') || card.find('[data-marker="item-price"]').text()),
      city: clean(card.find('[data-marker="item-address"]').text()).split(',')[0],
      priceText: clean(card.find('[data-marker="item-price"]').text()) });
  });
  if (total == null) total = integer($('[data-marker="page-title/count"]').first().text());
  const nextHref = $('a[data-marker="pagination-button/next"], a[data-marker="pagination-button/nextPage"], a[rel="next"]').first().attr('href') || pagerNext;
  let nextUrl = null;
  if (nextHref) {
    const next = new URL(avitoUrl(new URL(nextHref, url).href));
    // The live pager omits the UI's local-priority flag. Keep the explicitly
    // requested flag only after the returned search state confirms it.
    if (url.searchParams.get('localPriority') === '1' && searchCore?.localPriority === 1 && !next.searchParams.has('localPriority')) next.searchParams.set('localPriority', '1');
    const a = new URL(url), b = new URL(next);
    for (const key of ['p', 'context']) { a.searchParams.delete(key); b.searchParams.delete(key); }
    a.searchParams.sort(); b.searchParams.sort();
    if (a.href !== b.href || Number(next.searchParams.get('p')) !== Number(url.searchParams.get('p') || 1) + 1) throw new Error('Авито: пагинация изменила область поиска');
    nextUrl = next.href;
  }
  if (!items.size && total !== 0) throw new Error('Авито: формат выдачи не распознан');
  return { items: [...items.values()], total, nextUrl, searchCore, hash: createHash('sha256').update(html).digest('hex') };
}

function hydratedItem($, id) {
  let result = null;
  $('script:not([src])').each((_, element) => {
    if (result) return;
    const match = $(element).text().match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\)/);
    if (!match) return;
    try {
      // Parse only the JSON string literal and its JSON payload. Site code is
      // never evaluated; the item must match the requested advertisement ID.
      const payload = JSON.parse(JSON.parse(match[1]));
      const find = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 10 || result) return;
        if (String(value.item?.id) === id) { result = value.item; return; }
        for (const child of Object.values(value)) find(child, depth + 1);
      };
      find(payload.loaderData);
    } catch { /* Unknown embedded data never supplies inferred fields. */ }
  });
  return result;
}

export function parseAvitoDetail(html, listingUrl, observedAt = new Date().toISOString()) {
  const url = avitoUrl(listingUrl, { listing: true }), $ = document(html);
  const id = new URL(url).pathname.match(/_(\d+)$/)[1];
  const embedded = hydratedItem($, id);
  const text = selector => clean($(selector).first().text());
  const title = text('[data-marker="item-view/title-info"], h1[itemprop="name"], h1');
  if (!title) throw new Error('Авито: заголовок объявления не найден');
  const parameters = {};
  $('[data-marker="item-view/item-params"] li').each((_, el) => {
    const value = clean($(el).text()), colon = value.indexOf(':');
    if (colon > 0) parameters[value.slice(0, colon).toLowerCase().replace(/ё/g, 'е')] = value.slice(colon + 1).trim();
  });
  const address = text('[data-marker="item-view/item-address"], [itemprop="addressLocality"]') || clean(embedded?.address || embedded?.geo?.address);
  const sellerElement = $('[data-marker="seller-info/name"]').first();
  const profile = sellerElement.find('a[href]').first().attr('href') || sellerElement.closest('a[href]').attr('href')
    || $('[data-marker="seller-link/link"]').first().attr('href');
  let sellerId = '';
  if (profile) {
    try { const p = new URL(avitoUrl(profile)); sellerId = p.pathname.match(/^\/(?:user|brands)\/([^/]+)/)?.[1] || ''; } catch { /* Unknown identity is quarantined. */ }
  }
  const priceText = text('[data-marker="item-view/item-price"]');
  const price = amount($('[itemprop="price"]').first().attr('content') || priceText);
  const currency = $('[itemprop="priceCurrency"]').first().attr('content') || (/₽|руб/i.test(priceText) ? 'RUB' : '');
  const memory = value => { const m = String(value || '').match(/^(\d+)\s*(?:ГБ|GB|ТБ|TB)?$/i); return m ? Number(m[1]) * (/ТБ|TB/i.test(value) ? 1000 : 1) : null; };
  return {
    id, url, title, price, priceText, currency,
    priceType: price && !/(?:^|\s)от\s|\/\s*мес|в\s+месяц|взнос/i.test(priceText) ? 'full' : 'unknown',
    city: address.split(',')[0].replace(/^г(?:\.\s*о)?\.\s*/i, ''), condition: parameters['состояние'] || '',
    seller: { id: sellerId, name: clean(sellerElement.text()) || text('[data-marker="seller-link/link"]') },
    description: text('[data-marker="item-view/item-description"]'),
    specs: { model: parameters['модель'], chip: parameters['процессор'],
      ramGb: memory(parameters['оперативная память'] || parameters['оперативная память, гб']),
      storageGb: memory(parameters['объем накопителя'] || parameters['объем накопителей, гб']), color: parameters['цвет'] },
    active: !/объявление\s+(?:снято\s+с\s+публикации|закрыто|продано)/i.test($('body').text()),
    observedAt, method: 'avito-html-v1', documentHash: createHash('sha256').update(html).digest('hex'),
  };
}
