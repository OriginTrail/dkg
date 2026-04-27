/**
 * Unified authentication for DKG node interfaces (HTTP API, MCP, WebSocket, etc.).
 *
 * Uses bearer tokens stored on disk. Tokens are auto-generated on first start.
 * Any interface that needs auth calls `verifyToken(token)` against the loaded set.
 */

import { randomBytes, createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dkgDir } from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthConfig {
  /** Master switch — when false, all requests are allowed (default: true). */
  enabled?: boolean;
  /** Pre-configured tokens. If empty, one is auto-generated on first start. */
  tokens?: string[];
}

// ---------------------------------------------------------------------------
// Token file management
// ---------------------------------------------------------------------------

function tokenFilePath(): string {
  return join(dkgDir(), 'auth.token');
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Load tokens from disk + config. Auto-generates a token file if none exists.
 * Returns the set of valid tokens.
 */
export async function loadTokens(authConfig?: AuthConfig): Promise<Set<string>> {
  const tokens = new Set<string>();
  const fileTokens = new Set<string>();

  // Add any config-defined tokens
  if (authConfig?.tokens) {
    for (const t of authConfig.tokens) {
      if (t.length > 0) tokens.add(t);
    }
  }

  // Load or generate the file-based token
  const filePath = tokenFilePath();
  if (existsSync(filePath)) {
    try {
      const raw = await readFile(filePath, 'utf-8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (t.length > 0 && !t.startsWith('#')) {
          tokens.add(t);
          fileTokens.add(t);
        }
      }
    } catch {
      // Unreadable — generate a fresh one
    }
  }

  if (tokens.size === 0) {
    const token = generateToken();
    tokens.add(token);
    fileTokens.add(token);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `# DKG node API token — treat this like a password\n${token}\n`, { mode: 0o600 });
    await chmod(filePath, 0o600);
  }

  // CLI-11: record the file snapshot so `verifyToken`'s mtime-gated
  // reconciliation knows which tokens originated on disk and can
  // subtract them when the file is rewritten. Without this snapshot
  // the reconciler would only ever ADD newly-discovered tokens and
  // leave stale file tokens alive forever (the very rotation bug
  // CLI-11 documents).
  try {
    const st = statSync(filePath);
    const raw = readFileSync(filePath);
    const contentHash = createHash('sha256').update(raw).digest('hex');
    lastFileSnapshot.set(tokens, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      contentHash,
      fileTokens,
    });
  } catch {
    /* file vanished mid-load — next verifyToken call will reconcile */
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Verification (interface-agnostic)
// ---------------------------------------------------------------------------

/**
 * CLI-11 (BUGS_FOUND.md dup #11/CLI-11): hot-reload reconciliation.
 *
 * The original `verifyToken` was a pure `Set.has` lookup. That meant
 * once the daemon had loaded `auth.token` at boot, *no* file rewrite
 * could ever revoke an issued token until the operator restarted the
 * process. `dkg auth rotate` (which simply rewrites the file) was a
 * quiet no-op against the running token set — the audit flagged this
 * as the spec §18 rotation gap.
 *
 * We now reconcile the in-memory `validTokens` set with the on-disk
 * `auth.token` file every time `verifyToken` runs, but only when the
 * file's size, mtime, OR content hash has changed since the last
 * reconciliation. The cost is one `statSync` per call plus a cheap
 * short-circuit on size+mtime; the sha256 is only recomputed when
 * those differ, which is in the same order of magnitude as the
 * existing `Set.has` and well below the cost of every other path
 * the daemon executes per request.
 *
 * Why not `mtimeMs` alone: on coarse filesystems (or when
 * `dkg auth rotate` runs twice in the same millisecond — rare but
 * observable in CI on fast disks) two consecutive rewrites can share
 * the same mtime, and a `stat`-only guard would silently skip the
 * second reconciliation and leave the previous token valid. Atomic
 * `rename(tmp, auth.token)` also preserves the destination mtime on
 * some platforms. Hashing the bytes closes the hole unconditionally
 * (PR #229 bot review round 6 — mtime-only rotation bypass).
 *
 * Tokens added programmatically (e.g. via the future `rotateToken`
 * API or pinned in `config.auth.tokens`) are preserved across
 * reconciliation: the algorithm compares the *file-derived* subset
 * with what's now on disk, removes the stale file tokens, and adds
 * the new ones — without touching tokens that never came from disk.
 */
const lastFileSnapshot = new WeakMap<
  Set<string>,
  { mtimeMs: number; size: number; contentHash: string; fileTokens: Set<string> }
>();

function reconcileFileTokens(validTokens: Set<string>): void {
  const filePath = tokenFilePath();
  let rawBuf: Buffer;
  let mtimeMs = -1;
  let size = -1;
  try {
    rawBuf = readFileSync(filePath);
    const st = statSync(filePath);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch (err: any) {
    // PR #229 bot review round 7 (auth.ts:162 — ENOENT path). If the
    // token file is missing AND we had previously loaded tokens from
    // it, those tokens MUST be revoked from `validTokens`: `dkg auth
    // revoke` rewrites the file to empty or deletes it, and operators
    // expect the in-memory set to follow suit. The previous revision
    // `return`ed silently on ENOENT, leaving the last file-derived
    // token valid forever.
    if (err && err.code === 'ENOENT') {
      const snapshot = lastFileSnapshot.get(validTokens);
      if (snapshot) {
        for (const oldTok of snapshot.fileTokens) validTokens.delete(oldTok);
        lastFileSnapshot.delete(validTokens);
      }
    }
    return;
  }

  // PR #229 bot review round 7 (auth.ts:162 — fast-path gap). The
  // previous revision short-circuited on matching `{mtimeMs, size}`
  // before hashing. That's unsafe on coarse-mtime filesystems (HFS+
  // 1s resolution, certain network mounts, CI tmpfs): a rotate that
  // rewrites `auth.token` with a new token of the same length within
  // the same second leaves `mtimeMs` and `size` unchanged and the
  // old token stays hot. Always hash the bytes — the file is tiny
  // (one or two lines) and hashing is O(µs).
  const contentHash = createHash('sha256').update(rawBuf).digest('hex');
  const snapshot = lastFileSnapshot.get(validTokens);
  if (snapshot && snapshot.contentHash === contentHash) {
    // Bytes unchanged — keep fileTokens, just refresh stat metadata so
    // future reads don't trip debug warnings about skew.
    if (snapshot.mtimeMs !== mtimeMs || snapshot.size !== size) {
      lastFileSnapshot.set(validTokens, {
        mtimeMs,
        size,
        contentHash,
        fileTokens: snapshot.fileTokens,
      });
    }
    return;
  }
  const newFileTokens = new Set<string>();
  for (const line of rawBuf.toString('utf-8').split('\n')) {
    const t = line.trim();
    if (t.length > 0 && !t.startsWith('#')) newFileTokens.add(t);
  }
  if (snapshot) {
    for (const oldTok of snapshot.fileTokens) {
      if (!newFileTokens.has(oldTok)) validTokens.delete(oldTok);
    }
  }
  for (const t of newFileTokens) validTokens.add(t);
  lastFileSnapshot.set(validTokens, { mtimeMs, size, contentHash, fileTokens: newFileTokens });
}

/**
 * Verify a bearer token against the loaded token set.
 * This is the single entry point any interface (HTTP, MCP, WS) should use.
 *
 * Performs an mtime-gated hot-reload of the on-disk `auth.token` file
 * on every call — see `reconcileFileTokens` above for the rationale.
 */
export function verifyToken(token: string | undefined, validTokens: Set<string>): boolean {
  if (!token) return false;
  reconcileFileTokens(validTokens);
  return validTokens.has(token);
}

// ---------------------------------------------------------------------------
// CLI-11 — programmatic rotation / revocation API
// ---------------------------------------------------------------------------

/**
 * Generate a fresh token, rewrite `auth.token` so it contains *only* the
 * new value, and update the supplied in-memory `validTokens` set so the
 * old file-derived token is invalidated immediately. Config-pinned
 * tokens (passed via `loadTokens({ tokens: [...] })`) are preserved.
 *
 * Returns the new token (never logged — caller decides what to do).
 */
export async function rotateToken(validTokens: Set<string>): Promise<string> {
  const filePath = tokenFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  const fresh = generateToken();
  // Capture the pre-rotation file-derived tokens BEFORE we drop the
  // snapshot — the rotation contract is that every token that came
  // from `auth.token` must be invalidated in-memory once the file has
  // been rewritten. If we relied on `reconcileFileTokens` alone, a
  // reset snapshot would short-circuit the remove-old-tokens step
  // (see reconcileFileTokens: the removal loop is gated on the old
  // snapshot existing). Config-pinned tokens — those added via
  // `loadTokens({ tokens: [...] })` — are not part of `fileTokens`
  // and therefore survive rotation unchanged.
  const previous = lastFileSnapshot.get(validTokens);
  await writeFile(
    filePath,
    `# DKG node API token — treat this like a password\n${fresh}\n`,
    { mode: 0o600 },
  );
  await chmod(filePath, 0o600);
  if (previous) {
    for (const oldTok of previous.fileTokens) validTokens.delete(oldTok);
  }
  // Force the next reconcile to actually re-read the file even if the
  // OS reused the previous mtime (e.g. on filesystems with low
  // resolution like ext3 / FAT32 / certain CI tmpfs).
  lastFileSnapshot.delete(validTokens);
  reconcileFileTokens(validTokens);
  return fresh;
}

/**
 * Revoke a single token. Returns `true` if the token was previously
 * known to this auth surface (in-memory or file-backed) and has now
 * been invalidated; returns `false` if the token was not present at
 * all.
 *
 * PR #229 bot review round 19 (r19-4): the previous revision was a
 * synchronous `validTokens.delete(token)` only — but `verifyToken()`
 * calls `reconcileFileTokens()` on every invocation, and that
 * reconciliation re-adds any token that still appears on disk in
 * `auth.token`. So calling `revokeToken()` against a file-derived
 * credential was a no-op the very next request: the in-memory set
 * was reset from the still-unchanged file. The contract advertised
 * by the JSDoc ("surgically kill a leaked credential") was therefore
 * broken for the most common case (the file-backed admin token).
 *
 * Fix: persist the removal. If the token was loaded from
 * `auth.token`, rewrite the file to exclude it (and its snapshot
 * entry) BEFORE deleting from the in-memory set, so the next
 * reconcile sees a file that no longer contains the revoked token
 * and leaves it out. Tokens that were never file-backed (e.g.
 * config-pinned via `loadTokens({ tokens: [...] })`) take the
 * original purely-in-memory path — those are not at risk of being
 * re-added by reconciliation because they are not in the snapshot's
 * `fileTokens`.
 */
export async function revokeToken(
  token: string,
  validTokens: Set<string>,
): Promise<boolean> {
  // Snapshot the file-backed tokens BEFORE we mutate the in-memory
  // set so we can decide whether the rewrite is needed. The snapshot
  // is the source of truth for what reconcileFileTokens will treat
  // as "file-derived" on the next call.
  const snapshot = lastFileSnapshot.get(validTokens);
  const wasFileToken = snapshot?.fileTokens.has(token) ?? false;

  if (wasFileToken) {
    const filePath = tokenFilePath();
    let raw: string;
    try {
      raw = readFileSync(filePath).toString('utf-8');
    } catch (err: any) {
      // File vanished between the snapshot and now — there is
      // nothing to rewrite. Drop the snapshot so the next reconcile
      // takes the ENOENT branch and removes any stragglers, then
      // fall through to the in-memory delete below.
      if (err && err.code === 'ENOENT') {
        lastFileSnapshot.delete(validTokens);
        return validTokens.delete(token);
      }
      throw err;
    }
    // Preserve comments and any other tokens; only strip lines that
    // exactly match the revoked token. Empty lines and `#`-prefixed
    // comment lines are kept so operators don't lose their notes.
    const lines = raw.split('\n');
    const kept: string[] = [];
    let removedAny = false;
    for (const line of lines) {
      const t = line.trim();
      if (t.length > 0 && !t.startsWith('#') && t === token) {
        removedAny = true;
        continue;
      }
      kept.push(line);
    }
    if (removedAny) {
      // Atomic-ish rewrite: same path, mode preserved at 0o600 so
      // the file stays operator-only readable. We deliberately do
      // NOT re-add a `# ...` header here because we are PRESERVING
      // whatever header (if any) was already on disk — the rewrite
      // is purely a delete-by-content.
      let next = kept.join('\n');
      // Guarantee a trailing newline so future appends don't end up
      // on the same line as the last surviving token.
      if (!next.endsWith('\n')) next = `${next}\n`;
      await writeFile(filePath, next, { mode: 0o600 });
      try {
        await chmod(filePath, 0o600);
      } catch {
        // chmod is best-effort on platforms (e.g. Windows) that
        // don't enforce POSIX modes. The writeFile mode hint above
        // is already authoritative on those that do.
      }
      // Drop the cached snapshot so the next reconcile re-reads the
      // (now strictly smaller) file and rebuilds `fileTokens` —
      // otherwise the snapshot's old `fileTokens` would still claim
      // the revoked token was file-backed and skip the removal.
      lastFileSnapshot.delete(validTokens);
    }
  }

  return validTokens.delete(token);
}

// ---------------------------------------------------------------------------
// CLI-10 — signed-request verifier (spec §18)
// ---------------------------------------------------------------------------

/**
 * Default ±5 min freshness window for signed requests, matching the
 * AWS Sig V4 / OAuth 1.0 conventions documented in spec §18.
 */
export const SIGNED_REQUEST_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

/**
 * In-memory nonce store: `nonce → expiryEpochMs`. Cleared on process
 * exit (restart-tolerant by design — a long-paused replay has its
 * timestamp blocked by the freshness window check anyway). The store
 * is bounded: any nonce older than the freshness window is pruned on
 * the next access.
 */
const seenNonces = new Map<string, number>();

function pruneNonces(now: number): void {
  if (seenNonces.size === 0) return;
  for (const [nonce, expiry] of seenNonces) {
    if (expiry <= now) seenNonces.delete(nonce);
  }
}

export interface SignedRequestInput {
  method: string;
  path: string;
  /** Raw request body (Buffer or string). Used to compute the signature payload. */
  body: Buffer | string;
  /** Timestamp string supplied by the client (typically ISO-8601). */
  timestamp: string;
  /** Nonce supplied by the client; rejected on second sighting. */
  nonce?: string;
  /** Hex signature supplied by the client. */
  signature: string;
  /** Bearer token used as the HMAC secret. */
  token: string;
  /** Optional override of the freshness window (for tests / spec changes). */
  freshnessWindowMs?: number;
  /** Optional clock override (for tests). */
  now?: number;
}

export type SignedRequestOutcome =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'missing-fields'
        | 'stale-timestamp'
        | 'replayed-nonce'
        | 'bad-signature';
    };

/**
 * Canonical string fed into the HMAC for {@link verifySignedRequest}.
 *
 * ```
 * METHOD\n
 * normalised-path\n
 * timestamp\n
 * nonce\n
 * sha256(body-hex)
 * ```
 *
 * Binds method, path, timestamp, nonce, and a hash of the body — so a
 * captured signature cannot be replayed:
 *   - against a different endpoint (path/method bound),
 *   - with a fresh nonce swapped in (nonce bound),
 *   - against the same endpoint with a tampered body (body hash bound).
 *
 * Callers that still compute HMAC over the legacy `timestamp + body`
 * payload will fail verification — this is intentional (bot review F3).
 */
/**
 * Strict lowercase-or-mixed-case hex validation.
 *
 * Bot review (PR #229 follow-up, auth.ts:376): `Buffer.from(hex, 'hex')`
 * silently truncates at the first non-hex character, so a header like
 * `<valid-hmac>zz` decodes to the original valid bytes and then passes
 * `timingSafeEqual`. Validate the string is purely hex and of the
 * exact expected length BEFORE handing it to `Buffer.from`.
 *
 * @param s                 the string to validate
 * @param expectedCharLen   the required length in hex characters
 *                          (typically 2 × HMAC-SHA256 byte length = 64)
 */
function isStrictHexOfLength(s: unknown, expectedCharLen: number): boolean {
  if (typeof s !== 'string') return false;
  if (s.length !== expectedCharLen) return false;
  // Must be even-length (handled above via expected length) AND all
  // characters hex. We allow both lowercase and uppercase so a client
  // that emits `A-F` is accepted, but no whitespace, no 0x prefix, no
  // punctuation. `/^[0-9a-f]+$/i` also rejects empty strings.
  return /^[0-9a-f]+$/i.test(s);
}

/**
 * Derive the canonical request path bound into the signed-request HMAC.
 *
 * Bot review (PR #229 follow-up, auth.ts:741): binding only `pathname`
 * left query parameters unsigned — an attacker could swap
 * `/api/query?graph=...` for `/api/query?graph=...&poison=...` without
 * invalidating the signature. Several protected daemon routes read
 * `url.searchParams`, so this was a real tamper surface.
 *
 * Now binds `pathname + search` (including the leading `?` when present).
 * Clients computing the HMAC MUST use this exact representation. The
 * helper is exported so callers can share it instead of re-implementing
 * the canonicalisation and drifting.
 */
export function canonicalRequestPath(req: IncomingMessage): string {
  const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  return `${u.pathname}${u.search}`;
}

export function canonicalSignedRequestPayload(
  method: string,
  path: string,
  timestamp: string,
  nonce: string | undefined,
  body: Buffer | string,
): string {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf-8');
  const bodyHashHex = createHash('sha256').update(bodyBuf).digest('hex');
  return [
    (method ?? '').toUpperCase(),
    path ?? '',
    timestamp ?? '',
    nonce ?? '',
    bodyHashHex,
  ].join('\n');
}

/**
 * Verify a signed request per spec §18.
 *
 * Required headers (mapped into `SignedRequestInput`):
 *   - `x-dkg-timestamp`   ISO-8601 or numeric epoch-ms
 *   - `x-dkg-signature`   hex-encoded HMAC-SHA256(token,
 *                         canonicalSignedRequestPayload(method, path, ts,
 *                         nonce, body))
 *   - `x-dkg-nonce`       REQUIRED — opaque, single-use; rejects replay.
 *
 * The HMAC covers METHOD + PATH + TIMESTAMP + NONCE + SHA256(BODY) so:
 *   - a captured signature cannot be replayed against another
 *     endpoint/verb (method + path are bound);
 *   - swapping the nonce to bypass the replay cache does not yield a
 *     valid signature (nonce is bound);
 *   - tampering the body breaks the hash and invalidates the signature.
 *
 * Nonce is REQUIRED: a signature without a nonce is rejected as
 * `missing-fields` (bot review F3). Callers upgrading from the prior
 * "timestamp + body only" scheme must regenerate signatures.
 *
 * Returns a discriminated result describing why a request was refused —
 * callers can map each `reason` to the appropriate HTTP status (401
 * for everything except `missing-fields`, which is 400).
 */
export function verifySignedRequest(input: SignedRequestInput): SignedRequestOutcome {
  if (!input.timestamp || !input.signature || !input.token || !input.nonce) {
    return { ok: false, reason: 'missing-fields' };
  }

  const windowMs = input.freshnessWindowMs ?? SIGNED_REQUEST_FRESHNESS_WINDOW_MS;
  const now = input.now ?? Date.now();
  const tsMs = Date.parse(input.timestamp);
  const tsEpoch = Number.isNaN(tsMs) ? Number(input.timestamp) : tsMs;
  if (!Number.isFinite(tsEpoch)) {
    return { ok: false, reason: 'stale-timestamp' };
  }
  if (Math.abs(now - tsEpoch) > windowMs) {
    return { ok: false, reason: 'stale-timestamp' };
  }

  pruneNonces(now);
  // PR #229 bot review round 9 (auth.ts:293): the replay cache used to
  // be keyed by the raw nonce string, so two different bearer tokens
  // that happened to pick the same nonce would reject each other for
  // the full freshness window. That's a trivial cross-client DoS (any
  // caller that emits `nonce=aaa...` blocks every other caller that
  // picks the same value) and also a false-positive: a replay is only
  // a problem when it's the SAME credential reusing the SAME nonce.
  // Scope the key by `sha256(token)+":"+nonce` so each credential has
  // its own nonce namespace; collisions across credentials no longer
  // cross-block.
  const nonceScope = createHash('sha256').update(input.token).digest('hex');
  const nonceKey = `${nonceScope}:${input.nonce}`;
  if (seenNonces.has(nonceKey)) {
    return { ok: false, reason: 'replayed-nonce' };
  }

  const payload = canonicalSignedRequestPayload(
    input.method,
    input.path,
    input.timestamp,
    input.nonce,
    input.body,
  );
  const expected = createHmac('sha256', input.token).update(payload).digest('hex');

  // Bot review (PR #229 follow-up): `Buffer.from(hex, 'hex')` does NOT
  // reject malformed hex — Node silently truncates at the first non-hex
  // character. `<valid-hmac>zz` decodes to the original valid bytes,
  // which then passes length + timingSafeEqual. Validate the supplied
  // signature is a pure, even-length hex string of the expected length
  // BEFORE decoding. Reject everything else with `bad-signature`.
  if (!isStrictHexOfLength(input.signature, expected.length)) {
    return { ok: false, reason: 'bad-signature' };
  }

  // Constant-time comparison so a partial-match attacker can't
  // distinguish "first byte wrong" from "all bytes wrong" via timing.
  let supplied: Buffer;
  let want: Buffer;
  try {
    supplied = Buffer.from(input.signature, 'hex');
    want = Buffer.from(expected, 'hex');
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
  if (supplied.length !== want.length || !timingSafeEqual(supplied, want)) {
    return { ok: false, reason: 'bad-signature' };
  }

  seenNonces.set(nonceKey, now + windowMs);
  return { ok: true };
}

/**
 * Extract a bearer token from an HTTP Authorization header value.
 * Accepts: "Bearer <token>" or just "<token>".
 */
export function extractBearerToken(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed.startsWith('Bearer ')) return trimmed.slice(7).trim();
  if (trimmed.startsWith('bearer ')) return trimmed.slice(7).trim();
  return trimmed;
}

// ---------------------------------------------------------------------------
// HTTP middleware
// ---------------------------------------------------------------------------

const PUBLIC_PATHS = new Set([
  '/api/status',
  '/api/chain/rpc-health',
  '/.well-known/skill.md',
]);

const PUBLIC_PREFIXES = [
  '/ui',
  '/apps/',
];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  for (const prefix of PUBLIC_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * CLI-10 / BUGS_FOUND.md spec §18 — transport-layer replay protection.
 *
 * Bot review PR #229 (post-round-5): the previous revision of this file
 * added a coarse `token:method:pathname:content-length` fingerprint
 * dedup for body-less Bearer requests so a leaked Bearer could not be
 * silently replayed. That dedup was too aggressive: two consecutive
 * legitimate `POST /api/local-agent-integrations/:id/refresh` calls
 * share a fingerprint and the second one was 401-rejected for 60 s.
 * Similarly, any idempotent body-less `DELETE` retried within a minute
 * failed with a confusing replay error.
 *
 * Replay protection that REJECTS legitimate retries is worse than no
 * replay protection: it breaks correct clients while still leaving the
 * strict replay window (60 s) available to an attacker who records the
 * wire. The proper transport-layer defence against Bearer replay is
 * the signed-request scheme (x-dkg-timestamp + x-dkg-nonce +
 * x-dkg-signature) which binds every request to a unique nonce and a
 * freshness window, and which is already enforced above — including
 * synchronous zero-body verification. Clients that do not opt into
 * signed-request mode now get no transport-layer replay defence; they
 * must handle idempotence at the application layer or upgrade to
 * signed requests. That is the correct trade-off because:
 *
 *   1. Idempotent operations (`refresh`, `DELETE`) MUST be safe to
 *      retry. Transport replay defence must not violate that.
 *   2. Non-idempotent operations (e.g. `POST /publish`) are body-bearing
 *      in practice, so the old fingerprint never fired for them anyway.
 *   3. The signed-request scheme provides proper per-request nonce
 *      enforcement for callers that need it.
 *
 * The fingerprint cache and its helpers have therefore been removed.
 * The symbols below stay exported-but-empty for a release so any test
 * that still references them keeps compiling; the cache is a no-op.
 */

/**
 * HTTP auth guard. Returns true if the request is allowed to proceed,
 * false if a 401 response was sent.
 *
 * Usage in the server handler:
 *   if (!httpAuthGuard(req, res, authEnabled, validTokens)) return;
 */
export function httpAuthGuard(
  req: IncomingMessage,
  res: ServerResponse,
  authEnabled: boolean,
  validTokens: Set<string>,
  corsOrigin?: string | null,
): boolean {
  if (!authEnabled) return true;
  if (req.method === 'OPTIONS') return true;

  const pathname = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
  if (isPublicPath(pathname)) return true;

  const token = extractBearerToken(req.headers.authorization);
  let acceptedToken: string | undefined;
  if (verifyToken(token, validTokens)) {
    acceptedToken = token;
  } else if (pathname === '/api/events') {
    // EventSource can't set headers — accept token as query param, but ONLY
    // for the SSE endpoint to avoid leaking credentials in URLs/logs/referrers.
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const qsToken = url.searchParams.get('token');
    if (qsToken && verifyToken(qsToken, validTokens)) {
      acceptedToken = qsToken;
    }
  }

  if (acceptedToken) {
    const now = Date.now();

    // CLI-10: stale-timestamp gate. If the client opted into the
    // signed-request scheme by sending `x-dkg-timestamp`, enforce the
    // freshness window even before signature verification — a stale
    // timestamp is by itself a replay vector regardless of whether
    // the signature happens to be valid for that timestamp.
    const tsHeader = req.headers['x-dkg-timestamp'];
    if (typeof tsHeader === 'string' && tsHeader.length > 0) {
      const tsMs = Date.parse(tsHeader);
      const tsEpoch = Number.isNaN(tsMs) ? Number(tsHeader) : tsMs;
      if (
        !Number.isFinite(tsEpoch) ||
        Math.abs(now - tsEpoch) > SIGNED_REQUEST_FRESHNESS_WINDOW_MS
      ) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="dkg-node"',
          'Access-Control-Allow-Origin': corsOrigin ?? '*',
        });
        res.end(
          JSON.stringify({ error: 'Stale or unparseable x-dkg-timestamp' }),
        );
        return false;
      }
    }

    // Bot review F1/F2/F3 (BUGS_FOUND.md spec §18): when the client
    // actually opted INTO the signed-request scheme (by sending
    // `x-dkg-signature` and/or `x-dkg-nonce`) we MUST fail closed if
    // any of the required headers is missing or malformed — otherwise
    // a forged signature / replayed nonce would silently pass as long
    // as the bearer token is valid. Full body-binding verification
    // runs in {@link verifyHttpSignedRequestAfterBody} once route
    // handlers have buffered the body. Here we pre-validate the
    // headers that can be checked without the body:
    //   - x-dkg-timestamp present + fresh (already done above)
    //   - x-dkg-nonce present + not replayed
    //   - x-dkg-signature present + well-formed hex
    // Rejecting a replayed nonce here is safe: verifySignedRequest
    // below records successful verifications under the same nonce.
    const sigHeader = req.headers['x-dkg-signature'];
    const nonceHeader = req.headers['x-dkg-nonce'];
    const clientDeclaredSigned = (typeof sigHeader === 'string' && sigHeader.length > 0)
      || (typeof nonceHeader === 'string' && nonceHeader.length > 0);
    if (clientDeclaredSigned) {
      if (
        typeof sigHeader !== 'string' || sigHeader.length === 0 ||
        typeof nonceHeader !== 'string' || nonceHeader.length === 0 ||
        typeof tsHeader !== 'string' || tsHeader.length === 0
      ) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="dkg-node"',
          'Access-Control-Allow-Origin': corsOrigin ?? '*',
        });
        res.end(JSON.stringify({
          error: 'Signed-request mode requires x-dkg-timestamp, x-dkg-nonce, and x-dkg-signature.',
        }));
        return false;
      }
      // Pre-body replay rejection: an attacker swapping in a fresh
      // nonce still fails the post-body HMAC (nonce is bound), but
      // catching a replayed nonce here saves the body parse.
      //
      // PR #229 bot review round 10 (cli/auth.ts:678). Until r10 this
      // pre-body check keyed on the raw `nonceHeader` string, while
      // the full verifier below (r9-3) keys on
      // `sha256(token) + ":" + nonce`. Two different bearer
      // credentials that reused the same nonce would 401 each other
      // HERE even though the signed body would verify cleanly —
      // exactly the cross-client false positive r9-3 was meant to
      // eliminate. Apply the same per-credential scope here so the
      // pre-check and the full verifier enforce identical replay
      // semantics.
      pruneNonces(now);
      const preBodyNonceScope = createHash('sha256').update(acceptedToken).digest('hex');
      const preBodyNonceKey = `${preBodyNonceScope}:${nonceHeader}`;
      if (seenNonces.has(preBodyNonceKey)) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="dkg-node"',
          'Access-Control-Allow-Origin': corsOrigin ?? '*',
        });
        res.end(JSON.stringify({ error: 'Replayed nonce' }));
        return false;
      }
      // Stash the auth context so route handlers can call
      // verifyHttpSignedRequestAfterBody(req, rawBody) after
      // buffering the body. The actual HMAC check happens there
      // (or synchronously below for body-less requests).
      (req as unknown as { __dkgSignedAuth?: SignedAuthPending }).__dkgSignedAuth = {
        token: acceptedToken,
        timestamp: tsHeader,
        nonce: nonceHeader,
        signature: sigHeader,
      };

      // Bot review (PR #229 F2 second follow-up): protected GET / HEAD
      // routes never call readBody*(), so the post-body enforcement in
      // the daemon's body-reading helpers never runs for them. Without
      // this block, a signed request with arbitrary x-dkg-signature
      // would reach the handler as long as the bearer token is valid
      // and the nonce is fresh — which defeats the whole binding
      // contract. For any request that the daemon's body-reading code
      // path is NOT guaranteed to exercise (GET / HEAD / zero
      // content-length with no chunked transfer), we verify the HMAC
      // right here, bound to an empty body, and either fail closed
      // with 401 or mark the request `verified` so a subsequent
      // readBody (the request *might* still carry a body on unusual
      // methods) is a no-op.
      const clRaw = req.headers['content-length'];
      const clNum = typeof clRaw === 'string' ? Number(clRaw) : NaN;
      const isChunked = req.headers['transfer-encoding'] === 'chunked';
      const method = req.method ?? 'GET';
      // PR #229 bot review round 7 (auth.ts:692): DELETE was lumped in
      // with GET/HEAD/OPTIONS as "definitely body-less", but RFC 9110
      // explicitly allows a DELETE request to carry a body and the DKG
      // daemon accepts them on a handful of routes (e.g. admin token
      // revocation carries a JSON body listing token ids). Treating
      // those DELETEs as zero-body here binds the HMAC to an empty
      // string and marks the request `verified` before `readBodyOrNull`
      // ever runs — so any body bytes are silently accepted without
      // authentication.
      //
      // Only short-circuit when the framing proves the request is
      // actually body-less (GET/HEAD/OPTIONS are semantically body-less
      // for HMAC binding; everything else must trip the explicit
      // Content-Length/Transfer-Encoding check).
      //
      // PR #229 bot review round 19 (r19-1): pre-r19-1 `isFramingBodyless`
      // required an *explicit* `Content-Length: 0`. That let a signed
      // client omit the header entirely and — per HTTP/1.1 RFC 9112
      // §6.1, a non-chunked request with no `Content-Length` also has
      // no body — hit an auth-gated empty-body route like
      // `POST /api/local-agent-integrations/:id/refresh`. Those routes
      // never call `readBodyOrNull()`, so the deferred
      // `verifyHttpSignedRequestAfterBody` hook never runs and the
      // HMAC is never checked. Any `x-dkg-signature` (even a stale or
      // forged one) was accepted.
      //
      // Fix: treat MISSING `Content-Length` (with no
      // `Transfer-Encoding`) the same as `Content-Length: 0` and bind
      // the HMAC to the empty body here. A caller that actually wants
      // to stream a body MUST frame it (Content-Length > 0 or
      // Transfer-Encoding: chunked); that's the only way to signal
      // body presence on the wire without ambiguity anyway.
      const clHeaderPresent = typeof clRaw === 'string' && clRaw.length > 0;
      const isFramingBodyless =
        !isChunked && (
          (clHeaderPresent && Number.isFinite(clNum) && clNum <= 0) ||
          !clHeaderPresent
        );
      const isZeroBody =
        method === 'GET' ||
        method === 'HEAD' ||
        method === 'OPTIONS' ||
        isFramingBodyless;
      if (isZeroBody) {
        const pending = (req as unknown as {
          __dkgSignedAuth?: SignedAuthPending & { verified?: boolean };
        }).__dkgSignedAuth!;
        const outcome = verifyHttpSignedRequestAfterBody(req, '');
        if (!outcome.ok) {
          const status = outcome.reason === 'missing-fields' ? 400 : 401;
          const extraHeaders: Record<string, string> =
            status === 401 ? { 'WWW-Authenticate': 'Bearer realm="dkg-node"' } : {};
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': corsOrigin ?? '*',
            ...extraHeaders,
          });
          res.end(
            JSON.stringify({
              error: `Signed request rejected: ${outcome.reason}`,
            }),
          );
          return false;
        }
        pending.verified = true;
      } else {
        // PR #229 bot review round 23 (r23-1): body-carrying signed
        // requests (chunked OR explicit `Content-Length > 0`) are
        // accepted here on the bearer-token proof alone and the HMAC
        // check is deferred to `enforceSignedRequestPostBody`, which
        // only runs when a route handler calls `readBody*()`. If a
        // handler happens to ignore the body (for example
        // `POST /api/local-agent-integrations/:id/refresh`, which
        // only cares that the path was hit), the signed-request HMAC
        // is *never* verified and an attacker with a valid bearer
        // token can forge any `x-dkg-signature` + arbitrary body —
        // the bearer token alone unlocks the route. The original
        // r19-1 fix only caught the empty-`Content-Length` case;
        // `Transfer-Encoding: chunked` with an empty body (and
        // non-chunked bodies on handlers that don't read) were still
        // exploitable.
        //
        // Fix: install a response-level fail-closed guard. We record
        // the fact that a post-body HMAC verification is still
        // outstanding and override `res.writeHead` / `res.end` so
        // that if the handler attempts to emit ANY response while
        // `__dkgSignedAuth.verified` is still false, we replace the
        // status with 401 and refuse to serve data. Routes that do
        // read the body hit `readBody` → `enforceSignedRequestPostBody`
        // → `pending.verified = true` and the guard collapses into a
        // no-op on the first response call.
        installSignedRequestResponseGuard(req, res, corsOrigin ?? undefined);
      }

      return true;
    }

    // Bot review PR #229 (post-round-5): the previous revision of this
    // guard dedup'd body-less Bearer requests by `(token, method,
    // pathname, content-length)` fingerprint and 401-rejected the
    // second hit within a 60-second window. That turned every
    // legitimate idempotent retry of a body-less POST / DELETE
    // (concrete regression:
    // `POST /api/local-agent-integrations/:id/refresh` double-click)
    // into a spurious replay error. Transport-layer replay protection
    // must not break idempotent retries — clients that need strict
    // per-request replay defence MUST opt into the signed-request
    // scheme (x-dkg-timestamp / x-dkg-nonce / x-dkg-signature), which
    // is already enforced synchronously above for zero-body requests.
    // Bearer-only callers now get pass-through here; they are
    // responsible for whatever replay semantics they need at the
    // application layer.

    return true;
  }

  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer realm="dkg-node"',
    'Access-Control-Allow-Origin': corsOrigin ?? '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify({ error: 'Unauthorized — provide a valid Bearer token in the Authorization header' }));
  return false;
}

