/**
 * Generic DKG App Loader
 *
 * Discovers installed packages that declare a `dkgApp` field in their
 * package.json, loads their API handlers, and serves their static UI.
 *
 * This is the one-time mechanism that enables installable DKG apps:
 * no per-app code needed in packages/cli or packages/node-ui.
 */

import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { createRequire } from 'node:module';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

export interface DkgAppManifest {
  id: string;
  label: string;
  apiHandler: string;
  staticDir: string;
}

export interface LoadedApp {
  id: string;
  label: string;
  path: string;
  staticDir: string;
  handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
}

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

/**
 * Discover and load all installed DKG apps.
 * Scans node_modules for packages with a `dkgApp` field in package.json.
 */
export async function loadApps(agent?: unknown, config?: unknown, log?: (msg: string) => void): Promise<LoadedApp[]> {
  const apps: LoadedApp[] = [];
  const require = createRequire(join(process.cwd(), 'package.json'));

  let rootPkg: { dependencies?: Record<string, string> };
  try {
    rootPkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf-8'));
  } catch {
    return apps;
  }

  const deps = { ...rootPkg.dependencies };

  for (const depName of Object.keys(deps)) {
    try {
      const pkgJsonPath = require.resolve(`${depName}/package.json`);
      const pkgJson = JSON.parse(await readFile(pkgJsonPath, 'utf-8'));
      const manifest: DkgAppManifest | undefined = pkgJson.dkgApp;
      if (!manifest?.id || !manifest.apiHandler || !manifest.staticDir) continue;

      const pkgDir = dirname(pkgJsonPath);
      const handlerPath = join(pkgDir, manifest.apiHandler);
      const staticDir = join(pkgDir, manifest.staticDir);

      const handlerModule = await import(handlerPath);
      const createHandler = handlerModule.default ?? handlerModule.createHandler;
      if (typeof createHandler !== 'function') {
        log?.(`App ${manifest.id}: handler does not export a default function, skipping`);
        continue;
      }

      const handler = createHandler(agent, config);
      if (typeof handler !== 'function') {
        log?.(`App ${manifest.id}: createHandler did not return a function, skipping`);
        continue;
      }

      apps.push({
        id: manifest.id,
        label: manifest.label,
        path: `/apps/${manifest.id}`,
        staticDir,
        handler,
      });

      log?.(`App loaded: ${manifest.label} (${manifest.id}) → /apps/${manifest.id}/`);
    } catch {
      // Not a DKG app or can't be loaded; skip silently
    }
  }

  return apps;
}

/**
 * Derive a client-facing origin URL from request headers.
 * Uses `x-forwarded-proto` for scheme (respects reverse proxies/TLS termination)
 * and the `Host` header for hostname, replacing the port.
 */
export function deriveOrigin(req: IncomingMessage, port: number): string {
  const rawProto = req.headers['x-forwarded-proto'];
  const protoHeader = Array.isArray(rawProto) ? rawProto[0] : rawProto;
  const proto = protoHeader?.split(',')[0]?.trim() || 'http';
  const reqHost = req.headers.host;
  const hostname = reqHost ? reqHost.replace(/:\d+$/, '') : '127.0.0.1';
  return `${proto}://${hostname}:${port}`;
}

/**
 * Handle incoming requests for installed apps.
 * - GET /api/apps → list of installed apps
 * - GET /apps/:id/* → serve static UI files
 * - /api/apps/:id/* → delegate to app's API handler
 *
 * Returns true if the request was handled.
 */
export async function handleAppRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  apps: LoadedApp[],
  authToken?: string,
  appStaticPort?: number,
): Promise<boolean> {
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/apps') {
    let staticBaseUrl: string | undefined;
    if (appStaticPort) {
      staticBaseUrl = deriveOrigin(req, appStaticPort);
    }
    const list = apps.map(a => ({
      id: a.id,
      label: a.label,
      path: a.path,
      ...(staticBaseUrl ? { staticUrl: `${staticBaseUrl}${a.path}/` } : {}),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(list));
    return true;
  }

  for (const app of apps) {
    if (await app.handler(req, res, url)) return true;
  }

  if (path.startsWith('/apps/')) {
    const segments = path.slice('/apps/'.length).split('/');
    const appId = segments[0];
    const app = apps.find(a => a.id === appId);
    if (!app) return false;

    return serveAppStatic(res, app.staticDir, path.slice(`/apps/${appId}`.length) || '/', authToken);
  }

  return false;
}

async function serveAppStatic(
  res: ServerResponse,
  staticDir: string,
  urlPath: string,
  authToken?: string,
  apiOrigin?: string,
): Promise<true> {
  const resolved = resolve(staticDir, (urlPath && urlPath !== '/') ? urlPath.replace(/^\//, '') : 'index.html');
  const rel = relative(staticDir, resolved);
  if (rel.startsWith('..') || resolve(staticDir, rel) !== resolved) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return true;
  }
  let filePath = resolved;

  const ext = filePath.slice(filePath.lastIndexOf('.'));
  if (!MIME[ext]) filePath = join(staticDir, 'index.html');
  if (!existsSync(filePath)) filePath = join(staticDir, 'index.html');

  const mimeExt = filePath.slice(filePath.lastIndexOf('.'));
  const isHtml = mimeExt === '.html';

  try {
    const needsInjection = isHtml && (authToken || apiOrigin);
    if (needsInjection) {
      const html = await readFile(filePath, 'utf-8');
      const parts: string[] = [];
      if (authToken) parts.push(`window.__DKG_TOKEN__=${JSON.stringify(authToken)}`);
      if (apiOrigin) parts.push(`window.__DKG_API_ORIGIN__=${JSON.stringify(apiOrigin)}`);
      const injection = `<script>${parts.join(';')}</script>`;
      const injected = html.replace('</head>', `${injection}</head>`);
      const buf = Buffer.from(injected, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': buf.byteLength, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      res.end(buf);
    } else {
      const s = await stat(filePath);
      const contentType = MIME[mimeExt] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': s.size, 'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' });
      createReadStream(filePath).pipe(res);
    }
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('App UI not found');
  }

  return true;
}

/**
 * Start a separate-origin HTTP server for app static files.
 * Running on a different port gives each app a different browser origin,
 * providing real isolation (no sandbox hacks needed) while allowing
 * localStorage, sessionStorage, and normal asset loading.
 */
export async function startAppStaticServer(
  apps: LoadedApp[],
  host: string,
  port: number,
  apiPortRef: { value: number },
  log?: (msg: string) => void,
): Promise<{ server: Server; port: number }> {
  const appServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      if (path.startsWith('/apps/')) {
        const segments = path.slice('/apps/'.length).split('/');
        const appId = segments[0];
        const app = apps.find(a => a.id === appId);
        if (app) {
          const apiOrigin = apiPortRef.value ? deriveOrigin(req, apiPortRef.value) : undefined;
          await serveAppStatic(res, app.staticDir, path.slice(`/apps/${appId}`.length) || '/', undefined, apiOrigin);
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request');
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    appServer.once('error', reject);
    appServer.listen(port, host, () => {
      appServer.removeListener('error', reject);
      resolve();
    });
  });
  const boundPort = (appServer.address() as any).port as number;
  log?.(`App static server listening on http://${host}:${boundPort}`);
  return { server: appServer, port: boundPort };
}
