/**
 * Signed-request auth & token rotation tests.
 *
 * Covers audit findings from `.test-audit/BUGS_FOUND.md` → `packages/cli (BURA)`:
 *   - CLI-10 (HIGH) — signed-request auth (spec §18) is completely unimplemented
 *     in `packages/cli/src/auth.ts`. The module only exposes Bearer-token
 *     helpers; there is no signature/nonce verification surface. Spec §18
 *     mandates signed requests with replay protection for the JSON API.
 *   - CLI-11 (HIGH) — token rotation has no in-process effect. `dkg auth
 *     rotate` (see `src/cli.ts` ~line 437) rewrites the file but requires a
 *     daemon restart; the currently-running token set is never invalidated.
 *     There is also no public `revokeToken` / `rotateTokenInMemory` API.
 *
 * These tests do NOT use any mocks. They spin up a tiny real HTTP server
 * using `httpAuthGuard` from `src/auth.ts` — the exact same guard the daemon
 * uses at request ingress — so the test is a faithful miniature of the auth
 * path.
 *
 * Bugs surfaced / left red on purpose:
 *   - PROD-BUG (spec-gap): CLI-10 — no signed-request surface exists.
 *   - PROD-BUG (spec-gap): CLI-11 — no in-process rotation API; stale tokens
 *     keep working until daemon restart.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http';
import { randomBytes, createHmac, createHash } from 'node:crypto';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as authModule from '../src/auth.js';
import { httpAuthGuard, loadTokens, verifyToken } from '../src/auth.js';

// ---------------------------------------------------------------------------
// Shared test server — same httpAuthGuard used in production daemon
// ---------------------------------------------------------------------------

function startGuardedServer(
  validTokens: Set<string>,
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!httpAuthGuard(req, res, true, validTokens)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// CLI-10 — signed request auth & replay protection (spec §18)
// ---------------------------------------------------------------------------

describe('CLI-10 — signed-request auth (spec §18)', () => {
  it('exports a verifier for signed requests (PROD-BUG: spec-gap — not implemented)', () => {
    // Spec §18 describes a signed-request scheme: each request includes a
    // signature over (method, path, body-hash, timestamp, nonce) and the
    // server rejects replays.
    //
    // There are several acceptable module shapes, so we probe for any
    // reasonable spelling. If NONE of these exist, the auth module is
    // Bearer-only — which is the exact spec-gap CLI-10 describes.
    const candidates = [
      'verifySignedRequest',
      'verifyRequestSignature',
      'verifySignature',
      'signedRequestGuard',
      'httpSignedRequestGuard',
    ];
    const found = candidates.filter(
      (name) => typeof (authModule as any)[name] === 'function',
    );

    // RED ON PURPOSE — see BUGS_FOUND.md CLI-10. Remove this comment block
    // and flip the assertion once a signed-request verifier ships.
    expect(found).not.toEqual([]); // PROD-BUG: spec §18 verifier missing
  });

  it('rejects a replayed nonce (PROD-BUG: nonce store unimplemented)', async () => {
    // There is no nonce store to talk to; the Bearer guard accepts every
    // request whose Authorization header matches, with zero timestamp or
    // nonce binding. A request replayed 24 hours later (or 24 million times)
    // is indistinguishable from the original at the transport layer.
    const token = randomBytes(32).toString('base64url');
    const validTokens = new Set([token]);
    const { server, baseUrl } = await startGuardedServer(validTokens);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const first = await fetch(`${baseUrl}/api/query`, {
        method: 'POST',
        headers,
      });
      const second = await fetch(`${baseUrl}/api/query`, {
        method: 'POST',
        headers,
      });

      expect(first.status).toBe(200);
      // PROD-BUG: spec §18 requires per-request nonce, so `second` should
      // be 401 / 409 "replay detected". Bearer-only auth can't distinguish.
      // Left red as evidence — see CLI-10.
      expect(second.status).toBe(401);
    } finally {
      await stopServer(server);
    }
  });

  it('rejects a signed request whose timestamp is outside the freshness window', async () => {
    // Spec §18 also mandates a freshness window (typically ±5 min).
    // With Bearer-only auth there is no timestamp field, so a token
    // captured months ago still works — another manifestation of CLI-10.
    const token = randomBytes(32).toString('base64url');
    const validTokens = new Set([token]);
    const { server, baseUrl } = await startGuardedServer(validTokens);
    try {
      const staleTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const body = JSON.stringify({ sparql: 'ASK { ?s ?p ?o }' });
      const sig = createHmac('sha256', token).update(staleTs + body).digest('hex');
      const res = await fetch(`${baseUrl}/api/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-dkg-timestamp': staleTs,
          'x-dkg-signature': sig,
          'Content-Type': 'application/json',
        },
        body,
      });
      // PROD-BUG: server has no clock-skew check. See CLI-10.
      expect(res.status).toBe(401);
    } finally {
      await stopServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// CLI-11 — token rotation & revocation
// ---------------------------------------------------------------------------

describe('CLI-11 — token rotation & revocation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `dkg-auth-rotate-${randomBytes(4).toString('hex')}`);
    await mkdir(tempDir, { recursive: true });
    process.env.DKG_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.DKG_HOME;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('exposes a programmatic rotate/revoke API (PROD-BUG: missing)', () => {
    // Spec §18 requires tokens to be rotatable at runtime. `dkg auth rotate`
    // (CLI) only rewrites the file; there is no exported function other
    // services can call to rotate-in-place.
    const candidates = [
      'rotateToken',
      'revokeToken',
      'invalidateToken',
      'issueNewToken',
    ];
    const found = candidates.filter(
      (name) => typeof (authModule as any)[name] === 'function',
    );

    // RED ON PURPOSE — see BUGS_FOUND.md CLI-11. The CLI command exists
    // but does not expose any in-process rotation surface the daemon can
    // call to hot-reload its token set.
    expect(found).not.toEqual([]); // PROD-BUG: no in-process rotation API
  });

  it('verifyToken returns true for a token after it has been "rotated" on disk (hot-reload gap)', async () => {
    // Simulate a live daemon: it loaded tokens at boot, then the operator
    // rotated the file. The on-disk file now contains only a new token;
    // the daemon's in-memory `validTokens` set still holds the old one.
    const oldToken = 'old-' + randomBytes(16).toString('hex');
    const newToken = 'new-' + randomBytes(16).toString('hex');

    await writeFile(join(tempDir, 'auth.token'), `${oldToken}\n`);
    const runningValidTokens = await loadTokens();
    expect(runningValidTokens.has(oldToken)).toBe(true);

    // Operator runs `dkg auth rotate` — file is overwritten.
    await writeFile(join(tempDir, 'auth.token'), `${newToken}\n`);

    // Spec §18 expects the OLD token to stop working within a bounded
    // rotation window. In practice, `verifyToken` still accepts the old
    // token because the in-memory set was loaded once at boot and is
    // never reconciled with disk.
    //
    // This assertion is RED on purpose: it asserts the SAFE behavior
    // (old token rejected). Current code keeps old token valid — see
    // CLI-11 and the comment in `src/cli.ts` line ~451
    // ("Restart the daemon for the new token to take effect").
    expect(verifyToken(oldToken, runningValidTokens)).toBe(false);

    // Sanity: the file-based reload would pick up only the new token.
    const reloaded = await loadTokens();
    expect(reloaded.has(newToken)).toBe(true);
    expect(reloaded.has(oldToken)).toBe(false);
  });

  it('fresh loadTokens after rotation contains ONLY the new token (file wire format)', async () => {
    const tokenA = 'a-' + randomBytes(16).toString('hex');
    const tokenB = 'b-' + randomBytes(16).toString('hex');

    await writeFile(join(tempDir, 'auth.token'), `${tokenA}\n`);
    const first = await loadTokens();
    expect(first).toEqual(new Set([tokenA]));

    // `dkg auth rotate` writes a single fresh token with a comment header
    // (see src/cli.ts rotate action). Mimic it byte-for-byte.
    await writeFile(
      join(tempDir, 'auth.token'),
      `# DKG node API token — treat this like a password\n${tokenB}\n`,
    );

    const second = await loadTokens();
    expect(second).toEqual(new Set([tokenB]));
  });

  it('config-provided tokens survive rotation (expected: they do NOT, if rotation means full revocation)', async () => {
    // If rotation is meant to be "nuclear" (drop every previous credential),
    // config-provided tokens must also be dropped when `rotate` runs.
    // Current behavior: config.auth.tokens are mixed back in on every
    // loadTokens() call, so a token pinned in config CANNOT be revoked
    // via `dkg auth rotate`. That's a footgun worth documenting.
    const configToken = 'cfg-' + randomBytes(16).toString('hex');
    const fileTokenA = 'file-a-' + randomBytes(16).toString('hex');
    const fileTokenB = 'file-b-' + randomBytes(16).toString('hex');

    await writeFile(join(tempDir, 'auth.token'), `${fileTokenA}\n`);
    const pre = await loadTokens({ tokens: [configToken] });
    expect(pre.has(configToken)).toBe(true);
    expect(pre.has(fileTokenA)).toBe(true);

    // Simulate rotation.
    await writeFile(join(tempDir, 'auth.token'), `${fileTokenB}\n`);
    const post = await loadTokens({ tokens: [configToken] });
    // CURRENT behavior (documented): config token is still there.
    // This test PASSES on the current code. It's here as a guard against
    // anyone "fixing" rotation by silently dropping config tokens — that
    // would be a separate behavior regression we'd want flagged.
    expect(post.has(configToken)).toBe(true);
    expect(post.has(fileTokenB)).toBe(true);
    expect(post.has(fileTokenA)).toBe(false);
  });
});
