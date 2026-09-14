const productAnchor = /<a\b(?=[^>]*\bclass=["'][^"']*\bproducts-view-name-link\b[^"']*["'])(?=[^>]*\btitle=["']([^"']+)["'])[^>]*>/gi;

const absoluteUrl = (value, baseUrl) => {
  try { return new URL(value, baseUrl).href; } catch { return null; }
};

export function findRifaCategoryUrls(html, baseUrl = 'https://rifastore.ru/') {
  const values = [...String(html).matchAll(/href=["']([^"']*\/categories\/macbook-[^"']+)["']/gi)]
    .map(match => absoluteUrl(match[1], baseUrl))
    .filter(Boolean);
  return [...new Set(values)];
}

export function findRifaNextPage(html, pageUrl) {
  const link = [...String(html).matchAll(/<link\b[^>]*>/gi)]
    .find(match => /\brel=["']next["']/i.test(match[0]));
  if (!link) return null;
  const href = (link[0].match(/\bhref=["']([^"']+)["']/i) || [])[1];
  return href ? absoluteUrl(href, pageUrl) : null;
}

export function parseRifaCategory(html, pageUrl) {
  const source = String(html);
  const anchors = [...source.matchAll(productAnchor)];
  const products = [];
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const end = anchors[index + 1]?.index ?? source.length;
    const card = source.slice(anchor.index, end);
    const priceText = (card.match(/<[^>]+\bclass=["'][^"']*\bprice-number\b[^"']*["'][^>]*>([\s\S]*?)<\//i) || [])[1];
    if (!priceText) continue;
    const productUrl = (anchor[0].match(/https:\/\/rifastore\.ru\/products\/[^'"}\s)]+/i) || [])[0]
      || (anchor[0].match(/\b(?:href|data-ng-href)=["'](\/products\/[^"']+)["']/i) || [])[1];
    products.push({ title: anchor[1], url: productUrl ? absoluteUrl(productUrl, pageUrl) : pageUrl, priceText });
  }
  return products;
}
