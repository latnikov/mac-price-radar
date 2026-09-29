"""Install a prepared /srv/macbookbro-shop build on the existing server.
Preserves legacy services and reuses the existing main-domain CRM credentials.
Run as root only after uploading the reviewed storefront and retail-analytics.js.
"""
import os
import re
import secrets
import shutil
import subprocess
import time
from pathlib import Path

if os.geteuid() != 0:
    raise SystemExit('Run on the deployment server as root')
base=Path('/srv/macbookbro-shop')
assert (base/'storefront/server.mjs').is_file()
caddy=Path('/etc/caddy/Caddyfile')
original=caddy.read_text()
match=re.search(r'(?ms)^macbookbro\.ru\s*\{.*?(?=^dev\.macbookbro\.ru\s*\{)',original)
if not match:
    raise SystemExit('Unexpected Caddyfile layout; no changes made')
auth=re.search(r'(?s)(?:basicauth|basic_auth)\s*\{([^}]+)\}',match.group())
if not auth:
    raise SystemExit('Existing CRM authentication not found; no changes made')
auth_block='basicauth {'+auth.group(1)+'}'
backup=Path('/var/backups/macbookbro-shop')/time.strftime('%Y%m%d-%H%M%S')
backup.mkdir(parents=True,mode=0o700)
os.chmod(backup.parent,0o700)
shutil.copy2(caddy,backup/'Caddyfile')
unit=Path('/etc/systemd/system/macbookbro-shop.service')
if unit.exists():shutil.copy2(unit,backup/unit.name)
env_path=Path('/etc/macbookbro-shop.env')
if env_path.exists():shutil.copy2(env_path,backup/env_path.name)
conf=Path('/etc/macbookbro-shop');conf.mkdir(exist_ok=True,mode=0o750)
shutil.chown(conf,user='root',group='radar')
token_path=conf/'proxy-token'
if not token_path.exists():token_path.write_text(secrets.token_urlsafe(48)+'\n')
os.chmod(token_path,0o640);shutil.chown(token_path,user='root',group='radar')
proxy_token=token_path.read_text().strip()
assert re.fullmatch(r'[A-Za-z0-9_-]{32,}',proxy_token)
if not env_path.exists():
    env_path.write_text('\n'.join([
        'STORE_ORIGIN=https://macbookbro.ru',
        'STORE_PORT=4190',
        'STORE_DB=/var/lib/macbookbro-shop/shop.sqlite',
        'STORE_MEDIA_DIR=/var/lib/macbookbro-shop/media',
        'STORE_DEV_URL=http://127.0.0.1:4174/api/table',
        'STORE_TRUST_PROXY=loopback',
        'STORE_PROXY_AUTH_TOKEN_FILE=/etc/macbookbro-shop/proxy-token',
        'STORE_FEED_TOKEN='+secrets.token_urlsafe(48),
        'STORE_REQUESTS_PER_MINUTE=90','']))
    os.chmod(env_path,0o600)
data=Path('/var/lib/macbookbro-shop');data.mkdir(exist_ok=True,mode=0o700)
shutil.chown(data,user='radar',group='radar')
shutil.copyfile(base/'storefront/deploy/macbookbro-shop.service',unit)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now','macbookbro-shop'],check=True)
subprocess.run(['systemctl','restart','macbookbro-shop'],check=True)
for attempt in range(30):
    health=subprocess.run(['curl','--fail','--silent','--max-time','2','-H','Host: macbookbro.ru','http://127.0.0.1:4190/healthz'],capture_output=True)
    if health.returncode==0:break
    time.sleep(1)
else:raise SystemExit('Shop health failed; public Caddy route unchanged')
main='''macbookbro.ru {
    encode zstd gzip
    @crm path /crm /crm/*
    handle @crm {
        AUTH
        request_body {
            max_size 6MB
        }
        reverse_proxy 127.0.0.1:4190 {
            header_up X-Store-Admin-Key TOKEN
        }
    }
    redir /prices /prices/ 308
    redir /web /prices/web/ 308
    redir /web/* /prices{uri} 308
    handle_path /prices/* {
        AUTH
        @pricesRoot path /
        redir @pricesRoot /prices/web/ 308
        reverse_proxy 127.0.0.1:4173 {
            header_up Host 127.0.0.1:4173
            header_up Origin http://127.0.0.1:4173
            header_up -X-Store-Admin-Key
        }
    }
    handle {
        request_body {
            max_size 32KB
        }
        reverse_proxy 127.0.0.1:4190 {
            header_up -X-Store-Admin-Key
        }
    }
}

'''.replace('AUTH',auth_block).replace('TOKEN',proxy_token)
candidate=backup/'Caddyfile.candidate';candidate.write_text(original[:match.start()]+main+original[match.end():]);os.chmod(candidate,0o600)
validation=subprocess.run(['caddy','validate','--config',str(candidate),'--adapter','caddyfile'],capture_output=True)
if validation.returncode!=0:raise SystemExit('Caddy validation failed; original file retained. Inspect candidate privately.')
shutil.copyfile(candidate,caddy);os.chmod(caddy,0o640);shutil.chown(caddy,user='root',group='caddy')
reload=subprocess.run(['systemctl','reload','caddy'],capture_output=True)
if reload.returncode!=0:
    shutil.copyfile(backup/'Caddyfile',caddy)
    subprocess.run(['systemctl','reload','caddy'],check=True)
    raise SystemExit('Caddy reload failed; restored original route')
print('Shop installed; previous Caddyfile:',backup/'Caddyfile')
print('Store: https://macbookbro.ru/ ; CRM: https://macbookbro.ru/crm')
print('CRM reuses existing main-domain login. No test products imported.')
