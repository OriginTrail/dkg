// SPDX-License-Identifier: Apache-2.0
import type { GraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import { tryReplaceGraphAndSubjectAtomically, type PrivateContentStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { replaceExactKnowledgeAssetGraph } from './knowledge-asset-graph-write.js';
import { convergeKnowledgeAssetMetadataRows } from './knowledge-asset-metadata-write.js';
import {
  replaceLocallyTrustedKnowledgeAssetControls,
  MATERIALIZED_VERSION_PRED,
  materializedVersionQuad,
  readMaterializedVersion,
  shouldApplyMaterialization,
  withMaterializationLock,
  writeMaterializedVersion,
  type MaterializedVersion,
} from './metadata.js';

/** Publish and update serialize every materialized slice under the same KA lock. */
export async function materializeConfirmedGraphPublish(input: Readonly<{
  store: TripleStore;
  privateStore: PrivateContentStore;
  scope: GraphKnowledgeAssetScope;
  contextGraphId: string;
  subGraphName?: string;
  metaGraph: string;
  vmGraph: string;
  vmQuads: readonly Quad[];
  privateQuads: readonly Quad[];
  confirmedQuads: Quad[];
  version: MaterializedVersion;
  persistCatalogEntry: () => Promise<void>;
}>): Promise<boolean> {
  return withMaterializationLock(input.metaGraph, input.scope.ual, async () => {
    if (!await shouldApplyMaterialization(input.store, input.metaGraph, input.scope.ual,
      input.version, BigInt(input.scope.assertionVersion))) return false;
    await replaceLocallyTrustedKnowledgeAssetControls(input.store, input.scope.ual, input.confirmedQuads);
    const previousVersion = await readMaterializedVersion(input.store, input.metaGraph, input.scope.ual);
    // Public data and its metadata commit together. Only the previous ordering
    // fence belongs in this payload: the new fence commits after every slice.
    const publicMetadata = input.confirmedQuads
      .filter(quad => quad.predicate !== MATERIALIZED_VERSION_PRED)
      .map(quad => ({ ...quad, graph: input.metaGraph }));
    if (previousVersion !== null) {
      publicMetadata.push(materializedVersionQuad(input.metaGraph, input.scope.ual, previousVersion));
    }
    if (!await tryReplaceGraphAndSubjectAtomically(input.store, input.vmGraph,
      input.vmQuads.map(quad => ({ ...quad, graph: input.vmGraph })),
      input.metaGraph, input.scope.ual, publicMetadata)) {
      await replacePublicSliceWithoutCompoundCapability(input.store, input.vmGraph,
        input.vmQuads, input.metaGraph, input.scope.ual, publicMetadata);
    }
    // GH #1078 — supersede/persist private slices only now that the chain
    // has confirmed (before returning 'confirmed', so no read sees the KA
    // confirmed without its private data).
    await input.privateStore.replaceKnowledgeAssetPrivateTriples(input.contextGraphId,
      input.scope, input.privateQuads, input.subGraphName);
    await input.persistCatalogEntry();
    await writeMaterializedVersion(input.store, input.metaGraph, input.scope.ual, input.version);
    return true;
  });
}

/** Compatibility path only for stores that cleanly refuse compound writes. */
async function replacePublicSliceWithoutCompoundCapability(
  store: TripleStore,
  vmGraph: string,
  vmQuads: readonly Quad[],
  metaGraph: string,
  ual: string,
  metadataQuads: readonly Quad[],
): Promise<void> {
  await replaceExactKnowledgeAssetGraph(store, vmGraph, vmQuads, 'Graph-scoped confirmed publish');
  await convergeKnowledgeAssetMetadataRows(store, metaGraph, ual, metadataQuads);
}
