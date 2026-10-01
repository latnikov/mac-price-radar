"""Public dev parser routing; leave all other site blocks unchanged."""
import re


def public_parser_routing(source):
    match = re.search(r'(?m)^dev\.macbookbro\.ru\s*\{', source)
    if not match:
        raise ValueError('dev.macbookbro.ru site missing')
    cursor, depth = match.end(), 1
    while cursor < len(source) and depth:
        depth += (source[cursor] == '{') - (source[cursor] == '}')
        cursor += 1
    if depth:
        raise ValueError('Unclosed dev site block')
    return source[:match.start()] + '''dev.macbookbro.ru {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4174 {
        header_up Host 127.0.0.1:4174
    }
}''' + source[cursor:]
