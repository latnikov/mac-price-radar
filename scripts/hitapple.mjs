import { load } from 'cheerio';
import { decode, parseProduct, price } from './offer-normalization.mjs';
import { iphoneModel, iphoneColor, IPHONE_MODELS } from './iphone.mjs';

const origin = 'https://hitapple.ru';
const catalogUrl = `${origin}/category/mac/`;
const categories = new Map([
  ['macbook-air', 'Air'], ['macbook-pro', 'Pro'], ['macbookneo', 'Neo'],
]);
const fail = message => new Error(`HitApple: ${message}`);
const clean = value => decode(value).replace(/\u00a0/g, ' ');
const productTitle = /^(?:Apple\s+)?(?:MacBook\s+(?:Air|Pro|Neo)|iPhone\s+(?:17|18)\s+Pro(?:\s+Max)?)\b/i;

function safeUrl(value, base = catalogUrl) {
  let url;
  try { url = new URL(String(value || '').replace(/&amp;/gi, '&'), base); }
  catch { throw fail('invalid URL'); }
  if (url.origin !== origin || url.username || url.password) throw fail('URL outside the store');
  url.hash = '';
  return url;
}

function categoryUrl(value, base = catalogUrl) {
  const url = safeUrl(value, base);
  const match = url.pathname.match(/^\/category\/mac\/([^/]+)\/(?:page\/(\d+)\/)?$/);
  const phone = url.pathname.match(/^\/category\/iphone\/((?:17|18)-pro(?:-max)?)\/(?:page\/(\d+)\/)?$/);
  const selected = phone || match;
  if (!selected || (!phone && !categories.has(selected[1])) || (selected[2] && Number(selected[2]) < 1) || url.search) throw fail('pagination outside the device catalogue');
  if (selected[2] && Number(selected[2]) === 1) url.pathname = url.pathname.replace(/page\/1\/$/, '');
  return url.href;
}

function productUrl(value, base = catalogUrl) {
  const url = safeUrl(value, base);
  if (!/^\/product\/[^/]+\/$/.test(url.pathname)) throw fail('product URL outside the catalogue');
  for (const [key, val] of url.searchParams) {
    if (!/^attribute_pa_[a-z0-9-]+$/.test(key) || !/^[a-z0-9-]+$/i.test(val)) throw fail('unsupported product URL option');
  }
  url.searchParams.sort();
  return url.href;
}

const parentUrl = value => { const url = new URL(value); url.search = ''; return url.href; };

async function responseText(response, url) {
  if (typeof response === 'string') return response;
  if (!response?.ok) throw fail(`HTTP ${response?.status ?? 'unknown'}: ${url}`);
  if (response.url && safeUrl(response.url).origin !== origin) throw fail('redirect outside the store');
  return response.text();
}

export function discoverHitappleCategories(html, { phones = false } = {}) {
  const $ = load(String(html));
  const urls = new Set();
  $('ul.products > li.product-category').each((_, element) => {
    const card = $(element), title = clean(card.find('.woocommerce-loop-category__title').text());
    if (phones ? !iphoneModel(title) : !/^MacBook\s+(?:Air|Pro|Neo)\b/i.test(title)) return;
    const url = categoryUrl(card.find('a').first().attr('href'));
    const slug = new URL(url).pathname.split('/').filter(Boolean).at(-1);
    if (phones ? iphoneModel(title) !== iphoneModel(`iPhone ${slug.replace(/-/g, ' ')}`) : !new RegExp(`^MacBook\\s+${categories.get(slug)}$`, 'i').test(title)) throw fail('category title does not match its URL');
    if (urls.has(url)) throw fail('duplicate MacBook category');
    urls.add(url);
  });
  if (urls.size !== (phones ? IPHONE_MODELS.length : categories.size)) throw fail('incomplete crawl: expected all requested categories');
  return [...urls];
}

