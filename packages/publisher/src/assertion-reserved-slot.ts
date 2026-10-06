// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, assertionLifecycleUri, contextGraphMetaUri, MAX_ROOTLESS_KA_NUMBER_V1 } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { TripleStore } from '@origintrail-official/dkg-storage';

/** The author is already bound by the lifecycle coordinate; validate its slot. */
export function assertExpectedKaSlotMatchesAllocation(expected: bigint | undefined, actual: bigint | undefined): void {
  if (expected !== undefined && (typeof expected !== 'bigint' || expected < 0n || expected > MAX_ROOTLESS_KA_NUMBER_V1 || expected !== actual)) {
    throw Object.assign(new Error('Requested KA reservation does not match the lifecycle slot'), { code: 'KA_RESERVED_ID_MISMATCH' });
  }
}

/** Called under the lifecycle write lock before reopening or returning a seal. */
export async function assertExpectedKaSlotMatchesLifecycle(
  store: TripleStore, contextGraphId: string, author: string, name: string,
  expected: bigint | undefined, subGraphName?: string,
): Promise<void> {
  if (expected === undefined) return;
  assertExpectedKaSlotMatchesAllocation(expected, expected);
  const lifecycle = assertSafeIri(assertionLifecycleUri(contextGraphId, author, name, subGraphName));
  const result = await store.query(`SELECT DISTINCT ?number WHERE {
    GRAPH <${assertSafeIri(contextGraphMetaUri(contextGraphId))}> {
      <${lifecycle}> ?p ?o .
      OPTIONAL { <${lifecycle}> <http://dkg.io/ontology/kaId> ?number }
    }
  } LIMIT 2`);
  // No lifecycle is a fresh create. An existing row with no single valid
  // identity is corruption, not permission to silently replace the slot.
  if (result.type === 'bindings' && result.bindings.length === 0) return;
  const raw = result.type === 'bindings' && result.bindings.length === 1 ? result.bindings[0]?.number : undefined;
  const literal = raw === undefined ? null : parseRdfLiteralTerm(raw);
  const number = literal?.value ?? raw;
  if (number === undefined || number !== number.trim() || !/^(0|[1-9][0-9]*)$/.test(number)
    || (literal?.kind === 'language')
    || (literal?.kind === 'typed' && literal.datatype !== 'http://www.w3.org/2001/XMLSchema#integer')) {
    throw Object.assign(new Error('Cannot verify the existing lifecycle KA reservation'), { code: 'KA_WM_LIFECYCLE_CORRUPT' });
  }
  assertExpectedKaSlotMatchesAllocation(expected, BigInt(number));
}
