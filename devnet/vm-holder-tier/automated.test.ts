/**
 * VM exact-recovery holder tier — live devnet coverage.
 *
 * Network-observable behavior under test: an Edge that subscribes to a public
 * Context Graph reaches its FULL Verifiable-Memory KA count when the only peer
 * it is connected to holds none of the graph's data and the graph's curator is
 * offline, because the ShardingTable Cores that hold the data are reachable from
 * the unsigned phonebook profiles the chain vouches for (ShardingTable
 * membership plus the wallet-to-identity binding). Data is still verified
 * against the on-chain merkle roots; the profiles decide only whom to dial.
 *
 * Topology built by the suite (a default `devnet.sh start 6` is enough):
 *   - Core 1 (the edges' only peer) is restarted with `DKG_VM_RECONCILER_ENABLED=0`
 *     before anything is published: a Core with VM reconciliation off declines
 *     every public StorageACK and never back-fills a public graph, so it never
 *     holds this one (a Core with it on fills its gaps from the other Cores within
 *     a minute of a restart, which the first live run showed). Cores 2 to 4 are
 *     then restarted so they reserve on the fresh relay (its restart dropped every
 *     reservation, and a node that kept finding none waits out a ten minute
 *     cooldown), and the suite waits until each advertises a circuit address
 *     through core 1: that address is the only way an edge that knows just their
 *     profiles can reach them. Core 4 then creates the graph and publishes N KAs:
 *     cores 2 and 3 sign and hold them. Core 4 - the graph's curator and author -
 *     is stopped afterwards, for the rest of the suite, so the curator tier of the
 *     recovery roster points at an offline peer.
 *   - Edges 5 and 6 are restarted with `DEVNET_EDGE_BOOTSTRAP_CORES=1`, so their
 *     only bootstrap peer (and relay) is core 1, with the periodic peer-sync
 *     reconciler off so nothing but the subscribe catch-up and the VM reconcile
 *     sweep decides whom they dial.
 *   - Edge 5 runs the default build. Edge 6 is the control: the same node with
 *     `DKG_VM_RECONCILE_HOLDER_TIER=0`, i.e. the behavior before the tier.
 *
 * What is asserted. Everything about the tier itself is asserted
 * UNCONDITIONALLY on the enabled edge, from the daemon's own log, as one causal
 * chain that only the holder tier can produce:
 *   1. the VM reconcile pass resolved the tier for the graph: at least two
 *      hinted holders across at least two ShardingTable identities, BOTH holder
 *      cores among the hinted peers (a peer is hinted only when its profile's
 *      wallet resolves on chain to a ShardingTable identity, so this is the
 *      wallet-to-identity binding of both cores), and `unmatched=0`: no core-role
 *      row the pass read failed that binding (true here because every core-role
 *      profile on this devnet is a ShardingTable member's). The stats line's
 *      `unbound` is not asserted: the phonebook query admits only rows with a
 *      well-formed wallet, so it is always 0 by construction and shows nothing;
 *   2. the recovery pass then found a hinted holder NOT connected and dialed it
 *      itself ("dialing hinted ShardingTable holder"): a peer that an earlier
 *      connection had already made reachable is never dialed, so this line is
 *      absent when something else connected the edge first;
 *   3. an exact fetch from that dialed holder came back `disposition=found`;
 *   4. the edge reaches N/N KAs.
 * A change that disables the tier or hides its hints removes 1 to 3 and fails
 * the suite.
 *
 * The tier-off control (edge 6) is INFORMATIONAL, not a pass criterion for the
 * feature. Its KA count and both edges' connections are only recorded: the
 * subscribe catch-up's connection-priming walk (`primeCatchupConnections`) and
 * the VM sweep's cached-miss check both dial the core-role phonebook profiles
 * that advertise a relay, with no help from the tier, and on a devnet the only
 * address either has for a holder is the relay circuit its profile advertises
 * (loopback addresses are never published). Nothing here can keep priming from
 * reaching a holder while still letting the tier reach it, so whether the
 * control converges is timing, not evidence: it reached N/N through the priming
 * walk in 7 of 11 live runs. The one thing asserted about it is that its kill
 * switch is honoured (no tier line, no dial line). `HOLDER_TIER_STRICT_CONTROL=1`
 * additionally requires that it does not converge, for a run known not to prime
 * in time. "Without the tier the holder is never reached" is asserted
 * deterministically by the in-process libp2p and Hardhat suites in
 * packages/agent.
 *
 * Preconditions:
 *   pnpm run build
 *   ./scripts/devnet.sh start 6
 * Run: pnpm test:devnet:vm-holder-tier
 *
 * The suite restarts nodes 1 to 6 and stops node 4 (never node identities,
 * wallets or chain state) and publishes only into its own freshly created
 * Context Graph. Evidence is written to `.devnet/vm-holder-tier-evidence.json`.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEVNET_DIR,
  REPO_ROOT,
  detectDevnet,
  ensureAllIdentities,
  getJson,
  lexical,
  makeNquadsFile,
  publishViaCli,
  queryNode,
  runDkgCli,
  sleep,
  type CliResult,
  type DevnetNode,
  type DevnetState,
} from '../_bootstrap/harness.js';

const N_KAS = 6;
/** Cores that sign the graph's ACKs and hold it: core 4 (its author) publishes while core 1 is down. */
const HOLDER_CORES = [2, 3];
const AUTHOR_CORE = 4;
const RELAY_CORE = 1;
const EDGE_TIER_ON = 5;
const EDGE_CONTROL = 6;
const CONVERGE_MS = Number(process.env.HOLDER_TIER_CONVERGE_MS ?? 600_000);
const CONTROL_EXTRA_MS = Number(process.env.HOLDER_TIER_CONTROL_EXTRA_MS ?? 90_000);
const STRICT_CONTROL = process.env.HOLDER_TIER_STRICT_CONTROL === '1';
const SPARSE_ENV = {
  DEVNET_EDGE_BOOTSTRAP_CORES: String(RELAY_CORE),
  DKG_SYNC_RECONCILER_ENABLED: '0',
};