/**
 * Pending signed-request auth state attached to the request by
 * {@link httpAuthGuard} when the client opted into the signed-request
 * scheme. Route handlers MUST finish the check by calling
 * {@link verifyHttpSignedRequestAfterBody} once they have buffered the
 * request body.
 */
export interface SignedAuthPending {
  token: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

/**
 * Completes signed-request verification started by {@link httpAuthGuard}.
 *
 * After a route handler has buffered the request body, it MUST call this
 * helper to finish the verification that the guard left pending. The
 * helper reads the stashed auth context from `req.__dkgSignedAuth` and
 * runs the full {@link verifySignedRequest} check binding method, path,
 * timestamp, nonce, and body hash.
 *
 * Returns `{ ok: true }` if the request does not use signed-request mode
 * (there is nothing to finish) or if the signature verifies. Otherwise
 * returns the discriminated outcome describing why the request was
 * rejected; the caller is expected to translate it into a 401.
 *
 * When the verification succeeds the nonce is committed to the seen-nonce
 * cache, so subsequent replays are rejected even after process restart
 * (bounded by the freshness window).
 *
 * NOTE: Prefer {@link enforceSignedRequestPostBody} from daemon (and any
 * other HTTP surface that reads request bodies) so the enforcement is
 * driven centrally from the body-reading helper instead of each route
 * having to remember to call it. This function is retained because it is
 * still the lowest-level primitive.
 */
export function verifyHttpSignedRequestAfterBody(
  req: IncomingMessage,
  body: Buffer | string,
): SignedRequestOutcome {
  const pending = (req as unknown as { __dkgSignedAuth?: SignedAuthPending }).__dkgSignedAuth;
  if (!pending) return { ok: true };
  // Bot review (PR #229 follow-up): bind the FULL request path
  // (pathname + search), not just pathname, so query-param tampering
  // invalidates the signature. See `canonicalRequestPath` for details.
  return verifySignedRequest({
    method: req.method ?? 'GET',
    path: canonicalRequestPath(req),
    body,
    timestamp: pending.timestamp,
    nonce: pending.nonce,
    signature: pending.signature,
    token: pending.token,
  });
}

/**
 * Thrown by {@link enforceSignedRequestPostBody} when the signed-request
 * post-body HMAC verification fails. The HTTP layer maps this to 401.
 *
 * Bot review (PR #229 F2 follow-up): the previous revision of
 * {@link httpAuthGuard} pre-validated the signed-request HEADERS, stashed
 * `__dkgSignedAuth`, and returned `true`. No call site actually invoked
 * `verifyHttpSignedRequestAfterBody` — so any request with a fresh
 * timestamp / nonce and an arbitrary `x-dkg-signature` reached the
 * handler as long as the bearer token was valid, completely defeating
 * the body-binding guarantee the HMAC is supposed to provide. The fix
 * is to enforce the post-body check inside the daemon's body-reading
 * helpers so EVERY buffered-body route automatically validates.
 */
export class SignedRequestRejectedError extends Error {
  readonly reason: Exclude<SignedRequestOutcome, { ok: true }>['reason'];
  constructor(reason: Exclude<SignedRequestOutcome, { ok: true }>['reason']) {
    super(`Signed request rejected: ${reason}`);
    this.name = 'SignedRequestRejectedError';
    this.reason = reason;
  }
}

/**
 * Enforce the post-body signed-request HMAC check. Call this from the
 * shared body-reading code path after the full body has been buffered
 * and before the handler sees it.
 *
 * No-op when the request did NOT opt into signed-request mode (i.e.
 * {@link httpAuthGuard} did not stash `__dkgSignedAuth`). When signed
 * mode is active, throws {@link SignedRequestRejectedError} on any
 * failure reason — the HTTP layer is expected to catch it and emit a
 * 401 response. Once a request's signature has been verified it is
 * marked on `__dkgSignedAuth.verified = true` so subsequent body-
 * reads (e.g. multipart handlers that call readBody more than once)
 * are idempotent.
 */
export function enforceSignedRequestPostBody(
  req: IncomingMessage,
  body: Buffer | string,
): void {
  const pending = (req as unknown as { __dkgSignedAuth?: SignedAuthPending & { verified?: boolean } }).__dkgSignedAuth;
  if (!pending || pending.verified) return;
  const outcome = verifyHttpSignedRequestAfterBody(req, body);
  if (outcome.ok) {
    pending.verified = true;
    return;
  }
  throw new SignedRequestRejectedError(outcome.reason);
}

/**
 * @internal — test/operator helper to wipe the replay cache. Useful
 * when an integration test has a legitimate reason to repeat a signed
 * request and needs a clean slate. Bot review PR #229 (post-round-5):
 * the coarse body-less fingerprint cache has been removed; only the
 * per-nonce replay cache remains to be cleared.
 */
export function _clearReplayCacheForTesting(): void {
  seenNonces.clear();
}

/**
 * PR #229 bot review round 23 (r23-1, cli/auth.ts): response-level
 * fail-closed enforcement for body-carrying signed requests.
 *
 * When `httpAuthGuard` stashes `__dkgSignedAuth` for a signed request
 * whose body has not yet been read, the HMAC is verified lazily via
 * `readBody*()` → `enforceSignedRequestPostBody`. Routes that ignore
 * the body (refresh / revoke / fire-and-forget endpoints) never
 * trigger the lazy check, so the request is accepted on the bearer
 * token alone — any `x-dkg-signature` (fresh, stale, or forged)
 * slips through. The original r19-1 fix only closed the explicit
 * `Content-Length: 0` path; chunked empty bodies and non-chunked
 * bodies on non-reading routes remained exploitable.
 *
 * We install a one-shot guard on `res.writeHead` / `res.end` that
 * checks `__dkgSignedAuth.verified` at response time. If the flag
 * is still false we rewrite the response to `401 Unauthorized` —
 * the route handler never sees its intended response emitted to
 * the client. Routes that correctly read the body hit
 * `enforceSignedRequestPostBody` first and flip `verified = true`,
 * making the guard a pass-through on the first response call.
 *
 * Implementation note: we also hook `res.end(null)` / `res.end()` to
 * catch streaming responses, and mark the guard as "spent" so the
 * wrappers don't recurse when we ourselves call writeHead/end to
 * emit the 401 response.
 */
function installSignedRequestResponseGuard(
  req: IncomingMessage,
  res: ServerResponse,
  corsOrigin?: string,
): void {
  type GuardedRes = ServerResponse & { __dkgSignedAuthGuardInstalled?: boolean };
  const guarded = res as GuardedRes;
  if (guarded.__dkgSignedAuthGuardInstalled) return;
  guarded.__dkgSignedAuthGuardInstalled = true;

  const origWriteHead = res.writeHead.bind(res) as typeof res.writeHead;
  const origEnd = res.end.bind(res) as typeof res.end;
  // PR #229 bot review r3146563620 (auth.ts:1244): a handler can leak
  // response bytes through `res.write()` (which auto-flushes implicit
  // headers on first call) or via the explicit `res.flushHeaders()`,
  // before the deferred HMAC verification flips `pending.verified`.
  // Bind the originals so we can safely replay them after verification.
  const origWrite = res.write.bind(res) as typeof res.write;
  const origFlushHeaders = (res as ServerResponse & { flushHeaders?: () => void }).flushHeaders
    ? ((res as ServerResponse & { flushHeaders: () => void }).flushHeaders.bind(res) as () => void)
    : undefined;
  // `spent === true` means we already rewrote the response to 401;
  // every subsequent writeHead/end call from the original handler
  // collapses to a silent no-op so we never get an ERR_STREAM_WRITE_
  // AFTER_END from Node when the handler drains its intended success
  // payload into a socket we've already closed.
  let spent = false;

  // PR #229 bot review round 25 (r25-2). Legitimate clients can send a
  // signed request with `Transfer-Encoding: chunked` + an immediately-
  // terminating body (`0\r\n\r\n`) — for example a refresh/revoke POST
  // whose semantics don't need a payload but whose framing still opts
  // into chunked transfer. The handler for such routes correctly
  // ignores the body. Before r25-2 that combination would hit the
  // fail-closed arm below and emit 401, because `pending.verified`
  // is only flipped by `enforceSignedRequestPostBody`, which needs
  // the handler to explicitly call `readBody*()`.
  //
  // Fix: if the handler emits a response without verifying the
  // HMAC, DEFER its response while we drain whatever body remains
  // on the wire, then finish the verification ourselves and either
  //   (a) replay the handler's intended response on success, or
  //   (b) rewrite it to 401 on any failure.
  //
  // The drain is bounded by `MAX_BODY_BYTES` so a signed request
  // with a never-ending chunked body can't keep us in the
  // reader loop forever. We explicitly DO NOT resume until
  // verification is required, so body-carrying handlers that
  // call `readBody*()` themselves continue to take the
  // synchronous verification path in `enforceSignedRequestPostBody`
  // and the guard collapses into a transparent pass-through.
  const MAX_DRAIN_BYTES = 10 * 1024 * 1024;
  let drainedChunks: Buffer[] = [];
  let drainedBytes = 0;
  let drainAttached = false;
  let drainOverflow = false;

  const attachDrainListeners = (): void => {
    if (drainAttached) return;
    drainAttached = true;
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      drainedBytes += buf.length;
      if (drainedBytes > MAX_DRAIN_BYTES) {
        drainOverflow = true;
        drainedChunks = [];
        return;
      }
      if (!drainOverflow) drainedChunks.push(buf);
    };
    (req as IncomingMessage).on('data', onData);
  };

