import { canonicalModelName, canonicalStorageGb, known, moneyMinor, normalize } from './domain.mjs';
import { AVITO, visibleAvitoOffer } from './avito-policy.mjs';
import { isProcurementOffer } from '../web/retail-analytics.js';

export const AVITO_PROCUREMENT_VERSION = 'russian-procurement-gap-v1';
const CORE = ['model', 'chip', 'screenIn', 'ramGb', 'storageGb'];
const EXTRA = ['cpuCores', 'gpuCores', 'keyboard', 'region', 'displayType', 'bundle'];
const available = new Set(['InStock', 'source_reported', 'confirmed']);
const value = (o, k) => k === 'storageGb' ? canonicalStorageGb(o[k]) : k === 'model' ? canonicalModelName(o[k]) : o[k];
const at = o => Date.parse(o.observedAt || o.fetchedAt);
const basic = o => CORE.every(k => known(value(o, k))) && ['screenIn','ramGb','storageGb'].every(k => Number.isFinite(value(o,k)) && value(o,k) > 0);
const same = (a, b) => CORE.every(k => normalize(value(a,k)) === normalize(value(b,k)))
  && EXTRA.every(k => !known(a[k]) || !known(b[k]) || normalize(a[k]) === normalize(b[k]));
const valid = (o, now) => o && o.visibility !== 'private' && o.currency === 'RUB' && typeof o.price === 'number' && moneyMinor(o.price) !== null
  && available.has(o.stock) && o.active !== false && !o.withdrawn && !o.rejected && !o.latestAttempt?.rejected
  && !['rejected','invalid'].includes(o.validationStatus) && !['withdrawn','rejected'].includes(o.latestAttempt?.status)
  && !o.qualityWarnings?.length && !o.validationIssues?.length && !o.isDemo && !o.demo && !o.seed && o.dataKind !== 'demo'
  && o.priceType === 'full' && (o.minimumQuantity == null || o.minimumQuantity === 1)
  && Number.isFinite(at(o)) && at(o) <= now + 60_000
  && (!o.validUntil || Date.parse(o.validUntil) > now);

export function russianProcurementOffers(offers, { now = Date.now(), maxAgeHours = 72 } = {}) {
  // The newest observation wins before eligibility: an unavailable latest
  // quote must not resurrect an older, cheaper procurement price.
  const latest = new Map();
  for (const o of offers) {
    if (!o || !isProcurementOffer(o)) continue;
    const key = `${o.retailer}|${o.listingId || o.sourceVariantId || o.url}`;
    if (!latest.has(key) || at(o) >= at(latest.get(key))) latest.set(key,o);
  }
  return [...latest.values()].filter(o => valid(o,now) && basic(o) && /^MacBook\b/i.test(o.model) && o.condition === 'new' && now-at(o) <= maxAgeHours*3_600_000);
}

export function compareAvitoProcurement(offer, procurement, { now = Date.now(), costReserveRub = 3000 } = {}) {
  const reasons = [...(offer.avitoRisks || [])];
  const fresh = valid(offer,now) && now-at(offer) <= 4*3_600_000;
  if (!fresh) reasons.push('Объявление нужно перепроверить: наблюдение старше четырёх часов или наличие не подтверждено');
  const result = { version: AVITO_PROCUREMENT_VERSION, comparisonKind:'russian-procurement-gap',
    referencePrice:null, grossDeltaRub:null, deltaRub:null, deltaPercent:null, costReserveRub,
    procurement:null, matchKind:'none', fresh, alertEligible:false, reasons, score:0, level:'low' };
  if (!basic(offer)) { reasons.push('Недостаточно характеристик для сравнения с русским закупом'); return result; }
  const matches = procurement.filter(p => same(offer,p));
  if (!matches.length) { reasons.push('Нет актуальной цены русского закупа для этой модели, чипа, RAM и SSD'); return result; }
  const colors = matches.filter(p => known(offer.color) && known(p.color) && normalize(offer.color) === normalize(p.color));
  const reference = [...(colors.length ? colors : matches)].sort((a,b) => a.price-b.price || at(b)-at(a) || String(a.listingId).localeCompare(String(b.listingId)))[0];
  const matchKind = colors.length ? 'same_color' : 'other_color';
  if (matchKind === 'other_color') reasons.push(`Цвет не совпадает или не указан: ориентир закупа — ${reference.color || 'не указан'}`);
  const missingCores = ['cpuCores','gpuCores'].some(k => !known(offer[k]) || !known(reference[k]));
  if (missingCores) reasons.push('Проверить число ядер CPU/GPU: в одной из карточек оно не указано');
  reasons.push('Б/у сравнивается с закупом нового MacBook; разница не является ценой перепродажи или прибылью');
  const gross = moneyMinor(reference.price)-moneyMinor(offer.price), net=gross-Math.round(costReserveRub*100);
  const deltaPercent = net/moneyMinor(reference.price)*100;
  const anomaly = offer.price < reference.price*0.6;
  if(anomaly)reasons.push('Разница с закупом превышает 40%: проверить состояние и фактическую цену');
  const jump = offer.previousPrice > 0 && Math.abs(offer.price/offer.previousPrice-1)>0.25;
  if(jump)reasons.push('Цена объявления изменилась более чем на 25%');
  return {...result,referencePrice:reference.price,grossDeltaRub:gross/100,deltaRub:net/100,deltaPercent:Math.round(deltaPercent*100)/100,
    matchKind,procurement:{retailer:reference.retailer,price:reference.price,color:reference.color,
      condition:'new',url:reference.url,observedAt:new Date(at(reference)).toISOString(),listingId:reference.listingId || null},
    alertEligible:fresh && matchKind==='same_color' && !anomaly && !jump && !offer.avitoRisks?.length,
    score:Math.max(0,Math.min(100,Math.round(50+deltaPercent))),level:fresh && matchKind==='same_color'?'high':'medium'};
}

export function rankAvitoProcurementOffers(offers, options = {}) {
  const procurement = russianProcurementOffers(offers,options);
  const result = offers.filter(visibleAvitoOffer).map(o => o.retailer===AVITO
    ? {...o,avitoRank:compareAvitoProcurement(o,procurement,options)} : o);
  const ordered=result.filter(o=>o.retailer===AVITO).sort((a,b)=>
    Number(b.avitoRank.referencePrice!==null)-Number(a.avitoRank.referencePrice!==null)
    || Number(b.avitoRank.fresh)-Number(a.avitoRank.fresh)
    || (b.avitoRank.deltaRub ?? -Infinity)-(a.avitoRank.deltaRub ?? -Infinity)
    || a.price-b.price || String(a.listingId).localeCompare(String(b.listingId)));
  ordered.forEach((o,i)=>{o.avitoRank.position=i+1;o.avitoRank.adjustedPrice=o.price;});
  return result;
}
