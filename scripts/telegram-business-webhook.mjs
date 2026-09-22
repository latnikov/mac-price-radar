import { configureBusinessWebhook } from './telegram-business.mjs';

const result = await configureBusinessWebhook();
console.log(`Telegram Business webhook настроен: ${result.url}; ожидают доставки: ${result.pendingUpdateCount}`);
if (result.lastErrorMessage) console.log(`Последняя ошибка Telegram: ${result.lastErrorMessage}`);
