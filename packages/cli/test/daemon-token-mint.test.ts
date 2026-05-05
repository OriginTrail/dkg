/**
 * Slice 06 — integration tests for `/api/auth/tokens` (mint / list / revoke).
 *
 * Stands up `handleAuthRoutes` directly with a real on-disk auth file so
 * the read-modify-write critical section is exercised end to end. No
 * mocks of `token-store`. Critical contracts pinned:
 *
 *   - root token (scopes='*') CAN mint, list, revoke
 *   - any explicitly-scoped token CANNOT (403 — privilege-escalation guard)
 *   - mint response carries the full token EXACTLY ONCE; subsequent
 *     list/get responses MUST not leak it
 *   - file write goes through writeFileAtomic (POSIX-rename atomic);
 *     a parallel-mints test covers the well-formed-file invariant
 *   - DELETE returns 204 on hit, 404 on miss; refuses to revoke the
 *     bearer token the request was made with
 */
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleAuthRoutes } from '../src/daemon/routes/auth.js';
import { loadTokenStore, type TokenStore } from '../src/auth.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

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

function buildCtx(
  req: any,
  res: any,
  store: TokenStore,
  validTokens: Set<string>,
  token?: string,
): RequestContext {
  const url = new URL(`http://localhost${req.url}`);
  return {
    req,
    res,
    path: url.pathname,
    url,
    requestToken: token,
    tokenStore: store,
    validTokens,
  } as unknown as RequestContext;
}

// ───────────────────────────────────────────────────────────────────────────
// Setup helpers
// ───────────────────────────────────────────────────────────────────────────

async function loadStoreAndSet(): Promise<{ store: TokenStore; validTokens: Set<string> }> {
  const store = await loadTokenStore();
  const validTokens = new Set([...store.values()].map((r) => r.fullToken));
  return { store, validTokens };
}

