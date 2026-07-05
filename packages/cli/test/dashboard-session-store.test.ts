import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IncomingMessage, Server } from 'node:http';
import {
  DASHBOARD_SESSION_COOKIE,
  DashboardLoginAttemptLimiter,
  DashboardSessionStore,
  type DashboardLoginVerification,
} from '../src/daemon/dashboard-session.js';
import { getDashboardSessionCookie, setDashboardSessionCookie } from '../src/daemon/dashboard-session-cookie.js';
import {
  AGENT_TOKEN,
  DEFAULT_AGENT_ADDRESS,
  ROTATED_TOKEN,
  TOKEN_AGENT_ADDRESS,
  VALID_TOKEN,
  cookieFrom,
  loopbackBootstrapInit,
  rawRequest,
  startDashboardSessionServer as startServer,
} from './dashboard-session-test-harness.js';

describe('dashboard session store invariants', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('requires login sessions to carry a credential fingerprint', () => {
    const store = new DashboardSessionStore();
    const issuedAt = 1_000;
    if (false) {
      // @ts-expect-error Login sessions must be created with a fingerprint.
      store.create(VALID_TOKEN, 'login', issuedAt);
    }

    const created = store.createLoginSession(VALID_TOKEN, 'credential-a', issuedAt);
    const authenticated = store.authenticateSessionId(created.sessionId, issuedAt + 1);

    expect(created.record).toMatchObject({ source: 'login', credentialFingerprint: 'credential-a' });
    expect(authenticated).toMatchObject({ source: 'login', credentialFingerprint: 'credential-a' });
  });

  it('rejects and prunes expired dashboard session cookies', () => {
    const store = new DashboardSessionStore();
    const issuedAt = 1_000;
    const created = store.create(VALID_TOKEN, 'loopback', issuedAt);
    const req = {
      headers: {
        cookie: `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(created.sessionId)}`,
      },
    } as IncomingMessage;

    expect(store.authenticateSessionId(getDashboardSessionCookie(req), created.record.expiresAt - 1)).toMatchObject({
      sessionId: created.sessionId,
      compatToken: VALID_TOKEN,
    });
    expect(store.authenticateSessionId(getDashboardSessionCookie(req), created.record.expiresAt + 1)).toBeNull();
    expect(store.authenticateSessionId(getDashboardSessionCookie(req), created.record.expiresAt + 2)).toBeNull();
  });

});
