import { load } from 'cheerio';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const FOREIGN_SOURCE = 'AppleInsider';
export const GUIDE_URL = 'https://prices.appleinsider.com/current-gen';
export const RATE_URL = 'https://www.google.com/finance/quote/USD-RUB?hl=en';
export const CBR_RATE_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
export const APPLE_CATEGORIES = ['current-gen', 'ipad', 'iphone', 'apple-watch', 'airpods-beats', 'tv-home', 'vision', 'accessories', 'apple-displays'];
export function parseCbrRate(xml) {
  const $ = load(xml, { xmlMode: true });
  const dollar = $('Valute').filter((_, el) => $(el).find('CharCode').text() === 'USD');
  const nominal = Number(dollar.find('Nominal').text());
  const value = Number(dollar.find('Value').text().replace(',', '.'));
  const rateDate = $('ValCurs').attr('Date');
  if (dollar.length !== 1 || !(nominal > 0) || !(value > 0) || value / nominal > 10000 || !/^\d{2}\.\d{2}\.\d{4}$/.test(rateDate || '')) throw new Error('ЦБ: не найден однозначный курс USD/RUB с датой');
  return { usdRate: Math.round(value / nominal * 1e6) / 1e6, rateDate, rateSource: 'ЦБ РФ', rateUrl: CBR_RATE_URL };
}
export function findAppleGuides(html) {
  const $ = load(html), urls = new Set();
  $('a[href]').each((_, a) => {
    let url;
    try { url = new URL($(a).attr('href'), GUIDE_URL); } catch { return; }
    if (url.origin === 'https://prices.appleinsider.com' && /^\/(?:macbook|mac-mini|mac-studio|mac-pro|imac|ipad|iphone|apple-watch|apple-airpods|airpods|apple-tv|smart-speakers|apple-vision|airtag|magic-accessories|apple-displays|beats|earbuds|over-ear-headphones)[a-z0-9-]*\/?$/.test(url.pathname)) {
      url.hash = ''; url.search = ''; urls.add(url.href.replace(/\/$/, ''));
    }
  });
  return [...urls];
}

export function parseGoogleRate(html) {
  const $ = load(html);
  if (!/USD\s*\/\s*RUB|USD-RUB/.test($('body').text())) throw new Error('Google: не найдена пара USD/RUB');
  const text = clean($('.YMlKec.fxKbKc').first().text());
  const rate = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 10000) throw new Error('Google: не найден однозначный курс USD/RUB');
  return rate;
}

export function findMacGuides(html) {
  const $ = load(html), urls = new Set();
  $('a[href]').each((_, a) => {
    const url = new URL($(a).attr('href'), GUIDE_URL);
    if (url.origin === 'https://prices.appleinsider.com' && /^\/(?:macbook|mac-mini|mac-studio|mac-pro|imac)[a-z0-9-]*\/?$/.test(url.pathname)) {
      url.hash = ''; url.search = ''; urls.add(url.href.replace(/\/$/, ''));
    }
  });
  if (!urls.size || urls.size > 100) throw new Error('AppleInsider: не найден полный список разделов Mac');
  return [...urls];
}

