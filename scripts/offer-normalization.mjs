import { canonicalModelName, canonicalStorageGb, moneyMinor } from './domain.mjs';
export { moneyMinor } from './domain.mjs';
export const decode = value => String(value ?? '')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&#8381;|₽|руб\.?/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export const price = value => { const minor = moneyMinor(value); return minor === null ? null : minor / 100; };

export function parseProduct(title, url, retailer, amount, fetchedAt = new Date().toISOString(), metadata = {}) {
  const decodedTitle = decode(title);
  const normalizedTitle = decodedTitle
    .replace(/\([^)]*\)/g, '')
    .replace(/, английская раскладка.*$/i, '')
    .trim();
  if (!Number.isFinite(amount) || amount <= 0) return null;

  // A URL can contain stale parent-category specifications or a typo. Prefer
  // the product title, and use only the final slug for missing attributes.
  let slug;
  try { slug = decodeURIComponent(String(url).split('?')[0].split('/').filter(Boolean).at(-1) || '').replace(/[-_]+/g, ' '); }
  catch { slug = ''; }
  const combined = `${decodedTitle} ${slug}`;
  const chip = (combined.match(/\b(A18 Pro|M\d+(?:\s+(?:Pro|Max|Ultra))?)\b/i) || [])[1];
  const modelMatch = normalizedTitle.match(/((?:MacBook\s+(?:Air|Pro|Neo)(?:\s+(?:13|14|15|16)\s*(?:["”]|дюйм)?|\s*\d{2}\s*Early\s*\d{4})?)|(?:iMac(?:\s+(?:24|27)\s*(?:["”]|дюйм)?)?))/i);
  if (!chip || !modelMatch) return null;

  let model = modelMatch[1]
    .replace(/Early\s*\d{4}/i, '')
    .replace(/\s*дюйм/i, '"')
    .replace(/\s*["”]/, '"')
    .replace(/\s+/g, ' ')
    .trim();
  model = canonicalModelName(model.replace(/\b(13|14|15|16)$/, '$1"'));

  const memory = text => {
    const slash = text.match(/\b(\d{1,3})\s*(?:ГБ|GB)?\s*\/\s*(\d{1,4})\s*(ТБ|TB|ГБ|GB|Г|G)?\b/i);
    if (slash) return { ram: Number(slash[1]), storage: Number(slash[2]) * (/тб|tb/i.test(slash[3] || '') ? 1000 : 1) };
    const values = [...text.matchAll(/(\d+)\s*(ТБ|TB|ГБ|GB)/gi)]
      .map(m => ({ value: Number(m[1]) * (/тб|tb/i.test(m[2]) ? 1000 : 1) }));
    const prefixRam = text.match(/RAM\s*(\d+)\s*(?:ГБ|GB)/i);
    const suffixRam = text.match(/(\d+)\s*(?:ГБ|GB)\s*RAM/i);
    const prefixSsd = text.match(/SSD\s*(\d+)\s*(ТБ|TB|ГБ|GB)/i);
    const suffixSsd = text.match(/(\d+)\s*(ТБ|TB|ГБ|GB)\s*SSD/i);
    const suffixLabels = suffixRam && suffixSsd && !(prefixRam && prefixSsd);
    const ram = suffixLabels ? suffixRam : prefixRam || suffixRam;
    const ssd = suffixLabels ? suffixSsd : prefixSsd || suffixSsd;
    return {
      ram: ram ? Number(ram[1]) : values.find(x => x.value < 256)?.value,
      storage: ssd ? Number(ssd[1]) * (/тб|tb/i.test(ssd[2]) ? 1000 : 1) : values.find(x => x.value >= 256)?.value,
    };
  };
  const titleMemory = memory(decodedTitle), slugMemory = memory(slug);
  const ramGb = titleMemory.ram ?? slugMemory.ram ?? null;
  const storageGb = canonicalStorageGb(titleMemory.storage ?? slugMemory.storage ?? null);
  if (!ramGb || !storageGb) return null;

  const macBookColorMap = [
    ['Sky Blue', 'sky blue|sky-blue|небесно[ -]голуб|nebesno[ -]golub|goluboe'],
    ['Midnight', 'midnight|полуноч|т[её]мн(?:ая|ую)?[ -]ноч|polunochn|temnaa[ -]noc'],
    ['Starlight', 'starlight|сияющ|zvezda'],
    ['Blush', 'blush|румян|rumyan|rumian|розов|rozov|pink'],
    ['Citrus', 'citrus|цитрус|tsitrus|желт|zhelt|yellow'],
    ['Indigo', 'indigo|индиго|син(?:ий|яя|ее|его)?|sini|blue'],
    ['Silver', 'silver|серебр|[sc]erebr'],
    ['Space Gray', 'space gray|space-gray|серый космос|sery[jy][ -]kosmos'],
    ['Gold', 'gold|золот|zolot'],
    ['Space Black', 'space black|space-black|ч[её]рн|chern|cernyj'],
  ];
  const imacColorMap = [
    ['Silver', 'silver|серебр'],
    ['Blue', '\\bblue\\b|син(?:ий|яя|ее|его)?'],
    ['Green', '\\bgreen\\b|зел[её]н'],
    ['Orange', '\\borange\\b|оранжев'],
    ['Yellow', '\\byellow\\b|ж[её]лт'],
    ['Pink', '\\bpink\\b|розов'],
    ['Purple', '\\bpurple\\b|фиолет'],
  ];
  const colorMap = /^iMac\b/i.test(model) ? imacColorMap : macBookColorMap;
  const findColor = text => colorMap.find(([, pattern]) => new RegExp(pattern, 'i').test(text))?.[0];
  const color = findColor(decodedTitle) || findColor(slug) || 'unknown';
  const cores = text => {
    const pair = text.match(/(\d+)\s*[-_ ]?core(?:\s*,?\s*|[-_]+)GPU[-_\s]*(\d+)\s*[-_ ]?core/i);
    return {
      cpu: Number((text.match(/(\d+)\s*(?:c|[- ]?core)[-_\s]*CPU/i) || [])[1] || (text.match(/CPU[-_\s]*(\d+)\s*(?:c|[- ]?core)/i) || [])[1] || pair?.[1] || (text.match(/A18\s+Pro\s*(\d+)\s*[- ]?core/i) || [])[1]) || null,
      gpu: Number(pair?.[2] || (text.match(/(\d+)\s*(?:c|[- ]?core)[-_\s]*GPU/i) || [])[1] || (text.match(/GPU[-_\s]*(\d+)\s*(?:c|[- ]?core)/i) || [])[1]) || null,
    };
  };
  const titleCores = cores(decodedTitle), slugCores = cores(slug);
  const cpuCores = titleCores.cpu || slugCores.cpu, gpuCores = titleCores.gpu || slugCores.gpu;
  const qualityWarnings = [...(metadata.qualityWarnings || [])];
  for (const field of ['ram', 'storage']) {
    if (titleMemory[field] && slugMemory[field] && titleMemory[field] !== slugMemory[field]) qualityWarnings.push(`Конфликт ${field}: заголовок ${titleMemory[field]}, URL ${slugMemory[field]}`);
  }
  for (const field of ['cpu', 'gpu']) if (titleCores[field] && slugCores[field] && titleCores[field] !== slugCores[field]) qualityWarnings.push(`Конфликт ${field}: заголовок ${titleCores[field]}, URL ${slugCores[field]}`);
  const titleColor = findColor(decodedTitle), slugColor = findColor(slug);
  if (titleColor && slugColor && titleColor !== slugColor) qualityWarnings.push(`Конфликт цвета: ${titleColor}, URL ${slugColor}`);
  const chipIn = text => text.match(/\b(A18 Pro|M\d+(?:\s+(?:Pro|Max|Ultra))?)\b/i)?.[1].toUpperCase();
  if (chipIn(decodedTitle) && chipIn(slug) && chipIn(decodedTitle) !== chipIn(slug)) qualityWarnings.push('Конфликт чипа между заголовком и URL');
  if (![8, 12, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 512].includes(ramGb) || ![128, 256, 512, 1000, 2000, 4000, 8000, 16000].includes(storageGb)) qualityWarnings.push('Непроверенное сочетание RAM/SSD');
  const keyboardMatch = combined.match(/\bKB[ -]?(US|RU|RS|UK|EU)\b/i);
  const keyboard = keyboardMatch?.[1].toUpperCase() || (/английск.*раскладк/i.test(decodedTitle) ? 'US' : 'unknown');
  const condition = /б\s*\/\s*у|\bused\b|бывш.*употреб/i.test(combined) ? 'used'
    : /refurb|восстановлен/i.test(combined) ? 'refurbished'
    : /витрин|\bdisplay\b/i.test(combined) ? 'display'
    : /вскрыт|open.?box/i.test(combined) ? 'open_box'
    : /новый|новая|новое|\bnew\b|запечатан/i.test(combined) ? 'new' : 'unknown';
  // This price table uses rubles for every source by business policy.
  metadata = { ...metadata, currency: 'RUB' };
  const currency = 'RUB';
  const priceType = /рассроч|в месяц|\/мес/i.test(String(metadata.rawPrice || '')) ? 'installment' : /(?:^|\s)от\s+\d/i.test(String(metadata.rawPrice || '')) ? 'from' : 'unknown';
  return { ...metadata, retailer, title: normalizedTitle, rawTitle: String(title), url, price: amount, priceMinor: moneyMinor(amount), currency: metadata.currency || currency, fetchedAt, observedAt: fetchedAt, condition: condition !== 'unknown' ? condition : metadata.condition || condition, model, chip: chip.replace(/\s+/g, ' ').toUpperCase().replace(' PRO', ' Pro').replace(' MAX', ' Max').replace(' ULTRA', ' Ultra'), ramGb, storageGb, color, cpuCores, gpuCores, screenIn: Number(model.match(/\b(13|14|15|16|24|27)/)?.[1]) || null, keyboard: metadata.keyboard || keyboard, region: metadata.region || 'unknown', displayType: metadata.displayType || 'unknown', bundle: metadata.bundle || 'unknown', priceType: priceType !== 'unknown' ? priceType : metadata.priceType || 'unknown', stock: metadata.stock || 'unknown', evidence: { title: String(title), slug, titleMemory, slugMemory, ...(metadata.evidence || {}) }, qualityWarnings, normalizationVersion: 3 };
}
