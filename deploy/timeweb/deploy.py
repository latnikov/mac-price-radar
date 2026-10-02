"""Deploy the exact successful GitHub dev commit; keep runtime data outside releases.

The timer uses anonymous read access to the public repository. No GitHub write
token or production secret is stored in GitHub Actions. All checks fail closed.
"""
import argparse
import fcntl
import gzip
import http.client
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tarfile
import time
import urllib.parse
import urllib.request
from contextlib import closing
from pathlib import Path

REPOSITORY = 'latnikov/mac-price-radar'
BRANCH = 'dev'
ROOT = Path('/srv/macbookbro-releases')
MIRROR = Path('/var/lib/macbookbro-deploy/repo.git')
STATE = Path('/var/lib/macbookbro-ops/deploy.json')
DATA = Path('/srv/macbookbro-data/parser')
BACKUPS = Path('/var/backups/macbookbro-timeweb-deploy')
HEADER = Path('/etc/caddy/macbookbro-release.caddy')
LINKS = {
    Path('/srv/mac-price-radar/dev'): '',
    Path('/srv/macbookbro-shop'): '',
    Path('/srv/macbookbro-orders'): 'order-site',
}
SERVICES = ['macbookbro-worker', 'macbookbro-orders', 'macbookbro-shop', 'mac-price-radar@dev']
TIMERS = ['macbookbro-health.timer', 'mac-price-radar-collect.timer', 'mac-price-radar-apify.timer']
DATABASES = {
    'parser': DATA / 'private/master.sqlite',
    'shop': Path('/var/lib/macbookbro-shop/shop.sqlite'),
    'orders': Path('/var/lib/macbookbro-orders/orders.sqlite'),
}


def command(*args, **kwargs):
    return subprocess.run(args, check=True, timeout=kwargs.pop('timeout', 300), **kwargs)


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o640)
    temporary.replace(path)


def successful_run(payload, commit):
    runs = [r for r in payload.get('workflow_runs', []) if r.get('head_sha') == commit
            and r.get('head_branch') == BRANCH and r.get('event') == 'push'
            and r.get('path') == '.github/workflows/ci.yml']
    if not runs:
        return None
    latest = max(runs, key=lambda r: (r['id'], r.get('run_attempt', 1)))
    return latest if latest.get('status') == 'completed' and latest.get('conclusion') == 'success' else None


