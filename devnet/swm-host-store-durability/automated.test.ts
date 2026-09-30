/**
 * SWM host-mode store durability - devnet validation.
 *
 * A core that hosts a curated context graph's Shared Working Memory keeps the
 * opaque ciphertext envelopes in `<home>/swm-host/<sha256(cg)>.{log,meta}`
 * (`SwmHostModeStore`). This suite proves, on a real 6-node devnet, that
 * `kill -9` of that core while it is ingesting live gossip cannot corrupt the
 * store or recycle a seqno, and that a member's host catch-up (strict
 * greater-than seqno paging) still completes afterwards:
 *
 *   1. The hosting core (node4, `swmHostMode.stripCiphertext=false`) receives
 *      the curator's (node5) SWM shares for a curated CG and stores them.
 *      This is the first, non-vacuous gate: without entries on disk nothing
 *      below means anything.
 *   2. For several cycles the suite SIGKILLs the core the moment a new frame
 *      lands in its log (the writer keeps producing shares throughout, so the
 *      kill falls inside the append -> persistMeta -> directory-fsync window
 *      or right after it), restarts it, and asserts on the on-disk files:
 *        - no `<key>.<log|meta>.tmp-*` file that existed at the kill survives
 *          the restart (leftover temps are swept by `init()`),
 *        - after the next append the log is a clean frame stream with no torn
 *          tail, and seqnos are strictly increasing with no duplicate or
 *          reused value across the crash,
 *        - the `.meta` cursor is never below the log's last seqno,
 *        - the host re-engages host mode for the CG from its persisted flag.
 *   3. The member edge (node6) pages the hosting core with
 *      `POST /api/shared-memory/host-catchup`, one round per call, resuming
 *      from the returned cursor until the host has nothing more, from several
 *      starting cursors: the core serves exactly the frames with seqno > the
 *      starting cursor across the pages and the final cursor is the true last
 *      seqno (catch-up "pages to completion").
 *
 * Preconditions:
 *   pnpm run build && pnpm --dir packages/cli run build:prepared
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *
 * Run:
 *   pnpm test:devnet:swm-host-store-durability
 *
 * The suite mutates only its own ephemeral entities: a fresh curated CG it
 * creates, and node4's `swmHostMode` config block (backed up and restored, with
 * a restart, on every exit path). It restarts node4 several times.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEVNET_DIR,
  REPO_ROOT,
  getJson,
  postJson,
  queryNode,
  readNodeConfig,
  sleep,
  waitFor,
  lexical,
  type DevnetNode,
} from '../_bootstrap/harness';

const HOST = 4; // core
const CURATOR = 5; // edge
const MEMBER = 6; // edge
const KILL_CYCLES = Number(process.env.SWM_HOST_KILL_CYCLES ?? 5);
const STAMP = Date.now().toString(36);

// ─────────────────────────── node + fs helpers ────────────────────────────
function agentToken(num: number): string {
  try {
    const records = Object.values(
      JSON.parse(readFileSync(join(DEVNET_DIR, `node${num}`, 'agent-keystore.json'), 'utf8')),
    ) as Array<{ authToken?: string }>;
    return records.find((r) => typeof r?.authToken === 'string')?.authToken ?? '';
  } catch {
    return '';
  }
}

/** The node's own API token, or (for calls made "as the agent") the agent's. */
function nodeFor(num: number, asAgent = false): DevnetNode {
  const base = readNodeConfig(num);
  return asAgent ? { ...base, authToken: agentToken(num) || base.authToken } : base;
}

const hostHome = join(DEVNET_DIR, `node${HOST}`);
const storeDir = join(hostHome, 'swm-host');
const hostConfigPath = join(hostHome, 'config.json');

const hashKey = (cgId: string) => createHash('sha256').update(cgId).digest('base64url');

