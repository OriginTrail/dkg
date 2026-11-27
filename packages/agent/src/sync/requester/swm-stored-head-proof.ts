/**
 * A stored SWM head newer than the descriptor a peer serves answers two
 * separate questions, and this module keeps them apart:
 *
 *   - may catch-up overwrite the KA with the peer's older snapshot? Never:
 *     `storedVersionOutranksDescriptor` keeps the stored head, and fails safe
 *     when the ordering cannot be read;
 *   - does this node hold what the peer served? Only when the newer head's own
 *     committed content is in the store: `newerStoredHeadIsMaterialized`.
 *
 * Keeping a head proves nothing about the content behind it. Metadata alone, a
 * head no reader can resolve, or other bytes under it leave the asset missing
 * here, so a catch-up must not count it as already held (#3296).
 */
import { assertSafeIri } from '@origintrail-official/dkg-core';
import {
  isKnowledgeAssetWorkspaceHeadCorruptError,
  resolveKnowledgeAssetWorkspaceHead,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';
import type { GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';

/**
 * True when the locally stored head version outranks the descriptor we are
 * about to materialize. BigInt-compared when both parse; anything unparseable
 * is treated as OUTRANKING — failing safe means never destroying local state
 * whose ordering we cannot establish.
 */
export function storedVersionOutranksDescriptor(stored: string, descriptorVersion: string): boolean {
  try {
    return BigInt(stored) > BigInt(descriptorVersion);
  } catch {
    return true;
  }
}

/**
 * True only when the KA's stored head resolves as every reader resolves it, at
 * a version newer than the descriptor's, and its assertion graph holds exactly
 * the content that head commits to: the same quad count and public-quads
 * digest. The descriptor's own commitment cannot vouch for another version's
 * bytes, and an unparseable or ambiguous head does not resolve at all.
 */
export async function newerStoredHeadIsMaterialized(
  store: TripleStore,
  contextGraphId: string,
  descriptor: GraphScopedSwmRecoveryDescriptor,
): Promise<boolean> {
  let head: Awaited<ReturnType<typeof resolveKnowledgeAssetWorkspaceHead>>;
  try {
    head = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager: new GraphManager(store),
      contextGraphId,
      kaUal: descriptor.kaUal,
      subGraphName: descriptor.subGraphName,
      queryOptions: { priority: 'background', source: 'agent.sharedMemorySync.storedHeadProof.resolveHead' },
    });
  } catch (error) {
    // A corrupt head proves nothing. A failed read is not an answer: it
    // propagates, and the round records a materialization failure.
    if (isKnowledgeAssetWorkspaceHeadCorruptError(error)) return false;
    throw error;
  }
  if (head === undefined || BigInt(head.assertionVersion) <= BigInt(descriptor.assertionVersion)) {
    return false;
  }
  // Bounded by one KA's graph: the same read `isGraphAssetMaterialized` makes.
  const content = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertSafeIri(head.assertionGraph)}> { ?s ?p ?o } }`,
    { priority: 'background', source: 'agent.sharedMemorySync.storedHeadProof.readGraph' },
  );
  if (content.type !== 'quads' || content.quads.length !== head.publicTripleCount) return false;
  const digest = workspacePublicQuadsDigest(content.quads.map((quad) => ({ ...quad, graph: '' })));
  return digest === head.publicQuadsDigest.toLowerCase();
}