def ci_run(commit):
    query = urllib.parse.urlencode({'head_sha': commit, 'branch': BRANCH, 'event': 'push', 'per_page': 10})
    request = urllib.request.Request(
        f'https://api.github.com/repos/{REPOSITORY}/actions/workflows/ci.yml/runs?{query}',
        headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'MacBookBro-deploy'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return successful_run(json.load(response), commit)


def safe_release_names(names):
    for name in names:
        path = Path(name)
        if path.is_absolute() or '..' in path.parts:
            raise RuntimeError('Unsafe release path')
        if path.name == '.env' or path.name.startswith('.env.') or path.name == 'staff-users.json':
            raise RuntimeError('Secret settings in release')
        if re.search(r'\.sqlite(?:-wal|-shm)?$', name) or name.endswith(('.pem', '.key')):
            raise RuntimeError('Private database or key in release')
        if name.startswith(('data/private/', 'data/incoming/')):
            raise RuntimeError('Private data in release')


def replace_link(path, target):
    if path.exists() and not path.is_symlink():
        raise RuntimeError('Deployment path must be a symlink: ' + str(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.next')
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    temporary.replace(path)


def snapshot_database(source, destination):
    raw = destination.with_name(destination.name + '.snapshot')
    if raw.exists() or destination.exists():
        raise RuntimeError('Backup destination already exists')
    with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True, timeout=15)) as db:
        with closing(sqlite3.connect(raw)) as backup:
            db.backup(backup, pages=1024)
            backup.create_function('casefold', 1, lambda value: str(value or '').lower(), deterministic=True)
            if backup.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RuntimeError('Database snapshot is corrupt')
    raw.chmod(0o600)
    with raw.open('rb') as source_file, gzip.open(destination, 'wb', compresslevel=1) as target_file:
        shutil.copyfileobj(source_file, target_file, 1024 * 1024)
    destination.chmod(0o600)
    raw.unlink()


def active(unit):
    return subprocess.run(['systemctl', 'is-active', unit], capture_output=True, text=True).stdout.strip() in ('active', 'activating')


def prune_managed_history():
    backups = sorted((p for p in BACKUPS.iterdir() if p.is_dir() and (p / '.complete').exists()), reverse=True)
    for path in backups[2:]:
        shutil.rmtree(path)
    protected = {link.resolve().parent if relative else link.resolve() for link, relative in LINKS.items()}
    if STATE.exists():
        for link, target in json.loads(STATE.read_text()).get('previous', {}).items():
            path = Path(target)
            protected.add(path.parent if LINKS.get(Path(link)) else path)
    releases = sorted((p for p in ROOT.iterdir() if p.is_dir() and re.fullmatch('[a-f0-9]{40}', p.name)
                       and (p / '.ready').exists()), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in releases[3:]:
        if path not in protected:
            shutil.rmtree(path)


def health():
    for port, host, path in [(4190, 'macbookbro.ru', '/healthz'),
                             (4180, 'macbookbro.ru', '/healthz'),
                             (4174, '127.0.0.1:4174', '/api/status')]:
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=8)
        try:
            connection.request('GET', path, headers={'Host': host})
            response = connection.getresponse()
            value = json.loads(response.read())
            if response.status != 200 or (port != 4174 and value.get('ok') is not True):
                raise RuntimeError('Application health check failed')
        finally:
            connection.close()
    for port, path in [(4190, '/'), (4180, '/order/')]:
        result = command('curl', '-fsS', '--max-time', '10', '-H', 'Host: macbookbro.ru',
                         f'http://127.0.0.1:{port}{path}', capture_output=True)
        if b'<html' not in result.stdout.lower():
            raise RuntimeError('Public application did not return HTML')


def prepare_release(commit):
    release = ROOT / commit
    if (release / '.ready').exists():
        return release
    if release.exists():
        raise RuntimeError('Incomplete release needs inspection: ' + str(release))
    names = command('git', '--git-dir', str(MIRROR), 'ls-tree', '-r', '--name-only', commit,
                    capture_output=True, text=True).stdout.splitlines()
    safe_release_names(names)
    release.mkdir(parents=True)
    archive = release / 'source.tar'
    with archive.open('wb') as output:
        command('git', '--git-dir', str(MIRROR), 'archive', commit, stdout=output)
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            if not member.isfile() and not member.isdir():
                raise RuntimeError('Release symlinks are not allowed')
        source.extractall(release, filter='data')
    archive.unlink()
    command('chown', '-R', 'radar:radar', str(release))
    cache = Path('/var/cache/macbookbro-npm')
    cache.mkdir(parents=True, exist_ok=True)
    command('chown', 'radar:radar', str(cache))
    # The test tree has only public seed data; no production database is linked yet.
    for args in [('npm', 'ci', '--ignore-scripts'), ('npm', 'test'), ('npm', 'run', 'test:orders'),
                 ('npm', 'run', 'test:shop'), ('npm', 'run', 'typecheck'),
                 ('python3', '-m', 'unittest', 'discover', '-s', 'deploy/platform', '-p', 'test_*.py')]:
        command('runuser', '-u', 'radar', '--', *args, cwd=release, timeout=900,
                env={**os.environ, 'npm_config_cache': str(cache)})
    shutil.rmtree(release / 'data')
    (release / 'data').symlink_to(DATA)
    (release / 'platform-release.json').write_text(json.dumps({'commit': commit, 'deployed_at': time.time()}))
    (release / 'order-site/platform-release.json').write_text((release / 'platform-release.json').read_text())
    (release / '.ready').touch()
    command('chown', '-R', 'root:root', str(release))
    # The systemd deployment unit uses UMask=0077. After ownership changes back
    # to root, radar still needs to traverse the immutable release directory.
    release.chmod(0o755)
    return release


def install_release(commit, release, verified):
    if any(active(s) for s in ['mac-price-radar-collect.service', 'mac-price-radar-apify.service']):
        raise RuntimeError('Collection is running; deployment deferred')
    previous = {str(link): str(link.resolve()) for link in LINKS}
    backup = BACKUPS / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + commit[:7])
    backup.mkdir(parents=True, mode=0o700)
    BACKUPS.chmod(0o700)
    atomic_json(backup / 'rollback.json', {'links': previous, 'commit': commit})
    saved_header = HEADER.read_text() if HEADER.exists() else ''
    (backup / 'release.caddy').write_text(saved_header)
    timer_states = {t: active(t) for t in TIMERS}
    worker_active = active('macbookbro-worker')
    command('systemctl', 'stop', *TIMERS)
    try:
        # Recheck after stopping timers to close the timer/start race.
        if any(active(s) for s in ['mac-price-radar-collect.service', 'mac-price-radar-apify.service']):
            raise RuntimeError('Collection started concurrently; deployment deferred')
        # Online backups are consistent snapshots; take them while HTTP is still
        # serving, then stop writers for the brief atomic code switch.
        for label, path in DATABASES.items():
            snapshot_database(path, backup / (label + '.sqlite.gz'))
        command('systemctl', 'stop', *SERVICES)
        try:
            for link, relative in LINKS.items():
                replace_link(link, release / relative)
            command('systemctl', 'start', *SERVICES[1:])
            for attempt in range(30):
                try:
                    health()
                    break
                except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError):
                    if attempt == 29:
                        raise
                    time.sleep(1)
            HEADER.write_text('header X-MacBookBro-Commit ' + commit + '\n')
            HEADER.chmod(0o644)
            command('caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile')
            command('systemctl', 'reload', 'caddy')
            if worker_active:
                command('systemctl', 'start', 'macbookbro-worker')
            # Upgrade the timer implementation only after the application passes health.
            shutil.copy2(release / 'deploy/timeweb/deploy.py', '/usr/local/lib/macbookbro-deploy/deploy.py')
            atomic_json(STATE, {'commit': commit, 'previous': previous, 'deployed_at': time.time(),
                                'ci_run': verified['html_url'], 'backup': str(backup), 'status': 'deployed'})
            (backup / '.complete').touch()
        except Exception:
            command('systemctl', 'stop', *SERVICES)
            for link in LINKS:
                replace_link(link, previous[str(link)])
            HEADER.write_text(saved_header)
            command('systemctl', 'start', *SERVICES[1:])
            if worker_active:
                command('systemctl', 'start', 'macbookbro-worker')
            command('systemctl', 'reload', 'caddy')
            # Never rewind live databases: new accepted orders must survive rollback.
            raise
    finally:
        for timer, was_active in timer_states.items():
            if was_active:
                command('systemctl', 'start', timer)
    # Retention failures must not undo a verified application publication.
    try:
        prune_managed_history()
    except OSError:
        print('Managed deployment retention needs inspection', flush=True)
    print(json.dumps({'commit': commit, 'status': 'deployed', 'backup': str(backup)}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['poll', 'deploy'])
    parser.add_argument('commit', nargs='?')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Root is required')
    with Path('/run/lock/macbookbro-deploy.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if not MIRROR.exists():
            MIRROR.parent.mkdir(parents=True, exist_ok=True)
            command('git', 'clone', '--bare', '--single-branch', '--branch', BRANCH,
                    f'https://github.com/{REPOSITORY}.git', str(MIRROR))
        command('git', '--git-dir', str(MIRROR), 'fetch', 'origin', '+refs/heads/dev:refs/heads/dev')
        head = command('git', '--git-dir', str(MIRROR), 'rev-parse', 'refs/heads/dev',
                       capture_output=True, text=True).stdout.strip()
        commit = args.commit if args.mode == 'deploy' else head
        if not commit or not re.fullmatch('[a-f0-9]{40}', commit):
            raise SystemExit('Full commit SHA required')
        if args.mode == 'poll' and STATE.exists() and json.loads(STATE.read_text()).get('commit') == commit:
            return
        if commit != head:
            raise SystemExit('Only the current dev head may be published')
        verified = ci_run(commit)
        if not verified:
            print(json.dumps({'commit': commit, 'status': 'waiting_for_successful_ci'}))
            return
        release = prepare_release(commit)
        # A newer push while testing is left for the next run; never publish stale code.
        command('git', '--git-dir', str(MIRROR), 'fetch', 'origin', '+refs/heads/dev:refs/heads/dev')
        current = command('git', '--git-dir', str(MIRROR), 'rev-parse', 'refs/heads/dev',
                          capture_output=True, text=True).stdout.strip()
        if current != commit or ci_run(commit) is None:
            raise SystemExit('Release changed or its latest CI is no longer successful')
        install_release(commit, release, verified)


if __name__ == '__main__':
    main()
