import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleAppRequest, startAppStaticServer, deriveOrigin, loadApps, type LoadedApp } from '../src/app-loader.js';

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

function makeApp(id: string, staticDir: string): LoadedApp {
  return {
    id,
    label: `Test ${id}`,
    path: `/apps/${id}`,
    staticDir,
    handler: async () => false,
  };
}

function httpGet(server: Server, path: string, headers?: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    import('node:http').then(({ get }) => {
      get(`http://127.0.0.1:${addr.port}${path}`, { headers }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      }).on('error', reject);
    });
  });
}

function fakeReqRes(host?: string): { req: IncomingMessage; res: ServerResponse & { _status: number; _body: string; _headers: Record<string, unknown> } } {
  const req = { method: 'GET', headers: { host: host || '127.0.0.1:19200' } } as unknown as IncomingMessage;
  const collected = { _status: 0, _body: '', _headers: {} as Record<string, unknown> };
  const res = {
    ...collected,
    writeHead(code: number, headers?: Record<string, unknown>) {
      collected._status = code;
      Object.assign(collected._headers, headers);
    },
    end(data?: string | Buffer) {
      collected._body = typeof data === 'string' ? data : data?.toString() ?? '';
    },
    setHeader() {},
  } as unknown as ServerResponse & typeof collected;
  Object.defineProperty(res, '_status', { get: () => collected._status });
  Object.defineProperty(res, '_body', { get: () => collected._body });
  Object.defineProperty(res, '_headers', { get: () => collected._headers });
  return { req, res };
}

