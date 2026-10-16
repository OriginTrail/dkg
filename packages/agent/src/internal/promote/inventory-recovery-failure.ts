import { createPromoteRetryableFailure, createPromotePostCommitFailure } from '@origintrail-official/dkg-publisher';
import { isInventoryPersistenceFailure } from '../../rfc64/inventory-persistence-failure.js';
import { SwmCatalogAuthorityNotReady, SwmInventoryWriteFailure } from '../swm-inventory-write.js';

/** Replay policy consumes persistence provenance; integrity and producer refusals pass through. */
export async function throwInventoryRecoveryFailure(error: unknown): Promise<never> {
  const cause = error instanceof SwmInventoryWriteFailure ? error.cause : error;
  if (cause instanceof SwmCatalogAuthorityNotReady) throw createPromoteRetryableFailure(cause);
  if (isInventoryPersistenceFailure(cause)) throw createPromotePostCommitFailure(cause);
  throw cause;
}
