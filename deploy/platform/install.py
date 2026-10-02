"""Publish a reviewed platform release on the audited MacBookBro host.
Preserves databases, secret settings and accepted orders. Requires a clean
Git release directory and commit SHA; runs without Codex or any agent.
"""
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from parser_access import public_parser_routing
from redesign_routing import migrate as redesign_parser_routing

def run(*args, **options):
    return subprocess.run(args, check=True, **options)

def update_env(path, values):
    existing = path.read_text().splitlines()
    path.write_text('\n'.join([line for line in existing if line.split('=', 1)[0] not in values] + [k + '=' + str(v) for k, v in values.items()]) + '\n')
    os.chmod(path, 0o600)

def main():
    if os.geteuid() != 0 or len(sys.argv) != 3:
        raise SystemExit('Usage as root: install.py RELEASE_DIRECTORY COMMIT_SHA')
    release, commit = Path(sys.argv[1]).resolve(), sys.argv[2]
    if not re.fullmatch('[a-f0-9]{40}', commit):
        raise SystemExit('Full Git commit SHA required')
    for name in ['storefront/server.mjs', 'storefront/worker.mjs', 'order-site/server.mjs', 'scripts/master-store.mjs', 'deploy/platform/maintenance.py']:
        if not (release / name).is_file():
            raise SystemExit('Incomplete platform release')
    for source in [release / 'storefront/server.mjs', release / 'order-site/server.mjs', release / 'scripts/master-store.mjs']:
        run('node', '--check', str(source))
    backup = Path('/var/backups/macbookbro-deploy') / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + commit[:7])
    backup.mkdir(mode=0o700, parents=True)
    os.chmod(backup.parent, 0o700)
    files = ['/etc/caddy/Caddyfile', '/etc/macbookbro-shop.env', '/etc/macbookbro-orders.env', '/etc/mac-price-radar/dev.env',
             '/etc/systemd/system/macbookbro-shop.service', '/srv/mac-price-radar/dev/scripts/master-store.mjs',
             '/srv/mac-price-radar/dev/scripts/build-data.mjs', '/srv/mac-price-radar/dev/scripts/foreign-prices.mjs',
             '/srv/mac-price-radar/dev/web/foreign.js']
    for index, name in enumerate(files):
        shutil.copy2(name, backup / (str(index) + '-' + Path(name).name))
    shutil.copytree('/srv/macbookbro-orders', backup / 'order-code', ignore=shutil.ignore_patterns('data', '*.sqlite*'))
    shutil.copytree('/srv/macbookbro-shop', backup / 'shop-code', ignore=shutil.ignore_patterns('data', '*.sqlite*', 'node_modules'))
    extra_files = ['/srv/mac-price-radar/dev/scripts/collector-lock.mjs', '/etc/macbookbro-platform.json', '/etc/systemd/journald.conf.d/macbookbro.conf',
        '/etc/ssh/sshd_config.d/20-macbookbro.conf', '/etc/systemd/system/mac-price-radar@dev.service.d/platform.conf',
        '/etc/systemd/system/mac-price-radar-apify.service.d/platform.conf']
    extra_files += ['/srv/mac-price-radar/dev/' + name for name in ['scripts/server.mjs', 'scripts/store77.mjs', 'web/app.js', 'web/price-table.js']]
    extra_files += [str(Path('/etc/systemd/system') / unit.name) for unit in (release / 'deploy/platform').iterdir() if unit.suffix in ['.service', '.timer']]
    for index, name in enumerate(extra_files):
        if Path(name).exists():
            shutil.copy2(name, backup / ('extra-' + str(index)))
    original_caddy = Path('/etc/caddy/Caddyfile').read_text()
    original_units = {name: subprocess.run(['systemctl', 'is-active', name], capture_output=True, text=True).stdout.strip() == 'active'
                      for name in ['macbookbro-shop', 'macbookbro-worker', 'macbookbro-orders', 'mac-price-radar@dev', 'mac-price-radar@prod',
                                   'macbookbro-health.timer', 'macbookbro-backup.timer', 'mac-price-radar-backup.timer']}
    original_enabled = {name: subprocess.run(['systemctl', 'is-enabled', name], capture_output=True, text=True).stdout.strip() == 'enabled' for name in original_units}
    for name in ['macbookbro-shop', 'macbookbro-worker']:
        run('systemctl', 'stop', name) if original_units[name] else None
    users = Path('/etc/macbookbro-shop/staff-users.json')
    if not users.exists():
        entries = []
        for name in ['Vlad', 'VladJr', 'Max', 'Sasha']:
            salt = secrets.token_hex(16)
            # Initial credentials explicitly requested by the owner. Only salted hashes persist.
            hashed = hashlib.scrypt(name.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32).hex()
            entries.append({'username': name, 'role': 'owner' if name == 'Max' else 'manager', 'salt': salt, 'hash': hashed})
        users.write_text(json.dumps(entries))
    os.chmod(users, 0o640)
    shutil.chown(users, user='root', group='radar')
    update_env(Path('/etc/macbookbro-shop.env'), {'STORE_CRM_ORIGIN': 'https://crm.macbookbro.ru',
        'STORE_STAFF_USERS_FILE': str(users), 'STORE_STAFF_COOKIE_DOMAIN': 'macbookbro.ru', 'STORE_RUN_WORKERS': '0',
        'STORE_LEGACY_ORDERS_DB': '/var/lib/macbookbro-orders/orders.sqlite', 'STORE_HEALTH_FILE': '/var/lib/macbookbro-ops/health.json',
        'STORE_DATA_SYNC_INTERVAL_MS': '300000', 'STORE_SYNC_INTERVAL_MS': '60000'})
    caddy = '''macbookbro.ru {
    encode zstd gzip
    @internal path /internal/*
    handle @internal {
        respond 404
    }
    @crm path /crm /crm/*
    handle @crm {
        request_body {
            max_size 6MB
        }
        reverse_proxy 127.0.0.1:4190 {
            header_up -X-Store-Admin-Key
        }
    }
    redir /order /order/ 308
    handle /order/* {
        request_body {
            max_size 8KB
        }
        reverse_proxy 127.0.0.1:4180
    }
    redir /prices /prices/ 308
    redir /web /prices/web/ 308
    redir /web/* /prices{uri} 308
    handle_path /prices/* {
        forward_auth 127.0.0.1:4190 {
            uri /internal/staff-auth
            header_up Host macbookbro.ru
        }
        @pricesRoot path /
        redir @pricesRoot /prices/web/ 308
        reverse_proxy 127.0.0.1:4174 {
            header_up Host 127.0.0.1:4174
        }
    }
    handle {
        request_body {
            max_size 32KB
        }
        reverse_proxy 127.0.0.1:4190 {
            header_up -X-Store-Admin-Key
        }
    }
}

crm.macbookbro.ru {
    encode zstd gzip
    @crm path / /crm /crm/* /media/*
    handle @crm {
        request_body {
            max_size 6MB
        }
        reverse_proxy 127.0.0.1:4190 {
            header_up -X-Store-Admin-Key
        }
    }
    respond 404
}

dev.macbookbro.ru {
    encode zstd gzip
    @telegramWebhook path /api/telegram/bsa-webhook
    handle @telegramWebhook {
        reverse_proxy 127.0.0.1:4174 {
            header_up Host 127.0.0.1:4174
        }
    }
    handle {
        forward_auth 127.0.0.1:4190 {
            uri /internal/staff-auth
            header_up Host macbookbro.ru
        }
        reverse_proxy 127.0.0.1:4174 {
            header_up Host 127.0.0.1:4174
        }
    }
}

order.macbookbro.ru {
    encode zstd gzip
    @relay path /api/relay/claim /api/relay/ack /api/relay/status
    handle @relay {
        request_body {
            max_size 8KB
        }
        reverse_proxy 127.0.0.1:4180
    }
    handle {
        redir https://macbookbro.ru/order{uri} 308
    }
}
'''
    caddy = redesign_parser_routing(caddy)
    caddy = public_parser_routing(caddy)
    candidate = backup / 'Caddyfile.candidate'
    candidate.write_text(caddy)
    try:
        run('caddy', 'validate', '--config', str(candidate), '--adapter', 'caddyfile', stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        run('python3', str(release / 'storefront/deploy/update.py'), str(release), env={**os.environ, 'MACBOOKBRO_PLATFORM_UPDATE': '1'})
        update_env(Path('/etc/macbookbro-orders.env'), {'ORDER_ORIGIN': 'https://macbookbro.ru', 'ORDER_BASE_PATH': '/order'})
        # Direct Telegram was verified read-only on the audited host. No pending
        # historical customer notifications exist; the fixture is excluded by code.
        if 'ORDER_DELIVERY_MODE=relay' in Path('/etc/macbookbro-orders.env').read_text():
            db = sqlite3.connect('file:/var/lib/macbookbro-orders/orders.sqlite?mode=ro', uri=True)
            try:
                if db.execute("SELECT COUNT(*) FROM orders WHERE notified_at IS NULL AND id!='MB-RELAY-TEST'").fetchone()[0]:
                    raise RuntimeError('Reconcile pending relay notifications before switching delivery')
            finally:
                db.close()
        update_env(Path('/etc/macbookbro-orders.env'), {'ORDER_DELIVERY_MODE': 'direct', 'ORDER_TELEGRAM_API_IPV4': '149.154.167.220'})
        # Release files only; never overwrite an application's private data directory.
        for p in (release / 'order-site').iterdir():
            if p.name in ['data', 'test', 'deploy']:
                continue
            target = Path('/srv/macbookbro-orders') / p.name
            if p.is_dir():
                shutil.copytree(p, target, dirs_exist_ok=True)
            else:
                shutil.copy2(p, target)
        shutil.copy2(release / 'storefront/telegram-transport.mjs', '/srv/macbookbro-orders/telegram-transport.mjs')
        for name in ['master-store.mjs', 'collector-lock.mjs', 'build-data.mjs', 'foreign-prices.mjs', 'server.mjs', 'store77.mjs']:
            shutil.copy2(release / 'scripts' / name, Path('/srv/mac-price-radar/dev/scripts') / name)
        shutil.copy2(release / 'web/foreign.js', '/srv/mac-price-radar/dev/web/foreign.js')
        for name in ['app.js', 'price-table.js']:
            shutil.copy2(release / 'web' / name, Path('/srv/mac-price-radar/dev/web') / name)
        update_env(Path('/etc/mac-price-radar/dev.env'), {'AUTO_REFRESH_INTERVAL_MS': '0'})
        library = Path('/usr/local/lib/macbookbro-ops')
        library.mkdir(mode=0o755, parents=True, exist_ok=True)
        for name in ['maintenance.py', 'audit.py', 'compact.py']:
            if (release / 'deploy/platform' / name).exists():
                shutil.copy2(release / 'deploy/platform' / name, library / name)
        state = Path('/var/lib/macbookbro-ops')
        state.mkdir(mode=0o750, exist_ok=True)
        shutil.chown(state, user='root', group='radar')
        os.chmod(state, 0o2750)
        Path('/var/backups/macbookbro-platform').mkdir(mode=0o700, exist_ok=True)
        config = {'backup_dir': '/var/backups/macbookbro-platform', 'backup_generations': 7, 'backup_max_bytes': 3 * 1024**3,
            'deploy_backup_dirs': ['/var/backups/macbookbro-shop', '/var/backups/macbookbro-deploy'],
            'databases': {'parser_dev': '/srv/mac-price-radar/dev/data/private/master.sqlite',
                'parser_legacy': '/srv/mac-price-radar/prod/data/private/master.sqlite',
                'shop': '/var/lib/macbookbro-shop/shop.sqlite', 'orders': '/var/lib/macbookbro-orders/orders.sqlite'},
            'configuration': ['/etc/caddy/Caddyfile', '/etc/macbookbro-shop.env', '/etc/macbookbro-shop', '/etc/macbookbro-orders.env',
                '/etc/mac-price-radar', '/etc/systemd/system', '/srv/macbookbro-shop', '/srv/macbookbro-orders',
                '/srv/mac-price-radar/dev/scripts', '/srv/mac-price-radar/dev/web', '/srv/mac-price-radar/dev/data/catalog.json', '/srv/mac-price-radar/dev/requirements.md',
                '/srv/mac-price-radar/dev/package.json', '/srv/mac-price-radar/dev/package-lock.json', '/srv/mac-price-radar/dev/apps-script',
                '/srv/mac-price-radar/dev/data/offers.json', '/etc/macbookbro-platform.json', '/usr/local/lib/macbookbro-ops',
                '/srv/mac-price-radar/dev/data/private/bsa-business.json', '/srv/mac-price-radar/dev/data/private/foreign-prices.json',
                '/srv/mac-price-radar/dev/data/private/avito', '/srv/mac-price-radar/dev/data/private/analytics.ndjson'],
            'media': ['/var/lib/macbookbro-shop/media'],
            'health': {'shop': {'port': 4190, 'host': 'macbookbro.ru', 'service': 'macbookbro-shop'},
                'orders': {'port': 4180, 'host': 'macbookbro.ru', 'service': 'macbookbro-orders'},
                'parser': {'port': 4174, 'host': '127.0.0.1:4174', 'path': '/api/status', 'service': 'mac-price-radar@dev'}}}
        Path('/etc/macbookbro-platform.json').write_text(json.dumps(config, indent=2))
        os.chmod('/etc/macbookbro-platform.json', 0o600)
        for unit in (release / 'deploy/platform').glob('*.service'):
            shutil.copy2(unit, Path('/etc/systemd/system') / unit.name)
        for unit in (release / 'deploy/platform').glob('*.timer'):
            shutil.copy2(unit, Path('/etc/systemd/system') / unit.name)
        for name, limit in [('mac-price-radar@dev.service', '384M'), ('mac-price-radar-apify.service', '384M')]:
            dropin = Path('/etc/systemd/system') / (name + '.d') / 'platform.conf'
            dropin.parent.mkdir(exist_ok=True)
            dropin.write_text('[Service]\nEnvironment=NODE_OPTIONS=--max-old-space-size=256\nMemoryHigh=256M\nMemoryMax=' + limit + '\nTasksMax=64\nCPUWeight=20\nProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\nRestrictSUIDSGID=true\n')
        shutil.copy2(release / 'storefront/deploy/macbookbro-shop.service', '/etc/systemd/system/macbookbro-shop.service')
        logconf = Path('/etc/systemd/journald.conf.d/macbookbro.conf')
        logconf.parent.mkdir(exist_ok=True)
        logconf.write_text('[Journal]\nSystemMaxUse=128M\nRuntimeMaxUse=32M\nMaxRetentionSec=7day\n')
        sshconf = Path('/etc/ssh/sshd_config.d/20-macbookbro.conf')
        sshconf.write_text('PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\nX11Forwarding no\nMaxAuthTries 3\nLoginGraceTime 30\n')
        run('sshd', '-t')
        Path('/etc/caddy/Caddyfile').write_text(caddy)
        os.chmod('/etc/caddy/Caddyfile', 0o640)
        shutil.chown('/etc/caddy/Caddyfile', user='root', group='caddy')
        run('systemctl', 'daemon-reload')
        run('systemctl', 'restart', 'macbookbro-orders', 'mac-price-radar@dev', 'macbookbro-shop')
        run('systemctl', 'enable', '--now', 'macbookbro-worker', 'macbookbro-backup.timer', 'macbookbro-health.timer')
        # A single price database now serves every browser and the shop worker.
        run('systemctl', 'disable', '--now', 'mac-price-radar-backup.timer', 'mac-price-radar@prod')
        subprocess.run(['systemctl', 'reset-failed', 'mac-price-radar-backup'], check=False, stderr=subprocess.DEVNULL)
        run('systemctl', 'reload', 'caddy')
        run('systemctl', 'reload', 'ssh')
        run('systemctl', 'restart', 'systemd-journald')
        for folder in ['/srv/macbookbro-shop', '/srv/macbookbro-orders', '/srv/mac-price-radar/dev']:
            (Path(folder) / 'platform-release.json').write_text(json.dumps({'commit': commit, 'deployed_at': time.time()}))
        (backup / '.platform-managed').write_text('Completed platform deployment; managed rollback retention.\n')
        print('Platform installed. Rollback configuration: ' + str(backup), flush=True)
    except Exception:
        for unit in ['macbookbro-health.timer', 'macbookbro-backup.timer', 'macbookbro-worker', 'macbookbro-shop']:
            subprocess.run(['systemctl', 'stop', unit], check=False)
        Path('/etc/caddy/Caddyfile').write_text(original_caddy)
        for index, name in enumerate(files):
            shutil.copy2(backup / (str(index) + '-' + Path(name).name), name)
        shutil.copytree(backup / 'order-code', '/srv/macbookbro-orders', dirs_exist_ok=True)
        for name in ['storefront', 'web']:
            shutil.rmtree(Path('/srv/macbookbro-shop') / name)
            shutil.copytree(backup / 'shop-code' / name, Path('/srv/macbookbro-shop') / name)
        shutil.copy2(backup / 'shop-code/package.json', '/srv/macbookbro-shop/package.json')
        for index, name in enumerate(extra_files):
            saved = backup / ('extra-' + str(index))
            if saved.exists():
                shutil.copy2(saved, name)
            else:
                Path(name).unlink(missing_ok=True)
        run('systemctl', 'daemon-reload')
        for unit, was_active in original_units.items():
            subprocess.run(['systemctl', 'enable' if original_enabled[unit] else 'disable', unit], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if was_active:
                subprocess.run(['systemctl', 'restart', unit], check=False)
        subprocess.run(['systemctl', 'reload', 'caddy'], check=False)
        raise

if __name__ == '__main__':
    main()