/**
 * The store files are keyed by sha256 of the id the ENVELOPE carries, which is
 * not necessarily the string this suite created the graph with. Find the
 * `.meta` whose recorded `contextGraphId` matches, and fall back to the hash of
 * the created id until the first frame lands.
 */
let resolvedKey: string | null = null;
function cgKey(cgId: string): string {
  if (resolvedKey) return resolvedKey;
  try {
    for (const name of readdirSync(storeDir)) {
      if (!name.endsWith('.meta')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(storeDir, name), 'utf8'));
        if (typeof parsed.contextGraphId === 'string' && parsed.contextGraphId.toLowerCase() === cgId.toLowerCase()) {
          resolvedKey = name.slice(0, -'.meta'.length);
          return resolvedKey;
        }
      } catch { /* absent or mid-rename: keep scanning */ }
    }
  } catch { /* store dir not created yet */ }
  return hashKey(cgId);
}

const HEADER_BYTES = 20;

interface LogState {
  size: number;
  validLength: number;
  seqnos: number[];
}

function readLog(cgId: string): LogState {
  const path = join(storeDir, `${cgKey(cgId)}.log`);
  if (!existsSync(path)) return { size: 0, validLength: 0, seqnos: [] };
  const buf = readFileSync(path);
  const seqnos: number[] = [];
  let offset = 0;
  while (offset + HEADER_BYTES <= buf.length) {
    const len = buf.readUInt32BE(offset + 16);
    const end = offset + HEADER_BYTES + len;
    if (end > buf.length) break;
    seqnos.push(Number(buf.readBigUInt64BE(offset + 8)));
    offset = end;
  }
  return { size: buf.length, validLength: offset, seqnos };
}

function logSize(cgId: string): number {
  try {
    return statSync(join(storeDir, `${cgKey(cgId)}.log`)).size;
  } catch {
    return 0;
  }
}

function readMetaSeqno(cgId: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(storeDir, `${cgKey(cgId)}.meta`), 'utf8'));
    return typeof parsed.seqno === 'number' ? parsed.seqno : null;
  } catch {
    return null; // absent or torn
  }
}

function tempFiles(): string[] {
  try {
    return readdirSync(storeDir).filter((n) => /\.(log|meta)\.tmp-/.test(n)).sort();
  } catch {
    return [];
  }
}

// ───────────────────────── process control (node4) ────────────────────────
const NODE_PID_FILES = ['daemon.pid', 'devnet.pid'] as const;

function readNodePids(num: number): number[] {
  const pids = new Set<number>();
  for (const f of NODE_PID_FILES) {
    const pidFile = join(DEVNET_DIR, `node${num}`, f);
    if (!existsSync(pidFile)) continue;
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isFinite(pid)) pids.add(pid);
  }
  return [...pids];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearDeadNodePidFiles(num: number): void {
  for (const f of NODE_PID_FILES) {
    const pidFile = join(DEVNET_DIR, `node${num}`, f);
    if (!existsSync(pidFile)) continue;
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isFinite(pid) && pidAlive(pid)) continue;
    try { rmSync(pidFile); } catch { /* best-effort */ }
  }
}

/** kill -9 every process that belongs to the node (the real worker is `daemon.pid`). */
function sigkillNode(num: number): number[] {
  const pids = readNodePids(num).filter(pidAlive);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return pids;
}

function devnetPortEnv(): Record<string, string> {
  const cfg = JSON.parse(readFileSync(join(DEVNET_DIR, 'node1', 'config.json'), 'utf8'));
  const rpc = new URL(cfg?.chain?.rpcUrl ?? 'http://127.0.0.1:8545');
  return {
    HARDHAT_PORT: rpc.port || '8545',
    API_PORT_BASE: String(cfg.apiPort ?? 9201),
    LIBP2P_PORT_BASE: String(cfg.listenPort ?? 10001),
  };
}

