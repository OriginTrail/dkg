import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  DashboardSessionStore,
  handleDashboardSessionRequest,
  verifyDashboardCsrf,
} from '../src/daemon/dashboard-session.js';
import { httpAuthGuard } from '../src/auth.js';

const VALID_TOKEN = 'dashboard-backed-token';

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return setCookie!.split(';')[0];
}

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const validTokens = new Set([VALID_TOKEN]);
  const sessions = new DashboardSessionStore();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (await handleDashboardSessionRequest(req, res, url, sessions, {
      authEnabled: true,
      validTokens,
      loopbackToken: VALID_TOKEN,
    })) {
      return;
    }
    if (!(await httpAuthGuard(req, res, true, validTokens, null, {
      dashboardSession: {
        authenticate: (request) => sessions.authenticate(request),
        verifyCsrf: (request, session) => verifyDashboardCsrf(request, session),
      },
    }))) {
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      authorization: req.headers.authorization ?? null,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('dashboard browser sessions', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('reports unauthenticated before bootstrap', async () => {
    const started = await startServer();
    server = started.server;

    const res = await fetch(`${started.baseUrl}/api/dashboard/session/status`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ authenticated: false });
  });

  it('sets an HttpOnly SameSite session cookie on loopback bootstrap', async () => {
    const started = await startServer();
    server = started.server;

    const res = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('dkg_ui_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie.toLowerCase()).not.toContain('domain=');
    await expect(res.json()).resolves.toMatchObject({ authenticated: true, source: 'loopback' });
  });

  it('authenticates protected GETs with the dashboard cookie and no Authorization header from the browser', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    const cookie = cookieFrom(bootstrap);

    const res = await fetch(`${started.baseUrl}/api/protected`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      authorization: `Bearer ${VALID_TOKEN}`,
    });
  });

  it('rejects unsafe session-authenticated requests without CSRF', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    const cookie = cookieFrom(bootstrap);

    const res = await fetch(`${started.baseUrl}/api/protected`, { method: 'POST', headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
  });

  it('allows unsafe session-authenticated requests with CSRF', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    const cookie = cookieFrom(bootstrap);
    const body = await bootstrap.json() as { csrfToken: string };

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-DKG-CSRF': body.csrfToken },
    });
    expect(res.status).toBe(200);
  });

  it('keeps invalid explicit Authorization from falling back to a valid cookie', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    const cookie = cookieFrom(bootstrap);

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      headers: { Cookie: cookie, Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('logout revokes the cookie-backed session', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    const cookie = cookieFrom(bootstrap);

    const logout = await fetch(`${started.baseUrl}/api/dashboard/session/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(logout.status).toBe(200);

    const res = await fetch(`${started.baseUrl}/api/protected`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
  });
});
