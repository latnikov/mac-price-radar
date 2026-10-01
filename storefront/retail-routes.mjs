import { fail } from './core.mjs';
import { esc, csrf, when } from './views.mjs';
import { importPriceCatalog } from './macbook-catalog.mjs';
import { customerList, customerEditor, dealEditor, dealsList, tasksView, crmOrderView } from './retail-views.mjs';

export async function retailRoutes({ path, req, res, url, s, form, store, retail, adminRender, redirect, sync }) {
  if (path === '/crm/products/import' && req.method === 'POST') {
    if (s.role !== 'owner') throw fail(403, 'Импорт доступен владельцу.');
    importPriceCatalog(store, { publish: form.publish === 'on', actor: s.role });
    store.setSetting('catalog_auto_import', form.publish === 'on');
    redirect(res, '/crm/products'); return true;
  }
  if (path === '/crm/customers' && req.method !== 'POST') { adminRender('Клиенты', customerList(retail, String(url.searchParams.get('q') || '').slice(0, 100), s)); return true; }
  if (path === '/crm/customers/save' && req.method === 'POST') { const c = retail.saveCustomer(form, s.role); redirect(res, `/crm/customers/${c.id}`); return true; }
  if (path === '/crm/customers/new' && req.method !== 'POST') { adminRender('Новый клиент', customerEditor(null, [], [], s)); return true; }
  const customerPath = path.match(/^\/crm\/customers\/([a-f0-9-]{36})$/);
  if (customerPath && req.method !== 'POST') {
    const c = retail.customer(customerPath[1]); if (!c) throw fail(404, 'Клиент не найден.');
    const dialogs = store.db.prepare('SELECT d.*,a.label FROM inbox_dialogs d JOIN dialog_customers c ON c.dialog_id=d.id JOIN inbox_accounts a ON a.id=d.account_id WHERE c.customer_id=? ORDER BY d.updated_at DESC LIMIT 50').all(c.id);
    adminRender('Клиент', customerEditor(c, retail.customerOrders(c.id), dialogs, s)); return true;
  }
  const link = path.match(/^\/crm\/inbox\/([a-f0-9]{64})\/link$/);
  if (link && req.method === 'POST') { retail.linkDialog(link[1], form.customerId, s.role); redirect(res, `/crm/inbox/${link[1]}`); return true; }
  if (path === '/crm/deals' && req.method !== 'POST') { adminRender('Сделки', dealsList(retail.deals())); return true; }
  if (path === '/crm/deals/new' && req.method !== 'POST') { adminRender('Новая сделка', dealEditor(null, retail.customers(), s, url.searchParams.get('customer'))); return true; }
  if (path === '/crm/deals/save' && req.method === 'POST') { const id = retail.saveDeal(form, s.role); redirect(res, `/crm/deals/${id}`); return true; }
  const dealPath = path.match(/^\/crm\/deals\/([a-f0-9-]{36})$/);
  if (dealPath && req.method !== 'POST') { const d = store.db.prepare('SELECT * FROM deals WHERE id=?').get(dealPath[1]); if (!d) throw fail(404, 'Сделка не найдена.'); adminRender('Сделка', dealEditor(d, retail.customers(), s)); return true; }
  if (path === '/crm/tasks' && req.method !== 'POST') { adminRender('Задачи', tasksView(retail.tasks(), s)); return true; }
  if (path === '/crm/tasks/save' && req.method === 'POST') { retail.saveTask(form, s.role); redirect(res, '/crm/tasks'); return true; }
  const taskPath = path.match(/^\/crm\/tasks\/([a-f0-9-]{36})\/done$/);
  if (taskPath && req.method === 'POST') { retail.finishTask(taskPath[1], s.role); redirect(res, '/crm/tasks'); return true; }
  const orderPath = path.match(/^\/crm\/orders\/(MB-[A-F0-9]{12})(?:\/(shipment|propose|accept|cost))?$/);
  if (orderPath) {
    const o = store.db.prepare('SELECT * FROM orders WHERE id=?').get(orderPath[1]); if (!o) throw fail(404, 'Заказ не найден.');
    if (req.method === 'POST') {
      if (orderPath[2] === 'shipment') retail.updateShipment(o.id, form, s.role);
      else if (orderPath[2] === 'propose') retail.propose(o.id, form, s.role);
      else if (orderPath[2] === 'accept') { const evidence = String(form.evidence || '').trim(); if (!evidence || evidence.length > 250) throw fail(400, 'Укажите основание подтверждения покупателем.'); retail.accept(o.id, form.proposalId, s.role, evidence); }
      else if (orderPath[2] === 'cost') { if (s.role !== 'owner') throw fail(403, 'Финансовые данные доступны владельцу.'); retail.saveCost(o.id, form, s.role); }
      else {if(['confirmed','fulfilling','completed'].includes(form.state)&&retail.fulfillment(o.id).data.state==='pending')throw fail(409,'Сначала согласуйте доставку с покупателем.');store.updateOrder(o.id, form.state, String(form.note || ''), s.role);}
      redirect(res, `/crm/orders/${o.id}`);
    } else if (!orderPath[2]) adminRender(o.id, crmOrderView(o, retail.orderData(o), retail, s));
    else throw fail(405, 'Метод не поддерживается.');
    return true;
  }
  if (['/crm/stock','/crm/accounting'].includes(path) && req.method !== 'POST') {
    const stock=path==='/crm/stock',allowed=['counterparty','product','variant','customerorder','supply','demand','salesreturn','enter','loss','paymentin','cashin'];
    const type=stock?'stock':(allowed.includes(url.searchParams.get('type'))?url.searchParams.get('type'):'customerorder');
    const q=String(url.searchParams.get('q')||'').slice(0,100),offset=Math.max(0,Math.trunc(Number(url.searchParams.get('offset')))||0);
    const count=store.db.prepare("SELECT COUNT(*) n FROM ms_objects WHERE type=? AND (?='' OR instr(lower(data),lower(?))>0)").get(type,q,q).n;
    const rows=store.db.prepare("SELECT * FROM ms_objects WHERE type=? AND (?='' OR instr(lower(data),lower(?))>0) ORDER BY remote_updated DESC,remote_id LIMIT 50 OFFSET ?").all(type,q,q,offset);
    const names={counterparty:'Контрагенты',product:'Товары',variant:'Модификации',customerorder:'Заказы',supply:'Приёмки',demand:'Отгрузки',salesreturn:'Возвраты',enter:'Оприходования',loss:'Списания',paymentin:'Входящие платежи',cashin:'Приходные ордера'};
    const checkpoint=store.db.prepare('SELECT * FROM sync_state WHERE channel=?').get(stock?'МойСклад · остатки':`МойСклад · ${type}`);
    adminRender(stock?'Остатки МойСклад':'Данные МойСклад',`<h2>${stock?'Текущие остатки МойСклад':'Данные МойСклад'}</h2><p><a href="/crm/integrations">Подключения</a> · <a href="/crm/stock">Остатки</a> · <a href="/crm/accounting">Документы и товары</a></p>${checkpoint?.state!=='ready'?'<p class="notice">Данные могут быть неполными или устаревшими. Проверьте синхронизацию.</p>':''}<small>Последнее полное обновление: ${when(checkpoint?.last_success)}</small><form>${stock?'':`<label>Раздел<select name="type">${allowed.map(k=>`<option value="${k}"${k===type?' selected':''}>${names[k]}</option>`).join('')}</select></label>`}<label>Поиск<input name="q" maxlength="100" value="${esc(q)}"></label><button>Найти</button></form><p>Записей: ${count}</p>${rows.map(row=>{const d=JSON.parse(row.data);return `<div class="box"><b>${esc(d.name||d.code||row.remote_id)}</b><p>${esc(d.moment||d.updated||'')}</p>${stock?`<p>Остаток: ${esc(d.stock??'неизвестен')} · доступно: ${esc(d.quantity??'неизвестно')} · резерв: ${esc(d.reserve??'неизвестен')}</p>`:['product','variant'].includes(type)?`<p>Код: ${esc(d.code||'')} · артикул: ${esc(d.article||'')}</p>`:d.sum!=null?`<p>Сумма документа: ${Number(d.sum/100).toLocaleString('ru-RU')} ₽</p>`:''}<small>UUID: ${esc(row.remote_id)}</small></div>`;}).join('')||'<p>Нет полученных записей.</p>'}<nav>${offset>0?`<a href="${path}?${new URLSearchParams({type,q,offset:String(Math.max(0,offset-50))})}">← Назад</a>`:''} ${offset+50<count?`<a href="${path}?${new URLSearchParams({type,q,offset:String(offset+50)})}">Дальше →</a>`:''}</nav><p class="muted">Документы учёта не означают автоматически признанную прибыль. Закуп, возвраты и платежи проверяются отдельно.</p>`);return true;
  }
  const requestPath=path.match(/^\/crm\/requests\/([a-f0-9-]{36})\/reply$/);
  if(requestPath&&req.method==='POST'){
    const reply=String(form.reply||'').trim();if(!reply||reply.length>2000)throw fail(400,'Ответ должен содержать от 1 до 2000 символов.');
    if(!store.db.prepare("UPDATE customer_requests SET reply=?,replied_at=?,state='done' WHERE id=?").run(reply,store.now(),requestPath[1]).changes)throw fail(404,'Обращение не найдено.');
    store.audit(s.role,'customer_request_replied',requestPath[1]);redirect(res,'/crm/requests');return true;
  }
  if (path === '/crm/requests' && req.method !== 'POST') {
    const rows = store.db.prepare('SELECT r.*,a.email FROM customer_requests r JOIN customer_accounts a ON a.id=r.account_id ORDER BY r.created_at DESC LIMIT 100').all();
    adminRender('Обращения из кабинета', `<h2>Обращения покупателей</h2>${rows.map(r => `<div class="box"><b>${esc(r.email)}</b> · ${when(r.created_at)}<p class="description">${esc(r.body)}</p>${r.reply?`<p class="description">Ответ: ${esc(r.reply)}</p>`:''}<form method="post" action="/crm/requests/${r.id}/reply">${csrf(s)}<label>Ответ в кабинет<textarea name="reply" maxlength="2000" required></textarea></label><button>Ответить покупателю</button></form>${r.order_id ? `<p><a href="/crm/orders/${r.order_id}">${r.order_id}</a></p>` : ''}</div>`).join('') || '<p>Обращений пока нет.</p>'}`); return true;
  }
  if (path === '/crm/integrations/run' && req.method === 'POST') { if (s.role !== 'owner') throw fail(403, 'Обмен запускает владелец.'); await sync(); redirect(res, '/crm/integrations'); return true; }
  if (path === '/crm/integrations' && req.method !== 'POST') {
    const rows = store.db.prepare('SELECT * FROM sync_state ORDER BY channel,account_id').all();
    adminRender('Интеграции', `<h2>Получение данных</h2><p><a href="/crm/prices">Цены dev</a> · <a href="/crm/channels">Публикации и очередь</a> · <a href="/crm/requests">Обращения из кабинета</a> · <a href="/crm/stock">Остатки</a> · <a href="/crm/accounting">МойСклад: документы</a></p><form method="post" action="/crm/integrations/run">${csrf(s)}<button>Обновить подключённые источники</button></form>${rows.map(r => `<div class="box"><b>${esc(r.channel)}${r.account_id ? ` · ${esc(r.account_id)}` : ''}</b><p>${esc(({ ready: 'Обновлено', partial: 'История неполная', blocked: 'Нужны настройки', error: 'Ошибка обмена', syncing: 'Обновляется', pending: 'Ожидает подключения' })[r.state] || r.state)}</p><small>Последнее успешное обновление: ${when(r.last_success)}</small>${r.error ? `<p>${esc(r.error)}</p>` : ''}</div>`).join('')}`); return true;
  }
  return false;
}
