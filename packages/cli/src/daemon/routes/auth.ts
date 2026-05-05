/**
 * `/api/auth/tokens` route group — root-only token administration.
 *
 * Slice 06 (ADR-0003). Adds three verbs:
 *
 *   POST   /api/auth/tokens               mint a scoped token
 *   GET    /api/auth/tokens               list (prefix + scopes only — never the secret)
 *   DELETE /api/auth/tokens/<prefix>      revoke by prefix (idempotent: 204 on hit, 404 on miss)
 *
 * Root-only: a "root" caller is one whose bearer token's scope set is
 * `'*'` in the loaded store. Every other caller (any explicitly-scoped
 * token) gets 403. ADR-0003 explicitly forbids an `auth:tokens:write`
 * scope — letting a scope mint scopes is a privilege-escalation path.
 *
 * The full token is returned ONCE on mint. Subsequent list/get responses
 * carry only `{prefix, scopes, name?, createdAt?}`. Storing the token
 * (so `verifyToken` matches on later requests) goes through
 * `writeFileAtomic` from `daemon/fs-utils.ts` — same atomic-rename
 * pattern the auto-update flow uses, so concurrent CLI + API mints
 * cannot interleave bytes.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  jsonResponse,
  readBody,
  safeDecodeURIComponent,
} from '../http-utils.js';
import {
  lookupTokenRecord,
  parseTokenFile,
  serializeTokenStore,
  setTokenRecord,
  deleteTokenRecord,
  toPublicRecord,
  tokenFilePath,
  tokenPrefix,
  type Scope,
  type TokenRecord,
} from '../../auth.js';
import { writeFileAtomic } from '../fs-utils.js';
import type { RequestContext } from './context.js';

const BASE_PATH = '/api/auth/tokens';

/**
 * Serialization mutex. The on-disk write goes through `writeFileAtomic`
 * (POSIX-rename atomic), but rename atomicity only guarantees that the
 * resulting file is one of the inputs — under concurrent N parallel
 * writes you'd lose N-1 of them because each write reads-modifies-writes
 * a snapshot of the in-memory state.
 *
 * The mutex serializes the read-modify-write critical section on a
 * SINGLE-PROCESS basis. Multi-process mints (e.g. simultaneous CLI +
 * daemon API call) need a separate file-lock — out of scope for slice 06,
 * documented as a known limitation.
 */
let mintMutex: Promise<void> = Promise.resolve();
async function withMintMutex<T>(work: () => Promise<T>): Promise<T> {
  const prev = mintMutex;
  let release!: () => void;
  mintMutex = new Promise((r) => { release = r; });
  try {
    await prev;
    return await work();
  } finally {
    release();
  }
}

/**
 * Generate a fresh secret. Same shape as the daemon's first-run token
 * (32 bytes of entropy → base64url) — keeps the on-disk representation
 * uniform across legacy and scoped lines.
 */
function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Verify the caller is "root" (scope set is exactly `'*'`). Sends a 403
 * + returns false if not. We accept ONLY the wildcard — an explicit list
 * that happens to include every known scope is NOT root, because new
 * scopes will be added over time and we don't want to grandfather old
 * lists into administering them.
 */
function requireRoot(ctx: RequestContext): boolean {
  const record = lookupTokenRecord(ctx.requestToken, ctx.tokenStore);
  if (!record || record.scopes !== '*') {
    jsonResponse(ctx.res, 403, {
      error: 'Root token required for token administration',
    });
    return false;
  }
  return true;
}

