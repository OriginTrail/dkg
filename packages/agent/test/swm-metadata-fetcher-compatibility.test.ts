import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextGraphWorkspaceGraphUri, createOperationContext } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { storeWorkspaceOperationPublicQuads } from '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';
import {
  runSharedMemorySync,
  type PublicSnapshotMetadata,
  type SharedMemoryMetadataFetcher,
  type SharedMemorySnapshotWalkContinuation,
} from '../src/sync/requester/shared-memory-sync.js';
import {
  SwmTargetExecutorV1,
  type PublicSwmTargetV1,
  type SwmTargetExecutorPortsV1,
} from '../src/sync/requester/swm-target-executor.js';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { createSwmRecoveryMutationRuntimeV1 } from '../src/sync/requester/swm-recovery-apply.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

type TargetLayout<T> = T extends PublicSwmTargetV1 ? Pick<T, 'mode' | 'metadataFetcher'> : never;

const CG = 'metadata-fetcher-compatibility';
const ctx = createOperationContext('sync');
const noop = () => {};
const page = (quads: Quad[]): SyncPageResult => ({
  quads, bytesReceived: 0, resumedFromOffset: 0, nextOffset: quads.length,
  checkpointKey: CG, completed: true, timedOut: false,
});

/** Prototype methods deliberately use instance state, as retained sessions do. */
class RetainedMetadataFetcher implements SharedMemoryMetadataFetcher {
  readonly fetched: string[] = [];
  readonly released: string[] = [];
  readonly walked: string[] = [];
  readonly resolved = new Set<string>();
  constructor(readonly metadata: Quad[]) {}
  async fetch(request: Parameters<SharedMemoryMetadataFetcher['fetch']>[0]) {
    this.fetched.push(request.contextGraphId);
    return { result: page(this.metadata), continuationYielded: false };
  }
  release(contextGraphId: string) { this.released.push(contextGraphId); }
  snapshotWalk(contextGraphId: string, manifest: readonly PublicSnapshotMetadata[]): SharedMemorySnapshotWalkContinuation {
    this.walked.push(contextGraphId);
    return {
      orderedManifestSnapshot: () => manifest.map(snapshot => ({ ...snapshot })),
      isResolved: ref => this.resolved.has(ref),
      resolvedCount: () => this.resolved.size,
      resolvedRefsSnapshot: () => [...this.resolved],
      suppressedMetadataRows: () => [],
      markResolved: ref => { this.resolved.add(ref); },
    };
  }
}

