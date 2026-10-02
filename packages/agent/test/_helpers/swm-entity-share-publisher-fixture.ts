/**
 * Publisher-owned entity-share fixture for SWM descriptor and manifest tests.
 * Every returned slice points to the exact snapshot captured at the real
 * publisher boundary, so callers cannot reconstruct merely equivalent blobs
 * beside the behavior they are meant to exercise.
 */
import {
  decodeEntityShareMetadata,
  workspaceOperationPublicSliceSubject,
} from '@origintrail-official/dkg-publisher';
import { storeWorkspaceOperationPublicQuads } from
  '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { MemoryWorkspaceSnapshotStore } from './memory-workspace-snapshot-store.js';

export interface EntitySharePublisherSlice {
  readonly rootEntity: string;
  readonly sliceSubject: string;
  readonly digest: string;
  readonly payload: Quad[];
}

export interface EntitySharePublisherFixture {
  readonly metaGraph: string;
  readonly meta: Quad[];
  readonly snapshots: ReadonlyMap<string, Quad[]>;
  readonly slices: readonly EntitySharePublisherSlice[];
}

/** Entity-share manifest and snapshots generated through the publisher boundary. */
export async function makeEntitySharePublisherFixture(options: {
  readonly contextGraphId: string;
  readonly shareOperationId: string;
  readonly rootEntities: readonly string[];
  readonly payload: readonly Quad[];
  readonly publisherPeerId: string;
  readonly subGraphName?: string;
}): Promise<EntitySharePublisherFixture> {
  const store = new OxigraphStore();
  const graphManager = new GraphManager(store);
  const snapshots = new MemoryWorkspaceSnapshotStore();
  try {
    await storeWorkspaceOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: options.contextGraphId,
      shareOperationId: options.shareOperationId,
      rootEntities: options.rootEntities,
      quads: options.payload,
      publisherPeerId: options.publisherPeerId,
      timestamp: new Date(0),
      subGraphName: options.subGraphName,
      publicSnapshotStore: snapshots,
    });
    const metaGraph = graphManager.sharedMemoryMetaUri(options.contextGraphId, options.subGraphName);
    const result = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`,
    );
    if (result.type !== 'quads') throw new Error('Entity-share fixture metadata query did not return quads');
    const sliceSubjects = options.rootEntities.map(rootEntity => workspaceOperationPublicSliceSubject(
      options.contextGraphId,
      options.shareOperationId,
      rootEntity,
      options.subGraphName,
    ));
    const meta = result.quads.map(quad => ({ ...quad, graph: metaGraph }));
    const decodedSlices = decodeEntityShareMetadata(options.contextGraphId, meta)
      .filter(record => record.kind === 'slice');
    const slices = options.rootEntities.map((rootEntity, index): EntitySharePublisherSlice => {
      const descriptor = decodedSlices.find(record =>
        record.rootEntity === rootEntity && record.subject === sliceSubjects[index]);
      if (!descriptor) throw new Error(`Entity-share fixture did not publish root ${rootEntity}`);
      const payload = snapshots.snapshots.get(descriptor.ref);
      if (!payload) throw new Error(`Entity-share fixture did not capture snapshot ${descriptor.ref}`);
      return { rootEntity, sliceSubject: descriptor.subject, digest: descriptor.ref, payload };
    });
    return {
      metaGraph,
      meta,
      snapshots: snapshots.snapshots,
      slices,
    };
  } finally {
    await store.close().catch(() => {});
  }
}
