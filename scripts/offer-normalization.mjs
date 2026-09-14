export const decode = value => String(value ?? '')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&#8381;|₽|руб\.?/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export const price = value => {
  const match = decode(value).replace(/\s/g, '').match(/\d[\d,.]*/);
  return match ? Number(match[0].replace(/,/g, '')) : null;
};

export function parseProduct(title, url, retailer, amount, fetchedAt = new Date().toISOString()) {
  const normalizedTitle = decode(title)
    .replace(/\([^)]*\)/g, '')
    .replace(/, английская раскладка.*$/i, '')
    .trim();
  if (!amount) return null;

  const combined = `${normalizedTitle} ${url}`;
  const chip = (combined.match(/\b(A18 Pro|M[45](?:\s+(?:Pro|Max))?)\b/i) || [])[1];
  const modelMatch = normalizedTitle.match(/(MacBook\s+(?:Air|Pro|Neo)(?:\s+(?:13|14|15|16)\s*(?:["”]|дюйм)?|\s*\d{2}\s*Early\s*\d{4})?)/i);
  if (!chip || !modelMatch) return null;

  let model = modelMatch[1]
    .replace(/Early\s*\d{4}/i, '')
    .replace(/\s*дюйм/i, '"')
    .replace(/\s*["”]/, '"')
    .replace(/\s+/g, ' ')
    .trim();
  model = model.replace(/\b(13|14|15|16)$/, '$1"');

  const ramMatch = combined.match(/(?:RAM\s*)?(\d+)\s*(?:ГБ|GB|gb)/i);
  const storageMatches = [...combined.matchAll(/(\d+)\s*(?:ТБ|TB|тб|tb|ГБ|GB|гб|gb)/gi)]
    .map(match => ({ value: Number(match[1]), terabytes: /тб|tb/i.test(match[0]) }));
  const storage = storageMatches.at(-1) ?? null;
  const ramGb = ramMatch ? Number(ramMatch[1]) : null;
  const storageGb = storage ? storage.value * (storage.terabytes ? 1000 : 1) : null;
  if (!ramGb || !storageGb) return null;

  const colorMap = [
    ['Sky Blue', 'sky blue|sky-blue|небесно-голуб|goluboe'],
    ['Midnight', 'midnight|полуноч|temnaa-noc'],
    ['Starlight', 'starlight|сияющ|zvezda'],
    ['Silver', 'silver|серебрист|serebr'],
    ['Space Black', 'space black|space-black|черн|cernyj|kosmos'],
  ];
  const color = (colorMap.find(([, pattern]) => new RegExp(pattern, 'i').test(combined)) || [])[0] || 'unknown';
  const corePair = combined.match(/(\d+)[- ]?core[- ]gpu[- ](\d+)[- ]?core/i);
  const cpuCores = Number(corePair?.[1] || (combined.match(/(\d+)(?:[- ]?Core|\s*c)[^,)]*CPU/i) || [])[1]) || null;
  const gpuCores = Number(corePair?.[2] || (combined.match(/(\d+)(?:[- ]?Core|\s*c)[^,)]*GPU/i) || [])[1]) || null;

  return { retailer, title: normalizedTitle, url, price: amount, currency: 'RUB', fetchedAt, condition: 'new', model, chip: chip.replace(/\s+/g, ' '), ramGb, storageGb, color, cpuCores, gpuCores };
}
