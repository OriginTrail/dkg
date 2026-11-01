import { describe, expect, it } from 'vitest';
import { contextGraphSharedMemoryUri, createOperationContext } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';
import { runSharedMemorySync, type SharedMemoryMetadataFetcher } from '../src/sync/requester/shared-memory-sync.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { SelectedManifestBoundSnapshotWalk } from '../src/sync/requester/manifest-bound-snapshot-walk.js';
import { SwmTargetExecutorV1, type PublicSwmTargetV1 } from '../src/sync/requester/swm-target-executor.js';
import { createSwmRecoveryMutationRuntimeV1 } from '../src/sync/requester/swm-recovery-apply.js';
import { makeEntitySharePublisherFixture } from './_helpers/swm-entity-share-publisher-fixture.js';
import { MemoryWorkspaceSnapshotStore } from './_helpers/memory-workspace-snapshot-store.js';

const CG = 'metadata-boundary-cg';
const ROOT = 'urn:metadata-boundary:root';
const baseTarget = {
  ctx: createOperationContext('sync'), remotePeerId: 'peer-source',
  contextGraphId: CG, remainingContextGraphs: 1,
};
const guard = () => ({ signal: new AbortController().signal, assertCurrent: () => {} });
const layouts: ReadonlyArray<{
  name: string; target: (session: SharedMemoryMetadataFetcher) => PublicSwmTargetV1;
}> = [
  { name: 'ordinary', target: session => ({ ...baseTarget, metadataFetcher: session, mode: { kind: 'ordinary' } }) },
  { name: 'selected current', target: session => ({ ...baseTarget, metadataFetcher: session, mode: { kind: 'selected-recovery', recoveryGuard: guard() } }) },
  { name: 'selected legacy', target: session => ({ ...baseTarget, mode: { kind: 'selected-recovery', recoveryGuard: guard(), metadataFetcher: session } }) },
  { name: 'selected identical dual', target: session => ({ ...baseTarget, metadataFetcher: session, mode: { kind: 'selected-recovery', recoveryGuard: guard(), metadataFetcher: session } }) },
];
function page(quads: Quad[]): SyncPageResult {
  return { quads, bytesReceived: 0, resumedFromOffset: 0, nextOffset: quads.length,
    checkpointKey: 'metadata-session', completed: true, timedOut: false };
}
class Session implements SharedMemoryMetadataFetcher {
  readonly calls: string[] = [];
  constructor(readonly metadata: Quad[]) {}
  async fetch() {
    this.calls.push('fetch');
    return { result: page(this.metadata), continuationYielded: false };
  }
  release() { this.calls.push('release'); }
  snapshotWalk(_contextGraphId: string, manifest: Parameters<NonNullable<SharedMemoryMetadataFetcher['snapshotWalk']>>[1]) {
    this.calls.push('walk');
    return new SelectedManifestBoundSnapshotWalk(manifest, { now: Date.now, retentionTtlMs: 60_000 });
  }
}

describe.each(['requester', 'executor'] as const)('%s metadata compatibility boundary', boundary => {
  it.each(layouts)('materializes publisher snapshots with $name on the original session receiver', async ({ target }) => {
    const fixture = await makeEntitySharePublisherFixture({
      contextGraphId: CG, shareOperationId: 'boundary-operation', rootEntities: [ROOT],
      payload: [{ subject: ROOT, predicate: 'urn:metadata-boundary:value', object: '"kept"', graph: '' }],
      publisherPeerId: 'peer-source',
    });
    const store = new OxigraphStore();
    const snapshots = new MemoryWorkspaceSnapshotStore();
    for (const [digest, quads] of fixture.snapshots) await snapshots.putSnapshot({ digest, quads });
    const session = new Session(fixture.meta);
    const input = target(session);
    const owned = new Map<string, string>();
    const fetchSyncPages = async (...args: Parameters<Parameters<typeof runSharedMemorySync>[0]['fetchSyncPages']>) => {
      if (args[4] === 'meta') throw new Error('Metadata strategy was bypassed');
      return page(args[4] === 'data'
        ? fixture.slices[0].payload.map(quad => ({ ...quad, graph: contextGraphSharedMemoryUri(CG) }))
        : []);
    };
    const worker = new SyncVerifyWorker();
    const processSharedMemoryBatch: Parameters<typeof runSharedMemorySync>[0]['processSharedMemoryBatch'] =
      (...args) => worker.processSharedMemoryBatch(...args);
    try {
      const result = boundary === 'requester'
        ? await runSharedMemorySync({
          ctx: input.ctx, remotePeerId: input.remotePeerId, contextGraphIds: [CG],
          mode: input.mode, metadataFetcher: input.metadataFetcher,
          createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER, fetchSyncPages,
          processSharedMemoryBatch, publicSnapshotStore: snapshots,
          ensureContextGraph: async () => {}, storeInsert: quads => store.insert(quads),
          ensureOwnedMap: () => owned, setCheckpoint: () => {}, deleteCheckpoint: () => {},
          logInfo: () => {}, logWarn: () => {}, logDebug: () => {},
        })
        : await new SwmTargetExecutorV1({
          store, writeLocks: new Map(), listSubGraphs: async () => [],
          createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER, fetchSyncPages,
          processSharedMemoryBatch, publicSnapshotStore: snapshots,
          recordDrops: () => {}, invalidateListContextGraphsCache: () => {},
          recoveryMutation: createSwmRecoveryMutationRuntimeV1({ store, recordDrops: () => {}, invalidateListContextGraphsCache: () => {} }),
          ensureOwnedMap: () => owned, setCheckpoint: () => {}, deleteCheckpoint: () => {}, deletePublicCheckpoint: () => {},
          retireFinalizedSwmTwin: async () => {}, logInfo: () => {}, logWarn: () => {}, logDebug: () => {},
        }).syncPublicTarget(input);
      expect(result.failedPeers).toBe(0);
      expect(result.failedPhases).toBe(0);
      expect(await store.countQuads(contextGraphSharedMemoryUri(CG))).toBe(1);
      expect(owned.get(ROOT)).toBe('peer-source');
      expect(session.calls).toEqual(['fetch', 'walk', 'release']);
    } finally {
      await worker.close();
      await store.close();
    }
  });
});
