import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backpressureRegistry,
  type BackpressureSource,
} from '@origintrail-official/dkg-core';
import { authenticateHttpRequest } from '../src/auth.js';
import { handleBackpressureRoutes } from '../src/daemon/routes/backpressure.js';

describe('backpressure diagnostics route', () => {
  let server: Server | undefined;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  async function request(options: {
    authEnabled?: boolean;
    requestToken?: string;
    tokenAgentAddress?: string;
  } = {}): Promise<{ status: number; body: any }> {
    const source: BackpressureSource = {
      backpressureId: `route-test-${Date.now()}-${Math.random()}`,
      getBackpressureSnapshot: () => ({
        scheduler: 'route-test',
        state: 'degraded',
        totals: {
          queued: 3,
          queueLimit: 4,
          inflight: 1,
          inflightLimit: 1,
          oldestQueuedAgeMs: 6_000,
          oldestActiveAgeMs: 1_000,
          rejectedTotal: 0,
        },
        lanes: [],
      }),
    };
    unregister = backpressureRegistry.register(source);
    const agent = {
      resolveAgentByToken: (token: string) =>
        token === options.requestToken ? options.tokenAgentAddress : undefined,
    };
    const authEnabled = options.authEnabled ?? true;
    const validTokens = new Set(options.requestToken ? [options.requestToken] : []);
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const authentication = await authenticateHttpRequest({
        req,
        res,
        authEnabled,
        validTokens,
        resolveAgentByToken: agent.resolveAgentByToken,
      });
      if (!authentication.allowed) return;
      await handleBackpressureRoutes({
        req,
        res,
        agent,
        config: { auth: { enabled: authEnabled } },
        validTokens,
        url,
        path: url.pathname,
        requestToken: authentication.requestToken,
        requestAuthorization: authentication.requestAuthorization,
        requestPrincipal: authentication.requestPrincipal,
      } as any);
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('route test server did not bind');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/diagnostics/backpressure`,
      options.requestToken
        ? { headers: { authorization: `Bearer ${options.requestToken}` } }
        : undefined,
    );
    return { status: response.status, body: await response.json() };
  }

  it('returns registered scheduler snapshots to a node admin', async () => {
    const result = await request({ requestToken: 'node-admin-token' });

    expect(result.status).toBe(200);
    expect(result.body.capturedAt).toEqual(expect.any(String));
    expect(result.body.state).toBe('degraded');
    expect(result.body.schedulers).toContainEqual(expect.objectContaining({
      scheduler: 'route-test',
      state: 'degraded',
      totals: expect.objectContaining({ queued: 3, queueLimit: 4 }),
    }));
  });

  it('rejects agent-scoped tokens', async () => {
    const result = await request({
      requestToken: 'agent-token',
      tokenAgentAddress: '0xagent',
    });

    expect(result.status).toBe(403);
    expect(result.body.error).toMatch(/node-level admin token/i);
  });

  it('allows tokenless diagnostics when daemon auth is disabled', async () => {
    const result = await request({ authEnabled: false });
    expect(result.status).toBe(200);
  });

  it('retains node-operator capability for a valid agent bearer when auth is disabled', async () => {
    const result = await request({
      authEnabled: false,
      requestToken: 'agent-token',
      tokenAgentAddress: '0xagent',
    });
    expect(result.status).toBe(200);
  });
});
