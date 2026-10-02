import { readFileSync } from 'node:fs';

export const catalogueBrands = [
  ['Apple', 'apple', 26], ['Anker', 'anker', 110], ['UGREEN', 'ugreen', 122],
  ['Logitech', 'logitech', 104], ['Ray-Ban Meta', 'rayban-meta', 140],
];
// Serve only these reviewed SVGs, without a session or arbitrary filesystem paths.
const assets = new Map(catalogueBrands.map(([, name]) => [
  `/brands/${name}.svg`, readFileSync(new URL(`./brand-assets/${name}.svg`, import.meta.url)),
]));
export function serveBrandAsset(req, res, path, send) {
  if (!path.startsWith('/brands/')) return false;
  const asset = assets.get(path);
  if (!asset) { send(req, res, 404, 'Not found', 'text/plain; charset=utf-8'); return true; }
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD');
    send(req, res, 405, 'Method not allowed', 'text/plain; charset=utf-8'); return true;
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  send(req, res, 200, asset, 'image/svg+xml'); return true;
}
