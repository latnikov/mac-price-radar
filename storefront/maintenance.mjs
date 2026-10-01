// Expiring operational data only. Orders, correspondence, stock and accounting stay intact.
export function maintainShop(store) {
  const at = store.now(), db = store.db;
  const removed = store.tx(() => {
    const clean = (sql, ...args) => Number(db.prepare(sql).run(...args).changes);
    return {
      sessions: clean('DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires<? LIMIT 5000)', at),
      limits: clean('DELETE FROM limits WHERE key IN (SELECT key FROM limits WHERE expires<? LIMIT 5000)', at),
      checkouts: clean('DELETE FROM checkouts WHERE id IN (SELECT id FROM checkouts WHERE expires<? AND NOT EXISTS (SELECT 1 FROM orders WHERE checkout_id=checkouts.id) LIMIT 5000)', at),
      tokens: clean('DELETE FROM account_tokens WHERE expires<?', at - 86400000),
      nonces: clean('DELETE FROM signed_nonces WHERE expires<?', at),
      telegramEvents: clean("DELETE FROM telegram_update_queue WHERE state IN ('processed','ignored') AND received_at<?", at - 7 * 86400000),
    };
  });
  db.exec('PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE)');
  store.setSetting('maintenance', { at, removed });
  return removed;
}
