import {
  assertionLifecycleUri, assertSafeIri, contextGraphMetaUri, MemoryLayer,
  createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, isTrustLevelQuad,
  GRAPH_KA_CONTENT_SCOPE_VERSION, type AssertionSeal, type GraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import type { PrivateContentStore, Quad, TripleStore } from '@origintrail-official/dkg-storage';
import type { AssertionPromoteResult } from './assertion-promote-types.js';
import { isReservedSubject } from './reserved-subjects.js';
import { readConfirmedGraphKnowledgeAssetMetadataEnvelope } from './metadata.js';
import { validateGraphScopedPayloadAgainstSeal } from './assertion-seal-recovery.js';

const payload = (quads: Quad[]) => quads.filter(q => !isReservedSubject(q.subject) && !isTrustLevelQuad(q));

interface CompletedLegacyHost {
  store: TripleStore;
  privateStore: PrivateContentStore;
  scopedQuads(graph: string): Promise<Quad[]>;
  cleanupVm(wmGraph: string): Promise<void>;
  hasMarker(): Promise<boolean>;
  hasTail(scope: GraphKnowledgeAssetScope, operationId: string): Promise<boolean>;
  validatePayload(publicQuads: Quad[], privateQuads: Quad[]): Promise<unknown>;
}

/** A completed pre-intent operation is readable, but can never authorize replay.
 * Called under the lifecycle lock. Exact VM validation precedes stale WM cleanup.
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
  await host.validatePayload(payload(await host.scopedQuads(source)),
    payload(await host.privateStore.getKnowledgeAssetPrivateTriples(contextGraphId, scope, subGraphName)));
  if (isVm) await host.cleanupVm(knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.WorkingMemory, scope, subGraphName));
  return { promotedCount: 0, promotedAllRoots: false, ...(isSwm ? { shareOperationId: operationId } : {}) };
}

/**
 * Whether a confirmed update superseded the admitted version in the same per-asset
 * VM graph: a confirmed envelope of a strictly newer version owns that graph, and the
 * resident payload with that version's private triples proves its roots and counts.
 * Read-only. Validation failures prove nothing; store failures propagate.
 */
export async function confirmedVmSupersedesSeal(
  host: Pick<CompletedLegacyHost, 'store' | 'privateStore' | 'scopedQuads'>,
  contextGraphId: string, seal: AssertionSeal, subGraphName?: string,
): Promise<boolean> {
  if (seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION || !seal.kaUal || !seal.assertionVersion) return false;
  const read = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(host.store, { contextGraphId, ual: seal.kaUal });
  if (read.state !== 'confirmed') return false;
  const { envelope } = read;
  const vmGraph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion), subGraphName);
  if ((envelope.subGraphName ?? null) !== (subGraphName ?? null) || envelope.assertionGraph !== vmGraph
    || BigInt(envelope.assertionVersion) <= BigInt(seal.assertionVersion)) return false;
  const newer = createGraphKnowledgeAssetScope(seal.kaUal, envelope.assertionVersion);
  const publicQuads = payload(await host.scopedQuads(vmGraph));
  const privateQuads = payload(await host.privateStore.getKnowledgeAssetPrivateTriples(contextGraphId, newer, subGraphName));
  const confirmed: AssertionSeal = { ...seal, assertionVersion: envelope.assertionVersion, merkleRoot: envelope.merkleRoot,
    publicTripleCount: envelope.publicTripleCount, privateTripleCount: envelope.privateTripleCount,
    privateMerkleRoot: envelope.privateMerkleRoot };
  try { await validateGraphScopedPayloadAgainstSeal(confirmed, publicQuads, privateQuads, 'superseding-memory'); }
  catch { return false; }
  return true;
}
