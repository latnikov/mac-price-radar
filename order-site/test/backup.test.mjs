import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupOrders } from '../backup.mjs';

test('order backup is a consistent, immutable SQLite copy with a checksum', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orders-backup-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE orders(id TEXT PRIMARY KEY, payload TEXT);');
  db.prepare('INSERT INTO orders VALUES (?,?)').run('one', '{"phone":"+79990000000"}');
  const target = join(dir, 'backup');
  const manifest = await backupOrders(source, target);
  db.prepare('INSERT INTO orders VALUES (?,?)').run('two', '{}');
  db.close();
  const copy = new DatabaseSync(join(target, 'orders.sqlite'), { readOnly: true });
  try { assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1); }
  finally { copy.close(); }
  assert.equal(manifest.orders, 1);
  assert.equal(manifest.sha256, createHash('sha256').update(readFileSync(join(target, 'orders.sqlite'))).digest('hex'));
  await assert.rejects(backupOrders(source, target), /EEXIST/);
});
