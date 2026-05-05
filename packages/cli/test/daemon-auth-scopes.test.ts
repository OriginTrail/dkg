/**
 * Slice 06 — auth scopes integration tests.
 *
 * The single most important test in this file is the backward-compat one:
 * a legacy scope-less token (the format every existing deployment carries
 * on disk) must continue to grant access to every kafka route. If that
 * test ever goes red, every existing daemon's API surface silently locks
 * up after a slice 06 upgrade — non-negotiable backward compat.
 *
 * The test uses a REAL on-disk token file (no mocks of token-store) so
 * the legacy file format is exercised end to end through the same parser
 * the daemon uses at startup.
 *
 * Mock surface: a stub `agent` with the same shape `handleKafkaRoutes`
 * consumes — `query`, `update`, `publish`, `resolveAgentAddress`. No real
 * chain or storage. The regression we are guarding is in the
 * route-handler scope-check + token-store wiring, not the V10 publisher.
 */
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleKafkaRoutes } from '../src/daemon/routes/kafka.js';
import { handleAuthRoutes } from '../src/daemon/routes/auth.js';
import {
  loadTokenStore,
  verifyTokenScope,
  type TokenStore,
} from '../src/auth.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

const VALID_OWNER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const VALID_URI =
  `urn:dkg:kafka-endpoint:${VALID_OWNER}:33b58f60595c766739f72b29e4ee417888d1a46af8339a4b5bdb1c3a5692f652`;

function buildMockReq(
  method: string,
  path: string,
  body?: unknown,
  authHeader?: string,
): Readable & { method: string; url: string; headers: Record<string, string | undefined> } {
  const stream = new Readable();
  if (body !== undefined) {
    stream.push(typeof body === 'string' ? body : JSON.stringify(body));
  }
  stream.push(null);
  Object.assign(stream, {
    method,
    url: path,
    headers: { authorization: authHeader },
  });
  return stream as Readable & {
    method: string;
    url: string;
    headers: Record<string, string | undefined>;
  };
}

interface CapturedResponse {
  status: number;
  body: unknown;
  headers: Record<string, string | string[] | number>;
}

function buildMockRes(): { res: any; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: undefined, headers: {} };
  const res: any = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number, headers?: Record<string, string | string[] | number>) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
      return res;
    },
    end(payload?: string) {
      res.writableEnded = true;
      if (payload !== undefined) {
        try {
          captured.body = JSON.parse(payload);
        } catch {
          captured.body = payload;
        }
      }
    },
  };
  return { res, captured };
}

function buildAgent(opts: {
  endpointBindings?: Array<Record<string, string>>;
  listBindings?: Array<Record<string, string>>;
} = {}): any {
  return {
    query: vi.fn(async (_sparql: string, _opts?: { contextGraphId?: string }) => {
      // Heuristic: list-shape vs single-shape. Tests only need "non-empty"
      // bindings to exercise route-success paths; precise SPARQL discrimination
      // is the kafka package's concern, exercised by package tests.
      if (opts.endpointBindings) return { bindings: opts.endpointBindings };
      if (opts.listBindings) return { bindings: opts.listBindings };
      return { bindings: [] };
    }),
    update: vi.fn(async () => ({})),
    publish: vi.fn(async () => ({})),
    resolveAgentAddress: vi.fn(() => VALID_OWNER),
  };
}

function buildCtx(
  req: any,
  res: any,
  agent: any,
  store: TokenStore,
  token: string | undefined,
  opts: { authEnabled?: boolean } = {},
): RequestContext {
  const url = new URL(`http://localhost${req.url}`);
  return {
    req,
    res,
    agent,
    path: url.pathname,
    url,
    requestAgentAddress: VALID_OWNER,
    requestToken: token,
    validTokens: new Set([...store.values()].map((r) => r.fullToken)),
    tokenStore: store,
    // Default `authEnabled: true` — Codex bug 1's fix short-circuits the
    // scope/root check when this is false; tests that exercise the gates
    // need it enabled. The auth-disabled bypass has its own dedicated
    // test below.
    authEnabled: opts.authEnabled ?? true,
  } as unknown as RequestContext;
}

// ───────────────────────────────────────────────────────────────────────────
// Backward compat — non-negotiable
// ───────────────────────────────────────────────────────────────────────────

