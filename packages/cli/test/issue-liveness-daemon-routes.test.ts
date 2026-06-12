/**
 * Issue-liveness regression tests — daemon HTTP route contracts.
 *
 * One real auth-enabled daemon (edge role) against the shared Hardhat node
 * (port 9548 per packages/cli/vitest.config.ts). Zero chain mocks. Each test
 * reproduces a confirmed-live production bug from the rc.17 QA sweep and asserts
 * the CORRECT behaviour, so it is RED while the bug is live and GREEN once fixed
 * (then close the linked GitHub issue). These repros are EXCLUDED from the normal
 * `pnpm test` CLI lane (which must stay green / mergeable) via the
 * `RUN_ISSUE_LIVENESS` gate, and run red only on the dedicated issue-liveness
 * lane (`RUN_ISSUE_LIVENESS=1`).
 *
 * Covered:
 *   #787  — POST /api/shared-memory/write with N-Quad *string* quads → 500
 *           "Cannot read properties of undefined (reading 'toLowerCase')"
 *           https://github.com/OriginTrail/dkg/issues/787
 *   #306  — POST /api/knowledge-assets/{name}/wm/write with string quads → 500
 *           "Cannot use 'in' operator to search for 'graph' in <s> <p> <o> ."
 *           https://github.com/OriginTrail/dkg/issues/306
 *   #158  — POST /api/ccl/eval with a real CG + unknown policy → 500 (want 404)
 *           https://github.com/OriginTrail/dkg/issues/158
 *   #309  — GET /api/status omits `defaultAgentAddress`, leaving integrations
 *           unable to scope working-memory queries.
 *           https://github.com/OriginTrail/dkg/issues/309
 *   #757  — GET /api/context-graph/{id}/join-requests is NOT curator-gated
 *           server-side: any valid bearer token can read another curator's
 *           pending-moderation data. https://github.com/OriginTrail/dkg/issues/757
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';
import { getSharedContext, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';

// Opt-in gate: these repros assert post-fix behaviour, so they are RED while
// the bug is live. They are EXCLUDED from the default test lane (which must stay
// green / mergeable) and run only under `RUN_ISSUE_LIVENESS=1` (the dedicated
// issue-liveness CI lane). See package.json `test:issue-liveness`.
const LIVENESS_ENABLED = process.env.RUN_ISSUE_LIVENESS === '1';


const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');

interface Daemon {
  home: string;
  apiPort: number;
  child: ChildProcess;
  token: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let portCounter = 0;
const uniquePort = (base: number) => base + (portCounter++ % 200);

async function startDaemon(): Promise<Daemon> {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`CLI not built at ${CLI_ENTRY}. Run the package build first.`);
  }
  const home = await mkdtemp(join(tmpdir(), 'dkg-liveness-routes-'));
  const apiPort = uniquePort(19960);
  const listenPort = uniquePort(20160);
  const { rpcUrl, hubAddress } = getSharedContext();

  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      name: 'liveness-routes-test',
      apiPort,
      listenPort,
      apiHost: '127.0.0.1',
      nodeRole: 'edge',
      relay: 'none',
      auth: { enabled: true },
      store: { backend: 'oxigraph-worker', options: { path: join(home, 'store.nq') } },
      chain: { type: 'evm', rpcUrl, hubAddress, chainId: 'evm:31337' },
      contextGraphs: [],
    }),
  );
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await writeFile(
    join(home, 'wallets.json'),
    JSON.stringify({ wallets: [{ address: coreOp.address, privateKey: coreOp.privateKey }] }, null, 2) + '\n',
    { mode: 0o600 },
  );

  const child = spawn('node', [CLI_ENTRY, 'daemon-worker'], {
    env: { ...process.env, DKG_HOME: home, DKG_API_PORT: String(apiPort), DKG_NO_BLUE_GREEN: '1', DKG_DISABLE_TELEMETRY: '1' },
    stdio: 'ignore',
  });

  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw new Error(`Daemon exited early (${child.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/status`);
      if (res.ok) break;
    } catch { /* not ready */ }
    await sleep(500);
    if (i === 89) throw new Error('Daemon did not become ready within 45s');
  }

  const raw = await readFile(join(home, 'auth.token'), 'utf-8');
  const token = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('#'));
  if (!token) throw new Error('No auth token');
  return { home, apiPort, child, token };
}