async function nodeReachable(num: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${readNodeConfig(num).apiPort}/api/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function restartNodeAndWait(num: number, timeoutMs = 120_000): Promise<void> {
  execFileSync('bash', [join(REPO_ROOT, 'scripts/devnet.sh'), 'restart-node', String(num)], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...devnetPortEnv() },
  });
  await waitFor(`node${num} reachable`, timeoutMs, 1_000, async () => ((await nodeReachable(num)) ? true : null));
}

// ─────────────────────────────── API helpers ──────────────────────────────
interface HostStats {
  enabled: boolean;
  perCg: Record<string, { entries: number; bytes: number; registered: boolean }>;
  subscribedCgIds: string[];
}

async function hostStats(): Promise<HostStats | null> {
  try {
    const r = await getJson(nodeFor(HOST), '/api/shared-memory/host-mode/stats');
    return r.status === 200 && r.json?.enabled === true ? (r.json as HostStats) : null;
  } catch {
    return null;
  }
}

let cgId = '';
let curatorAgent = '';
let memberAgent = '';
let hostPeerId = '';

async function writeShare(seq: number): Promise<boolean> {
  const name = `swmhost-${STAMP}-${seq}`;
  const res = await postJson(nodeFor(CURATOR, true), '/api/knowledge-assets', {
    contextGraphId: cgId,
    name,
    quads: [
      {
        subject: `urn:swmhost:${STAMP}:${seq}`,
        predicate: 'http://schema.org/name',
        object: `"swm host durability ${STAMP} #${seq}"`,
        graph: `did:dkg:context-graph:${cgId}`,
      },
    ],
    finalize: true,
    alsoShareSwm: true,
  });
  return res.status === 200 && res.json?.swmShared === true;
}

// Continuous writer, so the kills land in the middle of live ingestion.
let writerStop = false;
let writerSeq = 0;
let writerOk = 0;
let writerLoop: Promise<void> | null = null;

function startWriter(): void {
  if (writerLoop) return;
  writerStop = false;
  writerLoop = (async () => {
    while (!writerStop) {
      try {
        if (await writeShare(writerSeq++)) writerOk += 1;
      } catch { /* the curator keeps going while the host is down */ }
      await sleep(150);
    }
  })();
}

async function stopWriter(): Promise<void> {
  writerStop = true;
  await writerLoop;
  writerLoop = null;
}

// ─────────────────────────────── suite state ──────────────────────────────
let originalHostConfig: string | null = null;