describe('app-loader', () => {
  let staticDir: string;
  let server: Server;
  let apps: LoadedApp[];

  beforeEach(async () => {
    staticDir = join(tmpdir(), `app-loader-test-${Date.now()}`);
    await mkdir(staticDir, { recursive: true });
    await write(join(staticDir, 'index.html'), '<html><head></head><body>App UI</body></html>');
    await write(join(staticDir, 'assets', 'style.css'), 'body { color: red }');

    apps = [makeApp('test-app', staticDir)];

    server = createServer(async (req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const handled = await handleAppRequest(req, res, url, apps);
      if (!handled) {
        res.writeHead(404);
        res.end('not handled');
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(staticDir, { recursive: true, force: true });
  });

  it('serves index.html for app root', async () => {
    const res = await httpGet(server, '/apps/test-app/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('App UI');
  });

  it('serves legitimate nested assets', async () => {
    const res = await httpGet(server, '/apps/test-app/assets/style.css');
    expect(res.status).toBe(200);
    expect(res.body).toContain('color: red');
  });

  it('returns /api/apps listing', async () => {
    const res = await httpGet(server, '/api/apps');
    expect(res.status).toBe(200);
    const list = JSON.parse(res.body);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('test-app');
  });

  it('returns 404 for unknown app', async () => {
    const res = await httpGet(server, '/apps/nonexistent/');
    expect(res.status).toBe(404);
  });

  describe('path traversal prevention (defense-in-depth)', () => {
    it('URL normalization prevents ../  traversal at the HTTP layer', async () => {
      const res = await httpGet(server, '/apps/test-app/../../package.json');
      expect(res.status).toBe(404);
    });

    it('serveAppStatic rejects ../ if URL bypasses normalization', async () => {
      const { req, res } = fakeReqRes();
      const url = { pathname: '/apps/test-app/../../package.json' } as URL;

      await handleAppRequest(req, res, url, apps);
      expect(res._status).toBe(400);
      expect(res._body).toContain('Invalid path');
    });

    it('serveAppStatic rejects deeply nested traversal', async () => {
      const { req, res } = fakeReqRes();
      const url = { pathname: '/apps/test-app/assets/../../../etc/passwd' } as URL;

      await handleAppRequest(req, res, url, apps);
      expect(res._status).toBe(400);
      expect(res._body).toContain('Invalid path');
    });

    it('serveAppStatic serves index.html for unknown extensions (SPA fallback)', async () => {
      const { req, res } = fakeReqRes();
      const url = { pathname: '/apps/test-app/some/route' } as URL;

      await handleAppRequest(req, res, url, apps, 'test-token');
      expect(res._status).toBe(200);
      expect(res._body).toContain('App UI');
    });

    it('serveAppStatic does not inject token when authToken is undefined', async () => {
      const res = await httpGet(server, '/apps/test-app/');
      expect(res.status).toBe(200);
      expect(res.body).toContain('App UI');
      expect(res.body).not.toContain('__DKG_TOKEN__');
    });

    it('token-injected HTML omits Access-Control-Allow-Origin to prevent cross-origin exfiltration', async () => {
      const tokenServer = createServer(async (req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const handled = await handleAppRequest(req, res, url, apps, 'secret-token');
        if (!handled) { res.writeHead(404); res.end('not handled'); }
      });
      await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
      try {
        const port = (tokenServer.address() as any).port;
        const res = await httpGetPortFull(port, '/apps/test-app/');
        expect(res.status).toBe(200);
        expect(res.body).toContain('__DKG_TOKEN__');
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      } finally {
        await new Promise<void>(r => tokenServer.close(() => r()));
      }
    });

    it('non-token HTML still has Access-Control-Allow-Origin: *', async () => {
      const res = await httpGetPortFull((server.address() as any).port, '/apps/test-app/');
      expect(res.status).toBe(200);
      expect(res.body).not.toContain('__DKG_TOKEN__');
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });
  });

  describe('/api/apps staticUrl derived from request Host header', () => {
    it('includes staticUrl using request hostname when appStaticPort is provided', async () => {
      const { req, res } = fakeReqRes('mynode.example.com:19200');
      const url = { pathname: '/api/apps' } as URL;
      (req as any).method = 'GET';

      await handleAppRequest(req, res, url, apps, undefined, 19300);
      const list = JSON.parse(res._body);
      expect(list[0].staticUrl).toBe('http://mynode.example.com:19300/apps/test-app/');
    });

    it('strips port from Host header when deriving hostname', async () => {
      const { req, res } = fakeReqRes('192.168.1.50:19200');
      const url = { pathname: '/api/apps' } as URL;
      (req as any).method = 'GET';

      await handleAppRequest(req, res, url, apps, undefined, 19300);
      const list = JSON.parse(res._body);
      expect(list[0].staticUrl).toBe('http://192.168.1.50:19300/apps/test-app/');
    });

    it('uses https scheme when x-forwarded-proto is https', async () => {
      const { req, res } = fakeReqRes('mynode.example.com:19200');
      (req as any).headers['x-forwarded-proto'] = 'https';
      const url = { pathname: '/api/apps' } as URL;
      (req as any).method = 'GET';

      await handleAppRequest(req, res, url, apps, undefined, 19300);
      const list = JSON.parse(res._body);
      expect(list[0].staticUrl).toBe('https://mynode.example.com:19300/apps/test-app/');
    });

    it('falls back to 127.0.0.1 when Host header is missing', async () => {
      const { req, res } = fakeReqRes();
      (req as any).headers = {};
      const url = { pathname: '/api/apps' } as URL;
      (req as any).method = 'GET';

      await handleAppRequest(req, res, url, apps, undefined, 19300);
      const list = JSON.parse(res._body);
      expect(list[0].staticUrl).toBe('http://127.0.0.1:19300/apps/test-app/');
    });

    it('omits staticUrl when appStaticPort is not provided', async () => {
      const { req, res } = fakeReqRes();
      const url = { pathname: '/api/apps' } as URL;
      (req as any).method = 'GET';

      await handleAppRequest(req, res, url, apps);
      const list = JSON.parse(res._body);
      expect(list[0].staticUrl).toBeUndefined();
    });
  });
});

describe('startAppStaticServer', () => {
  let staticDir: string;
  let apps: LoadedApp[];
  let appServer: Server;

  beforeEach(async () => {
    staticDir = join(tmpdir(), `app-static-test-${Date.now()}`);
    await mkdir(staticDir, { recursive: true });
    await write(join(staticDir, 'index.html'), '<html><head></head><body>Separate Origin App</body></html>');
    await write(join(staticDir, 'assets', 'app.js'), 'console.log("hello")');
    apps = [makeApp('test-app', staticDir)];
  });

  afterEach(async () => {
    if (appServer) await new Promise<void>(r => appServer.close(() => r()));
    await rm(staticDir, { recursive: true, force: true });
  });

  it('starts on the specified port and serves app static files', async () => {
    const ref = { value: 19200 };
    const result = await startAppStaticServer(apps, '127.0.0.1', 0, ref);
    appServer = result.server;
    expect(result.port).toBeGreaterThan(0);

    const res = await httpGetPort(result.port, '/apps/test-app/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Separate Origin App');
  });

  it('serves nested assets', async () => {
    const ref = { value: 19200 };
    const result = await startAppStaticServer(apps, '127.0.0.1', 0, ref);
    appServer = result.server;

    const res = await httpGetPort(result.port, '/apps/test-app/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.body).toContain('console.log');
  });

  it('returns 404 for unknown app', async () => {
    const ref = { value: 19200 };
    const result = await startAppStaticServer(apps, '127.0.0.1', 0, ref);
    appServer = result.server;

    const res = await httpGetPort(result.port, '/apps/unknown/');
    expect(res.status).toBe(404);
  });

  it('does not serve API routes', async () => {
    const ref = { value: 19200 };
    const result = await startAppStaticServer(apps, '127.0.0.1', 0, ref);
    appServer = result.server;

    const res = await httpGetPort(result.port, '/api/apps');
    expect(res.status).toBe(404);
  });

  it('does NOT inject auth tokens into HTML (static-only server)', async () => {
    const ref = { value: 19200 };
    const result = await startAppStaticServer(apps, '127.0.0.1', 0, ref);
    appServer = result.server;

    const res = await httpGetPort(result.port, '/apps/test-app/');
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('__DKG_TOKEN__');
  });

  it('derives apiOrigin at request time from Host header and apiPort', async () => {
    const ref = { value: 19200 };
    const result = await startAppStaticServer(apps, '127.0.0.1', 0, ref);
    appServer = result.server;

    const res = await httpGetPort(result.port, '/apps/test-app/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('window.__DKG_API_ORIGIN__="http://127.0.0.1:19200"');
  });

  it('reads apiPortRef.value at request time (supports late binding)', async () => {
    const ref = { value: 0 };
    const result = await startAppStaticServer(apps, '127.0.0.1', 0, ref);
    appServer = result.server;

    ref.value = 55555;
    const res = await httpGetPort(result.port, '/apps/test-app/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('window.__DKG_API_ORIGIN__="http://127.0.0.1:55555"');
  });

  it('includes CORS headers on static responses', async () => {
    const ref = { value: 19200 };
    const result = await startAppStaticServer(apps, '127.0.0.1', 0, ref);
    appServer = result.server;

    const res = await httpGetPortFull(result.port, '/apps/test-app/');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('returns 400 for malformed requests instead of crashing', async () => {
    const ref = { value: 19200 };
    const result = await startAppStaticServer(apps, '127.0.0.1', 0, ref);
    appServer = result.server;

    const res = await httpGetPort(result.port, '/%00%00%00');
    expect([200, 400, 404]).toContain(res.status);
  });

  it('rejects with EADDRINUSE when port is already taken', async () => {
    const blocker = createServer();
    const blockerPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        resolve((blocker.address() as any).port);
      });
    });

    try {
      const ref = { value: 19200 };
      await expect(
        startAppStaticServer(apps, '127.0.0.1', blockerPort, ref),
      ).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise<void>(r => blocker.close(() => r()));
    }
  });
});

describe('deriveOrigin', () => {
  function fakeReq(host?: string, proto?: string | string[]): IncomingMessage {
    const headers: Record<string, string | string[]> = {};
    if (host) headers.host = host;
    if (proto) headers['x-forwarded-proto'] = proto;
    return { headers } as unknown as IncomingMessage;
  }

  it('derives http origin from Host header', () => {
    expect(deriveOrigin(fakeReq('mynode.local:19200'), 19300)).toBe('http://mynode.local:19300');
  });

  it('uses https when x-forwarded-proto is https', () => {
    expect(deriveOrigin(fakeReq('mynode.local:443', 'https'), 19300)).toBe('https://mynode.local:19300');
  });

  it('handles x-forwarded-proto with multiple values (uses first)', () => {
    expect(deriveOrigin(fakeReq('mynode.local:443', 'https, http'), 19300)).toBe('https://mynode.local:19300');
  });

  it('handles x-forwarded-proto as string[] (Node repeated headers)', () => {
    expect(deriveOrigin(fakeReq('mynode.local:443', ['https', 'http']), 19300)).toBe('https://mynode.local:19300');
  });

  it('falls back to 127.0.0.1 when Host header is missing', () => {
    expect(deriveOrigin(fakeReq(), 19300)).toBe('http://127.0.0.1:19300');
  });

  it('strips port from Host header', () => {
    expect(deriveOrigin(fakeReq('192.168.1.50:19200'), 19300)).toBe('http://192.168.1.50:19300');
  });

  it('handles Host header without port', () => {
    expect(deriveOrigin(fakeReq('mynode.local'), 19300)).toBe('http://mynode.local:19300');
  });

  it('rejects non-HTTP protocols and falls back to http', () => {
    expect(deriveOrigin(fakeReq('mynode.local:443', 'ftp'), 19300)).toBe('http://mynode.local:19300');
    expect(deriveOrigin(fakeReq('mynode.local:443', 'javascript'), 19300)).toBe('http://mynode.local:19300');
  });
});

describe('loadApps standalone fallback', () => {
  async function createFakeCliDir(deps: Record<string, string>, nodeModules?: Record<string, { pkgJson: object; handlerCode?: string }>) {
    const fakeCliDir = join(tmpdir(), `app-loader-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    await mkdir(fakeCliDir, { recursive: true });
    await writeFile(join(fakeCliDir, 'package.json'), JSON.stringify({ name: 'fake-cli', dependencies: deps }));
    if (nodeModules) {
      for (const [name, { pkgJson, handlerCode }] of Object.entries(nodeModules)) {
        const modDir = join(fakeCliDir, 'node_modules', ...name.split('/'));
        await mkdir(modDir, { recursive: true });
        await writeFile(join(modDir, 'package.json'), JSON.stringify(pkgJson));
        if (handlerCode) await writeFile(join(modDir, 'handler.js'), handlerCode);
      }
    }
    return fakeCliDir;
  }

  it('discovers dkgApp packages from CLI deps when repoDir() is null', async () => {
    const handlerCode = 'export default function createHandler() { return async () => false; }';
    const fakeCliDir = await createFakeCliDir(
      { 'fake-game': '*' },
      { 'fake-game': {
        pkgJson: { name: 'fake-game', type: 'module', dkgApp: { id: 'test-game', label: 'Test Game', apiHandler: './handler.js', staticDir: '.' } },
        handlerCode,
      }},
    );
    try {
      const messages: string[] = [];
      const apps = await loadApps(null, {}, (msg: string) => messages.push(msg), { cliPackageRoot: fakeCliDir });

      expect(apps).toHaveLength(1);
      expect(apps[0].id).toBe('test-game');
      expect(apps[0].label).toBe('Test Game');
      expect(apps[0].path).toBe('/apps/test-game');
      expect(messages.some(m => m.includes('test-game'))).toBe(true);
    } finally {
      await rm(fakeCliDir, { recursive: true, force: true });
    }
  });

  it('returns empty array when repoDir() is null and no dkgApp deps exist', async () => {
    const fakeCliDir = await createFakeCliDir({ commander: '^13' });
    try {
      const apps = await loadApps(null, {}, undefined, { cliPackageRoot: fakeCliDir });
      expect(apps).toEqual([]);
    } finally {
      await rm(fakeCliDir, { recursive: true, force: true });
    }
  });
});

function httpGetPort(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    import('node:http').then(({ get }) => {
      get(`http://127.0.0.1:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      }).on('error', reject);
    });
  });
}

function httpGetPortFull(port: number, path: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    import('node:http').then(({ get }) => {
      get(`http://127.0.0.1:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => resolve({
          status: res.statusCode!,
          body,
          headers: res.headers as Record<string, string>,
        }));
      }).on('error', reject);
    });
  });
}
