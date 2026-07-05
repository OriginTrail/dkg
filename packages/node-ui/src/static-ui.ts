import { type ServerResponse } from 'node:http';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export async function handleNodeUIStaticRequest(
  res: ServerResponse,
  url: URL,
  staticDir: string,
): Promise<boolean> {
  const path = url.pathname;
  if (path === '/ui' || path.startsWith('/ui/')) return serveStatic(res, staticDir, path);
  return false;
}

async function serveStatic(res: ServerResponse, staticDir: string, urlPath: string): Promise<true> {
  let filePath = urlPath === '/ui' || urlPath === '/ui/'
    ? join(staticDir, 'index.html')
    : join(staticDir, urlPath.slice('/ui/'.length));

  const lexicalResolved = resolve(filePath);
  const lexicalBase = resolve(staticDir);
  const lexicalRel = relative(lexicalBase, lexicalResolved);
  if (lexicalRel === '..' || lexicalRel.startsWith(`..${sep}`) || isAbsolute(lexicalRel) || resolve(lexicalBase, lexicalRel) !== lexicalResolved) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return true;
  }

  if (existsSync(filePath)) {
    try {
      const realFile = await realpath(filePath);
      const realBase = await realpath(staticDir);
      const realRel = relative(realBase, realFile);
      if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return true;
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return true;
      }
    }
  }

  // SPA fallback: if not a file with extension, serve index.html
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  if (!MIME[ext]) {
    filePath = join(staticDir, 'index.html');
  }

  if (!existsSync(filePath)) {
    filePath = join(staticDir, 'index.html');
  }

  const mimeExt = filePath.slice(filePath.lastIndexOf('.'));
  const isHtml = mimeExt === '.html';

  try {
    const s = await stat(filePath);
    const contentType = MIME[mimeExt] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': s.size,
      'Cache-Control': isHtml ? 'no-store' : 'public, max-age=31536000, immutable',
      ...staticSecurityHeaders(isHtml),
    });
    const stream = createReadStream(filePath);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Stream read error' }));
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
  } catch {
    res.writeHead(503, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end('<!DOCTYPE html><html><body><h1>Node UI not built</h1><p>Run <code>pnpm build:ui</code> in @origintrail-official/dkg-node-ui</p></body></html>');
  }

  return true;
}

function staticSecurityHeaders(isHtml: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (isHtml) {
    headers['Content-Security-Policy'] = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob:",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self' http: https: ws: wss:",
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
  }
  return headers;
}
