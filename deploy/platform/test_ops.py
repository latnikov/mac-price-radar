import importlib.util
import json
import sqlite3
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

ops = module('maintenance')
compact = module('compact')

class OperationsTests(unittest.TestCase):
    def test_snapshot_compression_restore_and_retention_preserve_live_data(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            source = directory / 'shop.sqlite'
            original = "original-price\nМакбук 'Silver'; DROP TABLE orders;\0still here"
            with sqlite3.connect(source) as db:
                db.create_function('casefold', 1, lambda v: str(v or '').lower(), deterministic=True)
                db.executescript('PRAGMA journal_mode=WAL; PRAGMA user_version=8; CREATE TABLE orders(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE payloads(id INTEGER PRIMARY KEY AUTOINCREMENT,bytes BLOB,amount REAL,label TEXT,total REAL GENERATED ALWAYS AS (amount*2) STORED); CREATE INDEX by_label ON payloads(casefold(label)); CREATE TRIGGER preserve_order BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT,"keep order"); END;')
                db.execute('INSERT INTO orders VALUES(?,?)', ('accepted', original))
                db.execute('INSERT INTO payloads(id,bytes,amount,label) VALUES(1,?,?,?)', (bytes(range(256)), 119.95, 'Silver'))
                db.execute('INSERT INTO payloads(id) VALUES(2)')
                db.execute('DELETE FROM payloads WHERE id=2')
            state = directory / 'state'
            state.mkdir()
            configuration = directory / 'configuration'
            configuration.mkdir()
            (configuration / 'service.conf').write_text('private configuration')
            (configuration / 'obsolete-unit').symlink_to(configuration / 'removed-unit')
            config = {'backup_dir': str(directory / 'backups'), 'databases': {'shop': str(source)}, 'backup_generations': 2, 'backup_max_bytes': 10000000, 'configuration': [str(configuration)]}
            with patch.object(ops, 'STATE', state):
                for stamp in ['20261001T010000Z','20261001T020000Z','20261001T030000Z']:
                    with patch.object(ops.time, 'strftime', return_value=stamp):
                        ops.backup(config)
                backups = sorted(Path(config['backup_dir']).glob('*.tar.gz'))
                self.assertEqual(len(backups), 2)
                restored = directory / 'restored'
                manifest = ops.verify_archive(backups[-1], restored)
                self.assertEqual(manifest['format'], 2)
                self.assertEqual(manifest['files']['shop.sqlite.sql.gz']['counts'], {'orders': 1, 'payloads': 1})
                with tarfile.open(backups[-1]) as archive:
                    self.assertFalse(any(name.endswith('.sqlite') for name in archive.getnames()))
                self.assertEqual((restored / 'configuration/0-configuration/service.conf').read_text(), 'private configuration')
                self.assertFalse((restored / 'configuration/0-configuration/obsolete-unit').exists())
                with sqlite3.connect(restored / 'shop.sqlite') as db:
                    self.assertEqual(db.execute('SELECT data FROM orders').fetchone()[0], original)
                    self.assertEqual(db.execute('SELECT bytes,amount FROM payloads').fetchone(), (bytes(range(256)), 119.95))
                    self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 8)
                    self.assertEqual(db.execute('SELECT seq FROM sqlite_sequence WHERE name="payloads"').fetchone()[0], 2)
                    self.assertEqual(db.execute('SELECT total FROM payloads').fetchone()[0], 239.9)
                    with self.assertRaisesRegex(sqlite3.IntegrityError, 'keep order'):
                        db.execute('DELETE FROM orders')
                with sqlite3.connect(source) as db:
                    self.assertEqual(db.execute('SELECT COUNT(*) FROM orders').fetchone()[0], 1)
                metadata = json.loads((state / 'backup.json').read_text())
                self.assertTrue(metadata['verified'])
                with patch.object(ops, 'sha', return_value='corrupted'):
                    with self.assertRaisesRegex(RuntimeError, 'checksum'):
                        ops.verify_archive(backups[-1], directory / 'corrupted')

    def test_streaming_snapshot_excludes_concurrent_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            source = directory / 'shop.sqlite'
            state = directory / 'state'
            state.mkdir()
            original_connect = sqlite3.connect
            with original_connect(source) as db:
                db.executescript('PRAGMA journal_mode=WAL; CREATE TABLE orders(id TEXT PRIMARY KEY); INSERT INTO orders VALUES("before");')
            original_dump = ops.iter_sql
            def concurrent_dump(db):
                with original_connect(source) as writer:
                    writer.execute('INSERT INTO orders VALUES("during")')
                yield from original_dump(db)
            config = {'backup_dir': str(directory / 'backups'), 'databases': {'shop': str(source)}}
            with patch.object(ops, 'STATE', state), patch.object(ops, 'iter_sql', side_effect=concurrent_dump):
                ops.backup(config)
            archive = next(Path(config['backup_dir']).glob('*.tar.gz'))
            restored = directory / 'restored'
            ops.verify_archive(archive, restored)
            with original_connect(source) as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM orders').fetchone()[0], 2)
            with original_connect(restored / 'shop.sqlite') as db:
                self.assertEqual(db.execute('SELECT id FROM orders').fetchall(), [('before',)])

    def test_restore_keeps_binary_format_one_backups_usable(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            source = directory / 'old.sqlite'
            with sqlite3.connect(source) as db:
                db.executescript('CREATE TABLE orders(id INTEGER PRIMARY KEY); INSERT INTO orders VALUES(1); CREATE TABLE other(id INTEGER); INSERT INTO other VALUES(1);')
            manifest = directory / 'manifest.json'
            manifest.write_text(json.dumps({'format': 1, 'files': {'old.sqlite': {'sha256': ops.sha(source), 'counts': {'orders': 1}}}}))
            archive = directory / 'format-one.tar.gz'
            with tarfile.open(archive, 'w:gz') as target:
                target.add(source, arcname=source.name)
                target.add(manifest, arcname=manifest.name)
            ops.verify_archive(archive, directory / 'restored')

    def test_compaction_requires_identical_typed_values(self):
        self.assertTrue(compact.redundant_raw({'price': 100, 'color': 'Silver', 'raw': {'price': 100, 'color': 'Silver'}}))
        self.assertFalse(compact.redundant_raw({'price': 100, 'raw': {'price': 200}}))
        self.assertFalse(compact.redundant_raw({'flag': True, 'raw': {'flag': 1}}))
        self.assertFalse(compact.redundant_raw({'raw': {'supplier_fact': 'must stay'}}))

    def test_offline_compaction_preserves_unique_evidence_and_restores_append_only_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'master.sqlite'
            db = sqlite3.connect(path)
            db.executescript('CREATE TABLE observations(seq INTEGER PRIMARY KEY,json TEXT); CREATE TRIGGER observations_no_update BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,"append only"); END;')
            for name in ['listings','runs','price_decisions','quote_revisions','audit']:
                db.execute('CREATE TABLE ' + name + '(id INTEGER PRIMARY KEY)')
                db.execute('INSERT INTO ' + name + ' VALUES(1)')
            values = [{'price': 100, 'raw': {'price': 100}}, {'price': 200, 'raw': {'price': 300}}]
            db.executemany('INSERT INTO observations VALUES(?,?)', [(i + 1, json.dumps(v)) for i, v in enumerate(values)])
            db.commit()
            db.close()
            result = compact.compact(path)
            self.assertEqual(result['compacted_observations'], 1)
            db = sqlite3.connect(path)
            self.assertEqual(json.loads(db.execute('SELECT json FROM observations WHERE seq=1').fetchone()[0]), {'price': 100})
            self.assertEqual(json.loads(db.execute('SELECT json FROM observations WHERE seq=2').fetchone()[0]), values[1])
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'append only'):
                db.execute('UPDATE observations SET json="{}" WHERE seq=1')
            db.rollback()
            db.execute('INSERT INTO observations VALUES(3,?)', (json.dumps(values[0]),))
            db.commit()
            db.close()
            original_connect = sqlite3.connect
            class InterruptedConnection(sqlite3.Connection):
                def execute(self, sql, *args):
                    result = super().execute(sql, *args)
                    if sql.startswith('DROP TRIGGER'):
                        raise RuntimeError('interrupted schema update')
                    return result
            with patch.object(compact.sqlite3, 'connect', side_effect=lambda *args, **kwargs: original_connect(*args, **kwargs, factory=InterruptedConnection)):
                with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                    compact.compact(path)
            db = sqlite3.connect(path)
            self.assertIsNotNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='observations_no_update'").fetchone())
            self.assertEqual(json.loads(db.execute('SELECT json FROM observations WHERE seq=3').fetchone()[0]), values[0])
            db.close()
            result = compact.compact(path, representations=False, page_size=16384)
            self.assertEqual(result['counts_preserved']['observations'], 3)
            db = sqlite3.connect(path)
            self.assertEqual(db.execute('PRAGMA page_size').fetchone()[0], 16384)
            self.assertEqual(db.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
            self.assertEqual(json.loads(db.execute('SELECT json FROM observations WHERE seq=3').fetchone()[0]), values[0])
            db.close()

    def test_rollback_rotation_never_touches_unmanaged_backups(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            untouched = root / 'old-manual-copy'
            untouched.mkdir()
            for i in range(5):
                source = root / ('completed-' + str(i))
                source.mkdir()
                (source / '.platform-managed').write_text('completed')
                (source / 'original.env').write_text('private setting')
            ops.rotate_deploy_snapshots({'deploy_backup_dirs': [directory]})
            self.assertTrue(untouched.is_dir())
            self.assertEqual(len(list(root.glob('deploy-*.tar.gz'))), 3)

if __name__ == '__main__':
    unittest.main()
