import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

if (!process.argv[2]) throw new Error('Supply the owned preview state directory (www and public-origin).');
const state = resolve(process.argv[2]);
const root = resolve(state, 'www');
const capability = '/spike/ka/accounts/account-a/capabilities';
const identities = new Set(['Bearer l1-owner-a', 'Bearer l1-viewer-a']);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json' };
const writes = [];
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data));
}
const server = http.createServer(async (req, res) => {
  try {
    let origin;
    try { origin = (await readFile(resolve(state, 'public-origin'), 'utf8')).trim(); }
    catch { return json(res, 503, { error: 'Preview is being prepared' }); }
    if (origin !== 'http://127.0.0.1:4621' && !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(origin)) throw new Error('Invalid preview origin');
    if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: 'Preview host required' });
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'Preview origin required' });
    const url = new URL(req.url, origin);
    const path = url.pathname;
    const event = /^\/spike\/ka\/events\/[a-f0-9-]{36}$/.test(path);
    const ka = event || ['', '/invoke', '/inspect', '/workflows', '/workflows/save', '/workflows/run',
      '/studio', '/studio/save', '/studio/run', '/studio/invoke', '/studio/activation', '/studio/history'].some(suffix => path === capability + suffix);
    const kit = path.startsWith('/v1/');
    if (ka || kit) {
      if (!event && !identities.has(req.headers.authorization)) return json(res, 403, { error: 'Use a public account-A kit selector' });
      const invoke = event || ka && ['/invoke', '/workflows/save', '/workflows/run', '/studio/save', '/studio/run', '/studio/activation'].some(suffix => path.endsWith(suffix));
      if (req.method !== (invoke ? 'POST' : 'GET')) return json(res, 405, { error: 'Method unavailable in this preview' });
      if (invoke && !event && req.headers.authorization !== 'Bearer l1-owner-a') return json(res, 403, { error: 'Invocation denied' });
      let body;
      if (invoke) {
        const now = Date.now();
        while (writes[0] < now - 60_000) writes.shift();
        if (writes.length >= 20) return json(res, 429, { error: 'Preview invocation limit reached; retry in a minute' });
        if (Number(req.headers['content-length'] ?? 0) > 16384) return json(res, 413, { error: 'Input too large' });
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) return json(res, 413, { error: 'Input too large' }); chunks.push(chunk); }
        body = Buffer.concat(chunks); writes.push(now);
      }
      const upstream = await fetch(`${ka ? 'http://127.0.0.1:4631' : 'http://127.0.0.1:4610'}${path}${url.search}`, {
        method: req.method, redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { ...(!event ? { authorization: req.headers.authorization } : {}), origin: 'http://127.0.0.1:4620',
          ...(invoke ? { 'content-type': 'application/json' } : {}),
          ...(invoke && !event && typeof req.headers['x-dkg-export-token'] === 'string' ? { 'x-dkg-export-token': req.headers['x-dkg-export-token'] } : {}) }, ...(body ? { body } : {}),
      });
      const data = await upstream.arrayBuffer();
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return res.end(Buffer.from(data));
    }
    if (/^\/(?:api|rest|auth|spike|webhook|kit)(?:\/|$)/.test(path)) return json(res, 404, { error: 'Route unavailable in this preview' });
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method unavailable' });
    const decoded = decodeURIComponent(path);
    if (decoded.split('/').some(part => part.startsWith('.') || part.includes('\\'))) return json(res, 404, { error: 'Unavailable' });
    let file = resolve(root, '.' + decoded);
    if (!file.startsWith(root + sep) && file !== root) return json(res, 404, { error: 'Unavailable' });
    let exists = false;
    try { exists = (await stat(file)).isFile(); } catch {}
    if (!exists) {
      if (extname(path) || !/^\/(?:$|sign-in$|accounts(?:\/|$))/.test(path)) return json(res, 404, { error: 'Unavailable' });
      file = resolve(root, 'index.html');
    }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { if (!res.headersSent) json(res, 502, { error: 'Preview service unavailable' }); else res.end(); }
});
server.requestTimeout = 65_000;
server.headersTimeout = 10_000;
server.listen(4621, '127.0.0.1', () => console.log('KA preview gateway listening on 127.0.0.1:4621'));
process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
