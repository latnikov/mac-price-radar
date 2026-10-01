import { priceStatus } from './price-status.js';
import { isProcurementOffer } from './retail-analytics.js';
import { AVITO, avitoSellerColumns, priceColumnKey, groupOffersByPriceColumn, sheetOffers } from './avito-columns.js';
import { avitoStatus } from './avito-status.js';
import { emptyFilters, readView, writeView, searchTerms, offerSearchText, matchesSearch, searchScore } from './view-state.js';
import { prepareTableOffers, buildPriceTable, selectTablePage, currentPrice, searchOverview, validMacColor, TABLE_PAGE_SIZE } from './price-table.js';
import { PHONE_FAMILIES, isPhone, productFamily, productScreen, storageLabel, configurationBadges } from './product-families.js';

const $ = id => document.getElementById(id);
const avitoSheet = document.body.dataset.sheet === 'avito';
const state = {
  offers: [], retailers: [], telegramSources: [], csrf: '', wasRunning: false, refreshPending: false,
  filters: emptyFilters(), page: 1,
};
const searchIndex = new WeakMap();
const COLUMN_STORAGE_KEY = avitoSheet ? 'mac-price-radar:avito-columns:v1' : 'mac-price-radar:columns:v1';
const hiddenGroups = new Set(), hiddenColumns = new Set();
try {
  const saved = JSON.parse(localStorage.getItem(COLUMN_STORAGE_KEY) || '{}');
  for (const [values, target] of [[saved.groups, hiddenGroups], [saved.columns, hiddenColumns]]) {
    if (Array.isArray(values)) for (const key of values) if (typeof key === 'string') target.add(key);
  }
} catch { /* A blocked or damaged browser store must not prevent loading prices. */ }
function saveColumns() {
  try { localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify({ groups: [...hiddenGroups], columns: [...hiddenColumns] })); } catch { /* Keep this session's selection. */ }
}

function restoreView() {
  const view = readView(location.hash);
  state.filters = view.filters;
  state.page = 1;
  $('search').value = view.query;
  $('min-price').value = view.min;
  $('max-price').value = view.max;
  $('sort').value = view.query && view.sort === 'model' ? 'relevance' : view.sort;
}
function saveView() {
  const hash = writeView({ filters: state.filters, query: $('search').value, min: $('min-price').value, max: $('max-price').value, sort: $('sort').value });
  if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
}
const CURRENT_CHIPS = {
  mini: new Set(['M6', 'M5 Pro']),
  studio: new Set(['M5 Max', 'M5 Ultra']),
  air: new Set(['M5']),
  pro: new Set(['M5', 'M5 Pro', 'M5 Max']),
  neo: new Set(['A18 Pro']),
  imac: new Set(['M4']),
};
const RETAILER_GROUPS = [
  { key: 'procurement', label: 'Закупка', retailers: [{ name: 'Дима', label: 'Дима' }, { name: 'BSA', label: 'BSA' }] },
  { key: 'moscow', label: 'МСК / РФ', retailers: [{ name: 'BigGeek', label: 'BigGeek' }, { name: 'Store77', label: 'Store77' }, { name: 'RifaStore', label: 'Rifa' }] },
  { key: 'nizhny', label: 'НН', retailers: [{ name: 'Айфория', label: 'Айфория' }, { name: 'Technichno', label: 'Технично' }, { name: 'iMobile', label: 'iMobile' }, { name: 'ReSale', label: 'ReSale' }, { name: 'Apple Store', label: 'Apple Store' }, { name: 'Rebro', label: 'Rebro' }, { name: 'Madstore', label: 'Madstore' }, { name: 'Smart Device', label: 'Smart Device' }, { name: 'AFM', label: 'AFM' }, { name: 'HitApple', label: 'Хит Эпл' }] },
];
const CONFIGURED_RETAILERS = RETAILER_GROUPS.flatMap(group => group.retailers.map(retailer => retailer.name));
const text = (tag, value, cls) => { const node = document.createElement(tag); if (value != null) node.textContent = String(value); if (cls) node.className = cls; return node; };
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU') : 'Дата не указана';
const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const sortCollator = new Intl.Collator('ru', { numeric: true });
const moscowDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
const number = value => numberFormat.format(Number(value));
const plural = (n, forms) => forms[n % 100 >= 11 && n % 100 <= 14 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2];
const storage = storageLabel;
const amount = offer => `${number(offer.price)} ₽`;
const rubles = value => Number.isFinite(value) ? `${number(value)} ₽` : '—';
const stock = offer => ['InStock', 'confirmed', 'source_reported'].includes(offer.stock) ? 'in' : ['OutOfStock', 'Discontinued', 'SoldOut'].includes(offer.stock) ? 'out' : 'unknown';
const compareOffers = (a, b) => a.price - b.price || String(a.url).localeCompare(String(b.url));
const model = offer => String(offer.model || offer.title || 'Не распознано').replace(/\s+/g, ' ').trim();
const family = productFamily;
const screen = productScreen;
const characteristics = offer => [offer.keyboard && !['unknown', 'not_applicable'].includes(offer.keyboard) ? `KB ${offer.keyboard}` : null, offer.region && offer.region !== 'unknown' ? offer.region : null].filter(Boolean).join(' · ');
const message = value => {
  $('message').textContent = value ? 'Не удалось выполнить запрос. Проверьте соединение и попробуйте ещё раз.' : '';
  $('message').hidden = !value;
  if (value) $('price-status').dataset.tone = 'warning';
};
function renderStatus() {
  if (!state.latestStatus) return;
  const summary = priceStatus(state.latestStatus, state.offers);
  if (avitoSheet) {
    const avito = state.latestStatus.avito;
    summary.title = state.latestStatus.state === 'running' ? 'Обновляем цены Авито' : 'Цены Авито';
    summary.detail = avitoStatus(avito) || 'Показываем последние сохранённые объявления.';
    summary.tone = state.latestStatus.state === 'running' ? 'loading' : avito?.state === 'ready' ? 'success' : 'warning';
    if (avito?.transport === 'apify') summary.schedule = Number.isFinite(Date.parse(avito.nextRunAt))
      ? `Следующий сбор Apify: ${new Date(avito.nextRunAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`
      : 'Новый сбор Apify пока не назначен';
  } else {
    Object.assign(summary, priceStatus({ ...state.latestStatus, avito: undefined }, state.offers));
  }
  $('status').textContent = summary.title;
  $('status-detail').textContent = summary.detail;
  $('status-schedule').textContent = summary.schedule;
  $('price-status').dataset.tone = summary.tone;
}

