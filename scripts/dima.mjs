import { parseProduct } from './offer-normalization.mjs';
import { readCachedChannelMessages } from './telegram-business.mjs';

const DEFAULT_CHAT_ID = '-1003421701174';

function dateInTimeZone(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now));
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function privateChannelUrl(chatId, postId) {
  const internalId = String(chatId || '').replace(/^-100/, '');
  return internalId ? `https://t.me/c/${internalId}/${postId}` : 'https://t.me/';
}

function sourceMeta(message) {
  const sourceTitle = String(message.sourceTitle || 'прайс от Л');
  const sourceUsername = message.sourceUsername ? String(message.sourceUsername).replace(/^@/, '') : null;
  return {
    sourceTitle,
    sourceUsername: sourceUsername ? `@${sourceUsername}` : null,
    sourceSender: sourceUsername ? `${sourceTitle} · @${sourceUsername}` : sourceTitle,
  };
}

function parsedLine(line) {
  const normalized = line.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const match = normalized.match(/^MacBook\s+([A-Z0-9]+)\s+(.+?)\s*2026\s+(\d{5,7})(?:\s*🚚)?$/i);
  if (!match) return null;
  const [, sku, description, rawPrice] = match;
  let title = `MacBook ${description}`;
  if (/^MacBook\s+Neo\b/i.test(title)) {
    title = title.replace(/^MacBook\s+Neo(?:\s+13)?\b/i, 'MacBook Neo 13"').replace(/\bA18\b(?!\s+Pro)/i, 'A18 Pro');
  }
  return { sku: sku.toUpperCase(), title, amount: Number(rawPrice), rawPrice };
}

export function parseDimaMessages(messages, { now = new Date(), timeZone = 'Europe/Moscow' } = {}) {
  const today = dateInTimeZone(now, timeZone);
  const offers = [], failures = [], seen = new Set();
  let eligibleMessages = 0, candidates = 0;
  for (const message of messages) {
    const messageDate = Number.isFinite(Date.parse(message.date)) ? dateInTimeZone(message.date, timeZone) : null;
    if (!messageDate || messageDate < today) continue;
    eligibleMessages++;
    const postId = String(message.id ?? message.postId ?? 'unknown');
    const source = sourceMeta(message);
    for (const [lineIndex, rawLine] of String(message.text || '').replace(/\r/g, '').split('\n').entries()) {
      const item = parsedLine(rawLine);
      if (!item) continue;
      candidates++;
      const duplicateKey = `${item.sku}|${item.title}|${item.amount}`.toLowerCase();
      if (seen.has(duplicateKey)) continue;
      seen.add(duplicateKey);
      const baseUrl = message.sourceUsername
        ? `https://t.me/${String(message.sourceUsername).replace(/^@/, '')}/${postId}`
        : privateChannelUrl(message.sourceChatId, postId);
      const parsed = parseProduct(item.title, baseUrl, 'Дима', item.amount, new Date(now).toISOString(), {
        rawPrice: item.rawPrice,
        sourceType: 'telegram_channel',
        stock: 'source_reported',
        condition: 'new',
        region: 'unknown',
        keyboard: 'unknown',
        displayType: 'standard',
        bundle: 'standard',
        priceType: 'full',
        buyerType: 'retail',
        minimumQuantity: 1,
        ...source,
        evidence: { method: 'telegram-forward-v2', sourceTitle: source.sourceTitle, sourceUsername: source.sourceUsername, sourceChatId: message.sourceChatId || null, postId, messageDate, rawLine: rawLine.trim() },
      });
      if (!parsed) {
        failures.push(`Дима ${postId}, строка ${lineIndex + 1}: не распознана конфигурация`);
        continue;
      }
      const url = new URL(baseUrl);
      url.searchParams.set('item', item.sku);
      offers.push({
        ...parsed,
        url: url.href,
        externalId: item.sku,
        sourceVariantId: item.sku,
        validFrom: messageDate,
      });
    }
  }
  return {
    offers,
    failures,
    stats: { protocol: 'Telegram Bot API via Apps Script polling', messages: messages.length, eligibleMessages, candidates, parsed: offers.length, rejected: failures.length, fromDate: today },
  };
}

export async function readDimaMessages({ env = process.env } = {}) {
  return readCachedChannelMessages({ env, sourceChatId: env.TELEGRAM_DIMA_CHAT_ID || DEFAULT_CHAT_ID });
}

export async function fetchDimaOffers({ now = new Date(), timeZone = 'Europe/Moscow', env = process.env, readMessages = readDimaMessages } = {}) {
  const messages = await readMessages({ env });
  return parseDimaMessages(messages, { now, timeZone });
}
