/**
 * #2858 — a confirmed VM copy follows its Knowledge Asset through on-chain
 * updates.
 *
 * An update keeps the KA id and moves its latest root. The ordinal walk
 * never revisits a settled ordinal, and a node whose only copy is a confirmed
 * VM copy (a member of a catalog graph) has no other lane that brings the new
 * version. These tests pin the parts of the fix:
 *
 *   1. `VmRefreshQueue` — the bounded target set and its retry schedule.
 *   2. `handleKAUpdatedNudge` — the `KnowledgeAssetUpdated` nudge decides from
 *      local state alone which held copies are behind the event.
 *   3. A refresh worker, started by the graph's reconcile pass and run beside
 *      it, works the targets off: it reads the chain, fetches the exact
 *      current version and replaces the older copy, and never rolls a copy
 *      back for an older or superseded event. A peer that cannot be reached
 *      costs one bounded step, and neither it nor a stuck attempt holds the
 *      pass or drops the target.
 *   4. The chain event poller's update lane is wired to the nudge, with or
 *      without the RFC-64 kill switch.
 *
 * The worker runs the real exact-asset fetch (chain evidence, local inspection
 * through the finalization handler, re-inspection); only the peer transport is
 * replaced, by a responder that materializes the version the chain names.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  buildKnowledgeAssetUal,
  type ChainAdapter,
  type ChainEvent,
  type EventFilter,
} from '@origintrail-official/dkg-chain';
import {
  MemoryLayer,
  TypedEventBus,
  createGraphKnowledgeAssetScope,
  createOperationContext,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  ChainEventPoller,
  PublishHandler,
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
  resolveKnowledgeAssetWorkspaceHead,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { GraphManager, OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { resolveConfirmedGraphScopedVm } from '../src/confirmed-graph-scoped-vm-resolver.js';
import { packKnowledgeAssetIdFromIdentity } from '../src/ka-identity.js';
import { materializeVerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';
import type { OrdinalOutcome } from '../src/chain-reconciler.js';
import type { ContextGraphReconcileResult } from '../src/vm-reconcile-service.js';
import { VmRefreshQueue, type VmRefreshTarget } from '../src/vm-refresh.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

const CG = '501';
const ON_CHAIN_CG = 501n;
const AUTHOR = '0x00000000000000000000000000000000000a0701';
const PUBLISHER = '0x2222222222222222222222222222222222222222';
const PEER = '12D3KooWRefreshProviderPeer';

const kaIdOf = (kaNumber: bigint) => packKnowledgeAssetIdFromIdentity({ agentAddress: AUTHOR, kaNumber });

interface RefreshInternals {
  store: TripleStore;
  chain: MockChainAdapter;
  subscribedContextGraphs: Map<string, {
    subscribed: boolean;
    coreHosted?: boolean;
    onChainId?: string;
    lastReconciledOrdinal?: number;
  }>;
  vmRefreshQueue: VmRefreshQueue;
  vmRefreshWorkers: Map<string, Promise<void>>;
  vmReconcileScheduling?: unknown;
  log: Record<'debug' | 'info' | 'warn', (...args: unknown[]) => void>;
  handleKAUpdatedNudge(
    kaId: bigint,
    merkleRoot: Uint8Array,
    ctx: ReturnType<typeof createOperationContext>,
    options?: { blockNumber?: number; logIndex?: number; blockHash?: string; txHash?: string; signal?: AbortSignal },
  ): Promise<VmRefreshTarget[]>;
  runVmRefreshesForCg(
    localCgId: string,
    onChainId: string,
    isTargetCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  startVmRefreshWorker(
    localCgId: string,
    onChainId: string,
    isTargetCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<void> | undefined;
  runVmReconcileForCg(
    localCgId: string,
    source?: 'live' | 'periodic' | 'manual',
  ): Promise<ContextGraphReconcileResult>;
  vmRefreshPersistCeiling(): number | undefined;
  reconcileChainOrdinal(
    localCgId: string,
    onChainCgId: bigint,
    ordinal: number,
    headBlock: number | undefined,
    options?: Record<string, never>,
  ): Promise<OrdinalOutcome>;
}

/** One version of a KA: its VM content, and the root and version the chain records. */
interface KaVersion {
  readonly label: string;
  readonly assertionVersion: bigint;
}

function contentOf(ual: string, version: KaVersion, localCgId = CG) {
  const scope = createGraphKnowledgeAssetScope(ual, version.assertionVersion);
  const assertionGraph = knowledgeAssetLayerGraphUri(localCgId, MemoryLayer.VerifiableMemory, scope);
  const dataQuads: Quad[] = [{
    subject: `urn:refresh:${scope.kaNumber}`,
    predicate: 'http://schema.org/name',
    object: `"${version.label}"`,
    graph: assertionGraph,
  }];
  const root = computeFlatKCRootV10(dataQuads.map((quad) => ({ ...quad, graph: '' })), []);
  return { assertionGraph, dataQuads, root };
}

/**
 * Install one confirmed version exactly as a verified durable fetch does, or,
 * given `txHash`, as the receipt-backed confirmation of that transaction.
 */
async function materialize(
  store: TripleStore,
  ual: string,
  kaId: bigint,
  version: KaVersion,
  localCgId = CG,
  txHash?: string,
): Promise<string> {
  const { assertionGraph, dataQuads, root } = contentOf(ual, version, localCgId);
  return materializeVerifiedGraphScopedAsset({
    store,
    asset: {
      contextGraphId: localCgId,
      ual,
      assertionVersion: version.assertionVersion,
      assertionGraph,
      metaGraph: `did:dkg:context-graph:${localCgId}/_meta`,
      dataQuads,
      metadataQuads: generateGraphKnowledgeAssetMetadata({
        contextGraphId: localCgId,
        ual,
        merkleRoot: root,
        publisherPeerId: 'rfc64-finalized-catalog-v1',
        accessPolicy: 'public',
        allowedPeers: [],
        timestamp: new Date('2026-09-27T08:00:00.000Z'),
        assertionVersion: version.assertionVersion,
        authorAddress: AUTHOR,
        publicTripleCount: 1,
        privateTripleCount: 0,
        assertionGraph,
      }, {
        status: 'confirmed',
        confirmation: txHash === undefined
          ? {
              kind: 'finalized-materialization',
              provenance: {
                batchId: kaId,
                materializedVersion: { blockNumber: 100, txIndex: 0 },
              },
            }
          : {
              kind: 'transaction',
              provenance: {
                txHash,
                blockNumber: 100,
                blockTimestamp: 1_790_000_000,
                publisherAddress: PUBLISHER,
                batchId: kaId,
                chainId: 'mock:31337',
              },
            },
      }),
    },
  });
}

async function localRootHex(store: TripleStore, ual: string, localCgId = CG): Promise<string | undefined> {
  const read = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, {
    contextGraphId: localCgId,
    ual,
  });
  return read.state === 'confirmed' ? ethers.hexlify(read.envelope.merkleRoot) : undefined;
}

async function localVersion(store: TripleStore, ual: string): Promise<string | undefined> {
  const read = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, { contextGraphId: CG, ual });
  return read.state === 'confirmed' ? read.envelope.assertionVersion : undefined;
}

/**
 * Stage one version in the graph's workspace with its head, as a share or a
 * StorageACK copy does: the chain's content of `content` when given, else a
 * draft of its own.
 */
async function stageWorkspaceCopy(
  store: TripleStore,
  ual: string,
  assertionVersion: string,
  shareOperationId: string,
  content?: KaVersion,
): Promise<void> {
  const graphManager = new GraphManager(store);
  const scope = createGraphKnowledgeAssetScope(ual, assertionVersion);
  const graph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
  const quads = content
    ? contentOf(ual, content).dataQuads.map((quad) => ({ ...quad, graph }))
    : [{
        subject: `urn:refresh:${shareOperationId}`,
        predicate: 'http://schema.org/name',
        object: `"${shareOperationId}"`,
        graph,
      }];
  await store.insert(quads);
  await storeKnowledgeAssetOperationPublicQuads({
    store,
    graphManager,
    contextGraphId: CG,
    shareOperationId,
    kaUal: scope.ual,
    assertionVersion: scope.assertionVersion,
    quads,
    privateTripleCount: 0,
    publisherPeerId: '12D3KooWRefreshPublisher',
  });
  await storeKnowledgeAssetWorkspaceHead({
    store,
    graphManager,
    contextGraphId: CG,
    shareOperationId,
    kaUal: scope.ual,
    assertionVersion: scope.assertionVersion,
  });
}

let agent: DKGAgent | null = null;
const restores: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (agent) {
    await agent.stop().catch(() => undefined);
    agent = null;
  }
  for (const restore of restores.splice(0)) await restore();
});

/** Shorten one of the refresh lane's time bounds for this test. */
function overrideRefreshBound(
  name: 'VM_REFRESH_PEER_STEP_TIMEOUT_MS' | 'VM_REFRESH_ATTEMPT_TIMEOUT_MS',
  value: number,
): void {
  const original = Object.getOwnPropertyDescriptor(DKGAgentBase, name)!;
  Object.defineProperty(DKGAgentBase, name, { ...original, value });
  restores.push(() => {
    Object.defineProperty(DKGAgentBase, name, original);
  });
}

/** Let the graph's refresh worker, when one runs, finish. */
async function refreshWorkerSettled(internals: RefreshInternals, localCgId = CG): Promise<void> {
  await internals.vmRefreshWorkers.get(localCgId);
}

/** A step that never returns and ignores its signal, like a dial with no deadline. */
const never = (): Promise<never> => new Promise<never>(() => undefined);

function logLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[1]));
}

/**
 * A member node holding confirmed VM copies of KAs in graph 501, whose ordinal
 * cursor has already settled every registration. The chain double answers each
 * KA's current version from `chainVersions`; the peer transport materializes
 * that version, or nothing while `peerHasCurrent` is false.
 */
