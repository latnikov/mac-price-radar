const procurementSources = new Set(['BSA', 'Дима']);
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
const shortDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
const timeFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const validDate = value => value && Number.isFinite(Date.parse(value));
const sourceName = name => name === 'Дима' ? 'Димы' : name;
const joinNames = names => names.map(sourceName).join(' и ');

export function priceStatus(status = {}, offers = [], now = Date.now()) {
  const today = dayFormat.format(new Date(now));
  const yesterday = dayFormat.format(new Date(now - 86400000));
  const procurement = offers.filter(offer => procurementSources.has(offer.retailer));
  const dated = procurement.map(offer => {
    const value = offer.submittedAt || offer.fetchedAt || offer.validFrom;
    return { retailer: offer.retailer, expired: now - Date.parse(value) > 24 * 3600000, day: validDate(value) ? dayFormat.format(new Date(value)) : null };
  });
  const stale = dated.filter(item => item.day && item.expired);
  const failed = (status.sources || []).filter(source => source.status && source.status !== 'success' && source.status !== 'running');
  const failedProcurement = failed.filter(source => procurementSources.has(source.retailer));
  const failedRetail = failed.filter(source => !procurementSources.has(source.retailer) && source.retailer !== 'Авито НН');
  let title = 'Цены загружены';
  let tone = 'success';
  const details = [];
  if (stale.length) {
    tone = 'warning';
    const days = [...new Set(stale.map(item => item.day))].sort();
    const allYesterday = days.length === 1 && days[0] === yesterday;
    const prefix = stale.length === procurement.length ? 'Закупочные цены' : 'Часть закупочных цен';
    const age = allYesterday ? 'за вчера' : days.at(-1) === yesterday ? 'за вчера и ранее' : `от ${shortDate.format(new Date(days.at(-1) + 'T12:00:00Z'))}${days.length > 1 ? ' и ранее' : ''}`;
    title = `${prefix} — ${age}`;
    const missingToday = failedProcurement.filter(source => source.counts?.eligibleMessages === 0);
    details.push(missingToday.length ? `Свежие прайсы ${joinNames(missingToday.map(source => source.retailer))} пока не получены. Показываем последние сохранённые цены.` : 'Для части позиций пока нет свежего прайса. Показываем последние сохранённые цены.');
  } else if (failedProcurement.length) {
    tone = 'warning';
    title = 'Закупочные цены обновились не полностью';
    details.push(`Не удалось получить полный прайс ${joinNames(failedProcurement.map(source => source.retailer))}. Показываем последние сохранённые цены.`);
  } else if (dated.some(item => !item.day)) {
    tone = 'warning';
    title = 'Дата части закупочных цен неизвестна';
    details.push('У этих позиций нет даты прайса. Уточните цену у поставщика.');
  }
  if (failedRetail.length) {
    if (tone === 'success') { tone = 'warning'; title = 'Не все магазины обновили цены'; }
    details.push(`Не обновились: ${failedRetail.map(source => source.retailer).join(', ')}. Их предыдущие цены сохранены.`);
  }
  if (status.avito) {
    const avito = status.avito;
    const staleAvito = avito.updatedAt && now - Date.parse(avito.updatedAt) > 2 * 3600000;
    if (avito.state === 'not_configured') details.push('Авито: сборщик подготовлен, доступ к объявлениям ещё не подтверждён.');
    else if (avito.state === 'blocked') {
      details.push('Авито ограничил доступ. Показываем только ранее проверенные объявления.');
      if (validDate(avito.retryAfter)) details.push(`Новая попытка Авито — не раньше ${shortDate.format(new Date(avito.retryAfter))}, ${timeFormat.format(new Date(avito.retryAfter))} мск.`);
    }
    else if (avito.state === 'running') details.push(avito.counts?.discovered
      ? `Авито: найдено ${avito.counts.discovered}, проверено карточек ${avito.counts.detailed || 0}.`
      : 'Собираем объявления Авито.');
    else if (avito.state === 'error' || avito.state === 'partial' || staleAvito) details.push('Авито: нет полного свежего среза. Проверяйте время у объявлений.');
    else if (avito.state === 'ready') details.push(`Авито: проверено ${avito.counts?.detailed || 0} объявлений.`);
    if (['not_configured', 'blocked', 'error', 'partial'].includes(avito.state) || staleAvito) {
      if (tone === 'success') { tone = 'warning'; title = 'Цены магазинов загружены · Авито ожидает обновления'; }
    }
  }
  if ((status.error || ['error', 'interrupted', 'degraded'].includes(status.state)) && !failed.length) {
    tone = 'warning';
    if (!stale.length) title = 'Обновление цен не завершилось';
    details.push('Показываем последние сохранённые цены. Обновление можно запустить ещё раз.');
  }
  if (!details.length && validDate(status.updatedAt)) details.push(`Последняя проверка — ${shortDate.format(new Date(status.updatedAt))}, ${timeFormat.format(new Date(status.updatedAt))} мск.`);
  if (!details.length) details.push('Показываем последние сохранённые предложения магазинов.');
  if (status.state === 'running') {
    if (tone === 'warning') details.unshift(`${title}.`);
    title = 'Обновляем цены';
    tone = 'loading';
    details.unshift(status.total ? `Проверено источников: ${status.completed || 0} из ${status.total}.` : 'Проверяем источники. Это займёт немного времени.');
  }
  const schedule = [];
  if (status.autoRefreshIntervalMs > 0) {
    const minutes = Math.round(status.autoRefreshIntervalMs / 60000);
    schedule.push(minutes === 60 ? 'Автообновление каждый час' : `Автообновление раз в ${minutes} мин`);
    if (validDate(status.nextRefreshAt) && Date.parse(status.nextRefreshAt) > now) {
      const sameDay = dayFormat.format(new Date(status.nextRefreshAt)) === today;
      schedule.push(`следующее ${sameDay ? 'в' : shortDate.format(new Date(status.nextRefreshAt)) + ' в'} ${timeFormat.format(new Date(status.nextRefreshAt))} мск`);
    }
  }
  return { title, detail: details.join(' '), schedule: schedule.join(' · '), tone };
}
