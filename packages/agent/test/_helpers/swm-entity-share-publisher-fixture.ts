/**
 * Publisher-owned entity-share fixture for SWM descriptor and manifest tests.
 * The returned digest and payload are the exact snapshot captured at the real
 * publisher boundary, so the fixture cannot reconstruct a merely equivalent
 * blob beside the behavior it is meant to exercise.
 */
import { workspaceOperationPublicSliceSubject } from '@origintrail-official/dkg-publisher';
import { storeWorkspaceOperationPublicQuads } from
  '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { MemorySnapshotStore, type SwmSyncHarnessShare } from './swm-sync-harness.js';

/** Entity-share manifest and sole snapshot generated through the publisher boundary. */
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
    const capturedSnapshots = [...snapshots.snapshots.entries()];
    if (capturedSnapshots.length !== 1) {
      throw new Error(`Entity-share fixture expected one published snapshot, got ${capturedSnapshots.length}`);
    }
    const [digest, payload] = capturedSnapshots[0]!;
    const metaGraph = graphManager.sharedMemoryMetaUri(options.contextGraphId);
    const result = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`,
    );
    if (result.type !== 'quads') throw new Error('Entity-share fixture metadata query did not return quads');
    return {
      digest,
      payload,
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
