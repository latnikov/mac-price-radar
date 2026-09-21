import { mkdir, copyFile, writeFile, readFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { openMasterStore } from './master-store.mjs';
const target = resolve(process.argv[2] || `data/private/backups/${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(target, { recursive: true, mode: 0o700 });
const store = openMasterStore();
try {
  store.backup(join(target, 'master.sqlite'));
  for (const file of ['data/catalog.json', 'requirements.md']) {
    const name = file.split('/').at(-1); await copyFile(file, join(target, name)); await chmod(join(target, name), 0o600);
  }
  const files = ['master.sqlite', 'catalog.json', 'requirements.md'];
  const manifest = { createdAt: new Date().toISOString(), schemaVersion: 1, files: {} };
  for (const name of files) manifest.files[name] = createHash('sha256').update(await readFile(join(target, name))).digest('hex');
  await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log(`Резервная копия: ${target}`);
} finally { store.close(); }