async function bootMember(options: {
  kaNumbers?: readonly bigint[];
  /** Connected peers, in connection order; the curator roster is empty when set. */
  peers?: readonly string[];
  /** Peers that serve the current version; every peer does when unset. */
  holders?: readonly string[];
  /** The graph's curators, asked first; overrides the default roster. */
  curators?: readonly string[];
  /** Curator resolution never returns, like a registry read behind a stuck dial. */
  curatorResolutionHangs?: boolean;
  /** The connect step for one candidate; returns at once when unset. */
  connect?: (peerId: string, signal: AbortSignal | undefined) => Promise<void>;
  /** The transfer from one prepared peer; runs before the responder when set. */
  beforeFetch?: (peerId: string) => Promise<void>;
  /** Keep the responder on the version chosen when its transfer began. */
  captureVersionAtFetchStart?: boolean;
} = {}) {
  const kaNumbers = options.kaNumbers ?? [7n];
  const peers = options.peers ?? [PEER];
  const chain = new MockChainAdapter();
  agent = await DKGAgent.create({ name: 'VmRefreshMember', chainAdapter: chain });
  const internals = agent as unknown as RefreshInternals;
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWRefreshMemberSelf',
    libp2p: {
      getPeers: () => [],
      getConnections: () => peers.map((peerId) => ({ remotePeer: { toString: () => peerId } })),
    },
  };
  agent.canReadContextGraph = async () => true;

  const kas = kaNumbers.map((kaNumber) => ({
    kaNumber,
    kaId: kaIdOf(kaNumber),
    ual: buildKnowledgeAssetUal(chain.chainId, AUTHOR, kaNumber),
  }));
  const chainVersions = new Map<bigint, KaVersion>();
  // The version before each KA's latest update, for a chain read that has not
  // seen that update yet.
  const previousVersions = new Map<bigint, KaVersion>();
  /**
   * What the chain double's reads see: the pinned view's block, and whether
   * the live root read (a lagging endpoint) or the pinned view (a confirmation
   * depth above one) still predates each KA's latest update.
   */
  const view = { blockNumber: 100, laggingRoot: false, laggingSnapshot: false };
  const versionSeen = (kaId: bigint, lagging: boolean): KaVersion | undefined =>
    (lagging ? previousVersions.get(kaId) : undefined) ?? chainVersions.get(kaId);
  for (const ka of kas) {
    const v1: KaVersion = { label: `A-${ka.kaNumber}`, assertionVersion: 1n };
    chainVersions.set(ka.kaId, v1);
    chain.__registerKC({
      kaId: ka.kaId,
      contextGraphId: ON_CHAIN_CG,
      merkleRootHex: ethers.hexlify(contentOf(ka.ual, v1).root),
      chunks: [],
    });
    await materialize(internals.store, ka.ual, ka.kaId, v1);
  }
  const uals = new Map(kas.map((ka) => [ka.ual, ka]));
  // Every registration is settled: the ordinal walk has nothing left to visit.
  internals.subscribedContextGraphs.set(CG, {
    subscribed: true,
    onChainId: CG,
    lastReconciledOrdinal: kas.length,
  });

  const rootReads = recorder(async (kaId: bigint) => {
    const version = versionSeen(kaId, view.laggingRoot);
    const ka = kas.find((candidate) => candidate.kaId === kaId);
    if (!version || !ka) throw new Error(`unknown KA ${kaId}`);
    return contentOf(ka.ual, version).root;
  });
  chain.getLatestMerkleRoot = rootReads;
  const snapshotReads = recorder(async (kaId: bigint) => {
    const version = versionSeen(kaId, view.laggingSnapshot);
    const ka = kas.find((candidate) => candidate.kaId === kaId);
    if (!version || !ka) return null;
    return {
      latestRoot: ethers.hexlify(contentOf(ka.ual, version).root),
      rootCount: version.assertionVersion,
      latestAuthor: AUTHOR,
      latestPublisher: PUBLISHER,
      blockNumber: view.blockNumber,
    };
  });
  chain.readKnowledgeAssetVersionSnapshot = snapshotReads as typeof chain.readKnowledgeAssetVersionSnapshot;
  chain.getKAContextGraphId = async () => ON_CHAIN_CG;

  const transport = { peerHasCurrent: true };
  const fetches = recorder(async (
    peerId: string,
    _localCgId: string,
    requested: readonly string[],
    fetchOptions?: { forceFreshExactSession?: boolean },
  ) => {
    void fetchOptions;
    const captured = options.captureVersionAtFetchStart
      ? new Map(requested.map((ual) => {
          const ka = uals.get(ual);
          return [ual, ka ? chainVersions.get(ka.kaId) : undefined] as const;
        }))
      : undefined;
    await options.beforeFetch?.(peerId);
    if (transport.peerHasCurrent && (options.holders === undefined || options.holders.includes(peerId))) {
      for (const ual of requested) {
        const ka = uals.get(ual);
        const version = captured ? captured.get(ual) : ka ? chainVersions.get(ka.kaId) : undefined;
        if (ka && version) await materialize(internals.store, ual, ka.kaId, version);
      }
    }
    return { result: {}, disposition: transport.peerHasCurrent ? 'found' : 'clean-absent' };
  });
  const connects = recorder(async (peerId: string, connectOptions: { signal?: AbortSignal } = {}) => {
    await options.connect?.(peerId, connectOptions.signal);
  });
  Object.assign(agent as unknown as Record<string, unknown>, {
    resolveCuratorPeerIdsForCg: async () => {
      if (options.curatorResolutionHangs) await never();
      return {
        peerIds: options.curators ?? (options.peers === undefined ? [PEER] : []),
        curatorIsLocal: false,
        legacyTripleResolved: false,
      };
    },
    ensurePeerConnected: connects,
    waitForSyncProtocol: async () => true,
    ensurePeerAdmittedForRecovery: async () => true,
    syncExactKnowledgeAssetsFromPeerDetailed: fetches,
  });

  /** Move one KA's on-chain version, as a confirmed `/api/update` does. */
  const updateOnChain = (kaNumber: bigint, version: KaVersion): Uint8Array => {
    const ka = kas.find((candidate) => candidate.kaNumber === kaNumber)!;
    previousVersions.set(ka.kaId, chainVersions.get(ka.kaId)!);
    chainVersions.set(ka.kaId, version);
    return contentOf(ka.ual, version).root;
  };
  return {
    chain,
    internals,
    kas,
    updateOnChain,
    view,
    rootReads,
    snapshotReads,
    fetches,
    transport,
    connects,
  };
}

const ctx = createOperationContext('system');

