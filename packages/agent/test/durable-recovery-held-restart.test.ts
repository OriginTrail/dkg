import { createStoreMutationOwner } from '../src/internal/observed-store-mutation.js';
import { createMutationObservedStore } from '../src/internal/context-graph-cache-invalidating-store.js';
import { RecoveryMaterializationOwner } from '../src/durable-recovery-materialization.js';
import { continueContextGraphSubscriptionLine } from '../src/context-graph-subscription-policy.js';
import type { ContextGraphSub } from '../src/dkg-agent-types.js';
import { durableRecoveryRoundOutcome } from '../src/sync/durable-recovery-round.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createRpcTimeoutError } from '@origintrail-official/dkg-chain';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
  overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { SYNC_PAGE_SIZE } from '../src/dkg-agent-constants.js';
import { getSyncCheckpointKey, MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { createGraphScopedDurableManifestPlan } from '../src/sync/durable-integrity.js';
import { createUalOnlyExactAssetSelection } from '../src/sync/exact-assets.js';
import { DurableRecoveryRunner, type DurableRecoveryRunnerDependencies } from '../src/sync/durable-recovery-runner.js';
import { classifyDurableProgress } from '../src/sync/durable-progress.js';
import {
  currentHeldGraphScopedAssetsReader,
  heldGraphScopedAssetsReader,
  readHeldGraphScopedAssets,
} from '../src/sync/requester/durable-data-holdings.js';
import {
  runDurableSyncDetailed,
  type DurableMetaContinuation,
  type DurableSyncContext,
} from '../src/sync/requester/durable-sync.js';
import { materializeVerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';
import { deleteSyncPageCheckpoint, fetchSyncPages } from '../src/sync/requester/page-fetch.js';
import { processDurableBatchForWire } from '../src/sync-verify-worker-impl.js';
import type { DurableBatchVerificationMode } from '../src/sync-verify-worker.js';
import { uniformDurableSyncBudget } from './durable-sync-test-helpers.js';

const CG = 'held-restart-cg';
const PEER = '12D3KooWHeldRestartPeer';
const SECOND_PEER = '12D3KooWHeldRestartPeerTwo';
const ctx = { operationId: 'held-restart', operationName: 'sync' } as OperationContext;
const stores: OxigraphStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

interface AssetFixture {
  readonly ual: string;
  readonly graph: string;
  readonly payload: Quad[];
  readonly meta: Quad[];
  readonly version: string;
  readonly rootHex: string;
}

function asset(kaNumber: number, version = '1'): AssetFixture {
  const ual = `did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ef/${kaNumber}`;
  const graph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, version));
  const payload = Array.from({ length: 4 + kaNumber }, (_, index): Quad => ({
    subject: `urn:held-restart:${kaNumber}:${index}`,
    predicate: 'urn:held-restart:value',
    object: `"v${version}-${index}"`,
    graph,
  }));
  const merkleRoot = computeFlatKCRootV10(payload, []);
  const meta = generateGraphKnowledgeAssetMetadata({
    ual,
    contextGraphId: CG,
    merkleRoot,
    publisherPeerId: 'publisher-peer',
    accessPolicy: 'public',
    timestamp: new Date(0),
    assertionVersion: version,
    publicTripleCount: payload.length,
    privateTripleCount: 0,
    assertionGraph: graph,
  }, { status: 'tentative' });
  return { ual, graph, payload, meta, version, rootHex: Buffer.from(merkleRoot).toString('hex') };
}

/**
 * A peer serving one graph: META, then DATA in manifest order (exact graphs by
 * code point), both narrowed to the requested assets of an exact request.
 */