  const waitForRequestEnd = (): Promise<void> =>
    new Promise((resolve) => {
      const reqAny = req as IncomingMessage & { complete?: boolean; readableEnded?: boolean };
      if (reqAny.complete || reqAny.readableEnded) { resolve(); return; }
      const done = (): void => resolve();
      req.once('end', done);
      req.once('close', done);
      req.once('error', done);
      req.resume();
    });

  // PR #229 bot review r3146563616 (auth.ts:1170): the prior check
  //   `req.complete || req.readableEnded` && `drainedBytes === 0`
  // was wrong — `req.complete` only means "Node finished parsing" and
  // `drainedBytes === 0` only means "we have not attached our drain
  // listeners yet", neither of which is evidence that the wire body
  // was zero-length. A chunked-or-CL>0 request whose body had been
  // fully buffered into the socket but never read by the handler would
  // pass this gate and bind the HMAC to an empty string, accepting
  // tampered bodies.
  //
  // Fix: gate the passive path on the request *framing* declared by
  // the client. Only short-circuit when the headers prove the request
  // is body-less (Content-Length: 0, OR no Content-Length and no
  // Transfer-Encoding — RFC 9112 §6.1: a non-chunked request with no
  // Content-Length has no body). `Transfer-Encoding: chunked` is
  // unconditionally rejected here because we cannot tell from the
  // headers alone whether the chunks were empty; that case MUST flow
  // through the deferred `attachDrainListeners` → `waitForRequestEnd`
  // path so the HMAC is bound to whatever bytes actually arrived.
  const isFramingBodylessByHeaders = (): boolean => {
    const headers = req.headers ?? {};
    const teRaw = headers['transfer-encoding'];
    const teHeader = Array.isArray(teRaw) ? teRaw.join(', ') : (teRaw ?? '');
    if (/chunked/i.test(teHeader)) return false;
    const clRaw = headers['content-length'];
    const clHeader = Array.isArray(clRaw) ? clRaw[0] : clRaw;
    if (typeof clHeader === 'string' && clHeader.length > 0) {
      const n = Number(clHeader);
      return Number.isFinite(n) && n <= 0;
    }
    // No Content-Length and no chunked → semantically bodyless per RFC.
    return true;
  };

