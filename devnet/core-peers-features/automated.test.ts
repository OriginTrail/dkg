/**
 * Core-peers features — devnet validation of the chain-driven VM
 * reconciliation effort (Phases B / C / D / E / F).
 *
 * Confirms, against a live 6-node devnet (4 core + 2 edge), that the
 * "full Telegram on top of chain" stack is functional end-to-end:
 *
 *   Phase F — every node serves the `/api/replication/*` surface
 *             (summary / per-cg / timeline / cursors / events) backed by the
 *             V19 `replication_events` table. (Pure API/DB wiring check.)
 *
 *   Phase B + E — publishing a KA to a public CG drives the chain-driven VM
 *             reconciler: cores accumulate replication telemetry, the per-CG
 *             contiguous watermark advances past 0, and the daemon log carries
 *             the structured `chain-promote` grep surface.
 *
 *   Phase D (recording) — when a core signs a StorageACK for a PUBLIC CG it
 *             marks the CG `coreHosted` (cursor inspector Role = host),
 *             persisted across restart.
 *
 *   Phase D (fill-the-gap, headline) — a core taken OFFLINE during a publish
 *             learns the missed KA from chain on restart and fills its own gap
 *             (observable as a `core-fill` replication event and/or the missed
 *             triple landing in that core's verifiable-memory).
 *
 *   Phase C — the `sinceBatchId` delta-sync hint is an additive, unsigned,
 *             backward-compatible protocol field with no active production
 *             caller yet (the contiguous-watermark resolver is intentionally
 *             unwired). We assert only that normal catch-up sync is unaffected
 *             — its responder/envelope behaviour is pinned by the agent unit
 *             tests (`sync-responder-cursor`, `sync-envelope-cursor`).
 *
 * Preconditions:
 *   pnpm run build
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *
 * Run:
 *   pnpm test:devnet:core-peers-features
 *
 * Runtime: ~3-6 minutes (the fill-the-gap test stops + restarts a core and
 * waits a couple of reconcile sweeps).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as http from 'node:http';
import { ethers } from 'ethers';
import { runKaPublishLifecycle } from '../_bootstrap/harness';

// ───────────────────────────── constants ─────────────────────────────────
const REPO_ROOT = resolve(__dirname, '../..');
const DEVNET_DIR = join(REPO_ROOT, '.devnet');
/** RPC is read from node1's config (devnet.sh wires it from HARDHAT_PORT), so a
 *  non-default Hardhat port works without editing the test. */
function detectRpc(): string {
  if (process.env.DEVNET_RPC) return process.env.DEVNET_RPC;
  try {
    const cfg = JSON.parse(readFileSync(join(DEVNET_DIR, 'node1', 'config.json'), 'utf8'));
    if (cfg?.chain?.rpcUrl) return cfg.chain.rpcUrl;
  } catch { /* fall through */ }
  return 'http://127.0.0.1:8545';
}
const RPC = detectRpc();
const DEVNET_SH = join(REPO_ROOT, 'scripts/devnet.sh');
const CONTEXT_GRAPH = 'devnet-test';
const CORE_NODES = [1, 2, 3, 4];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── node harness ──────────────────────────────
interface DevnetNode {
  num: number;
  apiPort: number;
  home: string;
  authToken: string;
}

