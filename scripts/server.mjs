import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const port = 4173;
const retailers = ['BigGeek', 'Айфория', 'Technichno', 'RifaStore'];
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
let job = null;

const setStatus = async patch => {
  const current = JSON.parse(await readFile(join(root, 'data/status.json'), 'utf8').catch(() => '{"state":"idle","progress":0}'));
  await writeFile(join(root, 'data/status.json'), JSON.stringify({ ...current, ...patch }, null, 2));
};

function refresh() {
  if (job) return job;
  job = (async () => {
    await setStatus({ state: 'running', progress: 5, startedAt: new Date().toISOString(), error: null });
    const timer = setInterval(async () => {
      const current = JSON.parse(await readFile(join(root, 'data/status.json'), 'utf8'));
      await setStatus({ progress: Math.min(90, current.progress + 5) });
    }, 1000);
    await new Promise(resolve => execFile(
      process.execPath,
      ['scripts/build-data.mjs'],
      { cwd: root, env: { ...process.env, LIVE: '1', RETAILER: retailers.join(',') } },
      async error => {
        clearInterval(timer);
        await setStatus(error
          ? { state: 'error', progress: 0, error: error.message }
          : { state: 'ready', progress: 100, updatedAt: new Date().toISOString(), error: null });
        resolve();
      },
    ));
  })().finally(() => { job = null; });
  return job;
}

createServer(async (req, res) => {
  const path = req.url?.split('?')[0] || '/';
  if (path === '/refresh' && req.method === 'POST') {
    refresh();
    res.writeHead(202);
    return res.end();
  }
  if (path === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(await readFile(join(root, 'data/status.json')).catch(() => '{"state":"idle","progress":0}'));
  }

  const rel = path === '/' ? '/web/index.html' : path.endsWith('/') ? `${path}index.html` : path;
  if (rel === '/web/index.html') refresh();
  const file = normalize(join(root, rel));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(port, () => {
  console.log(`Mac Price Radar: http://localhost:${port}/web/`);
  console.log(`A page load refreshes: ${retailers.join(', ')}`);
});
