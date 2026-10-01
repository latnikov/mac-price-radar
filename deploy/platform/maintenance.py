"""Independent server operations: consistent backups, restoration checks and health.
Uses only Python's standard library. No AI, agent, API quota or laptop is required.
"""
import argparse
from contextlib import closing
import fcntl
import hashlib
import http.client
import json
import os
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path

CONFIG = Path('/etc/macbookbro-platform.json')
STATE = Path('/var/lib/macbookbro-ops')

def sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()

def atomic_json(path, value):
    temporary = Path(str(path) + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    os.chmod(temporary, 0o640)
    temporary.replace(path)

def check_db(path):
    with closing(sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)) as db:
        db.create_function('casefold', 1, lambda v: str(v or '').lower(), deterministic=True)
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise RuntimeError('Backup database verification failed: ' + Path(path).name)
        if db.execute('PRAGMA foreign_key_check').fetchone():
            raise RuntimeError('Backup has invalid relationships: ' + Path(path).name)
        counts = {}
        for name in ['orders', 'inbox_messages', 'inbox_dialogs', 'customers', 'observations']:
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone():
                counts[name] = db.execute('SELECT COUNT(*) FROM "' + name + '"').fetchone()[0]
        return counts

def verify_archive(archive, directory):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise RuntimeError('Restoration destination must be empty')
    with tarfile.open(archive, 'r:gz') as source:
        # Only regular files/directories in our archive; never restore outside destination.
        members = source.getmembers()
        for member in members:
            if not (member.isfile() or member.isdir()) or not (directory / member.name).resolve().is_relative_to(directory.resolve()):
                raise RuntimeError('Unsafe backup archive member')
        source.extractall(directory, members=members)
    manifest = json.loads((directory / 'manifest.json').read_text())
    for name, value in manifest['files'].items():
        path = directory / name
        if path.resolve().is_relative_to(directory.resolve()) is False or sha(path) != value['sha256']:
            raise RuntimeError('Restored backup checksum mismatch')
        if name.endswith('.sqlite') and check_db(path) != value['counts']:
            raise RuntimeError('Restored backup row counts mismatch')
    return manifest

def rotate_deploy_snapshots(config):
    # Only deployments completed by the platform installer carry this marker.
    for directory in config.get('deploy_backup_dirs', []):
        root = Path(directory)
        if not root.is_dir():
            continue
        for source in sorted(root.iterdir()):
            if not source.is_dir() or not (source / '.platform-managed').is_file():
                continue
            archive = root / ('deploy-' + source.name + '.tar.gz')
            partial = archive.with_suffix('.partial')
            expected = {p.relative_to(source).as_posix(): sha(p) for p in source.rglob('*') if p.is_file() and not p.is_symlink()}
            with tarfile.open(partial, 'w:gz', compresslevel=1) as target:
                target.add(source, arcname=source.name)
            seen = set()
            with tarfile.open(partial, 'r:gz') as check:
                for member in check:
                    if member.isfile():
                        relative = Path(member.name).relative_to(source.name).as_posix()
                        value = hashlib.sha256()
                        stream = check.extractfile(member)
                        for block in iter(lambda: stream.read(1024 * 1024), b''):
                            value.update(block)
                        if value.hexdigest() != expected[relative]:
                            raise RuntimeError('Deployment rollback archive verification failed')
                        seen.add(relative)
            if seen != set(expected):
                raise RuntimeError('Incomplete deployment rollback archive')
            partial.replace(archive)
            os.chmod(archive, 0o600)
            atomic_json(archive.with_suffix('.json'), {'sha256': sha(archive), 'bytes': archive.stat().st_size})
            shutil.rmtree(source)
        retained_bytes = 0
        for index, archive in enumerate(sorted(root.glob('deploy-*.tar.gz'), reverse=True)):
            retained_bytes += archive.stat().st_size
            if index >= 3 or (index >= 2 and retained_bytes > 512 * 1024**2):
                if archive.with_suffix('.json').is_file():
                    archive.unlink()
                    archive.with_suffix('.json').unlink()

