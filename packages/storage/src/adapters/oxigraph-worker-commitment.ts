// SPDX-License-Identifier: Apache-2.0
import type { Worker } from 'node:worker_threads';
import { guardedTripleStorePersistenceBarrier, type TripleStoreCommitCapability,
  type TripleStoreCommitDurability, type TripleStorePersistenceBarrier } from '../persistence.js';

/** A replacement can flush successfully while lacking its predecessor's acknowledged writes. */
export function oxigraphWorkerCommitment(
  durability: TripleStoreCommitDurability,
  currentWorker: () => Worker | undefined,
  flush: TripleStorePersistenceBarrier,
): TripleStoreCommitCapability {
  const capture = () => {
    const owner = currentWorker();
    const assertOwner = () => {
      if (owner === undefined || currentWorker() !== owner) throw Object.assign(
        new Error('oxigraph-worker: persistence owner changed; reapply the mutation before certifying it'),
        { code: 'OXIGRAPH_WORKER_COMMIT_OWNER_CHANGED' },
      );
    };
    return guardedTripleStorePersistenceBarrier(async options => {
      assertOwner();
      await flush(options);
      assertOwner();
    });
  };
  return { durability, capture };
}
