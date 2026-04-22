/**
 * Behavioral coverage for `src/auth.ts` paths NOT exercised by the
 * existing `test/auth.test.ts`:
 *
 *   - verifySignedRequest (every discriminated-result reason)
 *   - rotateToken / revokeToken
 *   - _clearReplayCacheForTesting
 *   - httpAuthGuard branches:
 *       stale-timestamp precheck, Bearer-only replay dedup, SSE query-
 *       param token (/api/events), CORS origin echo, body-bearing path
 *       bypassing the replay dedup.
 *
 * All tests run against real HTTP servers (no request mocking) and a
 * real on-disk `auth.token` file scoped to a tmp dir, matching the QA
 * policy of minimising mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { writeFile, mkdir, rm, utimes, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHmac } from 'node:crypto';
import {
  verifySignedRequest,
  canonicalSignedRequestPayload,
  rotateToken,
  revokeToken,
  httpAuthGuard,
  loadTokens,
  _clearReplayCacheForTesting,
  SIGNED_REQUEST_FRESHNESS_WINDOW_MS,
  enforceSignedRequestPostBody,
  SignedRequestRejectedError,
  verifyHttpSignedRequestAfterBody,
  canonicalRequestPath,
} from '../src/auth.js';

function sigFor(
  token: string,
  method: string,
  path: string,
  ts: string,
  nonce: string,
  body: string | Buffer,
): string {
  return createHmac('sha256', token)
    .update(canonicalSignedRequestPayload(method, path, ts, nonce, body))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// verifySignedRequest — every branch of the discriminated-result type
// ---------------------------------------------------------------------------

describe('verifySignedRequest', () => {
  const TOKEN = 'secret-key';
  const BODY = '{"x":1}';

  const freshNonce = () => `n-${randomBytes(8).toString('hex')}`;

  it('returns missing-fields when timestamp is absent', () => {
    const out = verifySignedRequest({
      method: 'POST', path: '/x', body: BODY,
      timestamp: '', signature: 'abc', token: TOKEN, nonce: freshNonce(),
    });
    expect(out).toEqual({ ok: false, reason: 'missing-fields' });
  });

  it('returns missing-fields when signature is absent', () => {
    const out = verifySignedRequest({
      method: 'POST', path: '/x', body: BODY,
      timestamp: new Date().toISOString(), signature: '', token: TOKEN, nonce: freshNonce(),
    });
    expect(out).toEqual({ ok: false, reason: 'missing-fields' });
  });

  it('returns missing-fields when token is absent', () => {
    const out = verifySignedRequest({
      method: 'POST', path: '/x', body: BODY,
      timestamp: new Date().toISOString(), signature: 'abc', token: '', nonce: freshNonce(),
    });
    expect(out).toEqual({ ok: false, reason: 'missing-fields' });
  });

  it('returns missing-fields when nonce is absent (bot review F3 — nonce is now required)', () => {
    const ts = new Date().toISOString();
    const out = verifySignedRequest({
      method: 'POST', path: '/x', body: BODY,
      timestamp: ts, signature: sigFor(TOKEN, 'POST', '/x', ts, 'n1', BODY), token: TOKEN,
    });
    expect(out).toEqual({ ok: false, reason: 'missing-fields' });
  });

  it('returns stale-timestamp for an unparseable timestamp', () => {
    const out = verifySignedRequest({
      method: 'POST', path: '/x', body: BODY,
      timestamp: 'not-a-date', signature: 'abc', token: TOKEN, nonce: freshNonce(),
    });
    expect(out).toEqual({ ok: false, reason: 'stale-timestamp' });
  });

  it('returns stale-timestamp when outside the freshness window', () => {
    const now = Date.now();
    const oldTs = new Date(now - SIGNED_REQUEST_FRESHNESS_WINDOW_MS - 60_000).toISOString();
    const nonce = freshNonce();
    const out = verifySignedRequest({
      method: 'POST', path: '/x', body: BODY,
      timestamp: oldTs, signature: sigFor(TOKEN, 'POST', '/x', oldTs, nonce, BODY),
      token: TOKEN, nonce, now,
    });
    expect(out).toEqual({ ok: false, reason: 'stale-timestamp' });
  });

  it('accepts numeric epoch-ms timestamps', () => {
    const now = Date.now();
    const ts = String(now);
    const nonce = freshNonce();
    const out = verifySignedRequest({
      method: 'POST', path: '/x', body: BODY,
      timestamp: ts, signature: sigFor(TOKEN, 'POST', '/x', ts, nonce, BODY),
      token: TOKEN, nonce, now,
    });
    expect(out).toEqual({ ok: true });
  });

  it('returns bad-signature for wrong signature bytes', () => {
    const ts = new Date().toISOString();
    const nonce = freshNonce();
    const wrongSig = sigFor('other-key', 'POST', '/x', ts, nonce, BODY);
    const out = verifySignedRequest({
      method: 'POST', path: '/x', body: BODY,
      timestamp: ts, signature: wrongSig, token: TOKEN, nonce,
    });
    expect(out).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('returns bad-signature when the hex string is malformed (length mismatch)', () => {
    const ts = new Date().toISOString();
    const out = verifySignedRequest({
      method: 'POST', path: '/x', body: BODY,
      timestamp: ts, signature: 'aa', token: TOKEN, nonce: freshNonce(),
    });
    expect(out).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('returns bad-signature when the method is swapped (method is bound into the HMAC)', () => {
    const ts = new Date().toISOString();
    const nonce = freshNonce();
    const sig = sigFor(TOKEN, 'POST', '/x', ts, nonce, BODY);
    const out = verifySignedRequest({
      method: 'DELETE', path: '/x', body: BODY,
      timestamp: ts, signature: sig, token: TOKEN, nonce,
    });
    expect(out).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('returns bad-signature when the path is swapped (path is bound into the HMAC)', () => {
    const ts = new Date().toISOString();
    const nonce = freshNonce();
    const sig = sigFor(TOKEN, 'POST', '/x', ts, nonce, BODY);
    const out = verifySignedRequest({
      method: 'POST', path: '/y', body: BODY,
      timestamp: ts, signature: sig, token: TOKEN, nonce,
    });
    expect(out).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('returns bad-signature when the body is tampered (body hash is bound into the HMAC)', () => {
    const ts = new Date().toISOString();
    const nonce = freshNonce();
    const sig = sigFor(TOKEN, 'POST', '/x', ts, nonce, BODY);
    const out = verifySignedRequest({
      method: 'POST', path: '/x', body: '{"x":2}',
      timestamp: ts, signature: sig, token: TOKEN, nonce,
    });
    expect(out).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('returns bad-signature when the nonce is swapped (nonce is bound into the HMAC)', () => {
    const ts = new Date().toISOString();
    const nonce = freshNonce();
    const sig = sigFor(TOKEN, 'POST', '/x', ts, nonce, BODY);
    const out = verifySignedRequest({
      method: 'POST', path: '/x', body: BODY,
      timestamp: ts, signature: sig, token: TOKEN, nonce: 'different-nonce',
    });
    expect(out).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('returns replayed-nonce on second use of the same nonce', () => {
    const ts = new Date().toISOString();
    const nonce = freshNonce();
    const sig = sigFor(TOKEN, 'POST', '/x', ts, nonce, BODY);
    const first = verifySignedRequest({
      method: 'POST', path: '/x', body: BODY,
      timestamp: ts, signature: sig, token: TOKEN, nonce,
    });
    expect(first.ok).toBe(true);
    const second = verifySignedRequest({
      method: 'POST', path: '/x', body: BODY,
      timestamp: ts, signature: sig, token: TOKEN, nonce,
    });
    expect(second).toEqual({ ok: false, reason: 'replayed-nonce' });
  });

  it('accepts a Buffer body', () => {
    const ts = new Date().toISOString();
    const nonce = freshNonce();
    const bodyBuf = Buffer.from(BODY, 'utf-8');
    const sig = sigFor(TOKEN, 'POST', '/x', ts, nonce, bodyBuf);
    const out = verifySignedRequest({
      method: 'POST', path: '/x', body: bodyBuf,
      timestamp: ts, signature: sig, token: TOKEN, nonce,
    });
    expect(out).toEqual({ ok: true });
  });

  it('respects a custom freshnessWindowMs', () => {
    const now = Date.now();
    const ts = new Date(now - 10_000).toISOString();
    const nonce = freshNonce();
    const out = verifySignedRequest({
      method: 'POST', path: '/x', body: BODY,
      timestamp: ts, signature: sigFor(TOKEN, 'POST', '/x', ts, nonce, BODY),
      token: TOKEN, nonce, now, freshnessWindowMs: 1000,
    });
    expect(out).toEqual({ ok: false, reason: 'stale-timestamp' });
  });
});

// ---------------------------------------------------------------------------
// rotateToken + revokeToken — programmatic rotation API
// ---------------------------------------------------------------------------

describe('rotateToken / revokeToken', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `dkg-auth-rot-${randomBytes(4).toString('hex')}`);
    await mkdir(tempDir, { recursive: true });
    process.env.DKG_HOME = tempDir;
    _clearReplayCacheForTesting();
  });

  afterEach(async () => {
    delete process.env.DKG_HOME;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rotateToken generates a new token, rewrites the file, and invalidates the old one', async () => {
    const tokens = await loadTokens();
    const [original] = [...tokens];
    expect(tokens.has(original)).toBe(true);

    const fresh = await rotateToken(tokens);
    expect(fresh).not.toBe(original);
    expect(tokens.has(fresh)).toBe(true);
    // The original file-derived token must now be out of the set.
    expect(tokens.has(original)).toBe(false);

    // File on disk must contain only the new token.
    const raw = await readFile(join(tempDir, 'auth.token'), 'utf-8');
    expect(raw).toContain(fresh);
    expect(raw).not.toContain(original);
  });

  it('rotateToken preserves config-pinned tokens', async () => {
    const tokens = await loadTokens({ tokens: ['config-pin'] });
    await rotateToken(tokens);
    expect(tokens.has('config-pin')).toBe(true);
  });

  it('revokeToken removes a token from the in-memory set', async () => {
    const tokens = await loadTokens({ tokens: ['t-a', 't-b'] });
    expect(revokeToken('t-a', tokens)).toBe(true);
    expect(tokens.has('t-a')).toBe(false);
    expect(tokens.has('t-b')).toBe(true);
    // Revoking a missing token returns false (Set.delete semantics).
    expect(revokeToken('not-present', tokens)).toBe(false);
  });

  it('verifyToken hot-reloads tokens when the file mtime changes', async () => {
    const { verifyToken } = await import('../src/auth.js');
    const tokens = await loadTokens();
    const [original] = [...tokens];
    expect(verifyToken(original, tokens)).toBe(true);

    // Rewrite the file out-of-band and bump the mtime.
    const tokPath = join(tempDir, 'auth.token');
    await writeFile(tokPath, '# rotated\nnew-out-of-band-token\n');
    const later = new Date(Date.now() + 60_000);
    await utimes(tokPath, later, later);

    // Next verify should invalidate the original and accept the new one.
    expect(verifyToken('new-out-of-band-token', tokens)).toBe(true);
    expect(verifyToken(original, tokens)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// httpAuthGuard — SSE, replay-dedup, stale-ts precheck, CORS origin echo
// ---------------------------------------------------------------------------

describe('httpAuthGuard — advanced branches', () => {
  const VALID = 'test-tok';
  let validTokens: Set<string>;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    _clearReplayCacheForTesting();
    validTokens = new Set([VALID]);
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!httpAuthGuard(req, res, true, validTokens, 'https://example.com')) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
  });

  it('accepts a valid token via the ?token= query parameter on /api/events (SSE)', async () => {
    const res = await fetch(`${baseUrl}/api/events?token=${VALID}`);
    expect(res.status).toBe(200);
  });

  it('rejects /api/events with an invalid token query parameter', async () => {
    const res = await fetch(`${baseUrl}/api/events?token=nope`);
    expect(res.status).toBe(401);
  });

  it('does NOT accept ?token= on non-SSE endpoints', async () => {
    // /api/agents is protected — query-param token is SSE-only.
    const res = await fetch(`${baseUrl}/api/agents?token=${VALID}`);
    expect(res.status).toBe(401);
  });

  it('rejects when x-dkg-timestamp is outside the freshness window (pre-signature gate)', async () => {
    const staleTs = String(Date.now() - SIGNED_REQUEST_FRESHNESS_WINDOW_MS - 5000);
    const res = await fetch(`${baseUrl}/api/agents`, {
      headers: { Authorization: `Bearer ${VALID}`, 'x-dkg-timestamp': staleTs },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Stale or unparseable x-dkg-timestamp/);
  });

  it('rejects unparseable x-dkg-timestamp values', async () => {
    const res = await fetch(`${baseUrl}/api/agents`, {
      headers: { Authorization: `Bearer ${VALID}`, 'x-dkg-timestamp': 'not-a-date' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts a well-formed fresh x-dkg-timestamp', async () => {
    const freshTs = String(Date.now());
    const res = await fetch(`${baseUrl}/api/agents`, {
      headers: { Authorization: `Bearer ${VALID}`, 'x-dkg-timestamp': freshTs },
    });
    expect(res.status).toBe(200);
  });

  it('does NOT reject legitimate duplicate body-less POST retries (bot review PR #229 regression fix)', async () => {
    // Previous behaviour: the CLI-10 fingerprint dedup 401-rejected the
    // second identical body-less POST within 60 s. That broke every
    // idempotent retry like `POST /api/local-agent-integrations/:id/refresh`
    // when a user clicked the "refresh" button twice. The guard was
    // removed in favour of opt-in signed-request replay protection.
    const first = await fetch(`${baseUrl}/api/shared-memory/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${VALID}` },
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/api/shared-memory/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${VALID}` },
    });
    expect(second.status).toBe(200);

    // A third, immediate retry is also fine — there is no coarse
    // fingerprint cache any more; callers that want strict replay
    // defence opt into signed-request mode.
    const third = await fetch(`${baseUrl}/api/shared-memory/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${VALID}` },
    });
    expect(third.status).toBe(200);
  });

  it('does NOT reject legitimate duplicate body-less DELETE retries', async () => {
    // Parallel regression case: body-less DELETE used to also fall into
    // the fingerprint dedup. It must be safe to retry an idempotent
    // DELETE because the underlying state transition is itself
    // idempotent (delete of absent resource → 404/200, never 401-replay).
    const first = await fetch(`${baseUrl}/api/agents/nope`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${VALID}` },
    });
    // The daemon may respond 404 (unknown id) — what matters here is
    // that the auth layer does NOT 401 on the second call.
    expect(first.status).not.toBe(401);

    const second = await fetch(`${baseUrl}/api/agents/nope`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${VALID}` },
    });
    expect(second.status).not.toBe(401);
  });

  it('does NOT dedupe POSTs that carry a body', async () => {
    // First POST with a body.
    const first = await fetch(`${baseUrl}/api/shared-memory/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${VALID}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    });
    expect(first.status).toBe(200);

    // Second POST with a body — must still succeed (application layer
    // decides dedup semantics for body-bearing requests).
    const second = await fetch(`${baseUrl}/api/shared-memory/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${VALID}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    });
    expect(second.status).toBe(200);
  });

  it('echoes the configured CORS origin in 401 responses', async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com');
  });

  it('does NOT dedupe GET/HEAD requests (never stateful)', async () => {
    const a = await fetch(`${baseUrl}/api/agents`, {
      headers: { Authorization: `Bearer ${VALID}` },
    });
    expect(a.status).toBe(200);
    const b = await fetch(`${baseUrl}/api/agents`, {
      headers: { Authorization: `Bearer ${VALID}` },
    });
    expect(b.status).toBe(200);
  });

  it('_clearReplayCacheForTesting resets the dedup state', async () => {
    await fetch(`${baseUrl}/api/shared-memory/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${VALID}` },
    });
    _clearReplayCacheForTesting();
    const retry = await fetch(`${baseUrl}/api/shared-memory/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${VALID}` },
    });
    expect(retry.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PR #229 F2 follow-up: enforceSignedRequestPostBody must reject tampered /
// missing / stale signatures once the body is buffered. The previous revision
// pre-validated the headers and trusted the request if the bearer token was
// valid — this test pins the NEW enforcement path.
// ---------------------------------------------------------------------------

describe('enforceSignedRequestPostBody — centralised body-binding enforcement', () => {
  const TOKEN = 'post-body-secret';
  const freshNonce = () => `n-${randomBytes(8).toString('hex')}`;

  function makeReqWithPending(
    method: string,
    url: string,
    timestamp: string,
    nonce: string,
    signature: string,
  ): IncomingMessage {
    const req = {
      method,
      url,
      headers: { host: 'localhost' },
    } as unknown as IncomingMessage;
    (req as unknown as { __dkgSignedAuth?: unknown }).__dkgSignedAuth = {
      token: TOKEN,
      timestamp,
      nonce,
      signature,
    };
    return req;
  }

  it('is a no-op when the request did not opt into signed mode', () => {
    const req = { method: 'POST', url: '/x', headers: { host: 'localhost' } } as unknown as IncomingMessage;
    expect(() => enforceSignedRequestPostBody(req, '{"x":1}')).not.toThrow();
  });

  it('throws SignedRequestRejectedError when body has been tampered', () => {
    const ts = new Date().toISOString();
    const nonce = freshNonce();
    const realBody = '{"x":1}';
    const sig = sigFor(TOKEN, 'POST', '/api/query', ts, nonce, realBody);
    const req = makeReqWithPending('POST', '/api/query', ts, nonce, sig);
    const tamperedBody = '{"x":2}';
    expect(() => enforceSignedRequestPostBody(req, tamperedBody)).toThrow(SignedRequestRejectedError);
    try {
      enforceSignedRequestPostBody(req, tamperedBody);
    } catch (err) {
      expect((err as SignedRequestRejectedError).reason).toBe('bad-signature');
    }
  });

  it('accepts a correctly-signed body and marks the request verified (idempotent)', () => {
    const ts = new Date().toISOString();
    const nonce = freshNonce();
    const body = Buffer.from('{"x":1}');
    const sig = sigFor(TOKEN, 'POST', '/api/query', ts, nonce, body);
    const req = makeReqWithPending('POST', '/api/query', ts, nonce, sig);
    expect(() => enforceSignedRequestPostBody(req, body)).not.toThrow();
    const pending = (req as unknown as { __dkgSignedAuth?: { verified?: boolean } }).__dkgSignedAuth;
    expect(pending?.verified).toBe(true);
    // A second call with *different* bytes must NOT re-verify (idempotent);
    // this is important for routes that read the body more than once
    // (multipart sub-reads). The first verification is the authoritative
    // one, and the stashed auth context is marked accordingly.
    expect(() => enforceSignedRequestPostBody(req, 'tampered')).not.toThrow();
  });

  it('throws with reason=stale-timestamp when the signature is old', () => {
    const staleTs = new Date(Date.now() - SIGNED_REQUEST_FRESHNESS_WINDOW_MS - 60_000).toISOString();
    const nonce = freshNonce();
    const body = '{}';
    const sig = sigFor(TOKEN, 'POST', '/api/x', staleTs, nonce, body);
    const req = makeReqWithPending('POST', '/api/x', staleTs, nonce, sig);
    try {
      enforceSignedRequestPostBody(req, body);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SignedRequestRejectedError);
      expect((err as SignedRequestRejectedError).reason).toBe('stale-timestamp');
    }
  });

  it('verifyHttpSignedRequestAfterBody remains exported for legacy callers', () => {
    const ts = new Date().toISOString();
    const nonce = freshNonce();
    const body = 'payload';
    const sig = sigFor(TOKEN, 'POST', '/api/legacy', ts, nonce, body);
    const req = makeReqWithPending('POST', '/api/legacy', ts, nonce, sig);
    const out = verifyHttpSignedRequestAfterBody(req, body);
    expect(out).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// PR #229 F2 second follow-up: httpAuthGuard must fail closed on signed
// GET / HEAD / zero-body requests that never reach readBody*(), so the
// daemon can't accept a forged x-dkg-signature just because the token is
// valid and the timestamp is fresh. Previously httpAuthGuard stashed
// __dkgSignedAuth and returned true for these routes, and nothing ever
// verified the signature.
// ---------------------------------------------------------------------------

describe('httpAuthGuard — signed GET/HEAD requests verify HMAC synchronously', () => {
  const VALID = 'get-head-tok';
  let validTokens: Set<string>;
  let server: Server;
  let baseUrl: string;
  let handlerCallCount: number;

  beforeEach(async () => {
    _clearReplayCacheForTesting();
    validTokens = new Set([VALID]);
    handlerCallCount = 0;
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!httpAuthGuard(req, res, true, validTokens, null)) return;
      // Only count handler invocations that survive the guard — an
      // unverified signed request must NEVER get here.
      handlerCallCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
  });

  function signedHeaders(
    method: string,
    pathName: string,
    body: string = '',
    overrides: Partial<{ ts: string; nonce: string; sig: string }> = {},
  ): Record<string, string> {
    const ts = overrides.ts ?? String(Date.now());
    const nonce = overrides.nonce ?? `n-${randomBytes(8).toString('hex')}`;
    const sig = overrides.sig ?? sigFor(VALID, method, pathName, ts, nonce, body);
    return {
      Authorization: `Bearer ${VALID}`,
      'x-dkg-timestamp': ts,
      'x-dkg-nonce': nonce,
      'x-dkg-signature': sig,
    };
  }

  it('accepts a correctly-signed GET (bound to empty body) — 200', async () => {
    const res = await fetch(`${baseUrl}/api/agents`, {
      method: 'GET',
      headers: signedHeaders('GET', '/api/agents', ''),
    });
    expect(res.status).toBe(200);
    expect(handlerCallCount).toBe(1);
  });

  it('rejects a signed GET with a tampered signature — 401 and the handler never runs', async () => {
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    // Sign something else entirely (wrong path), then send to /api/agents.
    const forgedSig = sigFor(VALID, 'GET', '/api/something-else', ts, nonce, '');
    const res = await fetch(`${baseUrl}/api/agents`, {
      method: 'GET',
      headers: signedHeaders('GET', '/api/agents', '', { ts, nonce, sig: forgedSig }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Signed request rejected: bad-signature/);
    expect(handlerCallCount).toBe(0);
  });

  it('rejects a signed HEAD with a tampered signature — 401', async () => {
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const res = await fetch(`${baseUrl}/api/agents`, {
      method: 'HEAD',
      headers: signedHeaders('HEAD', '/api/agents', '', {
        ts,
        nonce,
        sig: 'deadbeef'.repeat(8),
      }),
    });
    expect(res.status).toBe(401);
    expect(handlerCallCount).toBe(0);
  });

  it('rejects a signed body-less POST with a tampered signature — 401 (handler never runs)', async () => {
    // POST with content-length: 0 must be treated as zero-body and
    // verified synchronously, not waved through because no readBody*()
    // runs for this handler.
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const res = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: {
        ...signedHeaders('POST', '/api/agents', '', {
          ts,
          nonce,
          sig: 'aa'.repeat(32),
        }),
        'Content-Length': '0',
      },
    });
    expect(res.status).toBe(401);
    expect(handlerCallCount).toBe(0);
  });

  it('rejects a signed GET with a forged body binding (signed for non-empty body, request has none)', async () => {
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    // Attacker signs using a pretend body they hope the server won't check.
    const bodyHashed = 'secret-payload';
    const forgedSig = sigFor(VALID, 'GET', '/api/agents', ts, nonce, bodyHashed);
    const res = await fetch(`${baseUrl}/api/agents`, {
      method: 'GET',
      headers: signedHeaders('GET', '/api/agents', '', { ts, nonce, sig: forgedSig }),
    });
    expect(res.status).toBe(401);
    expect(handlerCallCount).toBe(0);
  });

  it('handles a signed GET marks request.__dkgSignedAuth.verified so later readBody is a no-op', async () => {
    // White-box test: spin up an in-process server that reaches into
    // the request object and pins that __dkgSignedAuth.verified === true
    // after the guard passes for a signed GET.
    const recorded: Array<{ verified?: boolean }> = [];
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      if (!httpAuthGuard(req, res, true, new Set([VALID]), null)) return;
      const pending = (req as unknown as {
        __dkgSignedAuth?: { verified?: boolean };
      }).__dkgSignedAuth;
      recorded.push({ verified: pending?.verified });
      res.writeHead(200);
      res.end();
    };
    const s2 = createServer(handler);
    await new Promise<void>(r => s2.listen(0, '127.0.0.1', r));
    const port = (s2.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/agents`, {
        method: 'GET',
        headers: signedHeaders('GET', '/api/agents', ''),
      });
      expect(res.status).toBe(200);
      expect(recorded[0]?.verified).toBe(true);
    } finally {
      await new Promise<void>(r => s2.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// PR #229 follow-up: signed HMAC must bind the FULL request path
// (pathname + search), not just pathname. Previously an attacker could
// swap query parameters after signing and the signature stayed valid.
// ---------------------------------------------------------------------------

describe('httpAuthGuard — signed-request HMAC binds path+query (pathname + search)', () => {
  const VALID = 'query-bind-tok';
  let validTokens: Set<string>;
  let server: Server;
  let baseUrl: string;
  let handlerCallCount: number;

  beforeEach(async () => {
    _clearReplayCacheForTesting();
    validTokens = new Set([VALID]);
    handlerCallCount = 0;
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!httpAuthGuard(req, res, true, validTokens, null)) return;
      handlerCallCount++;
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
  });

  it('canonicalRequestPath returns pathname + search (with the ? literal)', () => {
    const req = {
      method: 'GET',
      url: '/api/query?graph=abc&name=Bob',
      headers: { host: 'localhost' },
    } as unknown as IncomingMessage;
    expect(canonicalRequestPath(req)).toBe('/api/query?graph=abc&name=Bob');
  });

  it('canonicalRequestPath returns pathname only when no query string is present', () => {
    const req = {
      method: 'GET',
      url: '/api/agents',
      headers: { host: 'localhost' },
    } as unknown as IncomingMessage;
    expect(canonicalRequestPath(req)).toBe('/api/agents');
  });

  it('rejects a signed GET when the query string differs from the signed one', async () => {
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    // Sign `/api/agents?only=abc`, but send `/api/agents?only=abc&poison=1`.
    const sigForOriginal = sigFor(VALID, 'GET', '/api/agents?only=abc', ts, nonce, '');
    const res = await fetch(`${baseUrl}/api/agents?only=abc&poison=1`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${VALID}`,
        'x-dkg-timestamp': ts,
        'x-dkg-nonce': nonce,
        'x-dkg-signature': sigForOriginal,
      },
    });
    expect(res.status).toBe(401);
    expect(handlerCallCount).toBe(0);
    const body = await res.json();
    expect(body.error).toMatch(/bad-signature/);
  });

  it('accepts a signed GET whose signature was computed over pathname + search', async () => {
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const fullPath = '/api/agents?only=abc';
    const sig = sigFor(VALID, 'GET', fullPath, ts, nonce, '');
    const res = await fetch(`${baseUrl}${fullPath}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${VALID}`,
        'x-dkg-timestamp': ts,
        'x-dkg-nonce': nonce,
        'x-dkg-signature': sig,
      },
    });
    expect(res.status).toBe(200);
    expect(handlerCallCount).toBe(1);
  });

  it('rejects a signed GET where the order of query params differs (signature covers the literal)', async () => {
    // The canonicalisation is deliberately literal — `?a=1&b=2` and
    // `?b=2&a=1` are DIFFERENT signed paths. Clients MUST send the same
    // query string they signed. Any re-ordering by a proxy invalidates
    // the signature — which is the safe default.
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const sig = sigFor(VALID, 'GET', '/api/agents?a=1&b=2', ts, nonce, '');
    const res = await fetch(`${baseUrl}/api/agents?b=2&a=1`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${VALID}`,
        'x-dkg-timestamp': ts,
        'x-dkg-nonce': nonce,
        'x-dkg-signature': sig,
      },
    });
    expect(res.status).toBe(401);
    expect(handlerCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PR #229 follow-up: strict hex validation for x-dkg-signature.
// `Buffer.from(hex, 'hex')` silently truncates at the first non-hex
// character, so `<valid-hmac>zz` decoded to the valid bytes and then
// passed timingSafeEqual. Must reject malformed hex up front.
// ---------------------------------------------------------------------------

describe('verifySignedRequest — strict hex validation of x-dkg-signature', () => {
  const TOKEN = 'hex-strict-tok';
  const freshNonce = () => `n-${randomBytes(8).toString('hex')}`;
  const ts = () => new Date().toISOString();

  function validInput() {
    const t = ts();
    const n = freshNonce();
    const sig = sigFor(TOKEN, 'POST', '/api/x', t, n, 'body');
    return { sig, timestamp: t, nonce: n };
  }

  it('accepts a correctly-formed 64-char hex signature', () => {
    const { sig, timestamp, nonce } = validInput();
    _clearReplayCacheForTesting();
    const out = verifySignedRequest({
      method: 'POST', path: '/api/x', body: 'body',
      timestamp, signature: sig, token: TOKEN, nonce,
    });
    expect(out).toEqual({ ok: true });
  });

  it('rejects a signature with non-hex characters (even if a valid hex prefix is present)', () => {
    // Classic Buffer.from('abcdefZZ...', 'hex') truncation attack.
    const { sig, timestamp, nonce } = validInput();
    _clearReplayCacheForTesting();
    // Replace the last 2 chars of a valid 64-hex-char sig with `zz`
    // (non-hex). With strict validation this MUST be rejected.
    const tampered = sig.slice(0, -2) + 'zz';
    const out = verifySignedRequest({
      method: 'POST', path: '/api/x', body: 'body',
      timestamp, signature: tampered, token: TOKEN, nonce,
    });
    expect(out).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a signature whose length is not 64 hex characters', () => {
    _clearReplayCacheForTesting();
    const { timestamp, nonce } = validInput();
    const tooShort = 'abcdef';
    const tooLong = 'a'.repeat(128);
    for (const candidate of [tooShort, tooLong]) {
      const out = verifySignedRequest({
        method: 'POST', path: '/api/x', body: 'body',
        timestamp, signature: candidate, token: TOKEN, nonce,
      });
      expect(out).toEqual({ ok: false, reason: 'bad-signature' });
    }
  });

  it('rejects a signature containing whitespace or 0x prefix', () => {
    _clearReplayCacheForTesting();
    const { sig, timestamp, nonce } = validInput();
    // Inject a leading `0x` — valid hex prefix but not our format.
    const withPrefix = '0x' + sig.slice(2);
    // Inject a space.
    const withSpace = sig.slice(0, 10) + ' ' + sig.slice(11);
    for (const candidate of [withPrefix, withSpace]) {
      const out = verifySignedRequest({
        method: 'POST', path: '/api/x', body: 'body',
        timestamp, signature: candidate, token: TOKEN, nonce,
      });
      expect(out).toEqual({ ok: false, reason: 'bad-signature' });
    }
  });

  it('accepts uppercase hex (clients that emit A-F instead of a-f still work)', () => {
    _clearReplayCacheForTesting();
    const { sig, timestamp, nonce } = validInput();
    const upper = sig.toUpperCase();
    const out = verifySignedRequest({
      method: 'POST', path: '/api/x', body: 'body',
      timestamp, signature: upper, token: TOKEN, nonce,
    });
    expect(out).toEqual({ ok: true });
  });
});