def backup(config):
    rotate_deploy_snapshots(config)
    root = Path(config['backup_dir'])
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    # The backup lock excludes another run; these are abandoned temporary copies.
    for abandoned in root.glob('.platform-work-*'):
        if abandoned.is_dir() and not abandoned.is_symlink():
            shutil.rmtree(abandoned)
    for abandoned in root.glob('platform-*.partial'):
        abandoned.unlink()
    required = sum(Path(p).stat().st_size for p in config['databases'].values() if Path(p).is_file()) + 768 * 1024**2
    if shutil.disk_usage(root).free < required:
        raise RuntimeError('Insufficient free space for a consistent backup; originals retained')
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    archive = root / ('platform-' + stamp + '.tar.gz')
    partial = root / ('platform-' + stamp + '.partial')
    with tempfile.TemporaryDirectory(prefix='.platform-work-', dir=root) as work, closing_partial(partial):
        work = Path(work)
        manifest = {'created_at': time.time(), 'files': {}, 'format': 1}
        for name, path in config['databases'].items():
            if not Path(path).is_file():
                raise RuntimeError('Required database is missing: ' + name)
            target = work / (name + '.sqlite')
            print('Backing up ' + name, flush=True)
            with closing(sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, timeout=10)) as source, closing(sqlite3.connect(target)) as destination:
                source.backup(destination, pages=1024, sleep=0.05)
                # Publish one complete file, with no dependency on WAL sidecars.
                destination.execute('PRAGMA journal_mode=DELETE')
            os.chmod(target, 0o600)
            manifest['files'][target.name] = {'sha256': sha(target), 'counts': check_db(target)}
        for group, paths in [('configuration', config.get('configuration', [])), ('media', config.get('media', []))]:
            for index, value in enumerate(paths):
                source = Path(value)
                if not source.exists():
                    continue
                target = work / group / (str(index) + '-' + source.name)
                target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
                if source.is_dir():
                    shutil.copytree(source, target)
                else:
                    shutil.copy2(source, target)
        for path in work.rglob('*'):
            if path.is_file() and path.relative_to(work).as_posix() not in manifest['files']:
                manifest['files'][path.relative_to(work).as_posix()] = {'sha256': sha(path)}
        atomic_json(work / 'manifest.json', manifest)
        with tarfile.open(partial, 'w:gz', compresslevel=1) as target:
            for path in work.iterdir():
                target.add(path, arcname=path.name)
        # Read the complete compressed stream, validating its CRC without a second full DB copy.
        with tarfile.open(partial, 'r:gz') as check:
            for member in check:
                if member.isfile():
                    stream = check.extractfile(member)
                    value = hashlib.sha256()
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        value.update(block)
                    if member.name != 'manifest.json' and value.hexdigest() != manifest['files'][member.name]['sha256']:
                        raise RuntimeError('Compressed backup verification failed')
        partial.rename(archive)
        os.chmod(archive, 0o600)
        atomic_json(archive.with_suffix('.json'), {'sha256': sha(archive), 'created_at': manifest['created_at'], 'bytes': archive.stat().st_size})
    atomic_json(STATE / 'backup.json', {'at': time.time(), 'archive': str(archive), 'bytes': archive.stat().st_size, 'verified': True})
    # Rotate only complete verified archives created by this tool. Never touch source databases.
    generations = sorted(root.glob('platform-*.tar.gz'), key=lambda p: p.name, reverse=True)
    retained_bytes = 0
    for index, path in enumerate(generations):
        retained_bytes += path.stat().st_size
        if index >= max(2, config.get('backup_generations', 7)) or (index >= 2 and retained_bytes > config.get('backup_max_bytes', 3 * 1024**3)):
            if path.with_suffix('.json').is_file():
                path.unlink()
                path.with_suffix('.json').unlink()
    print('Verified backup: ' + str(archive), flush=True)

class closing_partial:
    def __init__(self, path):
        self.path = path
    def __enter__(self):
        return self
    def __exit__(self, *error):
        self.path.unlink(missing_ok=True)

