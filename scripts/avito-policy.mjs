import { canonicalStorageGb } from './domain.mjs';
import { parseProduct } from './offer-normalization.mjs';

export const AVITO = 'Авито НН';
export const AVITO_VERSION = 'avito-nn-private-used-v4';
export const sellerNameKey = value => String(value || '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
export const excludedSeller = value => /макбучн|мкбчн|macbookbro|makbuchn|mkbchn/.test(sellerNameKey(value));
export const avitoUsedCondition = value => /^(?:б\s*\/\s*у|used|как\s+нов(?:ое|ый|ая)|отличное|хорошее|удовлетворительное)$/i.test(String(value || '').trim());
export const businessSellerName = value => /магазин|компания|сервис|салон|\bstore\b|\bshop\b|re\s*[:.-]?\s*sale|ресейл|айдевайс|айфонберри|mac\s*&\s*devices|apple\s*[- ]*trade|оптов|ооо\b/i.test(String(value || ''));
export const businessSellerDescription = value => /trade[\s-]*in|трейд[\s-]*ин|(?:выкуп|скупка)\s+(?:вашей|вашего|ваших|техники)|(?:наш|нашем|нашему)\s+магазин|(?:скидки|акции)[\s\S]{0,120}закрыто(?:му|е)\s+сообществ/i.test(String(value || ''));
export const macBookIdentity = value => /mac[k]?book|макбук/i.test(String(value || ''));
export function avitoSellerType(item) {
  const seller = item?.seller || {};
  if (seller.isShop === true || seller.shopName || businessSellerName(seller.name) || businessSellerDescription(item?.description)
    || /company|business|компания|магазин/i.test(`${seller.type || ''} ${seller.declaredType || ''} ${seller.postfix || ''}`)) return 'company';
  return seller.type === 'private' ? 'private' : 'unknown';
}
export const avitoGroupKey = o => [o.model, o.chip, o.screenIn, o.ramGb, canonicalStorageGb(o.storageGb), o.color, o.condition === 'used' ? 'used' : 'new'].join('|');
export function avitoUrl(value, { listing = false } = {}) {
  let url;
  try { url = new URL(value, 'https://www.avito.ru'); } catch { throw new Error('Авито: некорректная ссылка'); }
  if (url.protocol !== 'https:' || !['www.avito.ru', 'avito.ru'].includes(url.hostname) || url.port || url.username || url.password) throw new Error('Авито: ссылка вне разрешённого домена');
  url.hostname = 'www.avito.ru'; url.hash = '';
  if (listing) {
    if (!/\/[^/]+_\d{6,}$/.test(url.pathname)) throw new Error('Авито: ссылка не ведёт на объявление');
    url.search = '';
  }
  return url.href;
}

// Marketplace identity remains separate from retailer identity in SQLite.
// A store match is supplied ONLY by an explicit profile-ID map, never by name.
export function normalizeAvitoListing(item, { observedAt, sellerMap = {} } = {}) {
  const reject = (reason, status = 'excluded') => ({ status, id: String(item.id || ''), reason });
  const seller = item.seller || {};
  if (/^(новое|новый|новая|new)$/i.test(String(item.condition || '').trim())) return reject('Новые устройства исключены: только б/у от частных продавцов');
  const sellerType = avitoSellerType(item);
  if (sellerType === 'company' || sellerMap[String(seller.id)]) return reject('Магазин или компания исключены');
  if (!seller.name || !seller.id) return reject('Не установлен продавец', 'review');
  if (excludedSeller(seller.name) || excludedSeller(seller.id) || excludedSeller(sellerMap[String(seller.id)])) return reject('Исключённый продавец');
  if (!item.city || !item.condition) return reject('Не установлены город или состояние', 'review');
  if (!/^нижний\s+новгород$/i.test(String(item.city || '').trim())) return reject('Город не подтверждён как Нижний Новгород');
  const conditionText = String(item.condition || '').trim();
  const condition = avitoUsedCondition(conditionText) ? 'used' : null;
  if (!condition) return reject('Не подтверждено рабочее б/у состояние');
  if (sellerType !== 'private') return reject('Не подтверждён частный продавец', 'review');
  const title = String(item.title || '').trim();
  if (/^(?:ноутбук\s+)?(?:razer|honor|hp|huawei|asus|acer|lenovo|dell|msi)\b/i.test(title) || (!macBookIdentity(title) && !macBookIdentity(item.specs?.model))) return reject('Объявление не о MacBook');
  const conditionTitle = title.replace(/не\s+вскрыт[а-я]*/gi, 'запечатан').replace(/как\s+нов[а-я]*/gi, 'б/у');
  if (/скупк|выкуп|ремонт|запчаст|чехол|коробка\s+(?:от|для)|аренд|витрин|refurb|восстановлен|open.?box|не\s*рабоч|не\s*работа|неисправ|разбит|залит/i.test(conditionTitle)) return reject('Состояние или тип товара противоречат фильтрам');
  if (condition === 'new' && /б\s*\/\s*у|вскрыт|\bused\b/i.test(conditionTitle)) return reject('Заголовок противоречит новому состоянию');
  if (condition === 'used' && /(?:^|\s)(?:новый|новая|новое|запечатан[а-я]*|new)(?:\s|[,.!?]|$)/i.test(conditionTitle)) return reject('Заголовок противоречит б/у состоянию', 'review');
  if (condition === 'used' && /(?:^|[.!?\n])\s*(?:ноутбук\s+|товар\s+)?(?:новый|новая|новое|запечатан[а-я]*)(?:\s|[,.!?]|$)|состояние\s*:\s*нов[а-я]+/i.test(item.description || '')) return reject('Описание противоречит б/у состоянию', 'review');
  if (condition === 'new' && /состояние\s*:\s*(?:б\s*\/\s*у|как\s+нов|витрин|восстановлен)|(?:^|[.!?])\s*(?:ноутбук|товар|макбук|устройство)\s+(?:б\s*\/\s*у|восстановлен|витрин)/i.test(item.description || '')) return reject('Описание противоречит новому состоянию');
  if (item.nonWorking === true || /(?:^|[.!?\n])\s*(?:ноутбук|товар|макбук|устройство|экран|клавиатура)\s+(?:не\s+работает|неисправ[а-я]*|разбит[а-я]*|залит[а-я]*)/i.test(item.description || '')) return reject('Неисправное устройство');
  if (Array.isArray(item.adapterReviewReasons) && item.adapterReviewReasons.length) return reject(item.adapterReviewReasons.map(String).join('; '), 'review');
  const memoryPairs = [...title.matchAll(/\d{1,3}\s*\/\s*\d{1,4}\s*(?:TB|ТБ|GB|ГБ)?/gi)].map(m => m[0].replace(/\s/g, '').toLowerCase());
  if (new Set(memoryPairs).size > 1) return reject('Несколько конфигураций в одном объявлении', 'review');
  // Do not infer an unconditional full price from an installment or promo.
  if (item.priceType !== 'full' || item.currency !== 'RUB' || !Number.isSafeInteger(item.price * 100) || item.price <= 0) return reject('Не подтверждена полная рублёвая цена', 'review');
  if (/(?:^|\s)от\s+\d|в\s+месяц|\/\s*мес|первоначальн|при\s+(?:обмене|сдаче|покупке\s+гарантии)|только\s+(?:в\s+кредит|при)/i.test(`${item.priceText || ''} ${title}`)) return reject('Условная цена', 'review');
  const at = item.observedAt || observedAt;
  if (!Number.isFinite(Date.parse(at))) return reject('Нет времени наблюдения', 'review');
  let url;
  try { url = avitoUrl(item.url, { listing: true }); } catch { return reject('Некорректная ссылка', 'review'); }
  const externalId = new URL(url).pathname.match(/_(\d+)$/)[1];
  if (String(item.id) !== externalId) return reject('ID не совпадает со ссылкой', 'review');
  const specs = item.specs || {};
  const modelCase = value => String(value || '').replace(/\bmacbook\s+(air|pro|neo)\b/gi, (_, family) => `MacBook ${family[0].toUpperCase()}${family.slice(1).toLowerCase()}`);
  const titleNormalized = modelCase(conditionTitle.replace(/макбук/gi, 'MacBook').replace(/эйр/gi, 'Air').replace(/про(?=\s|$)/gi, 'Pro'));
  // Slugs are not evidence: ID-only URL prevents stale slug specifications
  // from completing an otherwise ambiguous configuration.
  const parseUrl = `https://www.avito.ru/nizhniy_novgorod/noutbuki/item_${externalId}`;
  const fromTitle = parseProduct(titleNormalized, parseUrl, AVITO, item.price, at);
  const specValue = k => specs[k] ?? fromTitle?.[k];
  // Avito's generic color vocabulary names the Air's Sky Blue as «Голубой».
  // Limit that alias to the matching Air generations in our catalogue.
  const color = /^голубой$/i.test(String(specValue('color'))) && /MacBook Air/i.test(specValue('model')) && /^M[45]$/i.test(fromTitle?.chip || '') ? 'Sky Blue' : specValue('color');
  const synthetic = [modelCase(specValue('model')), specValue('chip'), specValue('ramGb') ? `RAM ${specValue('ramGb')}GB` : '', specValue('storageGb') ? `SSD ${specValue('storageGb')}GB` : '', color,
    specValue('cpuCores') ? `${specValue('cpuCores')}-core CPU` : '', specValue('gpuCores') ? `${specValue('gpuCores')}-core GPU` : ''].filter(Boolean).join(' ');
  const fromSpecs = parseProduct(synthetic, parseUrl, AVITO, item.price, at);
  if (fromTitle && fromSpecs) for (const field of ['model', 'chip', 'ramGb', 'storageGb', 'screenIn', 'color', 'cpuCores', 'gpuCores']) {
    if (fromTitle[field] && fromSpecs[field] && fromTitle[field] !== 'unknown' && fromSpecs[field] !== 'unknown' && fromTitle[field] !== fromSpecs[field]) return reject(`Конфликт характеристики: ${field}`, 'review');
  }
  const parsed = fromSpecs || fromTitle;
  if (!parsed || !parsed.screenIn || parsed.color === 'unknown' || parsed.qualityWarnings.length) return reject('Недостаточно однозначных характеристик', 'review');
  if (fromTitle && fromTitle.condition !== 'unknown' && fromTitle.condition !== condition) return reject('Состояние противоречит заголовку');
  const risks = Array.isArray(item.adapterRisks) ? [...new Set(item.adapterRisks.filter(risk => typeof risk === 'string').map(risk => risk.slice(0, 200)))] : [];
  if (/под\s*заказ|предзаказ|срок\s+поставки/i.test(`${title} ${item.description || ''}`)) risks.push('Товар под заказ');
  if (/цена\s+от\s+\d|цена\s+(?:при|с\s+уч[её]том)|первоначальный\s+взнос/i.test(item.description || '')) risks.push('Условия цены требуют проверки');
  const sellerId = String(seller.id).slice(0, 250);
  return { status: 'accepted', offer: {
    ...parsed, url, externalId, listingId: `avito:${externalId}`, sourceId: 'avito:nn', sourceType: 'marketplace',
    sellerId: 'avito:marketplace', marketplaceSellerId: sellerId, sellerName: String(seller.name).slice(0, 200),
    marketplaceSellerType: 'private',
    matchedRetailer: sellerMap[sellerId] || null, sourceCity: 'Нижний Новгород',
    title, rawTitle: title, condition, stock: item.active === false ? 'Discontinued' : 'source_reported',
    priceType: 'full', paymentMethod: 'unknown', buyerType: 'retail', minimumQuantity: 1,
    validationStatus: 'accepted', avitoRisks: risks, adapterVersion: AVITO_VERSION,
    evidence: { method: item.method || 'avito-record-v1', observedAt: at, condition: item.condition, city: item.city,
      sellerId, sellerType: 'private', sellerName: String(seller.name).slice(0, 200), specs, priceText: item.priceText || String(item.price), documentHash: item.documentHash || null },
  } };
}

export function visibleAvitoOffer(offer) {
  return offer.retailer !== AVITO || (offer.condition === 'used' && offer.marketplaceSellerType === 'private' && offer.sourceCity === 'Нижний Новгород'
    && offer.marketplaceSellerId && offer.sellerName && !excludedSeller(offer.sellerName) && !excludedSeller(offer.marketplaceSellerId)
    && !businessSellerName(offer.sellerName) && !offer.matchedRetailer
    && !offer.rejected && offer.validationStatus !== 'rejected' && !['Discontinued', 'SoldOut', 'OutOfStock'].includes(offer.stock));
}
