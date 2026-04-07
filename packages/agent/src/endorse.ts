import { contextGraphDataUri, DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

/** Ontology predicate: agent endorses a Knowledge Asset */
export const DKG_ENDORSES = 'https://dkg.network/ontology#endorses';

/** Ontology predicate: timestamp of endorsement */
export const DKG_ENDORSED_AT = 'https://dkg.network/ontology#endorsedAt';

/**
 * Build endorsement triples for a Knowledge Asset.
 *
 * Endorsements are regular RDF triples published to the Context Graph's
 * data graph. They ride the next regular PUBLISH batch — no separate
 * chain transaction needed.
 */
export function buildEndorsementQuads(
  agentAddress: string,
  knowledgeAssetUal: string,
  contextGraphId: string,
): Quad[] {
  const agentUri = `did:dkg:agent:${agentAddress}`;
  const graph = contextGraphDataUri(contextGraphId);
  const now = new Date().toISOString();

  return [
    {
      subject: agentUri,
      predicate: DKG_ENDORSES,
      object: knowledgeAssetUal,
      graph,
    },
    {
      subject: agentUri,
      predicate: DKG_ENDORSED_AT,
      object: `"${now}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`,
      graph,
    },
  ];
}