describe('VmRefreshQueue', () => {
  const target = (
    merkleRoot: string,
    ual = 'did:dkg:mock:31337/0xabc/1',
    blockNumber?: number,
    logIndex?: number,
  ): VmRefreshTarget => ({
    localCgId: CG,
    ual,
    kaId: 1n,
    merkleRoot,
    ...(blockNumber === undefined ? {} : { blockNumber }),
    ...(logIndex === undefined ? {} : { logIndex }),
  });
  const queueAt = (clock: () => number, maxEntries = 8) => new VmRefreshQueue({
    maxEntries,
    baseBackoffMs: 60_000,
    maxBackoffMs: 600_000,
    maxAgeMs: 24 * 60 * 60_000,
    now: clock,
  });

  it('keeps one target per graph and KA: a replayed root keeps its backoff, a new root is due at once', () => {
    let now = 1_000;
    const queue = queueAt(() => now);
    expect(queue.offer(target('0xb2'))).toBe('recorded');
    expect(queue.due(CG, 10)).toEqual([{ ...target('0xb2'), failures: 0 }]);
    queue.settle(target('0xb2'), 'retry');
    expect(queue.due(CG, 10)).toEqual([]);

    // The same event replayed (a lane re-scan) cannot defeat the backoff.
    expect(queue.offer(target('0xb2'))).toBe('held');
    expect(queue.due(CG, 10)).toEqual([]);
    expect(queue.snapshot()).toMatchObject([{ merkleRoot: '0xb2', failures: 1, nextAttemptAt: 61_000 }]);

    // A later update is new evidence: it replaces the target and is due now.
    expect(queue.offer(target('0xc3'))).toBe('recorded');
    expect(queue.size).toBe(1);
    expect(queue.due(CG, 10)).toEqual([{ ...target('0xc3'), failures: 0 }]);
    now = 61_000;
    expect(queue.due('another-graph', 10)).toEqual([]);
  });

  it('settles only the attempted root and doubles the retry delay to its ceiling', () => {
    let now = 0;
    const queue = new VmRefreshQueue({
      maxEntries: 8,
      baseBackoffMs: 60_000,
      maxBackoffMs: 200_000,
      maxAgeMs: 24 * 60 * 60_000,
      now: () => now,
    });
    queue.offer(target('0xb2'));
    // An attempt for B finishes after C was recorded: C must stay.
    queue.offer(target('0xc3'));
    queue.settle(target('0xb2'), 'current');
    expect(queue.due(CG, 10)).toEqual([{ ...target('0xc3'), failures: 0 }]);

    const delays: number[] = [];
    for (let failure = 0; failure < 4; failure += 1) {
      queue.settle(target('0xc3'), 'retry');
      delays.push(queue.snapshot()[0]!.nextAttemptAt - now);
    }
    expect(delays).toEqual([60_000, 120_000, 200_000, 200_000]);
    now = 1_000_000;
    // A due retry carries its attempt count for the caller's peer rotation.
    expect(queue.due(CG, 10)).toEqual([{ ...target('0xc3'), failures: 4 }]);
    queue.settle(target('0xc3'), 'refreshed');
    expect(queue.size).toBe(0);
  });

  it('retains a newer same-root event while an older refresh completes', () => {
    const queue = queueAt(() => 0);
    const first = target('0xb2', undefined, 150, 4);
    const second = target('0xb2', undefined, 160, 2);
    expect(queue.offer(first)).toBe('recorded');
    const [attempt] = queue.due(CG, 1);
    expect(attempt).toBeDefined();

    expect(queue.offer(second)).toBe('recorded');
    expect(queue.due(CG, 1)).toEqual([{ ...second, checkVersion: true, failures: 0 }]);
    expect(queue.oldestBlockNumber()).toBe(160);
    queue.settle(attempt!, 'refreshed');
    expect(queue.due(CG, 1)).toEqual([{ ...second, checkVersion: true, failures: 0 }]);
    expect(queue.offer(first)).toBe('held');
    expect(queue.oldestBlockNumber()).toBe(160);
    queue.settle(second, 'current');
    expect(queue.size).toBe(0);
  });

  it('separates two same-root updates in one block by their log positions', () => {
    const queue = queueAt(() => 0);
    const first = target('0xb2', undefined, 160, 4);
    const second = target('0xb2', undefined, 160, 7);
    expect(queue.offer(first)).toBe('recorded');
    expect(queue.offer(second)).toBe('recorded');
    queue.settle(first, 'current');
    expect(queue.due(CG, 1)).toEqual([{ ...second, checkVersion: true, failures: 0 }]);
  });

  it('uses distinct transaction hashes when an adapter has no log positions', () => {
    const queue = queueAt(() => 0);
    const first = { ...target('0xb2', undefined, 160), txHash: '0x01' };
    const second = { ...target('0xb2', undefined, 160), txHash: '0x02' };
    expect(queue.offer(first)).toBe('recorded');
    expect(queue.offer(second)).toBe('recorded');
    queue.settle(first, 'refreshed');
    expect(queue.due(CG, 1)).toEqual([{ ...second, checkVersion: true, failures: 0 }]);
  });

  it('keeps the backoff of an exact positioned replay', () => {
    const queue = queueAt(() => 1_000);
    const event = {
      ...target('0xb2', undefined, 160, 7),
      txHash: '0x01', blockHash: '0xaaa',
    };
    expect(queue.offer(event)).toBe('recorded');
    queue.settle(queue.due(CG, 1)[0]!, 'retry');
    expect(queue.offer({ ...event })).toBe('held');
    expect(queue.snapshot()).toMatchObject([{ failures: 1, nextAttemptAt: 61_000 }]);
  });

  it('recognizes a replacement block hash even when every other event field matches', () => {
    const queue = queueAt(() => 0);
    const oldFork = {
      ...target('0xb2', undefined, 160, 7), txHash: '0x01', blockHash: '0xaaa',
    };
    const canonical = { ...oldFork, blockHash: '0xbbb' };
    expect(queue.offer(oldFork)).toBe('recorded');
    const attempt = queue.due(CG, 1)[0]!;
    expect(queue.offer(canonical)).toBe('recorded');
    expect(queue.due(CG, 1)).toEqual([{ ...canonical, checkVersion: true, failures: 0 }]);
    queue.settle(attempt, 'refreshed');
    expect(queue.due(CG, 1)).toEqual([{ ...canonical, checkVersion: true, failures: 0 }]);
  });

  it('keeps a newly observed lower-position fork update and its proof boundary', () => {
    const queue = queueAt(() => 0);
    const oldFork = { ...target('0xb2', undefined, 160, 7), txHash: '0xold', blockHash: '0xoldfork' };
    const canonical = { ...target('0xc3', undefined, 159, 4), txHash: '0xnew', blockHash: '0xnewfork' };
    expect(queue.offer(oldFork)).toBe('recorded');
    const attempt = queue.due(CG, 1)[0]!;
    expect(queue.offer(canonical)).toBe('recorded');
    expect(queue.due(CG, 1)).toEqual([{
      ...canonical, checkVersion: true, proofBlockNumber: 160, failures: 0,
    }]);
    queue.settle(attempt, 'refreshed');
    expect(queue.oldestBlockNumber()).toBe(159);
    expect(queue.offer(oldFork)).toBe('held');
    expect(queue.size).toBe(1);
  });

  it('refuses a new KA when full, but still takes a newer root for a KA it holds', () => {
    const queue = queueAt(() => 0, 2);
    expect(queue.offer(target('0x01', 'ual-1'))).toBe('recorded');
    expect(queue.offer(target('0x02', 'ual-2'))).toBe('recorded');
    expect(queue.offer(target('0x03', 'ual-3'))).toBe('full');
    expect(queue.offer(target('0x04', 'ual-1'))).toBe('recorded');
    expect(queue.snapshot().map((entry) => [entry.ual, entry.merkleRoot])).toEqual([
      ['ual-2', '0x02'],
      ['ual-1', '0x04'],
    ]);
    expect(queue.refusedTotal).toBe(1);
    queue.clearContextGraph(CG);
    expect(queue.size).toBe(0);
  });

  it('names the oldest event block it holds, ignoring targets without one', () => {
    const queue = queueAt(() => 0);
    expect(queue.oldestBlockNumber()).toBeUndefined();
    queue.offer(target('0x01', 'ual-1', 160));
    queue.offer(target('0x02', 'ual-2'));
    queue.offer(target('0x03', 'ual-3', 150));
    expect(queue.oldestBlockNumber()).toBe(150);
    queue.settle(target('0x03', 'ual-3', 150), 'refreshed');
    expect(queue.oldestBlockNumber()).toBe(160);
  });

  it('gives up a target held past its maximum age, releasing its block and slot', () => {
    let now = 0;
    const queue = queueAt(() => now, 1);
    queue.offer(target('0x01', 'ual-1', 150));
    queue.settle(target('0x01', 'ual-1', 150), 'retry');
    now = 24 * 60 * 60_000 - 1;
    expect(queue.expire()).toEqual([]);
    expect(queue.offer(target('0x02', 'ual-2', 170))).toBe('full');

    now = 24 * 60 * 60_000;
    expect(queue.expire()).toEqual([
      expect.objectContaining({ ual: 'ual-1', blockNumber: 150, failures: 1, heldMs: 24 * 60 * 60_000 }),
    ]);
    expect(queue.givenUpTotal).toBe(1);
    expect(queue.oldestBlockNumber()).toBeUndefined();
    expect(queue.offer(target('0x02', 'ual-2', 170))).toBe('recorded');
  });

  it('holds a target offered with a delay until the delay has passed', () => {
    let now = 5_000;
    const queue = queueAt(() => now);
    expect(queue.offer(target('0xb2'), 30_000)).toBe('recorded');
    expect(queue.snapshot()).toMatchObject([{ merkleRoot: '0xb2', failures: 0, nextAttemptAt: 35_000 }]);
    expect(queue.due(CG, 10)).toEqual([]);
    expect(queue.dueContextGraphIds()).toEqual([]);
    now = 35_000;
    expect(queue.due(CG, 10)).toEqual([{ ...target('0xb2'), failures: 0 }]);
  });
});

