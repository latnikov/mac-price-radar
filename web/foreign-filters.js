import { PHONE_FAMILIES, phoneModelName } from './product-families.js';
export const MAC_FAMILIES = [
  ['air', 'MacBook Air', 'laptop', 'Лёгкий и тонкий'], ['pro', 'MacBook Pro', 'laptop pro', 'Для больших задач'],
  ['neo', 'MacBook Neo', 'laptop neo', 'На каждый день'], ['mini', 'Mac mini', 'mini', 'Компактный настольный'],
  ['studio', 'Mac Studio', 'studio', 'Максимум мощности'], ['imac', 'iMac', 'imac', 'Всё в одном'], ['mac-pro', 'Mac Pro', 'studio', 'Рабочая станция'],
];
export const COLORS = { 'Space Gray': 'Серый космос', 'Space Black': 'Чёрный космос', 'Sky Blue': 'Небесно-голубой', 'Rose Gold': 'Розовое золото', 'Natural Titanium': 'Натуральный титан', 'Black Titanium': 'Чёрный титан', 'White Titanium': 'Белый титан', 'Desert Titanium': 'Пустынный титан', 'Blue Titanium': 'Синий титан', Midnight: 'Тёмная ночь', Starlight: 'Сияющая звезда', Silver: 'Серебристый', Black: 'Чёрный', White: 'Белый', Blue: 'Синий', Green: 'Зелёный', Pink: 'Розовый', Purple: 'Фиолетовый', Yellow: 'Жёлтый', Orange: 'Оранжевый', Gold: 'Золотой', Red: 'Красный', Burgundy: 'Бордовый', Glacier: 'Ледяной', Blush: 'Розовый Blush', Indigo: 'Индиго', Citrus: 'Цитрусовый', 'Jet Black': 'Глянцевый чёрный', 'Cloud Pink': 'Облачный розовый', 'Slate Blue': 'Серо-синий' };
Object.assign(COLORS, { 'Cosmic Orange': 'Космический оранжевый', 'Deep Blue': 'Тёмно-синий' });
export const SPEC_KEYS = ['chip', 'screen', 'ram', 'storage', 'cpu', 'gpu', 'display', 'color', 'connection'];
export const emptyForeignFilters = () => ({ category: 'Mac', family: '', ...Object.fromEntries(SPEC_KEYS.map(key => [key, ''])) });
export const capacity = value => Number(value) >= 1024 ? `${Number(value) / 1024} TB` : `${value} GB`;
const collator = new Intl.Collator('ru', { numeric: true });
const chipPattern = /\b[MA]\d{1,2}(?:\s+(?:Pro|Max|Ultra))?\b/gi;
const accessoryPattern = /\b(?:accessor(?:y|ies)|pencil|keyboard|case|cover|cable|charger|adapter|strap|band)\b/i;

function amountsIn(text) {
  return [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*(GB|TB)\b/gi)].map(match => {
    const before = text.slice(0, match.index), after = text.slice(match.index + match[0].length);
    const suffixRam = /^\s*(?:RAM|(?:Unified\s+)?Memory)\b/i.test(after), suffixStorage = /^\s*(?:SSD|HDD|(?:Flash\s+)?Storage)\b/i.test(after);
    const prefixRam = /\b(?:RAM|(?:Unified\s+)?Memory)\s*:?\s*$/i.test(before), prefixStorage = /\b(?:SSD|HDD|(?:Flash\s+)?Storage)\s*:?\s*$/i.test(before);
    return { value: String(Number(match[1]) * (match[2].toUpperCase() === 'TB' ? 1024 : 1)), kind: suffixRam ? 'ram' : suffixStorage ? 'storage' : prefixRam ? 'ram' : prefixStorage ? 'storage' : '' };
  });
}