function servingPeer(initial: AssetFixture[]) {
  let assets = initial;
  let pending: { phase: string; offset: number; limit: number; assetUals?: string[] } | undefined;
  const responses = new Map<string, Quad[]>();
  const served = { dataRequests: 0, dataRows: 0, exactDataRows: 0 };
  return {
    served,
    publish(next: AssetFixture[]) { assets = next; },
    current: () => assets,
    buildSyncRequest: async (
      _cg: string, offset: number, limit: number, _swm: boolean, _peer: string, phase?: string,
      _snapshotRef?: string, _sinceBatchId?: string, _session?: string, _recovery?: boolean, assetUals?: string[],
    ) => {
      pending = { phase: phase ?? 'data', offset, limit, assetUals };
      return new TextEncoder().encode('request');
    },
    send: async () => {
      const { phase, offset, limit, assetUals } = pending!;
      const selected = [...assets]
        .filter((fixture) => assetUals === undefined || assetUals.includes(fixture.ual))
        .sort((left, right) => (left.graph < right.graph ? -1 : left.graph > right.graph ? 1 : 0));
      const page = (phase === 'meta' ? selected.flatMap((fixture) => fixture.meta) : selected.flatMap((fixture) => fixture.payload))
        .slice(offset, offset + limit);
      if (phase === 'data') {
        served.dataRequests += 1;
        served.dataRows += page.length;
        if (assetUals !== undefined) served.exactDataRows += page.length;
      }
      if (page.length === 0) return new Uint8Array();
      const id = `response-${responses.size}`;
      responses.set(id, page);
      return new TextEncoder().encode(id);
    },
    parseAndFilter: async (body: string) => {
      const quads = responses.get(body) ?? [];
      return { quads, totalQuads: quads.length };
    },
  };
}

function processBatch(
  dataQuads: Quad[],
  metaQuads: Quad[],
  _ctx: OperationContext,
  acceptUnverified: boolean,
  mode: DurableBatchVerificationMode,
) {
  const wire = processDurableBatchForWire(dataQuads, metaQuads, acceptUnverified, mode);
  return {
    verifiedData: wire.verifiedDataIndexes.map((index) => dataQuads[index]!),
    verifiedMeta: wire.verifiedMetaIndexes.map((index) => metaQuads[index]!),
    verifiedGraphScopedDataGraphs: wire.verifiedGraphScopedDataGraphs,
    consumedUnpersistedMetaTriples: wire.consumedUnpersistedMetaTriples,
    verifiedPrivateOnlyResponses: wire.verifiedPrivateOnlyResponses,
    totalFetchedDataQuads: wire.totalFetchedDataQuads,
    totalFetchedMetaQuads: wire.totalFetchedMetaQuads,
    rejectedKcs: wire.rejectedKcs,
    emptyResponses: wire.emptyResponses,
    metaOnlyResponses: wire.metaOnlyResponses,
    dataRejectedMissingMeta: wire.dataRejectedMissingMeta,
  };
}

type ServingPeer = ReturnType<typeof servingPeer>;

/**
 * One node: its triple store survives a restart; checkpoints and the owner's
 * memory need not. Its chain is the generation the first peer serves unless a
 * test moves it.
 */
