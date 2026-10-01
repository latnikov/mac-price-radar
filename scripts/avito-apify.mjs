import { createHash } from 'node:crypto';
import { avitoUrl } from './avito-policy.mjs';

const tidy = value => typeof value === 'string' || typeof value === 'number'
  ? String(value).normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
const key = value => tidy(value).toLowerCase().replace(/ё/g, 'е');
// Sellers often mix Latin lookalikes into Russian promotional copy. Use this
// only for risk detection; never rewrite the evidence or infer specifications.
const riskText = value => key(value).replace(/[aceopxy]/g, c => ({ a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у' })[c]);
const listingId = value => /^(?:\d{6,})$/.test(tidy(value)) && (typeof value !== 'number' || Number.isSafeInteger(value)) ? tidy(value) : '';
const at = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;

function sellerFrom(record, reasons) {
  const seller = record.seller && typeof record.seller === 'object' ? record.seller : {};
  let id = tidy(seller.userKey || seller.id), profileUrl = '';
  if (seller.profileUrl) {
    try {
      profileUrl = avitoUrl(seller.profileUrl);
      const profileId = new URL(profileUrl).pathname.match(/^\/user\/([a-zA-Z0-9_-]{1,250})\/profile\/?$/)?.[1];
      if (!profileId || (id && profileId !== id)) throw new Error('profile');
      id ||= profileId;
      profileUrl = `https://www.avito.ru/user/${profileId}/profile`;
    } catch {
      reasons.push('ID продавца не подтверждён ссылкой на профиль');
      id = '';
      profileUrl = '';
    }
  }
  if (!/^[a-zA-Z0-9_-]{1,250}$/.test(id)) id = '';
  return { id, name: tidy(seller.name).slice(0, 200), type: record.userType === 'private' ? 'private' : record.userType === 'company' ? 'company' : 'unknown',
    declaredType: tidy(seller.sellerType || seller.type), isShop: seller.isShop === true,
    shopName: tidy(seller.shopName), postfix: tidy(seller.postfix), ...(profileUrl ? { profileUrl } : {}) };
}

function cityFrom(record, reasons) {
  const city = tidy(record.city), address = tidy(record.address);
  // Only an explicit comma-separated locality is evidence. A search location,
  // URL slug, region name or delivery promise does not establish the city.
  const isNizhny = value => /^(?:г\.\s*о\.\s*|городской\s+округ\s+|г(?:ород)?\.?\s+)?нижний\s+новгород$/i.test(value);
  const addressNizhny = address.split(',').some(part => isNizhny(part.trim()));
  if (city && address && isNizhny(city) !== addressNizhny) {
    reasons.push('Город противоречит адресу объявления');
    return '';
  }
  return addressNizhny || isNizhny(city) ? 'Нижний Новгород' : city || address;
}

function parametersFrom(record, reasons) {
  const parameters = new Map();
  for (const entry of Array.isArray(record.parameters) ? record.parameters : []) {
    const name = key(entry?.name), value = tidy(entry?.value);
    if (!name || !value) continue;
    if (parameters.has(name) && key(parameters.get(name)) !== key(value)) reasons.push(`Несколько значений характеристики: ${name}`);
    else parameters.set(name, value);
  }
  return parameters;
}

function specsFrom(parameters, reasons) {
  const specs = {};
  const value = (...names) => {
    const found = names.map(name => parameters.get(name)).filter(Boolean);
    if (new Set(found.map(key)).size > 1) reasons.push(`Несколько значений характеристики: ${names[0]}`);
    return found[0] || '';
  };
  const model = value('модель');
  if (model) {
    // Avito puts the Neo's explicit screen size before its family name.
    specs.model = model.replace(/\bmacbook\s+(13)\s+neo\b/i, 'MacBook Neo $1');
    if (/\b(?:air|pro|neo)\s*(?:\/|или)/i.test(model)) reasons.push('Несколько моделей в характеристиках');
  }
  const number = (name, raw, scale = 1) => {
    if (!raw) return;
    const match = raw.match(/^(\d+(?:[.,]\d+)?)\s*(GB|ГБ|TB|ТБ|дюйм(?:а|ов)?|["″])?$/i);
    if (!match) { reasons.push(`Неоднозначная характеристика: ${name}`); return; }
    const parsed = Number(match[1].replace(',', '.')) * (/^(?:TB|ТБ)$/i.test(match[2] || '') ? 1000 : scale);
    if (parsed > 0 && Number.isFinite(parsed)) specs[name] = parsed;
    else reasons.push(`Некорректная характеристика: ${name}`);
  };
  number('ramGb', value('оперативная память, гб', 'объем оперативной памяти', 'оперативная память'));
  number('storageGb', value('объем накопителей, гб', 'объем накопителя, гб', 'объем ssd', 'общий объем накопителей', 'встроенная память', 'объем встроенной памяти', 'объем памяти'));
  number('screenIn', value('диагональ, дюйм', 'диагональ экрана', 'диагональ'));
  number('cpuCores', value('количество ядер процессора'));
  const chip = value('процессор', 'линейка процессора');
  if (chip) {
    const match = chip.match(/^(?:Apple\s+)?(M\d+(?:\s+(?:Pro|Max|Ultra))?|A\d{2}\s+Pro)$/i);
    if (match) specs.chip = match[1];
    else reasons.push('Процессор не подтверждён однозначными характеристиками');
  }
  const gpu = value('видеокарта');
  if (gpu) {
    const match = gpu.match(/^Apple\s+graphics\s+(\d+)-core$/i);
    if (match) specs.gpuCores = Number(match[1]);
  }
  const color = value('цвет');
  if (color) {
    specs.color = color;
    if (/[/;]|\sили\s/i.test(color)) reasons.push('Несколько цветов в характеристиках');
    if (/\bNeo\b/i.test(specs.model || '') && /^желтый$/i.test(key(color))) specs.color = 'Citrus';
    if (/\bAir\b/i.test(specs.model || '') && /^M[45]$/i.test(specs.chip || '') && key(color) === 'голубой') specs.color = 'Sky Blue';
  }
  const simType = value('тип sim-карты', 'тип sim', 'sim-карты');
  if (simType) specs.simType = simType;
  const region = value('регион');
  if (region) specs.region = region;
  // Existing normalization derives the screen from the model string. Add only
  // an explicitly supplied size, never a catalogue default or slug value.
  if (specs.model && !/\b(?:13|14|15|16)\b/.test(specs.model) && specs.screenIn) {
    const size = { 13: 13, 13.3: 13, 13.6: 13, 14: 14, 14.2: 14, 15: 15, 15.3: 15, 16: 16, 16.2: 16 }[specs.screenIn];
    if (size) specs.model = specs.model.replace(/\b(MacBook\s+(?:Air|Pro|Neo))\b/i, `$1 ${size}`);
  }
  const modelSize = Number(specs.model?.match(/\b(?:Air|Pro|Neo)\s+(13|14|15|16)\b/i)?.[1]);
  if (modelSize && specs.screenIn && Math.floor(specs.screenIn) !== modelSize) reasons.push('Диагональ противоречит модели');
  return specs;
}

function convert(record, id, runId) {
  const reasons = [], parameters = parametersFrom(record, reasons);
  let url = '';
  try {
    url = avitoUrl(record.url);
    const parsed = new URL(url);
    const linkedId = parsed.pathname.match(/\/[^/]+_(\d{6,})$/)?.[1];
    if (linkedId !== id) {
      reasons.push(linkedId ? 'ID не совпадает со ссылкой' : 'Не получена полная ссылка на объявление');
      // Keep a legitimate short link for review without inventing a slug.
      if (parsed.pathname !== `/${id}`) url = '';
    }
    if (url) { parsed.search = ''; url = parsed.href; }
  } catch { reasons.push('Некорректная ссылка на объявление'); }
  const title = tidy(record.title), description = typeof record.description === 'string' ? record.description : '';
  const seller = sellerFrom(record, reasons), city = cityFrom(record, reasons);
  const specs = specsFrom(parameters, reasons);
  const currency = /^(?:₽|RUB|RUR|руб\.?)$/i.test(tidy(record.currency)) ? 'RUB' : tidy(record.currency);
  const price = typeof record.price === 'number' ? record.price : NaN;
  const priceText = tidy(record.priceFormatted);
  if (priceText) {
    const match = priceText.match(/^([\d\s]+(?:[.,]\d{1,2})?)\s*(?:₽|RUB|руб\.?)$/i);
    if (!match || Number(match[1].replace(/\s/g, '').replace(',', '.')) !== price) reasons.push('Цена не совпадает с отображаемой полной ценой');
  }
  // Optional installments alone do not turn an advertised full cash price
  // into a monthly amount. Explicit promo/conditional prices require review.
  if (/(?:^|\s)от\s+\d|в\s+месяц|\/\s*мес|первоначальн|при\s+(?:обмене|сдаче|покупке\s+гарантии)|только\s+(?:в\s+кредит|при)/i.test(`${title} ${priceText}`)
    || /промокод|промо-код|цена\s+(?:при\s|с\s+уч[её]том|от\s+\d)|первоначальный\s+взнос/i.test(riskText(description))) reasons.push('Условная или рекламная цена требует проверки');
  const adapterRisks = /под\s*заказ|предзаказ|срок\s+(?:поставки|привоза)|производите\s+предоплату/i.test(riskText(`${title} ${description}`)) ? ['Товар под заказ'] : [];
  const status = key(record.status);
  if (!['active', 'removed', 'closed', 'sold', 'archived', 'inactive'].includes(status)) reasons.push('Статус объявления не подтверждён');
  if (record.error || record.errorMessage) reasons.push('Сервис не получил полную карточку объявления');
  const adapterReviewReasons = [...new Set(reasons)];
  const nonWorking = parameters.has('неисправны устройства') && !/^(?:нет|нет неисправностей|отсутствуют)$/i.test(parameters.get('неисправны устройства'));
  return {
    id, url, title, description, seller, city, condition: parameters.get('состояние') || '', specs,
    price: Number.isFinite(price) ? price : null, priceText, currency,
    // This fallback also prevents acceptance by older policy versions which
    // do not yet display adapterReviewReasons.
    priceType: adapterReviewReasons.length ? 'unknown' : 'full',
    active: status === 'active', observedAt: record.scrapedAt,
    method: 'apify-avito-v1', sourceRunId: runId,
    documentHash: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
    ...(adapterReviewReasons.length ? { adapterReviewReasons } : {}),
    ...(adapterRisks.length ? { adapterRisks } : {}),
    ...(nonWorking ? { nonWorking: true } : {}),
  };
}

/** Convert an Apify dataset without granting it completeness or freshening it. */
export function apifySnapshot(records, { runId, startedAt, finishedAt, now = Date.now() } = {}) {
  if (!Array.isArray(records)) throw new Error('Apify: выгрузка должна быть массивом объявлений');
  const started = at(startedAt), finished = at(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || started > finished || !Number.isFinite(now) || finished > now + 60000) throw new Error('Apify: некорректные даты запуска');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(tidy(runId))) throw new Error('Apify: не указан корректный ID запуска');
  const found = new Set(), listings = new Map(), skipped = [];
  let duplicates = 0, detailed = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const id = listingId(record?.id);
    if (!id) { skipped.push({ index, reason: 'Нет корректного ID объявления' }); continue; }
    found.add(id);
    const observed = at(record.scrapedAt);
    if (!Number.isFinite(observed) || observed < started || observed > finished) {
      skipped.push({ id, reason: 'Время получения карточки отсутствует или вне дат запуска' });
      continue;
    }
    const item = convert(record, id, tidy(runId)), previous = listings.get(id);
    if (previous) {
      duplicates++;
      if (observed < Date.parse(previous.observedAt)) continue;
      if (observed === Date.parse(previous.observedAt) && (item.documentHash !== previous.documentHash || previous.adapterReviewReasons?.includes('Разные версии объявления с одинаковым временем получения'))) {
        item.adapterReviewReasons = [...new Set([...(item.adapterReviewReasons || []), 'Разные версии объявления с одинаковым временем получения'])];
        item.priceType = 'unknown';
      }
    }
    listings.set(id, item);
  }
  if (listings.size > 3000) throw new Error('Apify: снимок превышает поддерживаемые 3000 карточек');
  const items = [...listings.values()];
  detailed = items.filter(item => item.city && item.condition && item.seller.id && item.seller.name && item.url && !/^https:\/\/www\.avito\.ru\/\d+$/.test(item.url)).length;
  const reviewReasons = {};
  for (const item of items) for (const reason of item.adapterReviewReasons || []) reviewReasons[reason] = (reviewReasons[reason] || 0) + 1;
  return {
    schemaVersion: 1, scope: 'avito-nizhny-macbook', startedAt, completedAt: finishedAt,
    complete: false, discovered: found.size, expectedTotal: null, pages: 0, listings: items,
    failures: ['Apify: полнота охвата Авито не подтверждена; отсутствующие объявления не снимаются'],
    source: 'apify', runId: tidy(runId),
    diagnostics: { received: records.length, unique: found.size, detailed, duplicates, skipped, reviewReasons },
  };
}
