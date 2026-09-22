import { pollBusinessUpdates } from './telegram-business.mjs';

const result = await pollBusinessUpdates({ timeout: 0 });
console.log(`Telegram Business API: получено ${result.received}, сохранено сообщений BSA: ${result.state.messages.length}`);
