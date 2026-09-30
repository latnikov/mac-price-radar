const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rubles = value => finite(value) ? `${number.format(value)} ₽` : 'Не рассчитано';
const date = value => Number.isFinite(Date.parse(value))
  ? `${new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} МСК`
  : null;
const LIMIT = 12;
const REVIEW_LIMIT = 100;

export function avitoListingUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !(url.hostname === 'avito.ru' || url.hostname.endsWith('.avito.ru'))) return null;
    return url.href;
  } catch { return null; }
}

export function monitorSummary(data = {}) {
  const state = data.state && typeof data.state === 'object' ? data.state : {};
  const statuses = {
    ready: ['Сбор завершён', 'success'], partial: ['Получена часть объявлений', 'warning'],
    running: ['Идёт сбор', 'loading'], error: ['Сбор требует проверки', 'warning'],
    blocked: ['Сбор приостановлен', 'warning'], budget_exhausted: ['Лимит расходов исчерпан', 'warning'],
    paused: ['Сбор приостановлен', 'warning'], needs_attention: ['Нужна проверка', 'warning'],
    locked: ['Сбор уже идёт', 'loading'],
    budget: ['Лимит расходов исчерпан', 'warning'], disabled: ['Сбор выключен', 'warning'],
    idle: ['Ожидаем запуск', 'loading'], not_configured: ['Требуется настройка', 'warning'],
  };
  const [badge, tone] = statuses[state.state] || ['Ожидаем настройку сбора', 'warning'];
  const opportunities = data.opportunities && typeof data.opportunities === 'object' ? data.opportunities : {};
  const threshold = opportunities.threshold || opportunities.thresholds || {};
  const reserve = finite(threshold.costReserveRub) ? threshold.costReserveRub : 3000;
  const minRub = finite(threshold.minDeltaRub) ? threshold.minDeltaRub : 10000;
  const minPercent = finite(threshold.minDeltaPercent) ? threshold.minDeltaPercent : 10;
  const candidates = Array.isArray(opportunities.candidates) ? opportunities.candidates.filter(item => item && typeof item === 'object') : [];
  const budget = state.budget || {};
  const spent = finite(budget.spentUsd) ? dollars.format(budget.spentUsd) : 'неизвестно';
  const trialBudget = finite(budget.limitUsd);
  const max = trialBudget ? dollars.format(budget.limitUsd) : finite(budget.monthlyUsd) ? dollars.format(budget.monthlyUsd) : null;
  const remaining = finite(budget.remainingUsd) ? ` · осталось ${dollars.format(budget.remainingUsd)}` : '';
  const coverage = data.coverage || {};
  const notifications = data.notifications || state.notifications || {};
  const channels = { telegram: 'Telegram', browser: 'браузер', email: 'почта' };
  const notificationMessage = typeof notifications.message === 'string' ? notifications.message : '';
  const reviews = Array.isArray(data.review) ? data.review.filter(item => item && typeof item === 'object') : [];
  return {
    badge, tone, candidates, reviews, counts: state.counts || {},
    message: typeof state.message === 'string' && state.message.trim() ? state.message : state.transport === 'apify'
      ? 'Объявления поступают через Apify. Подтверждённые предложения попадают в таблицу по продавцам.'
      : 'Сохраняем найденные объявления и проверяем их перед добавлением в таблицу.',
    updated: date(state.updatedAt) ? `Последний импорт: ${date(state.updatedAt)}` : 'Успешный импорт пока не подтверждён',
    schedule: date(state.nextRunAt) ? `Следующий запуск: ${date(state.nextRunAt)}` : 'Следующий запуск пока не назначен',
    budget: max ? trialBudget
      ? `Тест Apify: ${spent} из ${max}${remaining}${date(budget.periodEndsAt) ? ` · до ${date(budget.periodEndsAt)}` : ''}. Сбор остановится после первой недели, исчерпания бюджета или 10 запусков на бесплатном тарифе.`
      : `Бюджет Apify за месяц: ${spent} из ${max}${remaining}`
      : 'Бюджет Apify пока не задан',
    notifications: notifications.enabled === true
      ? `Уведомления: ${channels[notifications.channel] || 'включены'}${date(notifications.lastSentAt) ? ` · последнее ${date(notifications.lastSentAt)}` : ''}.${notificationMessage ? ` ${notificationMessage}` : ''}`
      : notifications.channel === 'telegram'
        ? `Уведомления Telegram: ${notificationMessage || 'отправка приостановлена'}`
        : `Уведомления: ${notificationMessage || 'предложения видны здесь; внешние уведомления не подключены'}`,
    coverage: typeof coverage.message === 'string' && coverage.message.trim() ? coverage.message
      : 'Новые и б/у MacBook в Нижнем Новгороде. Охват ограничен настроенными поисками и доступной выдачей; полный охват Авито не подтверждён.',
    threshold: `Порог: от ${rubles(minRub)} и ${decimal.format(minPercent)}% после резерва ${rubles(reserve)} на дополнительные расходы.`,
    generatedAt: date(opportunities.generatedAt),
  };
}