function readNodeConfig(num: number): DevnetNode {
  const home = join(DEVNET_DIR, `node${num}`);
  if (!existsSync(home)) {
    throw new Error(`Devnet node${num} home missing — run ./scripts/devnet.sh start 6 first`);
  }
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  let authToken = '';
  if (existsSync(join(home, 'auth.token'))) {
    authToken =
      readFileSync(join(home, 'auth.token'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith('#')) ?? '';
  }
  return { num, apiPort: config.apiPort, home, authToken };
}

function api(node: DevnetNode): string {
  return `http://127.0.0.1:${node.apiPort}`;
}

/** Port env for `devnet.sh restart-node`, derived from node1's config so the
 *  restart matches whatever (possibly non-default) ports this devnet uses. */
function devnetPortEnv(): Record<string, string> {
  const cfg = JSON.parse(readFileSync(join(DEVNET_DIR, 'node1', 'config.json'), 'utf8'));
  const rpcPort = new URL(RPC).port || '8545';
  return {
    HARDHAT_PORT: rpcPort,
    API_PORT_BASE: String(cfg.apiPort ?? 9201),
    LIBP2P_PORT_BASE: String(cfg.listenPort ?? 10001),
  };
}

/** Every pid that belongs to a node. `devnet.pid` is just the `cli.js start`
 *  launcher, which double-forks the real worker (`daemon.pid`, reparented to
 *  init) and then EXITS — so killing only `devnet.pid` leaves the API serving.
 *  Return both (daemon first) so the caller can take the node truly offline. */
function readNodePids(num: number): number[] {
  const pids: number[] = [];
  for (const f of ['daemon.pid', 'devnet.pid']) {
    const pidf = join(DEVNET_DIR, `node${num}`, f);
    if (!existsSync(pidf)) continue;
    const pid = parseInt(readFileSync(pidf, 'utf8').trim(), 10);
    if (Number.isFinite(pid) && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/** Remove a node's pid files. After a manual SIGKILL the files still hold the
 *  now-dead PIDs; `devnet.sh restart-node` trusts them and could signal an
 *  unrelated process if the OS recycled a PID before the restart. Clear them
 *  so the restart starts from a clean slate. */
function clearNodePidFiles(num: number): void {
  for (const f of ['daemon.pid', 'devnet.pid']) {
    const pidf = join(DEVNET_DIR, `node${num}`, f);
    try { if (existsSync(pidf)) rmSync(pidf); } catch { /* best-effort */ }
  }
}

// ───────────────────────────── HTTP helpers ──────────────────────────────
function request(
  method: 'GET' | 'POST',
  url: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolveP, rejectP) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        method,
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolveP({ status: res.statusCode ?? 0, body: JSON.parse(buf) });
          } catch {
            resolveP({ status: res.statusCode ?? 0, body: buf });
          }
        });
      },
    );
    req.on('error', rejectP);
    if (data) req.write(data);
    req.end();
  });
}

const getJson = (node: DevnetNode, path: string) => request('GET', api(node) + path, node.authToken);
const postJson = (node: DevnetNode, path: string, body: unknown) =>
  request('POST', api(node) + path, node.authToken, body);

/** Interpret an `/api/query` ASK response across the shapes the node may emit.
 *  The current store returns `{ result: { bindings: [{ result: "true" }] } }`;
 *  older/simple paths use `{ boolean }` or `{ value }`. Accept all. */
function askIsTrue(body: any): boolean {
  if (typeof body?.boolean === 'boolean') return body.boolean;
  if (typeof body?.value === 'boolean') return body.value;
  const bindings = body?.result?.bindings;
  if (Array.isArray(bindings) && bindings.length > 0) {
    const first = bindings[0] ?? {};
    const v = first.result ?? first.boolean ?? Object.values(first)[0];
    return v === true || v === 'true';
  }
  return false;
}

async function nodeReachable(node: DevnetNode): Promise<boolean> {
  try {
    const r = await request('GET', api(node) + '/api/status', node.authToken);
    return r.status === 200;
  } catch {
    return false;
  }
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  intervalMs: number,
  probe: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

// ───────────────────────────── publish helpers ───────────────────────────
function runDkgCli(node: DevnetNode, args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'packages/cli/dist/cli.js'), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, DKG_NO_BLUE_GREEN: '1', DKG_HOME: node.home, DKG_API_PORT: String(node.apiPort) },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectResult(new Error(`dkg CLI timeout after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({ code: code ?? -1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectResult(err);
    });
  });
}

/** Write a unique nquads file and return its path + the subject we can later look for in VM. */
function makeWitnessFile(name: string): { path: string; subject: string; literal: string } {
  const dir = join(__dirname, 'turns');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ts = Date.now().toString(36);
  const subject = `urn:test:core-peers:${name}:${ts}`;
  const literal = `core-peers ${name} ${ts}`;
  const path = join(dir, `${name}-${ts}.nq`);
  const g = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
  writeFileSync(
    path,
    `<${subject}> <https://schema.org/name> "${literal}" <${g}> .\n` +
      `<${subject}> <https://schema.org/description> "core-peers feature devnet" <${g}> .\n`,
  );
  return { path, subject, literal };
}

