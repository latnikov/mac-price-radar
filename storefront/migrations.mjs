import { createHash } from 'node:crypto';

const migrations = [
  { version: 1, sql: `
    CREATE TABLE catalog_imports(recommendation_key TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),managed INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE customers(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',moysklad_id TEXT UNIQUE,segment TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL);
    CREATE INDEX customers_phone ON customers(phone);
    CREATE TABLE order_customers(order_id TEXT PRIMARY KEY REFERENCES orders(id),customer_id TEXT NOT NULL REFERENCES customers(id));
    CREATE TABLE dialog_customers(dialog_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customers(id));
    CREATE TABLE deals(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customers(id),order_id TEXT UNIQUE REFERENCES orders(id),title TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'new',responsible TEXT NOT NULL DEFAULT '',next_at INTEGER,lost_reason TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX deals_work ON deals(state,next_at);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,customer_id TEXT REFERENCES customers(id),deal_id TEXT REFERENCES deals(id),title TEXT NOT NULL,responsible TEXT NOT NULL DEFAULT '',due_at INTEGER,state TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL);
    CREATE TABLE fulfillment(order_id TEXT PRIMARY KEY REFERENCES orders(id),data TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL);
    CREATE TABLE order_proposals(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),data TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,accepted_at INTEGER);
    CREATE INDEX order_proposals_latest ON order_proposals(order_id,created_at DESC);
    CREATE TABLE ms_objects(type TEXT NOT NULL,remote_id TEXT NOT NULL,data TEXT NOT NULL,remote_updated TEXT,imported_at INTEGER NOT NULL,PRIMARY KEY(type,remote_id));
    CREATE TABLE sync_state(channel TEXT NOT NULL,account_id TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'pending',cursor TEXT,last_success INTEGER,last_attempt INTEGER,error TEXT,PRIMARY KEY(channel,account_id));
    CREATE TABLE costs(order_id TEXT PRIMARY KEY REFERENCES orders(id),amount_kopecks INTEGER,status TEXT NOT NULL DEFAULT 'UNKNOWN',source TEXT NOT NULL DEFAULT '',direct_cost_kopecks INTEGER NOT NULL DEFAULT 0,note TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL);
  ` },
  { version: 2, sql: `
    CREATE TABLE customer_accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,password_hash TEXT,email_verified INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE account_sessions(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,account_id TEXT NOT NULL REFERENCES customer_accounts(id));
    CREATE TABLE account_orders(account_id TEXT NOT NULL REFERENCES customer_accounts(id),order_id TEXT NOT NULL REFERENCES orders(id),evidence TEXT NOT NULL,PRIMARY KEY(account_id,order_id));
    CREATE TABLE account_tokens(hash TEXT PRIMARY KEY,email TEXT NOT NULL,kind TEXT NOT NULL,expires INTEGER NOT NULL,used_at INTEGER);
    CREATE TABLE customer_outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,destination TEXT NOT NULL,data TEXT,state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,error TEXT);
    CREATE TABLE customer_requests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES customer_accounts(id),order_id TEXT REFERENCES orders(id),body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'new',created_at INTEGER NOT NULL);
  ` },
  { version: 3, sql: `
    ALTER TABLE customer_accounts ADD COLUMN phone TEXT;
    CREATE UNIQUE INDEX customer_accounts_phone ON customer_accounts(phone) WHERE phone IS NOT NULL AND phone<>'';
  ` },
  { version: 4, sql: `
    CREATE TABLE signed_nonces(nonce TEXT PRIMARY KEY,expires INTEGER NOT NULL);
    ALTER TABLE customer_requests ADD COLUMN reply TEXT NOT NULL DEFAULT '';
    ALTER TABLE customer_requests ADD COLUMN replied_at INTEGER;
  ` },
  { version: 5, sql: `
    CREATE TABLE crm_profiles(customer_id TEXT PRIMARY KEY REFERENCES customers(id),kind TEXT NOT NULL DEFAULT 'unclassified',suggested_segment TEXT NOT NULL DEFAULT '',segment_basis TEXT NOT NULL DEFAULT '',import_source TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL);
    CREATE TABLE crm_imports(id TEXT PRIMARY KEY,channel TEXT NOT NULL,account_id TEXT NOT NULL,source_hash TEXT NOT NULL,started_at INTEGER NOT NULL,completed_at INTEGER,dialogs INTEGER NOT NULL DEFAULT 0,messages INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,UNIQUE(channel,account_id,source_hash));
    CREATE TABLE deal_events(id INTEGER PRIMARY KEY AUTOINCREMENT,deal_id TEXT NOT NULL REFERENCES deals(id),from_state TEXT,to_state TEXT NOT NULL,actor TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE TABLE telegram_connections(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,user_id TEXT NOT NULL,enabled INTEGER NOT NULL,can_reply INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE telegram_updates(update_id INTEGER PRIMARY KEY,received_at INTEGER NOT NULL);
    CREATE TABLE telegram_dialog_connections(dialog_id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES telegram_connections(id));
    CREATE INDEX dialog_customers_customer ON dialog_customers(customer_id);
    CREATE INDEX inbox_customer_tasks ON tasks(customer_id,state,due_at);
  ` },
  { version: 6, sql: `
    CREATE TABLE telegram_update_queue(update_id INTEGER PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT,received_at INTEGER NOT NULL);
    CREATE INDEX telegram_update_pending ON telegram_update_queue(state,next_at);
    CREATE TABLE inbox_archives(dialog_id TEXT PRIMARY KEY,import_id TEXT NOT NULL REFERENCES crm_imports(id),through_at INTEGER NOT NULL,message_count INTEGER NOT NULL);
    CREATE INDEX ms_objects_agent ON ms_objects(type,json_extract(data,'$.agent.meta.href'));
    CREATE TABLE deal_documents(deal_id TEXT NOT NULL REFERENCES deals(id),document_type TEXT NOT NULL,remote_id TEXT NOT NULL,linked_at INTEGER NOT NULL,PRIMARY KEY(deal_id,document_type,remote_id));
    CREATE TABLE crm_merges(id INTEGER PRIMARY KEY,source_id TEXT NOT NULL,target_id TEXT NOT NULL,actor TEXT NOT NULL,at INTEGER NOT NULL,detail TEXT NOT NULL);
  ` },
  { version: 7, sql: `
    CREATE TABLE telegram_message_versions(dialog_id TEXT NOT NULL,remote_id TEXT NOT NULL,update_id INTEGER NOT NULL,PRIMARY KEY(dialog_id,remote_id));
    CREATE TABLE telegram_connection_versions(connection_id TEXT PRIMARY KEY,update_id INTEGER NOT NULL);
    CREATE UNIQUE INDEX deal_document_once ON deal_documents(document_type,remote_id);
  ` },
];

export function migrateShop(db, now = Date.now()) {
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL)');
  for (const m of migrations) {
    const checksum = createHash('sha256').update(m.sql).digest('hex');
    const applied = db.prepare('SELECT checksum FROM schema_migrations WHERE version=?').get(m.version);
    if (applied) { if (applied.checksum !== checksum) throw new Error(`Migration ${m.version} checksum mismatch`); continue; }
    db.exec('BEGIN IMMEDIATE');
    try { db.exec(m.sql); db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(m.version, checksum, now); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}