function trustForRetailer(retailer, analytics, colorTrust) {
  if (colorTrust) return colorTrust;
  if (!analytics?.lowTrustRetailers?.has(retailer)) return null;
  return { level: 'low', label: 'низкий', reason: analytics.lowTrustReasons.get(retailer) };
}

function configurationCell(offer, variant = false) {
  const cell = text('td', null, 'configuration-cell');
  cell.append(text('span', model(offer).replace(/\s+\d+(?:\.\d+)?["″]$/, ''), 'configuration-model'));
  const badges = text('span', null, 'configuration-badges');
  const values = [...configurationBadges(offer), variant ? variantLabel(offer) : null];
  for (const value of values.filter(Boolean)) badges.append(text('span', value, 'configuration-badge'));
  cell.append(badges);
  return cell;
}

async function api(path, body) {
  const target = path.startsWith('/api/') ? new URL(`..${path}`, import.meta.url) : path;
  const response = await fetch(target, { signal: AbortSignal.timeout(30000), method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': state.csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function track(event, properties = {}) {
  if (!state.csrf) return;
  fetch(new URL('../api/analytics', import.meta.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf },
    body: JSON.stringify({ event, path: location.pathname, properties }),
    keepalive: true,
  }).catch(() => {});
}

function safeLink(offer) {
  try {
    const url = new URL(offer.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return text('span', amount(offer), 'price');
    const link = text('a', amount(offer), 'price');
    link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.title = offer.retailer === AVITO ? `Открыть объявление «${offer.title}» · ${offer.sellerName}` : `Открыть цену ${offer.retailer} на сайте магазина`;
    return link;
  } catch { return text('span', amount(offer), 'price'); }
}

function avitoOfferNode(offer) {
  const item = text('div', null, 'avito-offer');
  const rank = offer.avitoRank;
  item.append(safeLink(offer));
  const specs = characteristics(offer);
  if (specs) item.append(text('span', specs, 'variant'));
  const labels = { high: 'высокий', medium: 'средний', low: 'низкий' };
  const procurement = rank?.comparisonKind === 'russian-procurement-gap';
  const badge = text('span', procurement ? (rank.referencePrice == null ? 'Нет цены русского закупа' : `Русский закуп: ${rubles(rank.referencePrice)}`)
    : rank ? `Доверие: ${labels[rank.level]} · ${rank.score}/100` : 'Доверие: не рассчитан', `trust-badge avito-trust-${rank?.level || 'medium'}`);
  badge.title = rank?.reasons?.join('; ') || 'Оценка сопоставимости цены, свежести и независимых предложений';
  item.append(badge);
  if(procurement && rank.deltaRub != null)item.append(text('span',`Разница после резерва: ${rubles(rank.deltaRub)}`,'variant'));
  if (rank?.level === 'low' && rank.reasons?.length) item.append(text('span', rank.reasons[0], 'avito-reason'));
  item.append(text('span', `Проверено ${date(offer.fetchedAt)}`, 'variant'));
  if (stock(offer) === 'out') item.append(text('span', 'Нет в наличии', 'tag'));
  else if (stock(offer) === 'unknown') item.append(text('span', 'Наличие неизвестно', 'tag'));
  if (Date.now() - Date.parse(offer.fetchedAt) > 4 * 3600000) item.append(text('span', 'Старая проверка', 'tag warn'));
  const audit = text('details', null, 'avito-audit');
  audit.append(text('summary', 'Почему такая оценка'));
  audit.append(text('span', offer.title, 'variant'), text('span', `${offer.sellerName} · Нижний Новгород · ${offer.condition === 'used' ? 'Б/у' : 'Новое'}`, 'variant'));
  if (rank?.position) audit.append(text('span', `Место объявления в рейтинге: ${rank.position}`, 'variant'));
  if (rank?.referencePrice) {
    const delta = (offer.price / rank.referencePrice - 1) * 100;
    audit.append(text('span', `К сравнению: ${rubles(rank.referencePrice)} · ${delta >= 0 ? '+' : ''}${number(delta)}%`, 'variant'));
  }
  if (rank?.marketPrice) audit.append(text('span', `Ориентир модели: ${rubles(rank.marketPrice)} · независимых продавцов: ${rank.independentSellers}`, 'variant'));
  if (rank?.modelRange) audit.append(text('span', `Диапазон модели: ${rubles(rank.modelRange[0])}–${rubles(rank.modelRange[1])}`, 'variant'));
  for (const reason of rank?.reasons || []) audit.append(text('span', reason, 'avito-reason'));
  item.append(audit);
  return item;
}

function renderAvitoCell(cell, items) {
  cell.classList.add('avito-cell');
  if (!items.length) {
    cell.append(text('span', '—', 'empty-cell'));
    return;
  }
  if (items[0].avitoRank?.level === 'low') cell.classList.add('low-trust-price');
  cell.append(avitoOfferNode(items[0]));
  if (items.length === 1) return;
  const details = text('details', null, 'avito-list');
  const remaining = items.length - 1;
  details.append(text('summary', `Ещё ${remaining} ${plural(remaining, ['объявление', 'объявления', 'объявлений'])} продавца`));
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.loaded) return;
    details.dataset.loaded = 'true';
    for (const offer of items.slice(1)) details.append(avitoOfferNode(offer));
  });
  cell.append(details);
}

function choiceButton(label, filter, value, active, current = false) {
  const button = text('button', null, `choice${active ? ' active' : ''}${current ? ' current' : ''}`);
  button.type = 'button'; button.dataset.filter = filter; button.dataset.value = String(value); button.setAttribute('aria-pressed', active ? 'true' : 'false');
  button.append(text('span', label));
  if (current) button.append(text('small', 'актуальный'));
  return button;
}

function renderOptions(id, filter, values, format, anyLabel = 'Любой') {
  const selected = state.filters[filter];
  const nodes = [choiceButton(anyLabel, filter, '', selected === '')];
  for (const value of [...new Set(values.filter(item => item != null && item !== '' && item !== 'unknown'))].sort((a, b) => typeof a === 'number' ? a - b : sortCollator.compare(String(a), String(b)))) {
    nodes.push(choiceButton(format(value), filter, value, String(selected) === String(value)));
  }
  $(id).replaceChildren(...nodes);
}

function familyOffers() {
  return state.offers.filter(matchesFamily);
}

function matchesFamily(offer) {
  const selected = state.filters.family;
  return selected === '*' || family(offer) === selected;
}

function renderControls() {
  for (const button of $('family-options').querySelectorAll('[data-filter="family"]')) {
    const active = state.filters.family === button.dataset.value;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  const phoneSelected = Boolean(PHONE_FAMILIES[state.filters.family]);
  if (phoneSelected) Object.assign(state.filters, { chip: '*', screen: '', ram: '' });
  $('advanced-filters').querySelector('summary').textContent = phoneSelected ? 'Уточнить память, SIM и цвет' : 'Уточнить процессор, память и цвет';
  $('chip-step').hidden = state.filters.family === null || phoneSelected;
  if (state.filters.family === null) { $('spec-step').hidden = true; return; }

  const chips = [...new Set(familyOffers().filter(offer => !isPhone(offer)).map(offer => offer.chip).filter(chip => chip && chip !== 'unknown'))].sort((a, b) => sortCollator.compare(a, b));
  const currentSet = state.filters.family === '*' ? new Set(Object.values(CURRENT_CHIPS).flatMap(set => [...set])) : (CURRENT_CHIPS[state.filters.family] || new Set());
  const current = chips.filter(chip => currentSet.has(chip));
  const older = chips.filter(chip => !currentSet.has(chip));
  $('chip-current').replaceChildren(choiceButton('Все процессоры', 'chip', '*', state.filters.chip === '*'), ...current.map(chip => choiceButton(chip, 'chip', chip, state.filters.chip === chip, true)));
  $('chip-older').replaceChildren(...older.map(chip => choiceButton(chip, 'chip', chip, state.filters.chip === chip)));
  $('chip-history').hidden = older.length === 0;
  $('chip-history').querySelector('summary').textContent = `Предыдущие поколения · ${older.length}`;
  if (older.includes(state.filters.chip)) $('chip-history').open = true;

  $('spec-step').hidden = state.filters.chip === null;
  if (state.filters.chip === null) return;
  const base = familyOffers().filter(offer => state.filters.chip === '*' || offer.chip === state.filters.chip);
  $('screen-options').parentElement.hidden = phoneSelected || !base.some(offer => screen(offer));
  $('ram-options').parentElement.hidden = phoneSelected || !base.some(offer => offer.ramGb);
  $('ssd-options').parentElement.querySelector('span').textContent = phoneSelected ? 'Объём памяти' : 'Накопитель';
  renderOptions('screen-options', 'screen', base.map(screen), value => `${value}″`);
  renderOptions('ram-options', 'ram', base.map(offer => offer.ramGb), value => `${value} GB`);
  renderOptions('ssd-options', 'ssd', base.map(offer => offer.storageGb), storage);
  $('sim-options').parentElement.hidden = !base.some(isPhone);
  const sims = [...new Set(base.filter(isPhone).map(offer => offer.simType || 'unknown'))].sort();
  $('sim-options').replaceChildren(choiceButton('Любой', 'sim', '', state.filters.sim === ''), ...sims.map(value => choiceButton(value === 'unknown' ? 'Не указан' : value, 'sim', value, state.filters.sim === value)));
  const availableColors = base.filter(validMacColor).map(offer => offer.color);
  if (state.filters.color && !availableColors.includes(state.filters.color)) state.filters.color = '';
  renderOptions('color-options', 'color', availableColors, value => value, 'Любой');
  for (const button of $('stock-options').querySelectorAll('[data-filter="stock"]')) {
    const active = state.filters.stock === button.dataset.value;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function filtered() {
  const minimum = $('min-price').value;
  const maximum = $('max-price').value;
  const selected = state.filters;
  const terms = searchTerms($('search').value);
  return state.offers.filter(offer =>
    matchesFamily(offer)
    && matchesSearch(searchIndex.get(offer) || '', terms)
    && (selected.chip === '*' || offer.chip === selected.chip)
    && (!selected.screen || String(screen(offer)) === selected.screen)
    && (!selected.ram || String(offer.ramGb) === selected.ram)
    && (!selected.ssd || String(offer.storageGb) === selected.ssd)
    && (!selected.sim || (offer.simType || 'unknown') === selected.sim)
    && (!selected.color || offer.color === selected.color)
    && (!selected.stock || stock(offer) === selected.stock)
    && (minimum === '' || offer.price >= Number(minimum))
    && (maximum === '' || offer.price <= Number(maximum))
  );
}

const retailerLabel = offer => state.telegramSources.find(source => source.retailer === offer?.retailer)?.sourceTitle || offer?.sourceTitle
  || RETAILER_GROUPS.flatMap(group => group.retailers).find(item => item.name === offer?.retailer)?.label || offer?.retailer;
function retailerGroups(offers) {
  if (avitoSheet) {
    const sellers = avitoSellerColumns(offers);
    return sellers.length ? [{ key: 'avito', label: 'НН (Авито)', retailers: sellers }] : [];
  }
  const present = new Set(offers.map(offer => offer.retailer));
  for (const source of state.telegramSources) present.add(source.retailer);
  const configured = new Set(CONFIGURED_RETAILERS);
  const channels = state.telegramSources.filter(source => !configured.has(source.retailer));
  const channelIds = new Set(channels.map(source => source.retailer));
  const other = state.retailers.filter(retailer => retailer !== AVITO && !configured.has(retailer) && !channelIds.has(retailer)).map(name => ({ name, label: name }));
  const groups = [RETAILER_GROUPS[0], RETAILER_GROUPS[2], RETAILER_GROUPS[1]].map(group => ({ ...group, retailers: group.retailers.map(item => ({ ...item, label: retailerLabel({ retailer: item.name }) || item.label })) }));
  groups[0].retailers.push(...channels.map(source => ({ name: source.retailer, label: source.sourceTitle })));
  if (other.length) groups.push({ key: 'other', label: 'Другие', retailers: other });
  const sellers = avitoSellerColumns(offers);
  if (sellers.length) groups.push({ key: 'avito', label: 'НН (Авито)', retailers: sellers });
  return groups.map(group => ({ ...group, retailers: group.retailers.filter(retailer => group.key === 'nizhny' || present.has(retailer.name)).map(retailer => ({ ...retailer, key: retailer.key || priceColumnKey({ retailer: retailer.name }) })) })).filter(group => group.retailers.length);
}

function variantLabel(offer) {
  const condition = { new: 'новый', used: 'б/у', refurbished: 'восстановленный', display: 'витринный', open_box: 'вскрытая коробка' }[offer.condition] || null;
  return [offer.color === 'unknown' ? isPhone(offer) ? 'Цвет не указан' : null : offer.color,
    offer.cpuCores && offer.gpuCores ? `CPU ${offer.cpuCores} / GPU ${offer.gpuCores}` : null,
    condition || (isPhone(offer) ? 'Состояние не указано' : null), characteristics(offer),
    isPhone(offer) && (!offer.region || offer.region === 'unknown') ? 'Регион не указан' : null,
    ...['displayType', 'bundle'].map(field => offer[field] && !['unknown', 'standard'].includes(offer[field]) ? offer[field] : null)].filter(Boolean).join(' · ');
}

function offerDetails(cell, offer, { showVariant = false, analytics, colorTrust } = {}) {
  if (offer.keyboardLocalization === 'localized') cell.append(text('span', 'Русифицированный', 'tag'));
  if (offer.warrantyYears) cell.append(text('span', `${offer.warrantyYears} года гарантии`, 'tag'));
  if (isProcurementOffer(offer)) {
    const at = offer.submittedAt || offer.fetchedAt;
    cell.append(text('span', procurementAge(offer), 'tag'));
    cell.append(text('span', `Обновляли в ${new Date(at).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })}`, 'variant'));
    cell.title = `Переслано в Telegram-бота: ${date(at)}`;
    return;
  }
  if (showVariant) cell.append(text('span', variantLabel(offer), 'variant'));
  else if (characteristics(offer)) cell.append(text('span', characteristics(offer), 'variant'));
  const trust = trustForRetailer(offer.retailer, analytics, colorTrust);
  if (trust) {
    const badge = text('span', trust.reason, 'trust-badge');
    badge.title = colorTrust
      ? `Другой цвет той же комплектации у этого продавца: ${rubles(colorTrust.comparisonPrice)}`
      : `Средний ориентир сопоставимых магазинов НН: ${rubles(analytics?.nizhnyReferenceAverage)}. Эта цена не задаёт рекомендацию продажи.`;
    cell.append(badge); cell.classList.add('low-trust-price');
  }
  if (offer.withdrawn) cell.append(text('span', 'Цена отозвана магазином', 'tag warn'));
  else if (stock(offer) === 'out') cell.append(text('span', 'Нет в наличии', 'tag'));
  else if (offer.validationStatus === 'rejected' || offer.qualityWarnings?.length) {
    const badge = text('span', 'Цена не прошла проверку', 'tag warn');
    badge.title = (offer.qualityWarnings || []).join('; '); cell.append(badge);
  } else if (!currentPrice(offer)) cell.append(text('span', 'Нужно обновить', 'tag warn'));
  else if (stock(offer) === 'unknown') cell.append(text('span', 'Наличие уточнить', 'tag'));
  if (isProcurementOffer(offer)) cell.append(text('span', procurementAge(offer), 'variant'));
  cell.title = `Проверено: ${date(offer.fetchedAt)}`;
}

function priceRow(group, priceGroups) {
  const row = text('tr', null, 'configuration-row');
  const configCell = configurationCell(group.sample);
  configCell.append(text('span', variantLabel(group.sample), 'variant'));
  row.append(configCell);
  if (!avitoSheet) {
  const procurementCell = text('td', null, 'price-cell retailer-analytics retailer-group-start');
  procurementCell.append(text('span', rubles(group.analytics.minimumProcurement), 'price'));
  if (group.analytics.procurementBenchmark) procurementCell.append(text('span', retailerLabel(group.analytics.procurementBenchmark), 'variant'));
  row.append(procurementCell);
  const averageCell = text('td', null, 'price-cell retailer-analytics');
  averageCell.append(text('span', group.analytics.averageRetail == null ? '—' : rubles(group.analytics.averageRetail), 'price'));
  if (group.analytics.retailCount) averageCell.append(text('span', `${group.analytics.retailCount} ${plural(group.analytics.retailCount, ['магазин', 'магазина', 'магазинов'])}`, 'variant'));
  row.append(averageCell);
  const difference = group.analytics.difference;
  const differenceCell = text('td', null, `price-cell retailer-analytics analytics-difference${difference == null ? '' : difference >= 0 ? ' positive' : ' negative'}`);
  differenceCell.append(text('span', difference == null ? '—' : `${difference >= 0 ? '+' : ''}${rubles(difference)}`, 'price'));
  if (group.analytics.markupPercent != null) differenceCell.append(text('span', `${difference >= 0 ? '+' : ''}${number(group.analytics.markupPercent)}% к закупке`, 'variant'));
  row.append(differenceCell);
  const recommendationCell = text('td', null, 'price-cell retailer-analytics recommended-cell');
  recommendationCell.append(text('span', group.analytics.recommendedPrice == null ? '—' : rubles(group.analytics.recommendedPrice), 'price'));
  if (group.analytics.benchmark) recommendationCell.append(text('span', `на 500 ₽ ниже ${retailerLabel(group.analytics.benchmark)}`, 'variant'));
  if (group.analytics.recommendedPrice != null && group.analytics.minimumProcurement != null && group.analytics.recommendedPrice <= group.analytics.minimumProcurement) recommendationCell.append(text('span', 'Не выше минимальной закупки', 'tag warn'));
  row.append(recommendationCell);
  }
  const byColumn = priceGroups.length ? groupOffersByPriceColumn(group.offers) : new Map();
  for (const retailerGroup of priceGroups) for (const [index, retailer] of retailerGroup.retailers.entries()) {
    const cell = text('td', null, `price-cell retailer-${retailerGroup.key}${index === 0 ? ' retailer-group-start' : ''}`);
    const items = byColumn.get(retailer.key) || [];
    if (retailer.name === AVITO) {
      cell.dataset.sellerId = retailer.sellerId; renderAvitoCell(cell, items);
    } else if (!items.length) cell.append(text('span', '—', 'empty-cell'));
    else {
      const first = items.find(offer => currentPrice(offer)) || items[0];
      cell.append(safeLink(first));
      offerDetails(cell, first, { analytics: group.analytics, colorTrust: group.lowTrust.get(first.retailer) });
      if (retailerGroup.key === 'nizhny' && currentPrice(first) && first.price === group.analytics.minimumRetail && group.analytics.retailCount > 1) {
        cell.classList.add('lowest-retail-price');
        cell.append(text('span', 'Минимум в НН', 'variant'));
      }
    }
    row.append(cell);
  }
  return row;
}

// The model and price calculations always include all sources. Only presentation changes.
function renderColumnControls(priceGroups) {
  const headings = [...$('head').querySelector('.retailer-headings').children];
  const groups = [...(avitoSheet ? [] : [{ key: 'analytics', label: 'Ритейл-аналитика', retailers: ['minimum', 'average', 'difference', 'recommendation'].map((key, i) => ({ key: `analytics:${key}`, label: headings[i].textContent })) }]), ...priceGroups];
  const columns = groups.flatMap(group => group.retailers.map(column => ({ ...column, group: group.key })));
  const groupHeadings = [...$('head').querySelector('.column-groups').children].slice(1);
  const rows = [...$('rows').children];
  const controls = $('column-controls');
  const menuOpen = controls.querySelector('details')?.open || false;
  const buttons = text('div', null, 'column-group-buttons');
  const menu = text('details', null, 'column-menu'); menu.open = menuOpen;
  menu.append(text('summary', 'Столбцы'));
  const options = text('div', null, 'column-options');
  const groupButtons = [], checkboxes = [];
  const apply = () => {
    const visible = columns.map(column => !hiddenGroups.has(column.group) && !hiddenColumns.has(column.key));
    headings.forEach((heading, i) => { heading.hidden = !visible[i]; });
    rows.forEach(row => { columns.forEach((column, i) => { row.children[i + 1].hidden = !visible[i]; }); });
    groups.forEach((group, i) => {
      const count = columns.filter((column, j) => column.group === group.key && visible[j]).length;
      groupHeadings[i].hidden = !count; groupHeadings[i].colSpan = Math.max(1, count);
      groupButtons[i].textContent = `${count ? '−' : '+'} ${group.label} · ${count}/${group.retailers.length}`;
      groupButtons[i].setAttribute('aria-expanded', String(count > 0));
      groupButtons[i].title = `${count ? 'Свернуть' : 'Развернуть'} группу «${group.label}»`;
    });
    checkboxes.forEach((input, i) => { input.checked = visible[i]; });
    $('avito-jump').hidden = !columns.some((column, i) => column.group === 'avito' && visible[i]);
    reset.disabled = !hiddenGroups.size && !hiddenColumns.size;
  };
  for (const group of groups) {
    const button = text('button', '', 'column-group-toggle'); button.type = 'button';
    button.addEventListener('click', () => {
      const shown = !hiddenGroups.has(group.key) && group.retailers.some(column => !hiddenColumns.has(column.key));
      if (shown) hiddenGroups.add(group.key);
      else {
        hiddenGroups.delete(group.key);
        if (group.retailers.every(column => hiddenColumns.has(column.key))) group.retailers.forEach(column => hiddenColumns.delete(column.key));
      }
      saveColumns(); apply();
    });
    buttons.append(button); groupButtons.push(button);
    const fieldset = text('fieldset'); fieldset.append(text('legend', group.label));
    for (const column of group.retailers) {
      const label = text('label'); const input = document.createElement('input'); input.type = 'checkbox';
      input.addEventListener('change', () => {
        if (input.checked) { hiddenGroups.delete(group.key); hiddenColumns.delete(column.key); }
        else hiddenColumns.add(column.key);
        saveColumns(); apply();
      });
      label.append(input, document.createTextNode(column.label + (column.profileLabel ? ` · ${column.profileLabel}` : '')));
      fieldset.append(label); checkboxes.push(input);
    }
    options.append(fieldset);
  }
  headings.forEach((heading, i) => {
    const button = text('button', '−', 'column-collapse'); button.type = 'button';
    button.title = `Свернуть столбец «${columns[i].label}»`; button.setAttribute('aria-label', button.title);
    button.addEventListener('click', () => { hiddenColumns.add(columns[i].key); saveColumns(); apply(); groupButtons[groups.findIndex(group => group.key === columns[i].group)].focus({ preventScroll: true }); });
    heading.append(button);
  });
  const reset = text('button', 'Показать все', 'secondary'); reset.type = 'button';
  reset.addEventListener('click', () => { hiddenGroups.clear(); hiddenColumns.clear(); saveColumns(); apply(); });
  menu.append(options); controls.replaceChildren(buttons, menu, reset); apply();
}

function render({ keepPage = false } = {}) {
  if (!keepPage) state.page = 1;
  saveView(); renderActiveFilters();
  const ready = state.filters.family !== null && state.filters.chip !== null;
  $('sort').disabled = !ready; $('export').disabled = !ready;
  $('selection-prompt').hidden = ready;
  for (const id of ['table-wrap', 'table-meta', 'column-controls']) $(id).hidden = !ready;
  $('pagination').hidden = true;
  $('search-overview').hidden = true;
  if (!ready) { $('rows').replaceChildren(); $('head').replaceChildren(); $('empty').hidden = true; return; }
  const queryKey = JSON.stringify([state.filters, $('search').value, $('min-price').value, $('max-price').value, Math.floor(Date.now() / 60000)]);
  if (state.tableModel?.key !== queryKey) {
    const offers = filtered();
    const groups = buildPriceTable(offers, { contextOffers: state.offers });
    const terms = searchTerms($('search').value);
    for (const group of groups) group.searchScore = Math.max(...group.offers.map(offer => searchScore(searchIndex.get(offer) || '', terms)));
    state.tableModel = { key: queryKey, offers, groups };
  }
  const { groups, offers } = state.tableModel;
  if ($('search').value.trim() && groups.length) {
    $('search-overview').textContent = searchOverview(groups);
    $('search-overview').hidden = false;
  }
  const page = selectTablePage(groups, { sort: $('sort').value, page: state.page });
  state.page = page.page; state.pageCount = page.pages;
  const priceGroups = retailerGroups(page.allRows.flatMap(group => group.offers));
  const avitoColumns = priceGroups.find(group => group.key === 'avito')?.retailers || [];
  $('avito-jump').hidden = !avitoColumns.length;
  const groupHeading = text('tr', null, 'column-groups');
  const modelHeading = text('th', 'Конфигурация и цвет', 'model-heading');
  modelHeading.rowSpan = 2; modelHeading.scope = 'col'; groupHeading.append(modelHeading);
  const retailerHeading = text('tr', null, 'retailer-headings');
  if (!avitoSheet) {
  const analyticsHeading = text('th', 'Ритейл-аналитика', 'retailer-group-heading retailer-group-analytics');
  analyticsHeading.colSpan = 4; analyticsHeading.scope = 'colgroup'; groupHeading.append(analyticsHeading);
  for (const [label, title] of [
    ['Мин. закупка', 'Минимальная свежая закупочная цена для этой конфигурации и цвета'],
    ['Средняя по НН', 'Среднее свежих цен магазинов НН в этой строке, по одной цене на магазин'],
    ['Разница', 'Средняя по НН минус минимальная закупка; процент рассчитан относительно закупки'],
    ['Рекомендация продажи', 'На 500 ₽ ниже минимальной сопоставимой цены доверенного магазина НН'],
  ]) {
    const heading = text('th', label, 'retailer-heading retailer-analytics');
    heading.scope = 'col'; heading.title = title; retailerHeading.append(heading);
  }
  }
  for (const group of priceGroups) {
    const cell = text('th', group.label, `retailer-group-heading retailer-group-${group.key}`);
    cell.colSpan = group.retailers.length; cell.scope = 'colgroup'; groupHeading.append(cell);
  }
  for (const group of priceGroups) for (const [index, retailer] of group.retailers.entries()) {
    const cell = text('th', null, `retailer-heading retailer-${group.key}${index === 0 ? ' retailer-group-start' : ''}`);
    cell.append(text('span', retailer.label)); cell.scope = 'col';
    const channel = state.telegramSources.find(source => source.retailer === retailer.name);
    if (retailer.name !== AVITO) {
      const count = state.offers.filter(offer => offer.retailer === retailer.name).length;
      cell.append(text('span', channel && !count ? 'Прайс получен · пока нет распознанных цен' : `${count} цен`, 'variant'));
    }
    if (channel) {
      cell.title = `Telegram · ${channel.sourceUsername ? '@' + channel.sourceUsername : channel.sourceChatId}`;
      if (state.telegramSources.filter(source => source.sourceTitle === channel.sourceTitle).length > 1) cell.append(text('span', channel.sourceUsername ? '@' + channel.sourceUsername : channel.sourceChatId, 'variant'));
    }
    if (retailer.name === AVITO) {
      cell.dataset.sellerId = retailer.sellerId; cell.title = `Профиль Авито: ${retailer.sellerId}`;
      if (retailer.profileLabel) cell.append(text('span', retailer.profileLabel, 'variant'));
      if (retailer.matchedRetailer) cell.append(text('span', `Сайт: ${retailer.matchedRetailer}`, 'variant'));
    }
    retailerHeading.append(cell);
  }
  $('head').replaceChildren(groupHeading, retailerHeading);
  $('count').textContent = `${page.total} ${plural(page.total, ['конфигурация', 'конфигурации', 'конфигураций'])} · ${page.offerCount} ${plural(page.offerCount, ['предложение', 'предложения', 'предложений'])}`;
  const fragment = document.createDocumentFragment();
  for (const group of page.rows) {
    fragment.append(priceRow(group, priceGroups));
  }
  $('rows').replaceChildren(fragment);
  renderColumnControls(priceGroups);
  $('empty').hidden = page.total > 0;
  $('table-wrap').hidden = !page.total;
  $('pagination').hidden = page.pages <= 1;
  $('page-prev').disabled = page.page === 1; $('page-next').disabled = page.page === page.pages;
  $('page-info').textContent = `${(page.page - 1) * TABLE_PAGE_SIZE + 1}–${Math.min(page.total, page.page * TABLE_PAGE_SIZE)} из ${page.total} · страница ${page.page} / ${page.pages}`;
}

function procurementAge(offer) {
  const source = offer.submittedAt || offer.fetchedAt;
  if (!source || !Number.isFinite(Date.parse(source))) return 'Дата прайса неизвестна';
  const day = value => moscowDay.format(new Date(value));
  const sourceDay = /^\d{4}-\d{2}-\d{2}$/.test(source) ? source : day(source);
  if (sourceDay === day(Date.now())) return 'Сегодняшний ценник';
  if (sourceDay === day(Date.now() - 86400000)) return 'Вчерашний ценник';
  return `Прайс от ${new Date(sourceDay + 'T12:00:00Z').toLocaleDateString('ru-RU')}`;
}

function resetSpecs() { Object.assign(state.filters, { screen: '', ram: '', ssd: '', color: '', sim: '', stock: '' }); $('min-price').value = ''; $('max-price').value = ''; }

function renderActiveFilters() {
  const labels = { family: { air: 'MacBook Air', pro: 'MacBook Pro', neo: 'MacBook Neo', mini: 'Mac mini', studio: 'Mac Studio', imac: 'iMac', ...PHONE_FAMILIES }, sim: { unknown: 'SIM не указан' }, stock: { in: 'В наличии', out: 'Нет в наличии' } };
  const nodes = [];
  const add = (label, clear) => {
    const button = text('button', `${label} ×`, 'filter-tag'); button.type = 'button';
    button.setAttribute('aria-label', `Убрать фильтр: ${label}`);
    button.addEventListener('click', () => { clear(); renderControls(); render(); });
    nodes.push(button);
  };
  for (const [key, value] of Object.entries(state.filters)) {
    if (value == null || value === '' || value === '*') continue;
    const label = labels[key]?.[value] || (key === 'ram' ? `${value} GB RAM` : key === 'ssd' ? `${PHONE_FAMILIES[state.filters.family] ? '' : 'SSD '}${storage(Number(value))}` : key === 'screen' ? `${value}″` : value);
    add(label, () => {
      if (key === 'family') { state.filters.family = '*'; state.filters.chip = '*'; resetSpecs(); }
      else if (key === 'chip') { state.filters.chip = '*'; resetSpecs(); }
      else state.filters[key] = '';
    });
  }
  if ($('search').value) add(`Поиск: ${$('search').value}`, () => { $('search').value = ''; });
  for (const [id, label] of [['min-price', 'От'], ['max-price', 'До']]) if ($(id).value) add(`${label} ${rubles(Number($(id).value))}`, () => { $(id).value = ''; });
  $('active-filters').replaceChildren(...nodes); $('active-filters').hidden = !nodes.length;
  $('clear-search').hidden = !$('search').value;
}

let reloadPending;
function updateOffers(market) {
  market = sheetOffers(market, avitoSheet ? 'avito' : 'retail');
  state.offers = prepareTableOffers(market);
  state.tableModel = null;
  for (const offer of state.offers) searchIndex.set(offer, offerSearchText(offer));
  state.rankedAtMinute = Math.floor(Date.now() / 60000);
  const discovered = [...new Set(market.map(offer => offer.retailer))];
  state.retailers = [...CONFIGURED_RETAILERS, ...discovered.filter(retailer => !CONFIGURED_RETAILERS.includes(retailer)).sort(sortCollator.compare)];
  renderControls(); render({ keepPage: true }); renderStatus();
}
function reload() {
  if (reloadPending) return reloadPending;
  reloadPending = fetch(new URL(`../api/table?sheet=${avitoSheet ? 'avito' : 'retail'}`, import.meta.url), {
    signal: AbortSignal.timeout(30000), headers: state.tableEtag ? { 'if-none-match': state.tableEtag } : {},
  }).then(async response => {
    state.rankedAtMinute = Math.floor(Date.now() / 60000);
    if (response.status === 304) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const etag = response.headers.get('etag');
    if (etag && etag === state.tableEtag) return;
    const data = await response.json();
    state.telegramSources = data.telegramSources || [];
    updateOffers(data.offers); state.tableEtag = etag;
  }).finally(() => { reloadPending = null; });
  return reloadPending;
}

async function poll(reloadOnChange = true) {
  const status = await api('/api/status'); const running = status.state === 'running';
  state.latestStatus = status;
  renderStatus();
  $('refresh').disabled = !state.csrf || running || state.refreshPending;
  $('refresh').textContent = running || state.refreshPending ? 'Обновляем цены…' : 'Обновить цены';
  message('');
  const rankingExpired = state.offers.some(o => o.retailer === AVITO) && state.rankedAtMinute !== Math.floor(Date.now() / 60000);
  if (reloadOnChange && !running && (rankingExpired || state.wasRunning || (status.updatedAt && state.updatedAt !== status.updatedAt))) await reload();
  state.wasRunning = running; state.updatedAt = status.updatedAt;
  const minute = Math.floor(Date.now() / 60000);
  if (state.ready && state.analyticsMinute !== minute) { render({ keepPage: true }); state.analyticsMinute = minute; }
}

let pollTimer;
let pollPending = false;
async function pollLoop() {
  if (pollPending) return;
  clearTimeout(pollTimer);
  if (document.hidden) return;
  pollPending = true;
  try { await poll(); } catch (error) { message(error.message); }
  finally {
    pollPending = false;
    if (!document.hidden) pollTimer = setTimeout(pollLoop, state.wasRunning ? 5000 : 30000);
  }
}
document.addEventListener('visibilitychange', () => {
  clearTimeout(pollTimer);
  if (!document.hidden && state.ready) void pollLoop();
});

$('refresh').addEventListener('click', async () => {
  if (state.refreshPending || state.wasRunning) return;
  state.refreshPending = true;
  $('refresh').disabled = true;
  $('refresh').textContent = 'Обновляем цены…';
  try {
    await api('/api/refresh', avitoSheet ? { retailer: AVITO } : {});
    state.wasRunning = true;
    await poll();
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollLoop, 1000);
  } catch (error) { message(error.message); }
  finally {
    state.refreshPending = false;
    $('refresh').disabled = !state.csrf || state.wasRunning;
    $('refresh').textContent = state.wasRunning ? 'Обновляем цены…' : 'Обновить цены';
  }
});

$('filters').addEventListener('click', event => {
  const button = event.target.closest('button[data-filter]'); if (!button) return;
  const filter = button.dataset.filter, value = button.dataset.value;
  if (filter === 'family') { state.filters.family = value; state.filters.chip = '*'; resetSpecs(); }
  else if (filter === 'chip') { state.filters.chip = value; resetSpecs(); }
  else state.filters[filter] = value;
  renderControls(); render();
  track('filter_change', { filter, value });
});
$('min-price').addEventListener('input', render); $('max-price').addEventListener('input', render); $('sort').addEventListener('change', render);
for (const [id, direction] of [['page-prev', -1], ['page-next', 1]]) $(id).addEventListener('click', () => {
  state.page += direction; render({ keepPage: true }); $('table-wrap').scrollTop = 0;
});
let searchTimer;
$('search').addEventListener('input', () => {
  if (state.filters.family === null && $('search').value.trim()) { state.filters.family = '*'; state.filters.chip = '*'; renderControls(); }
  if ($('search').value.trim()) $('sort').value = 'relevance';
  clearTimeout(searchTimer); searchTimer = setTimeout(render, 150);
});
$('clear-search').addEventListener('click', () => { $('search').value = ''; render(); $('search').focus(); });
$('clear-specs').addEventListener('click', () => { resetSpecs(); state.filters.chip = '*'; $('search').value = ''; renderControls(); render(); });
window.addEventListener('hashchange', () => { restoreView(); renderControls(); render(); });
$('avito-jump').addEventListener('click', () => {
  const target = $('head').querySelector('.retailer-heading.retailer-avito:not([hidden])');
  if (!target) return;
  const wrap = $('table-wrap');
  const modelWidth = $('head').querySelector('.model-heading').getBoundingClientRect().width;
  const left = wrap.scrollLeft + target.getBoundingClientRect().left - wrap.getBoundingClientRect().left - modelWidth - 1;
  wrap.scrollTo({ left, behavior: 'smooth' });
  wrap.focus({ preventScroll: true });
});
$('reset').addEventListener('click', () => { state.filters = emptyFilters(); $('search').value = ''; $('sort').value = 'model'; resetSpecs(); renderControls(); render(); track('filter_reset'); });
$('export').addEventListener('click', async () => {
  const button = $('export');
  button.disabled = true;
  const selected = state.tableModel ? selectTablePage(state.tableModel.groups).allRows.flatMap(group => group.offers) : filtered();
  const filters = { ...state.filters, query: $('search').value, minPrice: $('min-price').value, maxPrice: $('max-price').value };
  try {
    let offers = selected;
    if (selected.length) {
      const ids = new Set(selected.map(offer => offer.listingId));
      const full = await api('/api/master');
      offers = full.rows.flatMap(row => row.offers).filter(offer => ids.has(offer.listingId) && offer.visibility !== 'private');
    }
    const value = { generatedAt: new Date().toISOString(), filters, offers };
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = text('a'); link.href = url; link.download = `prices-${new Date().toISOString().slice(0, 10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); track('export');
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
async function init() {
  document.body.classList.add('is-loading');
  $('filters').setAttribute('aria-busy', 'true');
  try {
    const config = await api('./public-config.json');
    if (config.mode === 'public') {
      const data = await api('../data/public-prices.json'); $('filters').hidden = true; $('table-meta').hidden = false; $('sort').parentElement.hidden = true; $('export').hidden = true; $('selection-prompt').hidden = true; $('table-wrap').hidden = false;
      $('head').append(text('tr')); for (const name of ['Товар', 'Цена', 'Город']) $('head').firstChild.append(text('th', name));
      for (const price of data.prices) { if (Date.parse(price.validUntil) <= Date.now()) continue; const row = text('tr'); for (const value of [price.title, `${number(price.priceMinor / 100)} ₽`, price.city]) row.append(text('td', value)); $('rows').append(row); }
      $('status').textContent = `Выгрузка: ${date(data.generatedAt)}`; $('status-detail').textContent = 'Опубликованные цены каталога.'; $('price-status').dataset.tone = 'success'; $('count').textContent = 'Публичный каталог'; $('empty').hidden = !!$('rows').children.length; return;
    }
    const sessionTask = api('/api/session').then(session => { state.csrf = session.csrfToken; $('refresh').hidden = false; $('refresh').disabled = state.wasRunning; track('page_view'); });
    const results = await Promise.allSettled([reload(), poll(false), sessionTask]);
    state.ready = true;
    pollTimer = setTimeout(pollLoop, state.wasRunning ? 5000 : 30000);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  } catch (error) { $('status').textContent = 'Не удалось загрузить цены'; message(error.message); }
  finally { document.body.classList.remove('is-loading'); $('filters').removeAttribute('aria-busy'); }
}
restoreView();
if (!location.hash) { state.filters.family = '*'; state.filters.chip = '*'; $('sort').value = 'coverage'; }
init();
