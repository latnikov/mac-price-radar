import { randomUUID } from 'node:crypto';
import { fail } from './core.mjs';
import { cleanField, shipmentNames, rublesToKopecks } from './checkout-data.mjs';

export const dealStates = { new: 'Новая', contacted: 'Связались', offered: 'Предложение', waiting: 'Ждём решения', won: 'Выиграна', lost: 'Потеряна' };
export const costStatuses = ['FACT', 'MANUAL', 'ESTIMATE', 'UNKNOWN'];
const parse = row => row && { ...row, data: JSON.parse(row.data) };
const boundedNote = value => { const text = String(value ?? '').trim(); if (text.length > 3000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw fail(400, 'Сократите заметку.'); return text; };

export function openRetail(store) {
  const { db, tx, now, audit } = store;
  function customer(id) { return db.prepare('SELECT * FROM customers WHERE id=?').get(id); }
  function saveCustomer(input, actor = 'owner') {
    return tx(() => {
      const old = input.id ? customer(input.id) : null;
      if (input.id && !old) throw fail(404, 'Клиент не найден.');
      const id = old?.id || randomUUID();
      const name = cleanField(input.name ?? old?.name, 120, 'Имя'), phone = cleanField(input.phone ?? old?.phone, 24, 'Телефон');
      const email = cleanField(input.email ?? old?.email, 254, 'Email'), segment = cleanField(input.segment ?? old?.segment, 100, 'Сегмент');
      db.prepare(`INSERT INTO customers(id,name,phone,email,segment,note,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,phone=excluded.phone,email=excluded.email,segment=excluded.segment,note=excluded.note,updated_at=excluded.updated_at`)
        .run(id, name, phone, email, segment, boundedNote(input.note ?? old?.note), now());
      audit(actor, 'customer_saved', id); return customer(id);
    });
  }
  function attachOrder(id, session, contact) {
    const existing = db.prepare('SELECT customer_id FROM order_customers WHERE order_id=?').get(id);
    if (existing) return customer(existing.customer_id);
    const matches = db.prepare('SELECT * FROM customers WHERE phone=?').all(contact.phone);
    const c = matches.length === 1 ? matches[0] : saveCustomer(contact, 'customer');
    db.prepare('INSERT INTO order_customers VALUES(?,?)').run(id, c.id);
    const order = db.prepare('SELECT data,created_at FROM orders WHERE id=?').get(id), data = JSON.parse(order.data);
    const dealId = randomUUID();
    db.prepare('INSERT INTO deals(id,customer_id,order_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(dealId, c.id, id, data.lines.map(l => l.title).join(' + ').slice(0, 250), order.created_at, now());
    db.prepare('INSERT INTO costs(order_id,updated_at) VALUES(?,?)').run(id, now());
    db.prepare('INSERT INTO fulfillment VALUES(?,?,1,?)').run(id, JSON.stringify(data.delivery || { method: 'pickup', feeKopecks: 0, state: 'confirmed' }), now());
    store.hooks.accountOrderCreated?.(id, session, contact);
    return c;
  }
  store.hooks.orderCreated = attachOrder;
  // Backfill relationships once without changing accepted historical snapshots.
  tx(() => { for (const o of db.prepare('SELECT o.* FROM orders o LEFT JOIN order_customers c ON c.order_id=o.id WHERE c.order_id IS NULL').all()) attachOrder(o.id, null, JSON.parse(o.data)); });
  function customers(q = '') {
    return db.prepare(`SELECT c.*,(SELECT COUNT(*) FROM order_customers x WHERE x.customer_id=c.id) AS order_count,
      (SELECT COUNT(*) FROM dialog_customers x WHERE x.customer_id=c.id) AS dialog_count FROM customers c
      WHERE ?='' OR instr(lower(c.name||' '||c.phone||' '||c.email),lower(?))>0 ORDER BY c.updated_at DESC LIMIT 100`).all(q, q);
  }
  const customerOrders = id => db.prepare('SELECT o.* FROM orders o JOIN order_customers c ON c.order_id=o.id WHERE c.customer_id=? ORDER BY o.created_at DESC LIMIT 100').all(id);
  function linkDialog(dialogId, customerId, actor) {
    if (!customer(customerId) || !db.prepare('SELECT id FROM inbox_dialogs WHERE id=?').get(dialogId)) throw fail(404, 'Клиент или диалог не найден.');
    db.prepare('INSERT INTO dialog_customers VALUES(?,?) ON CONFLICT(dialog_id) DO UPDATE SET customer_id=excluded.customer_id').run(dialogId, customerId);
    audit(actor, 'dialog_customer_linked', dialogId);
  }
  function saveDeal(input, actor) {
    return tx(() => {
      const old = input.id ? db.prepare('SELECT * FROM deals WHERE id=?').get(input.id) : null;
      if (input.id && !old) throw fail(404, 'Сделка не найдена.');
      if (old && old.revision !== Number(input.revision)) throw fail(409, 'Сделка изменена другим сотрудником. Обновите страницу.');
      const state = input.state || old?.state || 'new';
      if (!Object.hasOwn(dealStates, state)) throw fail(400, 'Выберите этап сделки.');
      const lost = cleanField(input.lostReason, 200, 'Причина потери');
      if (state === 'lost' && !lost) throw fail(400, 'Укажите причину потери сделки.');
      const c = customer(input.customerId || old?.customer_id); if (!c) throw fail(400, 'Выберите клиента.');
      const rawNext = String(input.nextAt || '');
      const nextAt = rawNext ? Date.parse(rawNext) : null;
      if (rawNext && !Number.isFinite(nextAt)) throw fail(400, 'Проверьте дату следующего действия.');
      const id = old?.id || randomUUID(), title = cleanField(input.title || old?.title, 250, 'Сделка');
      if (!title) throw fail(400, 'Укажите название сделки.');
      db.prepare(`INSERT INTO deals(id,customer_id,order_id,title,state,responsible,next_at,lost_reason,note,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,state=excluded.state,responsible=excluded.responsible,next_at=excluded.next_at,lost_reason=excluded.lost_reason,note=excluded.note,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(id, c.id, old?.order_id || null, title, state, cleanField(input.responsible, 120, 'Ответственный'), nextAt, lost, boundedNote(input.note), (old?.revision || 0) + 1, old?.created_at || now(), now());
      audit(actor, 'deal_saved', id); return id;
    });
  }
  const deals = () => db.prepare('SELECT d.*,c.name,c.phone FROM deals d JOIN customers c ON c.id=d.customer_id ORDER BY d.updated_at DESC LIMIT 100').all();
  function saveTask(input, actor) {
    const title = cleanField(input.title, 250, 'Задача'); if (!title) throw fail(400, 'Укажите задачу.');
    const dueAt = input.dueAt ? Date.parse(input.dueAt) : null;
    if (input.dueAt && !Number.isFinite(dueAt)) throw fail(400, 'Проверьте срок задачи.');
    if (input.customerId && !customer(input.customerId)) throw fail(404, 'Клиент не найден.');
    const id = randomUUID();
    db.prepare('INSERT INTO tasks(id,customer_id,title,responsible,due_at,created_at) VALUES(?,?,?,?,?,?)').run(id, input.customerId || null, title, cleanField(input.responsible, 120, 'Ответственный'), dueAt, now());
    audit(actor, 'task_created', id); return id;
  }
  function finishTask(id, actor) { if (!db.prepare("UPDATE tasks SET state='done' WHERE id=? AND state='open'").run(id).changes) throw fail(409, 'Задача уже завершена или не найдена.'); audit(actor, 'task_completed', id); }
  const tasks = () => db.prepare('SELECT t.*,c.name FROM tasks t LEFT JOIN customers c ON c.id=t.customer_id ORDER BY t.state,COALESCE(t.due_at,9223372036854775807),t.created_at DESC LIMIT 100').all();
  const fulfillment = id => parse(db.prepare('SELECT * FROM fulfillment WHERE order_id=?').get(id));
  const proposal = id => parse(db.prepare("SELECT * FROM order_proposals WHERE order_id=? AND state='pending' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id));
  function propose(id, input, actor) {
    return tx(() => {
      const row = db.prepare('SELECT * FROM orders WHERE id=?').get(id); if (!row) throw fail(404, 'Заказ не найден.');
      if (['cancelled', 'returned', 'completed'].includes(row.state)) throw fail(409, 'Заказ уже закрыт.');
      if (db.prepare("SELECT 1 FROM publications WHERE entity='order' AND entity_id=? AND channel='moysklad' AND remote_id IS NOT NULL").get(id)) throw fail(409, 'Документ уже создан в МойСклад: изменение цены требует сверки с учётом.');
      const original = JSON.parse(row.data), current = fulfillment(id);
      if (current.revision !== Number(input.revision)) throw fail(409, 'Условия доставки изменились. Обновите страницу.');
      const feeKopecks = rublesToKopecks(input.shippingRub);
      const lines = original.lines.map(l => ({ ...l, priceRub: rublesToKopecks(input[`price_${l.id}`] ?? l.priceRub) / 100 }));
      if (lines.some(l => l.priceRub <= 0)) throw fail(400, 'Укажите согласованную цену каждого товара.');
      if (current.data.method === 'pickup' && feeKopecks !== 0) throw fail(400, 'Самовывоз не имеет платы за доставку.');
      const goodsKopecks = lines.reduce((n, l) => n + Math.round(l.priceRub * 100) * l.qty, 0);
      const delivery = { ...current.data, feeKopecks, state: 'confirmed', estimatedDate: cleanField(input.estimatedDate, 100, 'Срок'), address: cleanField(input.address ?? current.data.address, 250, 'Адрес') };
      if (!delivery.estimatedDate) throw fail(400, 'Укажите согласованный срок получения.');
      db.prepare("UPDATE order_proposals SET state='superseded' WHERE order_id=? AND state='pending'").run(id);
      const proposalId = randomUUID();
      db.prepare('INSERT INTO order_proposals(id,order_id,data,created_at) VALUES(?,?,?,?)').run(proposalId, id, JSON.stringify({ lines, goodsKopecks, totalKopecks: goodsKopecks + feeKopecks, delivery, fulfillmentRevision: current.revision }), now());
      audit(actor, 'order_terms_proposed', id); return proposalId;
    });
  }
  function accept(id, proposalId, actor, evidence = 'customer') {
    return tx(() => {
      const p = parse(db.prepare('SELECT * FROM order_proposals WHERE id=? AND order_id=?').get(proposalId, id));
      if (!p) throw fail(404, 'Предложение не найдено.');
      if (p.state === 'accepted') return;
      if (p.state !== 'pending') throw fail(409, 'Условия изменились. Проверьте новое предложение.');
      const current = fulfillment(id);
      const order = db.prepare('SELECT state FROM orders WHERE id=?').get(id);
      if (current.revision !== p.data.fulfillmentRevision || ['cancelled', 'returned', 'completed'].includes(order?.state)) throw fail(409, 'Заказ изменился. Обновите условия.');
      db.prepare("UPDATE order_proposals SET state='accepted',accepted_at=? WHERE id=?").run(now(), p.id);
      db.prepare('UPDATE fulfillment SET data=?,revision=revision+1,updated_at=? WHERE order_id=?').run(JSON.stringify(p.data.delivery), now(), id);
      db.prepare("UPDATE orders SET state='confirmed' WHERE id=?").run(id);
      db.prepare("UPDATE jobs SET state='queued',next_at=0,error=NULL WHERE entity='order' AND entity_id=? AND channel='moysklad' AND state='blocked'").run(id);
      audit(actor, 'order_terms_accepted', `${id}:${evidence}`);
    });
  }
  function orderData(row) {
    const original = JSON.parse(row.data);
    const accepted = parse(db.prepare("SELECT * FROM order_proposals WHERE order_id=? AND state='accepted' ORDER BY accepted_at DESC,rowid DESC LIMIT 1").get(row.id));
    const delivery = fulfillment(row.id)?.data || original.delivery;
    return accepted ? { ...original, lines: accepted.data.lines, totalRub: accepted.data.goodsKopecks / 100, grandTotalRub: accepted.data.totalKopecks / 100, delivery } : { ...original, delivery };
  }
  store.orderData = orderData;
  function updateShipment(id, input, actor) {
    return tx(() => {
      const current = fulfillment(id); if (!current) throw fail(404, 'Заказ не найден.');
      if (Number(input.revision) !== current.revision) throw fail(409, 'Доставка изменена. Обновите страницу.');
      const state = input.state; if (!Object.hasOwn(shipmentNames, state)) throw fail(400, 'Выберите состояние доставки.');
      if (current.data.state === 'pending' && state !== 'pending' && state !== 'cancelled') throw fail(409, 'Сначала согласуйте стоимость и срок с покупателем.');
      const transitions = { pending: ['pending', 'cancelled'], confirmed: ['confirmed', 'shipped', 'delivered', 'cancelled'], shipped: ['shipped', 'delivered', 'cancelled'], delivered: ['delivered'], cancelled: ['cancelled'] };
      if (!transitions[current.data.state]?.includes(state)) throw fail(409, 'Недопустимый переход доставки.');
      const data = { ...current.data, state, carrier: cleanField(input.carrier, 100, 'Перевозчик'), tracking: cleanField(input.tracking, 100, 'Трек-номер') };
      if (state === 'shipped' && current.data.method !== 'pickup' && (!data.carrier || !data.tracking)) throw fail(400, 'Укажите перевозчика и трек-номер.');
      db.prepare('UPDATE fulfillment SET data=?,revision=revision+1,updated_at=? WHERE order_id=?').run(JSON.stringify(data), now(), id);
      audit(actor, 'shipment_updated', id);
    });
  }
  function saveCost(id, input, actor) {
    const status = input.status; if (!costStatuses.includes(status)) throw fail(400, 'Выберите достоверность закупа.');
    const amount = status === 'UNKNOWN' ? null : rublesToKopecks(input.costRub);
    const source = cleanField(input.source, 250, 'Основание');
    if (status !== 'UNKNOWN' && !source) throw fail(400, 'Укажите документ или основание себестоимости.');
    db.prepare('INSERT INTO costs VALUES(?,?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET amount_kopecks=excluded.amount_kopecks,status=excluded.status,source=excluded.source,direct_cost_kopecks=excluded.direct_cost_kopecks,note=excluded.note,updated_at=excluded.updated_at')
      .run(id, amount, status, source, rublesToKopecks(input.directRub || '0'), boundedNote(input.note), now());
    audit(actor, 'order_cost_saved', id);
  }
  function economics(id) {
    const row = db.prepare('SELECT * FROM orders WHERE id=?').get(id), cost = db.prepare('SELECT * FROM costs WHERE order_id=?').get(id);
    if (!row) return null;
    const d = orderData(row), goods = d.totalRub === null ? null : Math.round(d.totalRub * 100);
    return { ...cost, goodsKopecks: goods, contributionKopecks: cost?.amount_kopecks === null || cost?.amount_kopecks === undefined || goods === null ? null : goods - cost.amount_kopecks - cost.direct_cost_kopecks,
      recognized: false, recognitionNote: 'Факт выручки и прибыли подтверждается документами учёта' };
  }
  return { customer, saveCustomer, customers, customerOrders, linkDialog, saveDeal, deals, saveTask, finishTask, tasks, fulfillment, proposal, propose, accept, orderData, updateShipment, saveCost, economics };
}
