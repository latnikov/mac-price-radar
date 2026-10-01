import { MAC_FAMILIES, COLORS, SPEC_KEYS, emptyForeignFilters, capacity, foreignSpecs, matchesForeignRow, foreignModelLabel, foreignBadges, selectForeignPage } from './foreign-filters.js';
import { PHONE_FAMILIES } from './product-families.js';
const $ = id => document.getElementById(id);
const number = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(value);
const date = value => new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
let snapshot = { rows: [] }, csrf, running = false, pending = false, page = 1, pageCount = 1;
const collator = new Intl.Collator('ru', { numeric: true });
const filters = emptyForeignFilters();
let restored;
try { restored = JSON.parse(localStorage.getItem('foreign-filters') || '{}'); } catch { restored = {}; }
const hash = new URLSearchParams(location.hash.slice(1));
for (const key of Object.keys(filters)) {
  const value = hash.has(key) ? hash.get(key) : restored[key];
  if (typeof value === 'string' && value.length < 100) filters[key] = value;
}
for (const [key, id] of [['query', 'foreign-search'], ['min', 'foreign-min'], ['max', 'foreign-max'], ['sort', 'foreign-sort']]) {
  const value = hash.has(key) ? hash.get(key) : restored[key];
  if (typeof value === 'string') $(id).value = value.slice(0, 120);
}
if (SPEC_KEYS.some(key => filters[key])) $('foreign-advanced').open = true;
function persist() {
  const view = { ...filters, query: $('foreign-search').value, min: $('foreign-min').value, max: $('foreign-max').value, sort: $('foreign-sort').value };
  try { localStorage.setItem('foreign-filters', JSON.stringify(view)); } catch {}
  history.replaceState(null, '', `#${new URLSearchParams(Object.entries(view).filter(([, value]) => value !== ''))}`);
}
function button(label, key, value, className = '') {
  const node = document.createElement('button'); node.type = 'button'; node.className = `choice ${className}`;
  node.dataset.foreignFilter = key; node.dataset.value = value;
  node.classList.toggle('active', filters[key] === value); node.setAttribute('aria-pressed', String(filters[key] === value)); node.textContent = label;
  return node;
}
function filterLabel(key, value) {
  return key === 'family' ? MAC_FAMILIES.find(([id]) => id === value)?.[1] || PHONE_FAMILIES[value] || value
    : key === 'ram' ? `RAM ${value} GB` : key === 'storage' ? capacity(value)
      : key === 'color' ? COLORS[value] || value : key === 'cpu' ? `CPU ${value}` : key === 'gpu' ? `GPU ${value}`
        : key === 'display' ? value === 'Nano-texture' ? 'Нанотекстура' : 'Стандартный экран'
          : key === 'connection' && value === '10GbE' ? 'Ethernet 10 Гбит/с' : value;
}
function renderControls() {
  const categories = [...new Set(snapshot.rows.map(row => row.category).filter(Boolean))].sort();
  $('foreign-category-options').replaceChildren(button('Вся техника', 'category', ''), ...categories.map(value => button(value, 'category', value)));
  const base = snapshot.rows.filter(row => !filters.category || row.category === filters.category);
  const families = [...new Set(base.map(row => row.specs.family))].sort();
  const mac = filters.category === 'Mac';
  $('foreign-family-options').classList.toggle('mac-models', mac);
  const familyButtons = mac ? MAC_FAMILIES.filter(([key]) => families.includes(key)).map(([key, label, device, caption]) => {
    const node = button('', 'family', key, 'model-choice');
    const icon = document.createElement('span'); icon.className = `device ${device}`; icon.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span'); name.className = 'model-name'; name.textContent = label;
    const note = document.createElement('span'); note.className = 'model-caption'; note.textContent = `${caption} · ${base.filter(row => row.specs.family === key).length}`;
    node.append(icon, name, note); return node;
  }) : families.map(value => button(filterLabel('family', value), 'family', value));
  $('foreign-family-options').replaceChildren(...familyButtons, button('Все модели', 'family', '', 'all-models'));
  const modelRows = base.filter(row => !filters.family || row.specs.family === filters.family);
  for (const [index, key] of SPEC_KEYS.entries()) {
    const candidates = modelRows.filter(row => SPEC_KEYS.slice(0, index).every(other => !filters[other] || row.specs[other] === filters[other]));
    const values = [...new Set(candidates.map(row => row.specs[key]).filter(Boolean))].sort((a, b) => ['ram', 'storage', 'screen', 'cpu', 'gpu'].includes(key) ? parseFloat(a) - parseFloat(b) : collator.compare(a, b));
    $('foreign-' + key + '-group').hidden = (filters.category === 'iPhone' || Boolean(PHONE_FAMILIES[filters.family])) && ['chip', 'screen', 'ram', 'cpu', 'gpu', 'display'].includes(key) || !modelRows.some(row => row.specs[key]);
    if (key === 'chip') {
      // Compare generations within each family and chip tier using this price list.
      const generationKey = row => `${row.specs.family}:${row.specs.chip.replace(/\d+/, '')}`;
      const generations = new Map();
      for (const row of modelRows) generations.set(generationKey(row), Math.max(generations.get(generationKey(row)) || 0, Number(row.specs.chip.match(/\d+/)?.[0]) || 0));
      const current = values.filter(value => modelRows.some(row => row.specs.chip === value && Number(value.match(/\d+/)?.[0]) === generations.get(generationKey(row))));
      const older = values.filter(value => !current.includes(value));
      $('foreign-chip-options').replaceChildren(button('Все процессоры', key, ''), ...current.map(value => button(value, key, value, 'current')));
      $('foreign-chip-older').replaceChildren(...older.map(value => button(value, key, value)));
      $('foreign-chip-history').hidden = !older.length;
      $('foreign-chip-history').querySelector('summary').textContent = `Предыдущие поколения · ${older.length}`;
      if (older.includes(filters.chip)) $('foreign-chip-history').open = true;
    } else $('foreign-' + key + '-options').replaceChildren(button('Любой', key, ''), ...values.map(value => button(filterLabel(key, value), key, value)));
  }
  const active = [];
  for (const [key, value] of Object.entries(filters)) {
    if (!value) continue;
    const label = filterLabel(key, value);
    const node = button(`${label} ×`, key, ''); node.className = 'filter-tag'; node.setAttribute('aria-label', `Убрать фильтр: ${label}`); active.push(node);
  }
  for (const [id, label] of [['foreign-search', 'Поиск'], ['foreign-min', 'От'], ['foreign-max', 'До']]) {
    const value = $(id).value;
    if (!value) continue;
    const node = button(`${label}: ${value}${id === 'foreign-search' ? '' : ' ₽'} ×`, id, '');
    node.className = 'filter-tag'; node.setAttribute('aria-label', `Убрать фильтр: ${label}`); active.push(node);
  }
  $('foreign-active-filters').replaceChildren(...active); $('foreign-active-filters').hidden = !active.length;
  $('foreign-clear-search').hidden = !$('foreign-search').value;
}
function change() { page = 1; render(); persist(); }
function showFailure(message) { $('foreign-status').textContent = message; $('foreign-summary').textContent = message; }
const endpoint = path => new URL(`../api/${path}`, import.meta.url);
async function request(path, body) {
  const response = await fetch(endpoint(path), { signal: AbortSignal.timeout(30000), ...(body ? {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body),
  } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function render() {
  renderControls();
  const rows = snapshot.rows.filter(row => matchesForeignRow(row, filters, { query: $('foreign-search').value, min: $('foreign-min').value, max: $('foreign-max').value }));
  const selection = selectForeignPage(rows, { sort: $('foreign-sort').value, page });
  page = selection.page; pageCount = selection.pages;
  const fragment = document.createDocumentFragment();
  for (const row of selection.rows) {
    const tr = document.createElement('tr');
    tr.className = 'configuration-row';
    const config = document.createElement('td'); config.className = 'configuration-cell';
    const name = document.createElement('span'); name.className = 'configuration-model'; name.textContent = foreignModelLabel(row);
    const badges = document.createElement('span'); badges.className = 'configuration-badges';
    for (const badge of foreignBadges(row)) {
      const node = button(badge.label, badge.key, badge.value);
      node.className = 'configuration-badge'; node.title = `Выбрать ${filterLabel(badge.key, badge.value)}`;
      node.dataset.category = row.category; node.dataset.family = row.specs.family;
      badges.append(node);
    }
    config.append(name, badges);
    // Details keep every source distinction, including bands, stands and accessories.
    if (!badges.childElementCount || row.category !== 'Mac') {
      const variant = document.createElement('span'); variant.className = 'variant'; variant.textContent = row.configuration; config.append(variant);
    }
    const original = document.createElement('details'); original.className = 'foreign-configuration';
    const caption = document.createElement('summary'); caption.textContent = 'Описание источника';
    const description = document.createElement('p'); description.textContent = row.configuration;
    original.append(caption, description); config.append(original); tr.append(config);
    for (const [index, value] of [number(row.usd), row.rub == null ? '—' : number(row.rub)].entries()) {
      const td = document.createElement('td');
      td.className = `price-cell${index === 1 ? ' best-price-cell' : ''}`;
      if (value !== '—') {
        const priceLink = document.createElement('a'); priceLink.href = row.offerUrl || row.guideUrl;
        priceLink.className = 'price'; priceLink.target = '_blank'; priceLink.rel = 'noopener noreferrer'; priceLink.textContent = `${value} ${index === 0 ? '$' : '₽'}`;
        priceLink.setAttribute('aria-label', `${value} ${index === 0 ? 'долларов' : 'рублей'} — открыть предложение ${row.configuration}`);
        td.append(priceLink);
      } else td.textContent = value;
      tr.append(td);
    }
    const td = document.createElement('td'), link = document.createElement('a');
    link.href = row.guideUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'AppleInsider ↗';
    td.append(link);
    if (row.terms) { const note = document.createElement('p'); note.textContent = row.terms; td.append(note); }
    const checked = document.createElement('span'); checked.className = 'variant'; checked.textContent = `Проверено: ${date(row.fetchedAt)}`; td.append(checked);
    if (row.stale || Date.now() - Date.parse(row.fetchedAt) > 4 * 3600000) {
      const note = document.createElement('span'); note.className = 'tag warn'; note.textContent = 'Старая проверка';
      note.title = row.stale ? 'Обновление раздела не удалось. Показана сохранённая цена.' : 'С последней проверки прошло больше четырёх часов.'; td.append(note);
    }
    tr.append(td); fragment.append(tr);
  }
  $('foreign-rows').replaceChildren(fragment);
  $('foreign-count').textContent = `Конфигураций: ${rows.length} из ${snapshot.rows.length}`;
  $('foreign-pagination').hidden = selection.pages <= 1;
  $('foreign-page-prev').disabled = page === 1; $('foreign-page-next').disabled = page === pageCount;
  $('foreign-page-info').textContent = `${selection.start}–${selection.end} из ${selection.total} · страница ${page} / ${pageCount}`;
  $('foreign-table').hidden = !rows.length;
  $('foreign-empty').hidden = Boolean(rows.length);
  $('foreign-empty').textContent = snapshot.rows.length ? 'По этому запросу ничего не найдено.' : 'Цены появятся после первого успешного сбора.';
  renderStatus();
}
function renderStatus() {
  const rate = snapshot.usdRate || snapshot.googleRate;
  $('foreign-rate').textContent = rate ? `${snapshot.rateSource || 'Google'}: ${number(rate)} ₽/$ + 4 ₽ = ${number(snapshot.effectiveRate)} ₽/$. ${snapshot.rateDate ? `Дата курса: ${snapshot.rateDate}. ` : ''}Проверено: ${date(snapshot.updatedAt)} (Москва).` : 'Курс ещё не получен. Пересчёт появится после успешной проверки.';
  const stale = snapshot.updatedAt && Date.now() - Date.parse(snapshot.updatedAt) > 4 * 3600000;
  $('foreign-status').textContent = snapshot.requestedAt ? `Обновление запрошено ${date(snapshot.requestedAt)}. Сбор выполняется сервером по расписанию. Показаны сохранённые цены.` : running ? 'Идёт обновление цен. Сохранённый результат показан ниже.' : snapshot.state === 'error' ? `Сбор недоступен. ${snapshot.rows.length ? 'Показаны последние сохранённые цены.' : 'Подтверждённых цен пока нет.'} Последняя попытка: ${date(snapshot.attemptedAt)} (Москва).` : ['ready', 'partial'].includes(snapshot.state) ? `${stale ? 'Старая проверка. ' : ''}${snapshot.state === 'partial' ? 'Часть разделов не обновилась. ' : ''}Обновление каждый час. Последний сбор: ${date(snapshot.updatedAt)} (Москва). Таблиц: ${snapshot.guides}.` : 'Первый сбор ещё не завершён. Автоматическое обновление — каждый час.';
  $('foreign-summary').textContent = $('foreign-status').textContent;
  $('foreign-error').hidden = !snapshot.error && !snapshot.warnings?.length;
  $('foreign-error-text').textContent = snapshot.error || snapshot.warnings?.join('\n') || '';
  $('foreign-refresh').disabled = !csrf || running || pending;
  $('foreign-refresh').textContent = running || pending ? 'Обновляем цены…' : 'Обновить цены';
}
let snapshotVersion;
async function reload() {
  const [prices, status] = await Promise.all([request('foreign-prices'), request('status')]);
  running = status.state === 'running';
  const version = JSON.stringify([prices, prices.rows.map(row => Boolean(row.stale || Date.now() - Date.parse(row.fetchedAt) > 4 * 3600000))]);
  if (snapshotVersion !== version) {
    snapshotVersion = version; snapshot = { ...prices, rows: prices.rows.map(row => ({ ...row, specs: foreignSpecs(row) })) }; render();
  } else renderStatus();
}
for (const id of ['foreign-search', 'foreign-min', 'foreign-max']) $(id).addEventListener('input', change);
$('foreign-sort').addEventListener('change', change);
$('foreign-reset').addEventListener('click', () => {
  Object.assign(filters, emptyForeignFilters());
  for (const id of ['foreign-search', 'foreign-min', 'foreign-max']) $(id).value = '';
  $('foreign-sort').value = 'model'; change();
});
$('foreign-clear-search').addEventListener('click', () => { $('foreign-search').value = ''; change(); $('foreign-search').focus(); });
document.addEventListener('click', event => {
  const node = event.target.closest('[data-foreign-filter]'); if (!node) return;
  const key = node.dataset.foreignFilter;
  if (key.startsWith('foreign-')) { $(key).value = ''; change(); return; }
  if (node.classList.contains('configuration-badge')) {
    if (filters.category !== node.dataset.category || filters.family !== node.dataset.family) {
      Object.assign(filters, emptyForeignFilters(), { category: node.dataset.category, family: node.dataset.family });
    }
    $('foreign-advanced').open = true;
  }
  filters[key] = node.dataset.value;
  if (key === 'category' || key === 'family') {
    if (key === 'category') filters.family = '';
    for (const spec of SPEC_KEYS) filters[spec] = '';
    $('foreign-min').value = ''; $('foreign-max').value = '';
    $('foreign-advanced').open = true;
  } else {
    for (const spec of SPEC_KEYS.slice(SPEC_KEYS.indexOf(key) + 1)) filters[spec] = '';
  }
  change();
});
for (const [id, direction] of [['foreign-page-prev', -1], ['foreign-page-next', 1]]) $(id).addEventListener('click', () => {
  page += direction; render(); $('foreign-table').scrollTop = 0;
});
$('foreign-refresh').addEventListener('click', async () => {
  pending = true; renderStatus();
  let failure;
  try { await request('refresh', { retailer: 'AppleInsider' }); running = true; await reload(); }
  catch (error) { failure = error.message; }
  finally { pending = false; renderStatus(); if (failure) showFailure(failure); }
});
async function poll() {
  try { if (!document.hidden || !snapshot.updatedAt) await reload(); }
  catch (error) { showFailure(`Не удалось обновить лист: ${error.message}`); }
  finally { setTimeout(poll, running ? 3000 : 30000); }
}
request('session').then(session => { csrf = session.csrfToken; renderStatus(); }).catch(error => { showFailure(error.message); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void reload().catch(error => showFailure(error.message)); });
void poll();