let publishSeq = 0;

async function publishFromCore(node: DevnetNode, name: string): Promise<{ subject: string; literal: string; kaId?: string; status: string }> {
  const witness = makeWitnessFile(name);
  // #1410 replaced the one-shot `dkg publish <cg> --file` with the KA
  // lifecycle CLI (`ka create --share` then `ka publish`) — argument arrays +
  // Status:/KA ID: stdout parsing live in the shared runKaPublishLifecycle
  // (../_bootstrap/harness), which returns status lowercased; this suite keeps
  // its own CLI spawn (120s timeout).
  const result = await runKaPublishLifecycle((args) => runDkgCli(node, args), {
    kaName: `cpf-pub-${Date.now().toString(36)}-${++publishSeq}`,
    contextGraphId: CONTEXT_GRAPH,
    inputFile: witness.path,
  });
  const status = result.status;
  const kaId = result.kaId !== undefined ? String(result.kaId) : undefined;
  // Greedy publish-outcome gate: exit 0 is not proof of a real publish. Pin a
  // known success status and a positive kaId so a failed/'unknown' status or a
  // missing "KA ID:" line fails here instead of passing as a green publish.
  const publishOk = ['confirmed', 'finalized', 'tentative'];
  expect(
    publishOk,
    `publish status="${status}", expected one of ${publishOk.join('/')}\n${result.raw}`,
  ).toContain(status);
  expect(
    BigInt(kaId ?? '0'),
    `publish surfaced no positive "KA ID:" (kaId="${kaId}")\n${result.raw}`,
  ).toBeGreaterThan(0n);
  return { subject: witness.subject, literal: witness.literal, kaId, status };
}

async function ensureIdentity(node: DevnetNode): Promise<void> {
  const st = await getJson(node, '/api/status');
  if (st.status === 200 && BigInt(st.body?.identityId ?? '0') > 0n) return;
  await postJson(node, '/api/identity/ensure', {});
  await waitFor(`node${node.num} identity`, 30_000, 1_000, async () => {
    const s = await getJson(node, '/api/status');
    return s.status === 200 && BigInt(s.body?.identityId ?? '0') > 0n ? true : null;
  });
}

function daemonLogTail(num: number, maxBytes = 2_000_000): string {
  const logf = join(DEVNET_DIR, `node${num}`, 'daemon.log');
  if (!existsSync(logf)) return '';
  const buf = readFileSync(logf);
  return buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8');
}

// ───────────────────────────── fixtures ──────────────────────────────────
let nodes: Record<number, DevnetNode>;

beforeAll(async () => {
  if (!existsSync(DEVNET_DIR)) {
    throw new Error(`${DEVNET_DIR} missing — run \`./scripts/devnet.sh clean && ./scripts/devnet.sh start 6\` first.`);
  }
  // Hardhat must be reachable.
  const provider = new ethers.JsonRpcProvider(RPC, { chainId: 31337, name: 'localhost' });
  const chainId = await provider.send('eth_chainId', []);
  expect(chainId, 'devnet hardhat not reachable on :8545').toBeTruthy();

  nodes = {};
  for (let i = 1; i <= 6; i++) nodes[i] = readNodeConfig(i);

  // Cores need an on-chain identity to publish + sign ACKs.
  for (const n of CORE_NODES) await ensureIdentity(nodes[n]!);
}, 180_000);

