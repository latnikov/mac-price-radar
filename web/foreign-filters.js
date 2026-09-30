export const MAC_FAMILIES = [
  ['air', 'MacBook Air', 'laptop', 'Лёгкий и тонкий'], ['pro', 'MacBook Pro', 'laptop pro', 'Для больших задач'],
  ['neo', 'MacBook Neo', 'laptop neo', 'На каждый день'], ['mini', 'Mac mini', 'mini', 'Компактный настольный'],
  ['studio', 'Mac Studio', 'studio', 'Максимум мощности'], ['imac', 'iMac', 'imac', 'Всё в одном'], ['mac-pro', 'Mac Pro', 'studio', 'Рабочая станция'],
];
export const COLORS = { 'Space Gray': 'Серый космос', 'Space Black': 'Чёрный космос', 'Sky Blue': 'Небесно-голубой', 'Rose Gold': 'Розовое золото', 'Natural Titanium': 'Натуральный титан', 'Black Titanium': 'Чёрный титан', 'White Titanium': 'Белый титан', 'Desert Titanium': 'Пустынный титан', 'Blue Titanium': 'Синий титан', Midnight: 'Тёмная ночь', Starlight: 'Сияющая звезда', Silver: 'Серебристый', Black: 'Чёрный', White: 'Белый', Blue: 'Синий', Green: 'Зелёный', Pink: 'Розовый', Purple: 'Фиолетовый', Yellow: 'Жёлтый', Orange: 'Оранжевый', Gold: 'Золотой', Red: 'Красный', Burgundy: 'Бордовый', Glacier: 'Ледяной', Blush: 'Розовый Blush', Indigo: 'Индиго', Citrus: 'Цитрусовый', 'Jet Black': 'Глянцевый чёрный', 'Cloud Pink': 'Облачный розовый', 'Slate Blue': 'Серо-синий' };
export const SPEC_KEYS = ['chip', 'screen', 'ram', 'storage', 'color', 'connection'];
export const emptyForeignFilters = () => ({ category: 'Mac', family: '', ...Object.fromEntries(SPEC_KEYS.map(key => [key, ''])) });
export const capacity = value => Number(value) >= 1024 ? `${Number(value) / 1024} TB` : `${value} GB`;
export function foreignSpecs(row) {
  const text = row.configuration || '', path = new URL(row.guideUrl).pathname;
  const family = row.category === 'Mac' ? MAC_FAMILIES.find(([key]) => path.includes(key === 'air' || key === 'pro' || key === 'neo' ? `macbook-${key}` : key === 'imac' ? 'imac' : key === 'mac-pro' ? 'mac-pro' : `mac-${key}`))?.[0] || row.model : row.model;
  const chip = text.match(/\b[MA]\d{1,2}(?:\s+(?:Pro|Max|Ultra))?\b/i)?.[0] || '';
  const size = path.match(/(\d+(?:\.\d+)?)-inch/)?.[1] || text.match(/\b(\d+(?:\.\d+)?)\s*(?:inch|["″])/i)?.[1] || text.match(/\b(\d{2})mm\b/i)?.[1];
  const screen = size ? `${size}${/\b\d{2}mm\b/i.test(text) && !path.includes('inch') ? ' мм' : '″'}` : '';
  const amounts = [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*(GB|TB)\b/gi)].map(match => Number(match[1]) * (match[2].toUpperCase() === 'TB' ? 1024 : 1));
  const explicitRam = text.match(/\b(\d+)\s*GB\s*(?:RAM|(?:Unified\s+)?Memory)/i)?.[1];
  const ram = row.category === 'Mac' ? explicitRam || (amounts.length > 1 ? String(amounts[0]) : '') : '';
  const storage = amounts.length ? String(row.category === 'Mac' && ram ? amounts.at(-1) : amounts[0]) : '';
  const color = Object.keys(COLORS).sort((a, b) => b.length - a.length).find(value => new RegExp(`\\b${value}\\b`, 'i').test(text)) || '';
  const connection = /Wi-Fi\s*\+\s*Cellular/i.test(text) ? 'Wi-Fi + Cellular' : /Wi-Fi/i.test(text) ? 'Wi-Fi' : /GPS\s*\+\s*Cellular/i.test(text) ? 'GPS + Cellular' : /\bGPS\b/i.test(text) ? 'GPS' : '';
  return { family, chip, screen, ram: String(ram), storage, color, connection };
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
