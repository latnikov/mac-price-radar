// Public pages have no client-side selectors. Shorten their private CSS classes
// together with the matching HTML tokens to keep the complete response <14 KB.
// CRM/parser classes remain stable for their JavaScript and third-party styles.
export function compactShop(html) {
  const sheet = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
  const names = [...new Set([...sheet.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(match => match[1]))];
  const alphabet='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const tokens = new Map(names.map((name, i) => [name, alphabet[i%52]+(i<52?'':Math.floor(i/52))]));
  return html.replace(/(<[a-z][^<>]*?\sclass=")([^"]+)(")/g, (_, start, classes, end) =>
    start + classes.split(' ').map(name => tokens.get(name) || name).join(' ') + end
  ).replace(/<style>[\s\S]*?<\/style>/, () => '<style>' + sheet
    .replace(/\.([a-zA-Z][\w-]*)/g, (_, name) => '.' + tokens.get(name))
    .replace(/;}/g, '}') + '</style>');
}
