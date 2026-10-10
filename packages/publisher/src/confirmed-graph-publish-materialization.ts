// SPDX-License-Identifier: Apache-2.0
import type { GraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import { tryReplaceGraphAndSubjectAtomically, type PrivateContentStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { replaceExactKnowledgeAssetGraph } from './knowledge-asset-graph-write.js';
import { convergeKnowledgeAssetMetadataRows, prepareKnowledgeAssetMaterializationMetadata } from './knowledge-asset-metadata-write.js';
import {
  replaceLocallyTrustedKnowledgeAssetControls,
  shouldApplyMaterialization,
  withMaterializationLock,
  writeMaterializedVersion,
  type MaterializedVersion,
} from './metadata.js';

export interface GraphMaterializationRows {
  readonly vmQuads: readonly Quad[];
  readonly privateQuads: readonly Quad[];
  readonly metadataQuads: readonly Quad[];
}
interface GraphMaterializationTarget {
  readonly store: TripleStore;
  readonly privateStore: PrivateContentStore;
  readonly scope: GraphKnowledgeAssetScope;
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly metaGraph: string;
  readonly vmGraph: string;
  /** Identity/access reads and metadata construction happen under this KA's lock. */
  readonly prepare: () => Promise<GraphMaterializationRows>;
}

/** One confirmed publish/update owner for admission, every slice, and the final fence. */
export async function materializeConfirmedGraphKnowledgeAsset(input: GraphMaterializationTarget & Readonly<{
  version: MaterializedVersion;
  persistCatalogEntry: () => Promise<void>;
}>): Promise<boolean> {
  return withMaterializationLock(input.metaGraph, input.scope.ual, async () => {
    if (!await shouldApplyMaterialization(input.store, input.metaGraph, input.scope.ual,
      input.version, BigInt(input.scope.assertionVersion))) return false;
    const rows = await input.prepare();
    const publicMetadata = await prepareKnowledgeAssetMaterializationMetadata(
      input.store, input.metaGraph, input.scope.ual, rows.metadataQuads);
    // GH #1078 — persist the private slice only now that the chain has confirmed,
    // and before the metadata that advertises it, so no read sees this assertion
    // confirmed without its private data. The slice graph is keyed by assertion
    // version: until that metadata commits, readers keep the previous assertion
    // and its own slice, and a retry rewrites this one.
    await input.privateStore.replaceKnowledgeAssetPrivateTriples(input.contextGraphId,
      input.scope, rows.privateQuads, input.subGraphName);
    await replaceLocallyTrustedKnowledgeAssetControls(input.store, input.scope.ual, rows.metadataQuads);
    if (!await tryReplaceGraphAndSubjectAtomically(input.store, input.vmGraph,
      rows.vmQuads.map(quad => ({ ...quad, graph: input.vmGraph })),
      input.metaGraph, input.scope.ual, publicMetadata)) {
      await replacePublicSliceWithoutCompoundCapability(input.store, input.vmGraph,
        rows.vmQuads, input.metaGraph, input.scope.ual, publicMetadata);
    }
    await input.persistCatalogEntry();
    await writeMaterializedVersion(input.store, input.metaGraph, input.scope.ual, input.version);
    return true;
  });
}

/** Tentative local updates have no chain admission, catalog commit, or new fence. */
export async function materializeTentativeGraphKnowledgeAsset(input: GraphMaterializationTarget): Promise<void> {
  await withMaterializationLock(input.metaGraph, input.scope.ual, async () => {
    const rows = await input.prepare();
    const metadata = await prepareKnowledgeAssetMaterializationMetadata(
      input.store, input.metaGraph, input.scope.ual, rows.metadataQuads);
    await replaceExactKnowledgeAssetGraph(input.store, input.vmGraph, rows.vmQuads, 'Graph-scoped tentative update');
    await input.privateStore.replaceKnowledgeAssetPrivateTriples(input.contextGraphId,
      input.scope, rows.privateQuads, input.subGraphName);
    await replaceLocallyTrustedKnowledgeAssetControls(input.store, input.scope.ual, rows.metadataQuads);
    await convergeKnowledgeAssetMetadataRows(input.store, input.metaGraph, input.scope.ual, metadata);
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
  await replaceExactKnowledgeAssetGraph(store, vmGraph, vmQuads, 'Graph-scoped confirmed materialization');
  await convergeKnowledgeAssetMetadataRows(store, metaGraph, ual, metadataQuads);
}
