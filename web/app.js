import { calculateRetailAnalytics, RETAILER_TRUST } from './retail-analytics.js';

const $ = id => document.getElementById(id);
const state = {
  offers: [], retailers: [], csrf: '', wasRunning: false,
  filters: { family: 'desktops', chip: '*', screen: '', ram: '', ssd: '', color: '', stock: '' },
};
const CURRENT_CHIPS = {
  desktops: new Set(['M6', 'M5 Pro', 'M5 Max', 'M5 Ultra']),
  mini: new Set(['M6', 'M5 Pro']),
  studio: new Set(['M5 Max', 'M5 Ultra']),
  air: new Set(['M5']),
  pro: new Set(['M5', 'M5 Pro', 'M5 Max']),
  neo: new Set(['A18 Pro']),
  imac: new Set(['M4']),
};
const RETAILER_GROUPS = [
  { key: 'procurement', label: 'Закупка', retailers: [{ name: 'Дима', label: 'Дима' }, { name: 'BSA', label: 'BSA' }] },
  { key: 'moscow', label: 'МСК / РФ', retailers: [{ name: 'BigGeek', label: 'BigGeek' }, { name: 'RifaStore', label: 'Rifa' }] },
  { key: 'nizhny', label: 'НН', retailers: [{ name: 'Айфория', label: 'Айфория' }, { name: 'Technichno', label: 'Технично' }, { name: 'iMobile', label: 'iMobile' }, { name: 'ReSale', label: 'ReSale' }, { name: 'Apple Store', label: 'Apple Store' }, { name: 'Rebro', label: 'Rebro' }] },
];
const CONFIGURED_RETAILERS = RETAILER_GROUPS.flatMap(group => group.retailers.map(retailer => retailer.name));
const text = (tag, value, cls) => { const node = document.createElement(tag); if (value != null) node.textContent = String(value); if (cls) node.className = cls; return node; };
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU') : 'Дата не указана';
const number = value => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const plural = (n, forms) => forms[n % 100 >= 11 && n % 100 <= 14 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2];
const storage = value => value >= 1024 && value % 1024 === 0 ? `${value / 1024} TB` : value >= 1000 && value % 1000 === 0 ? `${value / 1000} TB` : value ? `${value} GB` : '—';
const amount = offer => `${number(offer.price)} ₽`;
const rubles = value => Number.isFinite(value) ? `${number(value)} ₽` : '—';
const stock = offer => ['InStock', 'confirmed', 'source_reported'].includes(offer.stock) ? 'in' : ['OutOfStock', 'Discontinued', 'SoldOut'].includes(offer.stock) ? 'out' : 'unknown';
const compareOffers = (a, b) => a.price - b.price || String(a.url).localeCompare(String(b.url));
const model = offer => String(offer.model || offer.title || 'Не распознано').replace(/\s+/g, ' ').trim();
const family = offer => /^Mac mini/i.test(model(offer)) ? 'mini' : /^Mac Studio/i.test(model(offer)) ? 'studio' : /MacBook\s+Air/i.test(model(offer)) ? 'air' : /MacBook\s+Pro/i.test(model(offer)) ? 'pro' : /MacBook\s+Neo/i.test(model(offer)) ? 'neo' : /^iMac\b/i.test(model(offer)) ? 'imac' : 'other';
const screen = offer => offer.screenIn || Number(model(offer).match(/\b(13|14|15|16|24|27)\b/)?.[1]) || null;
const key = offer => [model(offer), offer.chip, offer.ramGb, offer.storageGb, offer.color].join('|');
const characteristics = offer => [offer.cpuCores ? `CPU ${offer.cpuCores}` : null, offer.gpuCores ? `GPU ${offer.gpuCores}` : null, offer.keyboard && offer.keyboard !== 'unknown' ? `KB ${offer.keyboard}` : null, offer.region && offer.region !== 'unknown' ? offer.region : null].filter(Boolean).join(' · ');
const message = value => { $('message').textContent = value; $('message').hidden = !value; };