describe('KnowledgeAssetUpdated nudge (#2858)', () => {
  it('does nothing, and reads no chain state, for a KA no reconcile target holds', async () => {
    const { internals, rootReads, snapshotReads, chain } = await bootMember();
    const triggers = recorder((_localCgId: string) => undefined);
    internals.vmReconcileScheduling = { triggerLive: triggers };
    // A copy in a graph this node does not reconcile (no subscription row).
    const unrelatedUal = buildKnowledgeAssetUal(chain.chainId, AUTHOR, 99n);
    await materialize(internals.store, unrelatedUal, kaIdOf(99n), { label: 'x', assertionVersion: 1n }, '777');

    const debug = vi.spyOn(internals.log, 'debug');
    await expect(internals.handleKAUpdatedNudge(kaIdOf(98n), new Uint8Array(32).fill(1), ctx))
      .resolves.toEqual([]);
    await expect(internals.handleKAUpdatedNudge(kaIdOf(99n), new Uint8Array(32).fill(1), ctx))
      .resolves.toEqual([]);

    expect(logLines(debug)).toEqual([
      expect.stringMatching(/^VM refresh: no local graph holds .+; nothing to refresh$/),
      `VM refresh: "777" holds ${unrelatedUal} but is not a VM reconcile target; not queued`,
    ]);
    expect(internals.vmRefreshQueue.size).toBe(0);
    expect(triggers.calls).toEqual([]);
    expect(rootReads.calls).toEqual([]);
    expect(snapshotReads.calls).toEqual([]);
  });

  it('does nothing when the event\'s own transaction confirmed the copy', async () => {
    const { internals, kas, rootReads } = await bootMember();
    const ual = kas[0]!.ual;
    const txHash = '0x' + 'ab'.repeat(32);
    // The publisher's own update: receipt-backed by the event's transaction.
    await materialize(internals.store, ual, kas[0]!.kaId, { label: 'B', assertionVersion: 2n }, CG, txHash);
    const current = await localRootHex(internals.store, ual);
    const debug = vi.spyOn(internals.log, 'debug');

    await expect(internals.handleKAUpdatedNudge(
      kas[0]!.kaId,
      ethers.getBytes(current!),
      ctx,
      { blockNumber: 150, txHash: txHash.toUpperCase().replace('0X', '0x') },
    )).resolves.toEqual([]);
    expect(logLines(debug)).toEqual([
      `VM refresh: ${ual} in "${CG}" not queued: the copy holds this update`,
    ]);
    expect(internals.vmRefreshQueue.size).toBe(0);
    expect(rootReads.calls).toEqual([]);
  });

  it('queues a version check for a copy that already holds the event root', async () => {
    const { internals, kas, rootReads, snapshotReads } = await bootMember();
    const ual = kas[0]!.ual;
    const current = await localRootHex(internals.store, ual);
    const debug = vi.spyOn(internals.log, 'debug');

    // Roots name content: the copy may be an older version with the same one.
    await expect(internals.handleKAUpdatedNudge(
      kas[0]!.kaId,
      ethers.getBytes(current!),
      ctx,
      { blockNumber: 150, txHash: '0x' + 'cd'.repeat(32) },
    )).resolves.toEqual([expect.objectContaining({ merkleRoot: current, checkVersion: true, blockNumber: 150 })]);
    expect(logLines(debug)).toEqual([
      `VM refresh: ${ual} in "${CG}" holds its update's root; version check queued`,
    ]);
    expect(rootReads.calls).toEqual([]);
    expect(snapshotReads.calls).toEqual([]);
  });

  it('queues exactly one refresh carrying the new root for a copy behind the event', async () => {
    const { internals, kas, updateOnChain, rootReads, snapshotReads, fetches } = await bootMember();
    const triggers = recorder((_localCgId: string) => undefined);
    internals.vmReconcileScheduling = { triggerLive: triggers };
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    const expected: VmRefreshTarget = {
      localCgId: CG,
      ual: kas[0]!.ual,
      kaId: kas[0]!.kaId,
      merkleRoot: ethers.hexlify(rootB),
    };

    await expect(internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx)).resolves.toEqual([expected]);
    // The same event scanned again changes nothing.
    await expect(internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx)).resolves.toEqual([]);

    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({ ...expected, failures: 0 }),
    ]);
    expect(triggers.calls).toEqual([[CG]]);
    // Local decision only: the chain and the network are the pass's to use.
    expect(rootReads.calls).toEqual([]);
    expect(snapshotReads.calls).toEqual([]);
    expect(fetches.calls).toEqual([]);
  });

  it('fails the dispatch, so the lane holds the event, when it cannot read which graphs hold the KA', async () => {
    const { internals, kas, updateOnChain } = await bootMember();
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    const query = vi.spyOn(internals.store, 'query').mockRejectedValueOnce(new Error('store busy'));

    await expect(internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx, { blockNumber: 150 }))
      .rejects.toThrow(
        `VM refresh: could not read which local graphs hold KA ${kas[0]!.kaId} for its update at block 150: `
          + 'store busy',
      );
    expect(internals.vmRefreshQueue.size).toBe(0);

    // The lane dispatches the event again after its backoff.
    query.mockRestore();
    await expect(internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx, { blockNumber: 150 }))
      .resolves.toHaveLength(1);
  });

  it('fails the dispatch, so the lane holds the event, when the target set is full', async () => {
    const { internals, kas, updateOnChain } = await bootMember();
    for (let index = 0; index < DKGAgentBase.VM_REFRESH_MAX_ENTRIES; index += 1) {
      expect(internals.vmRefreshQueue.offer({
        localCgId: CG,
        ual: `did:dkg:mock:31337/0xabc/${index}`,
        kaId: BigInt(index + 1),
        merkleRoot: '0x01',
        blockNumber: 120,
      })).toBe('recorded');
    }
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });

    await expect(internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx, { blockNumber: 150 }))
      .rejects.toThrow(
        `VM refresh: ${DKGAgentBase.VM_REFRESH_MAX_ENTRIES} targets are held, the most allowed, so the `
          + `update at block 150 of ${kas[0]!.ual} in "${CG}" waits for some to settle`,
      );
    expect(internals.vmRefreshQueue.refusedTotal).toBe(1);
  });

  it('gives the lane that staged a newer version a grace period before the refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    const { internals, kas, updateOnChain, rootReads } = await bootMember();
    const triggers = recorder((_localCgId: string) => undefined);
    internals.vmReconcileScheduling = { triggerLive: triggers };
    // The update's StorageACK copy, the publisher's own staged update, or a
    // member's recovered copy of its curator's shared memory.
    await stageWorkspaceCopy(internals.store, kas[0]!.ual, '2', 'storage-ack-refresh-test');
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    const info = vi.spyOn(internals.log, 'info');

    await expect(internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx)).resolves.toHaveLength(1);

    expect(logLines(info)).toEqual([
      `VM refresh: ${kas[0]!.ual} in "${CG}" does not hold its update's root and stages a newer `
        + 'version; refresh queued in 30s unless that version is promoted first',
    ]);
    expect(internals.vmRefreshQueue.snapshot()).toEqual([expect.objectContaining({
      merkleRoot: ethers.hexlify(rootB),
      failures: 0,
      nextAttemptAt: Date.now() + DKGAgentBase.VM_REFRESH_STAGED_GRACE_MS,
    })]);
    // Not due, so no pass is started for it.
    expect(internals.vmRefreshQueue.hasDue(CG)).toBe(false);
    expect(triggers.calls).toEqual([]);
    expect(rootReads.calls).toEqual([]);
  });
});

