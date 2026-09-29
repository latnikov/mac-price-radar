import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function backupOrders(source, target) {
  if (!source || !target) throw new Error('Source database and a new backup directory are required');
  const directory = resolve(target);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const db = new DatabaseSync(source, { readOnly: true });
  const destination = join(directory, 'orders.sqlite');
  try {
    await backup(db, destination);
    await chmod(destination, 0o600);
    const restored = new DatabaseSync(destination, { readOnly: true });
    let count;
    try {
      if (restored.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Order backup failed integrity check');
      count = restored.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    } finally { restored.close(); }
    const manifest = { createdAt: new Date().toISOString(), orders: count,
      sha256: createHash('sha256').update(await readFile(destination)).digest('hex') };
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return manifest;
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.env.ORDERS_DB;
  const target = process.argv[2];
  await backupOrders(source, target);
  console.log(`Order backup created: ${resolve(target)}`);
}
