// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, assertionLifecycleUri, contextGraphMetaUri, escapeSparqlLiteral } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ASSERTION_RESERVATION_PREDICATES as P, decodeAssertionLifecycleRecord } from './assertion-lifecycle-record.js';
import { assertionPhysicalIdentityKey, decodeAssertionReservationIdentity, resolveStoredAssertionLifecycleOwner,
  type AssertionPhysicalIdentity } from './assertion-reservation.js';
import { withKeyedLocks } from './keyed-lock.js';
import { writeLocksForStore } from './store-write-locks.js';

export interface AssertionAllocationCoordinates {
  readonly contextGraphId: string;
  readonly lifecycleOwner: string;
  readonly name: string;
  readonly subGraphName?: string;
}

/** Shared-store creation lock: two lifecycle names cannot claim one graph. */
function assertionAllocationLockKey(contextGraphId: string, author: string, subGraphName?: string): string {
  return `assertion-allocation:${JSON.stringify([contextGraphId, subGraphName ?? '', author.toLowerCase()])}`;
}

/** One captured physical identity owns both the lock and the ownership fence. */
export function withAssertionAllocation<T>(store: TripleStore, coordinates: AssertionAllocationCoordinates,
  physicalIdentity: AssertionPhysicalIdentity, mutate: () => Promise<T>,
): Promise<T> {
  const target = { ...coordinates }, identity = { ...physicalIdentity };
  return withKeyedLocks(writeLocksForStore(store),
    [assertionAllocationLockKey(target.contextGraphId, identity.agentAddress, target.subGraphName)], async () => {
      await assertKaSlotOwnershipAvailable(store, target, identity);
      return mutate();
    });
}

/** Must run under the physical allocation lock, before changing either draft. */
export async function assertKaSlotOwnershipAvailable(
  store: TripleStore, coordinates: AssertionAllocationCoordinates, physicalIdentity: AssertionPhysicalIdentity,
): Promise<void> {
  const { contextGraphId, lifecycleOwner, name, subGraphName } = coordinates;
  const { number } = physicalIdentity;
  const unavailable = (reason = 'Cannot verify KA slot ownership') => Object.assign(new Error(reason), { code: 'KA_SLOT_OWNERSHIP_UNAVAILABLE' });
  const lifecycle = assertSafeIri(assertionLifecycleUri(contextGraphId, lifecycleOwner, name, subGraphName));
  const subgraphScope = subGraphName
    ? `?owner <${P.subGraphName}> "${escapeSparqlLiteral(subGraphName)}" .`
    : `FILTER NOT EXISTS { ?owner <${P.subGraphName}> ?subgraph }`;
  // sparql-scan-allow: R4 -- candidates are indexed by one exact KA number and subgraph, with a fixed reservation predicate set; this is not a graph census.
  const result = await store.query(`SELECT ?owner ?p ?o WHERE {
    GRAPH <${assertSafeIri(contextGraphMetaUri(contextGraphId))}> {
      VALUES ?number { "${number}"^^<http://www.w3.org/2001/XMLSchema#integer> "${number}" }
      ?owner <${P.number}> ?number .
      ${subgraphScope}
      FILTER(?owner != <${lifecycle}>)
      ?owner ?p ?o .
      VALUES ?p { ${Object.values(P).map(predicate => `<${predicate}>`).join(' ')} }
    }
  }`, { source: 'publisher.assertion.slotOwnership' });
  if (result.type !== 'bindings') throw unavailable();
  const candidates = new Map<string, Map<string, { p: string; o: string }>>();
  for (const row of result.bindings) {
    if (typeof row.owner !== 'string' || typeof row.p !== 'string' || typeof row.o !== 'string'
      || !Object.values(P).some(predicate => predicate === row.p)) throw unavailable();
    const rows = candidates.get(row.owner) ?? new Map<string, { p: string; o: string }>();
    rows.set(JSON.stringify([row.p, row.o]), { p: row.p, o: row.o }); candidates.set(row.owner, rows);
  }
  const expected = assertionPhysicalIdentityKey(physicalIdentity);
  for (const [subject, rows] of candidates) {
    const record = decodeAssertionLifecycleRecord([...rows.values()]);
    const owner = resolveStoredAssertionLifecycleOwner(record, {
      contextGraphId, lifecycleUri: subject, subGraphName,
    });
    const identity = decodeAssertionReservationIdentity(record, owner);
    if (identity.kind === 'conflict') throw unavailable(identity.reason);
    if (identity.kind === 'unallocated') throw unavailable();
    if (assertionPhysicalIdentityKey(identity.identity) === expected) {
      throw Object.assign(new Error('KA slot is already owned by another lifecycle'), { code: 'KA_SLOT_ALREADY_CLAIMED' });
    }
  }
}
