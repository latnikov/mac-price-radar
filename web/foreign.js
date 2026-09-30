import { MAC_FAMILIES, COLORS, SPEC_KEYS, emptyForeignFilters, capacity, foreignSpecs, matchesForeignRow } from './foreign-filters.js';
const $ = id => document.getElementById(id);
const number = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(value);
const date = value => new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
let snapshot = { rows: [] }, csrf, running = false, pending = false;
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
  }) : families.map(value => button(value, 'family', value));
  $('foreign-family-options').replaceChildren(...familyButtons, button('Все модели', 'family', '', 'all-models'));
  const modelRows = base.filter(row => !filters.family || row.specs.family === filters.family);
  for (const key of SPEC_KEYS) {
    const candidates = modelRows.filter(row => SPEC_KEYS.every(other => other === key || !filters[other] || row.specs[other] === filters[other]));
    const values = [...new Set(candidates.map(row => row.specs[key]).filter(Boolean))].sort((a, b) => ['ram', 'storage', 'screen'].includes(key) ? parseFloat(a) - parseFloat(b) : b.localeCompare(a, 'en', { numeric: true }));
    $('foreign-' + key + '-group').hidden = !modelRows.some(row => row.specs[key]);
    const format = value => key === 'ram' ? `${value} GB` : key === 'storage' ? capacity(value) : key === 'color' ? COLORS[value] || value : value;
    $('foreign-' + key + '-options').replaceChildren(button(key === 'chip' ? 'Все процессоры' : 'Любой', key, ''), ...values.map(value => button(format(value), key, value)));
  }
  const active = [];
  for (const [key, value] of Object.entries(filters)) {
    if (!value) continue;
    const label = key === 'family' ? MAC_FAMILIES.find(([id]) => id === value)?.[1] || value : key === 'ram' ? `${value} GB RAM` : key === 'storage' ? capacity(value) : key === 'color' ? COLORS[value] || value : value;
    const node = button(`${label} ×`, key, ''); node.className = 'filter-tag'; node.setAttribute('aria-label', `Убрать фильтр: ${label}`); active.push(node);
  }
  $('foreign-active-filters').replaceChildren(...active); $('foreign-active-filters').hidden = !active.length;
  $('foreign-clear-search').hidden = !$('foreign-search').value;
}
function change() { render(); persist(); }
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
  if ($('foreign-sort').value === 'price') rows.sort((a, b) => (a.rub ?? Infinity) - (b.rub ?? Infinity));
  if ($('foreign-sort').value === 'price-down') rows.sort((a, b) => (b.rub ?? -Infinity) - (a.rub ?? -Infinity));
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const [index, value] of [row.model, row.configuration, number(row.usd), row.rub == null ? '—' : number(row.rub)].entries()) {
      const td = document.createElement('td');
      if (index >= 2 && value !== '—') {
        const priceLink = document.createElement('a'); priceLink.href = row.offerUrl || row.guideUrl;
        priceLink.target = '_blank'; priceLink.rel = 'noopener noreferrer'; priceLink.textContent = value;
        priceLink.setAttribute('aria-label', `${value} ${index === 2 ? 'долларов' : 'рублей'} — открыть предложение ${row.configuration}`);
        td.append(priceLink);
      } else td.textContent = value;
      tr.append(td);
    }
    const td = document.createElement('td'), link = document.createElement('a');
    link.href = row.guideUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'AppleInsider ↗';
    td.append(link);
    if (row.terms) { const note = document.createElement('p'); note.textContent = row.terms; td.append(note); }
    if (row.stale) { const note = document.createElement('p'); note.textContent = `Предыдущая проверка: ${date(row.fetchedAt)}. Обновление раздела не удалось.`; td.append(note); }
    tr.append(td); fragment.append(tr);
  }
  $('foreign-rows').replaceChildren(fragment);
  $('foreign-count').textContent = `Конфигураций: ${rows.length} из ${snapshot.rows.length}`;
  $('foreign-table').hidden = !rows.length;
  $('foreign-empty').hidden = Boolean(rows.length);
  $('foreign-empty').textContent = snapshot.rows.length ? 'По этому запросу ничего не найдено.' : 'Цены появятся после первого успешного сбора.';
  const rate = snapshot.usdRate || snapshot.googleRate;
  $('foreign-rate').textContent = rate ? `${snapshot.rateSource || 'Google'}: ${number(rate)} ₽/$ + 4 ₽ = ${number(snapshot.effectiveRate)} ₽/$. ${snapshot.rateDate ? `Дата курса: ${snapshot.rateDate}. ` : ''}Проверено: ${date(snapshot.updatedAt)} (Москва).` : 'Курс ещё не получен. Пересчёт появится после успешной проверки.';
  const stale = snapshot.updatedAt && Date.now() - Date.parse(snapshot.updatedAt) > 4 * 3600000;
  $('foreign-status').textContent = snapshot.requestedAt ? `Обновление запрошено ${date(snapshot.requestedAt)}. Сбор начнётся на Mac при доступном подключении. Показаны сохранённые цены.` : running ? 'Идёт обновление цен. Сохранённый результат показан ниже.' : snapshot.state === 'error' ? `Сбор недоступен. ${snapshot.rows.length ? 'Показаны последние сохранённые цены.' : 'Подтверждённых цен пока нет.'} Последняя попытка: ${date(snapshot.attemptedAt)} (Москва).` : ['ready', 'partial'].includes(snapshot.state) ? `${stale ? 'Старая проверка. ' : ''}${snapshot.state === 'partial' ? 'Часть разделов не обновилась. ' : ''}Обновление каждый час${snapshot.transport === 'mac-browser' ? ', пока Mac включён и подключён к интернету' : ''}. Последний сбор: ${date(snapshot.updatedAt)} (Москва). Таблиц: ${snapshot.guides}.` : 'Первый сбор ещё не завершён. Автоматическое обновление — каждый час.';
  $('foreign-summary').textContent = $('foreign-status').textContent;
  $('foreign-error').hidden = !snapshot.error && !snapshot.warnings?.length;
  $('foreign-error-text').textContent = snapshot.error || snapshot.warnings?.join('\n') || '';
  $('foreign-refresh').disabled = !csrf || running || pending;
  $('foreign-refresh').textContent = running || pending ? 'Обновляем цены…' : 'Обновить цены';
}
async function reload() {
  const [prices, status] = await Promise.all([request('foreign-prices'), request('status')]);
  snapshot = { ...prices, rows: prices.rows.map(row => ({ ...row, specs: foreignSpecs(row) })) }; running = status.state === 'running'; render();
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
  filters[key] = node.dataset.value;
  if (key === 'category' || key === 'family') {
    if (key === 'category') filters.family = '';
    for (const spec of SPEC_KEYS) filters[spec] = '';
    $('foreign-min').value = ''; $('foreign-max').value = '';
  } else if (key === 'chip') {
    for (const spec of SPEC_KEYS) if (spec !== 'chip') filters[spec] = '';
  }
  change();
});
$('foreign-refresh').addEventListener('click', async () => {
  pending = true; render();
  let failure;
  try { await request('refresh', { retailer: 'AppleInsider' }); running = true; await reload(); }
  catch (error) { failure = error.message; }
  finally { pending = false; render(); if (failure) showFailure(failure); }
});
async function poll() {
  try { if (!document.hidden || !snapshot.updatedAt) await reload(); }
  catch (error) { showFailure(`Не удалось обновить лист: ${error.message}`); }
  finally { setTimeout(poll, running ? 3000 : 30000); }
}
request('session').then(session => { csrf = session.csrfToken; render(); }).catch(error => { showFailure(error.message); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void reload().catch(error => showFailure(error.message)); });
void poll();