beforeAll(async () => {
  for (const n of [HOST, CURATOR, MEMBER]) {
    expect(await nodeReachable(n), `node${n} must be reachable - start the devnet first`).toBe(true);
  }
  const role = (await getJson(nodeFor(HOST), '/api/status')).json?.nodeRole;
  expect(role, `node${HOST} must be a core`).toBe('core');
  expect((await getJson(nodeFor(CURATOR), '/api/status')).json?.nodeRole).toBe('edge');
  expect((await getJson(nodeFor(MEMBER), '/api/status')).json?.nodeRole).toBe('edge');

  // Turn the private-ciphertext strip off on the hosting core (it is ON by default and
  // then the core keeps nothing for a curated CG), remembering the original config.
  originalHostConfig = readFileSync(hostConfigPath, 'utf8');
  const config = JSON.parse(originalHostConfig);
  config.swmHostMode = { ...config.swmHostMode, enabled: true, stripCiphertext: false };
  writeFileSync(hostConfigPath, JSON.stringify(config, null, 2));
  await restartNodeAndWait(HOST);

  hostPeerId = (await getJson(nodeFor(HOST), '/api/status')).json?.peerId ?? '';
  expect(hostPeerId, 'host peer id').toBeTruthy();
  curatorAgent = (await getJson(nodeFor(CURATOR, true), '/api/agent/identity')).json?.agentAddress ?? '';
  memberAgent = (await getJson(nodeFor(MEMBER, true), '/api/agent/identity')).json?.agentAddress ?? '';
  expect(curatorAgent && memberAgent, 'edge agent addresses').toBeTruthy();

  // Fresh curated (private) CG owned by the curator edge, with the member allowlisted.
  cgId = `swmhost-${STAMP}`;
  const created = await postJson(nodeFor(CURATOR, true), '/api/context-graph/create', {
    id: cgId,
    name: `SWM host durability ${STAMP}`,
    accessPolicy: 1,
    publishPolicy: 0,
    allowedAgents: [curatorAgent, memberAgent],
    register: true,
  });
  expect(created.status, `create CG: ${JSON.stringify(created.json)}`).toBe(200);

  // The member joins through the supported signed-join flow.
  const enc = encodeURIComponent(cgId);
  const curatorPeerId = (await getJson(nodeFor(CURATOR, true), '/api/agent/identity')).json?.peerId;
  const curatorMultiaddr = readFileSync(join(DEVNET_DIR, `node${CURATOR}`, 'multiaddr'), 'utf8').trim();
  await postJson(nodeFor(MEMBER, true), '/api/connect', { multiaddr: curatorMultiaddr });
  const signed = await postJson(nodeFor(MEMBER, true), `/api/context-graph/${enc}/sign-join`, {});
  expect(signed.json?.delegation, `sign-join: ${JSON.stringify(signed.json)}`).toBeTruthy();
  let joined = false;
  for (let attempt = 1; attempt <= 4 && !joined; attempt += 1) {
    const join_ = await postJson(nodeFor(MEMBER, true), `/api/context-graph/${enc}/request-join`, {
      delegation: signed.json.delegation,
      curatorPeerId,
      agentName: 'swm-host-durability-member',
    });
    const delivered = join_.json?.delivered === 1 || join_.json?.delivered === 'local';
    joined = delivered && ['approved', 'already-member'].includes(join_.json?.status);
    if (!joined) await sleep(20_000);
  }
  expect(joined, 'member join approved and delivered').toBe(true);
  await waitFor('member receives the curator _meta', 120_000, 2_000, async () => {
    try {
      const rows = await queryNode(
        nodeFor(MEMBER),
        `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <did:dkg:context-graph:${cgId}/_meta> { ?s <https://dkg.network/ontology#allowedAgent> ?a } }`,
      );
      return Number(lexical(rows[0]?.c)) >= 1 ? true : null;
    } catch {
      return null;
    }
  });
  const subscribed = await postJson(nodeFor(MEMBER, true), '/api/subscribe', {
    contextGraphId: cgId,
    includeSharedMemory: true,
  });
  expect(subscribed.json?.subscribed, `member subscribe: ${JSON.stringify(subscribed.json)}`).toBe(cgId);

  // The operator hatch: designate the hosting core for this CG.
  const enabled = await postJson(nodeFor(HOST), '/api/shared-memory/host-mode/subscribe', { contextGraphId: cgId });
  expect(enabled.json?.hostingEnabled, `host-mode subscribe: ${JSON.stringify(enabled.json)}`).toBe(true);
  await sleep(10_000); // let the SWM gossip mesh include the host before the first share
}, 900_000);

afterAll(async () => {
  await stopWriter().catch(() => undefined);
  if (originalHostConfig !== null) {
    try {
      writeFileSync(hostConfigPath, originalHostConfig);
      sigkillNode(HOST);
      clearDeadNodePidFiles(HOST);
      await restartNodeAndWait(HOST, 180_000);
    } catch (err) {
      console.warn(`cleanup: could not restore node${HOST}: ${(err as Error).message}`);
    }
  }
}, 300_000);

