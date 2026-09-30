import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

// Dedicated visible Chrome profile: never connects to the user's personal tabs.
export async function connectForeignBrowser(root = process.cwd()) {
  const endpoint = 'http://127.0.0.1:9333';
  const list = async () => (await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
  try { await list(); } catch {
    const profile = resolve(root, 'data/private/appleinsider-browser');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const child = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      '--remote-debugging-port=9333', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', 'https://prices.appleinsider.com/',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 30; i++) { try { await list(); break; } catch { await new Promise(r => setTimeout(r, 1000)); } }
  }
  let tab = (await list()).find(t => t.type === 'page' && t.url.startsWith('https://prices.appleinsider.com'));
  if (!tab) tab = await (await fetch(`${endpoint}/json/new?https://prices.appleinsider.com/`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl), pending = new Map();
  let id = 0;
  await new Promise((resolveOpen, reject) => { ws.addEventListener('open', resolveOpen, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', e => {
    const message = JSON.parse(e.data), waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); }
  });
  ws.addEventListener('close', () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Браузер закрыт')); } pending.clear(); });
  const command = (method, params = {}) => new Promise((resolveCommand, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Браузер: таймаут ${method}`)); }, 30000);
    pending.set(requestId, { resolve: resolveCommand, reject, timer }); ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  await command('Page.enable');
  ws.addEventListener('message', e => {
    const message = JSON.parse(e.data);
    if (message.method === 'Page.javascriptDialogOpening') {
      // A site's leave-page dialog must not hold the hourly collection open.
      void command('Page.handleJavaScriptDialog', { accept: message.params.type === 'beforeunload' }).catch(() => {});
    }
  });
  return {
    close: () => ws.close(),
    async fetchPage(url) {
      const target = new URL(url);
      if (!['prices.appleinsider.com', 'www.google.com'].includes(target.hostname) || target.protocol !== 'https:') throw new Error('Недопустимый адрес браузерного сбора');
      const navigation = await command('Page.navigate', { url });
      if (navigation.errorText) throw new Error(navigation.errorText);
      for (let attempt = 0; attempt < 90; attempt++) {
        await new Promise(r => setTimeout(r, 1000));
        const result = await command('Runtime.evaluate', { expression: `JSON.stringify({url:location.href,ready:document.readyState,title:document.title,html:document.documentElement.outerHTML})`, returnByValue: true });
        const page = JSON.parse(result.result.value || '{}');
        if (page.ready !== 'complete' || page.url === 'about:blank') continue;
        if (new URL(page.url).hostname === target.hostname && new URL(page.url).pathname.replace(/\/$/, '') !== target.pathname.replace(/\/$/, '')) {
          if (attempt === 10 || attempt === 20) await command('Page.navigate', { url });
          if (attempt >= 30) throw new Error(`Браузер не перешёл на ${target.pathname}; открыт ${new URL(page.url).pathname}`);
          continue;
        }
        if (/Just a moment|Attention Required|Checking your browser/i.test(page.title)) continue;
        if (new URL(page.url).hostname !== target.hostname) throw new Error(`Источник перенаправил на ${page.url}`);
        await mkdir(join(root, 'data/private/foreign-html'), { recursive: true, mode: 0o700 });
        await writeFile(join(root, 'data/private/foreign-html', `${target.hostname}-${target.pathname.replace(/[^a-z0-9-]/gi, '_')}.html`), page.html, { mode: 0o600 });
        return page.html;
      }
      throw new Error(`Нужно пройти проверку в отдельном Chrome: ${url}`);
    },
  };
}
