/**
 * SWM host-mode store durability - devnet validation.
 *
 * A core that hosts a curated context graph's Shared Working Memory keeps the
 * opaque ciphertext envelopes in `<home>/swm-host/<sha256(cg)>.{log,meta}`
 * (`SwmHostModeStore`). This suite proves, on a real devnet, that `kill -9` of
 * that core while it is ingesting live gossip cannot corrupt the store or
 * recycle a seqno, and that host catch-up (strict greater-than seqno paging)
 * still completes afterwards:
 *
 *   1. The hosting core (node4) receives the curator's (node5) SWM shares for a
 *      curated CG and stores them. This is the first, non-vacuous gate: without
 *      entries on disk nothing below means anything.
 *   2. For several cycles the suite SIGKILLs the core the moment a new frame
 *      lands in its log (the writer keeps producing shares throughout, so the
 *      kill falls inside the append -> persistMeta -> directory-fsync window
 *      or right after it), restarts it, and asserts on the on-disk files:
 *        - no `<key>.<log|meta>.tmp-*` file that existed at the kill survives
 *          the restart (leftover temps are swept by `init()`),
 *        - after the next append the log is a clean frame stream with no torn
 *          tail, and seqnos are strictly increasing with no duplicate value,
 *        - every frame that was complete at the kill is still there, byte for
 *          byte (the recovered log starts with that exact prefix), and every
 *          frame appended after the restart sits after it with a seqno above
 *          max(the `.meta` cursor, the last complete frame) at the kill: no
 *          seqno is reused (`checkNoSeqnoReuse` in `log-frames.ts`, unit-tested
 *          without a devnet),
 *        - the `.meta` cursor covers the log, except for the one append that can be in
 *          flight while the writer runs (`checkCursorCoversLog` with `appendInFlight`,
 *          counted in frames),
 *        - the host re-engages host mode from its persisted flag.
 *   3. With ingestion stopped, the `.meta` cursor covers the whole log (no
 *      in-flight allowance), and the curator edge pages the hosting core with
 *      `POST /api/shared-memory/host-catchup`, one round per call and a page
 *      smaller than the log, resuming from the returned cursor until the host
 *      has nothing more, from several starting cursors. Each call resumes where
 *      the last stopped, holds at most a page and advances the cursor over the
 *      frames it served, and paging from 0 crosses at least two page boundaries
 *      (`checkCatchupWalk`, unit-tested without a devnet). The envelopes served across the pages
 *      are, in order, exactly the frames with seqno > the starting cursor, each
 *      byte-identical to its stored ciphertext (`checkServedFrames`), and the
 *      final cursor is the true last seqno (catch-up "pages to completion").
 *
 * Why the setup looks the way it does (this release):
 *   - The RFC-64 kill switch is on for node4 and node5: in catalog mode the
 *     legacy SWM transport, and with it host-mode custody, is inert.
 *   - `swmHostMode.stripCiphertext=false` on node4: by default a core keeps no
 *     private ciphertext for a curated graph.
 *   - The curated graph allowlists ONLY the curator. A private graph whose
 *     roster has a reachable peer besides the author is delivered point-to-point
 *     and never gossiped (OT-RFC-49 WS-A), which a hosting core (not a member)
 *     cannot receive; with the author as the only agent the roster is empty, so
 *     the gossip leg the host store consumes stays on. The author is an
 *     allowlisted agent, so it is also a legitimate host-catchup requester.
 *
 * Preconditions:
 *   pnpm run build && pnpm --dir packages/cli run build:prepared
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *
 * Run:
 *   pnpm test:devnet:swm-host-store-durability
 *
 * The suite mutates only its own ephemeral entities: a fresh curated CG it
 * creates, and the `config.json` of node4 and node5 (both backed up and
 * restored, with a restart, on every exit path). It restarts node4 several
 * times.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEVNET_DIR,
  REPO_ROOT,
  getJson,
  postJson,
  readNodeConfig,
  sleep,
  waitFor,
  type DevnetNode,
} from '../_bootstrap/harness';
import * as lifecycle from '../_bootstrap/node-lifecycle';
import {
  checkCatchupWalk,
  checkCursorCoversLog,
  checkNoSeqnoReuse,
  checkServedFrames,
  parseLog,
  quietPeriodGate,
  type ObservedCatchupPage,
  type ParsedLog,
  type ServedEntry,
} from './log-frames.js';

const HOST = 4; // core
const CURATOR = 5; // edge: the only allowlisted agent, the writer, and the catch-up requester
const KILL_CYCLES = Number(process.env.SWM_HOST_KILL_CYCLES ?? 5);
// How long the host log and its cursor must stay unchanged before the quiescent-state checks read them.
const LOG_QUIET_MS = 6_000;
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

interface LogState extends ParsedLog {
  seqnos: number[];
}

function readLog(cgId: string): LogState {
  const path = join(storeDir, `${cgKey(cgId)}.log`);
  if (!existsSync(path)) return { size: 0, validLength: 0, frames: [], seqnos: [] };
  const parsed = parseLog(readFileSync(path));
  return { ...parsed, seqnos: parsed.frames.map((frame) => frame.seqno) };
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

/**
 * Wait until neither the host log nor its `.meta` cursor has changed for `LOG_QUIET_MS`. A frame is
 * durable before its cursor, so the cursor of the last frame can still be on its way when the log
 * has stopped growing.
 */
