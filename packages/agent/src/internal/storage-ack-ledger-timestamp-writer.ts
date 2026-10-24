// SPDX-License-Identifier: Apache-2.0

import { assertSafeIri } from '@origintrail-official/dkg-core';
import { STORAGE_ACK_LEDGER_GRAPH, STORAGE_ACK_LEDGER_PREDICATES as LEDGER, storageAckLedgerMarkUpdate, xsdDateTimeLiteral } from '@origintrail-official/dkg-publisher';
import type { TripleStore, UpdateOptions } from '@origintrail-official/dkg-storage';
import type { ObservedStoreMutation } from './observed-store-mutation.js';

const TIMESTAMPS: ReadonlySet<string> = new Set([
  LEDGER.registeredAt, LEDGER.absentSeenAt, LEDGER.unregisteredAt, LEDGER.supersededAt,
  LEDGER.epoch, LEDGER.grandfatheredThrough, LEDGER.seenAt,
]);
export const isStorageAckLedgerTimestamp = (predicate: string): boolean => TIMESTAMPS.has(predicate);
export type StorageAckLedgerTimestampWriter = (
  subject: string, predicate: string, at: Date, options: UpdateOptions,
) => Promise<boolean>;

/** Exact timestamp operation; arbitrary predicates never acquire a narrow mutation descriptor. */
function planTimestamp(subject: string, predicate: string, at: Date) {
  assertSafeIri(subject);
  if (!isStorageAckLedgerTimestamp(predicate)) throw new TypeError('Unknown StorageACK ledger timestamp');
  const graph = STORAGE_ACK_LEDGER_GRAPH;
  const quad = { graph, subject, predicate, object: xsdDateTimeLiteral(at) };
  return { sparql: storageAckLedgerMarkUpdate(subject, predicate, at),
    mutation: { removals: [{ graph, subject, predicate }], quads: [quad] } };
}

/** Direct construction retains the provided store's ordinary observation policy. */
export const applyStorageAckLedgerTimestamp = (store: TripleStore): StorageAckLedgerTimestampWriter => (
  async (subject, predicate, at, options) => {
    if (typeof store.update !== 'function') return false;
    const plan = planTimestamp(subject, predicate, at);
    await store.update(plan.sparql, options);
    return true;
  }
);

/** Compose once over the configured decorated store, alongside the ordinary observed store. */
export function createStorageAckLedgerTimestampWriter(
  store: TripleStore, executeMutation: ObservedStoreMutation,
): StorageAckLedgerTimestampWriter {
  return async (subject, predicate, at, options) => {
    if (typeof store.update !== 'function') return false;
    const plan = planTimestamp(subject, predicate, at);
    await executeMutation(() => store.update!(plan.sparql, options), () => true, plan.mutation, 'update');
    return true;
  };
}

/** Initialization has already required update support and may not silently skip a mark. */
export async function requireStorageAckLedgerTimestamp(
  writer: StorageAckLedgerTimestampWriter, subject: string, predicate: string, at: Date, options: UpdateOptions,
): Promise<void> {
  if (!await writer(subject, predicate, at, options)) {
    throw new Error('StorageACK ledger initialization requires update support');
  }
}

/** Preserve the historical mark API: unknown predicates stay conservatively observed. */
export async function markStorageAckLedgerTimestamp(
  store: TripleStore, writer: StorageAckLedgerTimestampWriter,
  subject: string, predicate: string, at: number,
): Promise<void> {
  const options = { source: 'agent.storageAckLedger.mark', touchedGraphs: [STORAGE_ACK_LEDGER_GRAPH] };
  if (typeof store.update === 'function') {
    if (isStorageAckLedgerTimestamp(predicate)) {
      if (await writer(subject, predicate, new Date(at), options)) return;
    }
    await store.update(storageAckLedgerMarkUpdate(subject, predicate, new Date(at)), options);
    return;
  }
  await store.insert([{ subject, predicate, object: xsdDateTimeLiteral(new Date(at)),
    graph: STORAGE_ACK_LEDGER_GRAPH }], { source: 'agent.storageAckLedger.mark' });
}
