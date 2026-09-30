import { load } from 'cheerio';

export function avitoAccessFailure({ status = 200, html = '', retryAfter, now = Date.now() } = {}) {
  const $ = load(html); $('script,style').remove();
  const heading = `${$('title').text()} ${$('h1').text()}`;
  const denied = /доступ\s+ограничен|проблема\s+с\s+ip|проверка\s+браузера|captcha|access denied/i.test(heading);
  const challenge = /captcha|капч|проверка\s+браузера/i.test(heading) || Boolean($('[data-marker="captcha"],#captcha,form[action*="captcha"]').length);
  const regional = (denied || status >= 400) && /(?:недоступен|ограничен|запрещ[её]н).{0,100}(?:ваш(?:ем|ей)\s+(?:регион|стран)|территории)|not available in your (?:country|region)/i.test($('body').text());
  if (![401, 403, 429, 451].includes(status) && !denied && !challenge) return null;
  const reason = regional || status === 451 ? 'region_restriction' : /проблема\s+с\s+ip/i.test(heading) ? 'ip_restriction'
    : challenge ? 'captcha' : status === 429 ? 'rate_limit' : status === 401 ? 'authentication' : 'access_denied';
  const messages = { region_restriction: 'Авито ограничил доступ из этого региона', ip_restriction: 'Авито ограничил текущий IP', captcha: 'Авито запросил проверку в браузере', rate_limit: 'Авито ограничил частоту запросов', authentication: 'Авито запросил авторизацию', access_denied: 'Авито отказал в доступе; причина не уточнена' };
  const parsed = /^\d+$/.test(String(retryAfter)) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
  return { reason, status, challenge, message: messages[reason], retryAfter: new Date(Math.max(now + 6 * 3600000, Number.isFinite(parsed) ? Math.min(parsed, now + 7 * 86400000) : 0)).toISOString() };
}
export function accessError(failure) {
  return Object.assign(new Error(failure.message), { code: 'AVITO_BLOCKED', access: failure });
}

// /api/status must never return route credentials, cookie jars or raw HTML.
export function publicAvitoState(state = {}) {
  const result = {};
  for (const key of ['state','message','startedAt','updatedAt','retryAfter']) if (typeof state[key] === 'string') result[key] = state[key].slice(0,250);
  if (state.transport) result.transport = ['proxy', 'apify'].includes(state.transport) ? state.transport : 'direct';
  if (state.access) result.access = { reason: state.access.reason, status: state.access.status, challenge: Boolean(state.access.challenge) };
  if (state.counts) result.counts = Object.fromEntries(Object.entries(state.counts).filter(([k,v])=>['pages','discovered','detailed','inspected','remaining','expectedTotal','requests'].includes(k)&&Number.isFinite(v)));
  return result;
}