async function waitForQuietHostStore(label: string): Promise<void> {
  const quiet = quietPeriodGate(LOG_QUIET_MS);
  await waitFor(label, 120_000, 1_000, async () =>
    quiet(`${logSize(cgId)}:${readMetaSeqno(cgId)}`, Date.now()) ? true : null,
  );
}

function tempFiles(): string[] {
  try {
    return readdirSync(storeDir).filter((n) => /\.(log|meta)\.tmp-/.test(n)).sort();
  } catch {
    return [];
  }
}

// ───────────────────────── process control (node4) ────────────────────────
// PID files, liveness, restart and readiness are shared with the other suites that
// kill or restart a node: see ../_bootstrap/node-lifecycle.ts. This suite's own
// choices: the kill is an immediate SIGKILL of every live process the node's PID
// files list, the Hardhat port for `restart-node` comes from node1's config only
// (`DEVNET_RPC` is not consulted), an unparseable PID file is removed along with
// the dead ones, and readiness is probed without a token, with a 3 s request
// timeout, every second.
const PATHS: lifecycle.DevnetPaths = { repoRoot: REPO_ROOT, devnetDir: DEVNET_DIR };

const clearDeadNodePidFiles = (num: number): void =>
  lifecycle.clearDeadNodePidFiles(PATHS, num, { removeUnparseable: true });

/**
 * kill -9 every process that belongs to the node (the real worker is `daemon.pid`). The PID files
 * are read and every live PID is checked to be a daemon of this checkout first, which takes a
 * `ps` per process. The time-critical kill in the cycles does not use this: it calls
 * `lifecycle.verifiedNodePids` before its wait and `lifecycle.sigkillPids` at the kill point.
 */
const sigkillNode = (num: number): number[] => lifecycle.sigkillNodeProcesses(PATHS, num);

const nodeReachable = (num: number): Promise<boolean> =>
  lifecycle.nodeReachable(readNodeConfig(num).apiPort, { timeoutMs: 3_000 });

const restartNodeAndWait = (num: number, timeoutMs = 120_000): Promise<void> =>
  lifecycle.restartNodeAndWait(PATHS, {
    num,
    apiPort: readNodeConfig(num).apiPort,
    rpcUrl: lifecycle.rpcUrlFromNode1Config(DEVNET_DIR),
    label: `node${num} reachable`,
    timeoutMs,
    pollIntervalMs: 1_000,
    probe: { timeoutMs: 3_000 },
  });

/**
 * A restarted host is reachable from the edge only through the relay, and that relayed link
 * flaps (it opens and closes within milliseconds), so live gossip never reaches the host again
 * on its own. Dial it directly, as an operator would.
 */
