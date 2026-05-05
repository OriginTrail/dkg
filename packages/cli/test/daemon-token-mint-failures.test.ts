/**
 * Slice 06 — failure-mode tests for `/api/auth/tokens` (review I2).
 *
 * Pins the disk-first ordering invariant: when `writeFileAtomic` throws,
 * the in-memory `tokenStore` + `validTokens` MUST be unchanged so the
 * daemon's accepted-token set stays consistent with the on-disk file. A
 * mint that disagrees with disk would silently disappear on restart;
 * a revoke that disagrees with disk would silently come back.
 *
 * Failure injection: make the parent directory read-only so the temp
 * file write inside `writeFileAtomic` fails. Real fs surface, no mocks
 * — the same code path production runs hits the real EACCES.
 */
import { Readable } from 'node:stream';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleAuthRoutes } from '../src/daemon/routes/auth.js';
import { loadTokenStore, type TokenStore } from '../src/auth.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function buildMockReq(
  method: string,
  path: string,
  body: unknown,
  authHeader: string,
): Readable & { method: string; url: string; headers: Record<string, string | undefined> } {
  const stream = new Readable();
  stream.push(typeof body === 'string' ? body : JSON.stringify(body));
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
}
function buildMockRes(): { res: any; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: undefined };
  const res: any = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number) {
      captured.status = status;
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
  token: string,
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
    authEnabled: true,
  } as unknown as RequestContext;
}

const ROOT_TOKEN = 'root-token-failures-aaaaaaaaaaaaaaaaa';

describe('mint failure leaves in-memory state unchanged (review I2)', () => {
  let dkgHome: string;

  beforeEach(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-mint-failure-'));
    process.env.DKG_HOME = dkgHome;
    await writeFile(join(dkgHome, 'auth.token'), `${ROOT_TOKEN}\n`);
  });

  afterEach(async () => {
    delete process.env.DKG_HOME;
    // Restore mode in case a test left it locked (otherwise rm fails).
    try { await chmod(dkgHome, 0o700); } catch { /* best-effort */ }
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('mint: disk-write failure → 500, in-memory store unchanged, file unchanged', async () => {
    const store = await loadTokenStore();
    const validTokens = new Set([...store.values()].map((r) => r.fullToken));
    const sizeBefore = store.size;
    const validBefore = new Set(validTokens);

    // Snapshot the file content before the failure so we can confirm
    // it didn't change.
    const fileBefore = await readFile(join(dkgHome, 'auth.token'), 'utf-8');

    // Lock the dkg home directory read-only — writeFileAtomic's temp
    // file creation will fail with EACCES.
    await chmod(dkgHome, 0o500);

    const req = buildMockReq(
      'POST',
      '/api/auth/tokens',
      { scope: 'kafka:endpoint:read', name: 'doomed' },
      `Bearer ${ROOT_TOKEN}`,
    );
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(buildCtx(req, res, store, validTokens, ROOT_TOKEN));

    // 5xx — the persistence failed and the route surfaced it.
    expect(captured.status).toBeGreaterThanOrEqual(500);
    expect(captured.status).toBeLessThan(600);
    expect((captured.body as any).error).toMatch(/persist/i);

    // Restore so the assertions below can read the directory.
    await chmod(dkgHome, 0o700);

    // In-memory store + Set are UNCHANGED. No new prefix appeared, and
    // no new full-token entered the validTokens Set. (The implementation
    // must apply the disk write before mutating; review I2.)
    expect(store.size).toBe(sizeBefore);
    expect(validTokens.size).toBe(validBefore.size);
    expect([...validTokens].sort()).toEqual([...validBefore].sort());

    // The on-disk file is byte-identical to before.
    const fileAfter = await readFile(join(dkgHome, 'auth.token'), 'utf-8');
    expect(fileAfter).toBe(fileBefore);

    // No subsequent request should accept whatever token would have
    // been minted — but we don't have a token to compare to (the
    // generator runs only on success). The in-memory size + set
    // checks above already prove no orphan token leaked in.
  });

  it('revoke: disk-write failure → 500, target token still valid in memory + on disk', async () => {
    // Pre-populate a target token to revoke.
    const TARGET = 'target-to-revoke-aaaaaaaaaaaaaaaaaaa';
    await writeFile(
      join(dkgHome, 'auth.token'),
      `${ROOT_TOKEN}\n${TARGET}\tkafka:endpoint:read\n`,
    );
    const store = await loadTokenStore();
    const validTokens = new Set([...store.values()].map((r) => r.fullToken));
    const sizeBefore = store.size;

    expect(validTokens.has(TARGET)).toBe(true);
    const targetPrefix = TARGET.slice(0, 8);
    expect(store.has(targetPrefix)).toBe(true);

    const fileBefore = await readFile(join(dkgHome, 'auth.token'), 'utf-8');

    // Lock the directory so writeFileAtomic's temp create fails.
    await chmod(dkgHome, 0o500);

    const req = buildMockReq(
      'DELETE',
      `/api/auth/tokens/${targetPrefix}`,
      undefined as unknown as string,
      `Bearer ${ROOT_TOKEN}`,
    );
    const { res, captured } = buildMockRes();
    await handleAuthRoutes(buildCtx(req, res, store, validTokens, ROOT_TOKEN));

    expect(captured.status).toBeGreaterThanOrEqual(500);
    expect(captured.status).toBeLessThan(600);
    expect((captured.body as any).error).toMatch(/persist/i);

    await chmod(dkgHome, 0o700);

    // Target token is STILL in the in-memory store + Set (i.e. NOT
    // prematurely revoked). Without the disk-first ordering, the
    // delete would have applied to memory and the on-disk file would
    // resurrect the token on the next daemon restart.
    expect(store.size).toBe(sizeBefore);
    expect(store.has(targetPrefix)).toBe(true);
    expect(validTokens.has(TARGET)).toBe(true);

    // The on-disk file is byte-identical to before.
    const fileAfter = await readFile(join(dkgHome, 'auth.token'), 'utf-8');
    expect(fileAfter).toBe(fileBefore);
  });
});
