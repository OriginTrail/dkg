// SPDX-License-Identifier: Apache-2.0
import { certifiedTripleStoreCommitment, type TripleStoreCommitCapability } from '../persistence.js';
import { certifiedWriteAcknowledgement } from './sparql-http-consistency.js';
import type { AdmittedReadDeadline } from '../admitted-read-cancellation.js';
import { drainResponseBody } from '../http-response-limit.js';

/** The servlet closes the response only after its commit group is stable.
 * Drain without retaining progress output, under the mutation's original deadline. */
export async function completeBlazegraphWriteResponse(response: Response, deadline: AdmittedReadDeadline): Promise<void> {
  await drainResponseBody(response, deadline.waitFor);
}

export interface BlazegraphPersistenceOptions {
  /**
   * Defaults to `true`. Blazegraph runs each SPARQL UPDATE and N-Quads insert
   * request as its own journal commit and completes the response after that commit.
   * Successful headers alone do not acknowledge the commit.
   * With the standard disk journal (`bufferMode=DiskRW`, the setting of the
   * pinned managed image, and `forceOnCommit` at its default `ForceMetadata`) the commit
   * is forced to stable storage, so an acknowledged write survives a restart.
   * Progress-monitor URLs are not certified: their HTTP 200 can report failure.
   *
   * Set `false` when the journal is not durable: `bufferMode` `MemStore` or
   * `Transient`, or `forceOnCommit=No`. The store then exposes no commitment,
   * and confirmed lifecycle repair stays pending with its journal retained.
   */
  writesDurableOnAcknowledgement?: boolean;
}

/** Every acknowledged mutation is already committed, so the barrier has no work of its own. */
export function blazegraphWriteCommitment(options: BlazegraphPersistenceOptions, endpoint?: string): TripleStoreCommitCapability | undefined {
  const certified = certifiedWriteAcknowledgement(options, 'blazegraph', true);
  if (endpoint !== undefined) {
    try {
      // Monitoring deliberately reports even failed UPDATEs with HTTP 200.
      // Only an explicitly disabled monitor preserves the normal status contract.
      if (new URL(endpoint).searchParams.getAll('monitor').some(value => value.toLowerCase() !== 'false')) return undefined;
    } catch { return undefined; }
  }
  return certified
    ? certifiedTripleStoreCommitment('restart-durable', async () => {}) : undefined;
}
