import {
  assertionLifecycleUri, assertSafeIri, contextGraphMetaUri, MemoryLayer,
  createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, isTrustLevelQuad,
  GRAPH_KA_CONTENT_SCOPE_VERSION, type AssertionSeal, type GraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import type { PrivateContentStore, Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { isReservedSubject } from './reserved-subjects.js';

interface CompletedLegacyHost {
  store: TripleStore;
  privateStore: PrivateContentStore;
  scopedQuads(graph: string): Promise<Quad[]>;
  hasMarker(): Promise<boolean>;
  hasTail(scope: GraphKnowledgeAssetScope): Promise<boolean>;
  validatePayload(publicQuads: Quad[], privateQuads: Quad[]): Promise<unknown>;
}

/** A completed pre-intent operation is readable, but can never authorize replay.
 * Called under the lifecycle lock. Every check is read-only, including refusal.
 */
export async function verifyCompletedLegacyPromote(
  host: CompletedLegacyHost, contextGraphId: string, name: string, author: string,
  seal: AssertionSeal, subGraphName?: string,
): Promise<boolean> {
  if (seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION || !seal.kaUal || !seal.assertionVersion) return false;
  const lifecycle = assertSafeIri(assertionLifecycleUri(contextGraphId, author, name, subGraphName));
  const graph = assertSafeIri(contextGraphMetaUri(contextGraphId));
  const layer = await host.store.query(`SELECT ?layer WHERE { GRAPH <${graph}> {
    <${lifecycle}> <http://dkg.io/ontology/memoryLayer> ?layer
  } } LIMIT 2`);
  if (layer.type !== 'bindings' || layer.bindings.length !== 1
    || layer.bindings[0]?.layer !== JSON.stringify(MemoryLayer.SharedWorkingMemory)) return false;
  const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
  const wm = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.WorkingMemory, scope, subGraphName);
  if ((await host.scopedQuads(wm)).length || !await host.hasMarker() || !await host.hasTail(scope)) return false;
  const swm = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.SharedWorkingMemory, scope, subGraphName);
  const payload = (quads: Quad[]) => quads.filter(q => !isReservedSubject(q.subject) && !isTrustLevelQuad(q));
  await host.validatePayload(payload(await host.scopedQuads(swm)),
    payload(await host.privateStore.getKnowledgeAssetPrivateTriples(contextGraphId, scope, subGraphName)));
  return true;
}
