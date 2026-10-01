"""Update a reviewed storefront release, preserving all accepted order snapshots.
Run on the shop host as root: python3 update.py /absolute/path/to/release-directory
The release directory must contain package.json, storefront and shared web modules.
"""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

if os.geteuid() != 0:
    raise SystemExit('Root is required for service management')
release = Path(sys.argv[1]).resolve()
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
try:
    subprocess.run(['node', str(base / 'storefront/backup.mjs'), str(backup / 'data')], env=private_env, check=True, stdout=subprocess.DEVNULL)
    for name in ['storefront', 'web']:
        if (base / name).exists():
            shutil.rmtree(base / name)
        shutil.copytree(release / name, base / name)
    shutil.copy2(release / 'package.json', base / 'package.json')
    # Opt in to the current-new-only price import after the reviewed version is installed.
    lines = [line for line in settings.splitlines() if not line.startswith('STORE_AUTO_CATALOG=')]
    lines.append('STORE_AUTO_CATALOG=1')
    env_path.write_text('\n'.join(lines) + '\n')
    os.chmod(env_path, 0o600)
    installed = True
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
    subprocess.run(['systemctl', 'start', 'macbookbro-shop'], check=True)
    raise SystemExit('Update failed; previous code restored, order data retained')
print('Storefront updated. Private backup: ' + str(backup))
