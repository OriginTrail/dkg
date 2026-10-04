// SPDX-License-Identifier: Apache-2.0

import { withKeyedLocks } from '@origintrail-official/dkg-publisher';
import {
  tryReplaceSubjectPredicatesAtomically, UnsupportedTripleStoreCapabilityError,
  type Quad, type TripleStore,
} from '@origintrail-official/dkg-storage';

const locksByStore = new WeakMap<TripleStore, Map<string, Promise<void>>>();

/**
 * Serialize permanent bookkeeping and draft read/replace without holding a
 * curator/network lock. Callers acquire the draft lifecycle lock first when
 * needed; this short metadata lock never acquires or re-enters that lock.
 */
export function withNamedKaVmMetadataLock<T>(
  store: TripleStore, graph: string, lifecycle: string, work: () => Promise<T>,
): Promise<T> {
  let locks = locksByStore.get(store);
  if (!locks) { locks = new Map(); locksByStore.set(store, locks); }
  return withKeyedLocks(locks, [JSON.stringify([graph, lifecycle])], work);
}

/**
 * Replace only the supplied predicates in one certified backend transaction.
 * Historical links and concurrent unrelated receipts stay untouched without a
 * subject snapshot. The caller still holds draft/metadata ownership; generic
 * update support cannot provide this atomic certificate.
 */
export async function replaceNamedKaVmDraftSubject(
  store: TripleStore, graph: string, subject: string, replacements: Quad[],
): Promise<void> {
  if (!await tryReplaceSubjectPredicatesAtomically(store, graph, subject,
    [...new Set(replacements.map(quad => quad.predicate))], replacements, {
      source: 'agent.publish.namedKaVmTransition',
    })) {
    throw new UnsupportedTripleStoreCapabilityError('replaceSubjectPredicates', 'Named KA VM transition');
  }
}
