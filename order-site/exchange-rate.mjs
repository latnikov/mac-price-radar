export const CBR_RATE_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';
export const RATE_REFRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const MAX_XML_BYTES = 64 * 1024;

function moscowDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(timestamp);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function rateDate(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value || '');
  if (!match) throw new Error('Invalid CBR rate date');
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const time = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== iso) throw new Error('Invalid CBR rate date');
  return iso;
}

function positiveDecimal(value) {
  const text = String(value || '').trim();
  if (!/^\d+(?:[,.]\d+)?$/.test(text)) throw new Error('Invalid CBR currency value');
  const number = Number(text.replace(',', '.'));
  if (!Number.isFinite(number) || number <= 0) throw new Error('Invalid CBR currency value');
  return number;
}

export function parseCbrUsdRate(xml, timestamp = Date.now()) {
  // Only the small, documented CBR daily schema is accepted. Never resolve XML entities.
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > MAX_XML_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid CBR XML');
  const root = /^\s*(?:<\?xml[^?]*\?>\s*)?<ValCurs\b([^>]*)>([\s\S]*)<\/ValCurs>\s*$/.exec(xml);
  if (!root) throw new Error('Invalid CBR XML');
  const date = rateDate(root[1].match(/\bDate=["']([^"']+)["']/)?.[1]);
  // CBR can publish tomorrow's rate today; request and accept only an effective rate.
  if (date > moscowDate(timestamp)) throw new Error('CBR rate is not effective yet');
  const usd = [...root[2].matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g)]
    .filter(([, row]) => /<CharCode>\s*USD\s*<\/CharCode>/.test(row));
  if (usd.length !== 1) throw new Error('Missing or duplicate CBR USD rate');
  const field = name => usd[0][1].match(new RegExp(`<${name}>\\s*([^<]+)\\s*</${name}>`))?.[1];
  const nominal = positiveDecimal(field('Nominal'));
  if (!Number.isSafeInteger(nominal)) throw new Error('Invalid CBR nominal');
  const usdRub = positiveDecimal(field('Value')) / nominal;
  if (!Number.isFinite(usdRub) || usdRub <= 0 || usdRub > 1000000) throw new Error('Invalid CBR USD rate');
  return Object.freeze({ usdRub, rateDate: date, checkedAt: new Date(`${date}T00:00:00+03:00`).toISOString(), fetchedAt: new Date(timestamp).toISOString(), source: CBR_RATE_URL });
}

async function readXml(response) {
  if (!response.ok || !response.body) throw new Error('CBR request failed');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > MAX_XML_BYTES) throw new Error('CBR response too large');
    chunks.push(chunk);
  }
  return new TextDecoder('windows-1251').decode(Buffer.concat(chunks));
}

export function createExchangeRateProvider({ db, fallback, fetchImpl = fetch, now = Date.now, refreshMs = RATE_REFRESH_MS, onError = () => console.warn('USD/RUB refresh failed; retaining the last saved rate') }) {
  if (!Number.isSafeInteger(refreshMs) || refreshMs <= 0) throw new Error('Invalid exchange rate refresh interval');
  db.exec('CREATE TABLE IF NOT EXISTS order_exchange_rate(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)');
  let current = Object.freeze({ usdRub: fallback.usdRub, checkedAt: fallback.checkedAt, fetchedAt: null, rateDate: null, source: fallback.source });
  const saved = db.prepare('SELECT data FROM order_exchange_rate WHERE id=1').get();
  if (saved) {
    try {
      const value = JSON.parse(saved.data);
      if (value.source !== CBR_RATE_URL || !Number.isFinite(value.usdRub) || value.usdRub <= 0 || value.usdRub > 1000000 ||
          !/^\d{4}-\d{2}-\d{2}$/.test(value.rateDate) || !Number.isFinite(Date.parse(value.checkedAt)) ||
          rateDate(value.rateDate.split('-').reverse().join('.')) !== value.rateDate ||
          value.checkedAt !== new Date(`${value.rateDate}T00:00:00+03:00`).toISOString() || !Number.isFinite(Date.parse(value.fetchedAt)) ||
          value.rateDate > moscowDate(now()) || Date.parse(value.fetchedAt) > now() || Date.parse(value.fetchedAt) < Date.parse(value.checkedAt)) throw new Error('Invalid saved rate');
      current = Object.freeze(value);
    } catch { onError(); }
  }
  let nextAttempt = current.fetchedAt ? Date.parse(current.fetchedAt) + refreshMs : 0;
  let inFlight = null;
  let timer = null;
  let closed = false;
  const stopController = new AbortController();

  function refresh() {
    if (closed) return Promise.resolve(current);
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const timestamp = now();
        const [year, month, day] = moscowDate(timestamp).split('-');
        const url = new URL(CBR_RATE_URL);
        url.searchParams.set('date_req', `${day}/${month}/${year}`);
        const response = await fetchImpl(url.href, { signal: AbortSignal.any([stopController.signal, AbortSignal.timeout(8000)]), headers: { Accept: 'application/xml' } });
        const value = parseCbrUsdRate(await readXml(response), now());
        if (Date.parse(value.checkedAt) < Date.parse(current.checkedAt)) throw new Error('CBR returned an older rate');
        if (closed) return current;
        db.prepare('INSERT INTO order_exchange_rate(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(value));
        current = value;
        nextAttempt = now() + refreshMs;
      } catch {
        nextAttempt = now() + Math.min(RETRY_MS, refreshMs);
        if (!closed) onError();
      }
      return current;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  const refreshIfDue = () => inFlight || (now() >= nextAttempt ? refresh() : Promise.resolve(current));
  return {
    current: () => current, refresh, refreshIfDue,
    start() {
      if (closed || timer) return;
      void refreshIfDue();
      timer = setInterval(() => { void refreshIfDue(); }, Math.min(RETRY_MS, refreshMs));
      timer.unref();
    },
    async close() { closed = true; clearInterval(timer); stopController.abort(); await inFlight; },
  };
}