def health(config):
    at = time.time()
    alerts = []
    disk = shutil.disk_usage('/')
    usage = (disk.total - disk.free) / disk.total
    if usage > 0.8:
        alerts.append({'kind': 'disk', 'percent': round(usage * 100, 1)})
    memory = {line.split(':', 1)[0]: int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()}
    if memory['MemAvailable'] < 200 * 1024:
        alerts.append({'kind': 'memory', 'available_mb': memory['MemAvailable'] // 1024})
    endpoints = {}
    for name, url in config['health'].items():
        connection = http.client.HTTPConnection('127.0.0.1', url['port'], timeout=4)
        try:
            connection.request('GET', url.get('path', '/healthz'), headers={'Host': url['host']})
            response = connection.getresponse()
            response.read()
            endpoints[name] = response.status == 200
        except (OSError, http.client.HTTPException):
            endpoints[name] = False
        finally:
            connection.close()
        failure_path = STATE / (name + '-failures.json')
        failures = json.loads(failure_path.read_text()).get('failures', 0) if failure_path.exists() else 0
        failures = 0 if endpoints[name] else failures + 1
        if failures >= 3:
            alerts.append({'kind': 'service', 'name': name})
            subprocess.run(['systemctl', 'try-restart', url['service']], check=False, timeout=30, stdout=subprocess.DEVNULL)
            failures = 0
        atomic_json(failure_path, {'failures': failures})
    with closing(sqlite3.connect(Path(config['databases']['shop']).resolve().as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
        def setting(key):
            row = db.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
            return json.loads(row[0]) if row else {}
        heartbeat = setting('worker_heartbeat')
        if heartbeat.get('at', 0) < (at - 120) * 1000:
            alerts.append({'kind': 'worker_stale'})
            failure_path = STATE / 'worker-failures.json'
            failures = json.loads(failure_path.read_text()).get('failures', 0) + 1 if failure_path.exists() else 1
            if failures >= 3:
                subprocess.run(['systemctl', 'try-restart', 'macbookbro-worker'], check=False, timeout=30, stdout=subprocess.DEVNULL)
                failures = 0
            atomic_json(failure_path, {'failures': failures})
        else:
            atomic_json(STATE / 'worker-failures.json', {'failures': 0})
        price = setting('price_sync')
        if not price.get('ok') or price.get('at', 0) < (at - 7200) * 1000:
            alerts.append({'kind': 'price_sync_stale'})
        legacy = setting('legacy_orders_sync')
        if legacy.get('ok') is False:
            alerts.append({'kind': 'legacy_orders_import'})
        integrations = db.execute('SELECT channel,account_id,state,last_success FROM sync_state').fetchall()
        for channel, account, status, last_success in integrations:
            if status in ['blocked', 'error'] or (last_success and last_success < (at - 3600) * 1000):
                alerts.append({'kind': 'integration', 'channel': channel, 'account': account, 'state': status})
    backup_state = json.loads((STATE / 'backup.json').read_text()) if (STATE / 'backup.json').exists() else {}
    if backup_state.get('at', 0) < at - 26 * 3600:
        alerts.append({'kind': 'backup_stale'})
    status = {'at': at, 'disk_free': disk.free, 'disk_percent': round(usage * 100, 1), 'endpoints': endpoints,
              'memory_available_mb': memory['MemAvailable'] // 1024, 'alerts': alerts, 'backup': backup_state}
    previous = json.loads((STATE / 'health.json').read_text()).get('alerts', []) if (STATE / 'health.json').exists() else None
    atomic_json(STATE / 'health.json', status)
    if previous != alerts:
        print(json.dumps({'event': 'health_changed', 'alerts': alerts}, ensure_ascii=False), flush=True)
        # Optional explicit operator endpoint; no customer messages and no secret-bearing URLs.
        if config.get('alert_command'):
            subprocess.run(config['alert_command'], input=json.dumps(status).encode(), timeout=15, check=False)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['backup', 'health', 'verify'])
    parser.add_argument('--archive')
    parser.add_argument('--destination')
    args = parser.parse_args()
    os.umask(0o077)
    STATE.mkdir(mode=0o700, exist_ok=True)
    with (STATE / (args.action + '.lock')).open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        config = json.loads(CONFIG.read_text())
        if args.action == 'verify':
            if not args.archive or not args.destination:
                parser.error('verify requires --archive and --destination')
            verify_archive(args.archive, args.destination)
            atomic_json(STATE / 'restore-check.json', {'at': time.time(), 'archive': args.archive, 'ok': True})
            print('Restoration checks passed')
        else:
            globals()[args.action](config)

if __name__ == '__main__':
    main()
