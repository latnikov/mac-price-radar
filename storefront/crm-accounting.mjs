// Accounting evidence is kept separate from communication and manager deal stages.
export const saleTypes = ['demand', 'retaildemand', 'salesreturn', 'retailsalesreturn'];
export const documentNames = { demand: 'Отгрузка', retaildemand: 'Розничная продажа', salesreturn: 'Возврат', retailsalesreturn: 'Розничный возврат' };
export function remoteId(value) {
  if (value?.id) return String(value.id);
  try { return new URL(value?.meta?.href).pathname.split('/').filter(Boolean).at(-1); } catch { return null; }
}
export function currencyAmount(store, document) {
  const id = remoteId(document.rate?.currency);
  const row = id && store.db.prepare("SELECT data FROM ms_objects WHERE type='currency' AND remote_id=?").get(id);
  const currency = row ? JSON.parse(row.data) : null, code = String(currency?.isoCode || '');
  // Current exchange rates are not evidence of a historical RUB amount.
  const rub = ['RUB', '643'].includes(code.toUpperCase());
  return { code: rub ? 'RUB' : code || 'валюта не получена', amount: Number.isSafeInteger(document.sum) ? document.sum : null,
    rubKopecks: rub && Number.isSafeInteger(document.sum) ? document.sum : null };
}
export function accountingEvidence(store, counterpartyId = null) {
  const rows = store.db.prepare(`SELECT f.*,json_extract(c.data,'$.isoCode') AS currency_code FROM ms_document_facts f
    LEFT JOIN ms_objects c ON c.type='currency' AND c.remote_id=f.currency_id
    WHERE f.applicable=1 AND f.moment>='2026-01-01 00:00:00' ${counterpartyId?'AND f.counterparty_id=?':''}
    ORDER BY f.moment DESC,f.remote_id`).all(...(counterpartyId?[counterpartyId]:[]));
  let sales = 0, returns = 0, knownRubKopecks = 0, unknown = 0;
  const documents = [];
  for (const row of rows) {
    const isRub=['RUB','643'].includes(String(row.currency_code||'').toUpperCase());
    const amount={code:isRub?'RUB':row.currency_code||'валюта не получена',amount:row.amount_kopecks,rubKopecks:isRub?row.amount_kopecks:null}, returned = row.type.includes('return');
    returned ? returns++ : sales++;
    if (amount.rubKopecks === null) unknown++;
    else knownRubKopecks += (returned ? -1 : 1) * amount.rubKopecks;
    documents.push({ type: row.type, id: row.remote_id, name: row.name, moment: row.moment, ...amount });
  }
  const states = saleTypes.map(t => store.db.prepare('SELECT state,last_success FROM sync_state WHERE channel=?').get('МойСклад · ' + t));
  const complete = states.every(s => s?.state === 'ready');
  return { linked: Boolean(counterpartyId), sales, returns, knownRubKopecks, netKopecks: unknown ? null : knownRubKopecks, unknown, complete, documents };
}
