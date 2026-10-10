// SPDX-License-Identifier: Apache-2.0
import { certifiedTripleStoreCommitment, type TripleStoreCommitCapability } from '../persistence.js';
import { certifiedWriteAcknowledgement } from './sparql-http-consistency.js';

export interface BlazegraphPersistenceOptions {
  /**
   * Defaults to `true`. Blazegraph runs each SPARQL UPDATE and N-Quads insert
   * request as its own journal commit and answers 200 only after that commit.
   * With the standard disk journal (`bufferMode=DiskRW`, the setting of the
   * pinned managed image, and `forceOnCommit` at its default `Force`) the commit
   * is forced to stable storage, so an acknowledged write survives a restart.
   *
   * Set `false` when the journal is not durable: `bufferMode` `MemStore` or
   * `Transient`, or `forceOnCommit=No`. The store then exposes no commitment,
   * and confirmed lifecycle repair stays pending with its journal retained.
   */
  writesDurableOnAcknowledgement?: boolean;
}

/** Every acknowledged mutation is already committed, so the barrier has no work of its own. */
export function blazegraphWriteCommitment(options: BlazegraphPersistenceOptions): TripleStoreCommitCapability | undefined {
  return certifiedWriteAcknowledgement(options, 'blazegraph', true)
    ? certifiedTripleStoreCommitment('restart-durable', async () => {}) : undefined;
}