function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value != null) element.textContent = String(value);
  if (className) element.className = className;
  return element;
}

function metric(label, value) {
  const wrapper = node('div');
  wrapper.append(node('dt', label), node('dd', finite(value) ? number.format(value) : '—'));
  return wrapper;
}

function candidateCard(candidate) {
  const card = node('article', null, 'avito-opportunity');
  const heading = node('h4');
  const title = typeof candidate.title === 'string' && candidate.title.trim() ? candidate.title : 'Объявление Авито';
  const url = avitoListingUrl(candidate.url);
  const link = label => {
    const element = node('a', label);
    element.href = url; element.target = '_blank'; element.rel = 'noopener noreferrer';
    return element;
  };
  heading.append(url ? link(title) : node('span', title));
  const prices = node('dl', null, 'avito-opportunity-prices');
  for (const [label, value] of [['Цена Авито', candidate.price], ['Рыночный ориентир', candidate.referencePrice]]) {
    const item = node('div'); item.append(node('dt', label), node('dd', rubles(value))); prices.append(item);
  }
  const delta = node('p', null, 'avito-opportunity-delta');
  const percent = finite(candidate.deltaPercent) ? ` · ${decimal.format(candidate.deltaPercent)}%` : '';
  delta.append(node('span', candidate.condition === 'used' ? 'Скидка к новому после резерва' : 'Потенциальная разница после резерва'), node('strong', `${rubles(candidate.estimatedDeltaRub ?? candidate.deltaRub)}${percent}`));
  card.append(heading, node('p', candidate.sellerName || 'Продавец не указан', 'avito-opportunity-seller'), prices, delta);
  if (candidate.condition === 'used') card.append(node('p', 'Б/у: сравнение с ценой нового; нужна проверка состояния', 'avito-opportunity-review'));
  else if (candidate.requiresReview) card.append(node('p', 'Нужна ручная проверка объявления', 'avito-opportunity-review'));
  const reasons = Array.isArray(candidate.reasons) ? candidate.reasons.filter(reason => typeof reason === 'string').slice(0, 3) : [];
  if (reasons.length) {
    const list = node('ul', null, 'avito-opportunity-reasons');
    list.append(...reasons.map(reason => node('li', reason))); card.append(list);
  }
  card.append(node('p', date(candidate.observedAt) ? `Проверено: ${date(candidate.observedAt)}` : 'Время проверки не указано', 'avito-opportunity-date'));
  if (url) { const action = link('Посмотреть объявление ↗'); action.className = 'avito-opportunity-link'; card.append(action); }
  return card;
}

function reviewCard(item) {
  const card = node('article', null, 'avito-review-item');
  const heading = node('h4');
  const title = typeof item.title === 'string' && item.title.trim() ? item.title : 'Объявление Авито';
  const url = avitoListingUrl(item.url);
  const label = node(url ? 'a' : 'span', title);
  if (url) { label.href = url; label.target = '_blank'; label.rel = 'noopener noreferrer'; }
  heading.append(label);
  const detail = node('p', null, 'avito-review-detail');
  const condition = { new: 'Новое', used: 'Б/у' }[item.condition] || 'Состояние требует проверки';
  detail.append(node('span', `${condition} · ${date(item.observedAt) ? `Найдено ${date(item.observedAt)}` : 'Время наблюдения не указано'}`));
  detail.append(node('span', typeof item.reason === 'string' ? item.reason : 'Характеристики требуют ручной проверки', 'avito-review-reason'));
  card.append(heading, node('p', finite(item.price) && item.price > 0 ? rubles(item.price) : 'Цена не подтверждена', 'avito-review-price'), detail);
  return card;
}

