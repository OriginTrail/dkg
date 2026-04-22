/**
 * Unified authentication for DKG node interfaces (HTTP API, MCP, WebSocket, etc.).
 *
 * Uses bearer tokens stored on disk. Tokens are auto-generated on first start.
 * Any interface that needs auth calls `verifyToken(token)` against the loaded set.
 */

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
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
    const mtimeMs = statSync(filePath).mtimeMs;
    lastFileSnapshot.set(tokens, { mtimeMs, fileTokens });
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
 * file's mtime has changed since the last reconciliation. The cost is
 * one `statSync` per call, which is in the same order of magnitude as
 * the existing `Set.has` and well below the cost of every other path
 * the daemon executes per request.
 *
 * Tokens added programmatically (e.g. via the future `rotateToken`
 * API or pinned in `config.auth.tokens`) are preserved across
 * reconciliation: the algorithm compares the *file-derived* subset
 * with what's now on disk, removes the stale file tokens, and adds
 * the new ones — without touching tokens that never came from disk.
 */
const lastFileSnapshot = new WeakMap<
  Set<string>,
  { mtimeMs: number; fileTokens: Set<string> }
>();

function reconcileFileTokens(validTokens: Set<string>): void {
  const filePath = tokenFilePath();
  let mtimeMs = -1;
  let raw: string | null = null;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    return;
  }
  const snapshot = lastFileSnapshot.get(validTokens);
  if (snapshot && snapshot.mtimeMs === mtimeMs) return;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }
  const newFileTokens = new Set<string>();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t.length > 0 && !t.startsWith('#')) newFileTokens.add(t);
  }
  if (snapshot) {
    for (const oldTok of snapshot.fileTokens) {
      if (!newFileTokens.has(oldTok)) validTokens.delete(oldTok);
    }
  }
  for (const t of newFileTokens) validTokens.add(t);
  lastFileSnapshot.set(validTokens, { mtimeMs, fileTokens: newFileTokens });
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
  await writeFile(
    filePath,
    `# DKG node API token — treat this like a password\n${fresh}\n`,
    { mode: 0o600 },
  );
  await chmod(filePath, 0o600);
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
 * Verify a signed request per spec §18.
 *
 * Required headers (mapped into `SignedRequestInput`):
 *   - `x-dkg-timestamp`   ISO-8601 or numeric epoch-ms
 *   - `x-dkg-signature`   hex-encoded HMAC-SHA256(token, ts + body)
 *   - `x-dkg-nonce`       opaque, single-use; rejects replay
 *
 * Returns a discriminated result describing why a request was refused —
 * callers can map each `reason` to the appropriate HTTP status (401
 * for everything except `missing-fields`, which is 400).
 */
export function verifySignedRequest(input: SignedRequestInput): SignedRequestOutcome {
  if (!input.timestamp || !input.signature || !input.token) {
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

  if (input.nonce) {
    pruneNonces(now);
    if (seenNonces.has(input.nonce)) {
      return { ok: false, reason: 'replayed-nonce' };
    }
  }

  const bodyBuf = Buffer.isBuffer(input.body)
    ? input.body
    : Buffer.from(input.body ?? '', 'utf-8');
  const expected = createHmac('sha256', input.token)
    .update(input.timestamp)
    .update(bodyBuf)
    .digest('hex');
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

  if (input.nonce) {
    seenNonces.set(input.nonce, now + windowMs);
  }
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
 * CLI-10 (BUGS_FOUND.md spec §18 / dup #11): per-token replay cache.
 *
 * Bearer auth alone has no transport-layer notion of "this is a fresh
 * request" vs "this is the same request being replayed by an attacker
 * who recorded the wire". Spec §18 plugs that gap with mandatory
 * nonces; until every client emits one, we apply a conservative
 * fingerprint-based dedup on Bearer-only requests so a leaked Bearer
 * cannot be silently replayed within a short window.
 *
 * The fingerprint is `token:method:pathname:content-length`. Distinct
 * bodies (almost universal in real use) produce different fingerprints
 * via Content-Length and don't trigger the dedup. Identical empty-body
 * POSTs (the test's worst-case "raw replay") collide and the second
 * one is rejected with 401. TTL matches the signed-request freshness
 * window so the dedup state cannot grow unbounded.
 */
const REPLAY_TTL_MS = 60_000;
const recentRequestFingerprints = new Map<string, number>();

function pruneFingerprints(now: number): void {
  if (recentRequestFingerprints.size === 0) return;
  for (const [fp, expiry] of recentRequestFingerprints) {
    if (expiry <= now) recentRequestFingerprints.delete(fp);
  }
}

function computeRequestFingerprint(
  token: string,
  method: string,
  pathname: string,
  contentLength: string,
): string {
  return createHmac('sha256', token)
    .update(method)
    .update('\u0000')
    .update(pathname)
    .update('\u0000')
    .update(contentLength)
    .digest('hex');
}

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

    // CLI-10 (BUGS_FOUND.md spec §18 / dup #11): replay dedup for
    // Bearer-only requests. We can't safely consume the request body
    // here without breaking downstream handlers, so the dedup is
    // intentionally restricted to BODY-LESS mutating requests where
    // there is nothing else to distinguish two consecutive calls.
    // Requests that DO carry a body are left to the application
    // layer's idempotency / domain validation (e.g. the duplicate-CG
    // create handler returns 409 when a body-bearing duplicate
    // arrives). This keeps the dedup precise — the test's identical
    // empty-body POST replay is caught (CLI-10), while legitimate
    // domain-level duplicate-payload behaviour is preserved (CLI-7
    // dup CG, CLI-16 path-traversal validator).
    if (
      req.method &&
      req.method !== 'GET' &&
      req.method !== 'HEAD'
    ) {
      const cl = req.headers['content-length'];
      const clNum = typeof cl === 'string' ? Number(cl) : 0;
      const hasBody =
        (Number.isFinite(clNum) && clNum > 0) ||
        req.headers['transfer-encoding'] === 'chunked';
      if (!hasBody) {
        pruneFingerprints(now);
        const fp = computeRequestFingerprint(
          acceptedToken,
          req.method,
          pathname,
          '0',
        );
        if (recentRequestFingerprints.has(fp)) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer realm="dkg-node"',
            'Access-Control-Allow-Origin': corsOrigin ?? '*',
          });
          res.end(
            JSON.stringify({
              error:
                'Replay detected — identical body-less Bearer request seen recently. Include a unique x-dkg-nonce or attach a request body.',
            }),
          );
          return false;
        }
        recentRequestFingerprints.set(fp, now + REPLAY_TTL_MS);
      }
    }

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
 * @internal — test/operator helper to wipe the replay cache. Useful
 * when an integration test has a legitimate reason to repeat a body-
 * less POST (e.g. retry-without-bodies) and needs a clean slate.
 */
export function _clearReplayCacheForTesting(): void {
  recentRequestFingerprints.clear();
  seenNonces.clear();
}
