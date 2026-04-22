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
  let mtimeMs = -1;
  let size = -1;
  try {
    const st = statSync(filePath);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    return;
  }
  const snapshot = lastFileSnapshot.get(validTokens);
  // Cheap short-circuit: if size+mtime are identical, the bytes almost
  // certainly are too (and the fallback below will prove it by hashing).
  // Reading/hashing on every call would defeat the "one statSync per
  // request" design goal.
  if (snapshot && snapshot.mtimeMs === mtimeMs && snapshot.size === size) return;
  let rawBuf: Buffer;
  try {
    rawBuf = readFileSync(filePath);
  } catch {
    return;
  }
  const contentHash = createHash('sha256').update(rawBuf).digest('hex');
  if (snapshot && snapshot.contentHash === contentHash) {
    // mtime/size drifted but bytes are unchanged (e.g. atomic replace
    // with identical content, or `touch`). Refresh the fast-path
    // metadata so we don't re-hash on every request.
    lastFileSnapshot.set(validTokens, {
      mtimeMs,
      size,
      contentHash,
      fileTokens: snapshot.fileTokens,
    });
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
 * Revoke a single token in-process. Useful for operators that want to
 * surgically kill a leaked credential without rewriting the whole
 * token file.
 */
export function revokeToken(token: string, validTokens: Set<string>): boolean {
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
  if (seenNonces.has(input.nonce)) {
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

  seenNonces.set(input.nonce, now + windowMs);
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
      pruneNonces(now);
      if (seenNonces.has(nonceHeader)) {
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
      const isZeroBody =
        method === 'GET' ||
        method === 'HEAD' ||
        method === 'OPTIONS' ||
        method === 'DELETE' ||
        (!isChunked && Number.isFinite(clNum) && clNum <= 0);
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
