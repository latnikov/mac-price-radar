"""One-time recovery of storage used by obsolete deployment snapshots.
Archives historical code/data before removing its original copy. Daily backup
retention keeps the latest two complete generations; active roots are excluded.
"""
import gzip
import hashlib
import json
import os
import shutil
import sys
import tarfile
from pathlib import Path

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def verified_backup(path):
    manifest = json.loads((path / 'manifest.json').read_text())
    for name, expected in manifest['files'].items():
        if Path(name).name != name or digest(path / name) != expected:
            raise RuntimeError('Backup checksum mismatch: ' + str(path))

def archive(paths, target):
    if target.exists():
        if target.with_suffix('.sha256').read_text().strip() != digest(target):
            raise RuntimeError('Existing archive checksum mismatch')
        with tarfile.open(target, 'r:gz') as check:
            names = set(check.getnames())
            if any(str(path).lstrip('/') not in names for path in paths):
                raise RuntimeError('Existing archive is incomplete')
        print('Existing archive verified: ' + str(target), flush=True)
        return
    temporary = target.with_suffix('.partial')
    try:
        with tarfile.open(temporary, 'w:gz', compresslevel=1) as out:
            for path in paths:
                if path.is_symlink():
                    raise RuntimeError('Refusing symlink: ' + str(path))
                print('Archiving ' + str(path), flush=True)
                out.add(path, arcname=str(path).lstrip('/'))
        with gzip.open(temporary, 'rb') as check:
            while check.read(1024 * 1024):
                pass
        with tarfile.open(temporary, 'r:gz') as check:
            names = set(check.getnames())
            if any(str(path).lstrip('/') not in names for path in paths):
                raise RuntimeError('Incomplete archive')
        temporary.rename(target)
        os.chmod(target, 0o600)
        target.with_suffix('.sha256').write_text(digest(target) + '\n')
        print('Verified compressed archive: ' + str(target), flush=True)
    except Exception:
        if temporary.exists():
            temporary.unlink()
        raise

def main():
    if os.geteuid() != 0 or not ({'--apply', '--archive-only'} & set(sys.argv)):
        raise SystemExit('Run as root with --archive-only or --apply on the audited MacBookBro host')
    root = Path('/var/backups/mac-price-radar')
    complete = []
    for p in root.iterdir():
        if p.is_dir() and (p / 'manifest.json').exists() and (p / 'master.sqlite').exists():
            complete.append(p)
    complete.sort(key=lambda p: p.name, reverse=True)
    if len(complete) < 2:
        raise RuntimeError('Need two complete backup generations before pruning')
    for p in complete[:2]:
        verified_backup(p)
    destination = Path('/var/backups/macbookbro-bootstrap')
    destination.mkdir(mode=0o700, exist_ok=True)
    # Keep all history of code releases and one-time migrations in a compact archive.
    historical = [Path('/srv/mac-price-radar/releases'), Path('/srv/mac-price-radar/dev/data/private/backups')]
    historical += [p for p in [Path('/var/backups/parser-fix-7d0be30'), Path('/var/backups/parser-ui-5d7ef39'),
        Path('/var/backups/macbookbro-release-f34fd61')] if p.exists()]
    archive(historical, destination / 'historical-releases.tar.gz')
    if '--archive-only' in sys.argv:
        print('Archive ready; originals retained. Proposed cleanup: ' + json.dumps([str(p) for p in complete[2:] + historical]), flush=True)
        return
    for p in complete[2:]:
        print('Pruning old daily backup: ' + str(p), flush=True)
        shutil.rmtree(p)
    for p in historical:
        shutil.rmtree(p)
        if str(p).startswith('/srv/'):
            p.mkdir(mode=0o700)
            shutil.chown(p, user='radar', group='radar')
    print('Storage recovery completed', flush=True)

if __name__ == '__main__':
    main()
