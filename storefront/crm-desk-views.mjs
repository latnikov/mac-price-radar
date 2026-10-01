import { esc, csrf, hidden, when, rub } from './views.mjs';
import { dealStates } from './retail.mjs';
import { customerKinds } from './crm-desk.mjs';

const duration = ms => ms == null ? '—' : ms < 60000 ? '< 1 мин' : ms < 3600000 ? `${Math.round(ms / 60000)} мин` : ms < 86400000 ? `${Math.round(ms / 3600000)} ч` : `${Math.round(ms / 86400000)} дн`;
export function deskSummary(desk) {
  const m = desk.metrics();
  return `<h2>Продажи и общение</h2><div class="crm-metrics"><div class="box"><b>${m.contacts}</b><br>контактов</div><div class="box"><b>${m.dialogs}</b><br>диалогов</div><div class="box"><b>${m.waiting}</b><br>последнее сообщение клиента</div><div class="box"><b>${m.reminders}</b><br>напоминаний просрочено</div></div>
    <p class="muted">Контакты архива ещё требуют проверки: среди них могут быть поставщики и личные знакомые. Старый диалог не считается новой сделкой.</p>
    <h3>Продажи по документам с 1 января 2026</h3><p>${m.accounting.sales} проведённых продаж, ${m.accounting.returns} возвратов. Сумма документов в рублях после возвратов: <b>${rub(m.accounting.knownRubKopecks/100)}</b>.</p>${m.accounting.unknown?`<p class="notice">Ещё ${m.accounting.unknown} документов требуют проверки валюты и не включены в сумму.</p>`:''}${!m.accounting.complete?'<p class="notice">Синхронизация учёта ещё неполная. Итог может измениться.</p>':''}<p class="muted">Это сумма проведённых документов, без расчёта прибыли. Налоги, себестоимость и доставка требуют отдельной сверки.</p><h3>Воронка сделок</h3><div class="crm-metrics">${Object.entries(dealStates).map(([k, name]) => `<a class="box" href="/crm/deals?state=${k}"><b>${m.stages.find(s => s.state === k)?.n || 0}</b><br>${esc(name)}</a>`).join('')}</div>
    <p>Выигранных среди закрытых сделок: ${(() => { const won=m.stages.find(s=>s.state==='won')?.n||0,lost=m.stages.find(s=>s.state==='lost')?.n||0;return won+lost?`${Math.round(100*won/(won+lost))}%`:'недостаточно данных'; })()}.</p>
    <h3>Сегменты контактов</h3>${m.segment.map(s => `<p><a href="/crm/contacts?segment=${encodeURIComponent(s.name)}">${esc(s.name)}</a> · ${s.n}</p>`).join('')}<p class="muted">Неподтверждённые сегменты — предложения по словам в переписке.</p>`;
}
export function contactDirectory(desk, options, s) {
  const result = desk.contacts(options);
  const params = new URLSearchParams({ q: options.q || '', segment: options.segment || '', kind: options.kind || '' });
  return `<h2>Контакты и клиенты · ${result.total}</h2><p><a href="/crm/customers/new">Добавить контакт</a></p><form><label>Имя, телефон или email<input name="q" value="${esc(options.q)}"></label><label>Сегмент<input name="segment" value="${esc(options.segment)}"></label><label>Тип<select name="kind"><option value="">Все</option>${Object.entries(customerKinds).map(([k,v])=>`<option value="${k}"${options.kind===k?' selected':''}>${esc(v)}</option>`).join('')}</select></label><button>Найти</button></form>
    ${result.rows.map(c => `<div class="box"><a href="/crm/customers/${c.id}">${esc(c.name || c.phone || 'Контакт')}</a><p>${esc(c.segment || c.suggested_segment || 'Не определён')}${!c.segment && c.suggested_segment ? ' · предложено' : ''}</p><small>${c.moysklad_id?'МойСклад · ':''}${esc(customerKinds[c.kind || 'unclassified'])} · диалогов ${c.dialog_count} · открытых сделок ${c.open_deals}</small></div>`).join('')}
    <nav>${options.offset ? `<a href="?${params}&offset=${Math.max(0,options.offset-50)}">← Назад</a>` : ''}${options.offset+50<result.total?`<a href="?${params}&offset=${options.offset+50}">Дальше →</a>`:''}</nav>`;
}
export function customerPanel(desk, dialogId, s) {
  const c = desk.context(dialogId), customer = c.customer;
  return `<section class="crm-panel"><h3><a href="/crm/customers/${customer.id}">${esc(customer.name || 'Контакт')}</a></h3>
    <p>${esc(customer.phone)} ${esc(customer.email)}</p><form method="post" action="/crm/desk/${dialogId}/customer">${csrf(s)}${hidden('customerId',customer.id)}
    <label>Тип контакта<select name="kind">${Object.entries(customerKinds).map(([k,v])=>`<option value="${k}"${(c.profile?.kind||'unclassified')===k?' selected':''}>${esc(v)}</option>`).join('')}</select></label>
    <label>Подтверждённый сегмент<input name="segment" value="${esc(customer.segment)}" maxlength="100"></label>
    ${!customer.segment&&c.profile?.suggested_segment?`<small>Предложено: ${esc(c.profile.suggested_segment)}. ${esc(c.profile.segment_basis)}</small>`:''}
    <label>Заметки<textarea name="note" maxlength="3000">${esc(customer.note)}</textarea></label><button>Сохранить карточку</button></form>
    <h3>Общение</h3><p>Средний ответ по загруженной переписке: <b>${duration(c.communication.average_ms)}</b> · ответов ${c.communication.samples}</p>
    <p>Ожидание после последнего сообщения: ${duration(c.communication.waiting_ms)}</p>
    <h3>Сделки</h3>${c.deals.map(d=>`<p><a href="/crm/deals/${d.id}">${esc(d.title)}</a><br>${esc(dealStates[d.state])} · ${esc(d.responsible)}<br>Следующий контакт: ${when(d.next_at)}</p>`).join('')||'<p>Активность архива ещё не подтверждена как сделка.</p>'}
    <form method="post" action="/crm/desk/${dialogId}/deal">${csrf(s)}<label>Новая сделка<input name="title" maxlength="250" required placeholder="Подбор MacBook"></label><button>Создать сделку</button></form>
    <h3>Напомнить менеджеру</h3>${c.tasks.map(t=>`<div class="box"><b>${esc(t.title)}</b><p>${when(t.due_at)}${t.due_at&&t.due_at<Date.now()?' · просрочено':''}</p><form method="post" action="/crm/tasks/${t.id}/done">${csrf(s)}<button>Выполнено</button></form></div>`).join('')}
    <form method="post" action="/crm/desk/${dialogId}/remind">${csrf(s)}<label>Что сделать<input name="title" maxlength="250" required></label><label>Ответственный<input name="responsible" maxlength="120"></label><label>Когда, московское время<input name="dueAt" type="datetime-local" required></label><button>Добавить напоминание</button></form>
    <h3>Продажи МойСклад</h3><p>${!c.accounting.linked?'Контрагент пока не сопоставлен':`${c.accounting.sales} продаж с 01.01.2026 · ${c.accounting.netKopecks===null?'сумма требует проверки валюты':rub(c.accounting.netKopecks/100)} после возвратов`}</p>
    <p class="muted">Прибыль без подтверждённой себестоимости не вычисляется.</p><p><a href="/crm/desk/link?dialog=${dialogId}">Выбрать общую карточку / контрагента МойСклад</a></p>
    ${c.accounting.linked?`<p><a href="/crm/customers/${customer.id}/accounting">Открыть документы и суммы →</a></p>`:''}<h3>Другие диалоги контакта</h3>${c.dialogs.map(d=>`<p><a href="/crm/desk?dialog=${d.id}">${esc(d.label)} · ${esc(d.title)}</a></p>`).join('')}</section>`;
}
export function deskView(inbox, desk, session, options, threadHtml = '', sendReason = '') {
  const accounts = inbox.accounts(), rows = inbox.list({ ...options, limit: 30 });
  const params = new URLSearchParams({ q: options.q || '', account: options.accountId || '', unread: options.unread ? '1' : '' });
  return `<h2>Единая переписка</h2><p><a href="/crm/sales">Метрики и воронка</a> · <a href="/crm/contacts">Клиенты и сегменты</a> · <a href="/crm/tasks">Напоминания</a> · <a href="/crm/integrations">Подключения</a></p>
    <div class="crm-workspace"><section class="crm-panel"><form><label>Поиск<input name="q" value="${esc(options.q)}"></label><label>Канал<select name="account"><option value="">Все аккаунты</option>${accounts.map(a=>`<option value="${a.id}"${a.id===options.accountId?' selected':''}>${esc(a.label)}${a.state==='archive'?' · архив':''}</option>`).join('')}</select></label><label><input type="checkbox" name="unread" value="1"${options.unread?' checked':''}> Непрочитанные</label><button>Найти</button></form>
    ${rows.map(d=>`<article class="crm-chat${d.id===options.dialogId?' selected':''}"><small>${esc(d.account_label)} · ${when(d.updated_at)}</small><h4><a href="/crm/desk?${params}&dialog=${d.id}#thread">${esc(d.title)}</a></h4><p>${esc(String(d.preview||'').slice(0,100))}</p></article>`).join('')}
    <nav>${options.offset?`<a href="?${params}&offset=${Math.max(0,options.offset-30)}">←</a>`:''}${rows.length===30?`<a href="?${params}&offset=${options.offset+30}">Дальше →</a>`:''}</nav></section>
    <section class="crm-thread" id="thread">${sendReason?`<p class="notice">${esc(sendReason)}</p>`:''}${threadHtml||'<p>Выберите диалог слева. Здесь появятся переписка и поле ответа.</p>'}</section>
    ${options.dialogId?customerPanel(desk,options.dialogId,session):'<section class="crm-panel"><h3>Карточка клиента</h3><p>Сделка, этап, напоминания и метрики будут рядом с выбранным диалогом.</p></section>'}</div>`;
}