export async function handleAuthRoutes(ctx: RequestContext): Promise<void> {
  const { req, path } = ctx;

  if (req.method === 'POST' && path === BASE_PATH) {
    if (!requireRoot(ctx)) return;
    return handleMint(ctx);
  }

  if (req.method === 'GET' && path === BASE_PATH) {
    if (!requireRoot(ctx)) return;
    return handleList(ctx);
  }

  if (req.method === 'DELETE' && path.startsWith(`${BASE_PATH}/`)) {
    if (!requireRoot(ctx)) return;
    return handleRevoke(ctx);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// POST /api/auth/tokens — mint
// ───────────────────────────────────────────────────────────────────────────

interface MintRequestBody {
  scope?: unknown;
  scopes?: unknown;
  name?: unknown;
}

/**
 * Parse the request body into a normalized `{scopes, name?}` shape.
 * Returns null on a parse error (a 400 has already been written).
 *
 * The HTTP API accepts both `scope` and `scopes`; both can be either a
 * comma-separated string or an array of strings. The CLI sends `scope`
 * as a string for ergonomic flag handling, but UI clients tend to send
 * arrays — so we accept both.
 */
function parseMintBody(
  ctx: RequestContext,
  body: MintRequestBody,
): { scopes: Scope[] | '*'; name?: string } | null {
  const { res } = ctx;
  const rawScopes = body.scopes ?? body.scope;

  if (rawScopes === undefined || rawScopes === null) {
    jsonResponse(res, 400, {
      error: '"scope" (or "scopes") is required: comma-separated string or array',
    });
    return null;
  }

  let scopeList: string[];
  if (Array.isArray(rawScopes)) {
    if (!rawScopes.every((s): s is string => typeof s === 'string')) {
      jsonResponse(res, 400, { error: '"scopes" array entries must all be strings' });
      return null;
    }
    scopeList = rawScopes.map((s) => s.trim()).filter((s) => s.length > 0);
  } else if (typeof rawScopes === 'string') {
    scopeList = rawScopes.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  } else {
    jsonResponse(res, 400, { error: '"scope" must be a string or array of strings' });
    return null;
  }

  if (scopeList.length === 0) {
    jsonResponse(res, 400, { error: 'at least one scope is required' });
    return null;
  }

  // ADR-0003 forbids both wildcard mints AND an auth-management scope:
  //   - wildcard `*` would mint a new root (privilege escalation).
  //   - `auth:tokens:*` would let a scoped token mint scoped tokens
  //     (privilege escalation).
  // Both checks fire BEFORE the character allowlist so the operator
  // gets a precise diagnostic message instead of "disallowed characters".
  if (scopeList.includes('*')) {
    jsonResponse(res, 400, {
      error: 'wildcard scope "*" cannot be minted via API (root tokens are operator-managed)',
    });
    return null;
  }
  for (const s of scopeList) {
    if (s.startsWith('auth:tokens:')) {
      jsonResponse(res, 400, {
        error: `scope "${s}" is reserved (token administration is root-only)`,
      });
      return null;
    }
    // Character allowlist (no `*` — that's the wildcard case above).
    if (!/^[A-Za-z0-9_.:\-]+$/.test(s)) {
      jsonResponse(res, 400, { error: `scope "${s}" contains disallowed characters` });
      return null;
    }
  }

  let name: string | undefined;
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== 'string') {
      jsonResponse(res, 400, { error: '"name" must be a string when provided' });
      return null;
    }
    const trimmed = body.name.trim();
    if (trimmed.length > 0) {
      // The on-disk format uses TAB as a field separator — names with TABs
      // would corrupt the row. Reject early with a clear message.
      if (trimmed.includes('\t') || trimmed.includes('\n')) {
        jsonResponse(res, 400, {
          error: '"name" cannot contain tab or newline characters',
        });
        return null;
      }
      name = trimmed;
    }
  }

  const result: { scopes: Scope[] | '*'; name?: string } = { scopes: scopeList };
  if (name !== undefined) result.name = name;
  return result;
}

