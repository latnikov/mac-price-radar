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
  const decodedTitle = decode(title);
  const normalizedTitle = decodedTitle
    .replace(/\([^)]*\)/g, '')
    .replace(/, английская раскладка.*$/i, '')
    .trim();
  if (!amount) return null;

  const combined = `${decodedTitle} ${url}`;
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

  const slashConfiguration = combined.match(/\b(\d{1,3})\s*(?:ГБ|GB)?\s*\/\s*(\d{3,4})\s*(?:ГБ|GB|Г|G)?\b/i);
  const ramMatch = combined.match(/(?:RAM\s*)?(\d+)\s*(?:ГБ|GB)/i);
  const storageMatches = [...combined.matchAll(/(\d+)\s*(?:ТБ|TB|тб|tb|ГБ|GB|гб|gb)/gi)]
    .map(match => ({ value: Number(match[1]), terabytes: /тб|tb/i.test(match[0]) }));
  const storage = storageMatches.at(-1) ?? null;
  const ramGb = slashConfiguration ? Number(slashConfiguration[1]) : ramMatch ? Number(ramMatch[1]) : null;
  const storageGb = slashConfiguration
    ? Number(slashConfiguration[2])
    : storage ? storage.value * (storage.terabytes ? 1000 : 1) : null;
  if (!ramGb || !storageGb) return null;

  const colorMap = [
    ['Sky Blue', 'sky blue|sky-blue|небесно-голуб|goluboe'],
    ['Midnight', 'midnight|полуноч|temnaa-noc'],
    ['Starlight', 'starlight|сияющ|zvezda'],
    ['Blush', 'blush|румян|rumyan|rumian|розов|rozov|pink'],
    ['Citrus', 'citrus|цитрус|tsitrus|желт|zhelt|yellow'],
    ['Indigo', 'indigo|индиго|син(?:ий|яя|ее|его)?|sini|blue'],
    ['Silver', 'silver|серебр|serebr'],
    ['Space Gray', 'space gray|space-gray|серый космос|seryj-kosmos'],
    ['Gold', 'gold|золот|zolot'],
    ['Space Black', 'space black|space-black|черн|cernyj|kosmos'],
  ];
  const color = (colorMap.find(([, pattern]) => new RegExp(pattern, 'i').test(combined)) || [])[0] || 'unknown';
  const corePair = combined.match(/(\d+)\s*[-_ ]?core(?:\s*,?\s*|[-_]+)GPU[-_\s]*(\d+)\s*[-_ ]?core/i);
  const cpuCores = Number(
    corePair?.[1]
    || (combined.match(/(\d+)\s*(?:c|[- ]?core)[-_\s]*CPU/i) || [])[1]
    || (combined.match(/CPU[-_\s]*(\d+)\s*(?:c|[- ]?core)/i) || [])[1]
    || (combined.match(/A18\s+Pro\s*(\d+)\s*[- ]?core/i) || [])[1]
  ) || null;
  const gpuCores = Number(
    corePair?.[2]
    || (combined.match(/(\d+)\s*c[-_\s]*GPU/i) || [])[1]
    || (combined.match(/GPU[-_\s]*(\d+)\s*(?:c|[- ]?core)/i) || [])[1]
  ) || null;

  return { retailer, title: normalizedTitle, url, price: amount, currency: 'RUB', fetchedAt, condition: 'new', model, chip: chip.replace(/\s+/g, ' '), ramGb, storageGb, color, cpuCores, gpuCores };
}