export function contactLinkView(desk, dialogId, options, s) {
  const result = desk.contacts(options), current = desk.context(dialogId).customer;
  const params = new URLSearchParams({dialog:dialogId,q:options.q||''});
  return `<h2>Связать диалог с карточкой клиента</h2><p><a href="/crm/desk?dialog=${dialogId}">← Переписка</a></p><p>Сейчас: <a href="/crm/customers/${current.id}">${esc(current.name)}</a>. Выберите существующего клиента или контрагента МойСклад после проверки личности. Перенесётся связь этого диалога; заметки, сделки и заказы останутся в прежней карточке.</p>
    <form>${hidden('dialog',dialogId)}<label>Имя, телефон или email<input name="q" value="${esc(options.q)}"></label><button>Найти</button></form><p>Карточек: ${result.total}</p>
    ${result.rows.map(c=>`<div class="box"><b>${esc(c.name||'Контакт')}</b> · ${c.moysklad_id?'МойСклад':'CRM'}<p>${esc(c.phone)} ${esc(c.email)}</p><form method="post" action="/crm/desk/${dialogId}/link">${csrf(s)}${hidden('customerId',c.id)}<button${c.id===current.id?' disabled':''}>${c.id===current.id?'Текущая карточка':'Связать этот диалог'}</button></form></div>`).join('')}
    <nav>${options.offset?`<a href="?${params}&offset=${Math.max(0,options.offset-50)}">← Назад</a>`:''}${options.offset+50<result.total?`<a href="?${params}&offset=${options.offset+50}">Дальше →</a>`:''}</nav>`;
}
