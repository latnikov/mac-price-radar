import { DatabaseSync } from 'node:sqlite';
import { hash } from './core.mjs';

// The old order database remains the immutable source of its accepted quotes.
// CRM imports by original ID, without publishing products or resending notifications.
export function syncLegacyOrders(store, retail, sourcePath) {
  if (!sourcePath) return 0;
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let imported = 0;
  let skippedTests = 0;
  try {
    for (const row of source.prepare('SELECT id,payload,request_key,created_at FROM orders ORDER BY created_at').all()) {
      if (row.id === 'MB-RELAY-TEST') { skippedTests++; continue; }
      if (!/^MB-[A-F0-9]{8}$/.test(row.id)) throw new Error('Unexpected legacy order ID');
      const fingerprint = hash(row.payload);
      const old = store.db.prepare('SELECT source_hash FROM legacy_order_sources WHERE order_id=?').get(row.id);
      if (old) {
        if (old.source_hash !== fingerprint) throw new Error('Accepted legacy order changed');
        continue;
      }
      const payload = JSON.parse(row.payload);
      if (!payload.phone || (!payload.configurationDescription && !payload.configuration)) throw new Error('Incomplete legacy order');
      // Early versions saved configuration fields before introducing the description.
      // Preserve that exact configuration; never recalculate its historical quote.
      const description = payload.configurationDescription || JSON.stringify(payload.configuration);
      const priceRub = Number.isInteger(payload.priceRub) && payload.priceRub > 0 ? payload.priceRub : null;
      const data = { phone: payload.phone, name: payload.name || '', email: '', comment: '', payment: payload.paymentMethod || 'cash',
        consentVersion: payload.consentVersion, totalRub: priceRub, grandTotalRub: null,
        legacySource: 'order', legacyConfiguration: payload.configuration, pricingAsOf: payload.pricingAsOf, priceStatus: payload.priceStatus,
        delivery: { method: 'pickup', city: '', address: '', feeKopecks: null, state: 'pending', carrier: '', tracking: '', estimatedDate: '' },
        lines: [{ id: 'legacy:' + row.id, qty: 1, title: description, specification: description,
          priceRub, active: true, revision: null, recommendationKey: null, moyskladId: null, moyskladType: null, individual: false }] };
      store.tx(() => {
        store.db.prepare('INSERT INTO orders(id,checkout_id,session_id,fingerprint,data,created_at) VALUES(?,?,?,?,?,?)')
          .run(row.id, 'legacy:' + row.request_key, 'legacy:' + row.id, fingerprint, JSON.stringify(data), row.created_at);
        store.db.prepare('INSERT INTO legacy_order_sources VALUES(?,?,?,?)').run(row.id, fingerprint, row.payload, store.now());
        // No remote job is created: historical quotes still require manual reconciliation.
        store.hooks.orderCreated?.(row.id, null, data);
        store.audit('legacy_import', 'order_imported', row.id);
      });
      imported++;
    }
    store.setSetting('legacy_orders_sync', { at: store.now(), imported, skippedTests, ok: true });
    return imported;
  } finally { source.close(); }
}