function stockFromCard(card) {
  const inStock = card.hasClass('instock'), outOfStock = card.hasClass('outofstock');
  if (inStock === outOfStock) throw fail('missing or contradictory stock status');
  return inStock ? 'InStock' : 'OutOfStock';
}

function currentPrice($, container) {
  const priceNode = container.find('.price').first();
  let amounts = priceNode.find('ins .woocommerce-Price-amount');
  if (!amounts.length) amounts = priceNode.find('.woocommerce-Price-amount').filter((_, element) => !$(element).closest('del').length);
  if (amounts.length !== 1) throw fail('expected one current retail price, not a range');
  if (!/^(?:₽|руб\.?|RUB)$/i.test(cleanCurrency(amounts.find('.woocommerce-Price-currencySymbol').text()))) throw fail('retail price is not RUB');
  const rawPrice = clean(amounts.first().text());
  const amount = price(rawPrice);
  if (!amount) throw fail('invalid current retail price');
  return { amount, rawPrice };
}

const cleanCurrency = value => String(value || '').replace(/\s+/g, '').trim();

function normalizedTitle(title) {
  // Air M4 titles omit CPU/GPU labels; the first core count is CPU, the
  // second is GPU. Explicit labels also keep the shared RAM parser safe.
  return clean(title).replace(/(\d+)\s*-?core\s*,\s*(?:GPU\s*)?(\d+)\s*-?core\b/gi, '$1-core CPU / $2-core GPU');
}

function normalizedOffer({ title, url, amount, rawPrice, stock, externalId, productId = externalId, variantId = null, minimumQuantity = 1, fetchedAt, evidence }) {
  const offer = parseProduct(normalizedTitle(title), url, 'HitApple', amount, fetchedAt, {
    externalId, sourceProductId: productId, ...(variantId ? { sourceVariantId: variantId } : {}),
    sourceCity: 'Нижний Новгород', sourceSite: 'hitapple.ru', rawPrice,
    condition: 'new', region: 'unknown', keyboard: 'unknown', displayType: 'standard', bundle: 'standard',
    priceType: 'full', paymentMethod: 'cash', buyerType: 'retail', minimumQuantity, stock,
    evidence: { ...evidence, sourceProductTitle: evidence.sourceProductTitle ?? title,
      priceMeaning: 'Текущая розничная цена при наличном расчёте; старая цена и рассрочка исключены',
      availabilityMeaning: 'Наличие из публичного WooCommerce каталога или выбранного варианта' },
  });
  if (!offer || (!iphoneModel(title) && (!offer.screenIn || !offer.cpuCores || !offer.gpuCores)) || offer.color === 'unknown') throw fail(`unrecognized device configuration: ${title}`);
  return offer;
}

