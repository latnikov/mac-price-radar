import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fail } from './core.mjs';
import { page } from './views.mjs';

const prefix = '/crm/parser';
const pages = new Map([
  ['/', ['web/', 'Парсер цен', '']],
  ['/web/', ['web/', 'Парсер цен', '']],
  ['/web/index.html', ['web/index.html', 'Парсер цен', '']],
  ['/web/foreign.html', ['web/foreign.html', 'Зарубежные цены', 'foreign']],
  ['/web/avito.html', ['web/avito.html', 'Мониторинг Авито', 'avito']],
]);
const readApis = new Set(['session', 'status', 'table', 'master', 'foreign-prices', 'desktop-prices', 'avito-monitor', 'avito-monitor.csv', 'offers', 'history', 'runs', 'sources', 'quotes', 'calculations', 'prices', 'audit']);
const writeApis = new Set(['refresh', 'analytics', 'quotes', 'calculations', 'prices', 'economics', 'imports/dry-run', 'imports/commit']);
const assets = new Set(['app.js', 'styles.css', 'foreign.js', 'foreign.css', 'foreign-filters.js', 'retail-analytics.js', 'price-table.js', 'price-status.js', 'view-state.js', 'product-families.js', 'avito-status.js', 'avito-columns.js', 'avito-monitor.js', 'avito-monitor.css', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'og-image.jpg', 'public-config.json']);

export function parserOrigin(env) {
  const target = new URL(env.STORE_PARSER_ORIGIN || (env.STORE_DEV_URL ? new URL(env.STORE_DEV_URL).origin : 'http://127.0.0.1:4174'));
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw new Error('STORE_PARSER_ORIGIN must be a loopback HTTP origin');
  return target.origin;
}

export function staffDestination(value) {
  if (value === 'dev') return prefix + '/';
  if (typeof value !== 'string' || value.length > 500 || !/^\/crm(?:\/[a-zA-Z0-9_./-]*)?(?:\?[^#]*)?$/.test(value) || /[\\\r\n]/.test(value)) return '/crm';
  const url = new URL(value, 'http://local');
  if (url.pathname !== '/crm' && !url.pathname.startsWith('/crm/')) return '/crm';
  if (url.pathname === '/crm/login' || url.pathname === '/crm/logout' || url.pathname.includes('/api/')) return '/crm';
  return url.pathname + url.search;
}

export async function parserRoutes({ req, res, url, session, requestOrigin, target, fetchImpl, adminRender, send, redirect, shopOrigin }) {
  const relativePath = url.pathname.slice(prefix.length);
  const path = relativePath === '/public-config.json' ? '/web/public-config.json' : relativePath;
  if (!session.role) {
    if (path.startsWith('/api/')) return send(req, res, 401, JSON.stringify({ error: 'Сессия завершена. Войдите в CRM.', loginUrl: '/crm/login?next=' + encodeURIComponent(prefix + '/') }), 'application/json; charset=utf-8');
    return redirect(res, '/crm/login?next=' + encodeURIComponent(url.pathname + url.search));
  }
  if (path === '') return redirect(res, prefix + '/');
  if (path === '/web') return redirect(res, prefix + '/web/' + url.search);
  const api = path.startsWith('/api/') ? path.slice(5) : null;
  const view = pages.get(path), asset = path.startsWith('/web/') && assets.has(path.slice(5));
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  if (!view && !asset && !(api && (method === 'GET' ? readApis : writeApis).has(api))) throw fail(404, 'Страница парсера не найдена.');
  if (method === 'POST' && !api) throw fail(405, 'Метод не поддерживается.');
  if (method === 'POST' && req.headers.origin !== requestOrigin) throw fail(403, 'Обновите страницу CRM и повторите действие.');
  if (method === 'POST' && !['refresh', 'analytics'].includes(api) && session.role !== 'owner') throw fail(403, 'Действие доступно владельцу.');
  let body;
  if (method === 'POST') {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'Нужен JSON-запрос парсера.');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 24000) throw fail(413, 'Слишком большой запрос.'); chunks.push(chunk); }
    body = Buffer.concat(chunks);
  }
  let upstream;
  try {
    // Only this authenticated boundary may translate the browser Origin. No
    // browser cookies, authorization or arbitrary proxy headers go upstream.
    const headers = { ...(method === 'POST' ? { 'content-type': 'application/json', origin: target, 'x-csrf-token': String(req.headers['x-csrf-token'] || '') } : {}) };
    if (!view && req.headers['if-none-match']) headers['if-none-match'] = req.headers['if-none-match'];
    upstream = await fetchImpl(target + '/' + (view ? view[0] : path.slice(1)) + url.search, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  } catch {
    if (api) return send(req, res, 503, JSON.stringify({ error: 'Парсер временно недоступен. Попробуйте ещё раз.' }), 'application/json; charset=utf-8');
    return adminRender('Парсер цен', '<h2>Парсер временно недоступен</h2><p class="muted">Данные сохранены. Попробуйте открыть раздел ещё раз.</p><a class="button primary" href="/crm/parser/">Повторить</a>', { status: 503 });
  }
  if (view) {
    if (!upstream.ok) { await upstream.body?.cancel(); throw fail(503, 'Парсер временно недоступен. Попробуйте ещё раз.'); }
    const source = await upstream.text();
    const main = source.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
    if (!main) throw fail(502, 'Не удалось открыть экран парсера.');
    const bodyHtml = `<div class="parser-workspace">${main.replace(/(href|src)="\.\//g, '$1="/crm/parser/web/')}</div>`;
    const sheet = view[2];
    const head = `<link rel="stylesheet" href="/crm/parser/web/styles.css">${sheet ? `<link rel="stylesheet" href="/crm/parser/web/${sheet === 'foreign' ? 'foreign' : 'avito-monitor'}.css">` : ''}<script type="module" src="/crm/parser/web/${sheet === 'foreign' ? 'foreign' : 'app'}.js"></script>${sheet === 'avito' ? '<script type="module" src="/crm/parser/web/avito-monitor.js"></script>' : ''}`;
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    return send(req, res, 200, page(view[1], bodyHtml, { admin: true, parser: true, parserSheet: sheet === 'avito' ? 'avito' : '', head, path: url.pathname, session, role: session.role, username: session.username, shopOrigin }));
  }
  for (const header of ['content-type', 'etag', 'last-modified', 'content-disposition']) {
    const value = upstream.headers.get(header); if (value) res.setHeader(header, value);
  }
  res.setHeader('Cache-Control', 'private, no-cache');
  res.writeHead(upstream.status);
  if (req.method === 'HEAD' || !upstream.body) { await upstream.body?.cancel(); return res.end(); }
  try { await pipeline(Readable.fromWeb(upstream.body), res); } catch { res.destroy(); }
}
