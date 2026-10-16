import {
  assertionLifecycleUri, assertSafeIri, contextGraphMetaUri, MemoryLayer,
  createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, isTrustLevelQuad,
  GRAPH_KA_CONTENT_SCOPE_VERSION, type AssertionSeal, type GraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import type { PrivateContentStore, Quad, TripleStore } from '@origintrail-official/dkg-storage';
import type { AssertionPromoteResult } from './assertion-promote-types.js';
import { isReservedSubject } from './reserved-subjects.js';

interface CompletedLegacyHost {
  store: TripleStore;
  privateStore: PrivateContentStore;
  scopedQuads(graph: string): Promise<Quad[]>;
  hasMarker(): Promise<boolean>;
  hasTail(scope: GraphKnowledgeAssetScope, operationId: string): Promise<boolean>;
  validatePayload(publicQuads: Quad[], privateQuads: Quad[]): Promise<unknown>;
}

/** A completed pre-intent operation is readable, but can never authorize replay.
 * Called under the lifecycle lock. Every check is read-only, including refusal.
 */
export async function verifyCompletedLegacyPromote(
  host: CompletedLegacyHost, contextGraphId: string, name: string, author: string,
  seal: AssertionSeal, subGraphName?: string, operationId?: string,
): Promise<AssertionPromoteResult | null> {
  if (seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION || !seal.kaUal || !seal.assertionVersion) return null;
  const lifecycle = assertSafeIri(assertionLifecycleUri(contextGraphId, author, name, subGraphName));
  const graph = assertSafeIri(contextGraphMetaUri(contextGraphId));
  const layer = await host.store.query(`SELECT ?layer WHERE { GRAPH <${graph}> {
    <${lifecycle}> <http://dkg.io/ontology/memoryLayer> ?layer
  } } LIMIT 2`);
  if (layer.type !== 'bindings' || layer.bindings.length !== 1) return null;
  const isVm = layer.bindings[0]?.layer === JSON.stringify(MemoryLayer.VerifiableMemory);
  const isSwm = layer.bindings[0]?.layer === JSON.stringify(MemoryLayer.SharedWorkingMemory);
  if (!isVm && !isSwm) return null;
  const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
  if (isSwm) {
    const wm = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.WorkingMemory, scope, subGraphName);
    if (!operationId || (await host.scopedQuads(wm)).length || !await host.hasMarker()
      || !await host.hasTail(scope, operationId)) return null;
  }
  const source = knowledgeAssetLayerGraphUri(contextGraphId,
    isVm ? MemoryLayer.VerifiableMemory : MemoryLayer.SharedWorkingMemory, scope, subGraphName);
  const payload = (quads: Quad[]) => quads.filter(q => !isReservedSubject(q.subject) && !isTrustLevelQuad(q));
  await host.validatePayload(payload(await host.scopedQuads(source)),
    payload(await host.privateStore.getKnowledgeAssetPrivateTriples(contextGraphId, scope, subGraphName)));
  return { promotedCount: 0, promotedAllRoots: false, ...(isSwm ? { shareOperationId: operationId } : {}) };
}