let lastConnectAt = 0;
async function connectCuratorToHost(force = false): Promise<void> {
  if (!force && Date.now() - lastConnectAt < 5_000) return;
  lastConnectAt = Date.now();
  try {
    const multiaddr = readFileSync(join(hostHome, 'multiaddr'), 'utf8').trim();
    await postJson(nodeFor(CURATOR, true), '/api/connect', { multiaddr });
  } catch { /* retried on the next probe */ }
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
  // The one-shot create + share answers 201 Created.
  return res.status >= 200 && res.status < 300 && res.json?.swmShared === true;
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
/** node -> original config.json text, for every config this suite edits. */
const originalConfigs = new Map<number, string>();

function configPath(num: number): string {
  return join(DEVNET_DIR, `node${num}`, 'config.json');
}

/** Back up `config.json` (once) and rewrite it with `mutate` applied. */
function patchConfig(num: number, mutate: (config: any) => void): void {
  const text = readFileSync(configPath(num), 'utf8');
  if (!originalConfigs.has(num)) originalConfigs.set(num, text);
  const config = JSON.parse(text);
  mutate(config);
  writeFileSync(configPath(num), JSON.stringify(config, null, 2));
}

beforeAll(async () => {
  for (const n of [HOST, CURATOR]) {
    expect(await nodeReachable(n), `node${n} must be reachable - start the devnet first`).toBe(true);
  }
  const role = (await getJson(nodeFor(HOST), '/api/status')).json?.nodeRole;
  expect(role, `node${HOST} must be a core`).toBe('core');
  expect((await getJson(nodeFor(CURATOR), '/api/status')).json?.nodeRole).toBe('edge');

  // Check who every live process in the PID files of both nodes is BEFORE anything is edited or
  // restarted: this throws if a file lists a live process that is not a daemon of this checkout
  // (a recycled PID). `restartNodeAndWait` stops a node through the same check, and
  // `devnet.sh restart-node`, whose own stop phase signals PID-file entries without one, runs
  // only after that stop has left it nothing live to signal.
  for (const n of [HOST, CURATOR]) lifecycle.verifiedNodePids(PATHS, n);

  // See the header for why each switch is needed. Every edited config is backed up and
  // restored (with a restart) on any exit path.
  for (const n of [HOST, CURATOR]) {
    patchConfig(n, (config) => {
      config.rfc64Catalog = { ...config.rfc64Catalog, rollout: { ...config.rfc64Catalog?.rollout, killSwitch: true } };
      if (n === HOST) {
        config.swmHostMode = { ...config.swmHostMode, enabled: true, stripCiphertext: false };
      }
    });
  }
  for (const n of [HOST, CURATOR]) await restartNodeAndWait(n);

  hostPeerId = (await getJson(nodeFor(HOST), '/api/status')).json?.peerId ?? '';
  expect(hostPeerId, 'host peer id').toBeTruthy();
  curatorAgent = (await getJson(nodeFor(CURATOR, true), '/api/agent/identity')).json?.agentAddress ?? '';
  expect(curatorAgent, 'curator agent address').toBeTruthy();

  // Fresh curated (private) CG owned by the curator edge, allowlisting only the curator.
  cgId = `swmhost-${STAMP}`;
  const created = await postJson(nodeFor(CURATOR, true), '/api/context-graph/create', {
    id: cgId,
    name: `SWM host durability ${STAMP}`,
    accessPolicy: 1,
    publishPolicy: 0,
    allowedAgents: [curatorAgent],
    register: true,
  });
  expect(created.status, `create CG: ${JSON.stringify(created.json)}`).toBe(200);
  await sleep(10_000); // let the create beacon / chain event reach the core

  // The operator hatch: designate the hosting core for this CG (idempotent if the beacon
  // already engaged it).
  const enabled = await postJson(nodeFor(HOST), '/api/shared-memory/host-mode/subscribe', { contextGraphId: cgId });
  expect(enabled.json?.hostingEnabled, `host-mode subscribe: ${JSON.stringify(enabled.json)}`).toBe(true);
  // `hostingEnabled` is also true when the subscribe was a no-op (strip on, or the CG is on the
  // RFC-64 catalog lane): require an actual subscription.
  expect(
    enabled.json?.subscribed === true || enabled.json?.alreadySubscribed === true,
    `host-mode subscribe did not wire a handler: ${JSON.stringify(enabled.json)}`,
  ).toBe(true);
  await connectCuratorToHost(true);
  await sleep(5_000); // let the SWM gossip mesh include the host before the first share
}, 900_000);

afterAll(async () => {
  await stopWriter().catch(() => undefined);
  for (const [num, text] of originalConfigs) {
    try {
      writeFileSync(configPath(num), text);
      sigkillNode(num);
      clearDeadNodePidFiles(num);
      await restartNodeAndWait(num, 180_000);
    } catch (err) {
      console.warn(`cleanup: could not restore node${num}: ${(err as Error).message}`);
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
    // No writer is running yet: once the three deliveries have settled, the cursor covers the log.
    await waitForQuietHostStore('host store quiescent after the first shares');
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
    const evidence: string[] = [];

    for (let cycle = 1; cycle <= KILL_CYCLES; cycle += 1) {
      // Check who the host's processes are BEFORE the race (this throws if a PID file lists a live
      // process that is not a daemon of this checkout), so the kill itself is immediate.
      const hostPids = lifecycle.verifiedNodePids(PATHS, HOST);
      expect(hostPids.length, `cycle ${cycle}: node${HOST} has no live process in its PID files`).toBeGreaterThan(0);
      // Wait for a new frame, then kill the core at that instant.
      const baseSize = logSize(cgId);
      const killAt = Date.now() + 240_000;
      let killed: number[] = [];
      while (Date.now() < killAt) {
        if (logSize(cgId) > baseSize) {
          killed = lifecycle.sigkillPids(hostPids);
          break;
        }
        await sleep(3);
      }
      expect(killed.length, `cycle ${cycle}: host log never grew (no live ingestion)`).toBeGreaterThan(0);
      await waitFor(`cycle ${cycle}: node${HOST} offline`, 45_000, 500, async () =>
        (await nodeReachable(HOST)) ? null : true,
      );
      // An unreachable API only says the server stopped answering: read the files once the killed
      // processes are really gone, so a write that was still in flight cannot land after the snapshot.
      expect(
        await lifecycle.waitForPidsGone(`cycle ${cycle}: killed processes gone`, killed, 30_000),
        `cycle ${cycle}: killed processes still alive`,
      ).toBe(true);

      // What the kill left on disk: the snapshot every recovery claim below is checked against.
      const afterKill = readLog(cgId);
      const metaAfterKill = readMetaSeqno(cgId);
      const tempsAtKill = tempFiles();
      const window =
        tempsAtKill.length > 0
          ? 'temp file left (killed inside a durable meta write)'
          : metaAfterKill !== null && metaAfterKill < (afterKill.seqnos.at(-1) ?? 0)
            ? 'meta lags the log (killed between the frame append and the cursor write)'
            : afterKill.validLength < afterKill.size
              ? 'torn frame tail'
              : 'between writes';

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
      await connectCuratorToHost(true);
      await waitFor(`cycle ${cycle}: new frames after restart`, 240_000, 500, async () => {
        await connectCuratorToHost();
        return logSize(cgId) > sizeAfterRestart ? true : null;
      });
      await sleep(1_500);

      const log = readLog(cgId);
      expect(log.validLength, `cycle ${cycle}: torn log tail after restart + append`).toBe(log.size);
      expect(new Set(log.seqnos).size, `cycle ${cycle}: duplicate seqno in log`).toBe(log.seqnos.length);
      expect(log.seqnos, `cycle ${cycle}: seqnos not strictly increasing`).toEqual(
        [...log.seqnos].sort((a, b) => a - b),
      );
      // The frames that were complete at the kill are still there, byte for byte, and every frame
      // appended after the restart sits after them with a seqno above max(cursor, last complete frame).
      const recovery = checkNoSeqnoReuse({
        atKill: { frames: afterKill.frames, metaSeqno: metaAfterKill },
        afterRestart: { frames: log.frames },
      });
      expect(recovery.violations, `cycle ${cycle}: recovery lost or recycled frames`).toEqual([]);
      // The writer is still running: the cursor may trail by the one append in flight (counted in
      // frames, so a burned seqno does not change the allowance) and must be readable.
      expect(
        checkCursorCoversLog({ frames: log.frames, metaSeqno: readMetaSeqno(cgId), appendInFlight: true }),
        `cycle ${cycle}: cursor below the log tail`,
      ).toEqual([]);
      evidence.push(
        `cycle ${cycle}: ${window}; at the kill log=${afterKill.frames.length} frames last=${afterKill.seqnos.at(-1)} meta=${metaAfterKill}; ` +
          `preserved ${afterKill.frames.length} frames byte for byte, ${recovery.newFrames.length} new above ${recovery.highWater}`,
      );
    }

    await stopWriter();
    console.log(`writer shares accepted: ${writerOk}`);
    for (const line of evidence) console.log(line);
  }, 1_800_000);

  it('the curator edge pages the restarted host with strict-greater-than seqnos and reaches the end', async () => {
    // Quiesce: the writer is stopped, but a delivery may still be on its way. Wait until neither the
    // log nor its cursor has changed for a measured interval, so nothing is in flight when they are read.
    await waitForQuietHostStore('host store quiescent after the kill cycles');
    const log = readLog(cgId);
    expect(log.validLength).toBe(log.size);
    expect(log.seqnos.length).toBeGreaterThanOrEqual(KILL_CYCLES + 3);
    // Nothing is in flight any more, so the one-frame allowance of the kill cycles does not apply:
    // the cursor must cover the whole log.
    expect(
      checkCursorCoversLog({ frames: log.frames, metaSeqno: readMetaSeqno(cgId) }),
      'the .meta cursor does not cover the quiescent log',
    ).toEqual([]);
    const lastSeqno = log.seqnos.at(-1)!;
    const mid = log.seqnos[Math.floor(log.seqnos.length / 2)]!;
    // A page smaller than the log, so reaching the end from 0 takes at least three non-empty pages
    // and every continuation resumes from a truncated one.
    const pageSize = Math.max(1, Math.floor(log.seqnos.length / 3));

    // Page like a real requester: one round per call, resuming from the returned cursor until the
    // host has nothing more, from several starting cursors.
    for (const start of [0, mid, lastSeqno - 1, lastSeqno]) {
      const expected = log.frames.filter((frame) => frame.seqno > start);
      const served: ServedEntry[] = [];
      const pages: ObservedCatchupPage[] = [];
      let since = start;
      let calls = 0;
      for (;;) {
        calls += 1;
        expect(calls, `start=${start}: paging did not terminate`).toBeLessThan(200);
        const res = await postJson(nodeFor(CURATOR, true), '/api/shared-memory/host-catchup', {
          contextGraphId: cgId,
          peerId: hostPeerId,
          sinceSeqno: since,
          maxRounds: 1,
          maxEntriesPerRound: pageSize,
          includeEntries: true,
        });
        expect(res.status, `host-catchup since=${since}: ${JSON.stringify(res.json)}`).toBe(200);
        const peer = res.json.peers?.[0];
        expect(peer, `host-catchup since=${since} reached no peer: ${JSON.stringify(res.json)}`).toBeTruthy();
        expect(peer.denied, `host denied catch-up: ${JSON.stringify(peer)}`).toBeUndefined();
        expect(peer.error, `host-catchup error: ${JSON.stringify(peer)}`).toBeUndefined();
        expect(peer.entries, `start=${start}: the page lists what the host served`).toHaveLength(peer.fetched);
        pages.push({ since, fetched: peer.fetched, nextSeqno: peer.nextSeqno });
        if (peer.fetched === 0) break;
        served.push(...peer.entries);
        since = peer.nextSeqno;
      }
      // Page by page: each call resumed where the last stopped, held at most a page, and advanced
      // the cursor over exactly the frames it served; the walk ended on an empty response after
      // ceil(frames / page) nonempty ones, at least three from 0 (it must cross page boundaries).
      expect(
        checkCatchupWalk({ start, frames: log.frames, pages, pageSize, ...(start === 0 ? { minNonemptyPages: 3 } : {}) }),
        `start=${start}: the catch-up walk`,
      ).toEqual([]);
      // The served envelopes, across the pages and in order, are exactly the frames on disk after
      // the cursor: none missing, repeated or reordered, each byte-identical to its ciphertext.
      expect(checkServedFrames({ expected, served }), `start=${start}: catch-up did not serve the log suffix`).toEqual([]);
    }
  }, 600_000);
});
