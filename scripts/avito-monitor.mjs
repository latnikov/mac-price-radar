import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { calculateAvitoOpportunities } from './avito-opportunities.mjs';
import { publicAvitoState } from './avito-access.mjs';
import { AVITO, visibleAvitoOffer, avitoUrl, avitoUsedCondition, businessSellerName, macBookIdentity } from './avito-policy.mjs';
import { rankAvitoProcurementOffers } from './avito-procurement.mjs';

const read = async (path, fallback) => {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
};
const safeText = (value, max = 250) => typeof value === 'string' ? value
  .replace(/apify_api_[A-Za-z0-9_-]+/g, '[скрыто]')
  .replace(/([?&](?:token|access_token|api_key|key)=)[^\s&"'<>]+/gi, '$1[скрыто]')
  .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [скрыто]')
  .replace(/\b((?:api[_-]?)?token|api[_-]?key|password|authorization|secret)\s*[:=]\s*[^\s,;"'<>]+/gi, '$1=[скрыто]')
  .slice(0, max) : null;
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function publicReview(item) {
  if (!item || item.city !== 'Нижний Новгород' || !/^\d{6,}$/.test(String(item.id))
    || !macBookIdentity(item.title) || item.sellerType !== 'private' || !avitoUsedCondition(item.condition) || businessSellerName(item.sellerName)) return null;
  let url;
  try { url = new URL(avitoUrl(item.url)); } catch { return null; }
  if (!new RegExp(`(?:_|/)${item.id}$`).test(url.pathname)) return null;
  url.search = '';
  return { id: String(item.id), title: safeText(item.title, 300), url: url.href, city: 'Нижний Новгород',
    price: Number.isFinite(item.price) && item.price > 0 ? item.price : null,
    condition: safeText(item.condition, 100), sellerType: 'private', sellerName: safeText(item.sellerName, 200), reason: safeText(item.reason), observedAt: validDate(item.observedAt) };
}
export async function readAvitoMonitor({ root, env = process.env, offers = [], now = Date.now() }) {
  const dir = resolve(root, env.AVITO_DATA_DIR || 'data/private/avito');
  const [saved, reviews, notifications] = await Promise.all([
    read(join(dir, 'apify-state.json'), { state: 'not_configured', message: 'Подключение Apify ещё не настроено' }),
    read(join(dir, 'apify-review-index.json'), {}),
    read(join(dir, 'alerts-state.json'), { enabled: false, channel: 'site' }),
  ]);
  const state = publicAvitoState(saved);
  for (const field of ['state', 'message']) if (field in state) state[field] = safeText(state[field]);
  for (const field of ['startedAt', 'updatedAt', 'retryAfter']) if (field in state) state[field] = validDate(state[field]);
  if (state.access) state.access = { reason: safeText(state.access.reason),
    status: Number.isInteger(state.access.status) ? state.access.status : null, challenge: state.access.challenge === true };
  state.counts = Object.fromEntries(['total', 'accepted', 'review', 'excluded', 'detailed'].filter(key => Number.isFinite(saved.counts?.[key])).map(key => [key, saved.counts[key]]));
  state.budget = Object.fromEntries(['limitUsd', 'spentUsd', 'remainingUsd', 'reservedUsd'].filter(key => Number.isFinite(saved.budget?.[key])).map(key => [key, saved.budget[key]]));
  if (Number.isFinite(Date.parse(saved.budget?.periodEndsAt))) state.budget.periodEndsAt = saved.budget.periodEndsAt;
  if (Number.isFinite(Date.parse(saved.nextRunAt))) state.nextRunAt = saved.nextRunAt;
  const ranked=rankAvitoProcurementOffers(offers,{now}).filter(o=>o.retailer===AVITO && visibleAvitoOffer(o));
  const review=Object.values(reviews).map(publicReview).filter(item=>item?.observedAt);
  const acceptedIds=new Set(ranked.map(o=>String(o.externalId)));
  const listings=[...ranked.map(o=>({id:String(o.externalId),title:safeText(o.title,300),url:o.url,
    sellerName:safeText(o.sellerName,200),price:o.price,condition:'used',observedAt:o.observedAt||o.fetchedAt,
    configuration:[o.model,o.chip,`${o.ramGb}/${o.storageGb}`,o.color].join(' · '),review:false,rank:o.avitoRank})),
    ...review.filter(o=>!acceptedIds.has(o.id)).map(o=>({...o,review:true,
      rank:{referencePrice:null,deltaRub:null,reasons:[o.reason,'Характеристики требуют проверки; сравнение с закупом не рассчитано']}}))];
  listings.sort((a,b)=>Number(b.rank.referencePrice!==null)-Number(a.rank.referencePrice!==null)
    || Number(b.rank.fresh===true)-Number(a.rank.fresh===true)
    || (b.rank.deltaRub??-Infinity)-(a.rank.deltaRub??-Infinity)
    || (a.price??Infinity)-(b.price??Infinity) || a.id.localeCompare(b.id));
  listings.forEach((o,i)=>{o.position=i+1;});
  return { state, opportunities: calculateAvitoOpportunities(offers, { now }),listings,
    listingSummary:{total:listings.length,compared:listings.filter(o=>o.rank.referencePrice!==null).length,review:review.length,
      procurementSources:['Дима','BSA'],procurementMaxAgeHours:72},
    coverage: { complete: false, message: 'Только б/у MacBook частных продавцов в Нижнем Новгороде. Полный охват не подтверждён: бюджет и бесплатный тариф ограничивают число карточек и запусков. Пропавшее из частичной выдачи объявление не считается проданным.' },
    notifications: { enabled: notifications.enabled === true, channel: notifications.channel === 'telegram' ? 'telegram' : 'site',
      lastSentAt: validDate(notifications.lastSentAt), message: safeText(notifications.message) },
    review: review.sort((a,b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)).slice(0, 1000) };
}
