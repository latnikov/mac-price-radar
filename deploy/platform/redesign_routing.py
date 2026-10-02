"""Prepare canonical parser routing, preserving the order application and webhook.

CLI writes a candidate only: python3 redesign_routing.py CURRENT_CADDY CANDIDATE
Validate and reload the candidate after installing the matching storefront code.
"""
import re
import sys
from pathlib import Path


def site_span(source, host):
    match = re.search(r'(?m)^' + re.escape(host) + r'\s*\{', source)
    if not match:
        raise ValueError('Expected site missing: ' + host)
    start, cursor, depth = match.start(), match.end(), 1
    while cursor < len(source) and depth:
        depth += (source[cursor] == '{') - (source[cursor] == '}')
        cursor += 1
    if depth:
        raise ValueError('Unclosed site: ' + host)
    return start, cursor


def migrate(source):
    before_order = source[slice(*site_span(source, 'order.macbookbro.ru'))]
    start, end = site_span(source, 'dev.macbookbro.ru')
    old_dev = source[start:end]
    public_dev = '''dev.macbookbro.ru {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4174 {
        header_up Host 127.0.0.1:4174
    }
}'''
    if old_dev == public_dev:
        # A newer release intentionally exposes dev. Keep that decision while
        # adding the CRM parser and repairing only the older /prices mount.
        pass
    elif '127.0.0.1:4174' not in old_dev or '@telegramWebhook' not in old_dev:
        raise ValueError('Unexpected dev configuration; review before migration')
    else:
        source = source[:start] + '''dev.macbookbro.ru {
    encode zstd gzip
    @telegramWebhook path /api/telegram/bsa-webhook
    handle @telegramWebhook {
        reverse_proxy 127.0.0.1:4174 {
            header_up Host 127.0.0.1:4174
        }
    }
    @legacyParser path /web /web/* /api/*
    handle @legacyParser {
        redir https://crm.macbookbro.ru/crm/parser{uri} 308
    }
    handle {
        redir https://crm.macbookbro.ru/crm/parser/ 308
    }
}''' + source[end:]
    start, end = site_span(source, 'macbookbro.ru')
    shop = source[start:end]
    # The application owns parser authentication on both CRM entry points.
    # This exact known block prevents an accidental broad proxy rewrite.
    old = '''    handle_path /prices/* {
        forward_auth 127.0.0.1:4190 {
            uri /internal/staff-auth
            header_up Host macbookbro.ru
        }
        @pricesRoot path /
        redir @pricesRoot /prices/web/ 308
        reverse_proxy 127.0.0.1:4174 {
            header_up Host 127.0.0.1:4174
        }
    }'''
    new = '''    handle_path /prices/* {
        @pricesRoot path /
        redir @pricesRoot https://crm.macbookbro.ru/crm/parser/ 308
        redir https://crm.macbookbro.ru/crm/parser{uri} 308
    }'''
    if old not in shop and new not in shop:
        raise ValueError('Unexpected prices mount; review before migration')
    shop = shop.replace(old, new).replace('redir /prices /prices/ 308', 'redir /prices https://crm.macbookbro.ru/crm/parser/ 308')
    source = source[:start] + shop + source[end:]
    if source[slice(*site_span(source, 'order.macbookbro.ru'))] != before_order:
        raise AssertionError('Order routing changed')
    return source


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: redesign_routing.py CURRENT_CADDY CANDIDATE')
    current, candidate = map(Path, sys.argv[1:])
    if current.resolve() == candidate.resolve():
        raise SystemExit('A separate candidate file is required')
    candidate.write_text(migrate(current.read_text()))
    candidate.chmod(0o600)
    print('Candidate prepared; validate before applying.')