async function handleMint(ctx: RequestContext): Promise<void> {
  const { req, res } = ctx;

  const rawBody = await readBody(req);
  let parsed: MintRequestBody;
  try {
    parsed = (rawBody.length === 0 ? {} : JSON.parse(rawBody)) as MintRequestBody;
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON in request body' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return jsonResponse(res, 400, { error: 'Body must be a JSON object' });
  }

  const fields = parseMintBody(ctx, parsed);
  if (fields === null) return;

  const newToken = generateSecret();
  const record: TokenRecord = {
    prefix: tokenPrefix(newToken),
    fullToken: newToken,
    scopes: fields.scopes,
    createdAt: new Date().toISOString(),
  };
  if (fields.name !== undefined) record.name = fields.name;

  await withMintMutex(async () => {
    // Read-modify-write: re-read the file inside the mutex so we don't
    // clobber records added by a concurrent CLI mint that landed
    // BETWEEN the daemon's startup load and now. Without this, two
    // sequential API mints would each append their record but only
    // the second would survive on disk.
    const filePath = tokenFilePath();
    const existing = existsSync(filePath)
      ? parseTokenFile(await readFile(filePath, 'utf-8'), {
          onWarning: (msg) => console.warn(`[auth] ${msg}`),
        })
      : { store: new Map(), preserved: [] as Array<{ text: string; index: number }> };

    setTokenRecord(existing.store, record);

    // Mirror into the in-memory store so subsequent requests within
    // this daemon process accept the new token without a restart.
    setTokenRecord(ctx.tokenStore, record);
    ctx.validTokens.add(newToken);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, serializeTokenStore(existing));
    await chmod(filePath, 0o600);
  });

  // Mint response — the ONLY surface that returns the full token.
  // Subsequent GET/DELETE responses MUST never include `token`.
  return jsonResponse(res, 201, {
    token: newToken,
    prefix: record.prefix,
    scopes: record.scopes,
    ...(record.name !== undefined ? { name: record.name } : {}),
    createdAt: record.createdAt,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// GET /api/auth/tokens — list (no secrets)
// ───────────────────────────────────────────────────────────────────────────

async function handleList(ctx: RequestContext): Promise<void> {
  const { res } = ctx;
  // `toPublicRecord` strips `fullToken`. Keep the iteration order from
  // the in-memory store (insertion order) so the operator sees the
  // mint order they remember.
  const tokens = [...ctx.tokenStore.values()].map(toPublicRecord);
  return jsonResponse(res, 200, { tokens });
}

// ───────────────────────────────────────────────────────────────────────────
// DELETE /api/auth/tokens/<prefix> — revoke
// ───────────────────────────────────────────────────────────────────────────

async function handleRevoke(ctx: RequestContext): Promise<void> {
  const { res, path } = ctx;
  const encoded = path.slice(`${BASE_PATH}/`.length);
  if (!encoded) {
    return jsonResponse(res, 400, { error: 'Missing token prefix in path' });
  }
  if (encoded.includes('/')) {
    return jsonResponse(res, 404, { error: 'Not found' });
  }
  const prefix = safeDecodeURIComponent(encoded, res);
  if (prefix === null) return; // 400 already sent

  // Guard against revoking yourself out of the system. We'd survive in
  // memory until the next process restart, but the on-disk file would
  // no longer carry the token, so the next daemon start would auto-
  // generate a fresh one — disruptive and easy to footgun. Block it
  // and tell the caller why.
  const callerRecord = lookupTokenRecord(ctx.requestToken, ctx.tokenStore);
  if (callerRecord && callerRecord.prefix === prefix) {
    return jsonResponse(res, 400, {
      error: 'Refusing to revoke the bearer token used to make this request',
    });
  }

  const result = await withMintMutex(async () => {
    const filePath = tokenFilePath();
    if (!existsSync(filePath)) return { found: false };

    const existing = parseTokenFile(await readFile(filePath, 'utf-8'), {
      onWarning: (msg) => console.warn(`[auth] ${msg}`),
    });
    const target = existing.store.get(prefix);
    if (!target) return { found: false };

    deleteTokenRecord(existing.store, prefix);
    deleteTokenRecord(ctx.tokenStore, prefix);
    ctx.validTokens.delete(target.fullToken);

    await writeFileAtomic(filePath, serializeTokenStore(existing));
    await chmod(filePath, 0o600);
    return { found: true };
  });

  if (!result.found) {
    // Documented choice: 404 on miss (NOT 204). The semantic is "the
    // resource you tried to delete doesn't exist", which 404 expresses
    // more honestly than 204's "I deleted it" (lying about the world).
    // Idempotency is preserved in the sense that repeating the call
    // continues to return 404 deterministically.
    return jsonResponse(res, 404, { error: `No token with prefix "${prefix}"` });
  }
  // 204 has no body per RFC 7230. Bypass `jsonResponse` (which always
  // writes one) so we don't ship `null` as a body.
  res.writeHead(204);
  res.end();
}
