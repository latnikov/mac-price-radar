import importlib.util
import json
import sqlite3
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
            with sqlite3.connect(source) as db:
                db.executescript('PRAGMA journal_mode=WAL; CREATE TABLE orders(id TEXT PRIMARY KEY,data TEXT); INSERT INTO orders VALUES("accepted","original-price");')
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
                ops.verify_archive(backups[-1], restored)
                self.assertEqual((restored / 'configuration/0-configuration/service.conf').read_text(), 'private configuration')
                self.assertFalse((restored / 'configuration/0-configuration/obsolete-unit').exists())
                with sqlite3.connect(restored / 'shop.sqlite') as db:
                    self.assertEqual(db.execute('SELECT data FROM orders').fetchone()[0], 'original-price')
                with sqlite3.connect(source) as db:
                    self.assertEqual(db.execute('SELECT COUNT(*) FROM orders').fetchone()[0], 1)
                metadata = json.loads((state / 'backup.json').read_text())
                self.assertTrue(metadata['verified'])
                with patch.object(ops, 'sha', return_value='corrupted'):
                    with self.assertRaisesRegex(RuntimeError, 'checksum'):
                        ops.verify_archive(backups[-1], directory / 'corrupted')

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
