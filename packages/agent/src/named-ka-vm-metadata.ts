// SPDX-License-Identifier: Apache-2.0

import { withKeyedLocks } from '@origintrail-official/dkg-publisher';
import {
  tryReplaceSubjectPredicatesAtomically, UnsupportedTripleStoreCapabilityError,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

const locksByStore = new WeakMap<TripleStore, Map<string, Promise<void>>>();

/** Exercise the certified method through decorators before any irreversible submission. */
export async function requireNamedKaVmCompletionCapability(store: TripleStore, graph: string): Promise<void> {
  if (!await tryReplaceSubjectPredicatesAtomically(store, graph,
    'urn:dkg:named-ka-vm-completion:capability-probe', ['urn:dkg:named-ka-vm-completion:probe'], [], {
      source: 'agent.publish.namedKaVmCapabilityPreflight',
    })) {
    throw new UnsupportedTripleStoreCapabilityError('replaceSubjectPredicates', 'Named KA VM publication');
  }
}

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
