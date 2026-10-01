// Preserve the laptop target and add only the four requested phone families.
export const AVITO_SEARCH_TARGETS = [
  { query: 'MacBook', path: 'noutbuki', category: 'laptops' },
  { query: 'iPhone 18 Pro', path: 'telefony', category: 'phones' },
  { query: 'iPhone 18 Pro Max', path: 'telefony', category: 'phones' },
  { query: 'iPhone 17 Pro', path: 'telefony', category: 'phones' },
  { query: 'iPhone 17 Pro Max', path: 'telefony', category: 'phones' },
].map(target => ({ ...target, searchUrl: `https://www.avito.ru/nizhniy_novgorod/${target.path}?q=${target.query === 'MacBook' ? 'macbook' : encodeURIComponent(target.query)}` }));

export function avitoSearchTarget(query) {
  const value = String(query || '').trim();
  if (/^MacBook(?: (?:Air|Pro|Neo|M[1-5](?: Pro| Max| Ultra)?))*$/i.test(value) && value.length <= 80) return { ...AVITO_SEARCH_TARGETS[0], query: value };
  return AVITO_SEARCH_TARGETS.find(target => target.query.toLowerCase() === value.toLowerCase()) || null;
}