function node(
  serving: ServingPeer | Record<string, ServingPeer>,
  options: { holdingsUnreadable?: boolean; chain?: () => readonly AssetFixture[]; subscriptionId?: () => string; subscription?: () => ContextGraphSub | undefined; beforeChainRead?: () => Promise<void>; beforeVerify?: () => Promise<void>; beforeMetaStore?: () => Promise<void> } = {},
) {
  const peers: Record<string, ServingPeer> = 'send' in serving ? { [PEER]: serving as ServingPeer } : serving;
  const chain = options.chain ?? (() => Object.values(peers)[0]!.current());
  const rawStore = new OxigraphStore();
  stores.push(rawStore);
  const mutationOwner = createStoreMutationOwner(() => {});
  const store = createMutationObservedStore(rawStore, mutationOwner);
  const writes: string[] = [];
  const info: string[] = [];
  let holdingsUnreadable = options.holdingsUnreadable === true;
  // Chain checks answered per round; later ones time out, as on a throttled endpoint past the round's budget.
  let chainAnswersPerRound = Number.POSITIVE_INFINITY;
  let chainAnswersLeft = chainAnswersPerRound;
  let defaultSubscription: ContextGraphSub = { syncMode: 'always-on', subscribed: true, synced: true, onChainId: '323' };
  const materialization = new RecoveryMaterializationOwner({
    chain: () => { throw new Error('chain reads supplied below'); }, store: () => store,
    isClosed: () => false, subscription: () => {
      if (options.subscription) return options.subscription();
      const onChainId = options.subscriptionId?.() ?? '323';
      if (defaultSubscription.onChainId !== onChainId) defaultSubscription = { ...defaultSubscription, onChainId };
      return defaultSubscription;
    },
    bindingGeneration: () => 0, isBindingGenerationCurrent: (_id, captured) => captured === 0,
    track: () => {}, verifyBinding: async () => true,
    persistSubscription: async () => { throw new Error('already bound'); },
    bindSubscription: () => { throw new Error('already bound'); }, recordDrops: () => {}, reconcile: async () => {},
  }).forOperation({ ctx, contextGraphId: CG, authority: {
    coalescing: 'owner-only', admitVerifiedPage() {}, isRegisteredPublic: () => true,
    authenticate: () => { throw new Error('materialization supplied below'); },
  } });
  const holdings = (binding: () => Readonly<{ onChainId?: string; generation: number }>) => currentHeldGraphScopedAssetsReader({
    binding,
    readHeld: async (request) => {
      if (holdingsUnreadable) throw new Error('store queue wait timeout');
      return heldGraphScopedAssetsReader(store)(request);
    },
    readChainState: async ({ ual }) => {
      await options.beforeChainRead?.();
      if (chainAnswersLeft <= 0) throw createRpcTimeoutError('held chain check exceeded its context-graph deadline');
      chainAnswersLeft -= 1;
      const onChain = chain().find((fixture) => fixture.ual === ual)!;
      return { merkleRootHex: onChain.rootHex, assertionVersion: BigInt(onChain.version), bound: true, onChainContextGraphId: '323' };
    },
    budget: { createGraphScopedAuthenticationDeadline: () => Date.now() + 60_000 },
  });
  const round = (
    checkpointStore: MemorySyncCheckpointStore,
    remotePeerId: string,
    roundOptions: Pick<DurableSyncContext, 'graphRecovery' | 'exactAssetSelectionFor' | 'settlementSliceDeadline'>,
  ) => materialization.withHeldAssetFence(fence => runDurableSyncDetailed({
    ctx,
    remotePeerId,
    contextGraphIds: [CG],
    durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
    fetchSyncPages: (request) => fetchSyncPages({
      ctx: request.ctx,
      remotePeerId: request.remotePeerId,
      contextGraphId: request.contextGraphId,
      includeSharedMemory: false,
      phase: request.phase,
      graphUri: request.graphUri,
      deadline: request.fetchContext.deadline,
      syncPageTimeoutMs: 5_000,
      syncRouterAttempts: 1,
      syncPageRetryAttempts: 1,
      syncPageSize: SYNC_PAGE_SIZE,
      syncDeniedResponse: '#DENIED',
      debugSyncProgress: false,
      protocolSync: '/test/durable-held-restart',
      checkpointStore,
      forceFreshSession: request.forceFreshSession,
      manifestDigest: request.manifestDigest,
      manifestPrefixDigestAtOffset: request.manifestPrefixDigestAtOffset,
      durableResumeBoundary: request.durableResumeBoundary,
      shouldStopAfterPage: request.shouldStopAfterPage,
      returnAcceptedPrefixOnRetryableTransportFailure: request.returnAcceptedPrefixOnRetryableTransportFailure,
      requesterScope: request.requesterScope,
      assetUals: request.exactAssetUals,
      buildSyncRequest: peers[request.remotePeerId]!.buildSyncRequest,
      send: peers[request.remotePeerId]!.send,
      parseAndFilter: peers[request.remotePeerId]!.parseAndFilter,
      logWarn: () => {},
      logInfo: () => {},
      logDebug: () => {},
    }),
    ...roundOptions,
    graphRecovery: roundOptions.graphRecovery ? { ...roundOptions.graphRecovery, held: {
      reader: holdings(fence.binding)!, assertCurrent: fence.assertCurrent,
      withStoreFence: mutationOwner.contentFence.withScope.bind(mutationOwner.contentFence),
    } } : undefined,
    processDurableBatchInWorker: async (...args) => { await options.beforeVerify?.(); return processBatch(...args); },
    storeInsert: async ({ quads }) => { await options.beforeMetaStore?.(); await store.insert(quads); },
    storeGraphScopedAsset: async ({ asset: verified }) => {
      writes.push(verified.ual);
      // As chain authentication leaves it: confirmed, written with its rows in one replacement.
      const metadataQuads = overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1(
        verified.metadataQuads,
        { ual: verified.ual, metaGraph: verified.metaGraph, receivedAt: new Date(0) },
        {
          status: 'confirmed',
          materializedVersion: { blockNumber: 1, txIndex: 0 },
          confirmation: { kind: 'finalized-materialization' },
        },
      );
      return materializeVerifiedGraphScopedAsset({ store, asset: { ...verified, metadataQuads } });
    },
    deleteCheckpoint: (key) => deleteSyncPageCheckpoint(checkpointStore, key),
    setCheckpoint: (key, checkpoint) => {
      if (checkpoint.binding) {
        checkpointStore.setManifestBoundOffset(key, checkpoint.offset, checkpoint.binding.manifestDigest, Date.now(),
          checkpoint.binding.manifestPrefixDigest, checkpoint.binding.terminal, checkpoint.responderSessionOffset);
      } else checkpointStore.set(key, checkpoint.offset, Date.now(), checkpoint.responderSessionOffset);
    },
    logInfo: (_ctx, message) => { info.push(message); },
    logWarn: (_ctx, message) => { info.push(message); },
    logDebug: () => {},
  }));

  /**
   * A process lifetime: a new owner and a new checkpoint store. With
   * `sliceSpent`, each round starts past its slice's soft deadline, as once
   * held-copy checks used the slice: a DATA round stops at its first complete graph.
   */
  const start = (startOptions: { exactRequests?: boolean; sliceSpent?: boolean } = {}) => {
    const checkpointStore = new MemorySyncCheckpointStore();
    const dependencies: DurableRecoveryRunnerDependencies = {
      checkpointStore,
      isRunning: () => true,
      resolvePreferredPeerId: async () => undefined,
      connectRequestedPeer: async () => {},
      primeConnections: async () => {},
      liveConnectionPeerIds: () => Object.keys(peers),
      admitPeer: async () => true,
      isPrivateContextGraph: async () => false,
      orderPeerIds: (peerIds) => [...peerIds],
      isSyncCapable: async () => true,
      executeSlice: async (peerId, durableMetaContinuation: DurableMetaContinuation, durableRecoveryRound, durableResumeBoundary) => {
        chainAnswersLeft = chainAnswersPerRound;
        const detailed = await round(checkpointStore, peerId, {
          graphRecovery: { meta: durableMetaContinuation, holdings: durableRecoveryRound, boundary: durableResumeBoundary },
          settlementSliceDeadline: startOptions.sliceSpent ? Date.now() : undefined,
        });
        return durableRecoveryRoundOutcome(detailed.result, detailed.recoveryRound);
      },
      ...(startOptions.exactRequests === false ? {} : {
        executeExactSlice: async (peerId: string, assetUals: readonly string[]) => {
          const selection = createUalOnlyExactAssetSelection(assetUals);
          const { result } = await round(checkpointStore, peerId, { exactAssetSelectionFor: () => selection });
          return { result, complete: result.complete === true };
        },
      }),
      logDebug: () => {},
      logInfo: (message) => { info.push(message); },
      logWarn: (message) => { info.push(message); },
    };
    return {
      checkpointStore,
      recover: () => new DurableRecoveryRunner().run({ contextGraphId: CG, dependencies }),
    };
  };
  const failHoldingsReads = (fail: boolean) => { holdingsUnreadable = fail; };
  const limitChainAnswersPerRound = (answers: number) => { chainAnswersPerRound = answers; };
  return { store, writes, info, start, failHoldingsReads, limitChainAnswersPerRound };
}

