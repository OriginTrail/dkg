import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';

// End to end through a real daemon on the isolated mock chain: node-wide
// settings, node logs, agent registration and shutdown accept the node-operator
// token and refuse an agent-scoped one, and the dashboard shell embeds the
// operator token only for a loopback caller with a loopback Host. This covers
// the daemon wiring that unit tests of the individual handlers cannot: the
// shared memory TTL route, the caller scope passed to the dashboard API
// handler, and the `nodeUiTokenForRequest` decision at the `/ui` call site.

// The shell the daemon serves from `packages/node-ui/dist-ui`. `build:packages`
// (CI's shared build) skips that bundle, so create a minimal shell when it is
// absent and remove only what this test created — otherwise `serveStatic` would
// return the "not built" page and the token could never appear.
const shellPath = fileURLToPath(new URL('../../node-ui/dist-ui/index.html', import.meta.url));
const shellDir = dirname(shellPath);
let createdShell = false;
let createdShellDir = false;

let daemon: LiveDaemon;
let operatorToken: string;
let agentToken: string;

// node:http, not fetch: undici may drop a custom Host header, and this test
// depends on the Host reaching the daemon exactly as set.
function getUi(port: number, host: string, extra: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/ui', headers: { host, ...extra } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

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
    if (!existsSync(shellPath)) {
      if (!existsSync(shellDir)) { mkdirSync(shellDir, { recursive: true }); createdShellDir = true; }
      writeFileSync(shellPath, '<html><head><title>DKG</title></head><body></body></html>');
      createdShell = true;
    }
    daemon = await startLiveDaemon({ extraConfig: { chain: { type: 'mock' } } });
    operatorToken = daemon.token!;
    const registered = await call('POST', '/api/agent/register', operatorToken, { name: 'scope-agent', framework: 'test' });
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    agentToken = String(registered.body.authToken);
  });

  afterAll(async () => {
    await stopLiveDaemon(daemon);
    if (createdShell) rmSync(shellPath, { force: true });
    if (createdShellDir) rmSync(shellDir, { recursive: true, force: true });
  });

  it('embeds the operator token in /ui only for a loopback caller with a loopback Host', async () => {
    const port = daemon.apiPort;
    const local = await getUi(port, `localhost:${port}`);
    expect(local.status).toBe(200);
    expect(local.body).toContain(`window.__DKG_TOKEN__=${JSON.stringify(operatorToken)}`);

    const foreignHost = await getUi(port, `evil.example:${port}`);
    expect(foreignHost.status).toBe(200);
    expect(foreignHost.body).not.toContain('__DKG_TOKEN__');
    expect(foreignHost.body).not.toContain(operatorToken);

    // A proxy that announces itself makes the request non-local.
    for (const forwarded of [{ 'X-Forwarded-For': '203.0.113.7' }, { 'X-Forwarded-Port': '443' }]) {
      const proxied = await getUi(port, `localhost:${port}`, forwarded);
      expect(proxied.status).toBe(200);
      expect(proxied.body).not.toContain('__DKG_TOKEN__');
    }
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
