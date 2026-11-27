import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';

export type StagedKnowledgeAssetScope = ReturnType<typeof createGraphKnowledgeAssetScope>;

export interface StagedKnowledgeAssetTriple {
  subject: string;
  predicate: string;
  object: string;
}

/** The KA's own Shared Working Memory graph. */
export function knowledgeAssetSharedMemoryGraph(
  contextGraphId: string,
  scope: StagedKnowledgeAssetScope,
): string {
  return knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.SharedWorkingMemory, scope);
}

/** The KA's own Verified Memory graph: where a promotion of this KA must land. */
export function knowledgeAssetVerifiedMemoryGraph(
  contextGraphId: string,
  scope: StagedKnowledgeAssetScope,
): string {
  return knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory, scope);
}

/**
 * Stage one KA's shared-memory copy the way a node holds it: the content in
 * the KA's own graph, the share operation's record, and the workspace head.
 * Chain registration and the scenario's values stay with the calling suite.
 */
export async function stageKnowledgeAssetInSharedMemory(input: {
  store: TripleStore;
  contextGraphId: string;
  scope: StagedKnowledgeAssetScope;
  triples: readonly StagedKnowledgeAssetTriple[];
  shareOperationId: string;
  publisherPeerId?: string;
}): Promise<void> {
  const { store, contextGraphId, scope, shareOperationId } = input;
  const graph = knowledgeAssetSharedMemoryGraph(contextGraphId, scope);
  const quads = input.triples.map((triple) => ({ ...triple, graph }));
  const graphManager = new GraphManager(store);
  await store.insert(quads);
  await storeKnowledgeAssetOperationPublicQuads({
    store,
    graphManager,
    contextGraphId,
    shareOperationId,
    kaUal: scope.ual,
    assertionVersion: scope.assertionVersion,
    quads,
    privateTripleCount: 0,
    publisherPeerId: input.publisherPeerId ?? '12D3KooWStagedPublisher',
  });
  await storeKnowledgeAssetWorkspaceHead({
    store,
    graphManager,
    contextGraphId,
    shareOperationId,
    kaUal: scope.ual,
    assertionVersion: scope.assertionVersion,
  });
}

/** Whether a graph holds exactly this triple. */
export async function graphHoldsTriple(
  store: TripleStore,
  graph: string,
  triple: StagedKnowledgeAssetTriple,
): Promise<boolean> {
  const result = await store.query(
    `ASK { GRAPH <${graph}> { <${triple.subject}> <${triple.predicate}> ${triple.object} } }`,
  );
  return result.type === 'boolean' && result.value;
}
