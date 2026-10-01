import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrderService } from '../server.mjs';

// Resolve dependencies from their public URLs, as the browser does. Merely
// getting /app.js misses imports which escape a mounted application.
for (const basePath of ['', '/order']) {
  test(`browser module graph and privacy navigation stay inside ${basePath || '/'}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'mb-browser-assets-'));
    const service = createOrderService({ env: { ORDER_BASE_PATH: basePath }, dbPath: join(directory, 'orders.sqlite'), runWorker: false });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
    const entry = `http://127.0.0.1:${service.server.address().port}${basePath}/`;
    const page = await fetch(entry);
    assert.equal(page.status, 200);
    const html = await page.text();
    const src = html.match(/<script\b[^>]*\bsrc="([^"]+)"/)[1];
    const queue = [new URL(src, entry).href], visited = new Set();
    while (queue.length) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      assert.ok(url.startsWith(entry), `Module escapes application: ${url}`);
      const response = await fetch(url);
      assert.equal(response.status, 200, `Browser cannot load ${url}`);
      assert.match(response.headers.get('content-type'), /javascript/);
      const code = await response.text();
      for (const [, specifier] of code.matchAll(/^\s*(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
        queue.push(new URL(specifier, url).href);
      }
    }
    assert.deepEqual([...visited].map(url => new URL(url).pathname).sort(), ['app.js', 'catalog.mjs', 'quote-client.mjs', 'selection-link.mjs'].map(name => `${basePath}/${name}`).sort());
    const privacyUrl = new URL(html.match(/href="([^"]*privacy\.html)"/)[1], entry);
    const privacy = await fetch(privacyUrl);
    assert.equal(privacy.status, 200);
    const content = await privacy.text();
    const style = new URL(content.match(/<link\b[^>]*href="([^"]+)"/)[1], privacyUrl);
    assert.ok(style.href.startsWith(entry));
    assert.equal((await fetch(style)).status, 200);
    const back = new URL(content.match(/<a\b[^>]*href="([^"]+)"/)[1], privacyUrl);
    assert.equal(back.href, entry);
    assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
  });
}
