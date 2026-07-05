import { test, expect } from '@playwright/test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleNodeUIStaticRequest } from '../../src/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '../..');
const staticDir = resolve(packageRoot, 'dist-ui');

let server: Server | undefined;
let baseUrl: string;

test.beforeAll(async () => {
  if (!existsSync(resolve(staticDir, 'index.html'))) {
    throw new Error('packages/node-ui/dist-ui/index.html is missing; run pnpm build:ui before the production-static smoke');
  }
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (req.method === 'GET' && url.pathname === '/api/dashboard/session/status') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ authenticated: false }));
      return;
    }
    try {
      const handled = await handleNodeUIStaticRequest(res, url, staticDir);
      if (!handled && !res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err instanceof Error ? err.stack : String(err));
      } else {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (!server) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  server = undefined;
});

test('serves the production static app shell under CSP without legacy token bootstrap', async ({ page }) => {
  const browserFailures: string[] = [];
  const sameOriginFailures: string[] = [];
  const requestUrls: string[] = [];
  const consoleMessages: string[] = [];

  page.on('console', (message) => {
    const text = message.text();
    consoleMessages.push(`${message.type()}: ${text}`);
    if (message.type() === 'error' && /(Content Security Policy|Refused to load|violates)/i.test(text)) {
      browserFailures.push(text);
    }
  });
  page.on('pageerror', (err) => {
    browserFailures.push(err.message);
  });
  page.on('request', (request) => {
    requestUrls.push(request.url());
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (url.startsWith(`${baseUrl}/ui/`)) {
      sameOriginFailures.push(`${url} failed: ${request.failure()?.errorText ?? 'unknown error'}`);
    }
  });
  page.on('response', (response) => {
    const url = response.url();
    if (url.startsWith(`${baseUrl}/ui/`) && response.status() >= 400) {
      sameOriginFailures.push(`${url} returned ${response.status()}`);
    }
  });

  const main = await page.goto(`${baseUrl}/ui/`, { waitUntil: 'domcontentloaded' });
  expect(main?.status()).toBe(200);
  expect(main?.headers()['content-security-policy']).toContain("script-src 'self'");
  await page.waitForTimeout(500);

  expect({
    browserFailures,
    sameOriginFailures,
    url: page.url(),
    body: await page.locator('body').innerText().catch(() => ''),
    consoleMessages,
    requestUrls,
  }).toMatchObject({
    browserFailures: [],
    sameOriginFailures: [],
  });

  await expect(page.getByTestId('dashboard-session-unlock')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in to DKG Node Dashboard' })).toBeVisible();

  await expect(page.evaluate(() => (window as unknown as Record<string, unknown>).__DKG_TOKEN__)).resolves.toBeUndefined();
  expect(requestUrls.filter((url) => /token=/i.test(url))).toEqual([]);
  expect(sameOriginFailures).toEqual([]);
  expect(browserFailures).toEqual([]);
});
