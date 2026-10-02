# Timeweb production

The canonical source is `latnikov/mac-price-radar`, branch `dev`. The Timeweb
host is `201.34.144.229`. Caddy serves `dev.macbookbro.ru`, `macbookbro.ru`,
`macbookbro.ru/order/`, `crm.macbookbro.ru`, and the old `order.macbookbro.ru`
redirect. DNS remains hosted at Selectel; its A records point to Timeweb.

The application directories are symlinks to a single immutable Git release:

| Service | Working directory | Port |
| --- | --- | --- |
| `mac-price-radar@dev` | `/srv/mac-price-radar/dev` | 4174 |
| `macbookbro-shop` and `macbookbro-worker` | `/srv/macbookbro-shop` | 4190 |
| `macbookbro-orders` | `/srv/macbookbro-orders` | 4180 |

Releases are in `/srv/macbookbro-releases/<full commit SHA>`. Parser runtime
files are in `/srv/macbookbro-data/parser`; each release has a `data` symlink
to that directory. Shop/orders databases and media remain in
`/var/lib/macbookbro-shop` and `/var/lib/macbookbro-orders`. Secrets remain
under `/etc/mac-price-radar`, `/etc/macbookbro-shop`, and the two application
env files. Never overwrite these paths with files from GitHub.

## Automatic deployment

`macbookbro-deploy.timer` polls the public GitHub `dev` branch every two minutes
plus up to 15 seconds jitter. No GitHub write credential or server SSH key is
needed by Actions. The latest `push` run of `.github/workflows/ci.yml` must be
completed successfully for the exact SHA. Missing, pending, failed, cancelled,
or unavailable CI blocks publishing; a previous successful attempt cannot
override a later failed attempt.

The server installs dependencies with scripts disabled and runs the parser,
order, shop, type, and Python operations checks under `radar` before linking
any production data into the candidate. It then rechecks the branch and CI.
A host lock prevents overlapping deployments; active collectors defer the
update. During publication the worker and three HTTP services stop, consistent
compressed SQLite snapshots are saved, and all application symlinks switch.
Health checks validate databases and public HTML before Caddy reload and
worker restart. `X-MacBookBro-Commit` reports the published SHA.

```sh
systemctl status macbookbro-deploy.timer --no-pager
systemctl start macbookbro-deploy.service
journalctl -u macbookbro-deploy.service -n 60 --no-pager
cat /var/lib/macbookbro-ops/deploy.json
curl -I https://macbookbro.ru/
```

`/var/lib/macbookbro-ops/deploy.json` records the commit, successful CI URL,
previous application targets, timestamp and backup directory. Application
processes, collection, health and daily backup timers work without Codex or a
connected Mac. The server mirror lives in `/var/lib/macbookbro-deploy/repo.git`.

## Rollback and data

A failed application health or Caddy check restores the previous application
symlinks and release header. It keeps current databases, including accepted
orders, rather than replacing them with older snapshots. This assumes
backwards compatible database migrations; incompatible schema changes need
a separately reviewed maintenance and restoration plan.

Before each publication, snapshots and previous link targets are saved under
`/var/backups/macbookbro-timeweb-deploy/<timestamp>-<SHA>/`. Daily verified
platform backups use the existing `macbookbro-backup.timer` and include the
historical parser database. Migration generations remain protected under
`/var/backups/macbookbro-migration/{initial,final}`. Inspect existing snapshots
before manually restoring databases; restore only with all writers stopped.

Selectel's application workers must remain disabled after cutover. During DNS
cache expiry its Caddy proxies to Timeweb over verified HTTPS, so both IPs use
the same live databases. The original Selectel data stays available for a
deliberate recovery; switching back requires copying current Timeweb data,
not merely restarting its older applications.

Completed deployment snapshots retain two generations. Release retention keeps
the three most recent verified directories and always protects current and
previous targets. Incomplete deployment evidence and migration snapshots are
not removed automatically.