  const tryPassiveEmptyBodyVerification = (): boolean => {
    const pending = (req as unknown as {
      __dkgSignedAuth?: SignedAuthPending & { verified?: boolean };
    }).__dkgSignedAuth;
    if (!pending || pending.verified) return true;
    if (!isFramingBodylessByHeaders()) return false;
    if (drainedBytes !== 0) return false;
    const outcome = verifyHttpSignedRequestAfterBody(req, '');
    if (!outcome.ok) return false;
    pending.verified = true;
    return true;
  };

  const failClosed = (reason = 'HMAC verification never completed (handler did not read request body)'): void => {
    spent = true;
    try {
      origWriteHead.call(res, 401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="dkg-node"',
        'Access-Control-Allow-Origin': corsOrigin ?? '*',
      });
      (origEnd as (chunk?: string) => ServerResponse)(
        JSON.stringify({ error: `Signed request rejected: ${reason}` }),
      );
    } catch {
      // res already destroyed — nothing else we can do.
    }
  };

  // A queued writeHead / write / end / flushHeaders emission whose
  // fate depends on the async drain-and-verify. We replay them in the
  // exact order the handler emitted them so the status arrives before
  // the payload, preserving the semantics the handler intended.
  //
  // PR #229 r3146563620 follow-up: the queue now also holds `write`
  // chunks and `flushHeaders` markers — those used to bypass the guard
  // entirely and stream response bytes to the wire while the HMAC was
  // still unverified.
  type Queued =
    | { kind: 'writeHead'; args: Parameters<ServerResponse['writeHead']> }
    | { kind: 'write'; args: Parameters<ServerResponse['write']> }
    | { kind: 'end'; args: Parameters<ServerResponse['end']> }
    | { kind: 'flushHeaders' };
  const queue: Queued[] = [];

  const flushQueue = (): void => {
    for (const q of queue) {
      try {
        if (q.kind === 'writeHead') origWriteHead(...q.args);
        else if (q.kind === 'write') origWrite(...q.args);
        else if (q.kind === 'flushHeaders') {
          if (origFlushHeaders) origFlushHeaders();
        } else origEnd(...q.args);
      } catch {
        // res destroyed mid-flush; give up gracefully.
      }
    }
    queue.length = 0;
  };

  let deferred = false;
  const deferAndResolve = (): void => {
    if (deferred) return;
    deferred = true;
    void (async () => {
      try {
        attachDrainListeners();
        await waitForRequestEnd();
        if (drainOverflow) { failClosed('request body exceeded maximum drain size'); return; }
        const body = Buffer.concat(drainedChunks);
        const outcome = verifyHttpSignedRequestAfterBody(req, body);
        if (!outcome.ok) { failClosed(outcome.reason); return; }
        const pending = (req as unknown as {
          __dkgSignedAuth?: SignedAuthPending & { verified?: boolean };
        }).__dkgSignedAuth;
        if (pending) pending.verified = true;
        flushQueue();
      } catch {
        failClosed('verification failed');
      }
    })();
  };

  const pending = (): SignedAuthPending & { verified?: boolean } | undefined =>
    (req as unknown as {
      __dkgSignedAuth?: SignedAuthPending & { verified?: boolean };
    }).__dkgSignedAuth;

  (res as ServerResponse).writeHead = ((...args: Parameters<ServerResponse['writeHead']>) => {
    if (spent) return res;
    const p = pending();
    if (!p || p.verified) return origWriteHead(...args);
    // Try the cheap path first: chunked empty bodies that have
    // already been parsed by Node by the time the handler emits
    // writeHead fall through here (complete && observed 0 bytes).
    if (tryPassiveEmptyBodyVerification()) return origWriteHead(...args);
    // Otherwise queue this writeHead and kick off the async
    // drain-and-verify. The queued call is replayed once the
    // signature has been confirmed against whatever the wire
    // actually delivered.
    queue.push({ kind: 'writeHead', args });
    deferAndResolve();
    return res;
  }) as ServerResponse['writeHead'];

  (res as ServerResponse).end = ((...args: Parameters<ServerResponse['end']>) => {
    if (spent) return res;
    const p = pending();
    if (!p || p.verified) return origEnd(...args);
    if (tryPassiveEmptyBodyVerification()) return origEnd(...args);
    queue.push({ kind: 'end', args });
    deferAndResolve();
    return res;
  }) as ServerResponse['end'];

  // PR #229 r3146563620: also wrap `write` so streaming response bytes
  // cannot be flushed to the wire ahead of HMAC verification. Node will
  // implicitly call `writeHead(200)` on the first `write()` call if the
  // handler did not call it explicitly, so wrapping `write` is what
  // physically prevents the data leak.
  (res as ServerResponse).write = ((...args: Parameters<ServerResponse['write']>) => {
    if (spent) return false;
    const p = pending();
    if (!p || p.verified) return origWrite(...args);
    if (tryPassiveEmptyBodyVerification()) return origWrite(...args);
    queue.push({ kind: 'write', args });
    deferAndResolve();
    return true;
  }) as ServerResponse['write'];

  if (origFlushHeaders) {
    (res as ServerResponse & { flushHeaders: () => void }).flushHeaders = (() => {
      if (spent) return;
      const p = pending();
      if (!p || p.verified) {
        origFlushHeaders();
        return;
      }
      if (tryPassiveEmptyBodyVerification()) {
        origFlushHeaders();
        return;
      }
      queue.push({ kind: 'flushHeaders' });
      deferAndResolve();
    }) as () => void;
  }
}
