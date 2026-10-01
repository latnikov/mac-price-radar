"""Offline representation compaction; business rows and audit history are retained.
Requires a fresh verified platform backup. Removes raw only when every value
is already identical to its top-level value, then VACUUMs unused pages.
"""
import datetime
import fcntl
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

def redundant_raw(value):
    raw = value.get('raw')
    return isinstance(raw, dict) and all(key in value and canonical(value[key]) == canonical(child) for key, child in raw.items())

def compact(path):
    path = Path(path)
    owner = path.stat()
    before_bytes = path.stat().st_size
    db = sqlite3.connect(path, timeout=10)
    try:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA synchronous=FULL')
        original_counts = {name: db.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0] for name in ['observations','listings','runs','price_decisions','quote_revisions','audit']}
        trigger = db.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='observations_no_update'").fetchone()
        if not trigger:
            raise RuntimeError('Expected append-only trigger is missing')
        last = 0
        changed = 0
        while True:
            rows = db.execute('SELECT seq,json FROM observations WHERE seq>? ORDER BY seq LIMIT 2000', (last,)).fetchall()
            if not rows:
                break
            updates = []
            for seq, encoded in rows:
                value = json.loads(encoded)
                if redundant_raw(value):
                    original = {k: v for k, v in value.items() if k != 'raw'}
                    value.pop('raw')
                    result = canonical(value)
                    if json.loads(result) != original:
                        raise RuntimeError('Compaction changed business fields')
                    updates.append((result, seq))
            # DDL and representation updates commit together. A crash cannot
            # leave the historical price table without its append-only guard.
            try:
                db.execute('BEGIN IMMEDIATE')
                db.execute('DROP TRIGGER observations_no_update')
                db.executemany('UPDATE observations SET json=? WHERE seq=?', updates)
                db.execute(trigger[0])
                db.commit()
            except BaseException:
                db.rollback()
                raise
            changed += len(updates)
            last = rows[-1][0]
        after_counts = {name: db.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0] for name in original_counts}
        if original_counts != after_counts:
            raise RuntimeError('Business row counts changed')
        db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        db.execute('VACUUM')
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchone():
            raise RuntimeError('Compacted database verification failed')
        return {'database': path.name, 'path': str(path), 'before_bytes': before_bytes, 'after_bytes': path.stat().st_size,
                'compacted_observations': changed, 'counts_preserved': after_counts, 'quick_check': 'ok'}
    finally:
        db.close()
        for suffix in ['', '-wal', '-shm']:
            candidate = Path(str(path) + suffix)
            if candidate.exists():
                os.chown(candidate, owner.st_uid, owner.st_gid)
                os.chmod(candidate, owner.st_mode & 0o777)

def perform():
    state = json.loads(Path('/var/lib/macbookbro-ops/backup.json').read_text())
    if not state.get('verified') or state.get('at', 0) < time.time() - 6 * 3600:
        raise SystemExit('A fresh verified backup is required')
    archive = Path(state['archive'])
    metadata = json.loads(archive.with_suffix('.json').read_text())
    digest = hashlib.sha256()
    with archive.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    if digest.hexdigest() != metadata['sha256']:
        raise SystemExit('Backup checksum mismatch')
    for unit in ['mac-price-radar@dev', 'mac-price-radar@prod', 'mac-price-radar-collect', 'mac-price-radar-apify']:
        if subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0:
            raise SystemExit('Stop parser writers before compaction: ' + unit)
    config = json.loads(Path('/etc/macbookbro-platform.json').read_text())
    results = []
    for name in ['parser_dev','parser_legacy']:
        result = compact(config['databases'][name])
        results.append(result)
        print(json.dumps(result), flush=True)
    Path('/var/lib/macbookbro-ops/compaction.json').write_text(json.dumps({'at': time.time(), 'results': results}, indent=2))

def main():
    if '--manage-services' not in sys.argv:
        return perform()
    with Path('/var/lib/macbookbro-ops/compaction.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        units = ['mac-price-radar-collect.timer', 'mac-price-radar-apify.timer', 'mac-price-radar@dev',
                 'mac-price-radar-collect', 'mac-price-radar-apify']
        active = {unit: subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0 for unit in units}
        try:
            subprocess.run(['systemctl', 'stop', *units], check=True)
            perform()
        finally:
            # systemd owns this maintenance process even if the SSH connection ends.
            restart = [unit for unit in units[:3] if active[unit]]
            if restart:
                subprocess.run(['systemctl', 'start', *restart], check=True)

if __name__ == '__main__':
    main()
