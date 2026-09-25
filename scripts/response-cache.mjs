import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

// Cache the serialized representation too; simultaneous requests share a build.
export function createResponseCache() {
  const entries = new Map();
  return async function cached(key, revision, build) {
    let entry = entries.get(key);
    if (!entry || entry.revision !== revision) {
      entry = { revision };
      entry.pending = Promise.resolve().then(build).then(value => {
        const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
        return { body, etag: `"${createHash('sha256').update(body).digest('base64url')}"` };
      }).catch(error => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      entries.set(key, entry);
    }
    return entry.pending;
  };
}

export async function cachedFile(cache, path) {
  const info = await stat(path);
  return cache(path, `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`, () => readFile(path));
}

export function sendCached(req, res, { body, etag }, type, securityHeaders) {
  const headers = { ...securityHeaders, 'content-type': type, etag, 'cache-control': 'private, no-cache' };
  const matches = String(req.headers['if-none-match'] || '').split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*');
  if (matches) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { ...headers, 'content-length': body.length });
  res.end(body);
}
