"""Install only the Store77/public-dev parser change, preserving other apps/data."""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from parser_access import public_parser_routing

FILES = ['scripts/store77.mjs', 'scripts/build-data.mjs', 'scripts/server.mjs', 'web/app.js', 'web/price-table.js']


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def active(unit):
    return subprocess.run(['systemctl', 'is-active', unit], capture_output=True, text=True).stdout.strip() == 'active'


def main():
    if os.geteuid() != 0 or len(sys.argv) != 3 or not re.fullmatch('[a-f0-9]{40}', sys.argv[2]):
        raise SystemExit('Usage as root: update_parser.py RELEASE_DIRECTORY FULL_COMMIT_SHA')
    release, commit = Path(sys.argv[1]).resolve(), sys.argv[2]
    target = Path('/srv/mac-price-radar/dev')
    for name in FILES:
        if not (release / name).is_file():
            raise SystemExit('Incomplete parser release: ' + name)
        run('node', '--check', str(release / name))
    caddy = Path('/etc/caddy/Caddyfile')
    backup = Path('/var/backups/macbookbro-deploy') / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-parser-' + commit[:7])
    backup.mkdir(parents=True, mode=0o700)
    backup.chmod(0o700)
    shutil.copy2(caddy, backup / 'Caddyfile')
    candidate = backup / 'Caddyfile.candidate'
    candidate.write_text(public_parser_routing(caddy.read_text()))
    candidate.chmod(0o600)
    run('caddy', 'validate', '--config', str(candidate), '--adapter', 'caddyfile')
    existed = {}
    for name in FILES + ['parser-release.json']:
        existed[name] = (target / name).exists()
        if existed[name]:
            saved = backup / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target / name, saved)
    timer, service = 'mac-price-radar-collect.timer', 'mac-price-radar@dev'
    timer_active, service_active = active(timer), active(service)
    run('systemctl', 'stop', timer)
    try:
        if active('mac-price-radar-collect.service'):
            raise RuntimeError('Wait for the current collector to finish before updating')
        run('systemctl', 'stop', service)
        try:
            for name in FILES:
                shutil.copy2(release / name, target / name)
                shutil.chown(target / name, user='radar', group='radar')
                (target / name).chmod(0o644)
            run('systemctl', 'start', service)
            for attempt in range(20):
                try:
                    run('curl', '-fsS', '--max-time', '3', 'http://127.0.0.1:4174/api/status')
                    break
                except subprocess.CalledProcessError:
                    if attempt == 19:
                        raise
                    time.sleep(0.5)
            # The private candidate is 0600; retain the live Caddyfile's owner
            # and mode so the Caddy service can read the installed content.
            shutil.copyfile(candidate, caddy)
            run('systemctl', 'reload', 'caddy')
            (target / 'parser-release.json').write_text(json.dumps({'commit': commit, 'files': FILES,
                'deployed_at': time.time(), 'public_dev': True}))
            (backup / '.platform-managed').write_text('Completed parser deployment; managed rollback retention.\n')
            print(json.dumps({'commit': commit, 'backup': str(backup), 'public_dev': True}))
        except Exception:
            run('systemctl', 'stop', service)
            for name, present in existed.items():
                if present:
                    shutil.copy2(backup / name, target / name)
                else:
                    (target / name).unlink(missing_ok=True)
            shutil.copy2(backup / 'Caddyfile', caddy)
            run('systemctl', 'reload', 'caddy')
            if service_active:
                run('systemctl', 'start', service)
            raise
    finally:
        if timer_active:
            run('systemctl', 'start', timer)


if __name__ == '__main__':
    main()
