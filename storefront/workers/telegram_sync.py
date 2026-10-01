"""Import the authorized @macbookbro cloud inbox; never mark messages read.
Use --login interactively once, then run under the dedicated service account.
No Telegram Desktop files or sessions are accessed.
"""
import argparse
import asyncio
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse


def secret(name):
    path = os.environ.get(name + '_FILE')
    return Path(path).read_text().strip() if path else os.environ.get(name, '')


def upload(packet):
    endpoint = os.environ.get('STORE_TELEGRAM_INGEST_URL', 'http://127.0.0.1:4190/internal/inbox/telegram')
    parsed = urlparse(endpoint)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.path != '/internal/inbox/telegram':
        raise ValueError('Only the local storefront ingestion endpoint is allowed')
    timestamp, nonce = str(int(time.time() * 1000)), secrets.token_hex(16)
    body = json.dumps(packet, ensure_ascii=False, separators=(',', ':')).encode()
    signature = hmac.new(secret('STORE_TELEGRAM_INGEST_TOKEN').encode(), (timestamp + '\n' + nonce + '\n').encode() + body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(endpoint, data=body, headers={
        'Host': urlparse(os.environ['STORE_ORIGIN']).netloc, 'Content-Type': 'application/json',
        'X-MB-Timestamp': timestamp, 'X-MB-Nonce': nonce, 'X-MB-Signature': signature,
    })
    with urllib.request.urlopen(request, timeout=25) as response:
        if response.status != 200:
            raise RuntimeError('Inbox rejected the batch')


def message_data(message):
    return {'id': str(message.id), 'direction': 'out' if message.out else 'in',
            'body': message.message or ('[Медиа]' if message.media else '[Служебное сообщение]'),
            'kind': 'media' if message.media else 'text', 'createdAt': int(message.date.timestamp() * 1000)}


async def main(login):
    from telethon import TelegramClient, events
    os.umask(0o077)
    session = Path(os.environ.get('STORE_TELEGRAM_SESSION', '/var/lib/macbookbro-shop/telegram/owner'))
    session.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    client = TelegramClient(str(session), int(os.environ['TELEGRAM_API_ID']), secret('TELEGRAM_API_HASH'))
    await client.connect()
    if login:
        await client.start()
    if not await client.is_user_authorized():
        raise RuntimeError('Owner must authorize the worker with --login')
    me = await client.get_me()
    if (me.username or '').lower() != 'macbookbro' or me.bot:
        raise RuntimeError('Wrong account: expected the owner of @macbookbro')
    expected = os.environ.get('STORE_TELEGRAM_ACCOUNT_ID')
    if expected and str(me.id) != expected:
        raise RuntimeError('Telegram account identity differs from configuration')
    if login:
        print('Рабочий аккаунт авторизован. Сессия сохранена в закрытом каталоге.')
        await client.disconnect()
        return
    if len(secret('STORE_TELEGRAM_INGEST_TOKEN')) < 32:
        raise RuntimeError('Configure an ingestion key of at least 32 characters')
    queue = asyncio.Queue(maxsize=16)
    base = {'accountId': str(me.id), 'username': me.username}
    # Capture changes during the initial scan as well as after it.
    @client.on(events.NewMessage)
    @client.on(events.MessageEdited)
    async def on_message(event):
        entity = await event.get_chat()
        title = getattr(entity, 'title', None) or getattr(entity, 'first_name', None) or 'Клиент'
        await queue.put({**base, 'live': True, 'dialogs': [{'id': str(event.chat_id), 'title': title,
                        'unread': not event.message.out, 'updatedAt': int(event.message.date.timestamp() * 1000),
                        'messages': [message_data(event.message)]}]})
    async def sender():
        while True:
            packet = await queue.get()
            while True:
                try:
                    await asyncio.to_thread(upload, packet)
                    break
                except Exception:
                    print('Синхронизация временно недоступна; пакет ожидает повторного чтения.', flush=True)
                    await asyncio.sleep(10)
            queue.task_done()
    send_task = asyncio.create_task(sender())
    await asyncio.to_thread(upload, {**base, 'dialogs': [], 'complete': False})
    # iter_dialogs includes archived cloud conversations, iter_messages paginates.
    async for dialog in client.iter_dialogs():
        batch = []
        async for message in client.iter_messages(dialog.entity):
            batch.append(message_data(message))
            if len(batch) >= 100:
                await queue.put({**base, 'dialogs': [{'id': str(dialog.id), 'title': dialog.name,
                    'unread': bool(dialog.unread_count), 'messages': batch}]})
                batch = []
        await queue.put({**base, 'dialogs': [{'id': str(dialog.id), 'title': dialog.name,
            'unread': bool(dialog.unread_count), 'messages': batch, 'complete': True}]})
        await queue.join()
    await queue.join()
    await asyncio.to_thread(upload, {**base, 'dialogs': [], 'complete': True})
    await client.run_until_disconnected()
    send_task.cancel()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--login', action='store_true')
    args = parser.parse_args()
    asyncio.run(main(args.login))
