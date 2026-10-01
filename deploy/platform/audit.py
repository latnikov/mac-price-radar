"""Read-only aggregate audit. Never prints customer data or secret values."""
import json
import os
import socket
import sqlite3
import time
from pathlib import Path

DATABASES = {
    'parser_dev': '/srv/mac-price-radar/dev/data/private/master.sqlite',
    'parser_legacy': '/srv/mac-price-radar/prod/data/private/master.sqlite',
    'shop': '/var/lib/macbookbro-shop/shop.sqlite',
    'orders': '/var/lib/macbookbro-orders/orders.sqlite',
}

def audit_database(path):
    p = Path(path)
    if not p.exists():
        return {'missing': True}
    db = sqlite3.connect('file:' + str(p) + '?mode=ro', uri=True, timeout=10)
    db.create_function('casefold', 1, lambda v: str(v or '').lower(), deterministic=True)
    try:
        result = {'bytes': p.stat().st_size, 'wal_bytes': Path(str(p) + '-wal').stat().st_size if Path(str(p) + '-wal').exists() else 0,
                  'sqlite_version': sqlite3.sqlite_version, 'tables': {}}
        if p.name != 'master.sqlite':
            result['quick_check'] = db.execute('PRAGMA quick_check').fetchone()[0]
            result['foreign_key_errors'] = len(db.execute('PRAGMA foreign_key_check').fetchall())
        for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            columns = db.execute('PRAGMA table_info("' + table + '")').fetchall()
            info = {'rows': db.execute('SELECT COUNT(*) FROM "' + table + '"').fetchone()[0], 'fields': [r[1] for r in columns]}
            if table == 'observations':
                info['latest_day'] = db.execute('SELECT substr(received_at,1,10) FROM observations ORDER BY seq DESC LIMIT 1').fetchone()
                info['sample_bytes'] = db.execute("SELECT AVG(length(CAST(json AS BLOB))),AVG(length(CAST(json_extract(json,'$.raw') AS BLOB))) FROM (SELECT json FROM observations ORDER BY seq DESC LIMIT 1000)").fetchone()
                fields = {}
                for payload, in db.execute('SELECT json FROM observations ORDER BY seq DESC LIMIT 1000'):
                    for field, value in json.loads(payload).items():
                        size = len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode())
                        sample = fields.setdefault(field, {'present': 0, 'total_bytes': 0, 'max_bytes': 0})
                        sample['present'] += 1
                        sample['total_bytes'] += size
                        sample['max_bytes'] = max(sample['max_bytes'], size)
                info['sampled_fields'] = {field: {'present': value['present'], 'mean_bytes': round(value['total_bytes'] / value['present'], 1), 'max_bytes': value['max_bytes']} for field, value in sorted(fields.items())}
            if table == 'ms_objects':
                info['by_type'] = [{'type': kind, 'rows': count, 'mean_bytes': round(mean, 1), 'max_bytes': maximum} for kind, count, mean, maximum in db.execute('SELECT type,COUNT(*),AVG(length(CAST(data AS BLOB))),MAX(length(CAST(data AS BLOB))) FROM ms_objects GROUP BY type')]
            if table == 'inbox_messages':
                info['text_bytes'] = db.execute('SELECT SUM(length(CAST(body AS BLOB))) FROM inbox_messages').fetchone()[0]
            result['tables'][table] = info
        return result
    finally:
        db.close()

def main():
    disk = os.statvfs('/')
    result = {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'cpu': os.cpu_count(), 'load': os.getloadavg(),
              'disk': {'total': disk.f_blocks * disk.f_frsize, 'free': disk.f_bavail * disk.f_frsize}, 'databases': {}, 'dns': {}}
    for host in ['macbookbro.ru', 'dev.macbookbro.ru', 'order.macbookbro.ru', 'crm.macbookbro.ru']:
        try:
            result['dns'][host] = sorted(set(row[4][0] for row in socket.getaddrinfo(host, 443)))
        except socket.gaierror:
            result['dns'][host] = []
    for name, path in DATABASES.items():
        result['databases'][name] = audit_database(path)
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
