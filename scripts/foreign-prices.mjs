import { load } from 'cheerio';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const FOREIGN_SOURCE = 'AppleInsider';
export const GUIDE_URL = 'https://prices.appleinsider.com/current-gen';
export const RATE_URL = 'https://www.google.com/finance/quote/USD-RUB?hl=en';
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

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

export function parseAppleGuide(html, guideUrl) {
  const $ = load(html);
  const model = clean($('h1').first().text()).replace(/\s+Prices.*$/i, '');
  if (!/MacBook|Mac mini|Mac Studio|Mac Pro|iMac/i.test(model)) throw new Error('AppleInsider: не распознана модель');
  const rows = [];
  $('table').each((_, table) => {
    const headers = $(table).find('tr').first().children('th,td').toArray().map(cell => clean($(cell).text()));
    const configIndex = headers.findIndex(text => /^Configurations?$/i.test(text));
    const priceIndex = headers.findIndex(text => /^Best Price$/i.test(text));
    if (configIndex < 0 || priceIndex < 0) return;
    $(table).find('tr').slice(1).each((_, tr) => {
      const cells = $(tr).children('td');
      const configCell = cells.eq(configIndex), priceCell = cells.eq(priceIndex);
      const configuration = clean(configCell.text());
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
      rows.push({ id: `${guideUrl}|${configuration}`, model, configuration, usd, guideUrl, offerUrl,
        terms: priceText.slice(amount[0].length).trim(), priceLabel: 'Best Price' });
    });
  });
  if (!rows.length) throw new Error(`AppleInsider: не найдены цены в таблице ${guideUrl}`);
  return rows;
}

export function convertForeignPrices(rows, googleRate) {
  if (!Number.isFinite(googleRate) || googleRate <= 0) throw new Error('Недопустимый курс');
  const effectiveRate = Math.round((googleRate + 4) * 1e6) / 1e6;
  return rows.map(row => ({ ...row, rub: Math.round(row.usd * effectiveRate) }));
}

export async function readForeignPrices(root = '.') {
  try { return JSON.parse(await readFile(join(root, 'data/private/foreign-prices.json'), 'utf8')); }
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
  const directory = join(root, 'data/private');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'foreign-prices.json'), temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(temporary, path);
  if (snapshot.state === 'error') throw new Error(snapshot.error);
  return snapshot;
}
