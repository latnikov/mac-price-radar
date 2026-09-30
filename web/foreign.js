const $ = id => document.getElementById(id);
const number = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(value);
const date = value => new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
let snapshot = { rows: [] }, csrf, running = false, pending = false;
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
  const terms = $('foreign-search').value.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = snapshot.rows.filter(row => terms.every(term => `${row.model} ${row.configuration}`.toLowerCase().includes(term)));
  if ($('foreign-sort').value === 'price') rows.sort((a, b) => a.rub - b.rub);
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const value of [row.model, row.configuration, number(row.usd), number(row.rub)]) {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    }
    const td = document.createElement('td'), link = document.createElement('a');
    link.href = row.guideUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'AppleInsider ↗';
    td.append(link);
    if (row.terms) { const note = document.createElement('p'); note.textContent = row.terms; td.append(note); }
    tr.append(td); fragment.append(tr);
  }
  $('foreign-rows').replaceChildren(fragment);
  $('foreign-count').textContent = `Конфигураций: ${rows.length} из ${snapshot.rows.length}`;
  $('foreign-table').hidden = !rows.length;
  $('foreign-empty').hidden = Boolean(rows.length);
  $('foreign-empty').textContent = snapshot.rows.length ? 'По этому запросу ничего не найдено.' : 'Цены появятся после первого успешного сбора.';
  $('foreign-rate').textContent = snapshot.googleRate ? `Google: ${number(snapshot.googleRate)} ₽/$ + 4 ₽ = ${number(snapshot.effectiveRate)} ₽/$. Проверено: ${date(snapshot.updatedAt)} (Москва).` : 'Курс ещё не получен. Пересчёт появится после успешной проверки Google.';
  const stale = snapshot.updatedAt && Date.now() - Date.parse(snapshot.updatedAt) > 4 * 3600000;
  $('foreign-status').textContent = running ? 'Идёт обновление цен. Сохранённый результат показан ниже.' : snapshot.state === 'error' ? `Сбор недоступен. ${snapshot.rows.length ? 'Показаны последние сохранённые цены.' : 'Подтверждённых цен пока нет.'} Последняя попытка: ${date(snapshot.attemptedAt)} (Москва).` : snapshot.state === 'ready' ? `${stale ? 'Старая проверка. ' : ''}Обновление каждый час. Последний сбор: ${date(snapshot.updatedAt)} (Москва).` : 'Первый сбор ещё не завершён. Автоматическое обновление — каждый час.';
  $('foreign-error').hidden = !snapshot.error;
  $('foreign-error-text').textContent = snapshot.error || '';
  $('foreign-refresh').disabled = !csrf || running || pending;
  $('foreign-refresh').textContent = running || pending ? 'Обновляем цены…' : 'Обновить цены';
}
async function reload() {
  const [prices, status] = await Promise.all([request('foreign-prices'), request('status')]);
  snapshot = prices; running = status.state === 'running'; render();
}
$('foreign-search').addEventListener('input', render);
$('foreign-sort').addEventListener('change', render);
$('foreign-refresh').addEventListener('click', async () => {
  pending = true; render();
  let failure;
  try { await request('refresh', { retailer: 'AppleInsider' }); running = true; await reload(); }
  catch (error) { failure = error.message; }
  finally { pending = false; render(); if (failure) $('foreign-status').textContent = failure; }
});
async function poll() {
  try { if (!document.hidden) await reload(); }
  catch (error) { $('foreign-status').textContent = `Не удалось обновить лист: ${error.message}`; }
  finally { setTimeout(poll, running ? 3000 : 30000); }
}
request('session').then(session => { csrf = session.csrfToken; render(); }).catch(error => { $('foreign-status').textContent = error.message; });
void poll();
