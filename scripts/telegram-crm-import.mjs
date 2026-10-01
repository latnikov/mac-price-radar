import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { openShopStore } from '../storefront/core.mjs';
import { openInbox } from '../storefront/inbox.mjs';
import { openRetail } from '../storefront/retail.mjs';
import { openCrmDesk } from '../storefront/crm-desk.mjs';
import { importTelegramExport } from '../storefront/telegram-export.mjs';
const path = process.argv[2];
if (!path) { console.error('Укажите путь к result.json экспорта Telegram Desktop.'); process.exit(1); }
const store = openShopStore(process.env.STORE_DB || resolve('data/private/storefront/shop.sqlite'), { recoverJobs: false });
try {
  const bytes = readFileSync(path), inbox = openInbox(store, { recoverOutbox: false }), retail = openRetail(store), desk = openCrmDesk(store, inbox, retail);
  const report = importTelegramExport(store, inbox, desk, JSON.parse(bytes.toString()), createHash('sha256').update(bytes).digest('hex'), process.env.STORE_TELEGRAM_ACCOUNT_ID);
  desk.reconcileDialogs(); console.log(JSON.stringify(report));
} catch (e) { console.error(e.status ? e.message : 'Импорт не завершён. Доступные данные сохранены.'); process.exitCode = 1; }
finally { store.close(); }