let daemon: Daemon | null = null;
const CG = 'liveness-routes-cg';

function url(path: string): string {
  return `http://127.0.0.1:${daemon!.apiPort}${path}`;
}
function headers(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon!.token}` };
}

beforeAll(async () => {
  // Opt-in: don't spin a real daemon in the default lane (all repros are
  // gated/skipped there). Only the dedicated issue-liveness run needs it.
  if (!LIVENESS_ENABLED) return;
  daemon = await startDaemon();
  // CURATED CG (accessPolicy:1): #757 is about curator-only moderation access,
  // so the CG must actually have a curator (the daemon's default agent) for a
  // non-curator token to be a meaningful 403 target. Local CG is enough — these
  // are HTTP-contract bugs that fire before any chain op (an edge daemon can't
  // on-chain register anyway).
  const res = await fetch(url('/api/context-graph/create'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ id: CG, name: 'Liveness Routes CG', accessPolicy: 1 }),
  });
  if (!res.ok) throw new Error(`CG create failed: ${res.status} ${await res.text()}`);
}, 120_000);

afterAll(async () => {
  if (daemon) {
    daemon.child.kill('SIGTERM');
    await sleep(1500);
    if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
    await rm(daemon.home, { recursive: true, force: true }).catch(() => {});
  }
});

describe.runIf(LIVENESS_ENABLED)('GH #787 — SWM write with N-Quad string quads', () => {
  it('returns a 4xx (not 500) for string-shaped quads', async () => {
    const res = await fetch(url('/api/shared-memory/write'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        contextGraphId: CG,
        quads: ['<http://example.org/s787> <http://example.org/p> "v" .'],
      }),
    });
    expect(res.status).not.toBe(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe.runIf(LIVENESS_ENABLED)('GH #306 — KA wm/write with N-Quad string quads', () => {
  it('returns a 4xx (not 500) for string-shaped quads', async () => {
    await fetch(url('/api/knowledge-assets'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ contextGraphId: CG, name: 'ka-306' }),
    });
    const res = await fetch(url('/api/knowledge-assets/ka-306/wm/write'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ contextGraphId: CG, quads: ['<urn:s> <urn:p> <urn:o> .'] }),
    });
    expect(res.status).not.toBe(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe.runIf(LIVENESS_ENABLED)('GH #158 — CCL not-found error mapping (with a real CG)', () => {
  it('ccl/eval on an existing CG with an unknown policy returns 4xx not 500', async () => {
    const res = await fetch(url('/api/ccl/eval'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ contextGraphId: CG, name: 'no-such-policy' }),
    });
    expect(res.status).not.toBe(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe.runIf(LIVENESS_ENABLED)('GH #309 — /api/status exposes the default agent address', () => {
  it('status body carries a real defaultAgentAddress for WM-query scoping', async () => {
    const res = await fetch(url('/api/status'), { headers: { Authorization: `Bearer ${daemon!.token}` } });
    const body = (await res.json()) as Record<string, unknown>;
    // Must be a usable EVM address — `null`/`""`/`undefined` still leaves
    // integrations unable to scope WM queries, so `toBeDefined()` is too weak.
    expect(body.defaultAgentAddress, `defaultAgentAddress=${JSON.stringify(body.defaultAgentAddress)}`)
      .toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe.runIf(LIVENESS_ENABLED)('GH #757 — join-requests endpoint must be curator-gated', () => {
  it(
    'a non-curator agent token is rejected (403) from reading another CG curator\'s join-requests',
    async () => {
      // The CG (created in beforeAll with the node-admin/default-agent token)
      // is curated by the default agent. Register a SEPARATE agent and use its
      // token — it is NOT the curator and must not read moderation data.
      const reg = await fetch(url('/api/agent/register'), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ name: 'gh757-non-curator', framework: 'test' }),
      });
      const regBody = (await reg.json()) as { authToken?: string };
      expect(regBody.authToken, 'agent register should return a token').toBeTruthy();

      const res = await fetch(url(`/api/context-graph/${CG}/join-requests`), {
        headers: { Authorization: `Bearer ${regBody.authToken}` },
      });
      // Correct: 403 (not the curator). Bug: 200 with the pending-request data.
      expect(res.status).toBe(403);
    },
  );
});
