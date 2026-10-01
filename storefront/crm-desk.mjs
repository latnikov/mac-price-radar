import { accountingEvidence } from './crm-accounting.mjs';
import { fail } from './core.mjs';

export const customerKinds = { unclassified: 'Не разобрано', lead: 'Клиент / обращение', customer: 'Покупатель по учёту', supplier: 'Поставщик', personal: 'Личный контакт' };
export function suggestSegment(body) {
  const value = String(body || '').toLowerCase();
  if (/трейд.?ин|trade.?in|обмен.*доплат|выкуп/.test(value)) return 'Trade-in / выкуп';
  if (/ремонт|диагностик|замен.{0,12}(экран|батаре|клавиатур)/.test(value)) return 'Сервис';
  if (/оптом|оптов|партия|поставщик/.test(value)) return 'Опт / партнёры';
  if (/iphone|айфон/.test(value)) return 'iPhone';
  if (/macbook|макбук|mac mini|imac|mac studio/.test(value)) return 'Mac';
  return 'Не определён';
}
export function openCrmDesk(store, inbox, retail) {
  const { db, now, tx, audit } = store;
  function ensureCustomer(dialogId, { name, segment = '', source = '' } = {}) {
    const existing = db.prepare('SELECT customer_id FROM dialog_customers WHERE dialog_id=?').get(dialogId);
    if (existing) return existing.customer_id;
    const d = inbox.dialog(dialogId); if (!d) throw fail(404, 'Диалог не найден.');
    return tx(() => {
      const c = retail.saveCustomer({ name: String(name || d.title || 'Контакт').slice(0, 120) }, 'import');
      retail.linkDialog(d.id, c.id, 'import');
      db.prepare('INSERT INTO crm_profiles VALUES(?,?,?,?,?,?)').run(c.id, 'unclassified', segment,
        segment && segment !== 'Не определён' ? 'Предложено по словам в переписке; требует проверки' : '', source || d.channel, now());
      return c.id;
    });
  }
  function reconcileDialogs() {
    const rows = db.prepare(`SELECT d.id,d.title,a.channel FROM inbox_dialogs d JOIN inbox_accounts a ON a.id=d.account_id
      LEFT JOIN dialog_customers c ON c.dialog_id=d.id WHERE c.dialog_id IS NULL`).all();
    tx(() => { for (const d of rows) ensureCustomer(d.id, { source: d.channel }); });
    return rows.length;
  }
  function setKind(customerId, kind, actor) {
    if (!retail.customer(customerId) || !Object.hasOwn(customerKinds, kind)) throw fail(400, 'Выберите тип контакта.');
    if (kind === 'customer' && !accounting(customerId).sales) throw fail(400, 'Сначала свяжите клиента с проведённой продажей МойСклад.');
    db.prepare(`INSERT INTO crm_profiles(customer_id,kind,updated_at) VALUES(?,?,?) ON CONFLICT(customer_id)
      DO UPDATE SET kind=excluded.kind,updated_at=excluded.updated_at`).run(customerId, kind, now());
    audit(actor, 'customer_kind_set', customerId);
  }
  function contacts({ q = '', segment = '', kind = '', offset = 0 } = {}) {
    const where = `WHERE (?='' OR instr(casefold(c.name||' '||c.phone||' '||c.email),casefold(?))>0)
      AND (?='' OR c.segment=? OR (c.segment='' AND COALESCE(NULLIF(p.suggested_segment,''),'Не определён')=?)) AND (?='' OR COALESCE(p.kind,'unclassified')=?)`;
    const args = [q, q, segment, segment, segment, kind, kind];
    const total = db.prepare(`SELECT COUNT(*) n FROM customers c LEFT JOIN crm_profiles p ON p.customer_id=c.id ${where}`).get(...args).n;
    const rows = db.prepare(`SELECT c.*,p.kind,p.suggested_segment,
      (SELECT COUNT(*) FROM dialog_customers x WHERE x.customer_id=c.id) dialog_count,
      (SELECT COUNT(*) FROM deals x WHERE x.customer_id=c.id AND x.state NOT IN ('won','lost')) open_deals
      FROM customers c LEFT JOIN crm_profiles p ON p.customer_id=c.id ${where} ORDER BY c.updated_at DESC,c.id LIMIT 50 OFFSET ?`).all(...args, offset);
    return { total, rows };
  }
  function context(dialogId) {
    const id = ensureCustomer(dialogId), customer = retail.customer(id);
    return { customer, profile: db.prepare('SELECT * FROM crm_profiles WHERE customer_id=?').get(id),
      deals: db.prepare('SELECT * FROM deals WHERE customer_id=? ORDER BY updated_at DESC LIMIT 20').all(id),
      tasks: db.prepare("SELECT * FROM tasks WHERE customer_id=? AND state='open' ORDER BY COALESCE(due_at,9223372036854775807) LIMIT 20").all(id),
      dialogs: db.prepare('SELECT d.*,a.label FROM dialog_customers c JOIN inbox_dialogs d ON d.id=c.dialog_id JOIN inbox_accounts a ON a.id=d.account_id WHERE c.customer_id=? ORDER BY d.updated_at DESC LIMIT 30').all(id),
      communication: dialogMetrics(dialogId), accounting: accounting(id) };
  }
  function dialogMetrics(id) {
    // Adjacent inbound -> outbound measures delay from the most recent client message.
    const rows = db.prepare(`WITH ordered AS (
      SELECT direction,created_at,LAG(direction) OVER(ORDER BY created_at,id) previous_direction,
        LAG(created_at) OVER(ORDER BY created_at,id) previous_at FROM inbox_messages WHERE dialog_id=? AND direction IN ('in','out'))
      SELECT COUNT(*) samples,AVG(created_at-previous_at) average_ms FROM ordered WHERE direction='out' AND previous_direction='in'`).get(id);
    const last = db.prepare("SELECT direction,created_at FROM inbox_messages WHERE dialog_id=? AND direction IN ('in','out') ORDER BY created_at DESC,id DESC LIMIT 1").get(id);
    return { ...rows, waiting_ms: last?.direction === 'in' ? Math.max(0, now() - last.created_at) : null, last_direction: last?.direction };
  }
  function accounting(customerId) {
    const c = retail.customer(customerId);
    return c?.moysklad_id ? accountingEvidence(store, c.moysklad_id) : { linked: false, sales: 0, netKopecks: null, documents: [] };
  }
  function linkContact(dialogId, customerId, actor) {
    const target = retail.customer(customerId), oldId = ensureCustomer(dialogId);
    if (!target) throw fail(404, 'Карточка не найдена.');
    if (oldId === customerId) return;
    tx(() => {
      retail.linkDialog(dialogId, customerId, actor);
      db.prepare('INSERT INTO crm_merges(source_id,target_id,actor,at,detail) VALUES(?,?,?,?,?)')
        .run(oldId, customerId, actor, now(), JSON.stringify({ dialogId, operation: 'link_dialog' }));
    });
    // Notes, deals and customer account access remain with their original records.
  }
  function metrics() {
    return { accounting: accountingEvidence(store), contacts: db.prepare('SELECT COUNT(*) n FROM customers').get().n,
      dialogs: db.prepare('SELECT COUNT(*) n FROM inbox_dialogs').get().n,
      stages: db.prepare('SELECT state,COUNT(*) n FROM deals GROUP BY state').all(),
      reminders: db.prepare("SELECT COUNT(*) n FROM tasks WHERE state='open' AND due_at<=?").get(now()).n,
      waiting: db.prepare(`SELECT COUNT(*) n FROM inbox_dialogs d WHERE
        (SELECT direction FROM inbox_messages WHERE dialog_id=d.id AND direction IN ('in','out') ORDER BY created_at DESC,id DESC LIMIT 1)='in'`).get().n,
      segment: db.prepare("SELECT COALESCE(NULLIF(c.segment,''),NULLIF(p.suggested_segment,''),'Не определён') name,COUNT(*) n FROM customers c LEFT JOIN crm_profiles p ON p.customer_id=c.id GROUP BY name ORDER BY n DESC").all() };
  }
  function remind(customerId, input, actor) {
    if (!input.dueAt) throw fail(400, 'Укажите срок напоминания.');
    return retail.saveTask({ ...input, customerId }, actor);
  }
  return { ensureCustomer, reconcileDialogs, setKind, contacts, context, dialogMetrics, accounting, linkContact, metrics, remind };
}
