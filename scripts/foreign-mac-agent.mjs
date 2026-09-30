import { readFile, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { load } from 'cheerio';
import { connectForeignBrowser } from './foreign-browser.mjs';
import { APPLE_CATEGORIES, findAppleGuides, parseAppleGuide, parseCbrRate, convertForeignPrices, readForeignPrices, saveForeignPrices, CBR_RATE_URL } from './foreign-prices.mjs';

const exec = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const remote = '/srv/mac-price-radar/dev/data/private';
const ssh = command => exec('/usr/bin/ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'macbookbro', command], { timeout: 60000, maxBuffer: 1024 * 1024 });
const lock = join(root, 'data/private/foreign-mac.lock');
await mkdir(join(root, 'data/private'), { recursive: true });
try { await mkdir(lock); } catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (Date.now() - (await stat(lock)).mtimeMs < 45 * 60_000) process.exit(0);
  await rm(lock, { recursive: true }); await mkdir(lock);
}
async function run() {
  let browser;
  try {
    const previous = await readForeignPrices(root);
    const request = (await ssh(`cat ${remote}/foreign-request.json 2>/dev/null || true`)).stdout.trim();
    const requestedAt = request ? JSON.parse(request).requestedAt : null;
    const syncState = await readFile(join(root, 'data/private/foreign-mac-sync.json'), 'utf8').then(JSON.parse).catch(() => ({}));
    if (!process.argv.includes('--force') && Date.now() - Date.parse(syncState.attemptedAt || 0) < 3600000 && (!requestedAt || Date.parse(requestedAt) <= Date.parse(syncState.attemptedAt || 0))) return;
    const attemptedAt = new Date().toISOString();
    await writeFile(join(root, 'data/private/foreign-mac-sync.json'), JSON.stringify({ attemptedAt }), { mode: 0o600 });
    browser = await connectForeignBrowser(root);
    const queue = APPLE_CATEGORIES.map(path => `https://prices.appleinsider.com/${path}`), seen = new Set(), rows = [], coverage = [], warnings = [];
    for (let i = 0; i < queue.length; i++) {
      const url = queue[i]; if (seen.has(url)) continue;
      if (seen.size >= 200) throw new Error('Слишком много разделов AppleInsider');
      seen.add(url);
      console.log(`Раздел ${seen.size}: ${url}`);
      try {
        const html = process.argv.includes('--cached-html') ? await readFile(join(root, 'data/private/foreign-html', `prices.appleinsider.com-${new URL(url).pathname.replace(/[^a-z0-9-]/gi, '_')}.html`), 'utf8') : await browser.fetchPage(url), $ = load(html);
        for (const child of findAppleGuides(html)) if (!seen.has(child) && !queue.includes(child)) queue.push(child);
        if ($('table').length) {
          const parsed = parseAppleGuide(html, url, { allowEmpty: true });
          const fetchedAt = process.argv.includes('--cached-html') ? (await stat(join(root, 'data/private/foreign-html', `prices.appleinsider.com-${new URL(url).pathname.replace(/[^a-z0-9-]/gi, '_')}.html`))).mtime.toISOString() : new Date().toISOString();
          rows.push(...parsed.map(row => ({ ...row, fetchedAt })));
          coverage.push({ url, rows: parsed.length, state: parsed.length ? 'ready' : 'unavailable' });
        } else if (!$('.deal-card').length && !APPLE_CATEGORIES.some(path => url.endsWith('/' + path))) {
          throw new Error('Не найдена таблица или список моделей');
        }
      } catch (error) {
        console.warn(`Не обновлён раздел ${url}: ${error.message}`);
        warnings.push(`${url}: ${error.message}`); coverage.push({ url, state: 'error', error: error.message });
        rows.push(...previous.rows.filter(row => row.guideUrl === url).map(row => ({ ...row, stale: true })));
      }
    }
    if (!rows.some(row => !row.stale)) throw new Error('Не получено ни одной новой подтверждённой цены; сохранён предыдущий снимок');
    if (warnings.length) {
      const undiscovered = previous.rows.filter(row => !seen.has(row.guideUrl));
      rows.push(...undiscovered.map(row => ({ ...row, stale: true })));
      for (const url of new Set(undiscovered.map(row => row.guideUrl))) coverage.push({ url, state: 'error', error: 'Раздел не обнаружен из-за ошибки загрузки каталога' });
    }
    const response = await fetch(CBR_RATE_URL, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`ЦБ: HTTP ${response.status}`);
    const rate = parseCbrRate(await response.text());
    const unique = [...new Map(rows.map(row => [row.id, row])).values()].sort((a, b) => a.id.localeCompare(b.id));
    const snapshot = { state: warnings.length ? 'partial' : 'ready', transport: 'mac-browser', sourceUrl: 'https://prices.appleinsider.com/', ...rate,
      attemptedAt, updatedAt: new Date().toISOString(), surcharge: 4, effectiveRate: Math.round((rate.usdRate + 4) * 1e6) / 1e6,
      guides: coverage.length, coverage, warnings, rows: convertForeignPrices(unique, rate.usdRate), error: null };
    await saveForeignPrices(snapshot, root);
    await exec('/usr/bin/scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', join(root, 'data/private/foreign-prices.json'), `macbookbro:${remote}/foreign-prices.mac-upload.json`], { timeout: 60000 });
    await ssh(`chown radar:radar ${remote}/foreign-prices.mac-upload.json && chmod 600 ${remote}/foreign-prices.mac-upload.json && mv ${remote}/foreign-prices.mac-upload.json ${remote}/foreign-prices.json`);
    console.log(`Опубликовано: ${snapshot.rows.length} конфигураций, ${snapshot.guides} таблиц; курс ЦБ: ${rate.usdRate}; предупреждений: ${warnings.length}`);
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  } finally {
    browser?.close(); await rm(lock, { recursive: true, force: true });
  }
}
await run();
