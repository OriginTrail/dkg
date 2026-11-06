// The dashboard's static server: read-only, no dependencies, and it serves exactly
// two files. Anything else is a 404, any other method a 405.
//
//   BIND  the address to listen on; default 127.0.0.1
//   PORT  default 8127
//   WWW   the folder holding index.html and data.json; default ./www beside this file

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bind = process.env.BIND ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8127);
const www = process.env.WWW ?? join(dirname(fileURLToPath(import.meta.url)), 'www');

const ROUTES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' }],
  ['/data.json', { file: 'data.json', type: 'application/json; charset=utf-8', cache: 'no-cache' }],
]);

const SECURITY = {
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const server = createServer(async (req, res) => {
  const send = (status, headers, body) => {
    res.writeHead(status, { ...SECURITY, ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }, 'method not allowed\n');
  const path = (req.url ?? '/').split('?')[0];
  const route = ROUTES.get(path);
  if (!route) return send(404, { 'Content-Type': 'text/plain' }, 'not found\n');
  try {
    // Every poll revalidates, and an unchanged file answers in a few bytes.
    const file = join(www, route.file);
    const modified = (await stat(file)).mtime;
    modified.setMilliseconds(0);
    const headers = { 'Cache-Control': route.cache, 'Last-Modified': modified.toUTCString() };
    const since = Date.parse(req.headers['if-modified-since'] ?? '');
    if (!Number.isNaN(since) && modified.getTime() <= since) return send(304, headers);
    const body = await readFile(file);
    return send(200, { ...headers, 'Content-Type': route.type, 'Content-Length': body.length }, body);
  } catch {
    return send(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, 'not ready\n');
  }
});

server.requestTimeout = 10_000;
server.headersTimeout = 5_000;
server.keepAliveTimeout = 5_000;
server.maxConnections = 128;

server.listen(port, bind, () => {
  console.log(`serving ${www} on http://${bind}:${port}/`);
});