async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': state.csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function track(event, properties = {}) {
  if (!state.csrf) return;
  fetch('/api/analytics', {
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
    link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = `Открыть цену ${offer.retailer} на сайте магазина`;
    return link;
  } catch { return text('span', amount(offer), 'price'); }
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
  for (const value of [...new Set(values.filter(item => item != null && item !== '' && item !== 'unknown'))].sort((a, b) => typeof a === 'number' ? a - b : String(a).localeCompare(String(b), 'ru', { numeric: true }))) {
    nodes.push(choiceButton(format(value), filter, value, String(selected) === String(value)));
  }
  $(id).replaceChildren(...nodes);
}

function familyOffers() {
  return state.offers.filter(matchesFamily);
}

function matchesFamily(offer) {
  const selected = state.filters.family;
  return selected === 'desktops' ? offer.desktop === true : selected === '*' ? !offer.desktop : ['mini', 'studio'].includes(selected) ? offer.desktop === true && family(offer) === selected : family(offer) === selected;
}

function renderControls() {
  for (const button of $('family-options').querySelectorAll('[data-filter="family"]')) {
    const active = state.filters.family === button.dataset.value;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  $('chip-step').hidden = state.filters.family === null;
  if (state.filters.family === null) { $('spec-step').hidden = true; return; }

  const chips = [...new Set(familyOffers().map(offer => offer.chip).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
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
  const desktop = ['desktops', 'mini', 'studio'].includes(state.filters.family);
  for (const id of ['screen-options', 'color-options', 'stock-options']) $(id).parentElement.hidden = desktop;
  $('min-price').placeholder = $('max-price').placeholder = desktop ? '$' : '₽';
  renderOptions('screen-options', 'screen', base.map(screen), value => `${value}″`);
  renderOptions('ram-options', 'ram', base.map(offer => offer.ramGb), value => `${value} GB`);
  renderOptions('ssd-options', 'ssd', base.map(offer => offer.storageGb), storage);
  renderOptions('color-options', 'color', base.map(offer => offer.color), value => value, 'Любой');
  for (const button of $('stock-options').querySelectorAll('[data-filter="stock"]')) {
    const active = state.filters.stock === button.dataset.value;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function filtered() {
  const minimum = $('min-price').value;
  const maximum = $('max-price').value;
  const selected = state.filters;
  return state.offers.filter(offer =>
    matchesFamily(offer)
    && (selected.chip === '*' || offer.chip === selected.chip)
    && (!selected.screen || String(screen(offer)) === selected.screen)
    && (!selected.ram || String(offer.ramGb) === selected.ram)
    && (!selected.ssd || String(offer.storageGb) === selected.ssd)
    && (!selected.color || offer.color === selected.color)
    && (!selected.stock || stock(offer) === selected.stock)
    && (minimum === '' || offer.price >= Number(minimum))
    && (maximum === '' || offer.price <= Number(maximum))
  );
}

function retailerGroups() {
  const configured = new Set(CONFIGURED_RETAILERS);
  const other = state.retailers.filter(retailer => !configured.has(retailer)).map(name => ({ name, label: name }));
  return other.length ? [...RETAILER_GROUPS, { key: 'other', label: 'Другие', retailers: other }] : RETAILER_GROUPS;
}

function render() {
  const ready = state.filters.family !== null && state.filters.chip !== null;
  $('sort').disabled = !ready; $('export').disabled = !ready;
  $('selection-prompt').hidden = ready;
  $('table-wrap').hidden = !ready;
  if (!ready) {
    $('rows').replaceChildren(); $('head').replaceChildren(); $('empty').hidden = true;
    $('selection-prompt').textContent = state.filters.family === null ? 'Выберите модель, затем процессор — после этого покажем подходящие цены.' : 'Теперь выберите процессор. Актуальная линейка показана первой.';
    $('count').textContent = state.filters.family === null ? 'Начните с модели' : 'Модель выбрана';
    return;
  }

  const offers = filtered();
  const desktop = ['desktops', 'mini', 'studio'].includes(state.filters.family);
  $('desktop-note').hidden = !desktop;
  $('footer-note').textContent = desktop ? 'Показаны исходные суммы из Excel. Для цены в рублях откройте сайт заказов.' : 'В ячейке — цена на сайте магазина. Нажмите на ценник, чтобы открыть страницу товара.';
  $('analytics-method').hidden = desktop;
  if (desktop) { renderDesktop(offers); return; }
  const groups = new Map();
  for (const offer of offers) { const id = key(offer); if (!groups.has(id)) groups.set(id, { sample: offer, offers: [] }); groups.get(id).offers.push(offer); }
  const groupsSorted = [...groups.values()].sort((a, b) => {
    const mode = $('sort').value;
    const priceA = Math.min(...a.offers.map(offer => offer.price), Infinity), priceB = Math.min(...b.offers.map(offer => offer.price), Infinity);
    return mode === 'price-up' ? priceA - priceB : mode === 'price-down' ? priceB - priceA : mode === 'fresh' ? Math.max(...b.offers.map(offer => Date.parse(offer.fetchedAt) || 0)) - Math.max(...a.offers.map(offer => Date.parse(offer.fetchedAt) || 0)) : key(a.sample).localeCompare(key(b.sample), 'ru', { numeric: true });
  });
  const priceGroups = retailerGroups();
  const groupHeading = text('tr', null, 'column-groups');
  for (const name of ['Модель', 'Чип', 'RAM', 'SSD', 'Цвет']) {
    const cell = text('th', name, name === 'Модель' ? 'model-heading' : null);
    cell.rowSpan = 2; cell.scope = 'col'; groupHeading.append(cell);
  }
  const bestHeading = text('th', 'Лучшая цена', 'best-price-heading');
  bestHeading.rowSpan = 2; bestHeading.scope = 'col'; groupHeading.append(bestHeading);
  const analyticsHeading = text('th', 'Ритейл-аналитика', 'retailer-group-heading retailer-group-analytics');
  analyticsHeading.colSpan = 4; analyticsHeading.scope = 'colgroup'; groupHeading.append(analyticsHeading);
  for (const group of priceGroups) {
    const cell = text('th', group.label, `retailer-group-heading retailer-group-${group.key}`);
    cell.colSpan = group.retailers.length; cell.scope = 'colgroup'; groupHeading.append(cell);
  }
  const retailerHeading = text('tr', null, 'retailer-headings');
  for (const [label, extraClass] of [['Средняя закупка', ''], ['Средняя цена НН', ''], ['Средняя разница', ''], ['Рекоменд. цена', ' recommended-heading']]) {
    const cell = text('th', label, `retailer-heading retailer-analytics${extraClass}`); cell.scope = 'col'; retailerHeading.append(cell);
  }
  for (const group of priceGroups) {
    for (const [index, retailer] of group.retailers.entries()) {
      const cell = text('th', null, `retailer-heading retailer-${group.key}${index === 0 ? ' retailer-group-start' : ''}`);
      cell.append(text('span', retailer.label));
      const trust = RETAILER_TRUST[retailer.name];
      if (trust) { const badge = text('span', `Trust: ${trust.label}`, 'trust-badge'); badge.title = trust.reason; cell.append(badge); }
      cell.scope = 'col'; retailerHeading.append(cell);
    }
  }
  $('head').replaceChildren(groupHeading, retailerHeading);
  const fragment = document.createDocumentFragment();
  for (const group of groupsSorted) {
    const row = text('tr'), sample = group.sample;
    for (const value of [model(sample), sample.chip || '—', sample.ramGb ? `${sample.ramGb} GB` : '—', storage(sample.storageGb), sample.color && sample.color !== 'unknown' ? sample.color : '—']) row.append(text('td', value));
    const displayed = new Map();
    for (const retailerGroup of priceGroups) for (const retailer of retailerGroup.retailers) {
      const items = group.offers.filter(offer => offer.retailer === retailer.name).sort(compareOffers);
      displayed.set(retailer.name, { items, first: items[0] });
    }
    const bestCell = text('td', null, 'price-cell best-price-cell');
    const best = [...displayed.values()].map(item => item.first).filter(Boolean).sort(compareOffers)[0];
    if (!best) bestCell.append(text('span', '—', 'empty-cell'));
    else {
      bestCell.append(safeLink(best), text('span', best.retailer, 'variant'));
      if (stock(best) === 'out') bestCell.append(text('span', 'Нет в наличии', 'tag'));
      else if (['Дима', 'BSA'].includes(best.retailer)) bestCell.append(text('span', procurementAge(best), 'tag'));
      else if (Date.now() - Date.parse(best.fetchedAt) > 4 * 3600000) bestCell.append(text('span', 'Старая проверка', 'tag warn'));
    }
    row.append(bestCell);
    const analytics = calculateRetailAnalytics(group.offers);
    const procurementCell = text('td', null, 'analytics-cell retailer-analytics');
    procurementCell.append(text('span', rubles(analytics.averageProcurement), analytics.averageProcurement == null ? 'empty-cell' : 'price'));
    if (analytics.procurementCount) procurementCell.append(text('span', `${analytics.procurementCount} ${plural(analytics.procurementCount, ['источник', 'источника', 'источников'])}`, 'variant'));
    row.append(procurementCell);
    const retailCell = text('td', null, 'analytics-cell retailer-analytics');
    retailCell.append(text('span', rubles(analytics.averageRetail), analytics.averageRetail == null ? 'empty-cell' : 'price'));
    if (analytics.retailCount) retailCell.append(text('span', `${analytics.retailCount} ${plural(analytics.retailCount, ['магазин', 'магазина', 'магазинов'])}`, 'variant'));
    row.append(retailCell);
    const differenceClass = analytics.averageDifference == null ? '' : analytics.averageDifference >= 0 ? ' positive' : ' negative';
    const differenceCell = text('td', null, `analytics-cell retailer-analytics analytics-difference${differenceClass}`);
    const differenceText = analytics.averageDifference == null ? '—' : `${analytics.averageDifference >= 0 ? '+' : ''}${rubles(analytics.averageDifference)}`;
    differenceCell.append(text('span', differenceText, analytics.averageDifference == null ? 'empty-cell' : 'price'));
    if (analytics.averageMarkupPercent != null) differenceCell.append(text('span', `${analytics.averageMarkupPercent >= 0 ? '+' : ''}${number(analytics.averageMarkupPercent)}%`, 'variant'));
    row.append(differenceCell);
    const recommendedCell = text('td', null, 'analytics-cell retailer-analytics recommended-cell');
    recommendedCell.append(text('span', rubles(analytics.recommendedPrice), analytics.recommendedPrice == null ? 'empty-cell' : 'price'));
    if (analytics.benchmark) recommendedCell.append(text('span', `на 500 ₽ ниже ${analytics.benchmark.retailer}`, 'variant'));
    if (analytics.recommendedPrice != null && analytics.averageProcurement != null && analytics.recommendedPrice <= analytics.averageProcurement) recommendedCell.append(text('span', 'Ниже средней закупки', 'tag warn'));
    row.append(recommendedCell);
    for (const retailerGroup of priceGroups) for (const [index, retailer] of retailerGroup.retailers.entries()) {
      const cell = text('td', null, `price-cell retailer-${retailerGroup.key}${index === 0 ? ' retailer-group-start' : ''}`);
      const { items, first } = displayed.get(retailer.name);
      if (!items.length) cell.append(text('span', '—', 'empty-cell'));
      else {
        cell.append(safeLink(first));
        const details = characteristics(first); if (details) cell.append(text('span', details, 'variant'));
        const trust = RETAILER_TRUST[retailer.name]; if (trust) { const badge = text('span', `Trust: ${trust.label}`, 'trust-badge'); badge.title = trust.reason; cell.append(badge); }
        if (stock(first) === 'out') cell.append(text('span', 'Нет в наличии', 'tag')); else if (retailerGroup.key === 'procurement') cell.append(text('span', procurementAge(first), 'tag')); else if (Date.now() - Date.parse(first.fetchedAt) > 4 * 3600000) cell.append(text('span', 'Старая проверка', 'tag warn'));
      }
      row.append(cell);
    }
    fragment.append(row);
  }
  $('rows').replaceChildren(fragment);
  $('count').textContent = `${groupsSorted.length} ${plural(groupsSorted.length, ['строка', 'строки', 'строк'])} · ${offers.length} ${plural(offers.length, ['предложение', 'предложения', 'предложений'])} · ${state.retailers.length} ${plural(state.retailers.length, ['магазин', 'магазина', 'магазинов'])}`;
  $('empty').hidden = groupsSorted.length > 0;
}

function procurementAge(offer) {
  const source = offer.validFrom || offer.fetchedAt;
  if (!source || !Number.isFinite(Date.parse(source))) return 'Дата прайса неизвестна';
  const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
  const sourceDay = /^\d{4}-\d{2}-\d{2}$/.test(source) ? source : day(source);
  if (sourceDay === day(Date.now())) return 'Сегодняшний ценник';
  if (sourceDay === day(Date.now() - 86400000)) return 'Вчерашний ценник';
  return `Прайс от ${new Date(sourceDay + 'T12:00:00Z').toLocaleDateString('ru-RU')}`;
}

function renderDesktop(offers) {
  const mode = $('sort').value;
  const sorted = [...offers].sort((a, b) => mode === 'price-up' ? a.price - b.price : mode === 'price-down' ? b.price - a.price : a.listingId.localeCompare(b.listingId, 'ru', { numeric: true }));
  const heading = text('tr', null, 'column-groups');
  for (const label of ['Модель', 'Чип · CPU / GPU', 'Память', 'SSD', 'Apple, $', 'Вес, кг', 'Доставка, $', 'Таможня, $', 'Организация и сопровождение, $', 'Итого покупателю, $']) heading.append(text('th', label));
  $('head').replaceChildren(heading);
  $('rows').replaceChildren(...sorted.map(offer => {
    const row = text('tr');
    const values = [offer.model, `${offer.chip} · ${offer.cpuCores} / ${offer.gpuCores}`, `${offer.ramGb} GB`, storage(offer.storageGb), number(offer.appleUsd), number(offer.weightKg), number(offer.deliveryUsd), number(offer.customsUsd), number(offer.serviceUsd), number(offer.totalUsd)];
    values.forEach((value, i) => row.append(text('td', value, i === 9 ? 'price best-price-cell' : null)));
    return row;
  }));
  $('count').textContent = `${offers.length} ${plural(offers.length, ['конфигурация', 'конфигурации', 'конфигураций'])} · Прайс под заказ · USD`;
  $('empty').hidden = offers.length > 0;
}

function resetSpecs() { Object.assign(state.filters, { screen: '', ram: '', ssd: '', color: '', stock: '' }); $('min-price').value = ''; $('max-price').value = ''; }

async function reload() {
  const data = await api('/api/master');
  const offers = data.rows.flatMap(row => row.offers).filter(offer => offer.visibility !== 'private' && Number.isFinite(offer.price) && offer.price > 0);
  const latest = new Map();
  for (const offer of offers) { const id = offer.listingId || [offer.retailer, offer.externalId || offer.sourceVariantId || '', offer.url, offer.keyboard, offer.paymentMethod, offer.minimumQuantity].join('|'); const prior = latest.get(id); if (!prior || Date.parse(offer.fetchedAt) >= Date.parse(prior.fetchedAt)) latest.set(id, offer); }
  const desktop = await api('/api/desktop-prices');
  const desktopOffers = desktop.rows.map((row, i) => ({ ...row, desktop: true, currency: 'USD', price: row.totalUsd, retailer: 'Прайс под заказ', stock: 'unknown', listingId: `desktop-${i}`, fetchedAt: desktop.sourceDate, title: `${row.model} ${row.chip}`, url: 'https://order.macbookbro.ru' }));
  state.offers = [...latest.values(), ...desktopOffers];
  const discovered = [...new Set(state.offers.filter(offer => !offer.desktop).map(offer => offer.retailer))];
  state.retailers = [...CONFIGURED_RETAILERS, ...discovered.filter(retailer => !CONFIGURED_RETAILERS.includes(retailer)).sort((a, b) => a.localeCompare(b, 'ru'))];
  renderControls(); render();
}

async function poll() {
  const status = await api('/api/status'); const running = status.state === 'running';
  $('status').textContent = running ? `Обновление: ${status.source || 'источники'}${status.total ? ` · ${status.completed}/${status.total}` : ''}` : status.error ? 'Часть источников не обновилась' : status.updatedAt ? `Последний сбор: ${date(status.updatedAt)}` : 'Цены из сохранённой базы';
  if (status.autoRefreshIntervalMs) $('status').textContent += ` · Автоматически каждый час${status.nextRefreshAt ? ` · Следующий сбор: ${date(status.nextRefreshAt)}` : ''}`;
  message(status.error || ''); if (!running && (state.wasRunning || (status.updatedAt && state.updatedAt !== status.updatedAt))) await reload(); state.wasRunning = running; state.updatedAt = status.updatedAt;
}

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
$('reset').addEventListener('click', () => { Object.assign(state.filters, { family: 'desktops', chip: '*', screen: '', ram: '', ssd: '', color: '', stock: '' }); $('sort').value = 'model'; resetSpecs(); renderControls(); render(); track('filter_reset'); });
$('export').addEventListener('click', () => { const value = { generatedAt: new Date().toISOString(), filters: { ...state.filters, minPrice: $('min-price').value, maxPrice: $('max-price').value }, offers: filtered() }; const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = text('a'); link.href = url; link.download = `prices-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); track('export'); });
document.addEventListener('click', event => { const link = event.target.closest('[data-analytics]'); if (link) track(link.dataset.analytics); });

try {
  if (localStorage.getItem('mac-price-radar-cookie-notice') !== 'accepted') $('cookie-banner').hidden = false;
} catch { $('cookie-banner').hidden = false; }
$('cookie-accept').addEventListener('click', () => {
  try { localStorage.setItem('mac-price-radar-cookie-notice', 'accepted'); } catch {}
  $('cookie-banner').hidden = true;
});

async function init() {
  document.body.classList.add('is-loading');
  $('filters').setAttribute('aria-busy', 'true');
  try {
    const config = await api('./public-config.json');
    if (config.mode === 'public') {
      const data = await api('../data/public-prices.json'); $('filters').hidden = true; $('sort').parentElement.hidden = true; $('export').hidden = true; $('selection-prompt').hidden = true; $('table-wrap').hidden = false;
      $('head').append(text('tr')); for (const name of ['Товар', 'Цена', 'Город']) $('head').firstChild.append(text('th', name));
      for (const price of data.prices) { if (Date.parse(price.validUntil) <= Date.now()) continue; const row = text('tr'); for (const value of [price.title, `${number(price.priceMinor / 100)} ₽`, price.city]) row.append(text('td', value)); $('rows').append(row); }
      $('status').textContent = `Выгрузка: ${date(data.generatedAt)}`; $('count').textContent = 'Публичный каталог'; $('empty').hidden = !!$('rows').children.length; return;
    }
    const session = await api('/api/session'); state.csrf = session.csrfToken; await reload(); await poll(); track('page_view'); setInterval(() => poll().catch(error => message(error.message)), 5000);
  } catch (error) { $('status').textContent = 'Не удалось загрузить цены'; message(error.message); }
  finally { document.body.classList.remove('is-loading'); $('filters').removeAttribute('aria-busy'); }
}
init();
