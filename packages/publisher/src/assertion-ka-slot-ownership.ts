// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, assertionLifecycleUri, contextGraphMetaUri, escapeSparqlLiteral, toAgentDid } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

/** Shared-store creation lock: two lifecycle names cannot claim one graph. */
export function assertionAllocationLockKey(contextGraphId: string, author: string, subGraphName?: string): string {
  return `assertion-allocation:${JSON.stringify([contextGraphId, subGraphName ?? '', author.toLowerCase()])}`;
}

/** Must run under the allocation lock, before changing either draft's metadata. */
export async function assertKaSlotOwnershipAvailable(
  store: TripleStore,
  contextGraphId: string,
  author: string,
  name: string,
  number: bigint,
  subGraphName?: string,
): Promise<void> {
  const lifecycle = assertSafeIri(assertionLifecycleUri(contextGraphId, author, name, subGraphName));
  const authorDid = escapeSparqlLiteral(toAgentDid(author).toLowerCase());
  // Both current and older lifecycle metadata record these coordinates; a
  // lifecycle URI prefix cannot distinguish a root author from a subgraph.
  const subgraphScope = subGraphName
    ? `?owner <http://dkg.io/ontology/subGraphName> "${escapeSparqlLiteral(subGraphName)}" .`
    : 'FILTER NOT EXISTS { ?owner <http://dkg.io/ontology/subGraphName> ?subgraph }';
  const result = await store.query(`SELECT ?owner WHERE {
    GRAPH <${assertSafeIri(contextGraphMetaUri(contextGraphId))}> {
      VALUES ?number { "${number}"^^<http://www.w3.org/2001/XMLSchema#integer> "${number}" }
      ?owner <http://dkg.io/ontology/kaId> ?number ;
             <http://www.w3.org/ns/prov#wasAttributedTo> ?author .
      ${subgraphScope}
      FILTER(LCASE(STR(?author)) = "${authorDid}" && ?owner != <${lifecycle}>)
    }
  } LIMIT 1`);
  if (result.type !== 'bindings') {
    throw Object.assign(new Error('Cannot verify KA slot ownership'), { code: 'KA_SLOT_OWNERSHIP_UNAVAILABLE' });
  }
  if (result.bindings.length !== 0) {
    throw Object.assign(new Error('KA slot is already owned by another lifecycle'), { code: 'KA_SLOT_ALREADY_CLAIMED' });
  }
}