interface Topology {
  state: DevnetState;
  cgId: string;
  peerIds: Record<number, string>;
  holderCounts: Record<number, number>;
  logOffsets: Record<number, number>;
}

const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  kas: N_KAS,
};
let topology: Topology;

function devnetSh(args: string[], env: Record<string, string> = {}, timeoutMs = 240_000): Promise<CliResult> {
  return new Promise((resolveResult, rejectResult) => {
    execFile(
      'bash',
      [join(REPO_ROOT, 'scripts/devnet.sh'), ...args],
      { cwd: REPO_ROOT, env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number') {
          rejectResult(new Error(`devnet.sh ${args.join(' ')} failed: ${error.message}\n${stderr}`));
          return;
        }
        resolveResult({ code: error === null ? 0 : (error.code as number), stdout, stderr });
      },
    );
  });
}

function expectOk(result: CliResult, label: string): void {
  expect(result.code, `${label} failed (exit ${result.code})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
}

async function peerIdOf(node: DevnetNode): Promise<string> {
  const { status, json } = await getJson(node, '/api/status');
  expect(status, `node${node.num} /api/status`).toBe(200);
  expect(json?.peerId, `node${node.num} peerId`).toEqual(expect.any(String));
  return json.peerId as string;
}

async function connectedPeerIds(node: DevnetNode): Promise<Set<string>> {
  const { status, json } = await getJson(node, '/api/connections');
  expect(status, `node${node.num} /api/connections`).toBe(200);
  return new Set((json?.connections ?? []).map((c: { peerId: string }) => c.peerId));
}

/**
 * A node holds a relay reservation when it advertises a circuit address through
 * that relay: the address a peer that only knows this node's profile dials.
 */
async function hasRelayReservation(node: DevnetNode, relayPeerId: string): Promise<boolean> {
  const { status, json } = await getJson(node, '/api/status');
  return status === 200
    && Array.isArray(json?.multiaddrs)
    && (json.multiaddrs as string[]).some((address) => address.includes(`/p2p/${relayPeerId}/p2p-circuit`));
}

async function waitForRelayReservation(node: DevnetNode, relayPeerId: string, budgetMs = 240_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  do {
    if (await hasRelayReservation(node, relayPeerId)) return;
    await sleep(3_000);
  } while (Date.now() < deadline);
  throw new Error(
    `core ${node.num} holds no relay reservation on core ${RELAY_CORE} after ${budgetMs} ms: `
      + 'an edge that only knows its profile could not dial it, so the topology is not usable',
  );
}

/** Distinct finalized subjects the node holds in the graph's Verifiable Memory. */
async function vmCount(node: DevnetNode, cgId: string): Promise<number> {
  try {
    const rows = await queryNode(
      node,
      'SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s <https://schema.org/name> ?o }',
      { contextGraphId: cgId, view: 'verifiable-memory' },
    );
    return Number(lexical(rows[0]?.n ?? '0'));
  } catch {
    // A node that has not synced the graph yet has nothing to query.
    return 0;
  }
}

const logPath = (node: DevnetNode): string => join(node.home, 'daemon.log');

function logSize(node: DevnetNode): number {
  return existsSync(logPath(node)) ? statSync(logPath(node)).size : 0;
}

/** The last 8 characters of a peer id: how the daemon's log names peers. */
const shortId = (peerId: string): string => peerId.slice(-8);

/** This suite's lines only: written after the node's last restart and naming its graph. */
function suiteLog(node: DevnetNode, offset: number, cgId: string): string[] {
  if (!existsSync(logPath(node))) return [];
  return readFileSync(logPath(node)).subarray(offset).toString('utf8')
    .split('\n')
    .filter((line) => line.includes(cgId));
}

/**
 * `dkg subscribe` right after a (re)start can meet an authority index that is
 * still scanning the chain: the daemon answers a retryable 503 ("read authority
 * is temporarily unavailable"). Retry until it takes, as its own message says.
 */
async function subscribeWithRetry(node: DevnetNode, cgId: string, budgetMs = 300_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let last: CliResult | undefined;
  do {
    last = await runDkgCli(node, ['subscribe', cgId, '--save'], 240_000);
    if (last.code === 0) return;
    const retryable = /temporarily unavailable|retry once/i.test(`${last.stdout}\n${last.stderr}`);
    if (!retryable) break;
    await sleep(5_000);
  } while (Date.now() < deadline);
  expectOk(last!, `subscribe node${node.num}`);
}

async function restartNode(num: number, env: Record<string, string> = {}): Promise<void> {
  expectOk(await devnetSh(['restart-node', String(num)], env), `restart-node ${num}`);
}

beforeAll(async () => {
  const state = await detectDevnet(6);
  if (!state) {
    throw new Error('No devnet detected - run pnpm run build && ./scripts/devnet.sh start 6 before this suite.');
  }
  await ensureAllIdentities(state, 4);
  const author = state.nodes[AUTHOR_CORE]!;

  const peerIds: Record<number, string> = {};
  for (const n of [1, 2, 3, 4, EDGE_TIER_ON, EDGE_CONTROL]) peerIds[n] = await peerIdOf(state.nodes[n]!);

  // 1. Core 1 declines ACKs and never back-fills; core 4 then creates its own
  //    public graph and publishes, so only cores 2, 3 and 4 hold it.
  await restartNode(RELAY_CORE, { DKG_VM_RECONCILER_ENABLED: '0' });
  // The relay's restart dropped every circuit reservation it held, and a node
  // whose watchdog kept finding none waits out a ten-minute cooldown before it
  // asks again (a first live run of this suite left both holders unreachable
  // for the whole wait). Restart the cores an edge must later reach through
  // core 1, so each reserves on the fresh relay and re-meshes with the others,
  // and wait until each advertises a circuit address through it.
  for (const n of [...HOLDER_CORES, AUTHOR_CORE]) await restartNode(n);
  for (const n of [...HOLDER_CORES, AUTHOR_CORE]) {
    await waitForRelayReservation(state.nodes[n]!, peerIds[RELAY_CORE]!);
  }
  const slug = `vm-holder-tier-${Date.now().toString(36)}`;
  const created = await runDkgCli(author, [
    'context-graph', 'create', slug,
    '--name', 'VM holder tier devnet',
    '--description', 'Ephemeral context graph for the VM holder tier devnet suite',
  ], 120_000);
  expectOk(created, 'context-graph create');
  const cgId = /^\s*ID:\s+(.+)$/m.exec(created.stdout)?.[1]?.trim();
  if (!cgId) throw new Error(`could not parse the context graph id from:\n${created.stdout}`);
  expectOk(await runDkgCli(author, ['context-graph', 'register', cgId], 240_000), 'context-graph register');
  const published: string[] = [];
  for (let i = 1; i <= N_KAS; i += 1) {
    const { path } = makeNquadsFile(import.meta.dirname, `holder-tier-${i}`, cgId);
    published.push((await publishViaCli(author, cgId, path)).kaId?.toString() ?? '');
  }
  evidence.contextGraph = cgId;
  evidence.publishedKaIds = published;

  // 2. The ACK signers promote their copies shortly after the publish.
  const holderCounts: Record<number, number> = {};
  const deadline = Date.now() + 300_000;
  do {
    for (const n of HOLDER_CORES) holderCounts[n] = await vmCount(state.nodes[n]!, cgId);
    if (Math.max(...HOLDER_CORES.map((n) => holderCounts[n]!)) === N_KAS) break;
    await sleep(3_000);
  } while (Date.now() < deadline);

  // 3. Core 1 holds none of it; the curator/author goes away.
  holderCounts[RELAY_CORE] = await vmCount(state.nodes[RELAY_CORE]!, cgId);
  expectOk(await devnetSh(['stop-node', String(AUTHOR_CORE)]), `stop-node ${AUTHOR_CORE}`);
  evidence.holderCounts = holderCounts;

  // 4. Both edges get a bootstrap set of {core 1} only. Edge 6 is the control.
  const logOffsets: Record<number, number> = {};
  for (const [num, env] of [
    [EDGE_TIER_ON, SPARSE_ENV],
    [EDGE_CONTROL, { ...SPARSE_ENV, DKG_VM_RECONCILE_HOLDER_TIER: '0' }],
  ] as const) {
    logOffsets[num] = logSize(state.nodes[num]!);
    await restartNode(num, env);
  }

  topology = { state, cgId, peerIds, holderCounts, logOffsets };
}, 1_800_000);

describe('VM exact recovery holder tier on a live devnet', () => {
  it('starts from a topology in which no connected peer holds the graph and the curator is gone', async () => {
    const { state, peerIds, holderCounts } = topology;
    expect(Math.max(...HOLDER_CORES.map((n) => holderCounts[n]!)), 'a holder core has the whole graph').toBe(N_KAS);
    expect(holderCounts[RELAY_CORE], 'the relay core must lack the graph').toBeLessThan(N_KAS);
    // ...but every holder core is reachable through the one relay both edges know.
    for (const holder of HOLDER_CORES) {
      expect(
        await hasRelayReservation(state.nodes[holder]!, peerIds[RELAY_CORE]!),
        `core ${holder} holds a relay reservation on core ${RELAY_CORE}`,
      ).toBe(true);
    }
    for (const edgeNum of [EDGE_TIER_ON, EDGE_CONTROL]) {
      const connected = await connectedPeerIds(state.nodes[edgeNum]!);
      expect(connected.has(peerIds[RELAY_CORE]!), `edge ${edgeNum} reaches core ${RELAY_CORE}`).toBe(true);
      for (const holder of [...HOLDER_CORES, AUTHOR_CORE]) {
        expect(connected.has(peerIds[holder]!), `edge ${edgeNum} must not start connected to core ${holder}`).toBe(false);
      }
    }
  });

  it('reaches the full KA count from cores it was not connected to', async () => {
    const { state, cgId, peerIds, logOffsets } = topology;
    const edge = state.nodes[EDGE_TIER_ON]!;
    const control = state.nodes[EDGE_CONTROL]!;
    for (const node of [edge, control]) await subscribeWithRetry(node, cgId);

    const started = Date.now();
    let edgeCount = 0;
    while (Date.now() - started < CONVERGE_MS) {
      edgeCount = await vmCount(edge, cgId);
      if (edgeCount === N_KAS) break;
      await sleep(5_000);
    }
    evidence.edgeCount = edgeCount;
    evidence.edgeConvergedMs = edgeCount === N_KAS ? Date.now() - started : null;

    // The control gets the same time again, so "stuck" is not "slow".
    await sleep(CONTROL_EXTRA_MS);
    const controlCount = await vmCount(control, cgId);
    evidence.controlCount = controlCount;

    const edgeLines = suiteLog(edge, logOffsets[EDGE_TIER_ON]!, cgId);
    const controlLines = suiteLog(control, logOffsets[EDGE_CONTROL]!, cgId);
    const isTierLine = (line: string) => line.includes('VM exact fetch holder tier for');
    const isDialLine = (line: string) => line.includes('VM exact fetch dialing hinted ShardingTable holder');
    const tierLines = edgeLines.filter(isTierLine);
    const firstTierAt = edgeLines.findIndex(isTierLine);
    const dialedAt = (holder: number) => edgeLines.findIndex(
      (line) => isDialLine(line) && line.includes(`holder ${shortId(peerIds[holder]!)} `),
    );
    const foundAt = (holder: number) => edgeLines.findIndex(
      (line) => line.includes(`from ${shortId(peerIds[holder]!)}:`)
        && line.includes('VM exact fetch for')
        && line.includes('disposition=found'),
    );
    const dialedAndFetched = HOLDER_CORES.filter((n) => dialedAt(n) >= 0 && foundAt(n) > dialedAt(n));
    const connectedAfter = await connectedPeerIds(edge);
    const controlConnectedAfter = await connectedPeerIds(control);
    const reached = (connected: Set<string>) => HOLDER_CORES.filter((n) => connected.has(peerIds[n]!));
    const stat = (name: string): number => Number(new RegExp(`${name}=(\\d+)`).exec(tierLines.at(-1) ?? '')?.[1] ?? Number.NaN);
    evidence.tierLogLines = tierLines.slice(-3);
    evidence.tierStats = {
      profiles: stat('profiles'),
      unbound: stat('unbound'),
      unmatched: stat('unmatched'),
      pages: stat('pages'),
      lookups: stat('lookups'),
      identities: Number(/across (\d+) identit/.exec(tierLines.at(-1) ?? '')?.[1] ?? Number.NaN),
    };
    evidence.edgeDialedHolderCores = HOLDER_CORES.filter((n) => dialedAt(n) >= 0);
    evidence.edgeFetchedFoundFromHolderCores = HOLDER_CORES.filter((n) => foundAt(n) >= 0);
    evidence.edgeDialedThenFetchedFromHolderCores = dialedAndFetched;
    evidence.edgeConnectedHolderCores = reached(connectedAfter);
    evidence.controlConnectedHolderCores = reached(controlConnectedAfter);
    evidence.controlTierOrDialLogLines = controlLines.filter((l) => isTierLine(l) || isDialLine(l)).length;
    writeFileSync(join(DEVNET_DIR, 'vm-holder-tier-evidence.json'), JSON.stringify(evidence, null, 2));

    // 1. The tier resolved for the graph, and the resolution is real: hinted
    //    peers exist only for wallets the chain bound to ShardingTable identities.
    expect(tierLines.length, 'the enabled edge resolved the holder tier for the graph').toBeGreaterThan(0);
    const last = tierLines.at(-1)!;
    const hinted = Number(/(\d+) hinted ShardingTable holder\(s\)/.exec(last)?.[1] ?? 0);
    expect(hinted, `hinted holders in: ${last}`).toBeGreaterThanOrEqual(HOLDER_CORES.length);
    const identities = Number(/across (\d+) identit/.exec(last)?.[1] ?? 0);
    expect(identities, `ShardingTable identities behind the hinted holders in: ${last}`).toBeGreaterThanOrEqual(HOLDER_CORES.length);
    // Every core-role row read resolved to a ShardingTable identity (`unbound` would show nothing:
    // the phonebook query never returns a row without a well-formed wallet).
    expect(last).toMatch(/unmatched=0\b/);
    const hintedPeers = (/\[peers=([^\]]*)\]/.exec(last)?.[1] ?? '').split(',');
    for (const holder of HOLDER_CORES) {
      expect(hintedPeers, `core ${holder} is among the hinted peers in: ${last}`).toContain(shortId(peerIds[holder]!));
    }
    // 2 + 3. A hinted holder that was not connected was dialed by the recovery
    //    pass itself, after the tier resolved, and then served the data.
    expect(
      dialedAndFetched.length,
      'a hinted holder core was dialed by the recovery pass and then served the graph '
        + `(dialed: ${JSON.stringify(evidence.edgeDialedHolderCores)}, `
        + `found: ${JSON.stringify(evidence.edgeFetchedFoundFromHolderCores)}, `
        + `connected at the end: ${JSON.stringify(evidence.edgeConnectedHolderCores)})`,
    ).toBeGreaterThan(0);
    for (const holder of dialedAndFetched) {
      expect(dialedAt(holder), `core ${holder} was dialed after the tier resolved`).toBeGreaterThan(firstTierAt);
    }
    // 4. The whole graph arrived.
    expect(edgeCount, 'edge with the holder tier reaches the full KA count').toBe(N_KAS);

    // The kill switch is honoured: the control neither resolves the tier nor dials a hinted holder.
    expect(controlLines.filter((line) => isTierLine(line) || isDialLine(line))).toEqual([]);
    if (STRICT_CONTROL) {
      expect(controlCount, 'the tier-off control must not converge in a topology that isolates the holders').toBeLessThan(N_KAS);
    }
  }, 1_800_000);
});