export function foreignSpecs(row) {
  const text = row.configuration || '';
  let path = '';
  try { path = new URL(row.guideUrl).pathname; } catch {}
  const phone = row.category === 'iPhone' ? phoneModelName(path.slice(1).replace(/-/g, ' ')) || phoneModelName(row.model) : null;
  const family = row.category === 'Mac' ? MAC_FAMILIES.find(([key]) => path.includes(key === 'air' || key === 'pro' || key === 'neo' ? `macbook-${key}` : key === 'imac' ? 'imac' : key === 'mac-pro' ? 'mac-pro' : `mac-${key}`))?.[0] || row.model
    : phone ? Object.keys(PHONE_FAMILIES).find(key => PHONE_FAMILIES[key] === phone) : row.model;
  const device = ['Mac', 'iPad', 'iPhone', 'Vision Pro'].includes(row.category) && !accessoryPattern.test(text);
  const directChip = device ? text.match(chipPattern)?.[0] : '';
  const modelChips = row.category === 'iPad' && device ? [...new Set(String(row.model || '').match(chipPattern) || [])] : [];
  const chip = (directChip || (modelChips.length === 1 ? modelChips[0] : '') || '').toUpperCase().replace(/ PRO$/, ' Pro').replace(/ MAX$/, ' Max').replace(/ ULTRA$/, ' Ultra');
  const size = path.match(/(\d+(?:\.\d+)?)-inch/)?.[1] || text.match(/\b(\d+(?:\.\d+)?)\s*(?:inch|["″])/i)?.[1] || text.match(/\b(\d{2})mm\b/i)?.[1];
  const screen = size ? `${size}${/\b\d{2}mm\b/i.test(text) && !path.includes('inch') ? ' мм' : '″'}` : '';
  const amounts = amountsIn(text);
  const ramAmount = row.category === 'Mac' ? amounts.find(amount => amount.kind === 'ram') || (amounts.length > 1 ? amounts.find(amount => amount.kind !== 'storage') : null) : null;
  const storageAmount = amounts.find(amount => amount.kind === 'storage') || (ramAmount ? amounts.filter(amount => amount !== ramAmount && amount.kind !== 'ram').at(-1) : amounts.find(amount => amount.kind !== 'ram'));
  const ram = ramAmount?.value || '', storage = storageAmount?.value || '';
  const cpu = text.match(/\b(\d+)\s*(?:C|[-\s]?cores?)\s*CPU\b/i)?.[1] || '';
  const gpu = text.match(/\b(\d+)\s*(?:C|[-\s]?cores?)\s*GPU\b/i)?.[1] || '';
  const display = /\bNano[-\s]?texture\s+(?:Display|Glass)\b/i.test(text) ? 'Nano-texture' : /\bStandard\s+(?:Display|Glass)\b/i.test(text) ? 'Standard' : '';
  const color = Object.keys(COLORS).sort((a, b) => b.length - a.length).find(value => new RegExp(`\\b${value}\\b`, 'i').test(text)) || '';
  const phoneConnection = /(?:nano\s*)?SIM\s*(?:\+|\/)\s*eSIM/i.test(text) ? 'SIM + eSIM' : /Dual\s*SIM|2\s*SIM/i.test(text) ? 'Dual SIM' : /\beSIM\b/i.test(text) ? 'eSIM' : '';
  const connection = row.category === 'iPhone' ? phoneConnection : /\b10\s*GbE\b/i.test(text) ? '10GbE' : /Wi-Fi\s*\+\s*Cellular/i.test(text) ? 'Wi-Fi + Cellular' : /Wi-Fi\s*\+\s*Ethernet/i.test(text) ? 'Wi-Fi + Ethernet' : /Wi-Fi/i.test(text) ? 'Wi-Fi' : /GPS\s*\+\s*Cellular/i.test(text) ? 'GPS + Cellular' : /\bGPS\b/i.test(text) ? 'GPS' : '';
  return { family, chip, screen, ram, storage, cpu, gpu, display, color, connection };
}

export function foreignModelLabel(row) {
  const specs = row.specs || foreignSpecs(row);
  return (row.category === 'Mac' ? MAC_FAMILIES.find(([key]) => key === specs.family)?.[1] : PHONE_FAMILIES[specs.family]) || row.model || 'Модель не указана';
}

export function foreignBadges(row) {
  const specs = row.specs || foreignSpecs(row);
  const labels = {
    screen: value => value,
    chip: value => value,
    ram: value => `RAM ${capacity(value)}`,
    storage: value => `${row.category === 'Mac' ? 'SSD ' : ''}${capacity(value)}`,
    cpu: value => `CPU ${value}`,
    gpu: value => `GPU ${value}`,
    display: value => value === 'Nano-texture' ? 'Нанотекстура' : 'Стандартный экран',
    color: value => COLORS[value] || value,
    connection: value => value === '10GbE' ? 'Ethernet 10 Гбит/с' : value,
  };
  return ['screen', 'chip', 'ram', 'storage', 'cpu', 'gpu', 'display', 'color', 'connection']
    .filter(key => specs[key] && (row.category !== 'iPhone' || !['screen', 'chip', 'ram', 'cpu', 'gpu', 'display'].includes(key))).map(key => ({ key, value: specs[key], label: labels[key](specs[key]) }));
}

function compareChip(a, b) {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  const parse = value => value.match(/^([MA])(\d+)(?:\s+(Pro|Max|Ultra))?$/i);
  const left = parse(a), right = parse(b);
  if (!left || !right) return collator.compare(a, b);
  const tiers = { pro: 1, max: 2, ultra: 3 };
  return collator.compare(left[1], right[1]) || Number(right[2]) - Number(left[2]) || (tiers[left[3]?.toLowerCase()] || 0) - (tiers[right[3]?.toLowerCase()] || 0);
}

function compareValue(a, b, numeric = false) {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return (numeric ? parseFloat(a) - parseFloat(b) : 0) || collator.compare(String(a), String(b));
}

function compareConfiguration(a, b) {
  const category = a.category === b.category ? 0 : a.category === 'Mac' ? -1 : b.category === 'Mac' ? 1 : collator.compare(a.category || '', b.category || '');
  if (category) return category;
  const left = a.specs || foreignSpecs(a), right = b.specs || foreignSpecs(b);
  const familyOrder = value => { const index = MAC_FAMILIES.findIndex(([key]) => key === value); return index < 0 ? MAC_FAMILIES.length : index; };
  const model = a.category === 'Mac' ? familyOrder(left.family) - familyOrder(right.family) || collator.compare(foreignModelLabel(a), foreignModelLabel(b)) : collator.compare(foreignModelLabel(a), foreignModelLabel(b));
  if (model) return model;
  const chip = compareChip(left.chip, right.chip);
  if (chip) return chip;
  for (const key of ['screen', 'ram', 'storage', 'cpu', 'gpu', 'display', 'color', 'connection']) {
    const result = compareValue(left[key], right[key], ['screen', 'ram', 'storage', 'cpu', 'gpu'].includes(key));
    if (result) return result;
  }
  return collator.compare(a.configuration || '', b.configuration || '') || collator.compare(a.id || '', b.id || '');
}

export function selectForeignPage(rows, { sort = 'model', page = 1, pageSize = 30 } = {}) {
  const selected = rows.map((row, index) => ({ row, index }));
  selected.sort((a, b) => {
    const price = row => Number.isFinite(row.rub) ? row.rub : null;
    const leftPrice = price(a.row), rightPrice = price(b.row);
    const priceOrder = ['price', 'price-up', 'price-down'].includes(sort)
      ? leftPrice == null ? rightPrice == null ? 0 : 1 : rightPrice == null ? -1 : (leftPrice - rightPrice) * (sort === 'price-down' ? -1 : 1) : 0;
    return priceOrder || compareConfiguration(a.row, b.row) || a.index - b.index;
  });
  const allRows = selected.map(item => item.row);
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 30;
  const total = allRows.length, pages = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.max(1, Math.min(pages, Math.trunc(Number(page)) || 1));
  const start = total ? (currentPage - 1) * size + 1 : 0, end = Math.min(currentPage * size, total);
  return { rows: allRows.slice((currentPage - 1) * size, currentPage * size), allRows, total, pages, page: currentPage, start, end };
}
export function matchesForeignRow(row, filters, { query = '', min = '', max = '' } = {}) {
  const specs = row.specs || foreignSpecs(row);
  if (filters.category && row.category !== filters.category) return false;
  if (filters.family && specs.family !== filters.family) return false;
  if (SPEC_KEYS.some(key => filters[key] && specs[key] !== filters[key])) return false;
  if (min !== '' && (row.rub == null || row.rub < Number(min))) return false;
  if (max !== '' && (row.rub == null || row.rub > Number(max))) return false;
  const search = `${row.model} ${row.configuration} ${COLORS[specs.color] || ''}`.toLowerCase().replace(/ё/g, 'е');
  const aliases = { эйр: 'air', эир: 'air', про: 'pro', макс: 'max', ультра: 'ultra', мини: 'mini', студио: 'studio', нео: 'neo' };
  return query.toLowerCase().replace(/ё/g, 'е').replace(/м(?=\d)/g, 'm').replace(/гб/g, 'gb').replace(/тб/g, 'tb').split(/\s+/).filter(Boolean).every(term => search.includes(aliases[term] || term));
}
