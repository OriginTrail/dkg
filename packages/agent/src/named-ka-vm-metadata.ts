// SPDX-License-Identifier: Apache-2.0

import { assertSafeIri } from '@origintrail-official/dkg-core';
import { withKeyedLocks } from '@origintrail-official/dkg-publisher';
import {
  tryReplaceSubjectAtomically, UnsupportedTripleStoreCapabilityError,
  type Quad, type TripleStore,
} from '@origintrail-official/dkg-storage';

const locksByStore = new WeakMap<TripleStore, Map<string, Promise<void>>>();
const SUBJECT_ROW_LIMIT = 128;

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
 * Replace only the supplied predicates while preserving the complete bounded
 * subject. The caller holds both draft and metadata ownership for the read and
 * commit. A certified atomic replacement preserves the old or complete new
 * subject on failure; generic update support cannot provide that certificate.
 */
export async function replaceNamedKaVmDraftSubject(
  store: TripleStore, graph: string, subject: string, replacements: Quad[],
): Promise<void> {
  if (typeof store.replaceSubject !== 'function') {
    throw new UnsupportedTripleStoreCapabilityError('replaceSubject', 'Named KA VM transition');
  }
  const result = await store.query(`CONSTRUCT { <${assertSafeIri(subject)}> ?p ?o }
    WHERE { GRAPH <${assertSafeIri(graph)}> { <${assertSafeIri(subject)}> ?p ?o } }
    LIMIT ${SUBJECT_ROW_LIMIT + 1}`, { source: 'agent.publish.namedKaVmTransition' });
  if (result.type !== 'quads' || result.quads.length > SUBJECT_ROW_LIMIT) {
    throw new Error('Cannot repair named KA VM transition: complete metadata subject unavailable');
  }
  const predicates = new Set(replacements.map(quad => quad.predicate));
  const preserved = result.quads.filter(quad => !predicates.has(quad.predicate)).map(quad => ({ ...quad, graph }));
  if (!await tryReplaceSubjectAtomically(store, graph, subject, [...preserved, ...replacements], {
    source: 'agent.publish.namedKaVmTransition',
  })) {
    throw new UnsupportedTripleStoreCapabilityError('replaceSubject', 'Named KA VM transition');
  }
}
