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
 *   3. The reconcile pass works the targets off: it reads the chain, fetches the
 *      exact current version and replaces the older copy, and never rolls a
 *      copy back for an older or superseded event.
 *   4. The chain event poller's update lane is wired to the nudge.
 *
 * The pass runs the real exact-asset fetch (chain evidence, local inspection
 * through the finalization handler, re-inspection); only the peer transport is
 * replaced, by a responder that materializes the version the chain names.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  createOperationContext,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { GraphManager, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
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
  vmReconcileScheduling?: unknown;
  handleKAUpdatedNudge(
    kaId: bigint,
    merkleRoot: Uint8Array,
    ctx: ReturnType<typeof createOperationContext>,
    signal?: AbortSignal,
  ): Promise<VmRefreshTarget[]>;
  runVmRefreshesForCg(
    localCgId: string,
    onChainId: string,
    isTargetCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  runVmReconcileForCg(
    localCgId: string,
    source?: 'live' | 'periodic' | 'manual',
  ): Promise<ContextGraphReconcileResult>;
  reconcileChainOrdinal(
    localCgId: string,
    onChainCgId: bigint,
    ordinal: number,
    headBlock: number | undefined,
    options?: { deferActiveFetch?: boolean },
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

/** Install one confirmed version exactly as a verified durable fetch does. */
async function materialize(
  store: TripleStore,
  ual: string,
  kaId: bigint,
  version: KaVersion,
  localCgId = CG,
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
        confirmation: {
          kind: 'finalized-materialization',
          provenance: {
            batchId: kaId,
            materializedVersion: { blockNumber: 100, txIndex: 0 },
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

/** Stage one version in the graph's workspace with its head, as a share or a StorageACK copy does. */
async function stageWorkspaceCopy(
  store: TripleStore,
  ual: string,
  assertionVersion: string,
  shareOperationId: string,
): Promise<void> {
  const graphManager = new GraphManager(store);
  const scope = createGraphKnowledgeAssetScope(ual, assertionVersion);
  const quads = [{
    subject: `urn:refresh:${shareOperationId}`,
    predicate: 'http://schema.org/name',
    object: `"${shareOperationId}"`,
    graph: knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope),
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

afterEach(async () => {
  vi.useRealTimers();
  if (agent) {
    await agent.stop().catch(() => undefined);
    agent = null;
  }
});

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
    const version = chainVersions.get(kaId);
    const ka = kas.find((candidate) => candidate.kaId === kaId);
    if (!version || !ka) throw new Error(`unknown KA ${kaId}`);
    return contentOf(ka.ual, version).root;
  });
  chain.getLatestMerkleRoot = rootReads;
  const snapshotReads = recorder(async (kaId: bigint) => {
    const version = chainVersions.get(kaId);
    const ka = kas.find((candidate) => candidate.kaId === kaId);
    if (!version || !ka) return null;
    return {
      latestRoot: ethers.hexlify(contentOf(ka.ual, version).root),
      rootCount: version.assertionVersion,
      latestAuthor: AUTHOR,
      latestPublisher: PUBLISHER,
      blockNumber: 100,
    };
  });
  chain.readKnowledgeAssetVersionSnapshot = snapshotReads as typeof chain.readKnowledgeAssetVersionSnapshot;
  chain.getKAContextGraphId = async () => ON_CHAIN_CG;

  const transport = { peerHasCurrent: true };
  const fetches = recorder(async (peerId: string, _localCgId: string, requested: readonly string[]) => {
    if (transport.peerHasCurrent && (options.holders === undefined || options.holders.includes(peerId))) {
      for (const ual of requested) {
        const ka = uals.get(ual);
        const version = ka ? chainVersions.get(ka.kaId) : undefined;
        if (ka && version) await materialize(internals.store, ual, ka.kaId, version);
      }
    }
    return { result: {}, disposition: transport.peerHasCurrent ? 'found' : 'clean-absent' };
  });
  Object.assign(agent as unknown as Record<string, unknown>, {
    resolveCuratorPeerIdsForCg: async () => ({
      peerIds: options.peers === undefined ? [PEER] : [],
      curatorIsLocal: false,
      legacyTripleResolved: false,
    }),
    ensurePeerConnected: async () => undefined,
    waitForSyncProtocol: async () => true,
    ensurePeerAdmittedForRecovery: async () => true,
    syncExactKnowledgeAssetsFromPeerDetailed: fetches,
  });

  /** Move one KA's on-chain version, as a confirmed `/api/update` does. */
  const updateOnChain = (kaNumber: bigint, version: KaVersion): Uint8Array => {
    const ka = kas.find((candidate) => candidate.kaNumber === kaNumber)!;
    chainVersions.set(ka.kaId, version);
    return contentOf(ka.ual, version).root;
  };
  return { chain, internals, kas, updateOnChain, rootReads, snapshotReads, fetches, transport };
}

const ctx = createOperationContext('system');

describe('VmRefreshQueue', () => {
  const target = (merkleRoot: string, ual = 'did:dkg:mock:31337/0xabc/1'): VmRefreshTarget => ({
    localCgId: CG,
    ual,
    kaId: 1n,
    merkleRoot,
  });

  it('keeps one target per graph and KA: a replayed root keeps its backoff, a new root is due at once', () => {
    let now = 1_000;
    const queue = new VmRefreshQueue({
      maxEntries: 8,
      baseBackoffMs: 60_000,
      maxBackoffMs: 600_000,
      now: () => now,
    });
    expect(queue.offer(target('0xb2'))).toBe(true);
    expect(queue.due(CG, 10)).toEqual([{ ...target('0xb2'), failures: 0 }]);
    queue.settle(target('0xb2'), 'retry');
    expect(queue.due(CG, 10)).toEqual([]);

    // The same event replayed (a lane re-scan) cannot defeat the backoff.
    expect(queue.offer(target('0xb2'))).toBe(false);
    expect(queue.due(CG, 10)).toEqual([]);
    expect(queue.snapshot()).toMatchObject([{ merkleRoot: '0xb2', failures: 1, nextAttemptAt: 61_000 }]);

    // A later update is new evidence: it replaces the target and is due now.
    expect(queue.offer(target('0xc3'))).toBe(true);
    expect(queue.size).toBe(1);
    expect(queue.due(CG, 10)).toEqual([{ ...target('0xc3'), failures: 0 }]);
    now = 61_000;
    expect(queue.due('another-graph', 10)).toEqual([]);
  });

  it('settles only the attempted root, doubles the retry delay to its ceiling, and drops the oldest over capacity', () => {
    let now = 0;
    const queue = new VmRefreshQueue({
      maxEntries: 2,
      baseBackoffMs: 60_000,
      maxBackoffMs: 200_000,
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

    queue.offer(target('0x01', 'ual-1'));
    queue.offer(target('0x02', 'ual-2'));
    queue.offer(target('0x03', 'ual-3'));
    expect(queue.snapshot().map((entry) => entry.ual)).toEqual(['ual-2', 'ual-3']);
    queue.clearContextGraph(CG);
    expect(queue.size).toBe(0);
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

    await expect(internals.handleKAUpdatedNudge(kaIdOf(98n), new Uint8Array(32).fill(1), ctx))
      .resolves.toEqual([]);
    await expect(internals.handleKAUpdatedNudge(kaIdOf(99n), new Uint8Array(32).fill(1), ctx))
      .resolves.toEqual([]);

    expect(internals.vmRefreshQueue.size).toBe(0);
    expect(triggers.calls).toEqual([]);
    expect(rootReads.calls).toEqual([]);
    expect(snapshotReads.calls).toEqual([]);
  });

  it('does nothing when the local copy already holds the event root', async () => {
    const { internals, kas, rootReads } = await bootMember();
    const current = await localRootHex(internals.store, kas[0]!.ual);

    await expect(internals.handleKAUpdatedNudge(kas[0]!.kaId, ethers.getBytes(current!), ctx))
      .resolves.toEqual([]);
    expect(internals.vmRefreshQueue.size).toBe(0);
    expect(rootReads.calls).toEqual([]);
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

  it('leaves a newer version staged in the workspace to the lanes that promote it', async () => {
    const { internals, kas, updateOnChain } = await bootMember();
    // The update's StorageACK copy (or the publisher's own staged update).
    await stageWorkspaceCopy(internals.store, kas[0]!.ual, '2', 'storage-ack-refresh-test');
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });

    await expect(internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx)).resolves.toEqual([]);
    expect(internals.vmRefreshQueue.size).toBe(0);
  });
});

describe('VM refresh in the reconcile pass (#2858)', () => {
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

    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx);
    await expect(internals.runVmReconcileForCg(CG, 'manual')).resolves.toMatchObject({
      watermarkAfter: 1,
    });

    expect(fetches.calls.map(([peerId, localCgId, uals]) => [peerId, localCgId, [...uals]]))
      .toEqual([[PEER, CG, [ual]]]);
    expect(await localRootHex(internals.store, ual)).toBe(ethers.hexlify(rootB));
    expect(await localVersion(internals.store, ual)).toBe('2');
    expect(internals.vmRefreshQueue.size).toBe(0);

    // Converged: the same event again is a local no-op, and the ordinal walk
    // settles the refreshed copy from local state without a root read.
    const rootReadsBefore = rootReads.calls.length;
    await expect(internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx)).resolves.toEqual([]);
    await expect(internals.reconcileChainOrdinal(CG, ON_CHAIN_CG, 0, 200, { deferActiveFetch: true }))
      .resolves.toEqual({ status: 'already', blockNumber: 200 });
    expect(rootReads.calls.length).toBe(rootReadsBefore);
    expect(fetches.calls).toHaveLength(1);
  });

  it('settles an event older than the local copy without a fetch and without rolling back', async () => {
    const { internals, kas, updateOnChain, fetches } = await bootMember();
    const ual = kas[0]!.ual;
    const rootA = await localRootHex(internals.store, ual);
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await materialize(internals.store, ual, kas[0]!.kaId, { label: 'B', assertionVersion: 2n });

    // A late event for the version this node already moved past.
    const queued = await internals.handleKAUpdatedNudge(kas[0]!.kaId, ethers.getBytes(rootA!), ctx);
    expect(queued).toHaveLength(1);
    await internals.runVmRefreshesForCg(CG, CG, () => true);

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

    await internals.runVmRefreshesForCg(CG, CG, () => true);

    expect(rootReads.calls).toEqual([]);
    expect(fetches.calls).toEqual([]);
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('leaves a target to the StorageACK lane when an ACK copy arrives after the nudge', async () => {
    const { internals, kas, updateOnChain, fetches, rootReads } = await bootMember();
    const rootB = updateOnChain(7n, { label: 'B', assertionVersion: 2n });
    await internals.handleKAUpdatedNudge(kas[0]!.kaId, rootB, ctx);
    await stageWorkspaceCopy(internals.store, kas[0]!.ual, '2', 'storage-ack-late');

    await internals.runVmRefreshesForCg(CG, CG, () => true);

    expect(rootReads.calls).toEqual([]);
    expect(fetches.calls).toEqual([]);
    expect(internals.vmRefreshQueue.size).toBe(0);
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

    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(fetches.calls).toHaveLength(1);
    expect(await localRootHex(internals.store, ual)).toBe(rootA);
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

  it('follows an A -> B -> A history and ends on A, ignoring the late B event', async () => {
    const { internals, kas, updateOnChain, fetches } = await bootMember();
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

    // The B event replayed late (a lane re-scan) moves nothing.
    await internals.handleKAUpdatedNudge(kaId, rootB, ctx);
    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(await localRootHex(internals.store, ual)).toBe(rootA);
    expect(await localVersion(internals.store, ual)).toBe('3');
    expect(fetches.calls).toHaveLength(2);
    expect(internals.vmRefreshQueue.size).toBe(0);
  });

  it('bounds the attempts one pass makes and continues with the rest', async () => {
    const { internals, kas, updateOnChain, fetches } = await bootMember({ kaNumbers: [7n, 8n, 9n] });
    const triggers = recorder((_localCgId: string) => undefined);
    internals.vmReconcileScheduling = { triggerLive: triggers };
    for (const ka of kas) {
      const root = updateOnChain(ka.kaNumber, { label: `B-${ka.kaNumber}`, assertionVersion: 2n });
      await internals.handleKAUpdatedNudge(ka.kaId, root, ctx);
    }
    triggers.calls.length = 0;

    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(fetches.calls).toHaveLength(2);
    expect(internals.vmRefreshQueue.size).toBe(1);
    expect(triggers.calls).toEqual([[CG]]);

    await internals.runVmRefreshesForCg(CG, CG, () => true);
    expect(fetches.calls).toHaveLength(3);
    expect(internals.vmRefreshQueue.size).toBe(0);
    expect(triggers.calls).toEqual([[CG]]);
  });
});

describe('lifecycle wiring (#2858)', () => {
  it('routes the poller update lane to the refresh nudge, with the batch id as the KA id', async () => {
    agent = await DKGAgent.create({
      name: 'VmRefreshWiring',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
      rfc64CatalogActivation: { enabled: false },
    });
    await agent.start();
    const poller = (agent as unknown as {
      chainPoller: {
        onCollectionUpdated?: (info: {
          merkleRoot: Uint8Array;
          batchId: bigint;
          blockNumber: number;
        }) => Promise<void>;
      } | null;
    }).chainPoller;
    expect(poller?.onCollectionUpdated).toBeTypeOf('function');

    const nudges = recorder(async (..._args: unknown[]): Promise<VmRefreshTarget[]> => []);
    (agent as unknown as { handleKAUpdatedNudge: typeof nudges }).handleKAUpdatedNudge = nudges;
    const root = new Uint8Array(32).fill(7);
    await poller!.onCollectionUpdated!({ merkleRoot: root, batchId: 42n, blockNumber: 9 });

    expect(nudges.calls).toHaveLength(1);
    expect(nudges.calls[0]!.slice(0, 2)).toEqual([42n, root]);
  });
});
