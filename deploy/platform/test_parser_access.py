import unittest
from types import SimpleNamespace
from unittest.mock import patch
from parser_access import public_parser_routing
from update_parser import active


class PublicParserTests(unittest.TestCase):
    def test_removes_dev_auth_and_preserves_every_other_site(self):
        prefix = 'macbookbro.ru {\n reverse_proxy 127.0.0.1:4190\n}\n'
        suffix = '\ncrm.macbookbro.ru {\n respond 404\n}\norder.macbookbro.ru {\n reverse_proxy 127.0.0.1:4180\n}\n'
        source = prefix + '''dev.macbookbro.ru {
    handle {
        forward_auth 127.0.0.1:4190 {
            uri /internal/staff-auth
        }
        reverse_proxy 127.0.0.1:4174
    }
}''' + suffix
        result = public_parser_routing(source)
        self.assertTrue(result.startswith(prefix))
        self.assertTrue(result.endswith(suffix))
        self.assertNotIn('forward_auth', result)
        self.assertIn('header_up Host 127.0.0.1:4174', result)
        self.assertEqual(public_parser_routing(result), result)

    def test_replaces_dev_login_redirect_with_direct_parser_proxy(self):
        result = public_parser_routing('dev.macbookbro.ru {\n redir https://crm.macbookbro.ru/crm/parser/ 308\n}')
        self.assertNotIn('redir', result)
        self.assertIn('reverse_proxy 127.0.0.1:4174', result)

    def test_missing_or_unclosed_site_is_rejected(self):
        for source in ['macbookbro.ru {}', 'dev.macbookbro.ru { handle { }']:
            with self.assertRaises(ValueError):
                public_parser_routing(source)

    def test_oneshot_collector_is_running_while_systemd_reports_activating(self):
        for state in ['active', 'activating', 'reloading']:
            with patch('update_parser.subprocess.run', return_value=SimpleNamespace(stdout=state + '\n')):
                self.assertTrue(active('mac-price-radar-collect.service'))
        with patch('update_parser.subprocess.run', return_value=SimpleNamespace(stdout='inactive\n')):
            self.assertFalse(active('mac-price-radar-collect.service'))