describe('VM refresh worker (#2858)', () => {
  it('replaces the older copy of a settled ordinal with the current version', async () => {
    const { internals, kas, updateOnChain, fetches, rootReads } = await bootMember();
    const ual = kas[0]!.ual;
    const rootA = await localRootHex(internals.store, ual);
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });

    // Without the nudge the ordinal walk cannot see the update: the ordinal is
    // settled, so a pass reads nothing and the copy stays on the old root.
    await expect(internals.runVmReconcileForCg(CG, 'manual')).resolves.toMatchObject({
      watermarkAfter: 1,
    });
    expect(await localRootHex(internals.store, ual)).toBe(rootA);
    expect(fetches.calls).toEqual([]);

    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx, { blockNumber: 90 });
    await expect(internals.runVmReconcileForCg(CG, 'manual')).resolves.toMatchObject({
      watermarkAfter: 1,
    });
    await refreshWorkerSettled(internals);

    expect(fetches.calls.map(([peerId, localCgId, uals]) => [peerId, localCgId, [...uals]]))
      .toEqual([[PEER, CG, [ual]]]);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(await localVersion(internals.store, ual)).toBe('2');
    expect(internals.vmRefreshQueue.size).toBe(0);

    // Converged: the same event again (the copy was materialized after its
    // block) is a local no-op, and the ordinal walk settles the refreshed copy
    // from local state without a root read.
    const rootReadsBefore = rootReads.calls.length;
    await expect(internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx, { blockNumber: 90 }))
      .resolves.toEqual([]);
    await expect(internals.reconcileChainOrdinal(CG, ON_CHAIN_CG, 0, 200))
      .resolves.toEqual({ status: 'already', blockNumber: 200 });
    expect(rootReads.calls.length).toBe(rootReadsBefore);
    expect(fetches.calls).toHaveLength(1);
  });

  it('settles an event older than the local copy with one root read and one pinned view, no fetch and no rollback', async () => {
    const { internals, kas, updateOnChain, fetches, rootReads, snapshotReads } = await bootMember();
    const ual = kas[0]!.ual;
    const rootA = await localRootHex(internals.store, ual);
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await materialize(internals.store, ual, kas[0]!.kaId, { label: 'B', assertionVersion: 2n });

    // A late event for the version this node already moved past.
    const queued = await internals.handleKAUpdatedNudge(kas[0]!.kaId, ethers.getBytes(rootA!), ctx);
    expect(queued).toHaveLength(1);
    await internals.runVmRefreshesForCg(CG, CG, () => true);

    // The chain's current root and version settle it: no peer.
    expect(rootReads.calls).toHaveLength(1);
    expect(snapshotReads.calls).toHaveLength(1);
    expect(fetches.calls).toEqual([]);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(await localVersion(internals.store, ual)).toBe('2');
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('settles from local state when another lane confirmed the new root first', async () => {
    const { internals, kas, updateOnChain, fetches, rootReads } = await bootMember();
    const ual = kas[0]!.ual;
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx);
    // The StorageACK pending-update lane (or finalization gossip) lands first.
    await materialize(internals.store, ual, kas[0]!.kaId, { label: 'B', assertionVersion: 2n });
    const debug = vi.spyOn(internals.log, 'debug');

    await internals.runVmRefreshesForCg(CG, CG, () => true);

    expect(logLines(debug)).toEqual([
      `VM refresh of ${ual} in "${CG}" settled as current: the copy holds the update root`,
    ]);
    expect(rootReads.calls).toEqual([]);
    expect(fetches.calls).toEqual([]);
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('refreshes a version that stays staged past the grace, as on a restarted member', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    const { internals, kas, updateOnChain } = await bootMember();
    const ual = kas[0]!.ual;
    const versionB: KaVersion = { label: 'B', assertionVersion: 2n };
    // A restarted member recovered its curator's shared memory, which holds
    // the update itself; no lane on a member promotes it.
    await stageWorkspaceCopy(internals.store, ual, '2', 'curator-update-b', versionB);
    const rootB = updateOnChain(7n, versionB);
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx);

    // A pass inside the grace attempts nothing.
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localVersion(internals.store, ual)).toBe('1');
    expect(internals.vmRefreshQueue.size).toBe(1);

    vi.setSystemTime(new Date(Date.now() + DKGAgentBase.VM_REFRESH_STAGED_GRACE_MS));
    await internals.runVmRefreshesForCg(CG, CG, () => true);

    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(await localVersion(internals.store, ual)).toBe('2');
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('refreshes to the chain version and keeps a version staged ahead of the chain', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    const { internals, kas, updateOnChain, fetches } = await bootMember();
    const ual = kas[0]!.ual;
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    // A draft of the next version, shared before it is published.
    await stageWorkspaceCopy(internals.store, ual, '3', 'curator-draft-c');
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx);

    vi.setSystemTime(new Date(Date.now() + DKGAgentBase.VM_REFRESH_STAGED_GRACE_MS));
    await internals.runVmRefreshesForCg(CG, CG, () => true);

    expect(fetches.calls).toHaveLength(1);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(await localVersion(internals.store, ual)).toBe('2');
    expect(internals.vmRefreshQueue.size).toBe(0);
    // The draft, head and content, is untouched.
    const head = await resolveKnowledgeAssetWorkspaceHead({
      store: internals.store,
      graphManager: new GraphManager(internals.store),
      contextGraphId: CG,
      kaUal: ual,
    });
    expect(head?.assertionVersion).toBe('3');
    const draftGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.SharedWorkingMemory,
      createGraphKnowledgeAssetScope(ual, 3n),
    );
    const draft = await internals.store.query(
      `SELECT ?o WHERE { GRAPH <${draftGraph}> { <urn:refresh:curator-draft-c> ?p ?o } }`,
    );
    expect(draft.type === 'bindings' ? draft.bindings.map((row) => row['o']) : [])
      .toEqual(['"curator-draft-c"']);
  });

  it('refreshes past a workspace head left at the confirmed version', async () => {
    const { internals, kas, updateOnChain, fetches } = await bootMember();
    const ual = kas[0]!.ual;
    // A head from the version this node already holds (a retained copy of the
    // original publish) stages nothing newer and must not pin the old root.
    await stageWorkspaceCopy(internals.store, ual, '1', 'storage-ack-original');
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });

    await expect(internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx)).resolves.toHaveLength(1);
    await internals.runVmRefreshesForCg(CG, CG, () => true);

    expect(fetches.calls.length).toBeGreaterThanOrEqual(1);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(await localVersion(internals.store, ual)).toBe('2');
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('backs off a fetch no peer can serve and retries it only once it is due', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    const { internals, kas, updateOnChain, fetches, transport } = await bootMember();
    const ual = kas[0]!.ual;
    const rootA = await localRootHex(internals.store, ual);
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    transport.peerHasCurrent = false;
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx);
    const info = vi.spyOn(internals.log, 'info');

    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(fetches.calls).toHaveLength(1);
    expect(fetches.calls[0]?.[3]?.forceFreshExactSession).toBe(true);
    expect(await localRootHex(internals.store, ual)).toBe(rootA);
    expect(logLines(info)).toContain(
      `VM refresh of ${ual} in "${CG}" did not complete `
        + '(no peer served the current version; 1 peer attempt(s)); retrying in 60s',
    );
    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({ failures: 1, nextAttemptAt: Date.now() + 60_000 }),
    ]);

    // Not due yet: the next sweep leaves it alone.
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(fetches.calls).toHaveLength(1);

    transport.peerHasCurrent = true;
    vi.setSystemTime(Date.now() + 60_000);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(fetches.calls).toHaveLength(2);
    expect(fetches.calls[1]?.[3]?.forceFreshExactSession).toBe(true);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('asks the next window of peers on each retry until it reaches a holder', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    const peers = ['12D3KooWRefreshPeerA', '12D3KooWRefreshPeerB', '12D3KooWRefreshPeerC', '12D3KooWRefreshPeerD'];
    const { internals, kas, updateOnChain, fetches } = await bootMember({
      peers,
      holders: ['12D3KooWRefreshPeerD'],
    });
    const ual = kas[0]!.ual;
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx);

    // The first window (three peers) holds only the old version.
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(fetches.calls.map(([peerId]) => peerId)).toEqual(peers.slice(0, 3));
    expect(internals.vmRefreshQueue.size).toBe(1);

    vi.setSystemTime(Date.now() + 60_000);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(fetches.calls.map(([peerId]) => peerId).slice(3)).toEqual(['12D3KooWRefreshPeerD']);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('keeps the curator at the head of every retry window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    const CURATOR = '12D3KooWRefreshCurator';
    const others = ['A', 'B', 'C', 'D', 'E'].map((suffix) => `12D3KooWRefreshPeer${suffix}`);
    let curatorFailures = 1;
    // On a curated graph only the curator holds the private content; the
    // other connected peers (cores) do not.
    const { internals, kas, updateOnChain, fetches } = await bootMember({
      curators: [CURATOR],
      peers: [CURATOR, ...others],
      holders: [CURATOR],
      beforeFetch: async (peerId) => {
        if (peerId === CURATOR && curatorFailures-- > 0) throw new Error('stream reset');
      },
    });
    const ual = kas[0]!.ual;
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx);

    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(fetches.calls.map(([peerId]) => peerId)).toEqual([CURATOR, others[0], others[1]]);
    expect(internals.vmRefreshQueue.size).toBe(1);

    // The retry asks the curator first again, beside the next other peers.
    vi.setSystemTime(Date.now() + 60_000);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(fetches.calls.map(([peerId]) => peerId).slice(3)).toEqual([CURATOR]);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('never settles as current from a chain read that has not seen the update', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    const { internals, kas, updateOnChain, view, fetches, rootReads, snapshotReads } = await bootMember();
    const ual = kas[0]!.ual;
    const rootA = await localRootHex(internals.store, ual);
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    // A lagging endpoint still answers the old root, and its pinned view is
    // below the update's block.
    view.laggingRoot = true;
    view.laggingSnapshot = true;
    view.blockNumber = 140;
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx, { blockNumber: 150 });
    const info = vi.spyOn(internals.log, 'info');

    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(logLines(info)).toContain(
      `VM refresh of ${ual} in "${CG}" did not complete (the chain view at block 140 is behind `
        + "the update's block 150); retrying in 60s",
    );
    expect(rootReads.calls).toHaveLength(1);
    expect(snapshotReads.calls).toHaveLength(1);
    expect(fetches.calls).toEqual([]);
    expect(await localRootHex(internals.store, ual)).toBe(rootA);
    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({ merkleRoot: ethers.hexlify(rootB), blockNumber: 150, failures: 1 }),
    ]);

    // The chain reads catch up.
    view.laggingRoot = false;
    view.laggingSnapshot = false;
    view.blockNumber = 160;
    vi.setSystemTime(Date.now() + 60_000);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(fetches.calls).toHaveLength(1);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('fetches the update when only the live root read lagged it', async () => {
    const { internals, kas, updateOnChain, view, fetches, snapshotReads } = await bootMember();
    const ual = kas[0]!.ual;
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    // A lagging endpoint answers the old root; the pinned view has the update.
    view.laggingRoot = true;
    view.blockNumber = 160;
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx, { blockNumber: 150 });
    const info = vi.spyOn(internals.log, 'info');

    await internals.runVmRefreshesForCg(CG, CG, () => true);

    expect(fetches.calls).toHaveLength(1);
    // One view to settle the lagging read, one for the fetch's evidence.
    expect(snapshotReads.calls).toHaveLength(2);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(internals.vmRefreshQueue.size).toBe(0);
    expect(logLines(info)).toContainEqual(
      expect.stringContaining(`VM refresh: ${ual} in "${CG}" now holds the current version`),
    );
  });

  it('fetches nothing from exact evidence pinned below the update\'s block', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    const { internals, kas, updateOnChain, view, fetches } = await bootMember();
    const ual = kas[0]!.ual;
    const rootA = await localRootHex(internals.store, ual);
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    // The live read sees the update, but the pinned view (a confirmation depth
    // above one) does not yet, so the fetch would find the old version.
    view.laggingSnapshot = true;
    view.blockNumber = 148;
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx, { blockNumber: 150 });
    const info = vi.spyOn(internals.log, 'info');

    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(logLines(info)).toContain(
      `VM refresh of ${ual} in "${CG}" did not complete (the chain view of ${ual} at block 148 `
        + 'is behind block 150); retrying in 60s',
    );
    expect(fetches.calls).toEqual([]);
    expect(await localRootHex(internals.store, ual)).toBe(rootA);
    expect(internals.vmRefreshQueue.size).toBe(1);

    view.laggingSnapshot = false;
    view.blockNumber = 151;
    vi.setSystemTime(Date.now() + 60_000);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('settles an older event from a pinned view at or after its block', async () => {
    const { internals, kas, updateOnChain, view, fetches, rootReads, snapshotReads } = await bootMember();
    const ual = kas[0]!.ual;
    const rootA = await localRootHex(internals.store, ual);
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await materialize(internals.store, ual, kas[0]!.kaId, { label: 'B', assertionVersion: 2n });
    view.blockNumber = 200;

    // A replayed event for the version this node already moved past.
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, ethers.getBytes(rootA!), ctx, { blockNumber: 120 });
    await internals.runVmRefreshesForCg(CG, CG, () => true);

    expect(rootReads.calls).toHaveLength(1);
    expect(snapshotReads.calls).toHaveLength(1);
    expect(fetches.calls).toEqual([]);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('starts no refresh in a graph this node may no longer read', async () => {
    const { internals, kas, updateOnChain, fetches } = await bootMember();
    const ual = kas[0]!.ual;
    const rootA = await localRootHex(internals.store, ual);
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx);
    // Revoked membership: the pass's read-authority gate refuses the graph.
    agent!.canReadContextGraph = async () => false;

    await expect(internals.runVmReconcileForCg(CG, 'manual')).rejects.toThrow();
    expect(internals.vmRefreshWorkers.size).toBe(0);
    expect(fetches.calls).toEqual([]);
    expect(await localRootHex(internals.store, ual)).toBe(rootA);
  });

  it('follows an A -> B -> A history and ends on A, ignoring the late B event', async () => {
    const { internals, kas, updateOnChain, fetches, snapshotReads } = await bootMember();
    const ual = kas[0]!.ual;
    const kaId = kas[0]!.kaId;
    const rootA = await localRootHex(internals.store, ual);

    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await internals.handleKAUpdatedNudge(kaId, rootB, ctx);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));

    const rootA3 = updateOnChain(7n, { label: 'A-7', assertionVersion: 3n });
    expect(ethers.hexlify(rootA3)).toBe(rootA);
    await internals.handleKAUpdatedNudge(kaId, rootA3, ctx);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localRootHex(internals.store, ual)).toBe(rootA);
    expect(await localVersion(internals.store, ual)).toBe('3');
    expect(fetches.calls).toHaveLength(2);

    // The B event replayed late (a lane re-scan) moves nothing: one pinned
    // view confirms the copy's root and version.
    const snapshotReadsBefore = snapshotReads.calls.length;
    await internals.handleKAUpdatedNudge(kaId, rootB, ctx);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localRootHex(internals.store, ual)).toBe(rootA);
    expect(await localVersion(internals.store, ual)).toBe('3');
    expect(fetches.calls).toHaveLength(2);
    expect(snapshotReads.calls).toHaveLength(snapshotReadsBefore + 1);
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('moves a copy to the chain version when an update repeats its root', async () => {
    const { internals, kas, updateOnChain, view, fetches } = await bootMember();
    view.blockNumber = 200;
    const ual = kas[0]!.ual;
    const rootA = await localRootHex(internals.store, ual);
    // Version 2 commits the same content, so the same root.
    const rootA2 = updateOnChain(7n, { label: 'A-7', assertionVersion: 2n });
    expect(ethers.hexlify(rootA2)).toBe(rootA);

    await expect(internals.handleKAUpdatedNudge(kas[0]!.kaId, rootA2, ctx, { blockNumber: 150 }))
      .resolves.toHaveLength(1);
    await internals.runVmRefreshesForCg(CG, CG, () => true);

    expect(fetches.calls).toHaveLength(1);
    expect(await localRootHex(internals.store, ual)).toBe(rootA);
    expect(await localVersion(internals.store, ual)).toBe('2');
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('checks the version of a same-root replacement block behind a materialized copy', async () => {
    const { internals, kas, updateOnChain, view, fetches } = await bootMember();
    view.blockNumber = 200;
    const { kaId, ual } = kas[0]!;
    const root = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await internals.handleKAUpdatedNudge(kaId, root, ctx, {
      blockNumber: 160, blockHash: '0xold', txHash: '0xsame',
    });
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localVersion(internals.store, ual)).toBe('2');

    const canonicalRoot = updateOnChain(7n, { label: 'B', assertionVersion: 3n });
    expect(ethers.hexlify(canonicalRoot)).toBe(ethers.hexlify(root));
    await expect(internals.handleKAUpdatedNudge(kaId, canonicalRoot, ctx, {
      blockNumber: 160, blockHash: '0xnew', txHash: '0xsame',
    })).resolves.toEqual([expect.objectContaining({ checkVersion: true, blockHash: '0xnew' })]);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localVersion(internals.store, ual)).toBe('3');
    expect(fetches.calls).toHaveLength(2);
  });

  it.each([
    { path: 'same-root confirmation', label: 'A-7' },
    { path: 'exact fetch', label: 'B' },
  ])('enforces the earlier fork proof boundary through the $path worker', async ({ label }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    const { internals, kas, updateOnChain, view, fetches } = await bootMember();
    const { kaId, ual } = kas[0]!;
    const canonicalRoot = updateOnChain(7n, { label, assertionVersion: 2n });
    const oldFork = {
      localCgId: CG, ual, kaId, merkleRoot: '0x' + '77'.repeat(32),
      blockNumber: 160, blockHash: '0xold', logIndex: 7,
    };
    const canonical = {
      ...oldFork, merkleRoot: ethers.hexlify(canonicalRoot),
      blockNumber: 159, blockHash: '0xnew', logIndex: 4,
    };
    expect(internals.vmRefreshQueue.offer(oldFork)).toBe('recorded');
    expect(internals.vmRefreshQueue.offer(canonical)).toBe('recorded');
    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({ blockNumber: 159, proofBlockNumber: 160, checkVersion: true }),
    ]);

    view.blockNumber = 159;
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localVersion(internals.store, ual)).toBe('1');
    expect(fetches.calls).toHaveLength(0);
    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({ failures: 1 }),
    ]);

    view.blockNumber = 200;
    vi.setSystemTime(Date.now() + 60_000);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localVersion(internals.store, ual)).toBe('2');
    expect(fetches.calls).toHaveLength(1);
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('refreshes a newer same-root update that arrives while the older transfer is running', async () => {
    let entered = () => undefined;
    const firstTransferStarted = new Promise<void>((resolve) => { entered = resolve; });
    let release = () => undefined;
    const firstTransferMayFinish = new Promise<void>((resolve) => { release = resolve; });
    let transfers = 0;
    const { internals, kas, updateOnChain, view, fetches } = await bootMember({
      captureVersionAtFetchStart: true,
      beforeFetch: async () => {
        if (transfers++ === 0) {
          entered();
          await firstTransferMayFinish;
        }
      },
    });
    view.blockNumber = 200;
    const { kaId, ual } = kas[0]!;
    const rootB2 = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await internals.handleKAUpdatedNudge(kaId, rootB2, ctx, { blockNumber: 150, logIndex: 4 });
    const firstPass = internals.runVmRefreshesForCg(CG, CG, () => true);
    await firstTransferStarted;

    const rootB3 = updateOnChain(7n, { label: 'B', assertionVersion: 3n });
    expect(ethers.hexlify(rootB3)).toBe(ethers.hexlify(rootB2));
    await internals.handleKAUpdatedNudge(kaId, rootB3, ctx, { blockNumber: 160, logIndex: 2 });
    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({ blockNumber: 160, logIndex: 2, checkVersion: true }),
    ]);

    release();
    await firstPass;
    expect(await localVersion(internals.store, ual)).toBe('2');
    expect(internals.vmRefreshQueue.size).toBe(1);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localVersion(internals.store, ual)).toBe('3');
    expect(fetches.calls).toHaveLength(2);
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('keeps a canonical lower-log update while an old-fork transfer finishes', async () => {
    let entered = () => undefined;
    const firstTransferStarted = new Promise<void>((resolve) => { entered = resolve; });
    let release = () => undefined;
    const firstTransferMayFinish = new Promise<void>((resolve) => { release = resolve; });
    let transfers = 0;
    const { internals, kas, updateOnChain, view, fetches } = await bootMember({
      captureVersionAtFetchStart: true,
      beforeFetch: async () => {
        if (transfers++ === 0) {
          entered();
          await firstTransferMayFinish;
        }
      },
    });
    view.blockNumber = 200;
    const { kaId, ual } = kas[0]!;
    const oldTxHash = `0x${'11'.repeat(32)}`;
    const newTxHash = `0x${'22'.repeat(32)}`;
    const oldRoot = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await internals.handleKAUpdatedNudge(kaId, oldRoot, ctx, {
      blockNumber: 160, logIndex: 7, txHash: oldTxHash, blockHash: `0x${'33'.repeat(32)}`,
    });
    const firstPass = internals.runVmRefreshesForCg(CG, CG, () => true);
    await firstTransferStarted;

    const canonicalRoot = updateOnChain(7n, { label: 'C', assertionVersion: 3n });
    await internals.handleKAUpdatedNudge(kaId, canonicalRoot, ctx, {
      blockNumber: 160, logIndex: 4, txHash: newTxHash, blockHash: `0x${'44'.repeat(32)}`,
    });
    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({ txHash: newTxHash, logIndex: 4, checkVersion: true }),
    ]);

    release();
    await firstPass;
    expect(await localVersion(internals.store, ual)).toBe('2');
    expect(internals.vmRefreshQueue.size).toBe(1);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localVersion(internals.store, ual)).toBe('3');
    expect(fetches.calls).toHaveLength(2);
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('reaches the chain version of an A -> B -> A history it missed while offline', async () => {
    const { internals, kas, updateOnChain, view, fetches } = await bootMember();
    view.blockNumber = 200;
    const ual = kas[0]!.ual;
    const kaId = kas[0]!.kaId;
    const rootA = await localRootHex(internals.store, ual);
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    const rootA3 = updateOnChain(7n, { label: 'A-7', assertionVersion: 3n });

    // The lane replays both events after the restart; the latest names the
    // root the copy already has.
    await internals.handleKAUpdatedNudge(kaId, rootB, ctx, { blockNumber: 150 });
    await internals.handleKAUpdatedNudge(kaId, rootA3, ctx, { blockNumber: 160 });
    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({ merkleRoot: rootA, blockNumber: 160, checkVersion: true }),
    ]);
    await internals.runVmRefreshesForCg(CG, CG, () => true);

    expect(fetches.calls).toHaveLength(1);
    expect(await localRootHex(internals.store, ual)).toBe(rootA);
    expect(await localVersion(internals.store, ual)).toBe('3');
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('bounds the attempts one worker makes and hands the rest to the next pass', async () => {
    const { internals, kas, updateOnChain, fetches } = await bootMember({ kaNumbers: [7n, 8n, 9n] });
    const triggers = recorder((_localCgId: string) => undefined);
    internals.vmReconcileScheduling = { triggerLive: triggers };
    for (const ka of kas) {
      const root = updateOnChain(ka.kaNumber, { label: `B-${ka.kaNumber}`, assertionVersion: 2n });
      await internals.handleKAUpdatedNudge(ka.kaId, root, ctx);
    }
    triggers.calls.length = 0;

    const worker = internals.startVmRefreshWorker(CG, CG, () => true);
    // One worker per graph: a second pass joins the running one.
    expect(internals.startVmRefreshWorker(CG, CG, () => true)).toBe(worker);
    await worker;
    expect(fetches.calls).toHaveLength(2);
    expect(internals.vmRefreshQueue.size).toBe(1);
    expect(internals.vmRefreshWorkers.size).toBe(0);
    expect(triggers.calls).toEqual([[CG]]);

    await internals.startVmRefreshWorker(CG, CG, () => true);
    expect(fetches.calls).toHaveLength(3);
    expect(internals.vmRefreshQueue.size).toBe(0);
    expect(triggers.calls).toEqual([[CG]]);
    // Nothing due: no worker starts.
    expect(internals.startVmRefreshWorker(CG, CG, () => true)).toBeUndefined();
  });

  it('retries an attempt that outlives its deadline instead of dropping it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    overrideRefreshBound('VM_REFRESH_ATTEMPT_TIMEOUT_MS', 200);
    let transferReturns = false;
    const { internals, kas, updateOnChain, fetches } = await bootMember({
      beforeFetch: () => (transferReturns ? Promise.resolve() : never()),
    });
    const ual = kas[0]!.ual;
    const rootA = await localRootHex(internals.store, ual);
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx);
    const triggers = recorder((_localCgId: string) => undefined);
    internals.vmReconcileScheduling = { triggerLive: triggers };
    const warn = vi.spyOn(internals.log, 'warn');

    await internals.startVmRefreshWorker(CG, CG, () => true);
    // Backing off, the target is not due: no pass is asked for it.
    expect(triggers.calls).toEqual([]);
    expect(fetches.calls).toHaveLength(1);
    expect(await localRootHex(internals.store, ual)).toBe(rootA);
    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({
        merkleRoot: ethers.hexlify(rootB),
        failures: 1,
        nextAttemptAt: Date.now() + 60_000,
      }),
    ]);
    expect(logLines(warn)).toEqual([
      `VM refresh of ${ual} in "${CG}" did not complete `
        + `(VM refresh of ${ual} timed out after 200ms); retrying in 60s`,
    ]);

    transferReturns = true;
    vi.setSystemTime(Date.now() + 60_000);
    await internals.startVmRefreshWorker(CG, CG, () => true);
    expect(fetches.calls).toHaveLength(2);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('keeps the target untouched when its reconcile target closes mid-attempt', async () => {
    const { internals, kas, updateOnChain, fetches, rootReads } = await bootMember();
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx);
    const triggers = recorder((_localCgId: string) => undefined);
    internals.vmReconcileScheduling = { triggerLive: triggers };
    // The graph is rebound, or the lifecycle closes, while the root read runs.
    let targetCurrent = true;
    const readRoot = internals.chain.getLatestMerkleRoot.bind(internals.chain);
    internals.chain.getLatestMerkleRoot = async (...args: Parameters<typeof readRoot>) => {
      targetCurrent = false;
      return readRoot(...args);
    };

    await internals.startVmRefreshWorker(CG, CG, () => targetCurrent);

    expect(rootReads.calls).toHaveLength(1);
    expect(fetches.calls).toEqual([]);
    // Neither settled nor backed off: a fresh pass (asked for here) retries it.
    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({ merkleRoot: ethers.hexlify(rootB), failures: 0, nextAttemptAt: 0 }),
    ]);
    expect(triggers.calls).toEqual([[CG]]);
  });

  it('asks connected peers when curator resolution does not finish in time', async () => {
    overrideRefreshBound('VM_REFRESH_PEER_STEP_TIMEOUT_MS', 100);
    const { internals, kas, updateOnChain, fetches } = await bootMember({
      peers: [PEER],
      curatorResolutionHangs: true,
    });
    const ual = kas[0]!.ual;
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx);
    const info = vi.spyOn(internals.log, 'info');

    await internals.startVmRefreshWorker(CG, CG, () => true);

    expect(fetches.calls.map(([peerId]) => peerId)).toEqual([PEER]);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(logLines(info)).toContain(
      `Exact asset fetch: Curator resolution for "${CG}" timed out after 100ms; asking connected peers`,
    );
  });

  it('stops an attempt past its deadline at its next step', async () => {
    overrideRefreshBound('VM_REFRESH_ATTEMPT_TIMEOUT_MS', 100);
    let transferDone!: () => void;
    const transfer = new Promise<void>((resolve) => { transferDone = resolve; });
    const { internals, kas, updateOnChain, fetches } = await bootMember({
      holders: [],
      beforeFetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        transferDone();
      },
    });
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx);
    const finalizer = (internals as unknown as {
      getOrCreateFinalizationHandler(): { handleExactChainReconciledKC(...args: unknown[]): Promise<unknown> };
    }).getOrCreateFinalizationHandler();
    const inspections = vi.spyOn(finalizer, 'handleExactChainReconciledKC');

    await internals.startVmRefreshWorker(CG, CG, () => true);
    expect(internals.vmRefreshQueue.snapshot()).toEqual([expect.objectContaining({ failures: 1 })]);
    expect(inspections).toHaveBeenCalledTimes(1);

    // The abandoned transfer returns later; the attempt does no more work.
    await transfer;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetches.calls).toHaveLength(1);
    expect(inspections).toHaveBeenCalledTimes(1);
  });

  it('runs at most two workers and hands a freed slot to a waiting graph', async () => {
    const { internals } = await bootMember();
    const triggers = recorder((_localCgId: string) => undefined);
    internals.vmReconcileScheduling = { triggerLive: triggers };
    const gates = new Map<string, () => void>();
    Object.assign(internals, {
      isVmReconcileTargetSelected: (localCgId: string) => localCgId !== 'gone',
      // Each worker holds until its gate opens, then settles its graph's target.
      runVmRefreshesForCg: (localCgId: string) => new Promise<void>((resolve) => {
        gates.set(localCgId, () => {
          for (const target of internals.vmRefreshQueue.due(localCgId, 10)) {
            internals.vmRefreshQueue.settle(target, 'refreshed');
          }
          resolve();
        });
      }),
    });
    const offer = (localCgId: string) => internals.vmRefreshQueue.offer({
      localCgId,
      ual: `urn:ual:${localCgId}`,
      kaId: 1n,
      merkleRoot: '0x01',
    });
    // A graph that has since left VM reconciliation holds the oldest target.
    for (const localCgId of ['gone', 'g1', 'g2', 'g3']) offer(localCgId);

    const first = internals.startVmRefreshWorker('g1', 'g1', () => true);
    expect(internals.startVmRefreshWorker('g2', 'g2', () => true)).toBeDefined();
    expect(internals.startVmRefreshWorker('g3', 'g3', () => true)).toBeUndefined();
    expect([...internals.vmRefreshWorkers.keys()]).toEqual(['g1', 'g2']);

    gates.get('g1')!();
    await first;
    // The freed slot goes to the waiting graph; the departed one loses its target.
    expect(triggers.calls).toEqual([['g3']]);
    expect(internals.vmRefreshQueue.snapshot().map((entry) => entry.localCgId)).toEqual(['g2', 'g3']);
    expect([...internals.vmRefreshWorkers.keys()]).toEqual(['g2']);

    // A worker that ends after its lifecycle closed hands nothing on.
    const lifecycle = new AbortController();
    const third = internals.startVmRefreshWorker('g3', 'g3', () => true, lifecycle.signal);
    offer('g4');
    lifecycle.abort();
    gates.get('g3')!();
    await third;
    expect(triggers.calls).toEqual([['g3']]);
    gates.get('g2')!();
  });
});

