import { PHONE_FAMILIES } from './product-families.js';
const families = new Set(['air', 'pro', 'neo', 'mini', 'studio', 'imac', ...Object.keys(PHONE_FAMILIES), '*']);
const sorts = new Set(['model', 'price-up', 'price-down', 'fresh', 'coverage', 'relevance']);
export const emptyFilters = () => ({ family: null, chip: null, screen: '', ram: '', ssd: '', color: '', sim: '', stock: '' });
const shortText = value => String(value || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 120);
const positiveNumber = value => /^\d+(?:\.\d+)?$/.test(value || '') && Number(value) > 0 && Number(value) <= 1e9 ? value : '';

export function readView(hash = '') {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const filters = emptyFilters();
  const query = shortText(params.get('q'));
  if (families.has(params.get('family'))) filters.family = params.get('family');
  else if (query) filters.family = '*';
  if (filters.family !== null) {
    filters.chip = shortText(params.get('chip')) || '*';
    for (const key of ['screen', 'ram', 'ssd']) filters[key] = positiveNumber(params.get(key));
    filters.color = shortText(params.get('color'));
    filters.sim = ['eSIM', 'SIM + eSIM', 'Dual SIM', 'unknown'].includes(params.get('sim')) ? params.get('sim') : '';
    filters.stock = ['in', 'out'].includes(params.get('stock')) ? params.get('stock') : '';
    if (PHONE_FAMILIES[filters.family]) Object.assign(filters, { chip: '*', screen: '', ram: '' });
  }
  return { filters, query, min: positiveNumber(params.get('min')), max: positiveNumber(params.get('max')), sort: sorts.has(params.get('sort')) ? params.get('sort') : 'model' };
}

export function writeView(view) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(view.filters)) if (value != null && value !== '') params.set(key, value);
  if (view.query) params.set('q', shortText(view.query));
  if (positiveNumber(view.min)) params.set('min', view.min);
  if (positiveNumber(view.max)) params.set('max', view.max);
  if (sorts.has(view.sort) && view.sort !== 'model') params.set('sort', view.sort);
  return params.size ? `#${params}` : '';
}

const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const aliases = { 'про': 'pro', 'макс': 'max', 'ультра': 'ultra', 'эйр': 'air', 'аир': 'air', 'макбук': 'macbook', 'мак': 'mac', 'мини': 'mini', 'студио': 'studio', 'айфон': 'iphone', 'тб': 'tb', 'гб': 'gb' };
const canonical = value => normalize(value).replace(/(^|\s)[мm]\s*(\d+)/g, '$1m$2').split(/\s+/).map(word => aliases[word] || word).join(' ').replace(/\b(m\d+)(pro|max|ultra)\b/g, '$1 $2');
export const searchTerms = query => canonical(query).match(/\bm\d+\s+(?:pro|max|ultra)\b|\S+/g) || [];
export function offerSearchText(offer) {
  const storage = ({ 1024: 1000, 2048: 2000, 4096: 4000, 8192: 8000, 16384: 16000 })[Number(offer.storageGb)] ?? Number(offer.storageGb);
  return canonical([offer.title, offer.model, offer.chip, offer.color, offer.simType, offer.region, offer.sku, offer.article, offer.retailer, offer.sourceTitle, offer.sellerName, offer.screenIn, offer.ramGb, offer.storageGb, storage >= 1000 ? `${storage / 1000} TB ТБ` : ''].filter(Boolean).join(' '));
}
// Numbers and chip generations are exact; fuzzy matching only applies to words.
const oneEdit = (a, b) => {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const differences = [...a].map((c, i) => c === b[i] ? -1 : i).filter(i => i >= 0);
    return differences.length <= 1 || (differences.length === 2 && differences[1] === differences[0] + 1 && a[differences[0]] === b[differences[1]] && a[differences[1]] === b[differences[0]]);
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0; while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1);
};
export function searchScore(text, terms) {
  const words = text.split(' ');
  let score = 0;
  for (const term of terms) {
    if (term.includes(' ')) {
      if (!(` ${text} `).includes(` ${term} `)) return -1;
      score += 100; continue;
    }
    if (words.includes(term)) { score += 100; continue; }
    if (/^\d+$|^m\d+$/.test(term)) return -1;
    if (term.length >= 2 && words.some(word => word.startsWith(term))) { score += 70; continue; }
    if (term.length >= 3 && !/\d/.test(term) && words.some(word => !/\d/.test(word) && word.length >= 3 && oneEdit(term, word))) { score += 40; continue; }
    return -1;
  }
  return score;
}
export const matchesSearch = (text, terms) => searchScore(text, terms) >= 0;
