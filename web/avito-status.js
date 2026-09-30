export function avitoStatus(state, now=Date.now()) {
  if(!state)return '';
  const route=state.transport==='apify'?' через Apify':state.transport==='proxy'?' через отдельный прокси':'';
  const n=state.counts?.detailed;
  const count=Number.isFinite(n)?` Последняя порция: ${n} карточек.`:'';
  if(state.state==='blocked'){
    const reasons={region_restriction:'ограничен доступ из региона',ip_restriction:'Авито ограничил IP',captcha:'Авито запросил проверку в браузере',rate_limit:'Авито ограничил частоту запросов',authentication:'Авито запросил авторизацию',access_denied:'Авито отказал в доступе'};
    const at=Date.parse(state.retryAfter),pause=at>now?` Следующая попытка после ${new Date(at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК.`:' Ожидается следующая попытка.';
    return `Сбор Авито${route} приостановлен: ${reasons[state.access?.reason]||'доступ ограничен'}.${pause}${count} Сохранённые цены не становятся свежими от повторного импорта.`;
  }
  if(state.state==='running')return `Сбор Авито${route} идёт небольшими порциями.${count}`;
  if(state.state==='partial')return `Сбор Авито${route}: получена часть объявлений.${count} Полный охват не подтверждён.`;
  if(state.state==='error')return `Сбор Авито${route} не завершён. Требуется проверка соединения или формата страниц.${count}`;
  if(state.state==='ready'&&state.transport!=='apify')return `Последняя выдача Авито проверена полностью.${count}`;
  if(state.transport==='apify' && state.message)return `Авито через Apify: ${state.message}`;
  return 'Сборщик Авито ожидает настройки доступа.';
}
