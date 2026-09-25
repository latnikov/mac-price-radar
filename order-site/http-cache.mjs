import { createHash } from 'node:crypto';

export function representation(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return { body, etag: `"${createHash('sha256').update(body).digest('base64url')}"` };
}

export function sendRepresentation(req, res, { body, etag }, type) {
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('ETag', etag);
  res.setHeader('Content-Type', `${type}; charset=utf-8`);
  const matches = String(req.headers['if-none-match'] || '').split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*');
  if (matches) { res.writeHead(304); res.end(); return; }
  res.setHeader('Content-Length', body.length);
  res.writeHead(200);
  res.end(req.method === 'HEAD' ? undefined : body);
}
