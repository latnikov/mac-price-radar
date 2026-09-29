import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip);

// Cache the serialized representation too; simultaneous requests share a build.
export function createResponseCache() {
  const entries = new Map();
  return async function cached(key, revision, build) {
    let entry = entries.get(key);
    if (!entry || entry.revision !== revision) {
      entry = { revision };
      entry.pending = Promise.resolve().then(build).then(async value => {
        const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
        const compressed = body.length >= 1024 ? await compress(body, { level: 1 }) : null;
        return { body, gzipBody: compressed?.length < body.length ? compressed : null,
          etag: `"${createHash('sha256').update(body).digest('base64url')}"` };
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

export function sendCached(req, res, { body, gzipBody, etag }, type, securityHeaders) {
  const accepted = new Map(String(req.headers['accept-encoding'] || '').toLowerCase().split(',').map(part => {
    const [name, ...params] = part.trim().split(';');
    const quality = params.find(param => param.trim().startsWith('q='));
    return [name.trim(), quality == null ? 1 : Number(quality.trim().slice(2)) || 0];
  }));
  if (gzipBody && (accepted.get('gzip') ?? accepted.get('*') ?? 0) > 0) {
    body = gzipBody;
    etag = etag.replace(/"$/, '-gzip"');
  }
  const headers = { ...securityHeaders, 'content-type': type, etag, 'cache-control': 'private, no-cache', vary: 'Accept-Encoding',
    ...(body === gzipBody ? { 'content-encoding': 'gzip' } : {}) };
  const matches = String(req.headers['if-none-match'] || '').split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*');
  if (matches) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { ...headers, 'content-length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}
