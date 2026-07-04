import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  verifyToken,
  extractBearerToken,
  httpAuthGuard,
  getRequestAuthContext,
  loadTokens,
  resolveRequestAuthDecision,
} from '../src/auth.js';

// ---------------------------------------------------------------------------
// Unit tests for pure functions
// ---------------------------------------------------------------------------

describe('extractBearerToken', () => {
  it('extracts token from "Bearer <token>"', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('handles lowercase "bearer"', () => {
    expect(extractBearerToken('bearer xyz')).toBe('xyz');
  });

  it('returns raw value when no Bearer prefix', () => {
    expect(extractBearerToken('raw-token-value')).toBe('raw-token-value');
  });

  it('returns undefined for undefined input', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractBearerToken('')).toBeUndefined();
  });

  it('trims whitespace', () => {
    expect(extractBearerToken('  Bearer  tok  ')).toBe('tok');
  });
});

describe('verifyToken', () => {
  const tokens = new Set(['valid-token-1', 'valid-token-2']);

  it('returns true for valid token', () => {
    expect(verifyToken('valid-token-1', tokens)).toBe(true);
    expect(verifyToken('valid-token-2', tokens)).toBe(true);
  });

  it('returns false for invalid token', () => {
    expect(verifyToken('bad-token', tokens)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(verifyToken(undefined, tokens)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(verifyToken('', tokens)).toBe(false);
  });
});

describe('resolveRequestAuthDecision', () => {
  const VALID_TOKEN = 'decision-token';
  const validTokens = new Set([VALID_TOKEN]);
  const principal = { kind: 'agent' as const, agentAddress: 'did:dkg:agent:decision' };

  function request(
    url: string,
    options: { method?: string; headers?: IncomingMessage['headers'] } = {},
  ): IncomingMessage {
    return {
      url,
      method: options.method ?? 'GET',
      headers: {
        host: '127.0.0.1:8900',
        ...(options.headers ?? {}),
      },
    } as IncomingMessage;
  }

  it('returns an authorization-header context for a valid bearer credential', () => {
    const decision = resolveRequestAuthDecision(
      request('/api/agents', { headers: { authorization: `Bearer ${VALID_TOKEN}` } }),
      validTokens,
      { resolvePrincipal: () => principal },
    );

    expect(decision).toMatchObject({
      ok: true,
      credentialToken: VALID_TOKEN,
      context: {
        source: 'authorization-header',
        token: VALID_TOKEN,
        principal,
        csrf: { required: false, validated: false },
      },
    });
  });

  it('accepts a valid bearer credential without inventing an unresolved principal context', () => {
    const decision = resolveRequestAuthDecision(
      request('/api/agents', { headers: { authorization: `Bearer ${VALID_TOKEN}` } }),
      validTokens,
    );

    expect(decision).toMatchObject({
      ok: true,
      credentialToken: VALID_TOKEN,
    });
    expect(decision?.ok === true ? decision.context : undefined).toBeUndefined();
  });

  it('returns an events-query context with a resolved principal for a valid SSE credential', () => {
    const decision = resolveRequestAuthDecision(
      request(`/api/events?token=${VALID_TOKEN}`),
      validTokens,
      { resolvePrincipal: () => principal },
    );

    expect(decision).toMatchObject({
      ok: true,
      credentialToken: VALID_TOKEN,
      context: {
        source: 'events-query',
        token: VALID_TOKEN,
        principal,
        csrf: { required: false, validated: false },
      },
    });
  });

  it('does not fall back to dashboard-cookie auth after an invalid explicit bearer attempt', () => {
    const authSource = {
      resolve: vi.fn(() => ({
        ok: true as const,
        credentialToken: VALID_TOKEN,
        context: {
          source: 'dashboard-session' as const,
          internalCredentialToken: VALID_TOKEN,
          principal: { kind: 'node-admin' as const, agentAddress: 'did:dkg:agent:default' },
          csrf: { required: false, validated: false },
        },
      })),
    };

    const decision = resolveRequestAuthDecision(
      request('/api/agents', {
        headers: {
          authorization: 'Bearer wrong-token',
          cookie: 'dkg_ui_session=present',
        },
      }),
      validTokens,
      {
        authSources: [authSource],
      },
    );

    expect(decision).toBeNull();
    expect(authSource.resolve).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// loadTokens
// ---------------------------------------------------------------------------

describe('loadTokens', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `dkg-auth-test-${randomBytes(4).toString('hex')}`);
    await mkdir(tempDir, { recursive: true });
    process.env.DKG_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.DKG_HOME;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('auto-generates a token file when none exists', async () => {
    const tokens = await loadTokens();
    expect(tokens.size).toBe(1);
    const [token] = [...tokens];
    expect(token.length).toBeGreaterThan(20);
  });

  it('loads tokens from existing file', async () => {
    await writeFile(join(tempDir, 'auth.token'), '# comment\nmy-custom-token\n');
    const tokens = await loadTokens();
    expect(tokens.has('my-custom-token')).toBe(true);
  });

  it('skips comment lines and empty lines', async () => {
    await writeFile(join(tempDir, 'auth.token'), '# header\n\ntoken-a\n\n# another comment\ntoken-b\n');
    const tokens = await loadTokens();
    expect(tokens.has('token-a')).toBe(true);
    expect(tokens.has('token-b')).toBe(true);
    expect(tokens.has('# header')).toBe(false);
    expect(tokens.size).toBe(2);
  });

  it('merges config tokens with file tokens', async () => {
    await writeFile(join(tempDir, 'auth.token'), 'file-token\n');
    const tokens = await loadTokens({ tokens: ['config-token'] });
    expect(tokens.has('file-token')).toBe(true);
    expect(tokens.has('config-token')).toBe(true);
    expect(tokens.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// httpAuthGuard (integration test with real HTTP server)
// ---------------------------------------------------------------------------

describe('httpAuthGuard', () => {
  const VALID_TOKEN = 'test-secret-token';
  const validTokens = new Set([VALID_TOKEN]);
  const principal = { kind: 'agent' as const, agentAddress: 'did:dkg:agent:http-guard' };
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (!(await httpAuthGuard(req, res, true, validTokens, null, {
        resolvePrincipal: () => principal,
      }))) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, requestAuth: getRequestAuthContext(req) ?? null }));
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('allows /api/status without token (public)', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('allows OPTIONS without token (CORS preflight)', async () => {
    const res = await fetch(`${baseUrl}/api/knowledge-assets`, { method: 'OPTIONS' });
    expect(res.status).toBe(200);
  });

  it('allows /ui paths without token (static UI)', async () => {
    const res = await fetch(`${baseUrl}/ui/index.html`);
    expect(res.status).toBe(200);
  });

  it('allows /ui exact without token (static UI root)', async () => {
    const res = await fetch(`${baseUrl}/ui`);
    expect(res.status).toBe(200);
  });

  it('rejects /ui-custom — sibling paths must not bypass auth via the /ui prefix', async () => {
    // `/ui` prefix without trailing slash matched `/ui-custom`, `/ui_admin`, ... — route plugins at sibling paths bypassed auth.
    const res = await fetch(`${baseUrl}/ui-custom/anything`, { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('rejects /ui_admin — auth must not be bypassed by a non-/ui-prefix path', async () => {
    const res = await fetch(`${baseUrl}/ui_admin`, { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('rejects /uistuff — auth must not be bypassed by a concatenated /ui path', async () => {
    const res = await fetch(`${baseUrl}/uistuff`, { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('rejects POST /api/status — public allowlist must be method-aware (GET only)', async () => {
    // Public allowlist is read-only — non-GET on these paths must still go through auth, else plugins bypass via POST/PUT/DELETE.
    const res = await fetch(`${baseUrl}/api/status`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects PUT /.well-known/skill.md — non-GET on public path requires auth', async () => {
    const res = await fetch(`${baseUrl}/.well-known/skill.md`, { method: 'PUT', body: '' });
    expect(res.status).toBe(401);
  });

  it('rejects DELETE /api/chain/rpc-health — non-GET on public path requires auth', async () => {
    const res = await fetch(`${baseUrl}/api/chain/rpc-health`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('rejects POST /ui — non-GET on public exact path requires auth', async () => {
    const res = await fetch(`${baseUrl}/ui`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects POST /ui/index.html — non-GET on public prefix path requires auth', async () => {
    const res = await fetch(`${baseUrl}/ui/index.html`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('allows HEAD /api/status without auth — built-in claims HEAD so liveness probes succeed', async () => {
    // status.ts now claims HEAD on the three public-allowlisted paths, so HEAD never reaches plugins;
    // the public-HEAD allowlist exists for this case (k8s/load-balancer health probes).
    const res = await fetch(`${baseUrl}/api/status`, { method: 'HEAD' });
    expect(res.status).toBe(200);
  });

  it('allows HEAD /.well-known/skill.md without auth — same liveness contract', async () => {
    const res = await fetch(`${baseUrl}/.well-known/skill.md`, { method: 'HEAD' });
    expect(res.status).toBe(200);
  });

  it('rejects HEAD /ui — HEAD allowlist excludes paths without a built-in HEAD handler', async () => {
    // `/ui` is GET-public but has no built-in HEAD claim, so HEAD on /ui must go through auth to
    // prevent a fork plugin matching `HEAD /ui` from running unauthenticated (round-7 vulnerability).
    const res = await fetch(`${baseUrl}/ui`, { method: 'HEAD' });
    expect(res.status).toBe(401);
  });

  it('rejects HEAD /ui/something — HEAD allowlist excludes the /ui/* prefix', async () => {
    const res = await fetch(`${baseUrl}/ui/something`, { method: 'HEAD' });
    expect(res.status).toBe(401);
  });

  it('rejects protected endpoint without token', async () => {
    const res = await fetch(`${baseUrl}/api/knowledge-assets`, { method: 'POST' });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Unauthorized');
  });

  it('rejects Hermes provider persistence without token', async () => {
    const res = await fetch(`${baseUrl}/api/hermes-channel/persist-turn`, { method: 'POST' });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Unauthorized');
  });

  it('rejects protected endpoint with invalid token', async () => {
    const res = await fetch(`${baseUrl}/api/agents`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('allows protected endpoint with valid Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/agents`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.requestAuth).toMatchObject({
      source: 'authorization-header',
      token: VALID_TOKEN,
      principal,
      csrf: { required: false, validated: false },
    });
  });

  it('resolves the same principal shape for valid SSE query-token auth', async () => {
    const res = await fetch(`${baseUrl}/api/events?token=${encodeURIComponent(VALID_TOKEN)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestAuth).toMatchObject({
      source: 'events-query',
      token: VALID_TOKEN,
      principal,
      csrf: { required: false, validated: false },
    });
  });

  it('allows protected endpoint with raw token (no Bearer prefix)', async () => {
    const res = await fetch(`${baseUrl}/api/knowledge-assets`, {
      method: 'POST',
      headers: { Authorization: VALID_TOKEN },
    });
    expect(res.status).toBe(200);
  });

  it('includes WWW-Authenticate header in 401 response', async () => {
    const res = await fetch(`${baseUrl}/api/query`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="dkg-node"');
  });
});

describe('httpAuthGuard (auth disabled)', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (!(await httpAuthGuard(req, res, false, new Set()))) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('allows all requests when auth is disabled', async () => {
    const res = await fetch(`${baseUrl}/api/knowledge-assets`, { method: 'POST' });
    expect(res.status).toBe(200);
  });
});
