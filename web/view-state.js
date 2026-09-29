const families = new Set(['air', 'pro', 'neo', 'mini', 'studio', 'imac', '*']);
const sorts = new Set(['model', 'price-up', 'price-down', 'fresh', 'coverage']);
export const emptyFilters = () => ({ family: null, chip: null, screen: '', ram: '', ssd: '', color: '', stock: '' });
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
    filters.stock = ['in', 'out'].includes(params.get('stock')) ? params.get('stock') : '';
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
export const searchTerms = query => normalize(query).match(/\bm\d+\s+(?:pro|max|ultra)\b|\S+/g) || [];
export function offerSearchText(offer) {
  const storage = ({ 1024: 1000, 2048: 2000, 4096: 4000, 8192: 8000, 16384: 16000 })[Number(offer.storageGb)] ?? Number(offer.storageGb);
  return normalize([offer.title, offer.model, offer.chip, offer.color, offer.sku, offer.article, offer.retailer, offer.sourceTitle, offer.sellerName, offer.screenIn, offer.ramGb, offer.storageGb, storage >= 1000 ? `${storage / 1000} TB ТБ` : ''].filter(Boolean).join(' '));
}
export const matchesSearch = (text, terms) => terms.every(term => text.includes(term));
