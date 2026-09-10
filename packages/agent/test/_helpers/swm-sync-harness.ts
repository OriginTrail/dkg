/**
 * ONE runSharedMemorySync fixture for every real-store catch-up suite
 * (`swm-snapshot-materializer.test.ts` end-to-end block and
 * `swm-head-identity-preservation.test.ts`). Serves a fixed meta payload,
 * pre-seeds the snapshot store with the served share's payload, and exposes
 * the knobs those suites need (meta override, replaceGraph interception).
 */
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import type { SyncPageResult } from '../../src/sync/requester/page-fetch.js';
import { runSharedMemorySync } from '../../src/sync/requester/shared-memory-sync.js';
import {
  createSharedMemorySnapshotMaterializer,
  type SharedMemorySnapshotMaterializer,
} from '../../src/sync/requester/swm-snapshot-materializer.js';

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

export function makeSwmSyncHarness(options: {
  readonly ctx: OperationContext;
  readonly contextGraphId: string;
  readonly store: TripleStore;
  readonly served: SwmSyncHarnessShare;
  /** Meta payload override (defaults to the served share's meta). */
  readonly servedMeta?: readonly Quad[];
  /** Intercept graph replacement while delegating to the real materializer. */
  readonly onReplaceGraph?: () => void;
}) {
  const snapshotStore = new MemorySnapshotStore();
  const materializer = createSharedMemorySnapshotMaterializer({
    store: options.store,
    writeLocks: new Map<string, Promise<void>>(),
    invalidateListContextGraphsCache: () => {},
  });
  const servedMeta = options.servedMeta ?? options.served.meta;
  const wired: SharedMemorySnapshotMaterializer = options.onReplaceGraph
    ? {
      ...materializer,
      replaceGraph: async (graphUri, quads) => {
        options.onReplaceGraph!();
        return materializer.replaceGraph(graphUri, quads);
      },
    }
    : materializer;
  const run = async () => {
    await snapshotStore.putSnapshot({
      digest: options.served.digest,
      quads: [...options.served.payload],
    });
    return runSharedMemorySync({
      mode: { kind: 'ordinary' },
      ctx: options.ctx,
      remotePeerId: 'peer-source',
      contextGraphIds: [options.contextGraphId],
      createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_c, _p, _cg, _inc, phase): Promise<SyncPageResult> => ({
        quads: phase === 'meta' ? [...servedMeta] : [],
        bytesReceived: 0,
        resumedFromOffset: 0,
        nextOffset: phase === 'meta' ? servedMeta.length : 0,
        checkpointKey: 'k',
        completed: true,
        timedOut: false,
      }),
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
      snapshotMaterializer: wired,
      publicSnapshotStore: snapshotStore,
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      ensureOwnedMap: () => new Map(),
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });
  };
  return { run, snapshotStore };
}