const generation = (version3 = '1') => [1, 2, 3, 4, 5, 6].map((n) => asset(n, n === 3 ? version3 : '1'));
const rowsOf = (fixtures: readonly AssetFixture[]) => fixtures.reduce((rows, fixture) => rows + fixture.payload.length, 0);

describe('a recovery whose rounds outlast their slices', () => {
  it('resumes each round at its settled boundary under a complete manifest', async () => {
    const graph = Array.from({ length: 12 }, (_, index) => asset(index + 1));
    const peer = servingPeer(graph);
    const core = node(peer);

    // Every round writes past its slice's soft deadline, so it yields at the first settled boundary it can.
    const recovered = await core.start({ sliceSpent: true }).recover();

    expect(recovered.outcome).toBe('terminal');
    expect([...core.writes].sort()).toEqual(graph.map((fixture) => fixture.ual).sort());
    expect(core.info.filter((line) => line.startsWith('Yielding durable recovery')).length).toBeGreaterThan(1);
    expect(await readHeldGraphScopedAssets(core.store, {
      contextGraphId: CG,
      descriptors: createGraphScopedDurableManifestPlan(graph.flatMap((fixture) => fixture.meta), CG)!.descriptors,
    })).toEqual(new Set(graph.map((fixture) => fixture.ual)));
  });
});