describe('restarted member (#2858)', () => {
  it('converges from v1 to v3 when its target is queued after the copy was classified not current', async () => {
    overrideRefreshBound('VM_REFRESH_PEER_STEP_TIMEOUT_MS', 200);
    const CURATOR = '12D3KooWRefreshCuratorNotConnected';
    const CORE = '12D3KooWRefreshCoreHolder';
    let openCoreTransfer!: () => void;
    const coreTransfer = new Promise<void>((resolve) => { openCoreTransfer = resolve; });
    // After a restart the refresh queue is empty (it is process-local), the
    // persisted copy is the first version and the curator, asked first, is
    // not connected: its dial never returns. A connected core holds the
    // current version.
    const { internals, kas, updateOnChain, fetches, connects } = await bootMember({
      curators: [CURATOR],
      peers: [CORE],
      holders: [CORE],
      connect: (peerId) => (peerId === CURATOR ? never() : Promise.resolve()),
      beforeFetch: (peerId) => (peerId === CORE ? coreTransfer : Promise.resolve()),
    });
    const ual = kas[0]!.ual;
    const kaId = kas[0]!.kaId;
    const rootV1 = await localRootHex(internals.store, ual);
    // Two updates land while the node is down.
    const rootV2 = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    const rootV3 = updateOnChain(7n, { label: 'C', assertionVersion: 3n });

    // The resolver classifies the intact first version as not current. The
    // copy stays confirmed, so the refresh lane still acts on it.
    await expect(resolveConfirmedGraphScopedVm(internals.store, {
      contextGraphId: CG,
      ual,
      assertionVersion: 3n,
      merkleRoot: rootV3,
      kaId,
      batchId: kaId,
    })).resolves.toEqual({ status: 'invalid', reason: 'not-current' });
    expect(await localRootHex(internals.store, ual)).toBe(rootV1);

    // The update lane replays both events from its persisted cursor.
    await internals.handleKAUpdatedNudge(kaId, rootV2, ctx);
    await internals.handleKAUpdatedNudge(kaId, rootV3, ctx);
    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({ ual, merkleRoot: ethers.hexlify(rootV3), failures: 0 }),
    ]);

    const info = vi.spyOn(internals.log, 'info');
    // The pass returns while its worker is still at work: it never waits on
    // the curator's dial.
    await internals.runVmReconcileForCg(CG, 'live');
    expect(internals.vmRefreshWorkers.has(CG)).toBe(true);
    openCoreTransfer();
    await refreshWorkerSettled(internals);

    // The unreachable curator cost one bounded step; the core served v3.
    expect(connects.calls.map(([peerId]) => peerId)).toEqual([CURATOR, CORE]);
    expect(fetches.calls.map(([peerId]) => peerId)).toEqual([CORE]);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootV3));
    expect(await localVersion(internals.store, ual)).toBe('3');
    expect(internals.vmRefreshQueue.size).toBe(0);
    expect(logLines(info)).toEqual(expect.arrayContaining([
      `Exact asset fetch from ${CURATOR} failed: Peer preparation timed out after 200ms`,
      expect.stringContaining(`VM refresh: ${ual} in "${CG}" now holds the current version`),
    ]));
  });
});