describe('slice 06 — backward compat: legacy scope-less token', () => {
  let dkgHome: string;

  beforeEach(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-auth-bwc-'));
    process.env.DKG_HOME = dkgHome;
  });

  afterEach(async () => {
    delete process.env.DKG_HOME;
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('a legacy scope-less token file grants access to ALL kafka routes', async () => {
    // Write a real legacy-format token file (single line, no TAB).
    const legacyToken = 'legacy-no-scopes-token';
    await writeFile(
      join(dkgHome, 'auth.token'),
      `# DKG node API token — treat this like a password\n${legacyToken}\n`,
    );

    const store = await loadTokenStore();

    // The token MUST verify against every conceivable scope (full access).
    expect(verifyTokenScope(legacyToken, 'kafka:endpoint:read', store)).toBe(true);
    expect(verifyTokenScope(legacyToken, 'kafka:endpoint:write', store)).toBe(true);
    expect(verifyTokenScope(legacyToken, 'any-other-scope:we-dream-up', store)).toBe(true);

    // Hit each kafka route with the legacy token — every one must accept it
    // and reach the route body (i.e. no 401/403 from the scope guard).

    const agent = buildAgent({
      endpointBindings: [
        {
          endpoint: `<${VALID_URI}>`,
          broker: '"k.example:9092"',
          topic: '"orders"',
          messageFormat: '"application/json"',
          publisher: `<urn:dkg:agent:${VALID_OWNER}>`,
          endpointUrl: '<kafka://k.example:9092/orders>',
          issued: '"2026-05-04T12:34:56.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
        },
      ],
    });

    // GET list — kafka:endpoint:read
    {
      const req = buildMockReq(
        'GET',
        `/api/kafka/endpoint?contextGraphId=cg1`,
        undefined,
        `Bearer ${legacyToken}`,
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(buildCtx(req, res, agent, store, legacyToken));
      expect([200, 500]).toContain(captured.status); // 500 acceptable for stubbed query, NOT 401/403
      expect(captured.status).not.toBe(401);
      expect(captured.status).not.toBe(403);
    }

    // GET single — kafka:endpoint:read
    {
      const req = buildMockReq(
        'GET',
        `/api/kafka/endpoint/${encodeURIComponent(VALID_URI)}?contextGraphId=cg1`,
        undefined,
        `Bearer ${legacyToken}`,
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(buildCtx(req, res, agent, store, legacyToken));
      expect(captured.status).not.toBe(401);
      expect(captured.status).not.toBe(403);
    }

    // POST register — kafka:endpoint:write
    {
      const req = buildMockReq(
        'POST',
        `/api/kafka/endpoint`,
        {
          contextGraphId: 'cg1',
          broker: 'k.example:9092',
          topic: 'orders',
          messageFormat: 'application/json',
        },
        `Bearer ${legacyToken}`,
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(buildCtx(req, res, agent, store, legacyToken));
      expect(captured.status).not.toBe(401);
      expect(captured.status).not.toBe(403);
    }

    // POST verify — kafka:endpoint:write
    {
      const req = buildMockReq(
        'POST',
        `/api/kafka/endpoint/verify`,
        {
          contextGraphId: 'cg1',
          uri: VALID_URI,
          securityProtocol: 'PLAINTEXT',
        },
        `Bearer ${legacyToken}`,
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(buildCtx(req, res, agent, store, legacyToken));
      expect(captured.status).not.toBe(401);
      expect(captured.status).not.toBe(403);
    }

    // DELETE revoke — kafka:endpoint:write
    {
      const req = buildMockReq(
        'DELETE',
        `/api/kafka/endpoint/${encodeURIComponent(VALID_URI)}?contextGraphId=cg1`,
        undefined,
        `Bearer ${legacyToken}`,
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(buildCtx(req, res, agent, store, legacyToken));
      expect(captured.status).not.toBe(401);
      expect(captured.status).not.toBe(403);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Per-route scope enforcement
// ───────────────────────────────────────────────────────────────────────────

describe('slice 06 — per-route scope enforcement', () => {
  let dkgHome: string;

  beforeEach(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-auth-scope-'));
    process.env.DKG_HOME = dkgHome;
  });

  afterEach(async () => {
    delete process.env.DKG_HOME;
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('a read-scoped token is accepted on GET and rejected (403) on POST register', async () => {
    const readToken = 'read-only-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await writeFile(
      join(dkgHome, 'auth.token'),
      `${readToken}\tkafka:endpoint:read\n`,
    );
    const store = await loadTokenStore();

    expect(verifyTokenScope(readToken, 'kafka:endpoint:read', store)).toBe(true);
    expect(verifyTokenScope(readToken, 'kafka:endpoint:write', store)).toBe(false);

    const agent = buildAgent({
      listBindings: [], // empty list is fine for the contract test
    });

    // GET — must NOT 403
    {
      const req = buildMockReq(
        'GET',
        `/api/kafka/endpoint?contextGraphId=cg1`,
        undefined,
        `Bearer ${readToken}`,
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(buildCtx(req, res, agent, store, readToken));
      expect(captured.status).not.toBe(403);
    }

    // POST register — must 403
    {
      const req = buildMockReq(
        'POST',
        `/api/kafka/endpoint`,
        {
          contextGraphId: 'cg1',
          broker: 'k.example:9092',
          topic: 'orders',
          messageFormat: 'application/json',
        },
        `Bearer ${readToken}`,
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(buildCtx(req, res, agent, store, readToken));
      expect(captured.status).toBe(403);
      expect((captured.body as any)?.error).toContain('kafka:endpoint:write');
      // 403 must NOT carry a WWW-Authenticate header — that header signals
      // "no/invalid credentials"; this is "wrong scope".
      expect(
        Object.keys(captured.headers).map((k) => k.toLowerCase()),
      ).not.toContain('www-authenticate');
    }

    // POST verify — must 403
    {
      const req = buildMockReq(
        'POST',
        `/api/kafka/endpoint/verify`,
        { contextGraphId: 'cg1', uri: VALID_URI, securityProtocol: 'PLAINTEXT' },
        `Bearer ${readToken}`,
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(buildCtx(req, res, agent, store, readToken));
      expect(captured.status).toBe(403);
    }

    // DELETE revoke — must 403
    {
      const req = buildMockReq(
        'DELETE',
        `/api/kafka/endpoint/${encodeURIComponent(VALID_URI)}?contextGraphId=cg1`,
        undefined,
        `Bearer ${readToken}`,
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(buildCtx(req, res, agent, store, readToken));
      expect(captured.status).toBe(403);
    }
  });

  it('a write-scoped token is accepted on POST and rejected (403) on GET list', async () => {
    const writeToken = 'write-only-token-bbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await writeFile(
      join(dkgHome, 'auth.token'),
      `${writeToken}\tkafka:endpoint:write\n`,
    );
    const store = await loadTokenStore();

    expect(verifyTokenScope(writeToken, 'kafka:endpoint:write', store)).toBe(true);
    expect(verifyTokenScope(writeToken, 'kafka:endpoint:read', store)).toBe(false);

    const agent = buildAgent();

    // GET list — must 403
    {
      const req = buildMockReq(
        'GET',
        `/api/kafka/endpoint?contextGraphId=cg1`,
        undefined,
        `Bearer ${writeToken}`,
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(buildCtx(req, res, agent, store, writeToken));
      expect(captured.status).toBe(403);
      expect((captured.body as any)?.error).toContain('kafka:endpoint:read');
    }

    // GET single — must 403
    {
      const req = buildMockReq(
        'GET',
        `/api/kafka/endpoint/${encodeURIComponent(VALID_URI)}?contextGraphId=cg1`,
        undefined,
        `Bearer ${writeToken}`,
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(buildCtx(req, res, agent, store, writeToken));
      expect(captured.status).toBe(403);
    }

    // POST register — must NOT 403
    {
      const req = buildMockReq(
        'POST',
        `/api/kafka/endpoint`,
        {
          contextGraphId: 'cg1',
          broker: 'k.example:9092',
          topic: 'orders',
          messageFormat: 'application/json',
        },
        `Bearer ${writeToken}`,
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(buildCtx(req, res, agent, store, writeToken));
      expect(captured.status).not.toBe(403);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Codex bug 1 — auth-disabled bypasses scope gates
// ───────────────────────────────────────────────────────────────────────────

describe('slice 06 — Codex bug 1: auth.enabled=false bypasses scope gates', () => {
  let dkgHome: string;

  beforeEach(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-auth-disabled-'));
    process.env.DKG_HOME = dkgHome;
    // Pre-populate so the loader doesn't auto-generate. Even with auth
    // disabled, the store will exist; the gate just doesn't consult it.
    await writeFile(join(dkgHome, 'auth.token'), `auth-disabled-root-tk\n`);
  });

  afterEach(async () => {
    delete process.env.DKG_HOME;
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('with auth.enabled=false, every kafka route accepts requests with NO bearer token (200/non-403)', async () => {
    const store = await loadTokenStore();
    const agent = buildAgent();

    // POST register — no Authorization header at all. Pre-Codex-bug-1
    // fix this would 403 because verifyTokenScope(undefined, ...) fails.
    {
      const req = buildMockReq(
        'POST',
        `/api/kafka/endpoint`,
        {
          contextGraphId: 'cg1',
          broker: 'k.example:9092',
          topic: 'orders',
          messageFormat: 'application/json',
        },
        undefined, // NO bearer header
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(
        buildCtx(req, res, agent, store, undefined, { authEnabled: false }),
      );
      expect(captured.status).not.toBe(401);
      expect(captured.status).not.toBe(403);
    }

    // GET list — same, no token.
    {
      const req = buildMockReq(
        'GET',
        `/api/kafka/endpoint?contextGraphId=cg1`,
        undefined,
        undefined,
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(
        buildCtx(req, res, agent, store, undefined, { authEnabled: false }),
      );
      expect(captured.status).not.toBe(401);
      expect(captured.status).not.toBe(403);
    }

    // DELETE revoke — same.
    {
      const req = buildMockReq(
        'DELETE',
        `/api/kafka/endpoint/${encodeURIComponent(VALID_URI)}?contextGraphId=cg1`,
        undefined,
        undefined,
      );
      const { res, captured } = buildMockRes();
      await handleKafkaRoutes(
        buildCtx(req, res, agent, store, undefined, { authEnabled: false }),
      );
      expect(captured.status).not.toBe(401);
      expect(captured.status).not.toBe(403);
    }
  });

  it('with auth.enabled=false, mint/list/revoke /api/auth/tokens accept requests with NO bearer token', async () => {
    const store = await loadTokenStore();
    const validTokens = new Set([...store.values()].map((r) => r.fullToken));

    // POST mint — no Authorization header.
    {
      const req = buildMockReq(
        'POST',
        `/api/auth/tokens`,
        { scope: 'kafka:endpoint:read' },
        undefined,
      );
      const { res, captured } = buildMockRes();
      await handleAuthRoutes({
        req,
        res,
        path: '/api/auth/tokens',
        url: new URL('http://localhost/api/auth/tokens'),
        requestToken: undefined,
        tokenStore: store,
        validTokens,
        authEnabled: false,
      } as unknown as RequestContext);
      // 201 (mint succeeded) — NOT 403 (pre-Codex-bug-1 fix would have 403'd
      // because lookupTokenRecord(undefined) returns undefined and
      // requireRoot rejected).
      expect(captured.status).toBe(201);
    }

    // GET list — no header.
    {
      const req = buildMockReq(
        'GET',
        `/api/auth/tokens`,
        undefined,
        undefined,
      );
      const { res, captured } = buildMockRes();
      await handleAuthRoutes({
        req,
        res,
        path: '/api/auth/tokens',
        url: new URL('http://localhost/api/auth/tokens'),
        requestToken: undefined,
        tokenStore: store,
        validTokens,
        authEnabled: false,
      } as unknown as RequestContext);
      expect(captured.status).toBe(200);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Codex bug 3 — runtime agent token works on scope-gated routes
// ───────────────────────────────────────────────────────────────────────────

describe('slice 06 — Codex bug 3: runtime token added to BOTH structures works on scope-gated routes', () => {
  let dkgHome: string;

  beforeEach(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-runtime-add-'));
    process.env.DKG_HOME = dkgHome;
    await writeFile(join(dkgHome, 'auth.token'), `bug3-root-token-aaaaaaaaa\n`);
  });

  afterEach(async () => {
    delete process.env.DKG_HOME;
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('addTokenToStore-issued runtime token passes the kafka scope gate immediately (no restart)', async () => {
    const { addTokenToStore } = await import('../src/auth.js');
    const store = await loadTokenStore();
    const validTokens = new Set([...store.values()].map((r) => r.fullToken));
    const agent = buildAgent();

    // Simulate /api/agent/register issuing a fresh runtime token. The
    // helper must mutate BOTH structures so the daemon's scope gates
    // accept it on the very next request.
    const NEW_AGENT_TOKEN = 'runtime-agent-token-bbbbbbbbbbbbbbbbb';
    addTokenToStore(store, validTokens, {
      prefix: NEW_AGENT_TOKEN.slice(0, 8),
      fullToken: NEW_AGENT_TOKEN,
      scopes: '*', // agent tokens carry full access on non-admin routes
      source: 'agent',
    });

    // GET list with the brand-new token — pre-Codex-bug-3 fix this
    // would 403 (Set had it, store didn't, scope gate consults store).
    const req = buildMockReq(
      'GET',
      `/api/kafka/endpoint?contextGraphId=cg1`,
      undefined,
      `Bearer ${NEW_AGENT_TOKEN}`,
    );
    const { res, captured } = buildMockRes();
    await handleKafkaRoutes(buildCtx(req, res, agent, store, NEW_AGENT_TOKEN));
    expect(captured.status).not.toBe(401);
    expect(captured.status).not.toBe(403);
    // Both structures stayed in sync.
    expect(validTokens.has(NEW_AGENT_TOKEN)).toBe(true);
    expect(store.has(NEW_AGENT_TOKEN.slice(0, 8))).toBe(true);
  });
});
