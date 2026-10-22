import { afterEach, describe, expect, it } from 'vitest';
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
  runDurableSync,
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
  options: { holdingsUnreadable?: boolean; chain?: () => readonly AssetFixture[] } = {},
) {
  const peers: Record<string, ServingPeer> = 'send' in serving ? { [PEER]: serving as ServingPeer } : serving;
  const chain = options.chain ?? (() => Object.values(peers)[0]!.current());
  const store = new OxigraphStore();
  stores.push(store);
  const writes: string[] = [];
  const info: string[] = [];
  let holdingsUnreadable = options.holdingsUnreadable === true;
  const readHeld = currentHeldGraphScopedAssetsReader({
    readHeld: async (request) => {
      if (holdingsUnreadable) throw new Error('store queue wait timeout');
      return heldGraphScopedAssetsReader(store)(request);
    },
    readChainState: async ({ ual }) => {
      const onChain = chain().find((fixture) => fixture.ual === ual)!;
      return { merkleRootHex: onChain.rootHex, assertionVersion: BigInt(onChain.version), bound: true };
    },
    budget: { createGraphScopedAuthenticationDeadline: () => Date.now() + 60_000 },
  });
  const round = (
    checkpointStore: MemorySyncCheckpointStore,
    remotePeerId: string,
    roundOptions: Pick<DurableSyncContext, 'durableMetaContinuation' | 'exactAssetSelectionFor'>,
  ) => runDurableSync({
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
    readHeldGraphScopedAssets: readHeld,
    processDurableBatchInWorker: processBatch,
    storeInsert: async ({ quads }) => { await store.insert(quads); },
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
  });

  /** A process lifetime: a new owner and a new checkpoint store. */
  const start = (startOptions: { exactRequests?: boolean } = {}) => {
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
      executeSlice: (peerId, durableMetaContinuation: DurableMetaContinuation) => round(
        checkpointStore,
        peerId,
        { durableMetaContinuation },
      ),
      ...(startOptions.exactRequests === false ? {} : {
        executeExactSlice: async (peerId: string, assetUals: readonly string[]) => {
          const selection = createUalOnlyExactAssetSelection(assetUals);
          const result = await round(checkpointStore, peerId, { exactAssetSelectionFor: () => selection });
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
  return { store, writes, info, start, failHoldingsReads };
}

const generation = (version3 = '1') => [1, 2, 3, 4, 5, 6].map((n) => asset(n, n === 3 ? version3 : '1'));
const rowsOf = (fixtures: readonly AssetFixture[]) => fixtures.reduce((rows, fixture) => rows + fixture.payload.length, 0);

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