export function parseAppleGuide(html, guideUrl, { allowEmpty = false } = {}) {
  const $ = load(html);
  const model = clean($('h1').first().text()).replace(/\s+Prices.*$/i, '');
  if (!model || /Just a moment|Access denied|Error 403|Attention Required/i.test(model)) throw new Error('AppleInsider: не распознана модель');
  const rows = [];
  let recognized = false;
  $('table').each((_, table) => {
    const headers = $(table).find('tr').first().children('th,td').toArray().map(cell => clean($(cell).text()));
    const configIndex = headers.findIndex(text => /^Configurations?$/i.test(text));
    const priceIndex = headers.findIndex(text => /^Best Price$/i.test(text));
    if (configIndex < 0 || priceIndex < 0) return;
    recognized = true;
    $(table).find('tr').slice(1).each((_, tr) => {
      const cells = $(tr).children('td');
      const configCell = cells.eq(configIndex), priceCell = cells.eq(priceIndex);
      const configuration = clean(configCell.text());
      const path = new URL(guideUrl).pathname;
      if (path === '/smart-speakers' && !/HomePod/i.test(configuration)) return;
      if (path === '/apple-displays' && !/Apple|Studio Display|Pro Display/i.test(configuration)) return;
      if (['/earbuds', '/over-ear-headphones'].includes(path) && !/AirPods|Beats/i.test(configuration)) return;
      const priceText = clean(priceCell.text());
      // Read only Best Price, never MSRP, savings, installments or another row.
      const amount = priceText.match(/^\$\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)(?=\s|$)/);
      if (!configuration || !amount || /sold out|out of stock|\/mo|per month/i.test(priceText)) return;
      const usd = Number(amount[1].replace(/,/g, ''));
      if (!(usd > 0)) return;
      const link = priceCell.find('a[href]').first();
      let offerUrl = guideUrl;
      if (link.length) {
        const parsed = new URL(link.attr('href'), guideUrl);
        if (parsed.protocol === 'https:') offerUrl = parsed.href;
      }
      const category = /macbook|mac-mini|mac-studio|mac-pro|imac/.test(path) ? 'Mac' : path.startsWith('/ipad') ? 'iPad' : path.startsWith('/iphone') ? 'iPhone' : path.startsWith('/apple-watch') ? 'Apple Watch' : /airpods|beats|earbuds|headphones/.test(path) ? 'AirPods и Beats' : path === '/apple-displays' ? 'Дисплеи' : /apple-tv|smart-speakers/.test(path) ? 'TV и HomePod' : /vision/.test(path) ? 'Vision Pro' : 'Аксессуары';
      rows.push({ id: `${guideUrl}|${configuration}`, model, category, configuration, usd, guideUrl, offerUrl,
        terms: priceText.slice(amount[0].length).trim(), priceLabel: 'Best Price' });
    });
  });
  if (!recognized || (!rows.length && !allowEmpty)) throw new Error(`AppleInsider: не найдены цены в таблице ${guideUrl}`);
  return rows;
}

export async function saveForeignPrices(snapshot, root = '.') {
  const directory = join(root, 'data/private');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'foreign-prices.json'), temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(temporary, path);
}

export function convertForeignPrices(rows, googleRate) {
  if (!Number.isFinite(googleRate) || googleRate <= 0) throw new Error('Недопустимый курс');
  const effectiveRate = Math.round((googleRate + 4) * 1e6) / 1e6;
  return rows.map(row => ({ ...row, rub: Math.round(row.usd * effectiveRate) }));
}

export async function readForeignPrices(root = '.') {
  try {
    const snapshot = JSON.parse(await readFile(join(root, 'data/private/foreign-prices.json'), 'utf8'));
    const request = await readFile(join(root, 'data/private/foreign-request.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (request && Date.parse(request.requestedAt) > Date.parse(snapshot.attemptedAt || 0)) snapshot.requestedAt = request.requestedAt;
    return snapshot;
  }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { state: 'pending', rows: [], error: null, sourceUrl: GUIDE_URL, rateUrl: RATE_URL };
  }
}

export async function refreshForeignPrices({ fetchPage, root = '.', now = () => new Date().toISOString() }) {
  const previous = await readForeignPrices(root);
  const attemptedAt = now();
  let snapshot;
  try {
    const results = await Promise.allSettled([fetchPage(GUIDE_URL), fetchPage(RATE_URL)]);
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
    if (failures.length) throw new Error(failures.join('; '));
    const guides = findMacGuides(results[0].value);
    const googleRate = parseGoogleRate(results[1].value);
    const rows = [], queue = [...guides];
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (queue.length) {
        const url = queue.shift();
        try { rows.push(...parseAppleGuide(await fetchPage(url), url)); }
        catch (error) { failures.push(error.message); }
      }
    }));
    if (failures.length) throw new Error(failures.join('; '));
    const unique = [...new Map(rows.map(row => [row.id, row])).values()].sort((a, b) => a.id.localeCompare(b.id));
    snapshot = { state: 'ready', sourceUrl: GUIDE_URL, rateUrl: RATE_URL, attemptedAt, updatedAt: now(),
      googleRate, surcharge: 4, effectiveRate: Math.round((googleRate + 4) * 1e6) / 1e6,
      guides: guides.length, rows: convertForeignPrices(unique, googleRate), error: null };
  } catch (error) {
    snapshot = { ...previous, state: 'error', attemptedAt, error: error.message };
  }
  await saveForeignPrices(snapshot, root);
  if (snapshot.state === 'error') throw new Error(snapshot.error);
  return snapshot;
}
