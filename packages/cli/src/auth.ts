/**
 * Unified authentication for DKG node interfaces (HTTP API, MCP, WebSocket, etc.).
 *
 * Uses bearer tokens stored on disk. Tokens are auto-generated on first start.
 * Any interface that needs auth calls `verifyToken(token)` against the loaded set.
 *
 * Slice 06 — added scoped tokens via the `token-store` deep module. The
 * auth file format is extended to allow per-token scopes (see ADR-0003);
 * legacy scope-less lines continue to grant full access. The new
 * `loadTokenStore` returns the structured map; `loadTokens` is a thin
 * wrapper that returns just the set of full-token strings, so the 13
 * existing call sites keep compiling and behaving identically for legacy
 * tokens.
 */

import { randomBytes } from 'node:crypto';
import { readFile, mkdir, chmod, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dkgDir } from './config.js';
import {
  parseTokenFile,
  serializeTokenStore,
  lookupTokenRecord,
  setTokenRecord,
  tokenPrefix,
  type ParsedTokenFile,
  type TokenStore,
  type TokenRecord,
  type Scope,
} from './token-store.js';

// Re-export the deep-module types + helpers so call sites only import from
// `auth.ts`. Keeps the seam between the deep parser/serializer module and
// the I/O-bearing auth surface visible in one place.
export type { TokenStore, TokenRecord, Scope } from './token-store.js';
export {
  lookupTokenRecord,
  toPublicRecord,
  tokenPrefix,
  setTokenRecord,
  deleteTokenRecord,
  serializeTokenStore,
  parseTokenFile,
  type PublicTokenRecord,
} from './token-store.js';

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

/**
 * Resolve the on-disk auth-token path. Goes through `dkgDir()` so test
 * harnesses can redirect via `DKG_HOME=/tmp/...` without touching the
 * production location.
 */
export function tokenFilePath(): string {
  return join(dkgDir(), 'auth.token');
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Load the structured token store from disk + config. Auto-generates a
 * token file (legacy single-line format → scopes = `'*'`) if none exists.
 *
 * Config-defined tokens (from `dkg.config.yaml`) are inserted as
 * scope-less = root tokens — they are typically operator-supplied
 * preshared secrets, and slice 06's contract is "legacy = full access".
 *
 * Reads the file with `parseTokenFile`, which skips malformed lines
 * with a warning rather than crashing. The warning sink defaults to
 * `console.warn` — the daemon can route these through `Logger` later.
 */
export async function loadTokenStore(authConfig?: AuthConfig): Promise<TokenStore> {
  const filePath = tokenFilePath();

  let parsed: ParsedTokenFile = { store: new Map(), preserved: [] };

  if (existsSync(filePath)) {
    try {
      const raw = await readFile(filePath, 'utf-8');
      parsed = parseTokenFile(raw, {
        onWarning: (msg) => console.warn(`[auth] ${msg}`),
      });
    } catch {
      // Unreadable — fall through to auto-generate, same as the pre-slice-06
      // behavior. Don't lock the operator out of a fresh restart.
    }
  }

  // Insert config tokens AFTER file tokens so a config token can't
  // accidentally clobber a file-only one (the parser already de-dupes
  // file lines by prefix).
  if (authConfig?.tokens) {
    for (const t of authConfig.tokens) {
      if (t.length === 0) continue;
      const existing = lookupTokenRecord(t, parsed.store);
      if (existing) continue;
      const record: TokenRecord = {
        prefix: tokenPrefix(t),
        fullToken: t,
        scopes: '*',
      };
      setTokenRecord(parsed.store, record);
    }
  }

  // Auto-generate on first run. Legacy single-line format so a
  // downgrade to a pre-slice-06 daemon still reads it correctly.
  if (parsed.store.size === 0) {
    const token = generateToken();
    const record: TokenRecord = {
      prefix: tokenPrefix(token),
      fullToken: token,
      scopes: '*',
    };
    setTokenRecord(parsed.store, record);
    parsed.preserved.push({
      text: '# DKG node API token — treat this like a password',
      index: 0,
    });
    await mkdir(dirname(filePath), { recursive: true });
    const out = serializeTokenStore(parsed);
    await writeFile(filePath, out, { mode: 0o600 });
    await chmod(filePath, 0o600);
  }

  return parsed.store;
}

/**
 * Backward-compat wrapper. Returns the set of full-token strings — the
 * pre-slice-06 shape of `loadTokens`. Used by 13 call sites (the daemon
 * lifecycle, every route module, the api-client). They continue to work
 * unchanged for legacy tokens.
 */
export async function loadTokens(authConfig?: AuthConfig): Promise<Set<string>> {
  const store = await loadTokenStore(authConfig);
  return new Set([...store.values()].map((r) => r.fullToken));
}

// ---------------------------------------------------------------------------
// Verification (interface-agnostic)
// ---------------------------------------------------------------------------

/**
 * Verify a bearer token against the loaded token set.
 * This is the single entry point any interface (HTTP, MCP, WS) should use.
 */
export function verifyToken(token: string | undefined, validTokens: Set<string>): boolean {
  if (!token) return false;
  return validTokens.has(token);
}

/**
 * Verify a bearer token has the requested scope.
 *
 *   - `'*'` (root) grants any NON-EMPTY scope.
 *   - Explicit scope arrays are exact-match (no globbing).
 *   - Unknown / unrecognized tokens fail closed (false).
 *   - Empty / undefined `requiredScope` fails closed (false). The TS
 *     signature forbids this, but a JS caller (or a `someValue as Scope`
 *     cast) could still slip through; without the guard, a wildcard
 *     token would grant a "no scope" check, which is exactly the
 *     forgotten-argument bug we want loud rather than silent.
 *
 * Pure function — every input is explicit, no global state. Callers are
 * expected to send the appropriate 403 (NOT 401: the token IS valid; the
 * scope is wrong).
 */
export function verifyTokenScope(
  token: string | undefined,
  requiredScope: Scope,
  store: TokenStore,
): boolean {
  if (!token) return false;
  // Fail-closed BEFORE the wildcard shortcut so a forgotten/empty scope
  // argument can never accidentally grant access to a root token. See
  // review I1: slice 07 will copy this guard verbatim.
  if (!requiredScope) return false;
  const record = lookupTokenRecord(token, store);
  if (!record) return false;
  if (record.scopes === '*') return true;
  return record.scopes.includes(requiredScope);
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
 * HTTP auth guard. Returns true if the request is allowed to proceed,
 * false if a 401 response was sent.
 *
 * Usage in the server handler:
 *   if (!httpAuthGuard(req, res, authEnabled, validTokens)) return;
 *
 * Note: scope checks live PER ROUTE (see `daemon/routes/kafka.ts`). The
 * guard only enforces "valid token present" — pushing per-route scope
 * knowledge into the guard would force it to know every route's required
 * scope, which is exactly the smell ADR-0003 calls out.
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
  if (verifyToken(token, validTokens)) return true;

  // EventSource can't set headers — accept token as query param, but ONLY
  // for the SSE endpoint to avoid leaking credentials in URLs/logs/referrers.
  if (pathname === '/api/events') {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const qsToken = url.searchParams.get('token');
    if (qsToken && verifyToken(qsToken, validTokens)) return true;
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