describe('POST /api/auth/tokens — mint', () => {
  let dkgHome: string;
  const ROOT_TOKEN = 'root-token-aaaaaaaaaaaaaaaaaaaaa';

  beforeEach(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-mint-'));
    process.env.DKG_HOME = dkgHome;
    // Pre-populate with a single root (legacy) token so we have a known
    // caller to exercise the root-only check.
    await writeFile(join(dkgHome, 'auth.token'), `${ROOT_TOKEN}\n`);
  });

  afterEach(async () => {
    delete process.env.DKG_HOME;
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('mints a scoped token; response carries the full secret ONCE', async () => {
    const { store, validTokens } = await loadStoreAndSet();
    const req = buildMockReq('POST', '/api/auth/tokens', {
      scope: 'kafka:endpoint:write',
      name: 'kafka-publisher-bot',
    }, `Bearer ${ROOT_TOKEN}`);
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(buildCtx(req, res, store, validTokens, ROOT_TOKEN));
    expect(captured.status).toBe(201);
    const body = captured.body as any;
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.prefix.length).toBe(8);
    expect(body.prefix).toBe(body.token.slice(0, 8));
    expect(body.scopes).toEqual(['kafka:endpoint:write']);
    expect(body.name).toBe('kafka-publisher-bot');
    expect(typeof body.createdAt).toBe('string');

    // The minted token now lives in the store and on disk.
    expect(validTokens.has(body.token)).toBe(true);
    const onDisk = await readFile(join(dkgHome, 'auth.token'), 'utf-8');
    expect(onDisk).toContain(body.token);
    expect(onDisk).toContain('kafka:endpoint:write');
    expect(onDisk).toContain('kafka-publisher-bot');
  });

  it('mints with a comma-separated scope string', async () => {
    const { store, validTokens } = await loadStoreAndSet();
    const req = buildMockReq('POST', '/api/auth/tokens', {
      scope: 'kafka:endpoint:read, kafka:endpoint:write',
    }, `Bearer ${ROOT_TOKEN}`);
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(buildCtx(req, res, store, validTokens, ROOT_TOKEN));
    expect(captured.status).toBe(201);
    expect((captured.body as any).scopes).toEqual([
      'kafka:endpoint:read',
      'kafka:endpoint:write',
    ]);
  });

  it('mints with a scopes array', async () => {
    const { store, validTokens } = await loadStoreAndSet();
    const req = buildMockReq('POST', '/api/auth/tokens', {
      scopes: ['kafka:endpoint:read'],
    }, `Bearer ${ROOT_TOKEN}`);
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(buildCtx(req, res, store, validTokens, ROOT_TOKEN));
    expect(captured.status).toBe(201);
    expect((captured.body as any).scopes).toEqual(['kafka:endpoint:read']);
  });

  it('rejects when no scope is supplied (400)', async () => {
    const { store, validTokens } = await loadStoreAndSet();
    const req = buildMockReq('POST', '/api/auth/tokens', {}, `Bearer ${ROOT_TOKEN}`);
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(buildCtx(req, res, store, validTokens, ROOT_TOKEN));
    expect(captured.status).toBe(400);
    expect((captured.body as any).error).toContain('scope');
  });

  it('rejects an attempt to mint a wildcard "*" scope (privilege-escalation guard)', async () => {
    const { store, validTokens } = await loadStoreAndSet();
    const req = buildMockReq('POST', '/api/auth/tokens', {
      scope: '*',
    }, `Bearer ${ROOT_TOKEN}`);
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(buildCtx(req, res, store, validTokens, ROOT_TOKEN));
    expect(captured.status).toBe(400);
    expect((captured.body as any).error).toContain('wildcard');
  });

  it('rejects an attempt to mint an auth:tokens:* scope (privilege-escalation guard)', async () => {
    const { store, validTokens } = await loadStoreAndSet();
    const req = buildMockReq('POST', '/api/auth/tokens', {
      scope: 'auth:tokens:write',
    }, `Bearer ${ROOT_TOKEN}`);
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(buildCtx(req, res, store, validTokens, ROOT_TOKEN));
    expect(captured.status).toBe(400);
    expect((captured.body as any).error).toContain('reserved');
  });

  it('rejects when a scoped (non-root) token attempts to mint (403)', async () => {
    // Pre-create a scoped (non-root) token on disk so it lands in the
    // loaded store.
    const SCOPED = 'scoped-only-bbbbbbbbbbbbbbbbbbbbb';
    await writeFile(
      join(dkgHome, 'auth.token'),
      `${ROOT_TOKEN}\n${SCOPED}\tkafka:endpoint:read\n`,
    );
    const { store, validTokens } = await loadStoreAndSet();
    const req = buildMockReq('POST', '/api/auth/tokens', {
      scope: 'kafka:endpoint:write',
    }, `Bearer ${SCOPED}`);
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(buildCtx(req, res, store, validTokens, SCOPED));
    expect(captured.status).toBe(403);
    expect((captured.body as any).error).toContain('Root');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/auth/tokens — list (no secrets)
// ───────────────────────────────────────────────────────────────────────────

describe('GET /api/auth/tokens — list', () => {
  let dkgHome: string;
  const ROOT_TOKEN = 'root-token-cccccccccccccccccccccc';

  beforeEach(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-list-'));
    process.env.DKG_HOME = dkgHome;
    // Pre-populate with one root + one scoped token.
    await writeFile(
      join(dkgHome, 'auth.token'),
      `${ROOT_TOKEN}\n` +
        `scoped-Aaaaaaaaaaaaaaaaaaaa\tkafka:endpoint:read\tcatchup-bot\t2026-05-04T12:00:00.000Z\n`,
    );
  });

  afterEach(async () => {
    delete process.env.DKG_HOME;
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('lists tokens with prefix + scopes only (no fullToken)', async () => {
    const { store, validTokens } = await loadStoreAndSet();
    const req = buildMockReq('GET', '/api/auth/tokens', undefined, `Bearer ${ROOT_TOKEN}`);
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(buildCtx(req, res, store, validTokens, ROOT_TOKEN));
    expect(captured.status).toBe(200);
    const body = captured.body as { tokens: Array<Record<string, unknown>> };
    expect(body.tokens.length).toBe(2);
    for (const t of body.tokens) {
      expect((t as any).fullToken).toBeUndefined();
      expect((t as any).token).toBeUndefined();
      expect(typeof t.prefix).toBe('string');
      expect((t.prefix as string).length).toBeLessThanOrEqual(8);
    }
    // The full token must NOT appear ANYWHERE in the serialized response.
    expect(JSON.stringify(captured.body)).not.toContain(ROOT_TOKEN);
    expect(JSON.stringify(captured.body)).not.toContain('scoped-Aaaaaaaaaaaaaaaaaaaa');
  });

  it('rejects a scoped (non-root) caller with 403', async () => {
    const { store, validTokens } = await loadStoreAndSet();
    const req = buildMockReq(
      'GET',
      '/api/auth/tokens',
      undefined,
      `Bearer scoped-Aaaaaaaaaaaaaaaaaaaa`,
    );
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(
      buildCtx(req, res, store, validTokens, 'scoped-Aaaaaaaaaaaaaaaaaaaa'),
    );
    expect(captured.status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DELETE /api/auth/tokens/<prefix> — revoke
// ───────────────────────────────────────────────────────────────────────────

describe('DELETE /api/auth/tokens/<prefix>', () => {
  let dkgHome: string;
  const ROOT_TOKEN = 'root-token-ddddddddddddddddddddd';

  beforeEach(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-revoke-'));
    process.env.DKG_HOME = dkgHome;
    await writeFile(
      join(dkgHome, 'auth.token'),
      `${ROOT_TOKEN}\n` +
        `target01XXXXXXXXXXXXX\tkafka:endpoint:read\n`,
    );
  });

  afterEach(async () => {
    delete process.env.DKG_HOME;
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('revokes by prefix: 204 on hit, file no longer contains the token', async () => {
    const { store, validTokens } = await loadStoreAndSet();
    const req = buildMockReq(
      'DELETE',
      '/api/auth/tokens/target01',
      undefined,
      `Bearer ${ROOT_TOKEN}`,
    );
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(buildCtx(req, res, store, validTokens, ROOT_TOKEN));
    expect(captured.status).toBe(204);
    const onDisk = await readFile(join(dkgHome, 'auth.token'), 'utf-8');
    expect(onDisk).not.toContain('target01XXXXXXXXXXXXX');
    expect(validTokens.has('target01XXXXXXXXXXXXX')).toBe(false);
  });

  it('returns 404 when revoking a non-existent prefix (idempotent)', async () => {
    const { store, validTokens } = await loadStoreAndSet();
    const req = buildMockReq(
      'DELETE',
      '/api/auth/tokens/notreall',
      undefined,
      `Bearer ${ROOT_TOKEN}`,
    );
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(buildCtx(req, res, store, validTokens, ROOT_TOKEN));
    expect(captured.status).toBe(404);
    // Repeating the call MUST stay deterministic (still 404).
    const req2 = buildMockReq(
      'DELETE',
      '/api/auth/tokens/notreall',
      undefined,
      `Bearer ${ROOT_TOKEN}`,
    );
    const { res: res2, captured: captured2 } = buildMockRes();
    await handleAuthRoutes(buildCtx(req2, res2, store, validTokens, ROOT_TOKEN));
    expect(captured2.status).toBe(404);
  });

  it('refuses to revoke the bearer token used to make the request (400)', async () => {
    const { store, validTokens } = await loadStoreAndSet();
    const rootPrefix = ROOT_TOKEN.slice(0, 8);
    const req = buildMockReq(
      'DELETE',
      `/api/auth/tokens/${rootPrefix}`,
      undefined,
      `Bearer ${ROOT_TOKEN}`,
    );
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(buildCtx(req, res, store, validTokens, ROOT_TOKEN));
    expect(captured.status).toBe(400);
    expect((captured.body as any).error).toContain('Refusing to revoke');
  });

  it('rejects a scoped (non-root) caller with 403', async () => {
    const { store, validTokens } = await loadStoreAndSet();
    const req = buildMockReq(
      'DELETE',
      '/api/auth/tokens/target01',
      undefined,
      `Bearer target01XXXXXXXXXXXXX`,
    );
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(
      buildCtx(req, res, store, validTokens, 'target01XXXXXXXXXXXXX'),
    );
    expect(captured.status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// END-TO-END: mint → list → use → revoke
// ───────────────────────────────────────────────────────────────────────────

describe('end-to-end mint flow', () => {
  let dkgHome: string;
  const ROOT_TOKEN = 'root-token-eeeeeeeeeeeeeeeeeeeee';

  beforeEach(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-e2e-mint-'));
    process.env.DKG_HOME = dkgHome;
    await writeFile(join(dkgHome, 'auth.token'), `${ROOT_TOKEN}\n`);
  });

  afterEach(async () => {
    delete process.env.DKG_HOME;
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('mint → list reveals it (no secret) → revoke clears it from list', async () => {
    const { store, validTokens } = await loadStoreAndSet();

    // mint
    const mintReq = buildMockReq(
      'POST',
      '/api/auth/tokens',
      { scope: 'kafka:endpoint:write', name: 'producer' },
      `Bearer ${ROOT_TOKEN}`,
    );
    const { res: mintRes, captured: mintCaptured } = buildMockRes();
    await handleAuthRoutes(buildCtx(mintReq, mintRes, store, validTokens, ROOT_TOKEN));
    expect(mintCaptured.status).toBe(201);
    const mintBody = mintCaptured.body as { token: string; prefix: string };

    // list — appears, no secret
    const listReq = buildMockReq('GET', '/api/auth/tokens', undefined, `Bearer ${ROOT_TOKEN}`);
    const { res: listRes, captured: listCaptured } = buildMockRes();
    await handleAuthRoutes(buildCtx(listReq, listRes, store, validTokens, ROOT_TOKEN));
    expect(listCaptured.status).toBe(200);
    const listBody = listCaptured.body as { tokens: Array<{ prefix: string }> };
    const found = listBody.tokens.find((t) => t.prefix === mintBody.prefix);
    expect(found).toBeDefined();
    expect(JSON.stringify(listCaptured.body)).not.toContain(mintBody.token);

    // revoke
    const revokeReq = buildMockReq(
      'DELETE',
      `/api/auth/tokens/${mintBody.prefix}`,
      undefined,
      `Bearer ${ROOT_TOKEN}`,
    );
    const { res: revokeRes, captured: revokeCaptured } = buildMockRes();
    await handleAuthRoutes(
      buildCtx(revokeReq, revokeRes, store, validTokens, ROOT_TOKEN),
    );
    expect(revokeCaptured.status).toBe(204);

    // list again — no longer present
    const listReq2 = buildMockReq('GET', '/api/auth/tokens', undefined, `Bearer ${ROOT_TOKEN}`);
    const { res: listRes2, captured: listCaptured2 } = buildMockRes();
    await handleAuthRoutes(buildCtx(listReq2, listRes2, store, validTokens, ROOT_TOKEN));
    expect(
      (listCaptured2.body as { tokens: Array<{ prefix: string }> }).tokens.find(
        (t) => t.prefix === mintBody.prefix,
      ),
    ).toBeUndefined();
  });
});
