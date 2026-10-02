"""Release gates, WAL snapshot preservation, and atomic code rollback."""
import gzip
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('timeweb_deploy', Path(__file__).parents[1] / 'timeweb/deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class TimewebDeploymentTests(unittest.TestCase):
    def run_record(self, **updates):
        return {'id': 1, 'head_sha': 'a' * 40, 'head_branch': 'dev', 'event': 'push',
                'path': '.github/workflows/ci.yml', 'status': 'completed', 'conclusion': 'success', **updates}

    def test_ci_never_uses_another_commit_branch_event_or_workflow(self):
        for field, value in [('head_sha', 'b' * 40), ('head_branch', 'main'),
                             ('event', 'pull_request'), ('path', '.github/workflows/pages.yml')]:
            self.assertIsNone(deploy.successful_run({'workflow_runs': [self.run_record(**{field: value})]}, 'a' * 40))

    def test_newest_failed_or_pending_attempt_blocks_old_success(self):
        old = self.run_record()
        for newer in [self.run_record(id=2, conclusion='failure'),
                      self.run_record(id=2, status='in_progress', conclusion=None),
                      self.run_record(run_attempt=2, conclusion='failure')]:
            self.assertIsNone(deploy.successful_run({'workflow_runs': [old, newer]}, 'a' * 40))
        self.assertEqual(deploy.successful_run({'workflow_runs': [old]}, 'a' * 40), old)

    def test_secrets_and_traversal_cannot_enter_a_release(self):
        for name in ['.env.crm', 'config/staff-users.json', 'data/private/chats.json',
                     'data/master.sqlite-wal', 'keys/server.key', '../outside', '/etc/passwd']:
            with self.assertRaises(RuntimeError):
                deploy.safe_release_names([name])
        deploy.safe_release_names(['scripts/server.mjs', 'deploy/avito/env.example', 'data/catalog.json'])

    def test_snapshot_includes_wal_and_preserves_accepted_unicode_payload(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'orders.sqlite'
            db = sqlite3.connect(source)
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE orders(id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            expected = '{"name":"Тест", "note":"строка\\nвторая"}'
            db.execute('INSERT INTO orders VALUES(?, ?)', ('MB-TEST', expected))
            db.commit()
            archive = root / 'orders.sqlite.gz'
            deploy.snapshot_database(source, archive)
            restored = root / 'restored.sqlite'
            with gzip.open(archive, 'rb') as stream:
                restored.write_bytes(stream.read())
            with sqlite3.connect(restored) as check:
                self.assertEqual(check.execute('SELECT payload FROM orders').fetchone()[0], expected)
                self.assertEqual(check.execute('PRAGMA quick_check').fetchone()[0], 'ok')
            db.close()

    def test_code_rollback_does_not_change_data_or_overwrite_real_directories(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            old, new = root / 'old', root / 'new'
            old.mkdir()
            new.mkdir()
            data = root / 'accepted-orders'
            data.write_text('accepted after deploy')
            link = root / 'current'
            deploy.replace_link(link, old)
            deploy.replace_link(link, new)
            deploy.replace_link(link, old)
            self.assertEqual(link.resolve(), old.resolve())
            self.assertEqual(data.read_text(), 'accepted after deploy')
            with self.assertRaises(RuntimeError):
                deploy.replace_link(old, new)


if __name__ == '__main__':
    unittest.main()
