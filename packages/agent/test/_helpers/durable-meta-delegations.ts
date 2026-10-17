import {
  DKG_ONTOLOGY,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

/** Same positive and negative admission records for both real store backends. */
export function durableMetaDelegations(contextGraphId: string): {
  quads: Quad[];
  admittedSubjects: Set<string>;
  admittedRows: Quad[];
  metaGraph: string;
} {
  const entity = contextGraphDataGraphUri(contextGraphId);
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const foreignGraph = contextGraphMetaGraphUri(`${contextGraphId}-foreign`);
  const subject = (id: string) => `did:dkg:agent-delegation:${contextGraphId}:${id}`;
  const member = (predicate: string, object: string): Quad => ({
    graph: metaGraph, subject: entity, predicate, object: `"${object}"`,
  });
  const delegation = (id: string, agent: string, graph = metaGraph): Quad[] => [{
    graph, subject: id, predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT, object: `"${agent}"`,
  }, {
    graph, subject: id, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: `"peer-${agent}"`,
  }];
  const members = [
    member(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, '0xAcTiVe'),
    member(DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT, '0xPaRtIcIpAnT'),
    member(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, '0xReVoKeD'),
    member(DKG_ONTOLOGY.DKG_REVOKED_AGENT, '0xrevoked'),
    member(DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT, '0xReVoKeDpArTiCiPaNt'),
    member(DKG_ONTOLOGY.DKG_REVOKED_AGENT, '0xrevokedparticipant'),
  ];
  const admitted = [
    ...delegation(subject('active'), '0xactive'),
    ...delegation(subject('participant'), '0xparticipant'),
  ];
  return {
    metaGraph,
    admittedSubjects: new Set([subject('active'), subject('participant')]),
    admittedRows: [...members, ...admitted],
    quads: [
      ...members,
      ...admitted,
      ...delegation(subject('revoked'), '0xREVOKED'),
      ...delegation(subject('revoked-participant'), '0xREVOKEDPARTICIPANT'),
      ...delegation(subject('orphan'), '0xorphan'),
      ...delegation(`did:dkg:agent-delegation:${contextGraphId}-foreign:active`, '0xactive'),
      // A revocation in another graph cannot veto this graph's active member.
      { ...member(DKG_ONTOLOGY.DKG_REVOKED_AGENT, '0xactive'), graph: foreignGraph },
      // Nor can a foreign graph's member list authorize this graph's orphan.
      { ...member(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, '0xorphan'), graph: foreignGraph },
      ...delegation(subject('foreign-only'), '0xactive', foreignGraph),
    ],
  };
}
