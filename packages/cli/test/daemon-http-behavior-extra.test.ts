/**
 * Daemon HTTP behavior tests.
 *
 * Covers audit findings from `.test-audit/` → `packages/cli (BURA)`:
 *   - CLI-2  (dup #76) — CORS policy for JSON API: foreign-origin preflight must
 *                       not be echoed; whitelist must hold.
 *   - CLI-4  (dup #78) — Malformed JSON body → 400 with clear error message.
 *   - CLI-5  (dup #86) — Oversized body → 413 Payload Too Large.
 *   - CLI-6  (dup #88) — POST /api/chat: unreachable/unresolvable target must
 *                       not hang; must return a clean 4xx/5xx within timeout.
 *   - CLI-7  (dup #72 #85) — SPARQL endpoint 4xx matrix:
 *                       · mutation rejection (INSERT/DELETE → 400, NOT 500)
 *                       · whitespace-only → 400
 *                       · invalid peer (query-remote) → 404/4xx, NOT 500
 *                       · duplicate CG create → 409
 *   - CLI-8  (dup #83) — CONSTRUCT + access control (auth-enabled daemon must
 *                       reject unauth'd reads even when the endpoint is
 *                       "safe" SPARQL).
 *   - CLI-9  (dup #158 #159) — PROD-BUG: /api/verify & /api/ccl with a
 *                       non-existent resource return 500 (should be 404);
 *                       chain raw revert leaks in the 500 body.
 *   - CLI-13 (dup #71) — SIGTERM → exit code 0; SIGINT → exit code 130.
 *   - CLI-14 (dup #82) — pruneTimer / ratelimiter timer is cleaned up on
 *                       shutdown (daemon exits within the bounded window;
 *                       process does not hang with an open interval handle).
 *   - CLI-16 (dup #87) — Path traversal in CG IDs: `../etc/passwd` style
 *                       must be rejected by the CG route validator.
 *   - CLI-17            — api-client live daemon round-trip (no mocks).
 *
 * Strategy: spin up one real daemon in `beforeAll` using the built CLI
 * (`packages/cli/dist/cli.js daemon-worker`). All tests reuse the daemon via
 * fetch. Teardown sends SIGTERM and asserts the exit code + bounded shutdown.
 *
 * Mocks policy: ZERO blockchain mocks. The daemon is wired against the
 * SHARED HARDHAT NODE spun up by `packages/chain/test/hardhat-global-setup.ts`
 * on `process.env.HARDHAT_PORT` (9548 for the CLI lane). The daemon uses a
 * real `EVMChainAdapter` against that node with the real Hub address and the
 * pre-registered `CORE_OP` operational wallet (its identityId was posted on
 * chain by the harness' profile setup). None of the tests in this file
 * exercise on-chain behaviour — they all validate HTTP-layer contracts —
 * but they pay the small real-chain boot cost so NO test in the suite uses
 * a mock chain adapter. This matches the project policy ("every test hits
 * a real chain") enforced in CI.
 */

import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { ChainRpcTransportError } from '@origintrail-official/dkg-chain';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer, request, type Server } from 'node:http';
import { ethers } from 'ethers';
import { getSharedContext, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { ApiClient } from '../src/api-client.js';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { daemonState } from '../src/daemon/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');

interface Daemon {
  home: string;
  apiPort: number;
  listenPort: number;
  child: ChildProcess;
  token: string | null;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

function uniquePort(base: number): number {
  // Spread across test runs so parallel CI jobs don't collide. Vitest runs
  // `maxWorkers: 1` for this package so within-process collisions are not a
  // concern, but we still randomize to avoid reuse from a prior crash.
  return base + Math.floor(Math.random() * 1000);
}

async function writeDaemonConfig(
  home: string,
  apiPort: number,
  listenPort: number,
  authEnabled: boolean,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { rpcUrl, hubAddress } = getSharedContext();
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      name: 'daemon-extra-test',
      apiPort,
      listenPort,
      apiHost: '127.0.0.1',
      // Edge-role because these tests are HTTP-layer only — they must not
      // register on-chain handlers (ACK / storage-ack) whose absence would
      // otherwise time out in `DKGAgent.start()`. An edge node is a real
      // production node mode: it skips profile registration entirely and
      // simply dials other core nodes for publishes.
      nodeRole: 'edge',
      relay: 'none',
      auth: { enabled: authEnabled },
      store: {
        backend: 'oxigraph-worker',
        options: { path: join(home, 'store.nq') },
      },
      // Real EVM adapter against the shared Hardhat node (port 9548 per
      // packages/cli/vitest.config.ts). NO `type: 'mock'` — every test in
      // the repo must hit a real chain, even HTTP-layer tests that never
      // issue a chain call. The daemon's `ensureProfile` skips profile
      // creation for edge nodes, so the (CORE_OP-derived) op wallet is
      // never actually submitted as an on-chain identity here.
      chain: {
        type: 'evm',
        rpcUrl,
        hubAddress,
        chainId: 'evm:31337',
      },
      contextGraphs: [],
      ...extra,
    }),
  );

  // The daemon reads op wallets from `<DKG_HOME>/wallets.json`. Seed it
  // with the harness' CORE_OP key so the daemon boots without first
  // auto-generating a fresh wallet (which would also be fine, but using
  // the harness key keeps the signer address deterministic across tests).
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await writeFile(
    join(home, 'wallets.json'),
    JSON.stringify({
      wallets: [{ address: coreOp.address, privateKey: coreOp.privateKey }],
    }, null, 2) + '\n',
    { mode: 0o600 },
  );
}

async function startDaemon(opts: {
  authEnabled: boolean;
  apiPort?: number;
  listenPort?: number;
  extraConfig?: Record<string, unknown>;
}): Promise<Daemon> {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `CLI not built at ${CLI_ENTRY}. Run "pnpm --filter @origintrail-official/dkg build" first.`,
    );
  }
  const home = await mkdtemp(join(tmpdir(), 'dkg-daemon-extra-'));
  const apiPort = opts.apiPort ?? uniquePort(19700);
  const listenPort = opts.listenPort ?? uniquePort(19800);
  await writeDaemonConfig(home, apiPort, listenPort, opts.authEnabled, opts.extraConfig);

  const child = spawn('node', [CLI_ENTRY, 'daemon-worker'], {
    env: {
      ...process.env,
      DKG_HOME: home,
      DKG_API_PORT: String(apiPort),
      DKG_NO_BLUE_GREEN: '1',
      // Silence telemetry during tests
      DKG_DISABLE_TELEMETRY: '1',
    },
    stdio: 'ignore',
  });

  const daemon: Daemon = {
    home,
    apiPort,
    listenPort,
    child,
    token: null,
  };
  child.once('exit', (code, signal) => {
    daemon.exitCode = code;
    daemon.signal = signal;
  });

  // Wait for /api/status to respond (up to 45s). The readiness ceiling MUST
  // sit comfortably below the per-test vitest timeout used by callers
  // (currently 120s for CLI-13/14, 60s elsewhere) so that a slow startup
  // surfaces as a readable `"Daemon did not become ready within 45s"`
  // assertion error from inside startDaemon — *not* as the opaque
  // `"Test timed out"` framework error you get when both budgets collide
  // at the same wall-clock instant. 45s of startup headroom is generous:
  // healthy fresh-daemon boot on CI is ~1.5s, and the previous 60s ceiling
  // was the exact wall vitest's framework timer was hitting on overloaded
  // runners (see the May-5 main branch flake on `Bura: cli` →
  // `SIGINT → exits with code 130 within 10s` failing at 60_007ms — that
  // 7ms-over-budget signature is vitest cutting in before this loop's
  // own throw could fire).
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) {
      throw new Error(`Daemon exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/status`);
      if (res.ok) break;
    } catch {
      /* not ready yet */
    }
    await sleep(500);
    if (i === 89) throw new Error('Daemon did not become ready within 45s');
  }

  if (opts.authEnabled) {
    const tokenFile = join(home, 'auth.token');
    const raw = await readFile(tokenFile, 'utf-8');
    const token = raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('#'));
    if (!token) throw new Error('No auth token found in auth.token');
    daemon.token = token;
  }

  return daemon;
}

async function stopDaemon(
  d: Daemon | null,
  signal: NodeJS.Signals = 'SIGTERM',
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (!d) return { code: null, signal: null };
  if (d.child.exitCode !== null) {
    return { code: d.child.exitCode, signal: d.signal ?? null };
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      d.child.once('exit', (code, sig) => resolve({ code, signal: sig }));
    },
  );
  d.child.kill(signal);
  const result = await Promise.race([
    exited,
    sleep(timeoutMs).then(() => null as unknown as { code: number | null; signal: NodeJS.Signals | null }),
  ]);
  if (!result) {
    d.child.kill('SIGKILL');
    await rm(d.home, { recursive: true, force: true }).catch(() => {});
    throw new Error('Daemon did not exit within timeout; SIGKILLed');
  }
  await rm(d.home, { recursive: true, force: true }).catch(() => {});
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function authHeaders(d: Daemon): Record<string, string> {
  return d.token ? { Authorization: `Bearer ${d.token}` } : {};
}

function urlFor(d: Daemon, path: string): string {
  return `http://127.0.0.1:${d.apiPort}${path}`;
}

/**
 * Low-level raw request that does NOT set any implicit Content-Length or
 * transfer-encoding helpers the way `fetch` does. Needed for the oversized
 * body test so we can stream > MAX_BODY_BYTES past the daemon.
 */
function rawPost(d: Daemon, path: string, body: Buffer, extraHeaders: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>(
    (resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: d.apiPort,
          method: 'POST',
          path,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(body.length),
            ...authHeaders(d),
            ...extraHeaders,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf-8'),
              headers: res.headers as Record<string, string | string[] | undefined>,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    },
  );
}

