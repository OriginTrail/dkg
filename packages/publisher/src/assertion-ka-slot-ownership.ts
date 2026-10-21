// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, assertionLifecycleUri, contextGraphMetaUri, escapeSparqlLiteral, toAgentDid, isAllocatableKaAuthorV1 } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

/** Shared-store creation lock: two lifecycle names cannot claim one graph. */
export function assertionAllocationLockKey(contextGraphId: string, author: string, subGraphName?: string): string {
  return `assertion-allocation:${JSON.stringify([contextGraphId, subGraphName ?? '', author.toLowerCase()])}`;
}

/** Must run under the allocation lock, before changing either draft's metadata. */
export async function assertKaSlotOwnershipAvailable(
  store: TripleStore,
  contextGraphId: string,
  lifecycleOwner: string,
  name: string,
  number: bigint,
  subGraphName?: string,
  physicalAuthor = lifecycleOwner,
): Promise<void> {
  const lifecycle = assertSafeIri(assertionLifecycleUri(contextGraphId, lifecycleOwner, name, subGraphName));
  const authorDid = escapeSparqlLiteral(toAgentDid(physicalAuthor));
  // A peer may own the lifecycle name while a wallet owns the physical KA.
  // Graph identity uses wallet/number regardless of UAL network spelling;
  // The bound kaId supplies the number; the reserved UAL supplies its wallet.
  // Component matching preserves legacy address/number/whitespace aliases and
  // conservatively fences a competing reservation with contradictory numbers.
  const walletComponent = escapeSparqlLiteral(`/${physicalAuthor.toLowerCase()}/`);
  const walletIdentity = isAllocatableKaAuthorV1(physicalAuthor);
  const reservedIdentity = walletIdentity ? `BOUND(?reservedUal) && CONTAINS(LCASE(STR(?reservedUal)), "${walletComponent}")` : 'false';
  const legacyIdentity = `${walletIdentity ? '!BOUND(?reservedUal) && LCASE(STR(?author))' : 'STR(?author)'} = "${authorDid}"`;
  // Both current and older lifecycle metadata record these coordinates; a
  // lifecycle URI prefix cannot distinguish a root author from a subgraph.
  const subgraphScope = subGraphName
    ? `?owner <http://dkg.io/ontology/subGraphName> "${escapeSparqlLiteral(subGraphName)}" .`
    : 'FILTER NOT EXISTS { ?owner <http://dkg.io/ontology/subGraphName> ?subgraph }';
  const result = await store.query(`SELECT ?owner WHERE {
    GRAPH <${assertSafeIri(contextGraphMetaUri(contextGraphId))}> {
      VALUES ?number { "${number}"^^<http://www.w3.org/2001/XMLSchema#integer> "${number}" }
      ?owner <http://dkg.io/ontology/kaId> ?number .
      OPTIONAL { ?owner <http://dkg.io/ontology/reservedUal> ?reservedUal }
      OPTIONAL { ?owner <http://www.w3.org/ns/prov#wasAttributedTo> ?author }
      ${subgraphScope}
      FILTER(?owner != <${lifecycle}> && (
        (${reservedIdentity}) || (${legacyIdentity})
      ))
    }
  } LIMIT 1`);
  if (result.type !== 'bindings') {
    throw Object.assign(new Error('Cannot verify KA slot ownership'), { code: 'KA_SLOT_OWNERSHIP_UNAVAILABLE' });
  }
  if (result.bindings.length !== 0) {
    throw Object.assign(new Error('KA slot is already owned by another lifecycle'), { code: 'KA_SLOT_ALREADY_CLAIMED' });
  }
}
