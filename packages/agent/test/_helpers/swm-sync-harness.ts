/**
 * ONE runSharedMemorySync fixture for every real-store catch-up suite. It owns
 * the canonical store/materializer boundary, serves configurable phase data,
 * pre-seeds the snapshot store, and exposes only the interception points the
 * SWM materialization and coverage scenarios need.
 */
import type { OperationContext } from '@origintrail-official/dkg-core';
import {
  workspaceOperationPublicSliceSubject,
  workspacePublicQuadsDigest,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import { storeWorkspaceOperationPublicQuads } from
  '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';
import { GraphManager, OxigraphStore, type Quad, type TripleStore } from
  '@origintrail-official/dkg-storage';
import type { SyncPhase } from '../../src/sync/auth/request-build.js';
import type { SyncPageResult } from '../../src/sync/requester/page-fetch.js';
import {
  runSharedMemorySync,
  type SharedMemorySyncSummary,
} from '../../src/sync/requester/shared-memory-sync.js';
import { createSharedMemorySnapshotMaterializer } from '../../src/sync/requester/swm-snapshot-materializer.js';

export class MemorySnapshotStore implements WorkspacePublicSnapshotStore {
  readonly snapshots = new Map<string, Quad[]>();
  async putSnapshot(input: { readonly digest: string; readonly quads: readonly Quad[] }) {
    this.snapshots.set(input.digest, input.quads.map((quad) => ({ ...quad })));
    return { ref: input.digest, byteLength: 0 };
  }
  async getSnapshot(ref: string): Promise<Quad[] | null> {
    return this.snapshots.get(ref)?.map((quad) => ({ ...quad })) ?? null;
  }
}

export interface SwmSyncHarnessShare {
  readonly digest: string;
  readonly payload: readonly Quad[];
  readonly meta: readonly Quad[];
}

export interface SwmSyncHarnessFetchInput {
  readonly contextGraphId: string;
  readonly phase: SyncPhase;
  readonly snapshotRef: string | undefined;
}

export interface SwmSyncHarnessOptions {
  readonly ctx: OperationContext;
  readonly contextGraphId: string;
  readonly store: TripleStore;
  readonly served?: SwmSyncHarnessShare;
  /** Meta payload override (defaults to the served share's meta). */
  readonly servedMeta?: readonly Quad[];
  readonly cachedSnapshots?: ReadonlyMap<string, readonly Quad[]>;
  readonly remotePeerId?: string;
  readonly fetchPage?: (
    input: SwmSyncHarnessFetchInput,
    fallback: SyncPageResult,
  ) => Promise<SyncPageResult>;
  /** Use real store-backed materialization by default, or explicitly disable it. */
  readonly materialization?: 'real' | 'disabled';
  /** Runs before real graph replacement; throwing models a write failure. */
  readonly onReplaceGraph?: (graphUri: string, quads: readonly Quad[]) => void;
}

export function makeSwmSyncHarness(options: SwmSyncHarnessOptions) {
  const snapshotStore = new MemorySnapshotStore();
  const materializer = options.materialization === 'disabled' ? undefined
    : createSharedMemorySnapshotMaterializer({
      store: options.store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
  const onReplaceGraph = options.onReplaceGraph;
  if (materializer && onReplaceGraph) {
    const replaceGraph = materializer.replaceGraph.bind(materializer);
    materializer.replaceGraph = async (graphUri, quads) => {
      onReplaceGraph(graphUri, quads);
      await replaceGraph(graphUri, quads);
    };
  }
  const servedMeta = options.servedMeta ?? options.served?.meta ?? [];
  const snapshotFetches: string[] = [];
  const run = async () => {
    const cachedSnapshots = options.cachedSnapshots
      ?? (options.served
        ? new Map([[options.served.digest, options.served.payload]])
        : new Map<string, readonly Quad[]>());
    for (const [digest, quads] of cachedSnapshots) {
      await snapshotStore.putSnapshot({ digest, quads });
    }
    return runSharedMemorySync({
      mode: { kind: 'ordinary' },
      ctx: options.ctx,
      remotePeerId: options.remotePeerId ?? 'peer-source',
      contextGraphIds: [options.contextGraphId],
      createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (
        _ctx,
        _peer,
        contextGraphId,
        _includeSharedMemory,
        phase,
        _graphUri,
        _deadline,
        fetchOptions,
      ): Promise<SyncPageResult> => {
        if (phase === 'snapshot') snapshotFetches.push(String(fetchOptions?.snapshotRef));
        const fallback: SyncPageResult = {
          quads: phase === 'meta' ? [...servedMeta] : [],
          bytesReceived: 0,
          resumedFromOffset: 0,
          responderSessionStartedFresh: true,
          nextOffset: phase === 'meta' ? servedMeta.length : 0,
          checkpointKey: `${contextGraphId}:${phase}`,
          completed: true,
          timedOut: false,
        };
        return options.fetchPage?.({
          contextGraphId,
          phase,
          snapshotRef: fetchOptions?.snapshotRef,
        }, fallback) ?? fallback;
      },
      processSharedMemoryBatch: async (wsDataQuads, wsMetaQuads) => ({
        verifiedData: wsDataQuads,
        verifiedMeta: wsMetaQuads,
        totalFetchedDataQuads: wsDataQuads.length,
        totalFetchedMetaQuads: wsMetaQuads.length,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [],
      }),
      ensureContextGraph: async () => {},
      storeInsert: async (quads) => { await options.store.insert(quads); },
      snapshotMaterializer: materializer,
      publicSnapshotStore: snapshotStore,
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      ensureOwnedMap: () => new Map(),
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });
  };
  return { run, snapshotStore, snapshotFetches };
}

/** Real-store scenario runner with one canonical store lifecycle boundary. */
export async function runManagedSwmSyncHarness(
  options: Omit<SwmSyncHarnessOptions, 'store'>,
): Promise<{ summary: SharedMemorySyncSummary; snapshotFetches: string[] }> {
  const store = new OxigraphStore();
  try {
    const harness = makeSwmSyncHarness({ ...options, store });
    const summary = await harness.run();
    return { summary, snapshotFetches: harness.snapshotFetches };
  } finally {
    await store.close().catch(() => {});
  }
}

/** Entity-share manifest generated exclusively through the publisher boundary. */
export async function makeEntityShareSwmHarnessFixture(options: {
  readonly contextGraphId: string;
  readonly shareOperationId: string;
  readonly rootEntity: string;
  readonly payload: readonly Quad[];
  readonly publisherPeerId: string;
}): Promise<SwmSyncHarnessShare & { readonly sliceSubject: string }> {
  const store = new OxigraphStore();
  const graphManager = new GraphManager(store);
  const snapshots = new MemorySnapshotStore();
  try {
    await storeWorkspaceOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: options.contextGraphId,
      shareOperationId: options.shareOperationId,
      rootEntities: [options.rootEntity],
      quads: options.payload,
      publisherPeerId: options.publisherPeerId,
      timestamp: new Date(0),
      publicSnapshotStore: snapshots,
    });
    const metaGraph = graphManager.sharedMemoryMetaUri(options.contextGraphId);
    const result = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`,
    );
    if (result.type !== 'quads') throw new Error('Entity-share fixture metadata query did not return quads');
    const digest = workspacePublicQuadsDigest(options.payload);
    return {
      digest,
      payload: options.payload.map((quad) => ({ ...quad, graph: '' })),
      meta: result.quads.map((quad) => ({ ...quad, graph: metaGraph })),
      sliceSubject: workspaceOperationPublicSliceSubject(
        options.contextGraphId,
        options.shareOperationId,
        options.rootEntity,
      ),
    };
  } finally {
    await store.close().catch(() => {});
  }
}
