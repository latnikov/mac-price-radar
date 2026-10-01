"""Update a reviewed storefront release, preserving all accepted order snapshots.
Run on the shop host as root: python3 update.py /absolute/path/to/release-directory
The release directory must contain package.json, storefront and shared web modules.
"""
import json
import gzip
import hashlib
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

if os.geteuid() != 0:
    raise SystemExit('Root is required for service management')
release = Path(sys.argv[1]).resolve()
config = json.loads(Path(sys.argv[2]).read_text()) if len(sys.argv) > 2 else {}
telegram_export = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else None
allowed = {'STORE_MOYSKLAD_TOKEN', 'STORE_CRM_TELEGRAM_BOT_TOKEN', 'STORE_CRM_TELEGRAM_EXPECTED_BOT',
           'STORE_TELEGRAM_ACCOUNT_ID', 'STORE_TELEGRAM_API_IPV4', 'STORE_TELEGRAM_SEND_ENABLED', 'STORE_INBOX_SEND_ENABLED', 'STORE_DATA_SYNC_INTERVAL_MS'}
allowed.update(prefix + suffix for prefix in ['AVITO', 'AVITO_2'] for suffix in ['_CLIENT_ID', '_CLIENT_SECRET', '_ACCOUNT_ID', '_LABEL'])
if not isinstance(config, dict) or any(k not in allowed or not isinstance(v, str) or '\n' in v or '\r' in v for k, v in config.items()):
    raise SystemExit('Invalid private CRM settings')
if telegram_export and (not telegram_export.is_file() or not (release / 'scripts/telegram-crm-import.mjs').is_file()):
    raise SystemExit('Missing private Telegram export or importer')
base = Path('/srv/macbookbro-shop')
for name in ['package.json', 'storefront/server.mjs', 'storefront/migrations.mjs', 'web/price-table.js', 'web/retail-analytics.js', 'web/avito-columns.js']:
    if not (release / name).is_file():
        raise SystemExit('Incomplete release: ' + name)
if json.loads((release / 'package.json').read_text()).get('type') != 'module':
    raise SystemExit('Release must use ES modules')
if (release / 'data').exists() or any(release.rglob('*.sqlite')):
    raise SystemExit('Private data must not be part of a release')
subprocess.run(['node', '--check', str(release / 'storefront/server.mjs')], check=True)
backup = Path('/var/backups/macbookbro-shop') / ('customer-' + time.strftime('%Y%m%d-%H%M%S'))
backup.mkdir(parents=True, mode=0o700)
os.chmod(backup.parent, 0o700)
shutil.copytree(base, backup / 'code')
env_path = Path('/etc/macbookbro-shop.env')
shutil.copy2(env_path, backup / 'shop.env')
# Keep original settings, including all secrets, off the release tree.
settings = env_path.read_text()
private_env = dict(os.environ)
for line in settings.splitlines():
    if '=' in line and not line.startswith('#'):
        key, value = line.split('=', 1)
        private_env[key] = value.strip().strip('"').strip("'")
private_env.setdefault('STORE_DB', '/var/lib/macbookbro-shop/shop.sqlite')
private_env.setdefault('STORE_MEDIA_DIR', '/var/lib/macbookbro-shop/media')
subprocess.run(['systemctl', 'stop', 'macbookbro-shop'], check=True)
installed = False
db_path = Path(private_env['STORE_DB'])
def order_fingerprints():
    with sqlite3.connect('file:' + str(db_path) + '?mode=ro', uri=True) as db:
        return {row[0]: hashlib.sha256(row[1].encode()).hexdigest() for row in db.execute('SELECT id,data FROM orders')}
try:
    accepted_orders = order_fingerprints()
    subprocess.run(['node', str(base / 'storefront/backup.mjs'), str(backup / 'data')], env=private_env, check=True, stdout=subprocess.DEVNULL)
    for name in ['storefront', 'web']:
        if (base / name).exists():
            shutil.rmtree(base / name)
        shutil.copytree(release / name, base / name)
    shutil.copy2(release / 'package.json', base / 'package.json')
    # Opt in to the current-new-only price import after the reviewed version is installed.
    replaced = {'STORE_AUTO_CATALOG'} | set(config) | {k + '_FILE' for k in config}
    lines = [line for line in settings.splitlines() if line.split('=', 1)[0] not in replaced]
    lines.append('STORE_AUTO_CATALOG=1')
    for key, value in config.items():
        lines.append(key + '=' + json.dumps(value, ensure_ascii=False))
        private_env[key] = value
        private_env.pop(key + '_FILE', None)
    env_path.write_text('\n'.join(lines) + '\n')
    os.chmod(env_path, 0o600)
    installed = True
    if telegram_export:
        with tempfile.TemporaryDirectory(prefix='macbookbro-import-') as folder:
            unpacked = Path(folder) / 'result.json'
            with gzip.open(telegram_export, 'rb') as src, unpacked.open('wb') as dst:
                shutil.copyfileobj(src, dst)
            os.chmod(unpacked, 0o600)
            private_env['NODE_OPTIONS'] = '--max-old-space-size=768'
            subprocess.run(['node', str(release / 'scripts/telegram-crm-import.mjs'), str(unpacked)], env=private_env, check=True)
    after_orders = order_fingerprints()
    if any(after_orders.get(key) != value for key, value in accepted_orders.items()):
        raise RuntimeError('Accepted order snapshot changed')
    with sqlite3.connect('file:' + str(db_path) + '?mode=ro', uri=True) as db:
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchone():
            raise RuntimeError('Database verification failed')
    owner = db_path.stat()
    for suffix in ['', '-wal', '-shm']:
        candidate = Path(str(db_path) + suffix)
        if candidate.exists():
            os.chown(candidate, owner.st_uid, owner.st_gid)
    subprocess.run(['systemctl', 'start', 'macbookbro-shop'], check=True)
    for attempt in range(30):
        health = subprocess.run(['curl', '--fail', '--silent', '--max-time', '2', '-H', 'Host: macbookbro.ru', 'http://127.0.0.1:4190/healthz'], capture_output=True)
        if health.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('Updated shop failed health check')
except Exception:
    subprocess.run(['systemctl', 'stop', 'macbookbro-shop'], check=False)
    for name in ['storefront', 'web']:
        if (base / name).exists():
            shutil.rmtree(base / name)
        shutil.copytree(backup / 'code' / name, base / name)
    shutil.copy2(backup / 'code/package.json', base / 'package.json')
    shutil.copy2(backup / 'shop.env', env_path)
    # Retain migrated DB and any accepted orders. Extra tables are backwards compatible.
    owner = db_path.stat()
    for suffix in ['', '-wal', '-shm']:
        candidate = Path(str(db_path) + suffix)
        if candidate.exists():
            os.chown(candidate, owner.st_uid, owner.st_gid)
    subprocess.run(['systemctl', 'start', 'macbookbro-shop'], check=True)
    raise SystemExit('Update failed; previous code restored, order data retained')
print('Storefront updated. Private backup: ' + str(backup))
