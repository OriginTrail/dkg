// SPDX-License-Identifier: Apache-2.0

/**
 * The member list in a context graph's root `_meta`, and who a node takes it
 * from.
 *
 * A node takes a public graph's definition from any peer that holds it (the
 * RFC-64 metadata bootstrap, a Core's hosted copy): the definition is checked
 * against the policy the node accepted, and the chain-registration claims are
 * stripped. The member list is the curator's to state: the agents allowed to
 * write, the participants, the allowed peers, the revocations and the agents'
 * delegations. A node takes it only from the curator: through the join
 * approval, through the curator refresh, or from a node a share signed by the
 * owner's wallet ties to the graph. A snapshot served by any other peer adds
 * the definition only and leaves the member list the node holds as it is.
 */

import {
  assertSafeIri,
  contextGraphDataGraphUri,
  DKG_ONTOLOGY,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { stripLiteral } from './dkg-agent-utils.js';

/** The root `_meta` predicates of a graph's member list. */
export const MEMBER_LIST_ROOT_PREDICATES: readonly string[] = Object.freeze([
  DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
  DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT,
  DKG_ONTOLOGY.DKG_ALLOWED_PEER,
  DKG_ONTOLOGY.DKG_REVOKED_AGENT,
]);

/** The subject prefix of a graph's agent delegations. */
export function memberDelegationPrefix(contextGraphId: string): string {
  return `did:dkg:agent-delegation:${contextGraphId}:`;
}

/** Whether a row of the graph's root `_meta` belongs to its member list. */
export function isMemberListQuad(contextGraphId: string, quad: Quad): boolean {
  if (quad.subject.startsWith(memberDelegationPrefix(contextGraphId))) return true;
  return quad.subject === contextGraphDataGraphUri(contextGraphId)
    && MEMBER_LIST_ROOT_PREDICATES.includes(quad.predicate);
}

/** The snapshot without its member list: what a peer other than the curator contributes. */
export function withoutMemberList(contextGraphId: string, snapshot: readonly Quad[]): Quad[] {
  return snapshot.filter((quad) => !isMemberListQuad(contextGraphId, quad));
}

/** Whether the snapshot's root names `curatorAddress` (an EVM address) as its curator. */
export function snapshotNamesCurator(
  contextGraphId: string,
  snapshot: readonly Quad[],
  curatorAddress: string,
): boolean {
  const root = contextGraphDataGraphUri(contextGraphId);
  const expected = `did:dkg:agent:${curatorAddress.toLowerCase()}`;
  return snapshot.some((quad) => (
    quad.subject === root
    && quad.predicate === DKG_ONTOLOGY.DKG_CURATOR
    && stripLiteral(quad.object).trim().toLowerCase() === expected
  ));
}

/** The member-list rows of the graph's root this node holds, revocations aside (read separately). */
export async function readLocalMemberListRootRows(
  store: TripleStore,
  metaGraph: string,
  contextGraphUri: string,
): Promise<Quad[]> {
  const kept = MEMBER_LIST_ROOT_PREDICATES.filter((predicate) => predicate !== DKG_ONTOLOGY.DKG_REVOKED_AGENT);
  const result = await store.query(`
    SELECT ?p ?o WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        <${assertSafeIri(contextGraphUri)}> ?p ?o .
        VALUES ?p { ${kept.map((predicate) => `<${assertSafeIri(predicate)}>`).join(' ')} }
      }
    }
  `, { source: 'agent.metaRefresh.readLocalMemberList' });
  if (result.type !== 'bindings') throw new Error('Curator metadata replacement requires control-plane bindings');
  return result.bindings
    .filter((row) => typeof row['p'] === 'string' && typeof row['o'] === 'string')
    .map((row) => ({ subject: contextGraphUri, predicate: row['p']!, object: row['o']!, graph: metaGraph }));
}