function render(data, root) {
  const summary = monitorSummary(data);
  const set = (id, value) => { document.getElementById(id).textContent = value; };
  root.dataset.tone = summary.tone;
  set('avito-monitor-badge', summary.badge);
  set('avito-monitor-message', summary.message);
  document.getElementById('avito-monitor-counts').replaceChildren(
    metric('В последней порции', summary.counts.total), metric('Принято из порции', summary.counts.accepted),
    metric('Требуют проверки', summary.counts.review), metric('Не подходят', summary.counts.excluded),
  );
  for (const field of ['updated', 'schedule', 'budget', 'notifications', 'coverage']) set(`avito-monitor-${field}`, summary[field]);
  set('avito-opportunities-count', number.format(summary.candidates.length));
  set('avito-opportunities-threshold', `${summary.threshold}${summary.generatedAt ? ` Расчёт: ${summary.generatedAt}.` : ''}`);
  const empty = document.getElementById('avito-opportunities-empty');
  empty.hidden = Boolean(summary.candidates.length);
  empty.textContent = summary.generatedAt
    ? `Пока нет предложений, прошедших порог и проверку сопоставимости. Расчёт: ${summary.generatedAt}.`
    : 'Ждём достаточно свежих объявлений и сопоставимых цен для расчёта разницы.';
  document.getElementById('avito-opportunities-list').replaceChildren(...summary.candidates.slice(0, LIMIT).map(candidateCard));
  const more = document.getElementById('avito-opportunities-more');
  more.hidden = summary.candidates.length <= LIMIT;
  more.textContent = `Показаны первые ${LIMIT} предложений из ${number.format(summary.candidates.length)}. Остальные объявления доступны в таблице ниже.`;
  document.getElementById('avito-review').hidden = summary.reviews.length === 0;
  set('avito-review-count', number.format(summary.reviews.length));
  document.getElementById('avito-review-list').replaceChildren(...summary.reviews.slice(0, REVIEW_LIMIT).map(reviewCard));
  const reviewMore = document.getElementById('avito-review-more');
  reviewMore.hidden = summary.reviews.length <= REVIEW_LIMIT;
  reviewMore.textContent = `На странице показаны первые ${REVIEW_LIMIT} из ${number.format(summary.reviews.length)} объявлений на проверке.`;
  document.getElementById('avito-monitor-content').hidden = false;
  document.getElementById('avito-monitor-error').hidden = true;
}

function startMonitor(root) {
  let pending = false;
  let timer;
  let loaded = false;
  let snapshot = '';
  async function poll() {
    clearTimeout(timer);
    if (pending || document.hidden) return;
    pending = true;
    try {
      const response = await fetch('/api/avito-monitor', { cache: 'no-store', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('Monitor unavailable');
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Monitor unavailable');
      const nextSnapshot = JSON.stringify(data);
      if (snapshot !== nextSnapshot) { render(data, root); snapshot = nextSnapshot; }
      document.getElementById('avito-monitor-error').hidden = true;
      loaded = true;
    } catch {
      const error = document.getElementById('avito-monitor-error');
      error.textContent = loaded
        ? 'Не удалось обновить мониторинг. Ниже последние полученные данные. Повторим проверку через минуту.'
        : 'Мониторинг пока недоступен. Сохранённые цены можно посмотреть в таблице ниже. Повторим проверку через минуту.';
      error.hidden = false;
      if (!loaded) {
        root.dataset.tone = 'warning';
        document.getElementById('avito-monitor-badge').textContent = 'Нет связи с мониторингом';
        document.getElementById('avito-monitor-message').textContent = 'Состояние сбора пока неизвестно.';
      }
    } finally {
      pending = false;
      if (!document.hidden) timer = setTimeout(poll, 60000);
    }
  }
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) void poll(); });
  void poll();
}

if (typeof document !== 'undefined' && document.body?.dataset.sheet === 'avito') {
  const root = document.getElementById('avito-monitor');
  if (root) startMonitor(root);
}
