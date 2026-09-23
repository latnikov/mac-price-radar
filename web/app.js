const $ = id => document.getElementById(id);
const state = {
  offers: [], retailers: [], csrf: '', wasRunning: false,
  filters: { family: null, chip: null, screen: '', ram: '', ssd: '', color: '', stock: '' },
};
const CURRENT_CHIPS = {
  air: new Set(['M5']),
  pro: new Set(['M5', 'M5 Pro', 'M5 Max']),
  neo: new Set(['A18 Pro']),
  imac: new Set(['M4']),
};
const text = (tag, value, cls) => { const node = document.createElement(tag); if (value != null) node.textContent = String(value); if (cls) node.className = cls; return node; };
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU') : 'Дата не указана';
const number = value => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const plural = (n, forms) => forms[n % 100 >= 11 && n % 100 <= 14 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2];
const storage = value => value >= 1000 && value % 1000 === 0 ? `${value / 1000} TB` : value ? `${value} GB` : '—';
const amount = offer => `${number(offer.price)} ₽`;
const stock = offer => ['InStock', 'confirmed', 'source_reported'].includes(offer.stock) ? 'in' : ['OutOfStock', 'Discontinued', 'SoldOut'].includes(offer.stock) ? 'out' : 'unknown';
const compareOffers = (a, b) => (b.marketEligible === true) - (a.marketEligible === true) || (stock(a) === 'out') - (stock(b) === 'out') || a.price - b.price;
const stockLabel = offer => ({ in: 'В наличии на сайте', out: 'Нет в наличии', unknown: 'Наличие не указано' })[stock(offer)];
const model = offer => String(offer.model || offer.title || 'Не распознано').replace(/\s+/g, ' ').trim();
const family = offer => /MacBook\s+Air/i.test(model(offer)) ? 'air' : /MacBook\s+Pro/i.test(model(offer)) ? 'pro' : /MacBook\s+Neo/i.test(model(offer)) ? 'neo' : /^iMac\b/i.test(model(offer)) ? 'imac' : 'other';
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