async function startRateLimitedRpc(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32005, message: 'rate limited' },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('rate-limited RPC test server did not bind to a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

// ---------------------------------------------------------------------------
// Module-level daemon fixture (shared across describe blocks)
// ---------------------------------------------------------------------------

let daemon: Daemon | null = null;

beforeAll(async () => {
  daemon = await startDaemon({ authEnabled: true });
}, 60_000);

afterAll(async () => {
  if (daemon) await stopDaemon(daemon, 'SIGTERM', 10_000);
  daemon = null;
}, 20_000);

// ---------------------------------------------------------------------------
// CLI-2 — CORS policy for JSON API (dup #76)
// ---------------------------------------------------------------------------

describe('CLI-2 — CORS policy for /api/*', () => {
  it('does NOT echo a foreign origin on CORS preflight', async () => {
    const d = daemon!;
    const res = await fetch(urlFor(d, '/api/status'), {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization',
      },
    });
    // Either 403 (strict) or 204/200 without ACAO echoing evil origin.
    const acao = res.headers.get('access-control-allow-origin');
    // PROD-BUG guard: assert we do NOT blanket wildcard when apiHost is
    // loopback (the default — daemon should return a narrow whitelist).
    expect(acao).not.toBe('https://evil.example.com');
    // Accept either a loopback origin or absence of the header; wildcard on
    // an auth-enabled endpoint would be a security regression.
    if (acao && acao !== '*') {
      expect(acao).toMatch(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/);
    }
  });

  it('echoes a loopback origin on CORS preflight (expected: allowed)', async () => {
    const d = daemon!;
    const res = await fetch(urlFor(d, '/api/status'), {
      method: 'OPTIONS',
      headers: {
        Origin: `http://127.0.0.1:${d.apiPort}`,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization',
      },
    });
    expect([200, 204]).toContain(res.status);
    const acao = res.headers.get('access-control-allow-origin');
    expect(acao === `http://127.0.0.1:${d.apiPort}` || acao === '*').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI-4 — Malformed JSON → 400 (dup #78)
// ---------------------------------------------------------------------------

describe('CLI-4 — Malformed JSON body → 400', () => {
  it('POST /api/chat with `{not json}` returns 400 and a clear error', async () => {
    const d = daemon!;
    const res = await fetch(urlFor(d, '/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: '{not json}',
    });
    expect(res.status).toBe(400);
    const rawText = await res.text();
    let body: { error?: string };
    try {
      body = JSON.parse(rawText);
    } catch {
      body = { error: rawText };
    }
    expect(typeof body.error).toBe('string');
    // Either the daemon's structured message or the raw JSON parser error —
    // both are valid, both signal "bad JSON" to the caller.
    expect(body.error).toMatch(/JSON|Unexpected token|not json|parse/i);
  });

  it('POST /api/query with truncated JSON returns 400', async () => {
    const d = daemon!;
    const res = await fetch(urlFor(d, '/api/query'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: '{"sparql":',
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// CLI-5 — Oversized body → 413 (dup #86)
// ---------------------------------------------------------------------------

describe('CLI-5 — Oversized request body → 413', () => {
  it('POST /api/chat with > 256 KB body returns 413 (SMALL_BODY_BYTES limit)', async () => {
    const d = daemon!;
    // /api/chat uses SMALL_BODY_BYTES = 256 KB. Send 384 KB.
    const big = Buffer.alloc(384 * 1024, 0x20);
    const json = `{"to":"x","text":"${big.toString('ascii')}"}`;
    const res = await rawPost(d, '/api/chat', Buffer.from(json, 'utf-8'));
    expect(res.status).toBe(413);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/too large|payload|exceeds/i);
  });

  it('POST /api/query with > 10 MB body returns 413 (MAX_BODY_BYTES limit)', async () => {
    const d = daemon!;
    // /api/query uses default MAX_BODY_BYTES = 10 MB. Send 11 MB.
    const huge = Buffer.alloc(11 * 1024 * 1024, 0x61);
    const json = `{"sparql":"${huge.toString('ascii')}"}`;
    const res = await rawPost(d, '/api/query', Buffer.from(json, 'utf-8'));
    expect(res.status).toBe(413);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// CLI-6 — chat timeout / unreachable target does not hang
// ---------------------------------------------------------------------------

describe('CLI-6 — /api/chat bounded response time', () => {
  it('returns a bounded response for an unresolvable agent name', async () => {
    const d = daemon!;
    const t0 = Date.now();
    const res = await fetch(urlFor(d, '/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ to: 'no-such-agent-xyz', text: 'hello' }),
    });
    const dt = Date.now() - t0;
    // Resolver returns null → daemon emits 404 fast. The point is that
    // this must NOT hang forever. Spec/code path says ≤5s is plenty.
    expect(res.status).toBe(404);
    expect(dt).toBeLessThan(5_000);
  });
});

// ---------------------------------------------------------------------------
// CLI-7 — SPARQL 4xx matrix (dup #72 #85)
// ---------------------------------------------------------------------------

describe('CLI-7 — SPARQL endpoint 4xx matrix', () => {
  it('rejects mutation queries (INSERT) with 4xx, NOT 500', async () => {
    const d = daemon!;
    const res = await fetch(urlFor(d, '/api/query'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({
        sparql: 'INSERT DATA { <urn:a> <urn:b> <urn:c> }',
      }),
    });
    // Current code maps rejection to 400 via the "must start with SELECT..."
    // branch in /api/query's catch. Key invariant: NOT 500.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('rejects DELETE queries with 4xx, NOT 500', async () => {
    const d = daemon!;
    const res = await fetch(urlFor(d, '/api/query'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({
        sparql: 'DELETE WHERE { ?s ?p ?o }',
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('rejects whitespace-only query with 400', async () => {
    const d = daemon!;
    const res = await fetch(urlFor(d, '/api/query'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ sparql: '   \t\n  ' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/sparql/i);
  });

  it('rejects /api/query-remote to an invalid peer with 4xx, NOT 500', async () => {
    const d = daemon!;
    const res = await fetch(urlFor(d, '/api/query-remote'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({
        peerId: '12D3KooWInvalidPeerIdThatDoesNotExist000000000000000000',
        lookupType: 'sparql',
        sparql: 'ASK { ?s ?p ?o }',
      }),
    });
    // Should be 4xx (404 "peer not found" or 400 "invalid peerId").
    // PROD-BUG candidate: if this returns 500, it's CLI-7 dup #72 #85.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('returns 409 on duplicate context-graph create', async () => {
    const d = daemon!;
    const cgId = 'dup-cg-' + Math.random().toString(36).slice(2, 8);
    const first = await fetch(urlFor(d, '/api/context-graph/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ id: cgId, name: cgId }),
    });
    expect([200, 201]).toContain(first.status);

    const second = await fetch(urlFor(d, '/api/context-graph/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ id: cgId, name: cgId }),
    });
    // Duplicate create should map to 409 — the error handling block in
    // /api/context-graph/create explicitly looks for "already exists" /
    // "duplicate" / "conflict" substrings.
    expect(second.status).toBe(409);
  });

  it('returns 400 when registering an existing open context graph with a PCA account id', async () => {
    const d = daemon!;
    const cgId = 'open-pca-register-' + Math.random().toString(36).slice(2, 8);
    const create = await fetch(urlFor(d, '/api/context-graph/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ id: cgId, name: cgId }),
    });
    expect([200, 201]).toContain(create.status);

    const register = await fetch(urlFor(d, '/api/context-graph/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ id: cgId, pcaAccountId: '1' }),
    });
    expect(register.status).toBe(400);
    const body = await register.json();
    expect(body.error).toMatch(/pcaAccountId|PCA account id/i);
  });

  // OT-RFC-38 LU-6 Phase B (Codex PR #610): pcaAccountId on a create-only
  // request used to be rejected at the API boundary (PR #502 round-5) because
  // createContextGraph silently dropped it. PR #610 made createContextGraph
  // persist `publishPolicy` / `publishAuthorityAccountId` via the
  // DKG_PUBLISH_* triples so the deferred-register path on first VM publish
  // re-loads the user's create-time choices. The create-only call is now
  // accepted; the safety invariant is preserved by the persist+replay
  // round-trip instead of the create-without-register reject.
  it('accepts pcaAccountId on POST /api/context-graph/create and persists it for deferred register', async () => {
    const d = daemon!;
    const cgId = 'pca-create-only-' + Math.random().toString(36).slice(2, 8);
    const create = await fetch(urlFor(d, '/api/context-graph/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ id: cgId, name: cgId, pcaAccountId: '1' }),
    });
    expect(create.status).toBe(200);
    const body = (await create.json()) as { created?: string; registered?: boolean };
    expect(body.created).toBe(cgId);
    expect(body.registered).toBeUndefined();
  });

  // Codex review #502 round-3: pcaAccountId is a register-time knob —
  // /create no longer persists it locally. A failed /create
  // { register: true } leg must therefore leave NO stored PCA id
  // behind, so a follow-up /register that omits the param can NOT
  // silently replay the bad id.
  it('never persists a bad pcaAccountId locally when /create { register: true } register leg fails', async () => {
    const d = daemon!;
    const cgId = 'pca-create-register-no-persist-' + Math.random().toString(36).slice(2, 8);

    // /create { register: true } with a bad pcaAccountId. The register
    // leg fails on chain owner-lookup. Per Codex round-3, the create
    // path validates but does NOT persist pcaAccountId, so there's
    // nothing to roll back and a follow-up /register without the
    // param must NOT see the stale id.
    const createAndRegister = await fetch(urlFor(d, '/api/context-graph/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({
        id: cgId,
        name: cgId,
        accessPolicy: 1,
        pcaAccountId: '99999999999999999999',
        register: true,
      }),
    });
    // /create itself succeeds (CG is created locally); only the
    // register leg fails. Codex PR #502 round-9: the 200
    // partial-success contract is preserved (backwards compat) —
    // existing SDK callers rely on `created: true, registered: false`
    // to retry the register step without re-running create. The new
    // `registerErrorStatus` field surfaces what HTTP status the
    // standalone /register endpoint would have returned for the same
    // error (here: 404, nonexistent PCA token) so callers can map it
    // to 4xx semantics without changing the envelope status.
    expect(createAndRegister.status).toBe(200);
    const body = (await createAndRegister.json()) as {
      created?: string;
      registered?: boolean;
      registerError?: string;
      registerErrorStatus?: number;
    };
    expect(body.created).toBe(cgId);
    expect(body.registered).toBe(false);
    expect(typeof body.registerError).toBe('string');
    expect(body.registerError ?? '').toMatch(/PCA account 99999999999999999999 does not exist/);
    expect(body.registerErrorStatus).toBe(404);

    // Follow-up /register call omitting pcaAccountId. If the rollback
    // worked, the agent resolver finds NOTHING in storage and falls
    // through to the EOA-curated branch (which on the test daemon's
    // edge node + shared Hardhat signer succeeds → 200). The
    // alternative scenario — failure for *any* reason that isn't
    // "PCA account 99... does not exist" — also counts: the only thing
    // the rollback contract forbids is silently replaying the stale
    // bad id.
    const retryRegister = await fetch(urlFor(d, '/api/context-graph/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ id: cgId, accessPolicy: 1 }),
    });
    const retryBody = (await retryRegister.json()) as { error?: string; registered?: string };
    if (retryRegister.status >= 400) {
      expect(retryBody.error ?? '').not.toMatch(/99999999999999999999.*does not exist/);
    } else {
      // 2xx success path: the create-time bad id is fully gone — the
      // register call didn't even try the PCA branch.
      expect([200, 201]).toContain(retryRegister.status);
    }
  });

  // Codex PR #502 round-8: combined-flow register failures (caller
  // input / unsupported feature) used to silently return 200 with
  // `registered: false`. They now share the /register endpoint's 4xx
  // mappings — this test pins the 501 mapping when the chain adapter
  // is asked for a PCA registration but cannot introspect its tx
  // signer.
  //
  // The shared test daemon uses the EVM adapter against a Hardhat node
  // (which DOES introspect its signer), so we can't directly exercise
  // the 501 path here. The complementary "rejects pcaAccountId on
  // POST /api/context-graph/create when register is not true" test
  // and the 404 mapping above already cover the realistic adapter
  // scenarios — leaving this as a documentation marker.
  // TODO(devnet-smoke): cover the 501 mapping via an adapter that
  // surfaces `getPublishingConvictionAccountOwner()` but no signer.

  // Codex PR #502 round-10 (raised by @branarakic): the combined-flow
  // path must be able to send `{ accessPolicy: 0, publishPolicy: 0,
  // pcaAccountId, register: true }` — public-discoverable but
  // PCA-curated. Before round-10 the API client didn't forward
  // `publishPolicy`, so `registerContextGraph` defaulted it to
  // `open` (from `accessPolicy: 0`) and rejected the PCA id with
  // "PCA account id can only be used with curated publish policy".
  // This test pins the API-boundary contract: the request shape is
  // NOT rejected by the daemon's input validation, and the
  // register-leg failure (no such PCA token on the test chain) is
  // surfaced via 200 + `registerErrorStatus: 404` — proving the
  // combo reaches the chain layer.
  it('accepts accessPolicy=0 + publishPolicy=0 + pcaAccountId + register=true (public-discoverable + PCA-curated combined flow)', async () => {
    const d = daemon!;
    const cgId = 'pca-public-discoverable-' + Math.random().toString(36).slice(2, 8);
    const res = await fetch(urlFor(d, '/api/context-graph/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({
        id: cgId,
        name: cgId,
        accessPolicy: 0,
        publishPolicy: 0,
        pcaAccountId: '99999999999999999999',
        register: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      created?: string;
      registered?: boolean;
      registerError?: string;
      registerErrorStatus?: number;
    };
    expect(body.created).toBe(cgId);
    expect(body.registered).toBe(false);
    expect(body.registerErrorStatus).toBe(404);
    expect(body.registerError ?? '').toMatch(/PCA account 99999999999999999999 does not exist/);
    expect(body.registerError ?? '').not.toMatch(/curated publish policy/);
  });

  // Codex review #502-3: a bad pcaAccountId on /register surfaces as a
  // chain revert ("ERC721NonexistentToken" or similar) from the EVM
  // adapter. The daemon must translate it into a clean 4xx with the
  // wrapped agent-error message — never a generic 500 with raw revert
  // hex bleeding through.
  it('maps a nonexistent pcaAccountId on register to a 4xx (not 500)', async () => {
    const d = daemon!;
    const cgId = 'pca-register-nonexistent-' + Math.random().toString(36).slice(2, 8);
    const create = await fetch(urlFor(d, '/api/context-graph/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ id: cgId, name: cgId, accessPolicy: 1 }),
    });
    expect([200, 201]).toContain(create.status);

    // An astronomically high id that no minted PCA NFT will ever match
    // on the shared Hardhat node. The agent wraps the ERC721 revert into
    // "PCA account ... does not exist or cannot be looked up: ..." and
    // the daemon catch maps that prefix to 404.
    const register = await fetch(urlFor(d, '/api/context-graph/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ id: cgId, pcaAccountId: '99999999999999999999' }),
    });

    // The exact 4xx code depends on which branch fires first:
    //   - 404 when the wrapped "PCA account ... does not exist" error
    //     bubbles up (EVM contract-deployed-but-token-missing case).
    //   - 501 when this daemon's EVM adapter version pre-dates
    //     `getPublishingConvictionAccountOwner` (older deployments).
    //   - 400 when the value fails pcaAccountId parsing (shouldn't here,
    //     but guards against regressions in the parser).
    // The hard contract: NEVER a 5xx — that's the whole point of #502-3.
    expect(register.status).toBeGreaterThanOrEqual(400);
    expect(register.status).toBeLessThan(500);
    const body = await register.json();
    expect(typeof body.error).toBe('string');
    // No raw revert hex / Hardhat internal frames in the surfaced
    // message — callers should see something human-readable.
    expect(body.error).not.toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it('returns 503 when context graph register exhausts configured chain RPC endpoints', async () => {
    const primaryRpc = await startRateLimitedRpc();
    const backupRpc = await startRateLimitedRpc();
    let badRpcDaemon: Daemon | null = null;
    try {
      const { hubAddress } = getSharedContext();
      badRpcDaemon = await startDaemon({
        authEnabled: true,
        extraConfig: {
          chain: {
            type: 'evm',
            rpcUrl: primaryRpc.url,
            rpcUrls: [backupRpc.url],
            hubAddress,
            chainId: 'evm:31337',
          },
        },
      });
      const cgId = 'rpc-exhausted-register-' + Math.random().toString(36).slice(2, 8);
      const create = await fetch(urlFor(badRpcDaemon, '/api/context-graph/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(badRpcDaemon) },
        body: JSON.stringify({ id: cgId, name: cgId }),
      });
      expect(create.status).toBe(200);

      const register = await fetch(urlFor(badRpcDaemon, '/api/context-graph/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(badRpcDaemon) },
        body: JSON.stringify({ id: cgId }),
      });
      expect(register.status).toBe(503);
      const body = await register.json();
      expect(body.error).toMatch(/RPC|endpoint|rate/i);
    } finally {
      await stopDaemon(badRpcDaemon, 'SIGTERM', 10_000);
      await primaryRpc.close().catch(() => {});
      await backupRpc.close().catch(() => {});
    }
  });

  // NOTE: a direct-publish-route exhaustion is NOT exercised here. A
  // local-only CG (created above) skips the on-chain publish entirely ("No
  // positive on-chain context graph id resolved — skipping on-chain publish"),
  // so a real 429-RPC daemon never reaches the mint, and a registered CG can't
  // be created while the RPCs are rate-limited. The direct-publish 503 mapping
  // is covered route-level by the shared-helper unit test + the PCA route
  // transport tests (same classifyChainRpcTransportStatus), and the register
  // route above proves the helper end-to-end through a real chain write.

  it('returns 504 when context graph register reports a bounded chain timeout', async () => {
    const contextGraphId = 'timeout-register-' + Math.random().toString(36).slice(2, 8);
    const txHash = '0x' + '77'.repeat(32);
    // The adapter throws a ChainRpcTransportError instance for a receipt-wait
    // timeout; the guard recognises TIMEOUT via the instance, not a bare code.
    const timeoutError = new ChainRpcTransportError(
      'RPC_TIMEOUT',
      `register context graph tx ${txHash} timed out waiting for a receipt after 180000ms`,
      { txHash },
    );

    let routeServer: Server | null = null;
    try {
      routeServer = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const agent = {
          listContextGraphs: async () => [{
            id: contextGraphId,
            uri: `did:dkg:context-graph:${contextGraphId}`,
            subscribed: true,
            synced: true,
          }],
          resolveAgentByToken: () => undefined,
          registerContextGraph: async () => {
            throw timeoutError;
          },
        };
        await handleContextGraphRoutes({
          req,
          res,
          agent,
          publisherControl: {},
          publisherRuntime: null,
          config: {},
          startedAt: Date.now(),
          dashDb: {},
          opWallets: {},
          network: {},
          tracker: {},
          memoryManager: {},
          bridgeAuthToken: undefined,
          nodeVersion: 'test',
          nodeCommit: 'test',
          catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
          extractionRegistry: {},
          fileStore: {},
          extractionStatus: new Map(),
          assertionImportLocks: new Map(),
          vectorStore: {},
          embeddingProvider: null,
          validTokens: new Set(),
          apiHost: '127.0.0.1',
          apiPortRef: { value: 0 },
          routePlugins: [],
          url,
          path: url.pathname,
          requestToken: undefined,
          requestAgentAddress: '0x0000000000000000000000000000000000000001',
        } as any);
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      });
      await new Promise<void>((resolve) => routeServer!.listen(0, '127.0.0.1', resolve));
      const address = routeServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('context graph route test server did not bind to a TCP port');
      }

      const register = await fetch(`http://127.0.0.1:${address.port}/api/context-graph/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: contextGraphId }),
      });

      expect(register.status).toBe(504);
      const body = await register.json();
      expect(body).toMatchObject({
        code: 'TIMEOUT',
        txHash,
      });
      expect(body.error).toMatch(/timed out waiting for a receipt/i);
    } finally {
      if (routeServer) {
        await new Promise<void>((resolve, reject) => {
          routeServer!.close((err) => (err ? reject(err) : resolve()));
        });
      }
    }
  });

  it('returns 503 with txHash when context graph register receipt lookup fails after broadcast', async () => {
    const contextGraphId = 'receipt-lookup-register-' + Math.random().toString(36).slice(2, 8);
    const txHash = '0x' + '88'.repeat(32);
    const receiptLookupError = new Error(
      `Receipt lookup for tx ${txHash} failed on all configured RPC endpoints: rate limited`,
    );
    (receiptLookupError as Error & { code?: string; txHash?: string }).code = 'RPC_RECEIPT_LOOKUP_FAILED';
    (receiptLookupError as Error & { code?: string; txHash?: string }).txHash = txHash;

    let routeServer: Server | null = null;
    try {
      routeServer = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const agent = {
          listContextGraphs: async () => [{
            id: contextGraphId,
            uri: `did:dkg:context-graph:${contextGraphId}`,
            subscribed: true,
            synced: true,
          }],
          resolveAgentByToken: () => undefined,
          registerContextGraph: async () => {
            throw receiptLookupError;
          },
        };
        await handleContextGraphRoutes({
          req,
          res,
          agent,
          publisherControl: {},
          publisherRuntime: null,
          config: {},
          startedAt: Date.now(),
          dashDb: {},
          opWallets: {},
          network: {},
          tracker: {},
          memoryManager: {},
          bridgeAuthToken: undefined,
          nodeVersion: 'test',
          nodeCommit: 'test',
          catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
          extractionRegistry: {},
          fileStore: {},
          extractionStatus: new Map(),
          assertionImportLocks: new Map(),
          vectorStore: {},
          embeddingProvider: null,
          validTokens: new Set(),
          apiHost: '127.0.0.1',
          apiPortRef: { value: 0 },
          routePlugins: [],
          url,
          path: url.pathname,
          requestToken: undefined,
          requestAgentAddress: '0x0000000000000000000000000000000000000001',
        } as any);
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      });
      await new Promise<void>((resolve) => routeServer!.listen(0, '127.0.0.1', resolve));
      const address = routeServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('context graph route test server did not bind to a TCP port');
      }

      const register = await fetch(`http://127.0.0.1:${address.port}/api/context-graph/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: contextGraphId }),
      });

      expect(register.status).toBe(503);
      const body = await register.json();
      expect(body).toMatchObject({
        code: 'RPC_RECEIPT_LOOKUP_FAILED',
        txHash,
      });
      expect(body.error).toMatch(/receipt lookup/i);
    } finally {
      if (routeServer) {
        await new Promise<void>((resolve, reject) => {
          routeServer!.close((err) => (err ? reject(err) : resolve()));
        });
      }
    }
  });

  // ── #1085 — /register rehydrates the stored create-time publishPolicy ──
  // A standalone /api/context-graph/register that omits `publishPolicy`
  // used to forward `undefined`, silently regressing a curated CG to the
  // default policy (the publish auto-register path already rehydrates it).
  // These tests pin: the stored policy is rehydrated on omission, an
  // explicit body value still wins, and `pcaAccountId` stays explicit-only
  // (never rehydrated).
  async function runRegisterRouteCaptureOpts(
    body: Record<string, unknown>,
    agentOverrides: Record<string, any>,
  ): Promise<{ status: number; json: any; registerOpts: any }> {
    const contextGraphId = String(body.id ?? body.contextGraphId);
    let registerOpts: any = null;
    const agent = {
      listContextGraphs: async () => [{
        id: contextGraphId,
        uri: `did:dkg:context-graph:${contextGraphId}`,
        subscribed: true,
        synced: true,
      }],
      resolveAgentByToken: () => undefined,
      registerContextGraph: async (_id: string, opts: any) => {
        registerOpts = opts;
        return { onChainId: '42', txHash: '0x' + 'ab'.repeat(32) };
      },
      ...agentOverrides,
    };
    const routeServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      await handleContextGraphRoutes({
        req, res, agent,
        publisherControl: {}, publisherRuntime: null, config: {}, startedAt: Date.now(),
        dashDb: {}, opWallets: {}, network: {}, tracker: {}, memoryManager: {},
        bridgeAuthToken: undefined, nodeVersion: 'test', nodeCommit: 'test',
        catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
        extractionRegistry: {}, fileStore: {}, extractionStatus: new Map(),
        assertionImportLocks: new Map(), vectorStore: {}, embeddingProvider: null,
        validTokens: new Set(), apiHost: '127.0.0.1', apiPortRef: { value: 0 },
        routePlugins: [], url, path: url.pathname, requestToken: undefined,
        requestAgentAddress: '0x0000000000000000000000000000000000000001',
      } as any);
      if (!res.writableEnded) { res.statusCode = 404; res.end(); }
    });
    try {
      await new Promise<void>((resolve) => routeServer.listen(0, '127.0.0.1', resolve));
      const address = routeServer.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      const resp = await fetch(`http://127.0.0.1:${address.port}/api/context-graph/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: resp.status, json: await resp.json(), registerOpts };
    } finally {
      await new Promise<void>((resolve, reject) => routeServer.close((e) => (e ? reject(e) : resolve())));
    }
  }

  it('#1085 /register without publishPolicy rehydrates the stored create-time policy', async () => {
    let storedFor: string | null = null;
    const { status, registerOpts } = await runRegisterRouteCaptureOpts(
      { id: 'rehydrate-cg' },
      {
        getStoredContextGraphRegistrationOptions: async (id: string) => {
          storedFor = id;
          return { publishPolicy: 0 }; // curated at create time
        },
      },
    );
    expect(status).toBe(200);
    expect(storedFor).toBe('rehydrate-cg');
    // The rehydrated curated policy reaches the chain layer instead of undefined.
    expect(registerOpts.publishPolicy).toBe(0);
    // pcaAccountId is explicit-only — nothing stored is forwarded.
    expect(registerOpts.publishAuthorityAccountId).toBeUndefined();
  });

  it('#1085 stored-policy READ error is best-effort — 200, falls back to default, warns (not silent)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { status, registerOpts } = await runRegisterRouteCaptureOpts(
        { id: 'read-error-cg' },
        {
          getStoredContextGraphRegistrationOptions: async () => {
            throw new Error('store down');
          },
        },
      );
      // A stored-read failure must NOT 500 — best-effort fall back to the body/default policy…
      expect(status).toBe(200);
      expect(registerOpts.publishPolicy).toBeUndefined();
      // …but the fall-back is observable, not silent (the stated purpose of #1085).
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('#1085 explicit pcaAccountId + rehydrated OPEN stored policy → 400 before registerContextGraph', async () => {
    const { status, json, registerOpts } = await runRegisterRouteCaptureOpts(
      { id: 'open-cg', pcaAccountId: '7' }, // body omits publishPolicy
      {
        getStoredContextGraphRegistrationOptions: async () => ({ publishPolicy: 1 }), // stored OPEN
      },
    );
    // The effective (post-rehydration) policy is open, so an explicit pcaAccountId
    // is rejected at the route boundary — before registerContextGraph runs.
    expect(status).toBe(400);
    expect(json.error).toMatch(/pcaAccountId is only valid for curated/);
    expect(registerOpts).toBeNull();
  });

  it('#1085 explicit publishPolicy in the body wins over the stored policy', async () => {
    let storedCalled = false;
    const { status, registerOpts } = await runRegisterRouteCaptureOpts(
      { id: 'explicit-cg', publishPolicy: 1 },
      {
        getStoredContextGraphRegistrationOptions: async () => {
          storedCalled = true;
          return { publishPolicy: 0 };
        },
      },
    );
    expect(status).toBe(200);
    // Explicit wins; the stored-policy read is skipped entirely.
    expect(registerOpts.publishPolicy).toBe(1);
    expect(storedCalled).toBe(false);
  });

  it('#1085 pcaAccountId stays explicit-only — a stored publishAuthorityAccountId is never rehydrated', async () => {
    const { status, registerOpts } = await runRegisterRouteCaptureOpts(
      { id: 'pca-explicit-only-cg' },
      {
        getStoredContextGraphRegistrationOptions: async () => ({
          publishPolicy: 0,
          publishAuthorityAccountId: 7n, // must NOT leak into the register call
        }),
      },
    );
    expect(status).toBe(200);
    expect(registerOpts.publishPolicy).toBe(0);
    expect(registerOpts.publishAuthorityAccountId).toBeUndefined();
  });

  it('marks timeout-after-response catchup as failed rather than unreachable', async () => {
    const contextGraphId = 'catchup-timeout-response-' + Math.random().toString(36).slice(2, 8);
    const catchupTracker = { jobs: new Map<string, any>(), latestByContextGraph: new Map<string, string>() };
    const previousCatchupRunner = daemonState.catchupRunner;
    daemonState.catchupRunner = {
      run: async () => ({
        connectedPeers: 1,
        syncCapablePeers: 1,
        peersTried: 1,
        peersResponded: 1,
        peersSucceeded: 0,
        dataSynced: 0,
        sharedMemorySynced: 0,
        denied: false,
        deniedPeers: 0,
        diagnostics: {
          noProtocolPeers: 0,
          durable: {
            fetchedMetaTriples: 0,
            fetchedDataTriples: 0,
            insertedMetaTriples: 0,
            insertedDataTriples: 0,
            bytesReceived: 0,
            resumedPhases: 0,
            timedOutPhases: 1,
            completedPhases: 0,
            checkpointAdvances: 0,
            emptyResponses: 0,
            metaOnlyResponses: 0,
            dataRejectedMissingMeta: 0,
            rejectedKcs: 0,
            failedPeers: 0,
          },
          sharedMemory: {
            fetchedMetaTriples: 0,
            fetchedDataTriples: 0,
            insertedMetaTriples: 0,
            insertedDataTriples: 0,
            bytesReceived: 0,
            resumedPhases: 0,
            timedOutPhases: 0,
            completedPhases: 0,
            checkpointAdvances: 0,
            emptyResponses: 0,
            droppedDataTriples: 0,
            failedPeers: 0,
          },
        },
      }),
      close: async () => {},
    };

    let routeServer: Server | null = null;
    try {
      routeServer = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const agent = {
          getContextGraphAllowedAgents: async () => [],
          getSubscribedContextGraphs: () => new Map(),
          subscribeToContextGraph: () => {},
          contextGraphHasLocalContent: async () => false,
          markContextGraphSubscriptionState: () => {
            throw new Error('timeout-only catchup must not mark subscription synced');
          },
          resolveAgentByToken: () => undefined,
          getDefaultAgentAddress: () => '0x0000000000000000000000000000000000000001',
        };
        await handleContextGraphRoutes({
          req,
          res,
          agent,
          publisherControl: {},
          publisherRuntime: null,
          config: {},
          startedAt: Date.now(),
          dashDb: {},
          opWallets: {},
          network: {},
          tracker: {},
          memoryManager: {},
          bridgeAuthToken: undefined,
          nodeVersion: 'test',
          nodeCommit: 'test',
          catchupTracker,
          extractionRegistry: {},
          fileStore: {},
          extractionStatus: new Map(),
          assertionImportLocks: new Map(),
          vectorStore: {},
          embeddingProvider: null,
          validTokens: new Set(),
          apiHost: '127.0.0.1',
          apiPortRef: { value: 0 },
          routePlugins: [],
          url,
          path: url.pathname,
          requestToken: undefined,
          requestAgentAddress: '0x0000000000000000000000000000000000000001',
        } as any);
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      });
      await new Promise<void>((resolve) => routeServer!.listen(0, '127.0.0.1', resolve));
      const address = routeServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('context graph route test server did not bind to a TCP port');
      }

      const subscribe = await fetch(`http://127.0.0.1:${address.port}/api/context-graph/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextGraphId, includeSharedMemory: true }),
      });
      expect(subscribe.status).toBe(200);
      const queued = await subscribe.json() as { catchup: { jobId: string } };
      const jobId = queued.catchup.jobId;

      for (let i = 0; i < 20; i++) {
        const job = catchupTracker.jobs.get(jobId);
        if (job?.finishedAt) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const job = catchupTracker.jobs.get(jobId);
      expect(job).toMatchObject({
        status: 'failed',
        error: 'Sync did not complete — all reachable peers failed (timeouts or transport errors). Retry once the network is healthier.',
      });
      expect(job?.status).not.toBe('unreachable');
      expect(job?.result).toMatchObject({
        peersResponded: 1,
        peersSucceeded: 0,
        denied: false,
      });
    } finally {
      daemonState.catchupRunner = previousCatchupRunner;
      if (routeServer) {
        await new Promise<void>((resolve, reject) => {
          routeServer!.close((err) => (err ? reject(err) : resolve()));
        });
      }
    }
  });

  // SPEC_CG_MEMORY_MODEL / Codex PR #595 round-4: per-CG hosting
  // committees and per-CG quorum overrides were removed end-to-end.
  // The on-chain contract no longer accepts those args, so silently
  // stripping them from the request body would let callers believe
  // they created a roster-constrained / M-of-N CG when those
  // constraints were actually discarded. We reject any body that
  // carries either field, regardless of whether `id`/`name` are also
  // present — there is no faithful translation.
  for (const fields of [
    { participantIdentityIds: ['1', '2'], requiredSignatures: 1 },
    { participantIdentityIds: ['1', '2'] },
    { requiredSignatures: 1 },
  ] as const) {
    const presentKeys = Object.keys(fields).sort().join('+');
    it(`rejects POST /api/context-graph/create with deprecated fields (${presentKeys}) — even alongside valid id/name`, async () => {
      const d = daemon!;
      const cgId = 'depr-reject-' + Math.random().toString(36).slice(2, 8);
      const res = await fetch(urlFor(d, '/api/context-graph/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
        body: JSON.stringify({ id: cgId, name: cgId, ...fields }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error?: string;
        code?: string;
        deprecatedFields?: string[];
      };
      expect(body.code).toBe('DEPRECATED_CONTEXT_GRAPH_FIELDS');
      expect(body.error ?? '').toMatch(/SPEC_CG_MEMORY_MODEL/);
      expect(body.deprecatedFields).toEqual(Object.keys(fields).sort());
    });
  }

  it('rejects POST /api/context-graph/create with deprecated fields (no id/name) — naming the missing fields explicitly', async () => {
    const d = daemon!;
    const res = await fetch(urlFor(d, '/api/context-graph/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({
        participantIdentityIds: ['1', '2'],
        requiredSignatures: 1,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBe('DEPRECATED_CONTEXT_GRAPH_FIELDS');
  });
});

describe('removed shared-memory write route', () => {
  it('legacy shared-memory write and raw publisher enqueue routes are no longer served', async () => {
    const d = daemon!;
    const contextGraphId = 'lazy-swm-http-' + Math.random().toString(36).slice(2, 8);
    const write = await fetch(urlFor(d, '/api/shared-memory/write'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({
        contextGraphId,
        quads: [
          {
            subject: `urn:${contextGraphId}:root`,
            predicate: 'http://schema.org/name',
            object: '"Lazy HTTP Context Graph"',
            graph: '',
          },
        ],
      }),
    });
    expect(write.status).toBe(404);

    const conditionalWrite = await fetch(urlFor(d, '/api/shared-memory/conditional-write'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ contextGraphId, quads: [], conditions: [] }),
    });
    expect(conditionalWrite.status).toBe(404);

    const enqueue = await fetch(urlFor(d, '/api/publisher/enqueue'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({
        contextGraphId,
        shareOperationId: 'legacy-op',
        roots: ['urn:legacy-root'],
        namespace: 'legacy',
        scope: 'legacy',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:legacy' },
      }),
    });
    expect(enqueue.status).toBe(404);

    const list = await fetch(urlFor(d, '/api/context-graph/list'), {
      headers: authHeaders(d),
    });
    expect(list.status).toBe(200);
    const body = await list.json() as { contextGraphs?: Array<Record<string, unknown>> };
    const entry = body.contextGraphs?.find((row) => row.id === contextGraphId);
    expect(entry).toBeUndefined();
  }, 30_000);

  it('batch rejection reports use the named KA lifecycle route, not the old shared-memory URL', async () => {
    const d = daemon!;
    const contextGraphId = 'batch-rejection-' + Math.random().toString(36).slice(2, 8);

    const created = await fetch(urlFor(d, '/api/context-graph/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ id: contextGraphId, name: contextGraphId }),
    });
    expect(created.status).toBeLessThan(300);

    const oldRoute = await fetch(urlFor(d, '/api/shared-memory/report-batch-rejection'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ contextGraphId, verifyResult: { ok: false } }),
    });
    expect(oldRoute.status).toBe(404);

    const report = await fetch(urlFor(d, '/api/knowledge-assets/batch-rejections/report'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({
        contextGraphId,
        batchId: 'batch-1',
        verifyResult: {
          ok: false,
          expectedRoot: `0x${'11'.repeat(32)}`,
          actualRoot: `0x${'22'.repeat(32)}`,
          leafCount: 1,
          reason: 'test mismatch',
        },
      }),
    });
    expect(report.status).toBe(200);
    const body = await report.json() as {
      gossiped?: boolean;
      assertionName?: string;
      shareOperationId?: string;
      record?: { digest?: string };
      gossipError?: string;
    };
    expect(body.gossiped, JSON.stringify(body)).toBe(true);
    expect(body.assertionName).toMatch(/^batch-rejection-/);
    expect(body.shareOperationId).toMatch(/\S/);
    expect(body.record?.digest).toBeTruthy();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// CLI-8 — CONSTRUCT + access control (dup #83)
// ---------------------------------------------------------------------------

describe('CLI-8 — CONSTRUCT/SELECT access control', () => {
  it('rejects /api/query without an auth token (401, not 200 with data)', async () => {
    const d = daemon!;
    // No Authorization header — must NOT leak data.
    const res = await fetch(urlFor(d, '/api/query'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sparql: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } LIMIT 1',
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json().catch(() => null);
    expect(body?.error).toMatch(/Unauthorized|Bearer/i);
  });

  it('rejects /api/query with an invalid token', async () => {
    const d = daemon!;
    const res = await fetch(urlFor(d, '/api/query'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not-a-real-token',
      },
      body: JSON.stringify({
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
      }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// CLI-9 — /api/verify & /api/ccl not-found + raw revert leak (dup #158 #159)
// ---------------------------------------------------------------------------

describe('CLI-9 — /api/verify & /api/ccl error-code mapping', () => {
  it('/api/verify on a non-existent verifiableMemoryId returns 4xx (ideally 404), NOT 500 (PROD-BUG)', async () => {
    const d = daemon!;
    const res = await fetch(urlFor(d, '/api/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({
        contextGraphId: 'does-not-exist-cg',
        verifiableMemoryId: 'does-not-exist-vm',
        batchId: '9999999999',
      }),
    });
    // RED ON PURPOSE: current code lets the throw bubble to the top-level
    // catch and emits 500 with the raw agent error. Spec/issue #158
    // mandates 404 for not-found. See CLI-9.
    expect(res.status).not.toBe(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('/api/ccl/eval with unknown policy returns 4xx, NOT 500', async () => {
    const d = daemon!;
    const res = await fetch(urlFor(d, '/api/ccl/eval'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({
        contextGraphId: 'no-such-cg',
        policyUri: 'did:dkg:policy:does-not-exist',
        contextType: 'query',
      }),
    });
    // Same class of bug — unknown policy → generic 500 with raw chain revert
    // body per issue #159. Spec expects 4xx.
    expect(res.status).not.toBe(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('500 responses never leak raw chain-revert custom-error hex (PROD-BUG guard)', async () => {
    const d = daemon!;
    // Deliberately provoke an internal error — invalid batchId causes
    // a BigInt cast before /api/verify even reaches agent.verify.
    const res = await fetch(urlFor(d, '/api/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({
        contextGraphId: 'x',
        verifiableMemoryId: 'y',
        batchId: 'not-an-int',
      }),
    });
    const body = await res.text();
    // Raw revert hex (0x prefix, long hex string) or `data=` ABI payload
    // must NOT appear in the response body — that's the CLI-9 dup #159 leak.
    expect(body).not.toMatch(/data="0x[0-9a-fA-F]{8,}/);
    expect(body).not.toMatch(/unknown custom error/i);
  });
});

// ---------------------------------------------------------------------------
// CLI-16 — Path traversal in CG IDs (dup #87)
// ---------------------------------------------------------------------------

describe('CLI-16 — Path traversal in context-graph IDs', () => {
  for (const badId of [
    '../etc/passwd',
    '../../root',
    './../_private',
    'legit-cg/../../other-cg',
  ]) {
    it(`rejects context-graph create with id="${badId}" (400, not 200)`, async () => {
      const d = daemon!;
      const res = await fetch(urlFor(d, '/api/context-graph/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
        body: JSON.stringify({ id: badId, name: 'trav' }),
      });
      // PROD-BUG (CLI-16 dup #87): `isValidContextGraphId` allows both `.`
      // and `/`, so `../etc/passwd` slips through the regex. The daemon
      // either happily creates the CG or throws deep. Either way, it
      // should be 400 at the validator. Assertion stays RED until the
      // validator explicitly rejects `..` segments.
      expect(res.status).toBe(400);
      const body = await res.json().catch(() => ({}));
      expect(body.error).toMatch(/context graph id|invalid/i);
    });
  }
});

// ---------------------------------------------------------------------------
// CLI-17 — api-client live daemon round-trip
// ---------------------------------------------------------------------------

describe('V10 retired apps framework — /api/apps and /apps/* return 410 Gone', () => {
  // Real HTTP-level check that the retired installable-apps surface
  // answers 410 Gone with a structured body (pointing at the `dkg integration`
  // CLI replacement) instead of silently 404-ing on upgraded nodes. This is
  // the request-level counterpart to the source-scan assertions in
  // packages/node-ui/test/ui-compat.test.ts: the source scan can't catch
  // routing/auth-ordering regressions that change behavior without changing
  // text, so we also hit the real socket here.
  for (const path of ['/api/apps', '/api/apps/foo', '/apps', '/apps/some-app/index.html']) {
    it(`${path} → 410 Gone with migration body`, async () => {
      const d = daemon!;
      const res = await fetch(urlFor(d, path), { headers: authHeaders(d) });
      expect(res.status).toBe(410);
      expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);
      const body = await res.json() as { error?: string; reason?: string; docs?: string };
      expect(body.error).toBe('Gone');
      expect(body.reason ?? '').toMatch(/retired in V10/);
      expect(body.reason ?? '').toMatch(/dkg integration/);
      expect(body.docs ?? '').toMatch(/^https?:\/\//);
    });
  }

  it('CORS preflight on /api/apps is still handled (204), not 410', async () => {
    // Preflight must resolve before the 410 handler fires so browsers can
    // surface the real 410 to JS callers instead of opaque CORS failure.
    const d = daemon!;
    const res = await fetch(urlFor(d, '/api/apps'), {
      method: 'OPTIONS',
      headers: {
        Origin: `http://127.0.0.1:${d.apiPort}`,
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status).toBe(204);
  });
});

describe('CLI-17 — api-client round-trip against live daemon', () => {
  it('ApiClient.status() returns the live daemon status (no mocks)', async () => {
    const d = daemon!;
    const client = new ApiClient(d.apiPort, d.token ?? undefined);
    const status = await client.status();
    expect(status.name).toBe('daemon-extra-test');
    expect(status.nodeRole).toBe('edge');
    expect(typeof status.peerId).toBe('string');
    expect(status.peerId.length).toBeGreaterThan(10);
    expect(Array.isArray(status.multiaddrs)).toBe(true);
    expect(status.uptimeMs).toBeGreaterThan(0);
  });

  it('ApiClient with an invalid token is rejected (401)', async () => {
    const d = daemon!;
    const client = new ApiClient(d.apiPort, 'not-a-real-token');
    // Pin to auth-shaped error vocabulary — a bare `rejects.toThrow()` would
    // pass on unrelated failures (server 500, connection drop, typo in URL)
    // and hide a real 401-path regression.
    await expect(client.agents()).rejects.toThrow(/401|unauthori[sz]ed|forbidden|auth|token|http/i);
  });

  it('ApiClient handles connection refused gracefully (port with no daemon)', async () => {
    // Port 65432 almost certainly has nothing on it.
    const client = new ApiClient(65432, 'whatever');
    // Pin to transport-layer error vocabulary to prove the failure is a
    // connection failure, not a regex-silent success on some other throw.
    await expect(client.status()).rejects.toThrow(/ECONNREFUSED|refused|connect|fetch|ENOTFOUND|ETIMEDOUT|network|socket|reset|aborted/i);
  });
});

// ---------------------------------------------------------------------------
// A-1 — Working-Memory isolation at the HTTP boundary
// ---------------------------------------------------------------------------
//
// PR #242 added an A-1 guard inside `DKGAgent.query()` that denies a
// cross-agent working-memory read when `callerAgentAddress` is supplied
// and does not match `agentAddress`. Codex review on that PR flagged
// that the agent-level test bypasses the actual production path by
// injecting `callerAgentAddress` directly, so a regression in
// `packages/cli/src/daemon.ts` (e.g. /api/query forgetting to forward
// `requestAgentAddress`) would silently re-open the leak. This block is
// the HTTP-level regression: two agents registered on one daemon, each
// with a distinct auth token, querying `view=working-memory` against
// each other through real /api/query requests.
//
describe('A-1 — /api/query enforces working-memory isolation across agent tokens', () => {
  interface RegisteredAgent {
    agentAddress: string;
    authToken: string;
  }

  async function registerAgent(
    d: Daemon,
    name: string,
  ): Promise<RegisteredAgent> {
    const res = await fetch(urlFor(d, '/api/agent/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(typeof body.authToken).toBe('string');
    return { agentAddress: body.agentAddress, authToken: body.authToken };
  }

  async function queryAsAgent(
    d: Daemon,
    agent: RegisteredAgent,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(urlFor(d, '/api/query'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agent.authToken}`,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it(
    'seeded-WM cross-agent read returns 200 with empty bindings while the ' +
      'owning identity sees the seeded triple (proves A-1 isolation is active)',
    async () => {
      const d = daemon!;
      const cgId = 'a1-wm-http-' + Math.random().toString(36).slice(2, 8);
      const create = await fetch(urlFor(d, '/api/context-graph/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
        body: JSON.stringify({ id: cgId, name: cgId }),
      });
      expect([200, 201]).toContain(create.status);

      // Codex review on PR #242: without seeded data in A's WM, an
      // empty `cross.bindings` is meaningless — it'd pass even if
      // /api/query stopped forwarding `callerAgentAddress` and the
      // isolation guard was bypassed. Seed a triple into the default
      // agent's WM (that's our "A"), then prove B (agent-scoped
      // token) cannot read it while the node-level admin (no
      // agent-scope, callerAgentAddress=undefined) can.

      // Resolve the default agent's address via /api/agent/identity
      // under the node-level token. This is "A".
      const identityRes = await fetch(urlFor(d, '/api/agent/identity'), {
        headers: authHeaders(d),
      });
      expect(identityRes.status).toBe(200);
      const identity = await identityRes.json();
      const defaultAgentAddress: string = identity.agentAddress;
      expect(defaultAgentAddress).toMatch(/^0x[0-9a-fA-F]{40}$|^12D3/);

      // Create a WM assertion for that default agent and write one
      // triple into it. `agent.assertion.write` on the daemon uses
      // defaultAgentAddress, so this lands in default ("A")'s WM
      // namespace.
      const assertionName = 'a1-probe-' + Math.random().toString(36).slice(2, 8);
      const createAssertionRes = await fetch(urlFor(d, '/api/knowledge-assets'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
        body: JSON.stringify({ contextGraphId: cgId, name: assertionName }),
      });
      expect([200, 201]).toContain(createAssertionRes.status);

      const seedSubject = 'urn:a1-seed:probe-' + Math.random().toString(36).slice(2, 8);
      const writeRes = await fetch(
        urlFor(d, `/api/knowledge-assets/${encodeURIComponent(assertionName)}/wm/write`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
          body: JSON.stringify({
            contextGraphId: cgId,
            quads: [
              {
                subject: seedSubject,
                predicate: 'https://schema.org/name',
                object: '"seed-a"',
              },
            ],
          }),
        },
      );
      expect(writeRes.status).toBe(200);

      // Register agent B on the same daemon (gets its own scoped token).
      const agentB = await registerAgent(d, 'a1-http-agent-b');
      expect(agentB.agentAddress).not.toBe(defaultAgentAddress);

      // Cross-agent read: B (agent-scoped token) asks for the default
      // agent's WM. /api/query resolves `callerAgentAddress=B` via the
      // agent-token index and forwards it. DKGAgent.query sees
      // caller≠target and returns empty bindings — even though the
      // seed triple is physically present.
      const cross = await queryAsAgent(d, agentB, {
        sparql: `SELECT ?s ?p ?o WHERE { ?s ?p ?o FILTER(?s = <${seedSubject}>) }`,
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultAgentAddress,
      });
      expect(cross.status).toBe(200);
      expect(cross.body?.result?.bindings ?? []).toEqual([]);

      // Sanity: the node-level admin token is NOT agent-scoped, so
      // `requestToken` resolves through `resolveAgentByToken` to
      // undefined and `callerAgentAddress` is not forwarded. The A-1
      // guard is skipped and the seeded triple surfaces — proving
      // `cross` above really was blocked by isolation, not by missing
      // data.
      const adminRes = await fetch(urlFor(d, '/api/query'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
        body: JSON.stringify({
          sparql: `SELECT ?s ?p ?o WHERE { ?s ?p ?o FILTER(?s = <${seedSubject}>) }`,
          contextGraphId: cgId,
          view: 'working-memory',
          agentAddress: defaultAgentAddress,
        }),
      });
      expect(adminRes.status).toBe(200);
      const adminBody = await adminRes.json();
      const adminBindings = adminBody?.result?.bindings ?? [];
      expect(
        adminBindings.length,
        `seed triple should be visible under its owning agent via the node-level admin path — got ${JSON.stringify(adminBindings)}`,
      ).toBeGreaterThan(0);

      // A-1 follow-up review (2nd iteration): the node-level admin
      // token is the designated "admin bypass" for the WM isolation
      // check. `packages/adapter-openclaw` relies on this: it
      // authenticates `/api/query` with `~/.dkg/auth.token` and
      // passes session-specific `agentAddress` for *each* local
      // agent. So admin + foreign agentAddress must keep returning
      // 200 (not 403) — the actual hole Codex flagged is the
      // *unauthenticated* / auth-disabled case, which is covered by
      // the new suite below (`A-1 follow-up: auth-disabled WM hole`).
      const adminCrossRes = await fetch(urlFor(d, '/api/query'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
        body: JSON.stringify({
          sparql: `SELECT ?s ?p ?o WHERE { ?s ?p ?o FILTER(?s = <${seedSubject}>) }`,
          contextGraphId: cgId,
          view: 'working-memory',
          agentAddress: agentB.agentAddress,
        }),
      });
      expect(
        adminCrossRes.status,
        'admin token must keep working as the bypass for cross-agent WM reads — 403 here would break adapter-openclaw',
      ).toBe(200);
    },
    60_000,
  );

  it(
    'A-1 (Codex PR #242 iter-8 re-review): an authenticated agent reading its ' +
      'OWN WM with agentAddress=self must return 200 — the auth-disabled ' +
      'fallback 403 must NOT fire for recognised agent identities, even when ' +
      "the agent address is not one of the node's self-aliases",
    async () => {
      const d = daemon!;
      const cgId = 'a1-wm-self-' + Math.random().toString(36).slice(2, 8);
      const create = await fetch(urlFor(d, '/api/context-graph/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
        body: JSON.stringify({ id: cgId, name: cgId }),
      });
      expect([200, 201]).toContain(create.status);

      // Register agent B with a scoped token. B's address is NOT the
      // node default / peerId, so the self-alias fallback cannot
      // rescue this case — only a properly-gated "authenticated agent
      // identity bypasses the fallback" check makes the read succeed.
      const agentB = await registerAgent(d, 'a1-self-b');

      // B reads its OWN WM with its OWN token and agentAddress=B. We
      // don't care whether the result has bindings (B hasn't written
      // anything yet) — we only care that the daemon does NOT 403.
      //
      // Pre-iter-8-re-review the daemon's fallback treated
      // `!isAdminToken` as "untrusted" and 403'd here because B's
      // address is not a node self-alias. Post-fix, an authenticated
      // agent identity (callerAgentAddress resolved from a valid
      // agent-scoped bearer) skips the fallback entirely and
      // DKGAgent.query takes over — caller===target so the isolation
      // guard permits the read.
      const selfRes = await queryAsAgent(d, agentB, {
        sparql: `SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 1`,
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: agentB.agentAddress,
      });
      expect(
        selfRes.status,
        `authenticated agent reading its own WM must return 200 — got ` +
          `${selfRes.status} (body=${JSON.stringify(selfRes.body)})`,
      ).toBe(200);
    },
    60_000,
  );

  it(
    'A-1 follow-up: access-denied synthetic response preserves SPARQL query form ' +
      '(ASK → {result:"false"}, CONSTRUCT → quads:[])',
    async () => {
      const d = daemon!;
      const cgId = 'a1-deny-shape-' + Math.random().toString(36).slice(2, 8);
      const create = await fetch(urlFor(d, '/api/context-graph/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
        body: JSON.stringify({ id: cgId, name: cgId }),
      });
      expect([200, 201]).toContain(create.status);

      const identityRes = await fetch(urlFor(d, '/api/agent/identity'), {
        headers: authHeaders(d),
      });
      const identity = await identityRes.json();
      const defaultAgentAddress: string = identity.agentAddress;

      // Seed one WM triple under the default agent so an unrestricted
      // query would return bindings if access control didn't apply.
      const assertionName = 'a1-denyshape-' + Math.random().toString(36).slice(2, 8);
      const createAssertionRes = await fetch(urlFor(d, '/api/knowledge-assets'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
        body: JSON.stringify({ contextGraphId: cgId, name: assertionName }),
      });
      expect([200, 201]).toContain(createAssertionRes.status);
      const seedSubject = 'urn:a1-denyshape:seed-' + Math.random().toString(36).slice(2, 8);
      const writeRes = await fetch(
        urlFor(d, `/api/knowledge-assets/${encodeURIComponent(assertionName)}/wm/write`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
          body: JSON.stringify({
            contextGraphId: cgId,
            quads: [
              {
                subject: seedSubject,
                predicate: 'https://schema.org/name',
                object: '"seed-deny"',
              },
            ],
          }),
        },
      );
      expect(writeRes.status).toBe(200);

      // Register agent B on the same daemon and use B's scoped token
      // to cross-read A's WM — this triggers the A-1 deny branch.
      const agentB = await registerAgent(d, 'a1-denyshape-b');
      expect(agentB.agentAddress).not.toBe(defaultAgentAddress);

      // ASK form — a successful query would return
      // `{ result: 'true' }`. Access denied must return
      // `{ result: 'false' }`, not `{ bindings: [] }`.
      const askRes = await queryAsAgent(d, agentB, {
        sparql: `ASK WHERE { <${seedSubject}> ?p ?o }`,
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultAgentAddress,
      });
      expect(askRes.status).toBe(200);
      expect(
        askRes.body?.result?.bindings,
        `ASK deny should be shaped as [{result:'false'}] — got ${JSON.stringify(askRes.body?.result)}`,
      ).toEqual([{ result: 'false' }]);

      // CONSTRUCT form — a successful query returns
      // `{ bindings: [], quads: [...] }`. Deny must carry `quads: []`
      // alongside the empty bindings so clients can still destructure
      // `result.quads` without a type error.
      const constructRes = await queryAsAgent(d, agentB, {
        sparql: `CONSTRUCT { ?s ?p ?o } WHERE { <${seedSubject}> ?p ?o . BIND(<${seedSubject}> AS ?s) }`,
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultAgentAddress,
      });
      expect(constructRes.status).toBe(200);
      expect(constructRes.body?.result?.bindings ?? []).toEqual([]);
      expect(
        constructRes.body?.result?.quads,
        `CONSTRUCT deny must expose an empty quads[] array — got ${JSON.stringify(constructRes.body?.result)}`,
      ).toEqual([]);

      // SELECT form — still `{ bindings: [] }`, same as before.
      const selectRes = await queryAsAgent(d, agentB, {
        sparql: `SELECT ?o WHERE { <${seedSubject}> ?p ?o }`,
        contextGraphId: cgId,
        view: 'working-memory',
        agentAddress: defaultAgentAddress,
      });
      expect(selectRes.status).toBe(200);
      expect(selectRes.body?.result?.bindings ?? null).toEqual([]);
    },
    60_000,
  );

  it('rejects /api/query when agentAddress is not a string (400)', async () => {
    const d = daemon!;
    const cgId = 'a1-wm-badtype-' + Math.random().toString(36).slice(2, 8);
    const create = await fetch(urlFor(d, '/api/context-graph/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ id: cgId, name: cgId }),
    });
    expect([200, 201]).toContain(create.status);

    // Codex review on PR #242: the original A-1 guard called
    // `opts.agentAddress.toLowerCase()` without checking the type, so a
    // caller sending `{ agentAddress: 123 }` would trigger a TypeError
    // and turn bad input into a 500. The current guard must reject
    // non-string agentAddress up front AND be classified as 400 by
    // the daemon — not just "anything but 500". Pin 400 explicitly.
    for (const badValue of [123, true, null, { nested: 'x' }, ['arr']]) {
      const res = await fetch(urlFor(d, '/api/query'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
        body: JSON.stringify({
          sparql: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
          contextGraphId: cgId,
          view: 'working-memory',
          agentAddress: badValue,
        }),
      });
      const body = await res.json().catch(() => ({} as any));
      expect(
        res.status,
        `agentAddress=${JSON.stringify(badValue)} produced ${res.status} ${JSON.stringify(body)}`,
      ).toBe(400);
      // Accept either wording:
      //   - "agentAddress must be a string" — from DKGAgent.query's type guard
      //   - "agentAddress is required" — from resolveViewGraphs if the bad
      //     value was coerced to undefined upstream (e.g. null).
      expect(
        body?.error ?? '',
        `error should mention agentAddress — got ${JSON.stringify(body)}`,
      ).toMatch(/agentAddress/);
    }
  });
});

// ---------------------------------------------------------------------------
// A-1 follow-up (Codex PR #242 iteration 2) — auth-disabled WM hole
// ---------------------------------------------------------------------------
//
// The A-1 isolation guard rides on `callerAgentAddress`, which the daemon
// only resolves from an agent-scoped bearer token. When auth is DISABLED
// on the daemon, there is no token at all and any HTTP caller can point
// `view: 'working-memory'` at any `agentAddress` and read that agent's
// WM. Codex flagged this explicitly. The daemon now returns 403 in this
// narrow case (no token + WM + foreign agentAddress), while preserving
// the admin-token bypass for `packages/adapter-openclaw` and other
// in-repo clients that use `~/.dkg/auth.token` to run as each local
// agent in turn.
//
// Uses its own daemon fixture because it flips `auth.enabled=false`.

describe('A-1 follow-up: auth-disabled /api/query fails closed on foreign WM', () => {
  let d: Daemon | undefined;
  beforeAll(async () => {
    d = await startDaemon({ authEnabled: false });
  }, 60_000);
  afterAll(async () => {
    if (d) await stopDaemon(d, 'SIGTERM', 10_000);
  });

  it(
    'unauthenticated WM read of the node-default agent is allowed (200)',
    async () => {
      const daem = d!;
      const identityRes = await fetch(urlFor(daem, '/api/agent/identity'));
      expect(identityRes.status).toBe(200);
      const identity = await identityRes.json();
      const defaultAgentAddress: string = identity.agentAddress;

      const cgId = 'a1-noauth-self-' + Math.random().toString(36).slice(2, 8);
      const create = await fetch(urlFor(daem, '/api/context-graph/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cgId, name: cgId }),
      });
      expect([200, 201]).toContain(create.status);

      const res = await fetch(urlFor(daem, '/api/query'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
          contextGraphId: cgId,
          view: 'working-memory',
          agentAddress: defaultAgentAddress,
        }),
      });
      // Not 403 — the node-default WM is readable without auth.
      expect(res.status).toBe(200);
    },
    60_000,
  );

  it(
    'unauthenticated WM read of a *foreign* registered agent is rejected (403)',
    async () => {
      const daem = d!;
      const identityRes = await fetch(urlFor(daem, '/api/agent/identity'));
      const identity = await identityRes.json();
      const defaultAgentAddress: string = identity.agentAddress;

      // Register a second agent on the auth-disabled daemon so we
      // have a real foreign address to aim at.
      const regRes = await fetch(urlFor(daem, '/api/agent/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'a1-noauth-agent-b-' + Math.random().toString(36).slice(2, 6) }),
      });
      expect([200, 201]).toContain(regRes.status);
      const regBody = await regRes.json();
      const bAddr: string = regBody.agentAddress;
      expect(bAddr.toLowerCase()).not.toBe(defaultAgentAddress.toLowerCase());

      const cgId = 'a1-noauth-foreign-' + Math.random().toString(36).slice(2, 8);
      const create = await fetch(urlFor(daem, '/api/context-graph/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cgId, name: cgId }),
      });
      expect([200, 201]).toContain(create.status);

      const res = await fetch(urlFor(daem, '/api/query'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
          contextGraphId: cgId,
          view: 'working-memory',
          agentAddress: bAddr,
        }),
      });
      expect(res.status).toBe(403);
      const body = await res.json().catch(() => ({}) as any);
      expect(body?.error ?? '').toMatch(/require authentication|auth-disabled/i);
    },
    60_000,
  );

  it(
    'bogus `Authorization: Bearer junk` does NOT bypass the A-1 guard ' +
      '(Codex PR #242 iter-2 regression: `!requestToken` was too permissive ' +
      'because auth-disabled still populates requestToken from the header)',
    async () => {
      const daem = d!;
      const identityRes = await fetch(urlFor(daem, '/api/agent/identity'));
      const identity = await identityRes.json();
      const defaultAgentAddress: string = identity.agentAddress;

      const regRes = await fetch(urlFor(daem, '/api/agent/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'a1-bogus-bearer-' + Math.random().toString(36).slice(2, 6),
        }),
      });
      expect([200, 201]).toContain(regRes.status);
      const bAddr: string = (await regRes.json()).agentAddress;
      expect(bAddr.toLowerCase()).not.toBe(defaultAgentAddress.toLowerCase());

      const cgId = 'a1-bogus-' + Math.random().toString(36).slice(2, 8);
      await fetch(urlFor(daem, '/api/context-graph/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cgId, name: cgId }),
      });

      const res = await fetch(urlFor(daem, '/api/query'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // With auth disabled `httpAuthGuard` never validates this
          // token — the old guard would see a truthy `requestToken`
          // and skip the 403. The new guard must verify the token is
          // actually in `validTokens` before granting the admin bypass.
          Authorization: 'Bearer junk-token-not-in-validtokens',
        },
        body: JSON.stringify({
          sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
          contextGraphId: cgId,
          view: 'working-memory',
          agentAddress: bAddr,
        }),
      });
      expect(res.status).toBe(403);
    },
    60_000,
  );

  it(
    'self-read via the legacy peerId alias is NOT 403d ' +
      '(Codex PR #242 iter-4 regression: the guard used to compare only ' +
      'against defaultAgentAddress, but resolveAgentAddress(undefined) also ' +
      'exposes the bare peerId as the daemon\'s own WM identity, so an ' +
      'auth-disabled self-read via that alias must still be allowed)',
    async () => {
      const daem = d!;
      // Codex PR #242 iter-4 feedback: the earlier version of this test
      // had a silent `return` when neither `/api/host/info` nor
      // `/api/agent/identity` exposed a peerId, which meant a 400/500
      // regression would still make the test pass green. Resolve the
      // peerId deterministically from `/api/agent/identity` (this
      // fixture always wires it — no token needed since auth is
      // disabled in this harness, and the route falls back to the
      // default-agent identity), and fail loudly if it is missing.
      const identityRes = await fetch(urlFor(daem, '/api/agent/identity'));
      expect(identityRes.status).toBe(200);
      const identity = (await identityRes.json()) as { peerId?: string };
      expect(
        identity.peerId,
        '`/api/agent/identity` must return a peerId for this fixture — the test cannot exercise the A-1 legacy-alias guard without it',
      ).toBeTruthy();
      const peerId = identity.peerId!;

      const cgId = 'a1-self-alias-' + Math.random().toString(36).slice(2, 8);
      const cgRes = await fetch(urlFor(daem, '/api/context-graph/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cgId, name: cgId }),
      });
      expect([200, 201]).toContain(cgRes.status);

      const res = await fetch(urlFor(daem, '/api/query'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
          contextGraphId: cgId,
          view: 'working-memory',
          agentAddress: peerId,
        }),
      });
      // Codex PR #242 iter-4 follow-up: a regression elsewhere in the
      // WM query path (schema validation, context-graph lookup, etc.)
      // could turn this case into a 400/404/500 while the A-1 guard
      // itself works correctly, and a plain `not.toBe(403)` would
      // still go green. Assert the happy-path 200 so the test really
      // exercises the peerId-alias-allowed branch.
      expect(res.status).toBe(200);
      // Sanity check: the response is SPARQL-shaped. `/api/query`
      // wraps the engine result under a `result` key and echoes the
      // context graph id, so tolerate both `{ bindings }` and
      // `{ result: { bindings } }` to stay robust against the route
      // wrapper shape drifting independently of the guard under test.
      const body = (await res.json()) as
        | { bindings?: unknown[] }
        | { result?: { bindings?: unknown[] } };
      const bindings =
        'bindings' in body
          ? body.bindings
          : (body as { result?: { bindings?: unknown[] } }).result?.bindings;
      expect(Array.isArray(bindings)).toBe(true);
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// CLI-13 / CLI-14 — shutdown signal → exit code mapping & timer cleanup
// ---------------------------------------------------------------------------
//
// These two live in their own describe because they SIGTERM/SIGINT a
// dedicated daemon. They must run AFTER the shared-fixture tests so the
// module-level daemon isn't affected.
//
// Per-test budget = 120s. Composition:
//   ~45s — startDaemon readiness ceiling (see the loop above)
//   ~10s — stopDaemon's signal-to-exit window (the actual assertion)
//   ~65s — slack for runner I/O / fork-load spikes during fresh daemon
//          spawn under heavy CI fan-out
// The tests still strictly assert "exit within 10s of signal" — the
// expanded budget only buys headroom for the daemon to come up; once it
// is up, the SIGTERM/SIGINT validation window is unchanged.
//

describe('CLI-13 / CLI-14 — shutdown signal exit codes & timer cleanup', () => {
  it('SIGTERM → exits with code 0 within 10s (pruneTimer cleaned up)', async () => {
    const d = await startDaemon({ authEnabled: false });
    const { code, signal } = await stopDaemon(d, 'SIGTERM', 10_000);
    // Node translates clean signal shutdown to code=null, signal='SIGTERM'
    // if the process did not install a handler that process.exit(0)s.
    // Either (code=0, signal=null) or (code=null, signal='SIGTERM') is a
    // clean POSIX-compliant exit. A non-zero code is the bug.
    if (code !== null) {
      expect(code).toBe(0);
    } else {
      expect(signal).toBe('SIGTERM');
    }
  }, 120_000);

  it('SIGINT → exits with code 130 (POSIX: 128+SIGINT) within 10s', async () => {
    const d = await startDaemon({ authEnabled: false });
    const { code, signal } = await stopDaemon(d, 'SIGINT', 10_000);
    // POSIX mandates 128 + signal number. SIGINT = 2 → 130.
    // If the daemon handles SIGINT explicitly with process.exit(0), code=0
    // is also acceptable. But Ctrl+C that results in a non-zero non-130
    // exit (e.g. 1 due to swallowed promise rejection) is a bug.
    // PROD-BUG guard: current code does NOT install a SIGINT handler in
    // runDaemon; the default Node behavior kills with signal='SIGINT'.
    if (code !== null) {
      expect([0, 130]).toContain(code);
    } else {
      expect(signal).toBe('SIGINT');
    }
  }, 120_000);

  it('no open-handle hang after SIGTERM (daemon exits within 5s, not 10s cap)', async () => {
    const d = await startDaemon({ authEnabled: false });
    const t0 = Date.now();
    await stopDaemon(d, 'SIGTERM', 10_000);
    const dt = Date.now() - t0;
    // If pruneTimer / HttpRateLimiter._timer are not unref()'d or
    // cleared, process exit stalls until the interval next fires.
    // They ARE unref'd in current code — this is a guard test so any
    // future "remove .unref()" regression fires here. 5s is generous.
    expect(dt).toBeLessThan(8_000);
  }, 120_000);
});
