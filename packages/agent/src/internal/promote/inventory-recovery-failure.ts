import { Rfc64SwmAuthorInventoryProducerErrorV1 } from '../../rfc64/swm-author-inventory-producer-v1.js';
import { Rfc64ControlEnvelopeSigningErrorV1 } from '../../rfc64/control-envelope-signer-v1.js';
import { isTransientInventorySignerFailure } from './share-inventory-signing-capability.js';
import { createPromoteRetryableFailure, createPromotePostCommitFailure } from '@origintrail-official/dkg-publisher';
import { isInventoryPersistenceFailure } from '../../rfc64/inventory-persistence-failure.js';
import { SwmCatalogAuthorityNotReady, SwmInventoryWriteFailure } from '../swm-inventory-write.js';

/** Replay policy consumes persistence provenance; integrity and producer refusals pass through. */
export async function throwInventoryRecoveryFailure(error: unknown): Promise<never> {
  const cause = error instanceof SwmInventoryWriteFailure ? error.cause : error;
  if (cause instanceof SwmCatalogAuthorityNotReady) throw createPromoteRetryableFailure(cause);
  if (cause instanceof Rfc64SwmAuthorInventoryProducerErrorV1
    && cause.code === 'swm-inventory-producer-signer'
    && cause.cause instanceof Rfc64ControlEnvelopeSigningErrorV1
    && cause.cause.phase === 'callback' && isTransientInventorySignerFailure(cause.cause.cause)) {
    throw createPromoteRetryableFailure(cause);
  }
  if (isInventoryPersistenceFailure(cause)) throw createPromotePostCommitFailure(cause);
  throw cause;
}