// ─────────────────── 1. Phase F — replication API surface ─────────────────
describe('Phase F — /api/replication surface is served by every node', () => {
  it('summary / per-cg / timeline / cursors respond well-formed on all cores + an edge', async () => {
    for (const n of [...CORE_NODES, 5]) {
      const node = nodes[n]!;

      const summary = await getJson(node, '/api/replication/summary?periodMs=86400000');
      expect(summary.status, `node${n} summary: ${JSON.stringify(summary.body)}`).toBe(200);
      expect(summary.body).toHaveProperty('counts');
      expect(summary.body).toHaveProperty('promotes');
      expect(summary.body).toHaveProperty('successRate'); // null or number
      expect(typeof summary.body.totalEvents).toBe('number');

      const perCg = await getJson(node, '/api/replication/per-cg?periodMs=86400000');
      expect(perCg.status).toBe(200);
      expect(Array.isArray(perCg.body.rows)).toBe(true);

      const timeline = await getJson(node, '/api/replication/timeline?periodMs=86400000&bucketMs=3600000');
      expect(timeline.status).toBe(200);
      expect(Array.isArray(timeline.body.buckets)).toBe(true);

      const cursors = await getJson(node, '/api/replication/cursors');
      expect(cursors.status).toBe(200);
      expect(Array.isArray(cursors.body.cursors)).toBe(true);
    }
  }, 60_000);

  it('events endpoint requires a cg param (400) and returns an array when given one', async () => {
    const node = nodes[1]!;
    const missing = await getJson(node, '/api/replication/events');
    expect(missing.status).toBe(400);
    const ok = await getJson(node, `/api/replication/events?cg=${encodeURIComponent(CONTEXT_GRAPH)}&limit=10`);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.events)).toBe(true);
  }, 30_000);
});

// ────────── 2. Phase B + E — reconciler runs, watermark + telemetry ─────────
describe('Phase B + E — chain-driven VM reconciliation + structured telemetry', () => {
  it('a public publish advances a per-CG watermark and emits chain-promote telemetry on a core', async () => {
    // Publish from a core so the KA is registered on-chain under CONTEXT_GRAPH.
    const pub = await publishFromCore(nodes[1]!, 'reconcile');
    expect(pub.status, `publish status=${pub.status}`).toBe('confirmed');

    // The reconcile sweep (periodic, plus the live KACG nudge) should run on
    // the cores and advance the contiguous watermark for this CG past 0, with
    // telemetry persisted. Poll all cores; succeed on the first that shows it.
    const hit = await waitFor(
      'a core cursor watermark > 0 for CONTEXT_GRAPH with telemetry',
      120_000,
      4_000,
      async () => {
        for (const n of CORE_NODES) {
          const node = nodes[n]!;
          const cursors = await getJson(node, '/api/replication/cursors');
          if (cursors.status !== 200) continue;
          const row = (cursors.body.cursors as any[]).find((c) => c.context_graph_id === CONTEXT_GRAPH);
          const summary = await getJson(node, '/api/replication/summary?periodMs=86400000');
          const totalEvents = summary.body?.totalEvents ?? 0;
          if (row && (row.last_reconciled_ordinal ?? 0) > 0 && totalEvents > 0) {
            return { node: n, ordinal: row.last_reconciled_ordinal, totalEvents };
          }
        }
        return null;
      },
    );
    expect(hit.ordinal).toBeGreaterThan(0);

    // Phase E grep surface: the daemon log carries structured chain-promote lines.
    const log = daemonLogTail(hit.node);
    expect(log, `node${hit.node} daemon.log missing 'chain-promote' lines`).toMatch(/chain-promote action=/);
  }, 200_000);
});

