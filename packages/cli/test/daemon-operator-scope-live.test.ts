import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';

// End to end through a real daemon on the isolated mock chain: node-wide
// settings, node logs, agent registration and shutdown accept the node-operator
// token and refuse an agent-scoped one. This covers the daemon wiring that
// unit tests of the individual handlers cannot: the shared memory TTL route and
// the caller scope passed to the dashboard API handler.

let daemon: LiveDaemon;
let operatorToken: string;
let agentToken: string;

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${daemon.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* non-JSON body */ }
  return { status: res.status, body: parsed };
}

describe('node-admin scope on a live daemon (mock chain)', () => {
  beforeAll(async () => {
    daemon = await startLiveDaemon({ extraConfig: { chain: { type: 'mock' } } });
    operatorToken = daemon.token!;
    const registered = await call('POST', '/api/agent/register', operatorToken, { name: 'scope-agent', framework: 'test' });
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    agentToken = String(registered.body.authToken);
  });

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  });

  it('refuses node-wide changes and node log reads to an agent-scoped token', async () => {
    const ttlBefore = await call('GET', '/api/settings/shared-memory-ttl', agentToken);
    expect(ttlBefore.status).toBe(200);
    const refused = [
      await call('PUT', '/api/settings/shared-memory-ttl', agentToken, { ttlDays: 1 }),
      await call('PUT', '/api/settings/workspace-ttl', agentToken, { ttlDays: 1 }),
      await call('PUT', '/api/settings/retention', agentToken, { retentionDays: 30 }),
      await call('GET', '/api/node-log?lines=5', agentToken),
      await call('GET', '/api/logs', agentToken),
      await call('POST', '/api/agent/register', agentToken, { name: 'scope-agent-2', framework: 'test' }),
      await call('POST', '/api/shutdown', agentToken, {}),
    ];
    for (const res of refused) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(String(res.body.error)).toMatch(/requires a node-level admin token/);
    }

    // The TTL is unchanged and the node is still running.
    expect(await call('GET', '/api/settings/shared-memory-ttl', agentToken)).toEqual(ttlBefore);
    expect(daemon.exitCode ?? null).toBeNull();
    expect((await call('GET', '/api/status', agentToken)).status).toBe(200);
  });

  it('keeps serving the node-operator token', async () => {
    expect((await call('GET', '/api/node-log?lines=5', operatorToken)).status).toBe(200);
    expect((await call('GET', '/api/logs', operatorToken)).status).toBe(200);
    expect((await call('PUT', '/api/settings/shared-memory-ttl', operatorToken, { ttlDays: -1 })).status).toBe(400);
    expect(await call('PUT', '/api/settings/shared-memory-ttl', operatorToken, { ttlDays: 3 }))
      .toEqual({ status: 200, body: { ok: true, ttlMs: 3 * 24 * 60 * 60 * 1000, ttlDays: 3 } });
  });
});
