// Only the four phone families requested for the price radar.
export const IPHONE_MODELS = ['iPhone 18 Pro Max', 'iPhone 18 Pro', 'iPhone 17 Pro Max', 'iPhone 17 Pro'];
export function iphoneModel(value) {
  const match = String(value || '').replace(/айфон/gi, 'iPhone').match(/\bi\s*phone\s*(17|18)\s*pro(?:\s*(max))?\b/i);
  return match ? `iPhone ${match[1]} Pro${match[2] ? ' Max' : ''}` : null;
}
export const isIphone = offer => /^iPhone\b/i.test(String(offer?.model || ''));
export function iphoneSim(value) {
  const text = String(value || '').replace(/[-_]+/g, ' ');
  if (/\be\s*sim\s*(?:\+|\/)\s*e\s*sim\b|dual\s*e\s*sim/i.test(text)) return 'eSIM';
  if (/\b(?:nano\s*)?sim\s*(?:\+|\/|и|,|\s)\s*e\s*sim\b|физическ.{0,30}сим/i.test(text)) return 'SIM + eSIM';
  if (/\b2\s*(?:nano\s*)?sim\b|dual\s*sim|\bsim\s*\+\s*sim\b|две\s+физическ/i.test(text)) return 'Dual SIM';
  if (/\be\s*sim\b/i.test(text)) return 'eSIM';
  return 'unknown';
}
export function iphoneStorage(value) {
  const match = String(value || '').match(/\b(128|256|512|1024|2048|1|2)\s*(GB|ГБ|TB|ТБ|G|Г)(?=$|[^\p{L}])/iu);
  if (!match) return null;
  const amount = Number(match[1]) * (/^(TB|ТБ)$/i.test(match[2]) ? 1000 : 1);
  return ({ 1024: 1000, 2048: 2000 })[amount] || amount;
}
export function iphoneColor(value, model = '') {
  const colors = [
    ['Cosmic Orange', 'cosmic[ -]orange|космическ.{0,8}оранж'], ['Deep Blue', 'deep[ -]blue|глубок.{0,8}син|т[её]мно[ -]син'],
    ['Glacier', 'glacier|ледян'], ['Burgundy', 'burgundy|бургунд|бордов'], ['Silver', 'silver|серебр|serebr'],
    ['Black', '\\bblack\\b|ч[её]рн|chern'],
    [/18/.test(model) ? 'Blue' : 'Deep Blue', '\\bblue\\b|голуб|син(?:ий|яя|ее)|sini|golub'],
    ['Cosmic Orange', '\\borange\\b|оранж'],
  ];
  return colors.find(([, pattern]) => new RegExp(pattern, 'i').test(String(value || '')))?.[0] || 'unknown';
}

export function parseIphone(title, url, retailer, amount, fetchedAt, metadata = {}) {
  const model = iphoneModel(title);
  if (!model || !Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100)) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6 || /чехол|case\b|стекло|защит|запчаст|кабел|коробка\s+(?:для|от)/i.test(title)) return null;
  let slug = '';
  try { slug = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1) || '').replace(/[-_]+/g, ' '); } catch {}
  const storageGb = iphoneStorage(title) || iphoneStorage(slug);
  if (!storageGb) return null;
  const color = iphoneColor(title, model) !== 'unknown' ? iphoneColor(title, model) : iphoneColor(slug, model);
  const qualityWarnings = [...(metadata.qualityWarnings || [])];
  if (iphoneStorage(title) && iphoneStorage(slug) && iphoneStorage(title) !== iphoneStorage(slug)) qualityWarnings.push('Конфликт памяти между заголовком и URL');
  const condition = /б\s*\/\s*у|\bused\b/i.test(title) ? 'used' : /refurb|восстановлен/i.test(title) ? 'refurbished' : /предактив|вскрыт|open.?box|asis\+?/i.test(title) ? 'open_box' : metadata.condition || 'unknown';
  const chip = String(title).match(/\bA\d{2}\s+Pro\b/i)?.[0] || null;
  const rawPrice = String(metadata.rawPrice || '');
  return { ...metadata, retailer, title: String(title).replace(/\s+/g, ' ').trim(), rawTitle: String(title), url,
    price: amount, priceMinor: Math.round(amount * 100), currency: 'RUB', fetchedAt, observedAt: fetchedAt,
    model, storageGb, color, simType: metadata.simType && metadata.simType !== 'unknown' ? metadata.simType : iphoneSim(title) !== 'unknown' ? iphoneSim(title) : iphoneSim(slug),
    chip, ramGb: null, cpuCores: null, gpuCores: null, screenIn: null, keyboard: 'not_applicable',
    region: metadata.region || 'unknown', displayType: metadata.displayType || 'standard', bundle: metadata.bundle || 'standard', condition,
    priceType: /рассроч|в месяц|\/мес/i.test(rawPrice) ? 'installment' : /(?:^|\s)от\s+\d/i.test(rawPrice) ? 'from' : metadata.priceType || 'unknown',
    stock: metadata.stock || 'unknown', qualityWarnings, normalizationVersion: 4,
    evidence: { title: String(title), slug, ...(metadata.evidence || {}) } };
}
