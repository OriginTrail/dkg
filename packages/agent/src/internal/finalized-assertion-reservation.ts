// SPDX-License-Identifier: Apache-2.0
import { GRAPH_KA_CONTENT_SCOPE_VERSION, LegacyKnowledgeAssetReadOnlyError,
  contextGraphAssertionUri, contextGraphMetaUri, createGraphKnowledgeAssetScope,
  parseAssertionSealQuads, type AssertionSeal } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

export interface FinalizedAssertionReservation {
  readonly seal: AssertionSeal & { publicTripleCount: number };
  readonly scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  readonly kaId: bigint;
  readonly assertionUri: string;
  readonly metaGraph: string;
}
export class FinalizedAssertionReservationError extends Error {}

/** One loader owns seal completeness, scope, author and reserved-id consistency. */
export async function readFinalizedAssertionReservation(store: TripleStore, target: {
  contextGraphId: string; name: string; agentAddress: string; subGraphName?: string;
}, source: string): Promise<FinalizedAssertionReservation> {
  const assertionUri = contextGraphAssertionUri(target.contextGraphId, target.agentAddress, target.name, target.subGraphName);
  const metaGraph = contextGraphMetaUri(target.contextGraphId);
  const meta = await store.query(
    `CONSTRUCT { <${assertionUri}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${assertionUri}> ?p ?o } }`, { source });
  const seal = parseAssertionSealQuads(meta.type === 'quads' ? meta.quads : [], assertionUri);
  if (!seal) throw new FinalizedAssertionReservationError(
    `publishFromFinalizedAssertion: assertion <${assertionUri}> is not finalized. Call /api/knowledge-assets/${target.name}/wm/finalize before publishing.`);
  if (seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) throw new LegacyKnowledgeAssetReadOnlyError();
  if (seal.kaUal === undefined || seal.assertionVersion === undefined || seal.publicTripleCount === undefined)
    throw new FinalizedAssertionReservationError(`Graph-scoped assertion seal for <${assertionUri}> is incomplete`);
  const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
  if (scope.agentAddress.toLowerCase() !== seal.authorAddress.toLowerCase())
    throw new FinalizedAssertionReservationError(`Graph-scoped seal author ${seal.authorAddress} does not match UAL author ${scope.agentAddress}`);
  const kaId = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
  if (seal.reservedKaId !== undefined && seal.reservedKaId !== kaId)
    throw new FinalizedAssertionReservationError(`Graph-scoped seal reservedKaId ${seal.reservedKaId} does not match UAL-derived kaId ${kaId}`);
  return { seal: { ...seal, publicTripleCount: seal.publicTripleCount }, scope, kaId, assertionUri, metaGraph };
}