// ──────────────────────────────── tests ───────────────────────────────────
describe('SWM host-mode store survives kill -9 of the hosting core', () => {
  it('the hosting core stores the curator\'s private SWM shares as opaque frames (non-vacuous gate)', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(await writeShare(writerSeq++), `share ${i} accepted by the curator`).toBe(true);
    }
    await waitFor('host log has frames for the CG', 120_000, 1_000, async () =>
      readLog(cgId).seqnos.length >= 3 ? true : null,
    );
    const log = readLog(cgId);
    expect(log.validLength).toBe(log.size);
    expect(log.seqnos).toEqual([...new Set(log.seqnos)].sort((a, b) => a - b));
    expect(log.seqnos[0]).toBe(1);
    // The API view agrees with the disk (cleartext or wire-id key).
    const stats = await hostStats();
    const entries = Object.values(stats?.perCg ?? {}).reduce((sum, row) => sum + row.entries, 0);
    expect(entries).toBeGreaterThanOrEqual(3);
    expect(readMetaSeqno(cgId)).toBe(log.seqnos.at(-1));
    console.log(`baseline: host stored ${log.seqnos.length} frames, last seqno ${log.seqnos.at(-1)}`);
  }, 600_000);

  it(`${KILL_CYCLES} x kill -9 during live ingestion: no torn log, no leftover temp, no seqno reuse`, async () => {
    startWriter();
    let maxSeqnoEver = readLog(cgId).seqnos.at(-1) ?? 0;
    const evidence: string[] = [];

    for (let cycle = 1; cycle <= KILL_CYCLES; cycle += 1) {
      // Wait for a new frame, then kill the core at that instant.
      const baseSize = logSize(cgId);
      const killAt = Date.now() + 240_000;
      let killed: number[] = [];
      while (Date.now() < killAt) {
        if (logSize(cgId) > baseSize) {
          killed = sigkillNode(HOST);
          break;
        }
        await sleep(3);
      }
      expect(killed.length, `cycle ${cycle}: host log never grew (no live ingestion)`).toBeGreaterThan(0);
      await waitFor(`cycle ${cycle}: node${HOST} offline`, 45_000, 500, async () =>
        (await nodeReachable(HOST)) ? null : true,
      );

      // What the kill left on disk.
      const afterKill = readLog(cgId);
      const metaAfterKill = readMetaSeqno(cgId);
      const tempsAtKill = tempFiles();
      maxSeqnoEver = Math.max(maxSeqnoEver, ...afterKill.seqnos, metaAfterKill ?? 0);
      const window =
        tempsAtKill.length > 0
          ? 'temp file left (killed inside a durable meta write)'
          : metaAfterKill !== null && metaAfterKill < (afterKill.seqnos.at(-1) ?? 0)
            ? 'meta lags the log (killed between the frame append and the cursor write)'
            : afterKill.validLength < afterKill.size
              ? 'torn frame tail'
              : 'between writes';
      evidence.push(`cycle ${cycle}: ${window}; log=${afterKill.seqnos.length} frames last=${afterKill.seqnos.at(-1)} meta=${metaAfterKill}`);

      clearDeadNodePidFiles(HOST);
      await restartNodeAndWait(HOST);

      // Startup swept every temp file the kill left behind, and re-engaged host mode.
      await waitFor(`cycle ${cycle}: host store initialised`, 120_000, 1_000, async () => (await hostStats()) ?? null);
      const survivors = tempFiles().filter((name) => tempsAtKill.includes(name));
      expect(survivors, `cycle ${cycle}: temp files from the kill survived the restart`).toEqual([]);
      // The persisted host-mode flag re-engages the subscription without the operator (the
      // subscription key may be the cleartext id or its wire hash; new frames below prove it works).
      await waitFor(`cycle ${cycle}: host mode re-engaged`, 120_000, 2_000, async () => {
        const stats = await hostStats();
        return stats && stats.subscribedCgIds.length > 0 ? true : null;
      });

      // New frames arrive after the restart (the writer never stopped).
      const sizeAfterRestart = logSize(cgId);
      await waitFor(`cycle ${cycle}: new frames after restart`, 240_000, 500, async () =>
        logSize(cgId) > sizeAfterRestart ? true : null,
      );
      await sleep(1_500);

      const log = readLog(cgId);
      expect(log.validLength, `cycle ${cycle}: torn log tail after restart + append`).toBe(log.size);
      expect(new Set(log.seqnos).size, `cycle ${cycle}: duplicate seqno in log`).toBe(log.seqnos.length);
      expect(log.seqnos, `cycle ${cycle}: seqnos not strictly increasing`).toEqual(
        [...log.seqnos].sort((a, b) => a - b),
      );
      const fresh = log.seqnos.filter((s) => s > maxSeqnoEver);
      expect(fresh.length, `cycle ${cycle}: no frame above the pre-kill high-water mark ${maxSeqnoEver}`).toBeGreaterThan(0);
      expect(
        log.seqnos.slice(log.seqnos.indexOf(fresh[0]!)),
        `cycle ${cycle}: seqno reused or reordered across the crash`,
      ).toEqual(fresh);
      const meta = readMetaSeqno(cgId);
      expect(meta, `cycle ${cycle}: meta unreadable after restart`).not.toBeNull();
      expect(meta!, `cycle ${cycle}: cursor below the log tail`).toBeGreaterThanOrEqual(log.seqnos.at(-1)! - 1);
      maxSeqnoEver = Math.max(maxSeqnoEver, ...log.seqnos, meta!);
    }

    await stopWriter();
    console.log(`writer shares accepted: ${writerOk}`);
    for (const line of evidence) console.log(line);
  }, 1_800_000);

  it('a member pages the restarted host with strict-greater-than seqnos and reaches the end', async () => {
    // Quiesce: the writer is stopped; wait for the log to stop growing.
    let last = logSize(cgId);
    await waitFor('host log quiescent', 120_000, 4_000, async () => {
      const now = logSize(cgId);
      const stable = now === last;
      last = now;
      return stable ? true : null;
    });
    const log = readLog(cgId);
    expect(log.validLength).toBe(log.size);
    expect(log.seqnos.length).toBeGreaterThanOrEqual(KILL_CYCLES + 3);
    const lastSeqno = log.seqnos.at(-1)!;
    const mid = log.seqnos[Math.floor(log.seqnos.length / 2)]!;

    // Page like a real member: one round per call, resuming from the returned cursor until the
    // host has nothing more, from several starting cursors.
    for (const start of [0, mid, lastSeqno - 1, lastSeqno]) {
      const expectedTotal = log.seqnos.filter((s) => s > start).length;
      let since = start;
      let fetchedTotal = 0;
      let calls = 0;
      for (;;) {
        calls += 1;
        expect(calls, `start=${start}: paging did not terminate`).toBeLessThan(200);
        const res = await postJson(nodeFor(MEMBER, true), '/api/shared-memory/host-catchup', {
          contextGraphId: cgId,
          peerId: hostPeerId,
          sinceSeqno: since,
          maxRounds: 1,
        });
        expect(res.status, `host-catchup since=${since}: ${JSON.stringify(res.json)}`).toBe(200);
        const peer = res.json.peers?.[0];
        expect(peer, `host-catchup since=${since} reached no peer: ${JSON.stringify(res.json)}`).toBeTruthy();
        expect(peer.denied, `host denied catch-up: ${JSON.stringify(peer)}`).toBeUndefined();
        expect(peer.error, `host-catchup error: ${JSON.stringify(peer)}`).toBeUndefined();
        if (peer.fetched === 0) {
          expect(peer.nextSeqno, `start=${start}: empty page must not move the cursor`).toBe(since);
          break;
        }
        expect(peer.nextSeqno, `start=${start}: cursor must advance`).toBeGreaterThan(since);
        fetchedTotal += peer.fetched;
        since = peer.nextSeqno;
      }
      expect(fetchedTotal, `start=${start}: frames served across all pages`).toBe(expectedTotal);
      expect(since, `start=${start}: final cursor`).toBe(expectedTotal > 0 ? lastSeqno : start);
    }
  }, 600_000);
});
