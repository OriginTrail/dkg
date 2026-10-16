import { createPromoteRetryableFailure, runPromoteCommittedFinalization } from '@origintrail-official/dkg-publisher';
import { Rfc64SwmAuthorInventoryProducerErrorV1 } from '../../rfc64/swm-author-inventory-producer-v1.js';
import { InventoryV1CandidateError } from '../../rfc64/inventory-v1/index.js';
import { SwmCatalogAuthorityNotReady, SwmInventoryWriteFailure } from '../swm-inventory-write.js';

/** Keep integrity refusal distinct from the replay-safe inventory persistence boundary. */
export async function throwInventoryRecoveryFailure(error: unknown): Promise<never> {
  const cause = error instanceof SwmInventoryWriteFailure ? error.cause : error;
  if (cause instanceof SwmCatalogAuthorityNotReady) throw createPromoteRetryableFailure(cause);
  if (cause instanceof Rfc64SwmAuthorInventoryProducerErrorV1 && cause.code !== 'swm-inventory-producer-conflict') throw cause;
  if (cause instanceof InventoryV1CandidateError && !['swm-inventory-cas-conflict', 'candidate-database-error', 'latency-budget-exceeded'].includes(cause.code)) throw cause;
  if (error instanceof SwmInventoryWriteFailure && error.phase === 'inventory-commit') {
    await runPromoteCommittedFinalization(async () => { throw cause; });
  }
  throw cause;
}
