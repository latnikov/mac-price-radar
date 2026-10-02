import ast
from pathlib import Path
import unittest
from redesign_routing import migrate, site_span
from parser_access import public_parser_routing


class ParserRoutingTests(unittest.TestCase):
    def setUp(self):
        tree = ast.parse(Path(__file__).with_name('install.py').read_text())
        self.source = next(node.value.value for node in ast.walk(tree)
                           if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'caddy' for t in node.targets)
                           and isinstance(node.value, ast.Constant))

    def test_redirects_preserve_webhook_and_order(self):
        updated = migrate(self.source)
        dev = updated[slice(*site_span(updated, 'dev.macbookbro.ru'))]
        self.assertIn('redir https://crm.macbookbro.ru/crm/parser{uri} 308', dev)
        self.assertIn('@telegramWebhook path /api/telegram/bsa-webhook', dev)
        self.assertNotIn('forward_auth', dev)
        self.assertEqual(updated[slice(*site_span(updated, 'order.macbookbro.ru'))],
                         self.source[slice(*site_span(self.source, 'order.macbookbro.ru'))])
        self.assertEqual(updated[slice(*site_span(updated, 'crm.macbookbro.ru'))],
                         self.source[slice(*site_span(self.source, 'crm.macbookbro.ru'))])
        self.assertIn('reverse_proxy 127.0.0.1:4180', updated)
        self.assertEqual(migrate(updated), updated)

    def test_unknown_configuration_fails_before_writing(self):
        with self.assertRaises(ValueError):
            migrate(self.source.replace('127.0.0.1:4174', '127.0.0.1:1234'))

    def test_recent_public_dev_configuration_is_preserved(self):
        source = public_parser_routing(self.source)
        updated = migrate(source)
        self.assertEqual(updated[slice(*site_span(updated, 'dev.macbookbro.ru'))],
                         source[slice(*site_span(source, 'dev.macbookbro.ru'))])
        self.assertIn('redir /prices https://crm.macbookbro.ru/crm/parser/ 308', updated)
        self.assertEqual(updated[slice(*site_span(updated, 'order.macbookbro.ru'))],
                         source[slice(*site_span(source, 'order.macbookbro.ru'))])
        self.assertEqual(migrate(updated), updated)


if __name__ == '__main__':
    unittest.main()
