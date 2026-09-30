import { parseBsaMessages } from './bsa.mjs';
import { readCachedChannelMessages } from './telegram-business.mjs';
import { stableId } from './domain.mjs';

const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' });
const variantFields = ['model', 'chip', 'screenIn', 'cpuCores', 'gpuCores', 'ramGb', 'storageGb', 'color', 'condition', 'keyboard', 'region', 'displayType', 'bundle', 'priceType', 'minimumQuantity'];

export function parseTelegramChannel(messages, source) {
  const offers = new Map(), failures = [];
  let candidates = 0;
  const ordered = [...messages].sort((a, b) => String(b.submittedAt || b.receivedAt || b.date || '').localeCompare(String(a.submittedAt || a.receivedAt || a.date || '')) || Number(b.id) - Number(a.id));
  for (const message of ordered) {
    const observed = Date.parse(message.submittedAt || message.receivedAt || message.date);
    if (!Number.isFinite(observed)) { failures.push(`Сообщение ${message.id}: нет даты исходного прайса`); continue; }
    const text = String(message.text || '');
    const dated = /\b[0-3]?\d\s*[/.]\s*[01]?\d\s*[/.]\s*20\d{2}\b/.test(text);
    // Bot submission confirms an old forwarded post; legacy caches retain their saved receipt/source time.
    const parsed = parseBsaMessages([{ ...message, text: dated ? text : `${dayFormat.format(observed)}\n${text}` }], { now: observed });
    candidates += parsed.stats.candidates;
    failures.push(...parsed.failures.map(failure => failure.replace(/^BSA/, source.sourceTitle)));
    for (const item of parsed.offers) {
      const line = item.evidence?.rawLine || '';
      const condition = /предактив|вскрыт|open.?box/i.test(line) ? 'open_box'
        : /б\s*\/\s*у|\bused\b/i.test(line) ? 'used'
          : /восстанов|\brefurb/i.test(line) ? 'refurbished'
            : /новый|новая|новые|\bnew\b|запечат/i.test(line) ? 'new' : 'unknown';
      const qualityWarnings = [...(item.qualityWarnings || [])];
      if (/\$|€|USD|EUR|USDT|рассроч|в месяц|от\s+\d|опт\s+от/i.test(line)) qualityWarnings.push('Нужно уточнить валюту или условия цены');
      const offer = { ...item, ...source, condition, qualityWarnings, submittedAt: new Date(observed).toISOString(), fetchedAt: new Date(observed).toISOString(), observedAt: new Date(observed).toISOString() };
      const key = stableId('variant', variantFields.map(field => offer[field] ?? null));
      // A newer post replaces a variant's previous price, even if it rose.
      if (offers.has(key)) continue;
      const channelPath = source.sourceUsername || `c/${source.sourceChatId.replace(/^-100/, '')}`;
      const url = new URL(`https://t.me/${channelPath}/${message.id}`);
      url.searchParams.set('item', key);
      offers.set(key, { ...offer, sourceId: `telegram:${source.sourceChatId}`, sellerId: `telegram:${source.sourceChatId}`,
        sourceVariantId: key, externalId: key, url: url.href,
        evidence: { ...item.evidence, method: 'telegram-channel-v1', sourceChatId: source.sourceChatId } });
    }
  }
  if (!offers.size) failures.push('В сообщениях пока не найдены распознаваемые цены Mac. Нужны текст, модель, память и полная цена.');
  return { offers: [...offers.values()], failures,
    stats: { protocol: 'Telegram Bot API', messages: messages.length, candidates, parsed: offers.size, rejected: failures.length } };
}

export async function fetchTelegramChannel(source, { env = process.env } = {}) {
  const messages = await readCachedChannelMessages({ env, sourceChatId: source.sourceChatId });
  return parseTelegramChannel(messages, source);
}