describe('metadata fetcher compatibility at public SWM boundaries', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

  async function fixture(boundary: 'requester' | 'executor') {
    const source = new OxigraphStore();
    const store = new OxigraphStore();
    stores.push(source, store);
    const graphManager = new GraphManager(source);
    const root = 'urn:test:retained-entity';
    const payload: Quad[] = [{ subject: root, predicate: 'https://schema.org/name', object: '"retained"', graph: '' }];
    const digest = workspacePublicQuadsDigest(payload);
    const snapshots = new Map<string, Quad[]>();
    const publicSnapshotStore: WorkspacePublicSnapshotStore = {
      getSnapshot: async ref => snapshots.get(ref) ?? null,
      putSnapshot: async ({ digest: ref, quads }) => {
        snapshots.set(ref, quads.map(quad => ({ ...quad })));
        return { ref, byteLength: 0 };
      },
    };
    await storeWorkspaceOperationPublicQuads({
      store: source, graphManager, contextGraphId: CG, shareOperationId: 'retained-op',
      rootEntities: [root], quads: payload, publisherPeerId: 'peer-source',
      timestamp: new Date(0), publicSnapshotStore,
    });
    const metaGraph = graphManager.sharedMemoryMetaUri(CG);
    const result = await source.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`);
    if (result.type !== 'quads') throw new Error('Expected publisher metadata');
    const metadata = result.quads.map(quad => ({ ...quad, graph: metaGraph }));
    const fetcher = new RetainedMetadataFetcher(metadata);
    const fetchSyncPages = vi.fn<SwmTargetExecutorPortsV1['fetchSyncPages']>(async (_ctx, _peer, _cg, _include, phase) => {
      if (phase === 'meta') throw new Error('Retained metadata was bypassed');
      return page(phase === 'snapshot' ? payload : payload.map(quad => ({ ...quad, graph: contextGraphWorkspaceGraphUri(CG) })));
    });
    const listSubGraphs = vi.fn(async () => []);
    const writeLocks = new Map<string, Promise<void>>();
    const recoveryMutation = createSwmRecoveryMutationRuntimeV1({
      store, recordDrops: noop, invalidateListContextGraphsCache: noop, markMetaProjectionDirty: noop,
    });
    const ports: SwmTargetExecutorPortsV1 = {
      store, writeLocks, listSubGraphs, fetchSyncPages, publicSnapshotStore, recoveryMutation,
      createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
      processSharedMemoryBatch: async (data, meta) => ({
        verifiedData: data, verifiedMeta: meta,
        totalFetchedDataQuads: data.length, totalFetchedMetaQuads: meta.length,
        droppedDataTriples: 0, emptyResponses: 0, entityCreators: [],
      }),
      recordDrops: noop, invalidateListContextGraphsCache: noop, markMetaProjectionDirty: noop,
      setCheckpoint: noop, deleteCheckpoint: noop, deletePublicCheckpoint: noop,
      ensureOwnedMap: () => new Map(), retireFinalizedSwmTwin: async () => {},
      logInfo: noop, logWarn: noop, logDebug: noop,
    };
    const executor = new SwmTargetExecutorV1(ports);
    const insert = vi.spyOn(store, 'insert');
    const recoveryGuard = { signal: new AbortController().signal, assertCurrent: noop };
    const run = (layout: TargetLayout<PublicSwmTargetV1>) => {
      if (boundary === 'executor') {
        return executor.syncPublicTarget({
          ctx, remotePeerId: 'peer-source', contextGraphId: CG, remainingContextGraphs: 1,
          ...layout,
        });
      }
      return runSharedMemorySync({
        ...layout, ctx, remotePeerId: 'peer-source', contextGraphIds: [CG],
        createContextGraphSyncDeadline: ports.createContextGraphSyncDeadline,
        fetchSyncPages, processSharedMemoryBatch: ports.processSharedMemoryBatch,
        getRegisteredSubGraphNames: listSubGraphs,
        ensureContextGraph: recoveryMutation.ensureContextGraph,
        storeInsert: quads => store.insert(quads),
        snapshotMaterializer: createSharedMemorySnapshotMaterializer({
          store, writeLocks, invalidateListContextGraphsCache: noop,
        }),
        publicSnapshotStore, setCheckpoint: noop, deleteCheckpoint: noop,
        ensureOwnedMap: () => new Map(), logInfo: noop, logWarn: noop, logDebug: noop,
      });
    };
    return { run, fetcher, digest, store, insert, listSubGraphs, fetchSyncPages, recoveryGuard };
  }

  describe.each(['requester', 'executor'] as const)('%s', boundary => {
    it.each(['ordinary', 'selected', 'legacy-selected', 'both-identical'] as const)(
      'uses metadata and snapshot continuation from %s layout', async kind => {
        const f = await fixture(boundary);
        const nested = kind === 'legacy-selected' || kind === 'both-identical';
        const layout: TargetLayout<PublicSwmTargetV1> = kind === 'legacy-selected'
          ? { mode: { kind: 'selected-recovery', recoveryGuard: f.recoveryGuard, metadataFetcher: f.fetcher } }
          : {
            metadataFetcher: f.fetcher,
            mode: kind === 'ordinary' ? { kind: 'ordinary' } : {
              kind: 'selected-recovery', recoveryGuard: f.recoveryGuard,
              ...(nested ? { metadataFetcher: f.fetcher } : {}),
            },
          };
        const summary = await f.run(layout);
        expect(summary.failedPhases).toBe(0);
        expect(f.fetcher.fetched).toEqual([CG]);
        expect(f.fetcher.walked).toEqual([CG]);
        expect(f.fetcher.resolved).toEqual(new Set([f.digest]));
        expect(f.fetcher.released).toEqual([CG]);
        expect(f.fetchSyncPages.mock.calls.some(call => call[4] === 'meta')).toBe(false);
        const stored = await f.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${contextGraphWorkspaceGraphUri(CG)}> { ?s ?p ?o } }`);
        expect(stored.type === 'quads' ? stored.quads : []).toHaveLength(1);
      },
    );

    it('rejects conflicting metadata fetchers before I/O', async () => {
      const f = await fixture(boundary);
      const other = new RetainedMetadataFetcher([]);
      await expect(f.run({
        metadataFetcher: f.fetcher,
        mode: { kind: 'selected-recovery', recoveryGuard: f.recoveryGuard, metadataFetcher: other },
      })).rejects.toThrow('Conflicting shared-memory metadata fetchers');
      expect(f.fetcher.fetched).toEqual([]);
      expect(other.fetched).toEqual([]);
      expect(f.listSubGraphs).not.toHaveBeenCalled();
      expect(f.fetchSyncPages).not.toHaveBeenCalled();
      expect(f.insert).not.toHaveBeenCalled();
    });
  });
});