function safeLink(offer) {
  try {
    const url = new URL(offer.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return text('span', amount(offer), 'price');
    const link = text('a', amount(offer), 'price'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
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
  return state.filters.family === '*' ? state.offers : state.offers.filter(offer => family(offer) === state.filters.family);
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
  const query = $('search').value.toLowerCase().trim();
  const minimum = $('min-price').value;
  const maximum = $('max-price').value;
  const selected = state.filters;
  return state.offers.filter(offer =>
    (selected.family === '*' || family(offer) === selected.family)
    && (selected.chip === '*' || offer.chip === selected.chip)
    && (!selected.screen || String(screen(offer)) === selected.screen)
    && (!selected.ram || String(offer.ramGb) === selected.ram)
    && (!selected.ssd || String(offer.storageGb) === selected.ssd)
    && (!selected.color || offer.color === selected.color)
    && (!selected.stock || stock(offer) === selected.stock)
    && (!query || `${offer.title} ${model(offer)} ${offer.chip} ${offer.retailer} ${offer.sourceSender || ''} ${offer.sourceTitle || ''} ${offer.sourceUsername || ''} ${offer.url} ${characteristics(offer)}`.toLowerCase().includes(query))
    && (minimum === '' || offer.price >= Number(minimum))
    && (maximum === '' || offer.price <= Number(maximum))
  );
}

function offerDetail(offer) {
  const node = text('div', null, 'offer');
  node.append(safeLink(offer), text('small', offer.title), text('small', characteristics(offer)), text('small', stockLabel(offer)), text('small', date(offer.fetchedAt || offer.observedAt)));
  if (offer.sourceSender) node.append(text('small', `Источник: ${offer.sourceSender}`));
  if (offer.qualityWarnings?.length) node.append(text('small', offer.qualityWarnings.join('; ')));
  const reasons = [...new Set(offer.qualityReasons || [])].filter(reason => !offer.qualityWarnings?.includes(reason));
  if (reasons.length) node.append(text('small', reasons.join('; ')));
  return node;
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
  const groups = new Map();
  for (const offer of offers) { const id = key(offer); if (!groups.has(id)) groups.set(id, { sample: offer, offers: [] }); groups.get(id).offers.push(offer); }
  const groupsSorted = [...groups.values()].sort((a, b) => {
    const mode = $('sort').value;
    const priceA = Math.min(...a.offers.filter(offer => offer.marketEligible).map(offer => offer.price), Infinity), priceB = Math.min(...b.offers.filter(offer => offer.marketEligible).map(offer => offer.price), Infinity);
    return mode === 'price-up' ? priceA - priceB : mode === 'price-down' ? priceB - priceA : mode === 'fresh' ? Math.max(...b.offers.map(offer => Date.parse(offer.fetchedAt) || 0)) - Math.max(...a.offers.map(offer => Date.parse(offer.fetchedAt) || 0)) : key(a.sample).localeCompare(key(b.sample), 'ru', { numeric: true });
  });
  const heading = text('tr');
  for (const name of ['Модель', 'Чип', 'RAM', 'SSD', 'Цвет', 'Лучшая цена', ...state.retailers]) heading.append(text('th', name, name === 'Лучшая цена' ? 'best-price-heading' : null));
  $('head').replaceChildren(heading);
  const fragment = document.createDocumentFragment();
  for (const group of groupsSorted) {
    const row = text('tr'), sample = group.sample;
    for (const value of [model(sample), sample.chip || '—', sample.ramGb ? `${sample.ramGb} GB` : '—', storage(sample.storageGb), sample.color && sample.color !== 'unknown' ? sample.color : '—']) row.append(text('td', value));
    const bestCell = text('td', null, 'price-cell best-price-cell');
    const best = group.offers.filter(offer => offer.marketEligible === true).sort(compareOffers)[0];
    if (!best) bestCell.append(text('span', 'Нет проверенной цены', 'empty-cell'));
    else {
      const details = text('details'), summary = text('summary');
      summary.append(text('span', amount(best), 'price'), text('span', best.retailer, 'variant'));
      if (stock(best) === 'out') summary.append(text('span', 'Нет в наличии', 'tag'));
      else if (Date.now() - Date.parse(best.fetchedAt) > 4 * 3600000) summary.append(text('span', 'Старая проверка', 'tag warn'));
      details.append(summary, offerDetail(best)); bestCell.append(details);
    }
    row.append(bestCell);
    for (const retailer of state.retailers) {
      const cell = text('td', null, 'price-cell');
      const items = group.offers.filter(offer => offer.retailer === retailer).sort(compareOffers);
      if (!items.length) cell.append(text('span', '—', 'empty-cell'));
      else {
        const first = items[0], details = text('details'), summary = text('summary');
        summary.append(text('span', amount(first), 'price'), text('span', characteristics(first) || 'Подробности', 'variant'));
        if (items.length > 1) summary.append(text('span', `${items.length} ${plural(items.length, ['вариант', 'варианта', 'вариантов'])}`, 'variant'));
        if (first.marketEligible !== true) summary.append(text('span', 'Требует проверки', 'tag warn'));
        if (stock(first) === 'out') summary.append(text('span', 'Нет в наличии', 'tag')); else if (Date.now() - Date.parse(first.fetchedAt) > 4 * 3600000) summary.append(text('span', 'Старая проверка', 'tag warn'));
        details.append(summary); for (const offer of items) details.append(offerDetail(offer)); cell.append(details);
      }
      row.append(cell);
    }
    fragment.append(row);
  }
  $('rows').replaceChildren(fragment);
  $('count').textContent = `${groupsSorted.length} ${plural(groupsSorted.length, ['строка', 'строки', 'строк'])} · ${offers.length} ${plural(offers.length, ['предложение', 'предложения', 'предложений'])} · ${state.retailers.length} ${plural(state.retailers.length, ['магазин', 'магазина', 'магазинов'])}`;
  $('empty').hidden = groupsSorted.length > 0;
}

function resetSpecs() { Object.assign(state.filters, { screen: '', ram: '', ssd: '', color: '', stock: '' }); $('min-price').value = ''; $('max-price').value = ''; }

async function reload() {
  const data = await api('/api/master');
  const offers = data.rows.flatMap(row => row.offers).filter(offer => offer.visibility !== 'private' && Number.isFinite(offer.price) && offer.price > 0);
  const latest = new Map();
  for (const offer of offers) { const id = [offer.retailer, offer.url, offer.keyboard, offer.paymentMethod, offer.minimumQuantity].join('|'); const prior = latest.get(id); if (!prior || Date.parse(offer.fetchedAt) >= Date.parse(prior.fetchedAt)) latest.set(id, offer); }
  state.offers = [...latest.values()]; state.retailers = [...new Set(state.offers.map(offer => offer.retailer))].sort((a, b) => a.localeCompare(b, 'ru'));
  renderControls(); render();
}

async function poll() {
  const status = await api('/api/status'); const running = status.state === 'running';
  $('refresh').disabled = running;
  $('status').textContent = running ? `Обновление: ${status.source || 'источники'}${status.total ? ` · ${status.completed}/${status.total}` : ''}` : status.error ? 'Часть источников не обновилась' : status.updatedAt ? `Последний сбор: ${date(status.updatedAt)}` : 'Цены из сохранённой базы';
  message(status.error || ''); if (state.wasRunning && !running) await reload(); state.wasRunning = running;
}

$('filters').addEventListener('click', event => {
  const button = event.target.closest('button[data-filter]'); if (!button) return;
  const filter = button.dataset.filter, value = button.dataset.value;
  if (filter === 'family') { state.filters.family = value; state.filters.chip = null; resetSpecs(); }
  else if (filter === 'chip') { state.filters.chip = value; resetSpecs(); }
  else state.filters[filter] = value;
  renderControls(); render();
});
$('search').addEventListener('input', render); $('min-price').addEventListener('input', render); $('max-price').addEventListener('input', render); $('sort').addEventListener('change', render);
$('reset').addEventListener('click', () => { Object.assign(state.filters, { family: null, chip: null, screen: '', ram: '', ssd: '', color: '', stock: '' }); $('search').value = ''; $('sort').value = 'model'; resetSpecs(); renderControls(); render(); });
$('refresh').addEventListener('click', async () => { try { message(''); await api('/api/refresh', {}); await poll(); } catch (error) { message(error.message); } });
$('export').addEventListener('click', () => { const value = { generatedAt: new Date().toISOString(), filters: { ...state.filters, search: $('search').value, minPrice: $('min-price').value, maxPrice: $('max-price').value }, offers: filtered() }; const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = text('a'); link.href = url; link.download = `prices-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });

async function init() {
  try {
    const config = await api('./public-config.json');
    if (config.mode === 'public') {
      const data = await api('../data/public-prices.json'); $('refresh').hidden = true; $('filters').hidden = true; $('sort').parentElement.hidden = true; $('export').hidden = true; $('selection-prompt').hidden = true; $('table-wrap').hidden = false;
      $('head').append(text('tr')); for (const name of ['Товар', 'Цена', 'Город']) $('head').firstChild.append(text('th', name));
      for (const price of data.prices) { if (Date.parse(price.validUntil) <= Date.now()) continue; const row = text('tr'); for (const value of [price.title, `${number(price.priceMinor / 100)} ₽`, price.city]) row.append(text('td', value)); $('rows').append(row); }
      $('status').textContent = `Выгрузка: ${date(data.generatedAt)}`; $('count').textContent = 'Публичный каталог'; $('empty').hidden = !!$('rows').children.length; return;
    }
    const session = await api('/api/session'); state.csrf = session.csrfToken; await reload(); await poll(); setInterval(() => poll().catch(error => message(error.message)), 5000);
  } catch (error) { $('status').textContent = 'Не удалось загрузить цены'; message(error.message); }
}
init();
