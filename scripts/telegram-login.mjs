import { writeFile, chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Writable } from 'node:stream';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';

const outputPath = process.argv[2] || '/etc/mac-price-radar/telegram.env';
const mutedOutput = new Writable({ write(chunk, encoding, callback) { if (!mutedOutput.muted) stdout.write(chunk, encoding); callback(); } });
mutedOutput.muted = false;
const prompt = createInterface({ input: stdin, output: mutedOutput, terminal: true });
const ask = label => prompt.question(label).then(value => value.trim());
const askSecret = async label => {
  stdout.write(label);
  mutedOutput.muted = true;
  const value = await prompt.question('');
  mutedOutput.muted = false;
  stdout.write('\n');
  return value.trim();
};

let client;
try {
  const apiId = Number(await ask('Telegram API ID: '));
  const apiHash = await askSecret('Telegram API hash: ');
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) throw new Error('Некорректные API ID/hash');
  client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
  await client.start({
    phoneNumber: () => ask('Номер телефона в международном формате: '),
    phoneCode: () => askSecret('Код входа из Telegram: '),
    password: () => askSecret('Пароль двухэтапной аутентификации: '),
    onError: error => stdout.write(`Telegram: ${error.message}\n`),
  });
  const account = await client.getMe();
  const session = client.session.save();
  if (!session) throw new Error('Telegram не вернул сессию');
  await writeFile(outputPath, `TELEGRAM_API_ID=${apiId}\nTELEGRAM_API_HASH=${apiHash}\nTELEGRAM_SESSION=${session}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
  stdout.write(`Готово: авторизован ${account.username ? `@${account.username}` : account.firstName || 'Telegram-аккаунт'}; сессия сохранена в ${outputPath}\n`);
} finally {
  prompt.close();
  await client?.disconnect().catch(() => {});
}
