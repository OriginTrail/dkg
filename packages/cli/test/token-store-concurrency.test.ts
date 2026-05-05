/**
 * Slice 06 — concurrency test for parallel token mints.
 *
 * Reuses the real mint route (not a stub) so the read-modify-write
 * critical section + `writeFileAtomic` + the in-process mutex are
 * exercised together. The invariant we're guarding:
 *
 *   `Promise.all` of N parallel mints produces a well-formed token file
 *   that, when re-parsed from disk, contains all N records (no truncation,
 *   no interleaved bytes, no lost records).
 *
 * Without the mutex, two parallel mints would each read the same
 * pre-write snapshot and each WRITE only its own delta back, so N-1
 * mints would silently disappear from the file. The mutex serializes
 * the critical section per-process; the test would fail with N=10 → 1-2
 * records on disk.
 *
 * Multi-process mints (e.g. CLI + daemon-API simultaneously) are out of
 * scope for slice 06 and are documented as a known limitation in the
 * route module.
 */
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleAuthRoutes } from '../src/daemon/routes/auth.js';
import {
  loadTokenStore,
  parseTokenFile,
  type TokenStore,
} from '../src/auth.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function buildMockReq(
  method: string,
  path: string,
  body: unknown,
  authHeader: string,
): Readable & { method: string; url: string; headers: Record<string, string | undefined> } {
  const stream = new Readable();
  stream.push(JSON.stringify(body));
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
  } as unknown as RequestContext;
}

describe('parallel mint concurrency', () => {
  let dkgHome: string;
  const ROOT_TOKEN = 'root-token-fffffffffffffffffffffff';

  beforeEach(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-mint-concurrency-'));
    process.env.DKG_HOME = dkgHome;
    await writeFile(join(dkgHome, 'auth.token'), `${ROOT_TOKEN}\n`);
  });

  afterEach(async () => {
    delete process.env.DKG_HOME;
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('Promise.all of 10 parallel mints yields a well-formed file with all 10 records', async () => {
    const store = await loadTokenStore();
    const validTokens = new Set([...store.values()].map((r) => r.fullToken));

    const N = 10;
    const mintOne = async (i: number): Promise<{ status: number; token: string; prefix: string }> => {
      const req = buildMockReq(
        'POST',
        '/api/auth/tokens',
        { scope: 'kafka:endpoint:read', name: `parallel-${i}` },
        `Bearer ${ROOT_TOKEN}`,
      );
      const { res, captured } = buildMockRes();
      await handleAuthRoutes(buildCtx(req, res, store, validTokens, ROOT_TOKEN));
      const body = captured.body as { token: string; prefix: string };
      return { status: captured.status, token: body.token, prefix: body.prefix };
    };

    const results = await Promise.all(
      Array.from({ length: N }, (_unused, i) => mintOne(i)),
    );

    // Every mint succeeded.
    for (const r of results) {
      expect(r.status).toBe(201);
      expect(typeof r.token).toBe('string');
      expect(r.token.length).toBeGreaterThan(20);
    }

    // The on-disk file is well-formed: re-parsing it yields the root +
    // all N minted records, with no malformed-line warnings.
    const onDisk = await readFile(join(dkgHome, 'auth.token'), 'utf-8');
    const warnings: string[] = [];
    const parsed = parseTokenFile(onDisk, { onWarning: (m) => warnings.push(m) });

    expect(warnings).toEqual([]);
    expect(parsed.store.size).toBe(N + 1); // root + 10 minted

    // Every minted prefix is present on disk.
    for (const r of results) {
      const record = parsed.store.get(r.prefix);
      expect(record).toBeDefined();
      expect(record!.fullToken).toBe(r.token);
      expect(record!.scopes).toEqual(['kafka:endpoint:read']);
      expect(record!.name).toMatch(/^parallel-\d$/);
      expect(record!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    // The root token survived unchanged.
    const rootPrefix = ROOT_TOKEN.slice(0, 8);
    const rootRecord = parsed.store.get(rootPrefix);
    expect(rootRecord?.fullToken).toBe(ROOT_TOKEN);
    expect(rootRecord?.scopes).toBe('*');
  });
});