describe('restart through the update event lane (#2858)', () => {
  it('applies a same-root replacement fork after the old event already settled, without a restart', async () => {
    const { internals, kas, updateOnChain, view, fetches } = await bootMember();
    const { kaId, ual } = kas[0]!;
    view.blockNumber = 200;
    const oldRoot = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    const event: ChainEvent = {
      type: 'KnowledgeAssetUpdated', blockNumber: 160,
      data: {
        batchId: kaId.toString(), merkleRoot: ethers.hexlify(oldRoot),
        blockHash: '0xold', txHash: '0xsame', logIndex: 7,
      },
    };
    const events = [event];
    let head = 200;
    let now = 0;
    const eventChain = {
      chainId: 'mock:31337',
      getBlockNumber: async () => head,
      listenForEvents: async function* (filter: EventFilter): AsyncIterable<ChainEvent> {
        for (const current of events) {
          if (filter.eventTypes.includes(current.type)
            && current.blockNumber >= (filter.fromBlock ?? 0)
            && current.blockNumber <= (filter.toBlock ?? Number.MAX_SAFE_INTEGER)) {
            yield current;
          }
        }
      },
    } as unknown as ChainAdapter;
    const poller = new ChainEventPoller({
      chain: eventChain,
      publishHandler: new PublishHandler(new OxigraphStore(), new TypedEventBus()),
      intervalMs: 12_000,
      clock: () => now,
      onCollectionUpdated: async ({ batchId, merkleRoot, blockNumber, blockHash, txHash, logIndex }) => {
        await internals.handleKAUpdatedNudge(batchId, merkleRoot, ctx, {
          blockNumber, blockHash, txHash, logIndex,
        });
      },
    });
    const poll = () => (poller as unknown as { poll(): Promise<void> }).poll();

    await poll();
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localVersion(internals.store, ual)).toBe('2');
    expect(internals.vmRefreshQueue.size).toBe(0);

    const canonicalRoot = updateOnChain(7n, { label: 'B', assertionVersion: 3n });
    expect(ethers.hexlify(canonicalRoot)).toBe(ethers.hexlify(oldRoot));
    events.splice(0, 1, {
      ...event, data: { ...event.data, blockHash: '0xcanonical' },
    });
    head = 201;
    now = 12_000;
    await poll();
    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({ blockHash: '0xcanonical', checkVersion: true }),
    ]);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localVersion(internals.store, ual)).toBe('3');
    expect(fetches.calls).toHaveLength(2);
  });

  it('replays an unsettled update from the persisted lane cursor and converges without a new update', async () => {
    const { internals, kas, updateOnChain, view, transport } = await bootMember();
    const ual = kas[0]!.ual;
    const kaId = kas[0]!.kaId;
    view.blockNumber = 250;
    // No peer serves the update before the restart.
    transport.peerHasCurrent = false;
    const rootV2 = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    const rootV3 = updateOnChain(7n, { label: 'C', assertionVersion: 3n });
    const updateEvent = (blockNumber: number, root: Uint8Array): ChainEvent => ({
      type: 'KnowledgeAssetUpdated',
      blockNumber,
      data: {
        kaId: kaId.toString(),
        batchId: kaId.toString(),
        merkleRoot: ethers.hexlify(root),
        txHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
      },
    });
    const events = [updateEvent(150, rootV2), updateEvent(160, rootV3)];
    let head = 200;
    const eventChain = {
      chainId: 'mock:31337',
      getBlockNumber: async () => head,
      listenForEvents: async function* (filter: EventFilter): AsyncIterable<ChainEvent> {
        for (const event of events) {
          if (
            filter.eventTypes.includes(event.type)
            && event.blockNumber >= (filter.fromBlock ?? 0)
            && event.blockNumber <= (filter.toBlock ?? Number.MAX_SAFE_INTEGER)
          ) yield event;
        }
      },
    } as unknown as ChainAdapter;
    // The lane cursor was persisted before both updates.
    const saved = new Map<string, number>([['collectionUpdates', 140]]);
    const cursorPersistence = {
      async loadLane(lane: string) { return saved.get(lane); },
      async saveLane(lane: string, block: number) { saved.set(lane, block); },
    };
    let now = 0;
    // A poller wired the way the agent wires its update lane.
    const newPoller = () => new ChainEventPoller({
      chain: eventChain,
      publishHandler: new PublishHandler(new OxigraphStore(), new TypedEventBus()),
      intervalMs: 60_000,
      clock: () => now,
      cursorPersistence,
      onCollectionUpdated: async ({ batchId, merkleRoot, blockNumber, txHash, signal }) => {
        await internals.handleKAUpdatedNudge(batchId, merkleRoot, ctx, {
          blockNumber,
          ...(txHash === undefined ? {} : { txHash }),
          signal,
        });
      },
      collectionUpdatesPersistCeiling: () => internals.vmRefreshPersistCeiling(),
    });
    const poll = (poller: ChainEventPoller) => (poller as unknown as { poll(): Promise<void> }).poll();

    await poll(newPoller());
    // One target, at the latest root; the saved cursor stays below its event.
    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({ merkleRoot: ethers.hexlify(rootV3), blockNumber: 160 }),
    ]);
    expect(saved.get('collectionUpdates')).toBe(159);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localVersion(internals.store, ual)).toBe('1');

    // Restart: the process-local targets are gone, the persisted cursor is not.
    internals.vmRefreshQueue.clear();
    transport.peerHasCurrent = true;
    const restarted = newPoller();
    await poll(restarted);
    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({ merkleRoot: ethers.hexlify(rootV3), blockNumber: 160, failures: 0 }),
    ]);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootV3));
    expect(await localVersion(internals.store, ual)).toBe('3');
    expect(internals.vmRefreshQueue.size).toBe(0);

    // Settled: the next scan persists the block it reached.
    head = 210;
    now = 60_000;
    await poll(restarted);
    expect(saved.get('collectionUpdates')).toBe(210);
  });

  it('stops holding the lane cursor once a target that never settles is given up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    const { internals, kas, updateOnChain } = await bootMember();
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx, { blockNumber: 150 });
    expect(internals.vmRefreshPersistCeiling()).toBe(149);

    const warn = vi.spyOn(internals.log, 'warn');
    vi.setSystemTime(new Date(Date.now() + DKGAgentBase.VM_REFRESH_MAX_AGE_MS));
    expect(internals.vmRefreshPersistCeiling()).toBeUndefined();
    expect(internals.vmRefreshQueue.size).toBe(0);
    expect(logLines(warn)).toEqual([
      `VM refresh: gave up on ${kas[0]!.ual} in "${CG}" after 1440 min and 0 failed attempt(s) `
        + "(1 given up so far); its copy waits for the KA's next update or an asset fetch",
    ]);
  });
});

