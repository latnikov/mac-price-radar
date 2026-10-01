import { esc, rub, when, csrf, hidden, stateNames } from './views.mjs';
import { deliveryNames, shipmentNames } from './checkout-data.mjs';
export function accountForm(s, { register = false, mailEnabled = false, values = {} } = {}) {
  return `<div class="auth"><h2>${register ? 'Создать личный кабинет' : 'Войти в личный кабинет'}</h2><p class="muted">Заказы, доставка и связь с Макбучной.</p><form method="post" action="/account/${register ? 'register' : 'login'}">${csrf(s)}
    ${register ? `<label>Email<input type="email" name="email" value="${esc(values.email)}" autocomplete="email" maxlength="254" required></label><label>Телефон<input type="tel" name="phone" value="${esc(values.phone)}" autocomplete="tel" maxlength="24" required></label>` : `<label>Email или телефон<input name="identifier" value="${esc(values.identifier)}" autocomplete="username" maxlength="254" required></label>`}
    <label>Пароль<input type="password" name="password" minlength="10" maxlength="128" autocomplete="${register ? 'new-password' : 'current-password'}" required></label>
    ${register ? '<p class="muted">От 10 символов.</p><label><input type="checkbox" name="consent" required> Согласен на <a href="/privacy">обработку данных</a>.</label>' : ''}<button class="primary">${register ? 'Создать кабинет' : 'Войти'}</button></form>
    <p><a href="/account/${register ? 'login' : 'register'}">${register ? 'Уже есть аккаунт? Войти' : 'Создать аккаунт'}</a>${!register && mailEnabled ? ' · <a href="/account/forgot">Забыли пароль?</a>' : !register?' · <a href="/contacts">Помощь со входом</a>':''}</p><p><a href="/">Продолжить покупки</a></p></div>`;
}
export function accountHome(account, orders, requests, s) {
  return `<h2>Личный кабинет</h2><p>${esc(account.email)} · ${esc(account.phone)}</p><h3>Ваши заказы</h3>${orders.map(o => `<div class="box"><a href="/orders/${o.id}">${o.id}</a> · ${esc(stateNames[o.state])}<p>${esc(JSON.parse(o.data).lines.map(l => l.title).join(', '))}</p><small>${when(o.created_at)}</small></div>`).join('') || '<p>Здесь появятся заказы, оформленные из кабинета или добавленные из вашей текущей сессии.</p>'}
    <h3>Написать в Макбучную</h3><form method="post" action="/account/support">${csrf(s)}<label>Заказ<select name="orderId"><option value="">Общий вопрос</option>${orders.map(o => `<option>${o.id}</option>`).join('')}</select></label><label>Сообщение<textarea name="body" maxlength="2000" required></textarea></label><button>Отправить менеджеру</button></form>
    ${requests.length ? `<h3>Ваши обращения</h3>${requests.map(r => `<div class="box"><p class="description">${esc(r.body)}</p>${r.reply?`<p class="description"><b>Макбучная:</b> ${esc(r.reply)}</p><small>${when(r.replied_at)}</small>`:''}<small>${when(r.created_at)} · ${r.state === 'new' ? 'Получено' : 'Обработано'}</small></div>`).join('')}` : ''}
    <form method="post" action="/account/logout">${csrf(s)}<button>Выйти</button></form>`;
}
export function receiptView(o, d, proposal, s) {
  const f = d.delivery || { method: 'pickup', feeKopecks: 0, state: 'confirmed' };
  return `<h2>Спасибо! Заказ получен.</h2><p>Ваш номер: <b>${o.id}</b> · ${esc(stateNames[o.state])}</p><div class="box">${d.lines.map(l => `<p>${esc(l.title)} × ${l.qty}<br>${rub(l.priceRub == null ? null : l.priceRub * l.qty)}</p>`).join('')}
    <p>Товары: <b>${rub(d.totalRub)}</b></p><p>${esc(deliveryNames[f.method])}${f.city ? ` · ${esc(f.city)}` : ''}${f.address ? `<br>${esc(f.address)}` : ''}</p><p>Доставка: ${f.feeKopecks == null ? 'Стоимость уточняется' : rub(f.feeKopecks / 100)}</p>
    <p class="price">${d.totalRub != null && f.feeKopecks != null ? `Итого: ${rub(d.totalRub + f.feeKopecks / 100)}` : 'Итог согласуем с вами'}</p>
    <p>${esc(shipmentNames[f.state] || '')}${f.estimatedDate ? ` · ${esc(f.estimatedDate)}` : ''}</p>${f.tracking ? `<p>Перевозчик: ${esc(f.carrier)}<br>Трек-номер: <b>${esc(f.tracking)}</b></p>` : ''}</div>
    ${proposal ? `<section class="box"><h3>Проверьте условия заказа</h3>${proposal.data.lines.map(l => `<p>${esc(l.title)} × ${l.qty}: ${rub(l.priceRub * l.qty)}</p>`).join('')}<p>Доставка: ${rub(proposal.data.delivery.feeKopecks / 100)}<br>Срок: ${esc(proposal.data.delivery.estimatedDate)}</p><p class="price">Итого: ${rub(proposal.data.totalKopecks / 100)}</p><form method="post" action="/orders/${o.id}/accept">${csrf(s)}${hidden('proposalId', proposal.id)}<button class="primary">Подтвердить эти условия</button></form></section>` : ''}
    <p>Мы свяжемся с вами и подтвердим условия и срок получения.</p><p><a href="/account">Заказы в личном кабинете</a> · <a href="/">Вернуться в каталог</a></p>`;
}
export function deliveryView() {
  return '<h2>Доставка и самовывоз</h2><div class="box"><h3>Самовывоз</h3><p>Нижний Новгород, Грузинская, 41а. Без платы за доставку. Время получения согласуем при подтверждении заказа.</p></div><div class="box"><h3>По Нижнему Новгороду</h3><p>Выберите доставку при оформлении. Адрес, стоимость и срок подтвердит менеджер.</p></div><div class="box"><h3>По России</h3><p>Укажите город; адрес или пункт выдачи можно уточнить позже. Мы согласуем отправку, её стоимость и срок, затем добавим трек-номер в заказ.</p></div><p>Оплата после подтверждения. До согласования стоимость доставки не включена в сумму товаров.</p>';
}
