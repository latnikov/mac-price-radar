import { esc, csrf, hidden, when } from './views.mjs';

const channelName = channel => channel === 'avito' ? 'Авито' : 'Telegram';
const deliveryName = { draft: 'Черновик', sending: 'Отправляется', sent: 'Отправлено', unknown: 'Проверьте отправку на площадке' };
const syncName = { pending: 'Ожидает подключения', importing: 'Загружается', ready: 'История загружена', partial: 'История загружена не полностью' };

export function inboxList(inbox, { q = '', accountId = '', unread = false, offset = 0 } = {}) {
  const accounts = inbox.accounts(), rows = inbox.list({ q, accountId, unread, offset });
  const params = new URLSearchParams({ q, account: accountId, unread: unread ? '1' : '' });
  return `<h2>Переписка с клиентами</h2><p>Диалоги двух профилей Авито и рабочего Telegram появятся здесь после подключения каждого аккаунта.</p>
    ${accounts.map(a => `<p><b>${esc(a.label)}</b> · ${channelName(a.channel)} · ${esc(syncName[a.state] || a.state)}${a.synced_at ? ` · ${when(a.synced_at)}` : ''}</p>`).join('')}
    <form><label>Поиск по имени или переписке<input name="q" value="${esc(q)}" maxlength="100"></label>
    <label>Аккаунт<select name="account"><option value="">Все аккаунты</option>${accounts.map(a => `<option value="${a.id}"${accountId === a.id ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}</select></label>
    <label><input type="checkbox" name="unread" value="1"${unread ? ' checked' : ''}> Только непрочитанные на площадке</label><button>Найти</button></form>
    ${rows.map(d => `<article class="box"><small>${esc(d.account_label)} · ${channelName(d.channel)} · ${when(d.updated_at)}</small>
    <h3><a href="/crm/inbox/${d.id}">${esc(d.title)}</a>${d.unread > 0 ? ' <span class="badge">Непрочитано</span>' : ''}</h3>
    <p>${esc(String(d.preview || '').slice(0, 180))}</p>${d.segment ? `<small>${esc(d.segment)}</small>` : ''}</article>`).join('') || '<p>Диалогов пока нет. Нужно подключить аккаунты и загрузить историю.</p>'}
    <nav>${offset > 0 ? `<a href="?${params}&offset=${Math.max(0, offset - 50)}">← Назад</a>` : ''}${rows.length === 50 ? `<a href="?${params}&offset=${offset + 50}">Дальше →</a>` : ''}</nav>`;
}

export function inboxDialog(inbox, d, session, { offset = 0, canSend = false } = {}) {
  const messages = inbox.messages(d.id, offset), outgoing = inbox.outgoing(d.id);
  return `<p><a href="/crm/inbox">← Все диалоги</a></p><h2>${esc(d.title)}</h2>
    <p><b>${esc(d.account_label)}</b> · ${channelName(d.channel)} · ${d.unread < 0 ? 'Площадка не передала статус прочтения' : d.unread > 0 ? 'Непрочитано на площадке' : 'Прочитано на площадке'}</p>
    ${!d.history_complete ? '<p class="notice">История загружена не полностью. Здесь может быть только последнее сообщение.</p>' : ''}
    <form method="post" action="/crm/inbox/${d.id}/profile">${csrf(session)}<label>Сегмент<input name="segment" maxlength="100" value="${esc(d.segment)}" placeholder="Например: подбор MacBook"></label>
    <label>Заметки о клиенте<textarea name="note" maxlength="5000">${esc(d.note)}</textarea></label><button>Сохранить</button></form>
    <h3>История переписки</h3>${messages.map(m => `<div class="box"><small>${m.direction === 'out' ? 'Наш ответ' : m.direction === 'in' ? 'Клиент' : 'Служебное сообщение'} · ${when(m.created_at)}</small><p class="description">${esc(m.body)}</p>${m.kind !== 'text' ? '<small>Вложение пока доступно в исходном мессенджере.</small>' : ''}</div>`).join('') || '<p>История сообщений ещё не получена.</p>'}
    <nav>${messages.length === 100 ? `<a href="?offset=${offset + 100}">Более ранние сообщения</a>` : ''}${offset > 0 ? `<a href="?offset=${Math.max(0, offset - 100)}">Более новые сообщения</a>` : ''}</nav>
    <h3>Ответить клиенту</h3><p>Ответ уйдёт с аккаунта <b>${esc(d.account_label)}</b>.</p>
    ${!canSend ? '<p class="notice">Отправка для этого аккаунта пока не включена. Можно сохранить черновик.</p>' : ''}
    <form method="post" action="/crm/inbox/${d.id}/draft">${csrf(session)}<label>Сообщение<textarea name="body" rows="5" maxlength="4000" required></textarea></label><button>Сохранить черновик</button></form>
    ${outgoing.map(m => `<div class="box"><b>${esc(deliveryName[m.state])}</b><p class="description">${esc(m.body)}</p>${m.state === 'draft' && canSend ? `<form method="post" action="/crm/inbox/${d.id}/send">${csrf(session)}${hidden('replyId', m.id)}<button class="primary">Отправить с ${esc(d.account_label)}</button></form>` : ''}</div>`).join('')}`;
}