/** Reads only catalogue cards, preserving variation selection URLs. */
export function parseHitappleCategory(html, pageUrl, { fetchedAt = new Date().toISOString() } = {}) {
  categoryUrl(pageUrl);
  const $ = load(String(html));
  const cards = $('ul.products > li.product:not(.product-category)');
  if (!cards.length && !$('.woocommerce-info').text().match(/товар.*не найден|No products were found/i)) throw fail('incomplete crawl: category has no product cards');
  const entries = [], ids = new Set();
  cards.each((_, element) => {
    const card = $(element);
    const id = card.attr('class')?.match(/\bpost-(\d+)\b/)?.[1];
    if (!id || ids.has(id)) throw fail('missing or duplicate catalogue product id');
    ids.add(id);
    const title = clean(card.find('.woocommerce-loop-product__title').text());
    if (!productTitle.test(title)) {
      if (/^(?:Apple\s+)?(?:iMac|Mac\s+(?:mini|Studio))\b/i.test(title) || /чехол|аксессуар/i.test(title)) return;
      throw fail(`unexpected MacBook catalogue card: ${title}`);
    }
    const url = productUrl(card.find('a.woocommerce-LoopProduct-link, a.woocommerce-loop-product__link').first().attr('href') || card.find('a').first().attr('href'), pageUrl);
    const stock = stockFromCard(card);
    if (card.hasClass('product-type-variable')) {
      if (new URL(url).search) throw fail('variable parent has selected options');
      entries.push({ id, title, url, stock, type: 'variable' });
    } else if (card.hasClass('product-type-variation')) {
      if (!new URL(url).search) throw fail('variant card has no selected options');
      entries.push({ id, title, url, stock, type: 'variation', ...currentPrice($, card) });
    } else if (card.hasClass('product-type-simple')) {
      if (new URL(url).search) throw fail('simple card has selected options');
      const values = currentPrice($, card);
      entries.push({ id, title, url, stock, type: 'simple', ...values,
        offer: normalizedOffer({ title, url, stock, externalId: id, fetchedAt, ...values,
          evidence: { method: 'woocommerce-catalog-card-v1', catalogPage: pageUrl, sourceProductId: id, stockClass: stock === 'InStock' ? 'instock' : 'outofstock' } }) });
    } else throw fail(`unsupported product type: ${id}`);
  });

  const pages = new Set([pageUrl]);
  $('.woocommerce-pagination a.page-numbers').each((_, element) => {
    const url = categoryUrl($(element).attr('href'), pageUrl);
    const current = new URL(pageUrl).pathname.replace(/page\/\d+\/$/, '');
    if (new URL(url).pathname.replace(/page\/\d+\/$/, '') !== current) throw fail('pagination points to another category');
    pages.add(url);
  });
  const nextLinks = $('.woocommerce-pagination a.next');
  if (nextLinks.length > 1) throw fail('multiple next pages');
  const next = nextLinks.length ? categoryUrl(nextLinks.attr('href'), pageUrl) : null;
  const currentPage = Number(new URL(pageUrl).pathname.match(/\/page\/(\d+)\//)?.[1] || 1);
  if (next && Number(new URL(next).pathname.match(/\/page\/(\d+)\//)?.[1]) !== currentPage + 1) throw fail('incomplete crawl: pagination skipped a page');
  if (!next && [...pages].some(url => Number(new URL(url).pathname.match(/\/page\/(\d+)\//)?.[1] || 1) > currentPage)) throw fail('incomplete crawl: missing next page');
  return { entries, next, pages: [...pages], cardCount: cards.length };
}

function neoSpecification(title, description) {
  if (!/^Apple\s+MacBook\s+Neo$/i.test(title)) return null;
  if (!/\bA18\s+Pro\b/i.test(description) || !/6\s*ядер\s*CPU/i.test(description) || !/5\s*ядер\s*GPU/i.test(description)
    || !/8\s*ГБ.*памят/i.test(description) || !/13[ -]дюймов/i.test(description)) throw fail('unverified Neo specifications');
  return 'Apple MacBook Neo 13" A18 Pro 6-core CPU / 5-core GPU';
}

function variantColor(label, variant, neo, phoneModel = null) {
  if (phoneModel && iphoneColor(label, phoneModel) === 'unknown') {
    const sourceImage = `${variant.image?.title || ''} ${variant.image?.alt || ''} ${variant.image?.url || ''}`;
    const confirmed = iphoneColor(sourceImage, phoneModel);
    if (confirmed !== 'unknown') return confirmed;
  }
  if (!neo) return label;
  // HitApple labels Citrus as "Зеленый". Its own variant image identifies
  // the actual Apple color; do not infer this from a generic green label.
  const image = `${variant.image?.title || ''} ${variant.image?.alt || ''} ${variant.image?.url || ''}`;
  const color = ['Citrus', 'Blush', 'Silver', 'Indigo'].find(value => new RegExp(`(?:^|[-_\\s/])${value}(?:[-_\\s.]|$)`, 'i').test(image));
  const allowed = { Citrus: /зел[её]н|цитрус|citrus/i, Blush: /розов|blush/i, Silver: /серебр|silver/i, Indigo: /син|индиго|indigo/i };
  if (!color || !allowed[color].test(label)) throw fail('unverified Neo color mapping');
  return color;
}

/** Parses exact WooCommerce variation prices; the parent minimum is never used. */
export function parseHitappleVariations(html, pageUrl, { expectedProductId, fetchedAt = new Date().toISOString(), variants: suppliedVariants = null } = {}) {
  const url = parentUrl(productUrl(pageUrl));
  const $ = load(String(html));
  const mainForms = $('.summary form.variations_form');
  const forms = mainForms.length ? mainForms : $('form.variations_form');
  if (forms.length !== 1) throw fail('expected one variable product form');
  const form = forms.first();
  const productId = String(form.attr('data-product_id') || '');
  if (!/^\d+$/.test(productId) || (expectedProductId && productId !== expectedProductId)) throw fail('variable product id mismatch');
  const title = clean($('.summary h1.product_title').first().text());
  if (!productTitle.test(title)) throw fail('variable page is not a MacBook');
  if (!/Цена указана при наличном расч[её]те/i.test(clean($('.summary').text()))) throw fail('cash price not confirmed');
  const description = clean($('.woocommerce-Tabs-panel--description').text());
  const neo = neoSpecification(title, description);
  const phone = Boolean(iphoneModel(title));
  const optionLabels = new Map();
  form.find('select[name]').each((_, element) => {
    const select = $(element), name = select.attr('name');
    if (!['attribute_pa_czvet', 'attribute_pa_obem-pamyati', ...(phone ? ['attribute_pa_svyaz'] : [])].includes(name)) throw fail(`unsupported variant option: ${name}`);
    const labels = new Map();
    select.find('option[value]').each((_, option) => { const value = $(option).attr('value'); if (value) labels.set(value, clean($(option).text())); });
    optionLabels.set(name, labels);
  });
  if (optionLabels.size !== (phone ? 3 : 2)) throw fail('incomplete variable options');
  let variants;
  try { variants = suppliedVariants || JSON.parse(form.attr('data-product_variations')); }
  catch { throw fail('invalid variable product data'); }
  if (!Array.isArray(variants) || !variants.length) throw fail('incomplete crawl: variation data missing or requires AJAX');
  const ids = new Set(), combinations = new Set(), offers = [];
  for (const variant of variants) {
    const id = String(variant?.variation_id ?? '');
    if (!/^\d+$/.test(id) || ids.has(id)) throw fail('invalid or duplicate variation id');
    ids.add(id);
    if (!variant.attributes || Object.keys(variant.attributes).length !== optionLabels.size) throw fail(`incomplete variant attributes: ${id}`);
    const selected = new Map();
    const variantUrl = new URL(url);
    for (const [name, value] of Object.entries(variant.attributes)) {
      const label = optionLabels.get(name)?.get(value);
      if (!label) throw fail(`unsupported or wildcard variant attribute: ${id}`);
      selected.set(name, label); variantUrl.searchParams.set(name, value);
    }
    variantUrl.searchParams.sort();
    const key = variantUrl.search;
    if (combinations.has(key)) throw fail('duplicate variant options');
    combinations.add(key);
    const amount = price(variant.display_price);
    if (!amount) throw fail(`invalid current variant price: ${id}`);
    const renderedPrice = load(String(variant.price_html || ''));
    if (currentPrice(renderedPrice, renderedPrice.root()).amount !== amount) throw fail(`variant price differs from rendered RUB price: ${id}`);
    const minimumQuantity = Number(variant.min_qty ?? 1);
    if (!Number.isInteger(minimumQuantity) || minimumQuantity < 1) throw fail(`invalid variant minimum quantity: ${id}`);
    if (typeof variant.is_in_stock !== 'boolean' || typeof variant.is_purchasable !== 'boolean' || typeof variant.variation_is_active !== 'boolean' || typeof variant.variation_is_visible !== 'boolean') throw fail(`missing variant availability: ${id}`);
    const colorLabel = selected.get('attribute_pa_czvet');
    const color = variantColor(colorLabel, variant, Boolean(neo), iphoneModel(title));
    const memory = selected.get('attribute_pa_obem-pamyati');
    if (neo && !/^8\s*\/\s*(?:256|512)\s*GB$/i.test(memory)) throw fail(`unverified Neo memory: ${memory}`);
    const variantTitle = `${neo || normalizedTitle(title)} ${memory} ${color} ${phone ? selected.get('attribute_pa_svyaz') : ''}`;
    const onBackorder = /available-on-backorder|предзаказ|под заказ|on backorder/i.test(String(variant.availability_html || ''));
    const stock = !variant.is_in_stock || !variant.is_purchasable || !variant.variation_is_active || !variant.variation_is_visible || onBackorder ? 'OutOfStock' : 'InStock';
    offers.push(normalizedOffer({ title: variantTitle, url: productUrl(variantUrl.href), amount, rawPrice: String(variant.display_price), stock,
      externalId: id, productId, variantId: id, minimumQuantity, fetchedAt,
      evidence: { method: 'woocommerce-product-variations-v1', productPage: url, sourceProductTitle: title,
        sourceVariantId: id, sourceVariantAttributes: variant.attributes, sourceColorLabel: colorLabel,
        ...(phone ? { sourceColorImage: variant.image?.url || variant.image?.title } : {}),
        sourceCurrentPrice: variant.display_price, sourceRegularPrice: variant.display_regular_price,
        cashPriceNotice: 'Цена указана при наличном расчёте', sourceInStock: variant.is_in_stock,
        sourcePurchasable: variant.is_purchasable, sourceBackordersAllowed: variant.backorders_allowed, sourceOnBackorder: onBackorder,
        ...(neo ? { detailSpecifications: 'A18 Pro; 6 ядер CPU; 5 ядер GPU; 8 ГБ памяти; 13-дюймовый экран', sourceColorImage: variant.image?.url || variant.image?.title, supplementedFields: ['chip', 'screenIn', 'cpuCores', 'gpuCores'] } : {}),
      } }));
  }
  return { productId, offers };
}

/** Completes every category and exact variant before returning a new snapshot. */
export async function fetchHitappleOffers({ fetchPage = url => fetch(url, { signal: AbortSignal.timeout(20000) }), maxPages = 30, catalogueUrl = catalogUrl } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw fail('maxPages must be between 1 and 100');
  const fetchedAt = new Date().toISOString();
  const seen = new Set(), entries = new Map(), variableProducts = new Map();
  const stats = { catalogPagesFetched: 0, productPagesFetched: 0, catalogCards: 0, products: 0, variants: 0, inStock: 0, outOfStock: 0, preOrder: 0 };
  const read = async url => {
    if (seen.has(url)) throw fail('incomplete crawl: repeated page');
    if (seen.size >= maxPages) throw fail(`incomplete crawl: more than ${maxPages} pages`);
    seen.add(url);
    return responseText(await fetchPage(url), url);
  };
  if (![catalogUrl, `${origin}/category/iphone/`].includes(catalogueUrl)) throw fail('unsupported catalogue URL');
  const roots = discoverHitappleCategories(await read(catalogueUrl), { phones: catalogueUrl !== catalogUrl });
  stats.catalogPagesFetched++;
  for (const root of roots) {
    let url = root;
    const expectedPages = new Set();
    while (url) {
      const page = parseHitappleCategory(await read(url), url, { fetchedAt });
      stats.catalogPagesFetched++; stats.catalogCards += page.cardCount;
      page.pages.forEach(value => expectedPages.add(value));
      for (const entry of page.entries) {
        if (entries.has(entry.id)) throw fail(`incomplete crawl: repeated catalogue product ${entry.id}`);
        entries.set(entry.id, entry);
        if (entry.type !== 'simple') {
          const parent = parentUrl(entry.url), prior = variableProducts.get(parent);
          if (entry.type === 'variable') {
            if (prior?.id && prior.id !== entry.id) throw fail('variable parent identity mismatch');
            variableProducts.set(parent, { ...(prior || {}), id: entry.id });
          } else if (!prior) variableProducts.set(parent, {});
        }
      }
      url = page.next;
    }
    if ([...expectedPages].some(page => !seen.has(page))) throw fail('incomplete crawl: not all pagination links were fetched');
  }
  const offers = [...entries.values()].flatMap(entry => entry.offer ? [entry.offer] : []);
  for (const [url, parent] of variableProducts) {
    const html = await read(url);
    const $ = load(html), form = $('.summary form.variations_form').first();
    let variants = null;
    if (iphoneModel($('.summary h1.product_title').first().text()) && form.attr('data-product_variations') === 'false') {
      const productId = form.attr('data-product_id');
      const selections = form.find('select[name]').map((_, element) => {
        const select = $(element), name = select.attr('name');
        if (!['attribute_pa_czvet', 'attribute_pa_obem-pamyati', 'attribute_pa_svyaz'].includes(name)) throw fail(`unsupported AJAX variant option: ${name}`);
        return { name, values: select.find('option[value]').map((_, option) => $(option).attr('value')).get().filter(Boolean) };
      }).get();
      if (selections.length !== 3 || !/^\d+$/.test(productId || '')) throw fail('incomplete AJAX phone options');
      let combinations = [{}];
      for (const { name, values } of selections) combinations = combinations.flatMap(prior => values.map(value => ({ ...prior, [name]: value })));
      if (!combinations.length || combinations.length > 64) throw fail('unsupported AJAX phone combination count');
      variants = [];
      const queue = [...combinations];
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (queue.length) {
          const attributes = queue.shift();
          const endpoint = `${origin}/?wc-ajax=get_variation`;
          const body = new URLSearchParams({ product_id: productId, ...attributes });
          let variant;
          try { variant = JSON.parse(await responseText(await fetchPage(endpoint, { method: 'POST', body }), endpoint)); }
          catch (error) { throw fail(`phone variation lookup failed: ${error.message}`); }
          if (variant === false) continue;
          if (!variant || Object.keys(attributes).some(name => variant.attributes?.[name] !== attributes[name])) throw fail('AJAX phone variation selection mismatch');
          variants.push(variant);
        }
      }));
    }
    const parsed = parseHitappleVariations(html, url, { expectedProductId: parent.id, fetchedAt, variants });
    stats.productPagesFetched++;
    const byId = new Map(parsed.offers.map(offer => [offer.externalId, offer]));
    for (const entry of entries.values()) {
      if (entry.type !== 'variation' || parentUrl(entry.url) !== url) continue;
      const offer = byId.get(entry.id);
      if (!offer || offer.url !== entry.url || offer.price !== entry.amount || !offer.evidence.sourceInStock !== (entry.stock === 'OutOfStock')) throw fail(`incomplete crawl: variant ${entry.id} differs between catalogue and product page`);
    }
    for (const offer of parsed.offers) {
      if (entries.get(offer.externalId)?.type === 'simple' || offers.some(prior => prior.externalId === offer.externalId)) throw fail('duplicate offer identity');
      offers.push(offer);
    }
  }
  if (!offers.length) throw fail('incomplete crawl: no priced MacBook configurations');
  stats.products = [...entries.values()].filter(entry => entry.type === 'simple').length + variableProducts.size;
  stats.variants = offers.length;
  stats.inStock = offers.filter(offer => offer.stock === 'InStock').length;
  stats.outOfStock = offers.filter(offer => offer.stock === 'OutOfStock').length;
  stats.preOrder = offers.filter(offer => offer.stock === 'PreOrder').length;
  return { offers, failures: [], stats };
}
