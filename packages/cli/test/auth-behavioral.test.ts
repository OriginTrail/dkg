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
import { createConnection } from 'node:net';
import { writeFile, mkdir, rm, utimes, readFile, unlink } from 'node:fs/promises';
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

  it('returns missing-fields when nonce is absent', () => {
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

  // the replay cache used to
  // be keyed by the raw nonce string, so two different bearer tokens
  // that happened to pick the same nonce would reject each other for
  // the full freshness window (cross-client DoS + false-positive
  // replays). Scope the key by the token as well.
  describe('replay-cache scope', () => {
    it('nonce collision across different tokens does NOT cross-block', () => {
      const ts = new Date().toISOString();
      const nonce = freshNonce();

      const TOKEN_A = 'token-A-1234567890abcdef';
      const TOKEN_B = 'token-B-1234567890abcdef';

      const sigA = sigFor(TOKEN_A, 'POST', '/x', ts, nonce, BODY);
      const sigB = sigFor(TOKEN_B, 'POST', '/x', ts, nonce, BODY);

      const firstA = verifySignedRequest({
        method: 'POST', path: '/x', body: BODY,
        timestamp: ts, signature: sigA, token: TOKEN_A, nonce,
      });
      expect(firstA).toEqual({ ok: true });

      // Same nonce, DIFFERENT token — must succeed (not a replay).
      const firstB = verifySignedRequest({
        method: 'POST', path: '/x', body: BODY,
        timestamp: ts, signature: sigB, token: TOKEN_B, nonce,
      });
      expect(firstB).toEqual({ ok: true });
    });

    it('same token + same nonce IS still rejected as a replay', () => {
      const ts = new Date().toISOString();
      const nonce = freshNonce();
      const sig = sigFor(TOKEN, 'POST', '/y', ts, nonce, BODY);
      const first = verifySignedRequest({
        method: 'POST', path: '/y', body: BODY,
        timestamp: ts, signature: sig, token: TOKEN, nonce,
      });
      expect(first.ok).toBe(true);
      const replay = verifySignedRequest({
        method: 'POST', path: '/y', body: BODY,
        timestamp: ts, signature: sig, token: TOKEN, nonce,
      });
      expect(replay).toEqual({ ok: false, reason: 'replayed-nonce' });
    });
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
    expect(await revokeToken('t-a', tokens)).toBe(true);
    expect(tokens.has('t-a')).toBe(false);
    expect(tokens.has('t-b')).toBe(true);
    // Revoking a missing token returns false (Set.delete semantics).
    expect(await revokeToken('not-present', tokens)).toBe(false);
  });

  // pin the persistence
  // contract for file-backed tokens. Pre-r19-4, `revokeToken` was a
  // synchronous in-memory `Set.delete` only — and `verifyToken()`'s
  // per-call reconcile would silently re-import the still-on-disk
  // entry on the very next request. The fix rewrites `auth.token` to
  // exclude the revoked token; this test pins both the rewrite and
  // the cross-check that `verifyToken()` no longer re-accepts it.
  it('revokeToken persists removal of a file-backed token across verifyToken reconciliation', async () => {
    const { verifyToken } = await import('../src/auth.js');
    const tokenA = 'file-backed-token-a-' + randomBytes(8).toString('hex');
    const tokenB = 'file-backed-token-b-' + randomBytes(8).toString('hex');
    const tokPath = join(tempDir, 'auth.token');
    await writeFile(tokPath, `# DKG token file\n${tokenA}\n${tokenB}\n`, { mode: 0o600 });
    const tokens = await loadTokens();
    // Sanity: both file tokens are loaded.
    expect(tokens.has(tokenA)).toBe(true);
    expect(tokens.has(tokenB)).toBe(true);
    expect(verifyToken(tokenA, tokens)).toBe(true);
    expect(verifyToken(tokenB, tokens)).toBe(true);

    // Revoke A. The function MUST be awaited (it now persists to disk).
    expect(await revokeToken(tokenA, tokens)).toBe(true);

    // The file on disk must no longer contain tokenA, but MUST still
    // contain tokenB and the comment header.
    const after = await readFile(tokPath, 'utf-8');
    expect(after).not.toContain(tokenA);
    expect(after).toContain(tokenB);
    expect(after).toContain('# DKG token file');

    // Cross-check the bug bot's specific concern: the very next
    // `verifyToken()` call MUST NOT silently re-import the revoked
    // token. The implementation would have had
    // reconcileFileTokens re-add tokenA from disk on the next call,
    // so calling verifyToken(tokenA, ...) would still return true.
    // After r19-4, the file no longer contains tokenA, so even when
    // reconcile runs (we touch the mtime to force it), the revoked
    // token stays revoked.
    const later = new Date(Date.now() + 60_000);
    await utimes(tokPath, later, later);
    expect(verifyToken(tokenA, tokens)).toBe(false);
    // Other tokens unaffected.
    expect(verifyToken(tokenB, tokens)).toBe(true);
  });

  // -------------------------------------------------------------
  // auth.ts:203, KwIE). Pre-fix the
  // file-vs-config provenance was lost: `loadTokens()` merges both
  // sources into one `Set` AND tracks them all in `snapshot.fileTokens`
  // when the value happens to also appear on disk (a real-world
  // overlap shape — operators routinely seed `auth.token` with the
  // same value pinned in `config.auth.tokens` so the two control
  // surfaces don't drift during a rollout). Reconciliation then
  // deleted those tokens from `validTokens` whenever the file rotation
  // removed them from disk, silently revoking a configured admin
  // credential until restart.
  //
  // Fix: `lastFileSnapshot` now carries a separate `configTokens`
  // set, populated from the AuthConfig at load time, and every
  // delete path (`reconcileFileTokens`, `rotateToken`, the ENOENT
  // branch of `revokeToken`) skips tokens that are still pinned by
  // config. Tests below pin the four corners.
  // -------------------------------------------------------------
  describe('(KwIE) — config provenance survives file reconciliation', () => {
    it('reconcileFileTokens does NOT revoke a token that lives in BOTH auth.token and config.auth.tokens when the file rewrite removes it', async () => {
      const { verifyToken } = await import('../src/auth.js');
      const tokPath = join(tempDir, 'auth.token');
      const overlap = 'overlap-tok-' + randomBytes(8).toString('hex');
      const fileOnly = 'file-only-tok-' + randomBytes(8).toString('hex');
      // Both tokens sit on disk; one is ALSO config-pinned.
      await writeFile(tokPath, `${overlap}\n${fileOnly}\n`, { mode: 0o600 });

      const tokens = await loadTokens({ tokens: [overlap] });
      expect(tokens.has(overlap)).toBe(true);
      expect(tokens.has(fileOnly)).toBe(true);

      // Operator runs `dkg auth rotate`-style flow: rewrite the file
      // to a single fresh token (overlap+fileOnly are both gone from
      // the file). Bump mtime so the reconciler re-reads.
      const fresh = 'fresh-rotated-' + randomBytes(8).toString('hex');
      await writeFile(tokPath, `${fresh}\n`, { mode: 0o600 });
      const later = new Date(Date.now() + 60_000);
      await utimes(tokPath, later, later);

      // verifyToken triggers reconcileFileTokens. Pre-r31-14: overlap
      // gets revoked because it disappeared from `auth.token` and
      // config provenance was unknown. Post-r31-14: overlap stays
      // valid because it's still pinned by config.
      expect(verifyToken(overlap, tokens)).toBe(true);
      // The file-only token, with no config backing, IS revoked.
      expect(verifyToken(fileOnly, tokens)).toBe(false);
      // The new file-derived token took effect.
      expect(verifyToken(fresh, tokens)).toBe(true);
    });

    it('rotateToken does NOT revoke a config-pinned token even when it was previously also in auth.token', async () => {
      const tokPath = join(tempDir, 'auth.token');
      const overlap = 'overlap-rot-' + randomBytes(8).toString('hex');
      // Overlap shape: same value in BOTH config and file.
      await writeFile(tokPath, `${overlap}\n`, { mode: 0o600 });
      const tokens = await loadTokens({ tokens: [overlap] });

      const fresh = await rotateToken(tokens);
      // contract:
      //   - the rotation introduced a new file-derived token
      //   - the overlap token survives because config still pins it
      //     (pre-fix this assertion FAILED — overlap was removed from
      //     `validTokens` because reconcileFileTokens couldn't see
      //     that config also wanted it).
      expect(tokens.has(fresh)).toBe(true);
      expect(tokens.has(overlap), 'config-pinned token must survive rotate').toBe(true);

      // Re-rotating once more must STILL preserve the config token —
      // this catches a subtle bug where the rotation loses the
      // configTokens snapshot after the first rotate (the post-rotate
      // re-seed step).
      const fresh2 = await rotateToken(tokens);
      expect(tokens.has(fresh)).toBe(false);
      expect(tokens.has(fresh2)).toBe(true);
      expect(tokens.has(overlap), 'config-pinned token must survive successive rotates').toBe(true);
    });

    it('revokeToken ENOENT branch preserves config-pinned tokens that ALSO appeared in auth.token (overlap shape)', async () => {
      const tokPath = join(tempDir, 'auth.token');
      const overlap = 'enoent-overlap-' + randomBytes(8).toString('hex');
      const fileOnly = 'enoent-file-only-' + randomBytes(8).toString('hex');
      await writeFile(tokPath, `${overlap}\n${fileOnly}\n`, { mode: 0o600 });

      const tokens = await loadTokens({ tokens: [overlap] });
      expect(tokens.has(overlap)).toBe(true);
      expect(tokens.has(fileOnly)).toBe(true);

      // File vanishes (rm + race, common during `dkg auth wipe`).
      await unlink(tokPath);

      // Operator revokes the file-only token. the ENOENT
      // path bulk-revoked snapshot.fileTokens, which included
      // `overlap` because it was present on disk too — the
      // configured admin credential was silently nuked. Post-r31-14
      // the bulk-revoke loop skips entries that are also config-
      // pinned.
      expect(await revokeToken(fileOnly, tokens)).toBe(true);
      expect(tokens.has(fileOnly), 'file-only token must be revoked').toBe(false);
      expect(tokens.has(overlap), 'config-pinned overlap must survive ENOENT cascade').toBe(true);
    });

    it('revokeToken explicitly targeting a config-pinned token still removes it (operator intent overrides provenance)', async () => {
      const tokPath = join(tempDir, 'auth.token');
      const configPinned = 'explicit-config-' + randomBytes(8).toString('hex');
      await writeFile(tokPath, `${configPinned}\n`, { mode: 0o600 });

      const tokens = await loadTokens({ tokens: [configPinned] });
      await unlink(tokPath);

      // Operator explicitly asks: kill THIS token. Provenance does
      // not matter — operator intent wins. the
      // belt-and-suspenders `validTokens.delete(token)` at the end
      // of the ENOENT branch ensures the explicitly-named target is
      // always removed, even if it's config-pinned.
      expect(await revokeToken(configPinned, tokens)).toBe(true);
      expect(tokens.has(configPinned)).toBe(false);
    });

    it('rotateToken on a SET that has only config-pinned tokens (no file overlap) leaves them alone', async () => {
      // No `auth.token` file at start. loadTokens auto-creates one
      // because the in-memory set was empty after consuming config.
      // Wait — actually, a config token DOES count, so loadTokens
      // does NOT auto-generate. Verify by snapshotting the file.
      const tokPath = join(tempDir, 'auth.token');
      const configOnly = 'cfg-only-' + randomBytes(8).toString('hex');
      const tokens = await loadTokens({ tokens: [configOnly] });
      expect(tokens.has(configOnly)).toBe(true);

      // Now rotate. The config token MUST survive even though it has
      // never been in `auth.token` (no overlap, pure config provenance).
      const fresh = await rotateToken(tokens);
      expect(tokens.has(fresh)).toBe(true);
      expect(tokens.has(configOnly), 'pure-config token must survive rotate').toBe(true);
      // The new file contains only the rotated token (config tokens
      // are NOT persisted to disk on rotate — they live in config).
      const after = await readFile(tokPath, 'utf-8');
      expect(after).toContain(fresh);
      expect(after).not.toContain(configOnly);
    });
  });

  it('revokeToken on a config-pinned (non-file) token leaves the file alone', async () => {
    const fileToken = 'file-tok-' + randomBytes(8).toString('hex');
    const tokPath = join(tempDir, 'auth.token');
    await writeFile(tokPath, `${fileToken}\n`, { mode: 0o600 });
    const tokens = await loadTokens({ tokens: ['config-only-token'] });
    const before = await readFile(tokPath, 'utf-8');

    expect(await revokeToken('config-only-token', tokens)).toBe(true);
    expect(tokens.has('config-only-token')).toBe(false);

    // File untouched — the revoked token was not file-backed, so we
    // must not have rewritten anything.
    const after = await readFile(tokPath, 'utf-8');
    expect(after).toBe(before);
    // The file token survives.
    expect(tokens.has(fileToken)).toBe(true);
  });

  it('revokeToken returns false (and does not touch the file) when the token was never registered', async () => {
    const fileToken = 'file-tok-' + randomBytes(8).toString('hex');
    const tokPath = join(tempDir, 'auth.token');
    await writeFile(tokPath, `${fileToken}\n`, { mode: 0o600 });
    const tokens = await loadTokens();
    const before = await readFile(tokPath, 'utf-8');

    expect(await revokeToken('never-was-a-real-token', tokens)).toBe(false);
    const after = await readFile(tokPath, 'utf-8');
    expect(after).toBe(before);
    // Original file token still valid.
    expect(tokens.has(fileToken)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // — auth.ts:315). The earlier r19-4
  // ENOENT branch handled "file vanished mid-revoke" by:
  //
  //   - removing ONLY the requested token from the in-memory set
  //   - then DROPPING the snapshot
  //
  // That sequence broke a critical invariant: if the file used to
  // back N tokens (`A` and `B`), and the file is gone, then on the
  // next `verifyToken(B)` call `reconcileFileTokens()` would take the
  // ENOENT branch, look up the snapshot, find it missing, and skip
  // the per-fileToken revoke loop. `B` therefore stays valid forever
  // even though its source-of-truth file is gone.
  //
  // The fix in this round eagerly revokes EVERY token in the
  // surviving snapshot when the ENOENT branch fires. The two tests
  // below pin both ends:
  //   1. a sibling file-backed token is revoked alongside the
  //      explicitly-revoked one
  //   2. `verifyToken()` on the sibling reflects the revocation on
  //      the very next call (no stale-survival window)
  // ---------------------------------------------------------------------------
  it('revokeToken ENOENT branch eagerly revokes ALL file-backed tokens (no orphan stays valid)', async () => {
    const { verifyToken } = await import('../src/auth.js');
    const tokenA = 'enoent-orphan-a-' + randomBytes(8).toString('hex');
    const tokenB = 'enoent-orphan-b-' + randomBytes(8).toString('hex');
    const tokenC = 'enoent-orphan-c-' + randomBytes(8).toString('hex');
    const tokPath = join(tempDir, 'auth.token');
    await writeFile(tokPath, `${tokenA}\n${tokenB}\n${tokenC}\n`, { mode: 0o600 });

    const tokens = await loadTokens();
    expect(tokens.has(tokenA)).toBe(true);
    expect(tokens.has(tokenB)).toBe(true);
    expect(tokens.has(tokenC)).toBe(true);

    // Race the file-vanish-then-revoke sequence by deleting the file
    // FIRST (simulating an external `rm` between snapshot and
    // revokeToken).
    await unlink(tokPath);

    // Revoke A. Pre-fix: only A removed, B+C stay valid forever.
    // Post-fix: A, B, C all removed because the file (their source of
    // truth) is gone.
    expect(await revokeToken(tokenA, tokens)).toBe(true);
    expect(tokens.has(tokenA), 'A must be revoked').toBe(false);
    expect(tokens.has(tokenB), 'B must be revoked too — its file is gone').toBe(false);
    expect(tokens.has(tokenC), 'C must be revoked too — its file is gone').toBe(false);

    // Cross-check via verifyToken: every subsequent request that
    // arrives with B or C MUST be rejected. This is the bug that the
    // pre-fix code shipped with — verifyToken would happily accept B
    // because reconcileFileTokens had no snapshot to subtract from.
    expect(verifyToken(tokenA, tokens)).toBe(false);
    expect(verifyToken(tokenB, tokens)).toBe(false);
    expect(verifyToken(tokenC, tokens)).toBe(false);
  });

  it('revokeToken ENOENT branch is idempotent (second call returns false, set stays empty)', async () => {
    const tokenA = 'enoent-idem-a-' + randomBytes(8).toString('hex');
    const tokenB = 'enoent-idem-b-' + randomBytes(8).toString('hex');
    const tokPath = join(tempDir, 'auth.token');
    await writeFile(tokPath, `${tokenA}\n${tokenB}\n`, { mode: 0o600 });

    const tokens = await loadTokens();
    await unlink(tokPath);

    // First revoke clears both A and B (and returns true because
    // SOMETHING was removed). Subsequent calls have nothing to do
    // and must return false without throwing.
    expect(await revokeToken(tokenA, tokens)).toBe(true);
    expect(tokens.size).toBe(0);
    expect(await revokeToken(tokenB, tokens)).toBe(false);
    expect(await revokeToken(tokenA, tokens)).toBe(false);
    expect(await revokeToken('never-existed-' + randomBytes(4).toString('hex'), tokens)).toBe(false);
  });

  it('ENOENT eager-revoke does NOT touch config-pinned tokens (only file-backed ones get cleaned)', async () => {
    const fileTok = 'enoent-mixed-file-' + randomBytes(8).toString('hex');
    const configTok = 'enoent-mixed-config-' + randomBytes(8).toString('hex');
    const tokPath = join(tempDir, 'auth.token');
    await writeFile(tokPath, `${fileTok}\n`, { mode: 0o600 });

    // Mix: one file-backed, one config-pinned. Loader merges both.
    const tokens = await loadTokens({ tokens: [configTok] });
    expect(tokens.has(fileTok)).toBe(true);
    expect(tokens.has(configTok)).toBe(true);

    await unlink(tokPath);

    // Revoking the file-backed token via the ENOENT branch must
    // NOT cascade-revoke the config-pinned one — config-pinned
    // tokens have a different lifecycle (they're authoritative
    // until explicitly revoked or the process restarts).
    expect(await revokeToken(fileTok, tokens)).toBe(true);
    expect(tokens.has(fileTok)).toBe(false);
    expect(tokens.has(configTok), 'config-pinned token must survive ENOENT cascade').toBe(true);
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

  // Coarse-mtime filesystems
  // (HFS+ 1s, some SMB mounts, certain CI tmpfs) re-use the same mtime
  // tick on quick rewrites. `loadTokens` creates `auth.token` with a
  // 64-byte hex token; a rotation replaces it with ANOTHER 64-byte hex
  // token — same size, same second. The prior `{mtimeMs, size}` fast
  // path would then skip the hash-and-reload step entirely, leaving
  // the old token valid. Pin that the new file contents win regardless
  // of the stat sidecar.
  it('verifyToken hot-reloads even when the new token has the same size AND the same mtime', async () => {
    const { verifyToken } = await import('../src/auth.js');
    const tokens = await loadTokens();
    const [original] = [...tokens];
    const tokPath = join(tempDir, 'auth.token');

    // Snapshot the current mtime so we can pin the rewritten file to
    // the exact same tick (simulating coarse-mtime filesystems).
    const { statSync } = await import('node:fs');
    const originalStat = statSync(tokPath);
    const frozenMtime = new Date(originalStat.mtimeMs);

    // Same file shape (`# comment\n<64-hex-char>\n`) → same size.
    const sameSizeToken = 'a'.repeat(64);
    const header = '# DKG node API token — treat this like a password';
    await writeFile(tokPath, `${header}\n${sameSizeToken}\n`);
    await utimes(tokPath, frozenMtime, frozenMtime);

    // Hash-on-every-read means the new token takes effect immediately.
    expect(verifyToken(sameSizeToken, tokens)).toBe(true);
    expect(verifyToken(original, tokens)).toBe(false);
  });

  it('verifyToken revokes the last file-derived token when auth.token is deleted (ENOENT)', async () => {
    const { verifyToken } = await import('../src/auth.js');
    const tokens = await loadTokens();
    const [original] = [...tokens];
    expect(verifyToken(original, tokens)).toBe(true);

    await unlink(join(tempDir, 'auth.token'));

    // Previous revision returned silently on ENOENT so the stale token
    // stayed hot forever. Deletion is now a revocation signal.
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

  it('does NOT reject legitimate duplicate body-less POST retries', async () => {
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
// enforceSignedRequestPostBody must reject tampered /
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
// httpAuthGuard must fail closed on signed
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

  // -------------------------------------------------------------------
  // the guard treated a
  // POST/PUT/PATCH/DELETE as body-less ONLY when the client sent an
  // explicit `Content-Length: 0`. A signed client that OMITTED
  // `Content-Length` entirely (and didn't use Transfer-Encoding:
  // chunked) bypassed the synchronous HMAC check — the guard fell
  // through to the deferred `verifyHttpSignedRequestAfterBody` hook
  // that `readBodyOrNull()` is supposed to fire, but auth-gated
  // *empty-body* routes like `POST /api/local-agent-integrations/:id/refresh`
  // never call `readBody*()`. Net effect: any `x-dkg-signature` was
  // silently accepted for those routes.
  //
  // These tests pin the fix by crafting raw HTTP/1.1 requests with
  // no `Content-Length` and no `Transfer-Encoding` — per RFC 9112
  // §6.3 that framing unambiguously means "zero-body", so the guard
  // MUST verify the HMAC synchronously and reject a tampered one.
  // -------------------------------------------------------------------

  function sendRawHttp(
    port: number,
    rawRequest: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(port, '127.0.0.1');
      let chunks = '';
      sock.once('error', reject);
      sock.on('data', (b) => { chunks += b.toString('utf8'); });
      sock.on('end', () => {
        const headerEnd = chunks.indexOf('\r\n\r\n');
        const statusLine = chunks.slice(0, chunks.indexOf('\r\n'));
        const body = headerEnd >= 0 ? chunks.slice(headerEnd + 4) : '';
        const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
        resolve({ status: m ? Number(m[1]) : 0, body });
      });
      sock.on('close', () => {
        if (!chunks) resolve({ status: 0, body: '' });
      });
      sock.write(rawRequest);
    });
  }

  it('rejects a signed body-less POST with a tampered signature even when Content-Length is OMITTED', async () => {
    // This test would PASS pre-r19-1 — because the guard silently
    // waved the request through to the deferred hook, and a handler
    // that doesn't read the body never fires the deferred verify.
    // Under r19-1 the guard MUST surface the bad HMAC with 401.
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const { hostname, port } = new URL(baseUrl);
    const rawReq =
      `POST /api/agents HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      `Authorization: Bearer ${VALID}\r\n` +
      `x-dkg-timestamp: ${ts}\r\n` +
      `x-dkg-nonce: ${nonce}\r\n` +
      `x-dkg-signature: ${'aa'.repeat(32)}\r\n` +
      `Connection: close\r\n` +
      `\r\n`;
    const res = await sendRawHttp(Number(port), rawReq);
    expect(res.status).toBe(401);
    expect(handlerCallCount).toBe(0);
  });

  it('accepts a correctly-signed body-less POST with no Content-Length (verifier binds to empty body)', async () => {
    // Positive control: a client that correctly signs the empty
    // body MUST still pass, and the route handler MUST fire exactly
    // once. This locks that the fix doesn't over-reject — only the
    // "missing framing + tampered HMAC" combo is blocked.
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const goodSig = sigFor(VALID, 'POST', '/api/agents', ts, nonce, '');
    const { hostname, port } = new URL(baseUrl);
    const rawReq =
      `POST /api/agents HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      `Authorization: Bearer ${VALID}\r\n` +
      `x-dkg-timestamp: ${ts}\r\n` +
      `x-dkg-nonce: ${nonce}\r\n` +
      `x-dkg-signature: ${goodSig}\r\n` +
      `Connection: close\r\n` +
      `\r\n`;
    const res = await sendRawHttp(Number(port), rawReq);
    expect(res.status).toBe(200);
    expect(handlerCallCount).toBe(1);
  });

  it('rejects a signed body-less DELETE with a tampered signature when Content-Length is OMITTED', async () => {
    // Same attack shape as the POST case but on DELETE — which
    // round-7 explicitly removed from the "definitely body-less"
    // short-circuit because DELETE *can* carry a body. Here there
    // is no body and no framing, so it must be treated as zero-body
    // and verified synchronously.
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const { hostname, port } = new URL(baseUrl);
    const rawReq =
      `DELETE /api/agents HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      `Authorization: Bearer ${VALID}\r\n` +
      `x-dkg-timestamp: ${ts}\r\n` +
      `x-dkg-nonce: ${nonce}\r\n` +
      `x-dkg-signature: ${'bb'.repeat(32)}\r\n` +
      `Connection: close\r\n` +
      `\r\n`;
    const res = await sendRawHttp(Number(port), rawReq);
    expect(res.status).toBe(401);
    expect(handlerCallCount).toBe(0);
  });

  it('+ r25-2: a chunked POST with a TAMPERED signature whose handler IGNORES the body is fail-closed to 401', async () => {
    // The chunked
    // path used to be described as "caller's responsibility to read
    // the body — the deferred verify runs when the handler reads
    // the body". That let a signed request with
    // `Transfer-Encoding: chunked` + empty body bypass HMAC
    // verification on any handler that DOESN'T read the body
    // (for example `POST /api/local-agent-integrations/:id/refresh`).
    // The bearer token alone was enough, any `x-dkg-signature`
    // value was accepted.
    //
    // the guard installs a response-level fail-closed
    // wrapper on `res.writeHead`/`res.end`: if the handler tries
    // to emit ANY response while `__dkgSignedAuth.verified` is
    // still false, the wrapper rewrites the status to 401 and
    // the original body is never sent.
    //
    // r23-1 as originally
    // shipped was overcautious: a LEGITIMATE chunked empty-body
    // POST whose HMAC binds cleanly to `""` was ALSO 401'd,
    // because the guard didn't try the empty-body verification
    // before failing closed. We split the test: a TAMPERED
    // signature still 401s (this test), while the separate r25-2
    // test below asserts that a correctly-signed empty-body
    // chunked POST passes.
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const forgedSig = 'dead'.repeat(16);
    const { hostname, port } = new URL(baseUrl);
    const rawReq =
      `POST /api/agents HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      `Authorization: Bearer ${VALID}\r\n` +
      `Transfer-Encoding: chunked\r\n` +
      `x-dkg-timestamp: ${ts}\r\n` +
      `x-dkg-nonce: ${nonce}\r\n` +
      `x-dkg-signature: ${forgedSig}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      `0\r\n\r\n`;
    const res = await sendRawHttp(Number(port), rawReq);
    expect(res.status).toBe(401);
  });

  it('a body-carrying POST with `Transfer-Encoding: gzip, chunked` (comma-list) is NOT short-circuited as zero-body — tampered body still 401s', async () => {
    // The pre-fix
    // chunked check did `req.headers['transfer-encoding'] === 'chunked'`,
    // which Node only satisfies when the wire header is the EXACT
    // lowercase string "chunked". A signed client could ship
    // `Transfer-Encoding: gzip, chunked` (or `Chunked` / a duplicate
    // TE header that Node surfaces as an array) and slip into the
    // `isZeroBody` fast path — `verifyHttpSignedRequestAfterBody(req, '')`
    // would then bind the HMAC to an empty string and flip
    // `pending.verified = true` BEFORE the actual body bytes were
    // read. With a valid bearer token an attacker could PUT/POST
    // arbitrary bytes against any signed route.
    //
    // we share the parsing rule with `isFramingBodylessByHeaders`
    // (case-insensitive `/chunked/i.test(joined)`), so the comma-list
    // shape is correctly classified as "body-carrying chunked" and
    // the request flows through the deferred drain-and-verify guard.
    // A tampered signature against a non-empty body is therefore
    // fail-closed to 401 — the test below would have returned 200
    // against the pre-fix code.
    const body = 'attacker-payload';
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const tamperedSig = 'dead'.repeat(16);
    const { hostname, port } = new URL(baseUrl);
    const chunkHex = Buffer.byteLength(body).toString(16);
    const rawReq =
      `POST /api/agents HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      `Authorization: Bearer ${VALID}\r\n` +
      `Transfer-Encoding: gzip, chunked\r\n` +
      `x-dkg-timestamp: ${ts}\r\n` +
      `x-dkg-nonce: ${nonce}\r\n` +
      `x-dkg-signature: ${tamperedSig}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      `${chunkHex}\r\n${body}\r\n0\r\n\r\n`;
    const res = await sendRawHttp(Number(port), rawReq);
    expect(res.status).toBe(401);
  });

  it('a body-carrying POST with `Transfer-Encoding: Chunked` (mixed-case) is NOT short-circuited as zero-body', async () => {
    // Same r28 fix as above: the strict lowercase comparison missed
    // `Chunked` / `CHUNKED`. Even though most HTTP libraries
    // lowercase the header before exposing it, the auth path must
    // not rely on it because `req.headers['transfer-encoding']`
    // surfaces whatever case Node's parser preserved (and a custom
    // socket-level client can send anything). Confirm a tampered
    // signature with mixed-case TE is fail-closed to 401.
    const body = 'attacker-payload-mixed-case';
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const tamperedSig = 'beef'.repeat(16);
    const { hostname, port } = new URL(baseUrl);
    const chunkHex = Buffer.byteLength(body).toString(16);
    const rawReq =
      `POST /api/agents HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      `Authorization: Bearer ${VALID}\r\n` +
      `Transfer-Encoding: Chunked\r\n` +
      `x-dkg-timestamp: ${ts}\r\n` +
      `x-dkg-nonce: ${nonce}\r\n` +
      `x-dkg-signature: ${tamperedSig}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      `${chunkHex}\r\n${body}\r\n0\r\n\r\n`;
    const res = await sendRawHttp(Number(port), rawReq);
    expect(res.status).toBe(401);
  });

  it('a chunked POST with a CORRECTLY-signed empty body whose handler IGNORES the body returns 200 (not 401)', async () => {
    // The r23-1
    // response-guard unconditionally 401'd any chunked request whose
    // handler didn't call readBody*(), even when the signature
    // verified cleanly against the empty body that actually arrived
    // on the wire. A legitimate client calling e.g.
    // `POST /api/local-agent-integrations/:id/refresh` with a
    // refresh-style empty chunked body was therefore rejected.
    //
    // Fix: when the guard is about to fail closed, first check
    // whether the request body actually ended empty (parser
    // complete, zero bytes observed). If so verify the HMAC
    // against `""` and pass through if it matches.
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const goodSig = sigFor(VALID, 'POST', '/api/agents', ts, nonce, '');
    const { hostname, port } = new URL(baseUrl);
    const rawReq =
      `POST /api/agents HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      `Authorization: Bearer ${VALID}\r\n` +
      `Transfer-Encoding: chunked\r\n` +
      `x-dkg-timestamp: ${ts}\r\n` +
      `x-dkg-nonce: ${nonce}\r\n` +
      `x-dkg-signature: ${goodSig}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      `0\r\n\r\n`;
    const res = await sendRawHttp(Number(port), rawReq);
    expect(res.status).toBe(200);
  });

  it('a chunked POST with a CORRECTLY-signed NON-EMPTY body whose handler IGNORES the body returns 200 (guard drains-and-verifies)', async () => {
    // the response guard drains whatever body the wire
    // actually delivered and runs the full HMAC verification bound
    // to that payload. A genuine signature over a non-empty body
    // is therefore accepted even when the route handler chose to
    // ignore the body — the HMAC still attests to the sender's
    // identity and the exact method/path/timestamp/nonce/body
    // combination, so there is no security reason to 401 it. The
    // tampered-body variant below pins the negative case.
    const body = 'legitimately-signed-but-handler-ignored';
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const goodSig = sigFor(VALID, 'POST', '/api/agents', ts, nonce, body);
    const { hostname, port } = new URL(baseUrl);
    const chunkHex = Buffer.byteLength(body).toString(16);
    const rawReq =
      `POST /api/agents HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      `Authorization: Bearer ${VALID}\r\n` +
      `Transfer-Encoding: chunked\r\n` +
      `x-dkg-timestamp: ${ts}\r\n` +
      `x-dkg-nonce: ${nonce}\r\n` +
      `x-dkg-signature: ${goodSig}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      `${chunkHex}\r\n${body}\r\n` +
      `0\r\n\r\n`;
    const res = await sendRawHttp(Number(port), rawReq);
    expect(res.status).toBe(200);
  });

  it('a chunked POST with a TAMPERED non-empty body still fails closed to 401 after drain-and-verify', async () => {
    // Sign for "intended-body", wire "tampered-body". The guard
    // drains the wire payload, runs verifyHttpSignedRequestAfterBody
    // against those bytes, sees the HMAC mismatch, and emits 401.
    const signedBody = 'intended-body';
    const wireBody = 'tampered-body-wire';
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const sig = sigFor(VALID, 'POST', '/api/agents', ts, nonce, signedBody);
    const { hostname, port } = new URL(baseUrl);
    const chunkHex = Buffer.byteLength(wireBody).toString(16);
    const rawReq =
      `POST /api/agents HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      `Authorization: Bearer ${VALID}\r\n` +
      `Transfer-Encoding: chunked\r\n` +
      `x-dkg-timestamp: ${ts}\r\n` +
      `x-dkg-nonce: ${nonce}\r\n` +
      `x-dkg-signature: ${sig}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      `${chunkHex}\r\n${wireBody}\r\n` +
      `0\r\n\r\n`;
    const res = await sendRawHttp(Number(port), rawReq);
    expect(res.status).toBe(401);
  });

  it('+ r25-2: a signed POST with Content-Length > 0 and a TAMPERED signature is fail-closed to 401 after drain-and-verify', async () => {
    // the guard drains the wire body and runs the full
    // HMAC verification against it. A tampered/forged signature
    // cannot match the drained bytes, so the route handler's
    // intended response is replaced with 401. This preserves the
    // r23-1 wire-level fail-closed contract without false-positive
    // 401s on legitimate signed bodies (see the sibling r25-2
    // NON-EMPTY-body test which is now asserted to pass with 200).
    const body = 'ignored-by-handler';
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const forgedSig = 'beef'.repeat(16);
    const { hostname, port } = new URL(baseUrl);
    const rawReq =
      `POST /api/agents HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      `Authorization: Bearer ${VALID}\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `x-dkg-timestamp: ${ts}\r\n` +
      `x-dkg-nonce: ${nonce}\r\n` +
      `x-dkg-signature: ${forgedSig}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      body;
    const res = await sendRawHttp(Number(port), rawReq);
    expect(res.status).toBe(401);
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

  // -------------------------------------------------------------
  //
  // The original `tryPassiveEmptyBodyVerification` accepted on
  // `req.complete && drainedBytes === 0`, which is satisfiable by a
  // *non-empty* `Content-Length` body that the parser had already
  // buffered before the handler emitted its writeHead. That bound
  // the HMAC to `""` and let a tampered body slip past auth on any
  // route whose handler ignored the body.
  //
  // The fix gates the fast path on the request's *header framing*
  // (only Content-Length:0 OR no CL+no chunked qualifies). For a
  // Content-Length>0 body whose handler ignores the body, the guard
  // must now drain → verify the actual bytes → 401 on mismatch.
  // -------------------------------------------------------------
  it('signed POST with Content-Length>0 + tampered sig + IGNORED body returns 401 (not silently 200)', async () => {
    // The body the handler ignores. Pre-fix the empty-body fast path
    // would have accepted a tampered signature because it never read
    // these bytes.
    const wireBody = '{"tampered":true}';
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    // Signature is COMPLETELY UNRELATED to the wire body. Pre-fix the
    // guard would have bound this to `""` (because drainedBytes was
    // 0 when writeHead fired) and verified against the empty-body
    // canonical string — which the attacker can also produce. The
    // post-fix guard drains the wire bytes and verifies against
    // those, surfacing the mismatch.
    const forgedSig = 'beef'.repeat(16);
    const { hostname, port } = new URL(baseUrl);
    const rawReq =
      `POST /api/agents HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      `Authorization: Bearer ${VALID}\r\n` +
      `Content-Length: ${Buffer.byteLength(wireBody)}\r\n` +
      `x-dkg-timestamp: ${ts}\r\n` +
      `x-dkg-nonce: ${nonce}\r\n` +
      `x-dkg-signature: ${forgedSig}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      wireBody;
    const res = await sendRawHttp(Number(port), rawReq);
    expect(res.status).toBe(401);
    // The 401 must come from the response-guard rewrite (not from the
    // route handler succeeding) — its body identifies the rejection.
    expect(res.body.toLowerCase()).toContain('signed request rejected');
    expect(res.body).not.toContain('"ok":true');
  });

  // -------------------------------------------------------------
  // — auth.ts:1205). The previous
  // `waitForRequestEnd()` had `if (req.complete || req.readableEnded)
  // resolve()` as a fast-path. `req.complete === true` only means
  // the HTTP parser has finished reading the body off the socket —
  // buffered body bytes can still be sitting in IncomingMessage's
  // internal read buffer waiting for `resume()` to flow them
  // through `data` listeners. The deferred branch, when it called
  // `attachDrainListeners()` AFTER parser completion, never received
  // those buffered chunks because the `resume()` call was skipped
  // by the early return. So `Buffer.concat(drainedChunks)` was
  // empty and the HMAC was bound to `""` — re-opening the body-
  // binding bypass for handlers that ignore the body.
  //
  // Fix: only fast-path on `readableEnded === true` (which means
  // 'end' has already fired AND consumers have read all data); for
  // `complete && !readableEnded` we ALWAYS call `resume()` and
  // await the real 'end' event so buffered bytes flush through
  // our `data` listener and `drainedChunks` reflects the true
  // wire body.
  // -------------------------------------------------------------
  it('signed POST whose body fits in the TCP segment alongside headers (parser completes pre-handler) — tampered body is fail-closed to 401', async () => {
    // Sign the EMPTY body. Send Content-Length>0 with a different
    // payload so the wire body diverges from what the signature
    // attests to. With the headers + body in one socket write the
    // server is most likely to set `req.complete = true` before the
    // route handler runs — the precise window the previous fast-path
    // mishandled.
    const wireBody = '{"tampered":1}';
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    // CORRECT signature for the EMPTY body — the attacker's lure.
    const sigForEmpty = sigFor(VALID, 'POST', '/api/agents', ts, nonce, '');
    const { hostname, port } = new URL(baseUrl);
    const rawReq =
      `POST /api/agents HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      `Authorization: Bearer ${VALID}\r\n` +
      `Content-Length: ${Buffer.byteLength(wireBody)}\r\n` +
      `x-dkg-timestamp: ${ts}\r\n` +
      `x-dkg-nonce: ${nonce}\r\n` +
      `x-dkg-signature: ${sigForEmpty}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      wireBody;
    const res = await sendRawHttp(Number(port), rawReq);
    // Pre-fix this would have been 200 — the empty-body signature
    // matched an empty `Buffer.concat(drainedChunks)` because the
    // `complete` fast-path skipped `resume()` and the buffered
    // wireBody never flowed through our `data` listener.
    expect(res.status).toBe(401);
    expect(res.body.toLowerCase()).toContain('signed request rejected');
    expect(res.body).not.toContain('"ok":true');
  });

  // -----------------------------------------------------------------
  // auth.ts:1202).
  //
  // Pre-fix `waitForRequestEnd` had no deadline. A signed request that
  // declared `Transfer-Encoding: chunked` and never sent the
  // terminating `0\r\n\r\n` would keep the queued response and the
  // socket pinned forever — a slowloris / FD-exhaustion vector against
  // any auth-gated route that does not call `readBody*()` itself.
  //
  // Post-fix: race against `DKG_SIGNED_REQUEST_DRAIN_TIMEOUT_MS` (1s in
  // these tests for fast turn-around), destroy the request on expiry,
  // fail-closed to 401. This test sets a tiny env override and sends a
  // chunked body that NEVER terminates; the response must be 401
  // strictly within `5x` the deadline (the 5x is for CI noise tolerance).
  // -----------------------------------------------------------------
  it('signed request whose body never ends (chunked slowloris) is fail-closed within the drain deadline', async () => {
    // Spin up an isolated server with a short drain budget. We use a
    // process-env override (the production code reads
    // `DKG_SIGNED_REQUEST_DRAIN_TIMEOUT_MS` once per `httpAuthGuard`
    // closure) so this test stays self-contained.
    const prevTimeout = process.env.DKG_SIGNED_REQUEST_DRAIN_TIMEOUT_MS;
    process.env.DKG_SIGNED_REQUEST_DRAIN_TIMEOUT_MS = '300';
    const slowServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Handler does NOT read the body — that's the precondition for
      // the deferred drain path to engage.
      if (!httpAuthGuard(req, res, true, validTokens, null)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(r => slowServer.listen(0, '127.0.0.1', r));
    try {
      const port = (slowServer.address() as { port: number }).port;
      const ts = String(Date.now());
      const nonce = `n-${randomBytes(8).toString('hex')}`;
      // Sign the empty body so the framing-bodyless fast-path is
      // disabled (we declare chunked in the request) and the deferred
      // drain MUST run.
      const sigForEmpty = sigFor(VALID, 'POST', '/api/agents', ts, nonce, '');
      // Build a chunked request whose body never terminates: send one
      // valid chunk header + one byte of payload, then stop. No
      // `0\r\n\r\n` terminator is sent, so Node's HTTP parser will
      // wait forever for the next chunk.
      const headers =
        `POST /api/agents HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Authorization: Bearer ${VALID}\r\n` +
        `Transfer-Encoding: chunked\r\n` +
        `x-dkg-timestamp: ${ts}\r\n` +
        `x-dkg-nonce: ${nonce}\r\n` +
        `x-dkg-signature: ${sigForEmpty}\r\n` +
        `Connection: close\r\n` +
        `\r\n` +
        `1\r\n` + // chunk length: 1 byte
        `X` +     // 1 byte of payload
        // INTENTIONALLY no `\r\n0\r\n\r\n` terminator — slowloris.
        ``;

      const t0 = Date.now();
      const result = await new Promise<{ status: number; body: string; elapsedMs: number }>((resolve, reject) => {
        const sock = createConnection(port, '127.0.0.1');
        let chunks = '';
        const ko = setTimeout(() => {
          // Hard upper bound: if the server fails to respond within 5s
          // the test fails (would have been "forever" pre-fix).
          sock.destroy();
          reject(new Error('server did not respond within hard deadline (slowloris fix regression)'));
        }, 5000);
        sock.once('error', (err) => { clearTimeout(ko); reject(err); });
        sock.on('data', (b) => { chunks += b.toString('utf8'); });
        sock.on('end', () => {
          clearTimeout(ko);
          const headerEnd = chunks.indexOf('\r\n\r\n');
          const statusLine = chunks.slice(0, chunks.indexOf('\r\n'));
          const body = headerEnd >= 0 ? chunks.slice(headerEnd + 4) : '';
          const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
          resolve({ status: m ? Number(m[1]) : 0, body, elapsedMs: Date.now() - t0 });
        });
        sock.on('close', () => {
          clearTimeout(ko);
          if (!chunks) resolve({ status: 0, body: '', elapsedMs: Date.now() - t0 });
        });
        sock.write(headers);
      });

      // The deferred-drain race must surface a 401 (fail-closed),
      // and it must do so close to the drain deadline (300ms +
      // CI overhead) — definitely well below the 5s hard deadline.
      expect(result.status).toBe(401);
      expect(result.body.toLowerCase()).toMatch(/signed request rejected.*drain timed out|signed request rejected/);
      expect(result.elapsedMs).toBeLessThan(2500);
    } finally {
      await new Promise<void>(r => slowServer.close(() => r()));
      if (prevTimeout === undefined) {
        delete process.env.DKG_SIGNED_REQUEST_DRAIN_TIMEOUT_MS;
      } else {
        process.env.DKG_SIGNED_REQUEST_DRAIN_TIMEOUT_MS = prevTimeout;
      }
    }
  });

  it('legitimate slow-but-completing chunked request still succeeds (timeout does not kill honest clients)', async () => {
    // Counterpoint: if the body DOES terminate before the deadline,
    // the request must succeed. Honest mobile / lossy-link clients
    // commonly emit chunked bodies with a few hundred ms of inter-
    // chunk delay; the timeout must not turn them into 401s.
    const prevTimeout = process.env.DKG_SIGNED_REQUEST_DRAIN_TIMEOUT_MS;
    process.env.DKG_SIGNED_REQUEST_DRAIN_TIMEOUT_MS = '2000';
    const slowServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!httpAuthGuard(req, res, true, validTokens, null)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(r => slowServer.listen(0, '127.0.0.1', r));
    try {
      const port = (slowServer.address() as { port: number }).port;
      const wireBody = '{"slow":true}';
      const ts = String(Date.now());
      const nonce = `n-${randomBytes(8).toString('hex')}`;
      const goodSig = sigFor(VALID, 'POST', '/api/agents', ts, nonce, wireBody);

      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const sock = createConnection(port, '127.0.0.1');
        let chunks = '';
        const ko = setTimeout(() => { sock.destroy(); reject(new Error('hung')); }, 6000);
        sock.once('error', (err) => { clearTimeout(ko); reject(err); });
        sock.on('data', (b) => { chunks += b.toString('utf8'); });
        sock.on('end', () => {
          clearTimeout(ko);
          const headerEnd = chunks.indexOf('\r\n\r\n');
          const statusLine = chunks.slice(0, chunks.indexOf('\r\n'));
          const body = headerEnd >= 0 ? chunks.slice(headerEnd + 4) : '';
          const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
          resolve({ status: m ? Number(m[1]) : 0, body });
        });
        sock.on('close', () => { clearTimeout(ko); if (!chunks) resolve({ status: 0, body: '' }); });
        // Send headers + first chunk header, then DELAY before sending
        // the payload + terminator. Total wall time is well under the
        // 2s budget but well above zero.
        sock.write(
          `POST /api/agents HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Authorization: Bearer ${VALID}\r\n` +
          `Transfer-Encoding: chunked\r\n` +
          `x-dkg-timestamp: ${ts}\r\n` +
          `x-dkg-nonce: ${nonce}\r\n` +
          `x-dkg-signature: ${goodSig}\r\n` +
          `Connection: close\r\n` +
          `\r\n`,
        );
        setTimeout(() => {
          // Send a single chunk that contains the body, then terminate.
          const len = Buffer.byteLength(wireBody).toString(16);
          sock.write(`${len}\r\n${wireBody}\r\n0\r\n\r\n`);
        }, 250);
      });

      expect(result.status).toBe(200);
      expect(result.body).toContain('"ok":true');
    } finally {
      await new Promise<void>(r => slowServer.close(() => r()));
      if (prevTimeout === undefined) {
        delete process.env.DKG_SIGNED_REQUEST_DRAIN_TIMEOUT_MS;
      } else {
        process.env.DKG_SIGNED_REQUEST_DRAIN_TIMEOUT_MS = prevTimeout;
      }
    }
  });

  it('a sequence of independent signed POST/empty-body lures using random bodies all fail closed (no flaky timing window survives)', async () => {
    // Run the same scenario back-to-back with fresh nonces and
    // randomly-sized bodies. The previous fast-path bug was timing-
    // dependent (it only triggered when `complete` happened to be
    // true at the moment `waitForRequestEnd()` resolved), so a
    // single-shot test could easily pass spuriously even with the
    // bug present. Hammering the path with N requests probes the
    // window from multiple angles.
    const { hostname, port } = new URL(baseUrl);
    for (let i = 0; i < 8; i++) {
      const wireBody = randomBytes(16 + (i * 7) % 128).toString('hex');
      const ts = String(Date.now());
      const nonce = `n-${randomBytes(8).toString('hex')}`;
      const sigForEmpty = sigFor(VALID, 'POST', '/api/agents', ts, nonce, '');
      const rawReq =
        `POST /api/agents HTTP/1.1\r\n` +
        `Host: ${hostname}:${port}\r\n` +
        `Authorization: Bearer ${VALID}\r\n` +
        `Content-Length: ${Buffer.byteLength(wireBody)}\r\n` +
        `x-dkg-timestamp: ${ts}\r\n` +
        `x-dkg-nonce: ${nonce}\r\n` +
        `x-dkg-signature: ${sigForEmpty}\r\n` +
        `Connection: close\r\n` +
        `\r\n` +
        wireBody;
      const res = await sendRawHttp(Number(port), rawReq);
      expect(
        res.status,
        `iteration ${i}: tampered body must always be 401, got ${res.status}: ${res.body.slice(0, 200)}`,
      ).toBe(401);
    }
  });

  it('signed POST with Content-Length>0 and HONESTLY-signed body (handler ignores body) still returns 200', async () => {
    // Counterpoint: a legitimate signed body whose handler chose not
    // to read it must still pass — the drain-and-verify path is
    // expected to bind the HMAC to the actual wire bytes and pass.
    const wireBody = '{"legitimate":true}';
    const ts = String(Date.now());
    const nonce = `n-${randomBytes(8).toString('hex')}`;
    const goodSig = sigFor(VALID, 'POST', '/api/agents', ts, nonce, wireBody);
    const { hostname, port } = new URL(baseUrl);
    const rawReq =
      `POST /api/agents HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      `Authorization: Bearer ${VALID}\r\n` +
      `Content-Length: ${Buffer.byteLength(wireBody)}\r\n` +
      `x-dkg-timestamp: ${ts}\r\n` +
      `x-dkg-nonce: ${nonce}\r\n` +
      `x-dkg-signature: ${goodSig}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      wireBody;
    const res = await sendRawHttp(Number(port), rawReq);
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------
  //
  // The response guard wrapped writeHead+end but NOT res.write or
  // res.flushHeaders, so a handler calling res.write() before the
  // deferred HMAC verification finished could leak response bytes
  // to a request whose signed body had not yet been authenticated.
  // The fix wraps res.write and res.flushHeaders too: they queue
  // until verification succeeds, then replay; or get rewritten to
  // 401 on failure.
  // -------------------------------------------------------------
  it('handler that streams via res.write() with TAMPERED sig + non-empty body still 401s (no leaked bytes)', async () => {
    // Spin up a dedicated server whose handler calls res.write()
    // BEFORE res.end(), without ever calling readBody*(). Pre-fix
    // the wrap-only-writeHead/end guard would have let those
    // res.write() chunks reach the wire while the deferred drain
    // was still in flight; post-fix they're queued and the guard
    // physically rewrites the response to 401 on signature
    // mismatch.
    const writeServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!httpAuthGuard(req, res, true, validTokens, null)) return;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      // Stream-style emission: each .write() chunk MUST stay
      // queued until the HMAC has been verified against the
      // body that actually arrived on the wire.
      res.write('chunk-1\n');
      res.write('chunk-2\n');
      res.end('tail\n');
    });
    await new Promise<void>(r => writeServer.listen(0, '127.0.0.1', r));
    try {
      const port = (writeServer.address() as { port: number }).port;
      const wireBody = '{"x":1}';
      const ts = String(Date.now());
      const nonce = `n-${randomBytes(8).toString('hex')}`;
      const forgedSig = 'feed'.repeat(16);
      const rawReq =
        `POST /api/agents HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Authorization: Bearer ${VALID}\r\n` +
        `Content-Length: ${Buffer.byteLength(wireBody)}\r\n` +
        `x-dkg-timestamp: ${ts}\r\n` +
        `x-dkg-nonce: ${nonce}\r\n` +
        `x-dkg-signature: ${forgedSig}\r\n` +
        `Connection: close\r\n` +
        `\r\n` +
        wireBody;
      const res = await sendRawHttp(Number(port), rawReq);
      expect(res.status).toBe(401);
      // The 401 body is the JSON envelope from the guard — none of
      // the streamed chunks the handler tried to write must appear
      // in the response.
      expect(res.body).not.toContain('chunk-1');
      expect(res.body).not.toContain('chunk-2');
      expect(res.body).not.toContain('tail');
    } finally {
      await new Promise<void>(r => writeServer.close(() => r()));
    }
  });

  it('handler that streams via res.write() with VALID sig replays writes after verification (no truncation)', async () => {
    // Counterpoint: a correctly-signed request whose handler streams
    // via res.write must still receive the full streamed body. The
    // queued chunks are flushed in order after the deferred drain +
    // verify returns ok.
    const writeServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!httpAuthGuard(req, res, true, validTokens, null)) return;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('chunk-1\n');
      res.write('chunk-2\n');
      res.end('tail\n');
    });
    await new Promise<void>(r => writeServer.listen(0, '127.0.0.1', r));
    try {
      const port = (writeServer.address() as { port: number }).port;
      const wireBody = '{"x":1}';
      const ts = String(Date.now());
      const nonce = `n-${randomBytes(8).toString('hex')}`;
      const goodSig = sigFor(VALID, 'POST', '/api/agents', ts, nonce, wireBody);
      const rawReq =
        `POST /api/agents HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Authorization: Bearer ${VALID}\r\n` +
        `Content-Length: ${Buffer.byteLength(wireBody)}\r\n` +
        `x-dkg-timestamp: ${ts}\r\n` +
        `x-dkg-nonce: ${nonce}\r\n` +
        `x-dkg-signature: ${goodSig}\r\n` +
        `Connection: close\r\n` +
        `\r\n` +
        wireBody;
      const res = await sendRawHttp(Number(port), rawReq);
      expect(res.status).toBe(200);
      expect(res.body).toContain('chunk-1');
      expect(res.body).toContain('chunk-2');
      expect(res.body).toContain('tail');
    } finally {
      await new Promise<void>(r => writeServer.close(() => r()));
    }
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
// The pre-body replay
// check inside `httpAuthGuard` used to key on the raw nonce string
// while `verifySignedRequest` keys on `sha256(token):nonce`.
// Two different bearer credentials that reused the same nonce would
// 401 each other at the pre-body gate even though the full signed
// request would verify cleanly — exactly the cross-client
// false-positive r9-3 was meant to eliminate. These tests pin the
// parity: both gates enforce identical replay semantics.
// ---------------------------------------------------------------------------

describe('httpAuthGuard — pre-body nonce replay cache scope', () => {
  const TOK_A = 'tok-A-' + 'a'.repeat(16);
  const TOK_B = 'tok-B-' + 'b'.repeat(16);
  let server: Server;
  let baseUrl: string;
  let handlerCallCount: number;

  beforeEach(async () => {
    _clearReplayCacheForTesting();
    handlerCallCount = 0;
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!httpAuthGuard(req, res, true, new Set([TOK_A, TOK_B]), null)) return;
      handlerCallCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
  });

  function headersFor(token: string, nonce: string) {
    const ts = String(Date.now());
    const sig = sigFor(token, 'GET', '/api/agents', ts, nonce, '');
    return {
      Authorization: `Bearer ${token}`,
      'x-dkg-timestamp': ts,
      'x-dkg-nonce': nonce,
      'x-dkg-signature': sig,
    };
  }

  it('same nonce used with two DIFFERENT tokens — both succeed (no cross-client replay false-positive)', async () => {
    const sharedNonce = `shared-${randomBytes(8).toString('hex')}`;

    const r1 = await fetch(`${baseUrl}/api/agents`, {
      method: 'GET',
      headers: headersFor(TOK_A, sharedNonce),
    });
    expect(r1.status).toBe(200);

    // Second request: same nonce, different token. Pre-round-10 this
    // returned 401 "Replayed nonce" from the pre-body gate even though
    // verifySignedRequest (which is per-credential) would have verified
    // it. Post-round-10 both gates agree and the request succeeds.
    const r2 = await fetch(`${baseUrl}/api/agents`, {
      method: 'GET',
      headers: headersFor(TOK_B, sharedNonce),
    });
    expect(r2.status).toBe(200);
    expect(handlerCallCount).toBe(2);
  });

  it('same nonce used TWICE with the SAME token — second call rejected (401 replayed-nonce)', async () => {
    const nonce = `repeat-${randomBytes(8).toString('hex')}`;

    const r1 = await fetch(`${baseUrl}/api/agents`, {
      method: 'GET',
      headers: headersFor(TOK_A, nonce),
    });
    expect(r1.status).toBe(200);

    const r2 = await fetch(`${baseUrl}/api/agents`, {
      method: 'GET',
      headers: headersFor(TOK_A, nonce),
    });
    expect(r2.status).toBe(401);
    const body = await r2.json();
    expect(body.error).toMatch(/Replayed nonce|replayed-nonce/);
    expect(handlerCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// signed HMAC must bind the FULL request path
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
// strict hex validation for x-dkg-signature.
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
