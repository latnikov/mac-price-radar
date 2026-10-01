import { esc, csrf, hidden } from './views.mjs';
import { accountForm, accountHome, deliveryView, receiptView } from './customer-views.mjs';
import { normalizeAccountPhone } from './accounts.mjs';

export async function customerRoutes({ path, req, res, url, s, form, store, accounts, retail, render, redirect, cookie }) {
  if (path === '/delivery' && req.method !== 'POST') { render('Доставка', deliveryView()); return true; }
  if (path === '/account' && req.method !== 'POST') {
    const a = accounts.current(s);
    if (!a) { redirect(res, '/account/login'); return true; }
    const requests = store.db.prepare('SELECT * FROM customer_requests WHERE account_id=? ORDER BY created_at DESC LIMIT 20').all(a.id);
    render('Личный кабинет', accountHome(a, accounts.orders(s), requests, s)); return true;
  }
  if (['/account/login', '/account/register'].includes(path)) {
    const register = path.endsWith('register');
    if (req.method === 'POST') {
      if (!store.limit(`account:${s.ipKey}`, register ? 5 : 10, 15 * 60000)) throw Object.assign(new Error('Слишком много попыток. Попробуйте через 15 минут.'), { status: 429 });
      try { const next = await (register ? accounts.register(form, s) : accounts.login(form, s)); cookie(res, next); redirect(res, '/account'); }
      catch (e) { if ([400, 401, 409].includes(e.status)) render('Личный кабинет', accountForm(s, { register, mailEnabled: accounts.mailConfigured(), values: form }), { status: e.status, notice: e.message, error: true }); else throw e; }
    } else render('Личный кабинет', accountForm(s, { register, mailEnabled: accounts.mailConfigured() }));
    return true;
  }
  if (path === '/account/logout' && req.method === 'POST') { cookie(res, accounts.logout(s)); redirect(res, '/'); return true; }
  if (path === '/account/support' && req.method === 'POST') { accounts.support(form, s); redirect(res, '/account'); return true; }
  if (path === '/account/forgot') {
    if (req.method === 'POST') {
      if (!store.limit(`reset:${s.ipKey}`, 3, 15 * 60000)) throw Object.assign(new Error('Попробуйте позже.'), { status: 429 });
      accounts.requestReset(form.email); render('Восстановление доступа', '<h2>Проверьте почту</h2><p>Если аккаунт найден, вы получите ссылку для восстановления. Если письмо не пришло, обратитесь в Макбучную.</p><p><a href="/account/login">Вернуться ко входу</a></p>');
    } else render('Восстановление доступа', `<div class="auth"><h2>Восстановить доступ</h2><form method="post">${csrf(s)}<label>Email<input type="email" name="email" maxlength="254" required></label><button>Получить ссылку</button></form></div>`);
    return true;
  }
  if (path.startsWith('/account/'))res.setHeader('Referrer-Policy','no-referrer');
  if (path === '/account/reset') {
    if (req.method === 'POST') { const next = await accounts.reset(form.token, form.password, s); cookie(res, next); redirect(res, '/account'); }
    else render('Новый пароль', `<div class="auth"><h2>Новый пароль</h2><form method="post">${csrf(s)}${hidden('token', String(url.searchParams.get('token') || '').slice(0, 100))}<label>Пароль<input type="password" name="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><button>Сохранить</button></form></div>`);
    return true;
  }
  const order = path.match(/^\/orders\/(MB-[A-F0-9]{12})(\/accept)?$/);
  if (order) {
    if (!accounts.canViewOrder(order[1], s)) throw Object.assign(new Error('Заказ не найден.'), { status: 404 });
    const row = store.db.prepare('SELECT * FROM orders WHERE id=?').get(order[1]);
    if (order[2] && req.method === 'POST') { retail.accept(row.id, form.proposalId, `account:${accounts.current(s)?.id || 'guest'}`); redirect(res, `/orders/${row.id}`); }
    else if (!order[2] && req.method !== 'POST') render('Ваш заказ', receiptView(row, retail.orderData(row), retail.proposal(row.id), s));
    else throw Object.assign(new Error('Метод не поддерживается.'), { status: 405 });
    return true;
  }
  if (path === '/request') {
    if (req.method === 'POST') {
      const phone = normalizeAccountPhone(form.phone);
      if (form.consent !== 'on') throw Object.assign(new Error('Подтвердите согласие на обработку данных.'), { status: 400 });
      store.tx(()=>{const c = retail.saveCustomer({ name: form.name, phone });
      retail.saveDeal({ customerId: c.id, title: form.description, note: 'Запрос конфигурации с сайта' }, 'customer');});
      render('Запрос получен', '<h2>Спасибо! Запрос получен.</h2><p>Менеджер свяжется с вами, чтобы подобрать MacBook и согласовать цену.</p>');
    } else render('Подобрать MacBook', `<h2>Какой MacBook вы ищете?</h2><form method="post">${csrf(s)}<label>Модель и конфигурация<textarea name="description" maxlength="250" required>${esc(String(url.searchParams.get('model') || '').slice(0, 100))}</textarea></label><label>Телефон<input type="tel" name="phone" maxlength="24" required></label><label>Имя<input name="name" maxlength="100"></label><label><input type="checkbox" name="consent" required> Согласен на <a href="/privacy">обработку данных</a>.</label><button class="primary">Отправить запрос</button></form>`);
    return true;
  }
  return false;
}
