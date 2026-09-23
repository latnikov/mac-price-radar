import { parseProduct } from './offer-normalization.mjs';
import { readCachedBsaMessages } from './telegram-business.mjs';

function dateInTimeZone(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now));
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function priceListDate(text) {
  const match = text.match(/\b([0-3]?\d)\s*[/.]\s*([01]?\d)\s*[/.]\s*(20\d{2})\b/);
  if (!match) return null;
  const [, day, month, year] = match;
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

function extractPrice(line) {
  const candidates = [...line.matchAll(/(?<![\p{L}\p{N}])(?:\d{1,3}(?:[.\s\u00a0\u202f]\d{3})+|\d{4,7})(?![\p{L}\p{N}])/gu)]
    .map(match => ({ match, amount: Number(match[0].replace(/[^\d]/g, '')) }))
    .filter(item => item.amount >= 10_000 && item.amount <= 5_000_000);
  const selected = candidates.at(-1);
  if (!selected) return null;
  const start = selected.match.index;
  const end = start + selected.match[0].length;
  return {
    amount: selected.amount,
    title: `${line.slice(0, start)} ${line.slice(end)}`.replace(/\s*[-—]\s*(?:[*🔥]+\s*)?$/, '').replace(/\s+/g, ' ').trim(),
    rawPrice: selected.match[0],
  };
}

const regionNames = new Map([
  ['🇺🇸', 'US'], ['🇮🇳', 'IN'], ['🇭🇰', 'HK'], ['🇸🇬', 'SG'], ['🇻🇳', 'VN'], ['🇷🇺', 'RU'], ['🇪🇺', 'EU'],
]);

function regionFrom(line) {
  const regions = [...regionNames].filter(([flag]) => line.includes(flag)).map(([, region]) => region);
  return regions.length ? [...new Set(regions)].join('/') : 'unknown';
}

function normalizeCoreNotation(title) {
  return title
    .replace(/\bM5\s+Pro\s+Max\b/gi, 'M5 Max')
    .replace(/\b(M\d+(?:\s+(?:Pro|Max|Ultra))?)\s*\(?\s*(\d{1,2})\s*[cс]?\s*\/\s*(\d{1,2})\s*[cс]?\s*[/, ]+\s*(\d{1,3})\s*(?:GB|ГБ)?\s*[/, ]+\s*(\d{1,2})\s*(TB|ТБ|GB|ГБ)\b/gi,
      '$1 $2c CPU $3c GPU $4GB RAM $5$6 SSD')
    .replace(/\b(M\d+(?:\s+(?:Pro|Max|Ultra))?)\s*\(?\s*(\d{1,2})\s*\/\s*(\d{1,2})\s+\s*(\d{1,3})\s*(?:GB|ГБ)\s*[, ]+\s*(\d{1,2})\s*(TB|ТБ|GB|ГБ)\b/gi,
      '$1 $2c CPU $3c GPU $4GB RAM $5$6 SSD')
    .replace(/\b(\d{1,2})\s+CPU\b/gi, '$1c CPU')
    .replace(/\b(\d{1,2})\s+GPU\b/gi, '$1c GPU');
}

function normalizeProductTitle(line, contextModel) {
  let title = line
    .replace(/М(?=\d)/g, 'M')
    .replace(/\b([А-ЯA-Z0-9-]+)\s*\[(?=[A-Z0-9-]+\])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/\bNEO\b/i.test(title)) {
    title = title.replace(/\bNEO\b/i, 'MacBook Neo 13" A18 Pro');
  } else if (!/\bMacBook\s+(?:Air|Pro)\b/i.test(title)) {
    if (/\bAir\s*(13|15)\b/i.test(title)) title = title.replace(/\bAir\s*(13|15)\b/i, 'MacBook Air $1');
    else if (/\b(14|16)\s*Pro\b/i.test(title)) title = title.replace(/\b(14|16)\s*Pro\b/i, 'MacBook Pro $1');
    else if (/\bPro\s*(14|16)\b/i.test(title)) title = title.replace(/\bPro\s*(14|16)\b/i, 'MacBook Pro $1');
    else if (contextModel) title = `${contextModel} ${title}`;
  }

  if (/\bMacBook\s+Pro\b/i.test(title)) {
    title = title.replace(/\bGrey\b/gi, 'Space Gray');
    if (!/\bSpace\s+Black\b/i.test(title)) title = title.replace(/\bBlack\b/gi, 'Space Black');
  }
  return normalizeCoreNotation(title);
}

function sectionText(line) {
  return line
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contextFrom(line, current) {
  const section = sectionText(line);
  if (/\b(?:IMAC|MAC\s+MINI|MAC\s+STUDIO|STUDIO\s+DISPLAY|PRO\s+DISPLAY|IPAD|IPHONE|APPLE\s+WATCH)\b/i.test(section)) return null;
  if (/\bMACBOOK\s+NEO\b/i.test(section)) return 'MacBook Neo 13" A18 Pro';
  const pro = section.match(/\bMACBOOK\s+PRO\s+(14|16)\b/i);
  if (pro) return `MacBook Pro ${pro[1]}`;
  const air = section.match(/\bMACBOOK\s+AIR\s+(13|15)\b/i);
  if (air) return `MacBook Air ${air[1]}`;
  if (/^MACBOOK\s+AIR$/i.test(section)) return 'MacBook Air';
  const compactAir = section.match(/^AIR\s*(13|15)\b/i);
  if (compactAir) return `MacBook Air ${compactAir[1]}`;
  return current;
}

function skuFrom(line) {
  const withoutFlags = line.replace(/[\p{Emoji_Presentation}\uFE0F]/gu, ' ').trim();
  return (withoutFlags.match(/^\[([A-Z0-9-]{4,})\]/i) || withoutFlags.match(/^([A-Z][A-Z0-9-]{3,})\b/i))?.[1]?.toUpperCase() || null;
}

function looksLikeProduct(line, contextModel) {
  const section = sectionText(line);
  if (/\b(?:IMAC|MAC\s+MINI|MAC\s+STUDIO|STUDIO\s+DISPLAY|PRO\s+DISPLAY|IPAD|IPHONE|APPLE\s+WATCH)\b/i.test(section)) return false;
  const hasFamily = /\b(?:MacBook\s+)?(?:Air|Pro|NEO)\b/i.test(line) || Boolean(contextModel);
  const hasChip = /[MМ]\d+(?:\s+(?:Pro|Max|Ultra))?\b/i.test(line) || /\bA18\s+Pro\b/i.test(line) || /\bNEO\b/i.test(line);
  const hasMemory = /\b\d{1,3}\s*(?:GB|ГБ|TB|ТБ)\b/i.test(line) || /\b\d{1,3}\s*\/\s*\d{1,4}\b/.test(line);
  return hasFamily && hasChip && hasMemory;
}

export function parseBsaMessages(messages, { now = new Date(), timeZone = 'Europe/Moscow' } = {}) {
  const today = dateInTimeZone(now, timeZone);
  const offers = [], failures = [];
  let datedMessages = 0, eligibleMessages = 0, candidates = 0;

  for (const message of messages) {
    const text = String(message.text ?? '').replace(/\r/g, '');
    const postId = String(message.id ?? message.postId ?? 'unknown');
    const sourceUsername = String(message.sourceUsername || 'BigSaleApple').replace(/^@/, '');
    const sourceTitle = String(message.sourceTitle || 'BSA Store');
    const sourceSender = sourceTitle && sourceTitle.toLowerCase() !== sourceUsername.toLowerCase()
      ? `${sourceTitle} · @${sourceUsername}`
      : `@${sourceUsername}`;
    const listDate = priceListDate(text);
    if (listDate) datedMessages++;
    if (!listDate || listDate < today) continue;
    eligibleMessages++;
    const joined = text.replace(/(\d+)\s*-\s*\n\s*Core\b/gi, '$1-Core');
    let contextModel = null;
    for (const [lineIndex, rawLine] of joined.split('\n').entries()) {
      const line = rawLine.replace(/\s+/g, ' ').trim();
      if (!line) continue;
      contextModel = contextFrom(line, contextModel);
      const extracted = extractPrice(line);
      if (!extracted || !looksLikeProduct(line, contextModel)) continue;
      candidates++;
      const title = normalizeProductTitle(extracted.title, contextModel);
      const sku = skuFrom(line);
      const condition = /предактив|вскрыт|open.?box/i.test(line) ? 'open_box' : 'new';
      const parsed = parseProduct(title, `https://t.me/${sourceUsername}`, 'BSA', extracted.amount, new Date(now).toISOString(), {
        rawPrice: extracted.rawPrice,
        sourceType: 'telegram_channel',
        stock: 'source_reported',
        condition,
        region: regionFrom(line),
        keyboard: /\bРус\b/i.test(line) ? 'RU' : 'unknown',
        priceType: 'full',
        buyerType: 'retail',
        minimumQuantity: 1,
        sourceSender,
        sourceTitle,
        sourceUsername: `@${sourceUsername}`,
        evidence: { method: 'telegram-forward-v2', sourceTitle, sourceUsername: `@${sourceUsername}`, sourceChatId: message.sourceChatId || null, postId, listDate, rawLine: line },
      });
      if (!parsed) {
        failures.push(`BSA ${postId}, строка ${lineIndex + 1}: не распознана конфигурация`);
        continue;
      }
      contextModel = parsed.model;
      const sourceKey = [sku || 'no-sku', parsed.model, parsed.chip, parsed.ramGb, parsed.storageGb, parsed.color, condition].join('|');
      const url = new URL(`https://t.me/${sourceUsername}/${postId}`);
      url.searchParams.set('item', sourceKey);
      offers.push({
        ...parsed,
        url: url.href,
        externalId: sku ? `${postId}:${sku}` : `${postId}:${sourceKey}`,
        sourceVariantId: sourceKey,
        validFrom: listDate,
        sourceSender,
        sourceTitle,
        sourceUsername: `@${sourceUsername}`,
        evidence: { ...parsed.evidence, method: 'telegram-forward-v2', sourceTitle, sourceUsername: `@${sourceUsername}`, sourceChatId: message.sourceChatId || null, postId, listDate, rawLine: line },
      });
    }
  }

  return {
    offers,
    failures,
    stats: { protocol: 'Telegram Business Bot API', messages: messages.length, datedMessages, eligibleMessages, candidates, parsed: offers.length, rejected: failures.length, fromDate: today },
  };
}

export async function readBsaMessages({ env = process.env } = {}) {
  return readCachedBsaMessages({ env });
}

export async function fetchBsaOffers({ now = new Date(), timeZone = 'Europe/Moscow', env = process.env, readMessages = readBsaMessages } = {}) {
  const messages = await readMessages({ env });
  return parseBsaMessages(messages, { now, timeZone });
}