describe('a restarted Core and a graph it has already recovered', () => {
  it('transfers no DATA rows when the graph is unchanged', async () => {
    const peer = servingPeer(generation());
    const core = node(peer);

    const first = await core.start().recover();
    expect(first.outcome).toBe('terminal');
    expect(peer.served.dataRows).toBe(rowsOf(generation()));
    expect(core.writes).toHaveLength(6);

    // Restart: no owner memory, and the checkpoints are gone (expired after a day, or another peer).
    peer.served.dataRequests = 0;
    peer.served.dataRows = 0;
    core.writes.length = 0;
    const restarted = core.start();
    const second = await restarted.recover();

    expect(second.outcome).toBe('terminal');
    expect(second.result.complete).toBe(true);
    expect(peer.served.dataRequests).toBe(0);
    expect(peer.served.dataRows).toBe(0);
    expect(core.writes).toEqual([]);
    expect(second.result).toMatchObject({
      fetchedDataTriples: 0, insertedDataTriples: 0, completedPhases: 2, verifiedHeldAssets: 6,
    });
    // The held completion is readiness proof, as inserted data or a private-only response is.
    expect(classifyDurableProgress(second.result, { complete: second.result.complete }).completedReadinessCleanly)
      .toBe(true);
    expect(restarted.checkpointStore.get(getSyncCheckpointKey(PEER, CG, false, 'data')))
      .toMatchObject({ offset: rowsOf(generation()), terminal: true });
    expect(core.info).toContainEqual(expect.stringContaining('already held at this META generation'));
  });

  it.each(['chain', 'verification', 'metadata-store'].flatMap(stage =>
    ['deactivate', 'recreate', 'equivalent', 'delete-assertions'].map(change => ({ stage, change }))))(
    'fences held completion across $change during $stage', async ({ stage, change }) => {
      const peer = servingPeer(generation());
      let subscription: ContextGraphSub | undefined = {
        syncMode: 'always-on', subscribed: true, synced: true, onChainId: '323',
      };
      let entered!: () => void;
      let release!: () => void;
      const paused = new Promise<void>(resolve => { entered = resolve; });
      const resumed = new Promise<void>(resolve => { release = resolve; });
      let pause = false;
      const suspend = async (at: string) => { if (pause && stage === at) { entered(); await resumed; } };
      const core = node(peer, { subscription: () => subscription,
        beforeChainRead: () => suspend('chain'), beforeVerify: () => suspend('verification'),
        beforeMetaStore: () => suspend('metadata-store'),
      });
      expect((await core.start().recover()).outcome).toBe('terminal');
      peer.current()[0]!.meta.push({ subject: 'urn:held-restart:lifecycle',
        predicate: 'http://dkg.io/ontology/operationId', object: '"new-operation"',
        graph: peer.current()[0]!.meta[0]!.graph });
      pause = true;
      peer.served.dataRows = 0;
      const restarted = core.start();
      const recovering = restarted.recover();
      await paused;
      if (change === 'delete-assertions') await core.store.dropGraph(peer.current()[0]!.graph);
      else {
        const previous = subscription!;
        if (change === 'recreate') subscription = undefined;
        subscription = { ...previous, ...(change === 'deactivate' ? { subscribed: false } : { synced: false }) };
        if (change !== 'recreate') continueContextGraphSubscriptionLine(previous, subscription);
      }
      release();
      const result = await recovering;
      const terminal = restarted.checkpointStore.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.terminal === true;
      if (change === 'equivalent') {
        expect(result.outcome).toBe('terminal');
        expect(result.result.verifiedHeldAssets).toBe(6);
        expect(terminal).toBe(true);
      } else {
        expect(result.outcome).not.toBe('terminal');
        expect(result.result.verifiedHeldAssets ?? 0).toBe(0);
        expect(terminal).toBe(false);
        expect(classifyDurableProgress(result.result, { complete: result.result.complete }).completedReadinessCleanly).toBe(false);
      }
      expect(peer.served.dataRows).toBe(0);
    },
  );

  it.each([false, true])('stores new admissible META while skipping held DATA (missing asset: %s)', async (missing) => {
    const graph = generation();
    const peer = servingPeer(graph);
    const core = node(peer);
    expect((await core.start().recover()).outcome).toBe('terminal');
    const metaGraph = graph[0]!.meta[0]!.graph;
    const additions: Quad[] = [
      { subject: 'urn:held-restart:lifecycle', predicate: 'http://dkg.io/ontology/operationId', object: '"later-operation"', graph: metaGraph },
      { subject: 'urn:held-restart:reports', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: metaGraph },
      { subject: 'urn:held-restart:reports', predicate: 'http://dkg.io/ontology/name', object: '"reports"', graph: metaGraph },
    ];
    graph[0]!.meta.push(...additions);
    if (missing) await core.store.dropGraph(graph[1]!.graph);
    peer.served.dataRows = 0;
    const recovered = await core.start().recover();
    expect(recovered.outcome).toBe('terminal');
    expect(peer.served.dataRows).toBe(missing ? graph[1]!.payload.length : 0);
    for (const quad of additions) {
      const object = quad.object.startsWith('"') ? quad.object : `<${quad.object}>`;
      const result = await core.store.query(`ASK { GRAPH <${quad.graph}> { <${quad.subject}> <${quad.predicate}> ${object} } }`);
      expect(result).toEqual({ type: 'boolean', value: true });
    }
  });

  it('cannot use a held copy from another numeric graph slot as terminal proof', async () => {
    const peer = servingPeer(generation());
    let subscriptionId = '323';
    const core = node(peer, { subscriptionId: () => subscriptionId });
    expect((await core.start().recover()).outcome).toBe('terminal');
    // Both slots commit the same name; the chain name-binding proof still succeeds.
    subscriptionId = '582';
    peer.served.dataRows = 0;
    const restarted = core.start();
    const recovered = await restarted.recover();
    expect(recovered.outcome).not.toBe('terminal');
    expect(recovered.result.verifiedHeldAssets).toBe(0);
    expect(restarted.checkpointStore.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.terminal).not.toBe(true);
    expect(peer.served.dataRows).toBe(0);
  });

  it('fetches an asset again when its rows were removed and its envelope kept', async () => {
    const peer = servingPeer(generation());
    const core = node(peer);
    expect((await core.start().recover()).outcome).toBe('terminal');

    // A removed sub-graph drops the rows and keeps the confirmed envelope.
    const dropped = asset(2);
    await core.store.dropGraph(dropped.graph);
    peer.served.dataRows = 0;
    core.writes.length = 0;
    const recovered = await core.start().recover();

    expect(recovered.outcome).toBe('terminal');
    expect(peer.served.dataRows).toBe(dropped.payload.length);
    expect(core.writes).toEqual([dropped.ual]);
  });

  it('recovers from a peer with the current version when the first peer is behind the chain', async () => {
    const behind = servingPeer(generation());
    const current = servingPeer(generation());
    let onChain = generation();
    const core = node({ [PEER]: behind, [SECOND_PEER]: current }, { chain: () => onChain });
    expect((await core.start().recover()).outcome).toBe('terminal');

    // Asset 3 is updated on chain; only the second peer serves the new version.
    onChain = generation('2');
    current.publish(generation('2'));
    behind.served.dataRows = 0;
    current.served.dataRows = 0;
    core.writes.length = 0;
    const recovered = await core.start().recover();

    expect(recovered.outcome).toBe('terminal');
    expect(recovered.peerId).toBe(SECOND_PEER);
    expect(behind.served.dataRows).toBe(0);
    expect(current.served.dataRows).toBe(asset(3, '2').payload.length);
    expect(core.writes).toEqual([asset(3, '2').ual]);
    expect(core.info).toContainEqual(expect.stringContaining('is behind the chain'));
  });

  it('transfers only the updated asset when one asset has a new version', async () => {
    const peer = servingPeer(generation());
    const core = node(peer);
    expect((await core.start().recover()).outcome).toBe('terminal');

    peer.publish(generation('2'));
    peer.served.dataRows = 0;
    peer.served.exactDataRows = 0;
    core.writes.length = 0;
    const updated = await core.start().recover();

    expect(updated.outcome).toBe('terminal');
    const changed = asset(3, '2');
    expect(peer.served.dataRows).toBe(changed.payload.length);
    expect(peer.served.exactDataRows).toBe(changed.payload.length);
    expect(core.writes).toEqual([changed.ual]);
    const current = createGraphScopedDurableManifestPlan(generation('2').flatMap((fixture) => fixture.meta), CG)!;
    expect(await readHeldGraphScopedAssets(core.store, { contextGraphId: CG, descriptors: current.descriptors }))
      .toEqual(new Set(current.descriptors.map((descriptor) => descriptor.ual)));
    expect(core.info).toContainEqual(expect.stringContaining('fetches 1 missing asset(s)'));
    expect(core.info).toContainEqual(expect.stringContaining('reached its terminal verified boundary'));
  });

  it('still recovers a changed generation with full-graph rounds when exact requests are unavailable', async () => {
    const peer = servingPeer(generation());
    const core = node(peer);
    expect((await core.start().recover()).outcome).toBe('terminal');

    peer.publish(generation('2'));
    peer.served.dataRows = 0;
    core.writes.length = 0;
    const updated = await core.start({ exactRequests: false }).recover();

    expect(updated.outcome).toBe('terminal');
    expect(peer.served.dataRows).toBe(rowsOf(generation('2')));
    expect(core.writes).toContain(asset(3, '2').ual);
  });

  it('falls back to full-graph rounds when the store cannot say what it holds', async () => {
    const peer = servingPeer(generation());
    const core = node(peer);
    expect((await core.start().recover()).outcome).toBe('terminal');

    core.failHoldingsReads(true);
    peer.served.dataRows = 0;
    const restarted = await core.start().recover();

    expect(restarted.outcome).toBe('terminal');
    expect(peer.served.dataRows).toBe(rowsOf(generation()));
    expect(core.info).toContainEqual(expect.stringContaining('store queue wait timeout'));
  });

  it('settles a large held graph over several rounds when the chain answers only part of its checks in each', async () => {
    const large = Array.from({ length: 120 }, (_, index) => asset(index + 1));
    const peer = servingPeer(large);
    const core = node(peer);
    expect((await core.start().recover()).outcome).toBe('terminal');

    // A throttled endpoint: each round's checks run out of budget after 50 assets, and with them its slice.
    core.limitChainAnswersPerRound(50);
    peer.served.dataRows = 0;
    const restarted = await core.start({ sliceSpent: true }).recover();

    expect(restarted.outcome).toBe('terminal');
    expect(core.info).toContainEqual(expect.stringContaining("against the chain within the round's budget"));
    expect(core.info).toContainEqual(expect.stringContaining('already held at this META generation'));
    // Each round's checks resume where the last stopped; in between, short DATA rounds rather than a re-pull.
    expect(peer.served.dataRows).toBeLessThan(rowsOf(large) / 4);
  });

  it('fetches only an updated asset of a large graph when the chain answers part of the checks in each round', async () => {
    const large = (updated = '1') => Array.from({ length: 120 }, (_, index) => asset(index + 1, index === 2 ? updated : '1'));
    const peer = servingPeer(large());
    const core = node(peer);
    expect((await core.start().recover()).outcome).toBe('terminal');

    peer.publish(large('2'));
    core.limitChainAnswersPerRound(50);
    peer.served.dataRows = 0;
    peer.served.exactDataRows = 0;
    const restarted = await core.start({ sliceSpent: true }).recover();

    expect(restarted.outcome).toBe('terminal');
    expect(core.info).toContainEqual(expect.stringContaining("against the chain within the round's budget"));
    expect(core.info).toContainEqual(expect.stringContaining('fetches 1 missing asset(s)'));
    // The updated asset by exact request, and short DATA rounds while the checks catch up: no full-graph re-pull.
    expect(peer.served.exactDataRows).toBe(asset(3, '2').payload.length);
    expect(peer.served.dataRows).toBeLessThan(rowsOf(large()) / 4);
  });

  it('pulls the graph again when the store no longer holds it', async () => {
    const peer = servingPeer(generation());
    expect((await node(peer).start().recover()).outcome).toBe('terminal');

    // A replaced data directory: nothing records the earlier completion except the store itself.
    const replaced = node(peer);
    peer.served.dataRows = 0;
    const recovered = await replaced.start().recover();

    expect(recovered.outcome).toBe('terminal');
    expect(peer.served.dataRows).toBe(rowsOf(generation()));
    expect(replaced.writes).toHaveLength(6);
    expect(replaced.info).not.toContainEqual(expect.stringContaining('already held'));
  });
});