describe('lifecycle wiring (#2858)', () => {
  it.each([
    { mode: 'RFC-64 catalog disabled', activation: { enabled: false }, plan: undefined },
    {
      // Catalog mode needs persistence.
      mode: 'RFC-64 catalog mode',
      activation: {
        enabled: true,
        rollout: { killSwitch: false, defaultMode: 'catalog' as const, contextGraphModes: {} },
      },
      plan: { killSwitchActive: false, responsibilityDefaultMode: 'catalog' },
    },
    {
      // A kill-switch member used to learn of updates from the /update topic,
      // which curated graphs no longer send.
      mode: 'RFC-64 kill switch active',
      activation: {
        enabled: true,
        rollout: { killSwitch: true, defaultMode: 'legacy' as const, contextGraphModes: {} },
      },
      plan: { killSwitchActive: true },
    },
  ])('routes the poller update lane to the refresh nudge, which queues a held copy ($mode)', async ({
    activation,
    plan,
  }) => {
    const dataDir = plan?.responsibilityDefaultMode === 'catalog'
      ? await mkdtemp(join(tmpdir(), 'dkg-vm-refresh-wiring-'))
      : undefined;
    if (dataDir) restores.push(() => rm(dataDir, { recursive: true, force: true }));
    agent = await DKGAgent.create({
      name: 'VmRefreshWiring',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
      rfc64CatalogActivation: activation,
      ...(dataDir ? { dataDir } : {}),
    });
    await agent.start();
    if (plan) {
      expect((agent as unknown as { config: { rfc64CatalogExecutionPlan: unknown } })
        .config.rfc64CatalogExecutionPlan).toMatchObject(plan);
    }
    const poller = (agent as unknown as {
      chainPoller: {
        onCollectionUpdated?: (info: {
          merkleRoot: Uint8Array;
          batchId: bigint;
          blockNumber: number;
          txHash?: string;
          logIndex?: number;
          blockHash?: string;
        }) => Promise<void>;
      } | null;
    }).chainPoller;
    expect(poller?.onCollectionUpdated).toBeTypeOf('function');

    const nudges = recorder(async (..._args: unknown[]): Promise<VmRefreshTarget[]> => []);
    (agent as unknown as { handleKAUpdatedNudge: typeof nudges }).handleKAUpdatedNudge = nudges;
    const root = new Uint8Array(32).fill(7);
    const txHash = `0x${'ab'.repeat(32)}`;
    const blockHash = `0x${'cd'.repeat(32)}`;
    await poller!.onCollectionUpdated!({
      merkleRoot: root, batchId: 42n, blockNumber: 9, txHash, logIndex: 7, blockHash,
    });

    expect(nudges.calls).toHaveLength(1);
    expect(nudges.calls[0]!.slice(0, 2)).toEqual([42n, root]);
    expect(nudges.calls[0]![3]).toMatchObject({ blockNumber: 9, txHash, logIndex: 7, blockHash });
    // The lane's saved cursor follows the held refresh targets.
    const ceiling = (poller as unknown as {
      collectionUpdatesPersistCeiling?: () => number | undefined;
    }).collectionUpdatesPersistCeiling;
    expect(ceiling?.()).toBeUndefined();
    (agent as unknown as RefreshInternals).vmRefreshQueue.offer({
      localCgId: CG,
      ual: 'did:dkg:mock:31337/0xabc/1',
      kaId: 1n,
      merkleRoot: '0x01',
      blockNumber: 150,
    });
    expect(ceiling?.()).toBe(149);
    (agent as unknown as RefreshInternals).vmRefreshQueue.clear();

    // The nudge decides from the subscription and the local copy alone, so a
    // held copy behind the event is queued in every mode.
    delete (agent as unknown as { handleKAUpdatedNudge?: unknown }).handleKAUpdatedNudge;
    const internals = agent as unknown as RefreshInternals & {
      ensureVmReconcileScheduling(): { triggerLive(key: string): void };
    };
    const ual = buildKnowledgeAssetUal(internals.chain.chainId, AUTHOR, 7n);
    const kaId = kaIdOf(7n);
    internals.subscribedContextGraphs.set(CG, { subscribed: true, onChainId: CG, lastReconciledOrdinal: 1 });
    await materialize(internals.store, ual, kaId, { label: 'A-7', assertionVersion: 1n });
    const triggerLive = vi.spyOn(internals.ensureVmReconcileScheduling(), 'triggerLive')
      .mockImplementation(() => undefined);
    const rootB = contentOf(ual, { label: 'B-7', assertionVersion: 2n }).root;

    await poller!.onCollectionUpdated!({ merkleRoot: rootB, batchId: kaId, blockNumber: 10 });

    expect(internals.vmRefreshQueue.snapshot()).toEqual([
      expect.objectContaining({ localCgId: CG, ual, kaId, merkleRoot: ethers.hexlify(rootB) }),
    ]);
    expect(triggerLive).toHaveBeenCalledWith(CG);
  });
});