// ────────────────── 3. Phase D — core-hosted recording + fill ──────────────
describe('Phase D — Cores host public CGs and fill their own gaps', () => {
  it('a core marks the public CG core-hosted (cursor Role = host), persisted', async () => {
    // The publish in suite 2 made every core sign a StorageACK for the public
    // CONTEXT_GRAPH, which marks it coreHosted. Poll cores for core_hosted=1.
    const host = await waitFor(
      'a core cursor with core_hosted=1 for CONTEXT_GRAPH',
      90_000,
      4_000,
      async () => {
        for (const n of CORE_NODES) {
          const cursors = await getJson(nodes[n]!, '/api/replication/cursors');
          if (cursors.status !== 200) continue;
          const row = (cursors.body.cursors as any[]).find(
            (c) => c.context_graph_id === CONTEXT_GRAPH && c.core_hosted === 1,
          );
          if (row) return { node: n, onChainId: row.on_chain_id };
        }
        return null;
      },
    );
    expect(host.node).toBeGreaterThan(0);
    // core_hosted is only ever set for PUBLIC CGs (curated stay on the
    // ciphertext host-mode path), so this is also the public-detection proof.
  }, 120_000);

  it('a core offline during a publish fills its gap from chain on restart (core-fill)', async () => {
    // Phase D needs a PURE host-only victim (`core_hosted=1, subscribed=0`) so
    // the fill can ONLY come from the coreHosted reconcile path — a member-
    // subscriber would refill via its ordinary subscriber reconcile even if
    // `coreHosted` were broken, so only a pure host proves the host-only
    // recovery. On this devnet every core that signs a StorageACK for a public
    // CG is ALSO auto-subscribed to it, so a host-only core doesn't occur
    // naturally — we MANUFACTURE one by calling the unsubscribe endpoint (drops
    // live gossip + sync scope, keeps `coreHosted`). That removes the
    // finalization gossip fast-path, so the missed publish below can only be
    // recovered via the chain reconcile sweep. (node1 is the publisher/curator;
    // the other cores ACK as hosts.)
    const candidates = CORE_NODES.filter((n) => n !== 1);
    const picked = await waitFor(
      'a hosting core (core_hosted=1) for CONTEXT_GRAPH',
      90_000,
      4_000,
      async () => {
        let anyHost: { victim: number; subscribed: number } | null = null;
        for (const n of candidates) {
          const cursors = await getJson(nodes[n]!, '/api/replication/cursors');
          if (cursors.status !== 200) continue;
          const row = (cursors.body.cursors as any[]).find(
            (c) => c.context_graph_id === CONTEXT_GRAPH && c.core_hosted === 1,
          );
          if (!row) continue;
          const entry = { victim: n, subscribed: row.subscribed };
          anyHost ??= entry;
          if (row.subscribed !== 1) return entry; // already pure host-only
        }
        return anyHost; // else manufacture host-only via unsubscribe below
      },
    );
    const victim = picked.victim;
    const victimNode = nodes[victim]!;

    // Manufacture the pure host-only state: unsubscribe the live member
    // subscription while keeping `coreHosted`. Poll the cursors API until it
    // reports `subscribed=0, core_hosted=1` so we KNOW the gap can only be
    // filled by the chain reconcile path, not the gossip fast-path.
    if (picked.subscribed === 1) {
      const unsub = await postJson(victimNode, '/api/context-graph/unsubscribe', { contextGraphId: CONTEXT_GRAPH });
      expect(unsub.status, `unsubscribe node${victim} failed`).toBe(200);
      expect(unsub.body.coreHosted, 'unsubscribe must retain coreHosted').toBe(true);
      await waitFor(`node${victim} is pure host-only (subscribed=0, core_hosted=1)`, 30_000, 2_000, async () => {
        const cursors = await getJson(victimNode, '/api/replication/cursors');
        if (cursors.status !== 200) return null;
        const row = (cursors.body.cursors as any[]).find(
          (c) => c.context_graph_id === CONTEXT_GRAPH && c.core_hosted === 1,
        );
        return row && row.subscribed === 0 ? true : null;
      });
      console.log(`Phase D: manufactured pure host-only core node${victim} via unsubscribe; gap fill must come from chain reconcile.`);
    }

    // 1. Take the victim core OFFLINE. Kill the real worker (daemon.pid),
    //    not just the already-exited `cli.js start` launcher (devnet.pid).
    const pids = readNodePids(victim);
    expect(pids.length, `node${victim} pids not found`).toBeGreaterThan(0);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* may already be gone */ }
    }
    await waitFor(`node${victim} offline`, 45_000, 1_000, async () =>
      (await nodeReachable(victimNode)) ? null : true,
    );
    // Stale pid files now hold dead PIDs — clear them so `restart-node` can't
    // signal a recycled PID.
    clearNodePidFiles(victim);

    // 2. Publish a fresh KA to the CG from node1 while the victim is down.
    const pub = await publishFromCore(nodes[1]!, 'gap');
    expect(pub.status).toBe('confirmed');

    // 3. Bring the victim back online.
    execFileSync('bash', [DEVNET_SH, 'restart-node', String(victim)], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...devnetPortEnv() },
    });
    await waitFor(`node${victim} back online`, 90_000, 2_000, async () =>
      (await nodeReachable(victimNode)) ? true : null,
    );

    // 4. The victim must fill its gap FROM CHAIN after restart. Because it was
    //    made pure host-only (subscribed=0, core_hosted=1) above, the missed KA
    //    can ONLY reach its verifiable-memory via the Phase D host-fill path — a
    //    subscriber reconcile could not have produced it. We require BOTH:
    //      (i)  the missed triple is in the victim's verifiable-memory, AND
    //      (ii) chain-path evidence that the reconciler delivered THIS specific
    //           KA after restart — a `fetch`/`promote`/`core-fill` replication
    //           event for this ka id, or a `chain-promote action=…` daemon.log
    //           line naming it. This rules out a coincidental non-chain path.
    //    `already` is NOT accepted (it means the KA was present pre-restart).
    expect(pub.kaId, 'gap publish did not report a KA ID — cannot pin chain-path evidence').toBeTruthy();
    const kaId = pub.kaId!;
    const chainActions = new Set(['fetch', 'promote', 'core-fill']);
    const filled = await waitFor(
      `node${victim} fills the gap from chain (VM witness + chain-path evidence for ka=${kaId})`,
      240_000,
      5_000,
      async () => {
        const vm = await postJson(victimNode, '/api/query', {
          sparql: `ASK { <${pub.subject}> <https://schema.org/name> ?o }`,
          contextGraphId: CONTEXT_GRAPH,
          view: 'verifiable-memory',
        });
        if (!(vm.status === 200 && askIsTrue(vm.body))) return null; // headline proof first

        // Chain-path evidence pinned to THIS ka id.
        const events = await getJson(victimNode, `/api/replication/events?cg=${encodeURIComponent(CONTEXT_GRAPH)}&limit=200`);
        if (events.status === 200) {
          const hit = (events.body.events as any[]).find(
            (e) => chainActions.has(e.action) && typeof e.ual === 'string' && e.ual.endsWith(`/${kaId}`),
          );
          if (hit) return { via: 'chain-fill', evidence: `event:${hit.action} ${hit.ual}` };
        }
        const log = daemonLogTail(victim);
        const m = new RegExp(`chain-promote action=(promote|fetch|core-fill)[^\\n]*\\bka=${kaId}\\b`).exec(log);
        if (m) return { via: 'chain-fill', evidence: `log:${m[0]}` };
        return null;
      },
    );
    expect(filled, `node${victim} VM witness landed but no chain-path evidence for ka=${kaId}`).toBeTruthy();
    console.log(`Phase D fill-the-gap PASS via ${(filled as any).via} — ${(filled as any).evidence}`);
  }, 600_000);
});

// ───────────────────── 4. Phase C — no catch-up regression ─────────────────
describe('Phase C — sinceBatchId is additive; normal sync is unaffected', () => {
  it('a fresh core publish still reaches confirmed (full-scan sync path intact)', async () => {
    // Phase C adds an OPTIONAL unsigned hint with no active production caller
    // yet; its responder/envelope behaviour is unit-pinned. Here we only
    // confirm the publish + catch-up path (which exercises PROTOCOL_SYNC) is
    // not regressed by the additive field.
    const pub = await publishFromCore(nodes[1]!, 'phasec');
    expect(pub.status).toBe('confirmed');
  }, 200_000);
});
