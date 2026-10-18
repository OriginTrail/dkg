import { Rfc64SwmAuthorInventoryProducerErrorV1 } from '../../rfc64/swm-author-inventory-producer-v1.js';
import { Rfc64ControlEnvelopeSigningErrorV1 } from '../../rfc64/control-envelope-signer-v1.js';
import { isTransientInventorySignerFailure } from './share-inventory-signing-capability.js';
import { createPromoteRetryableFailure, createPromotePostCommitFailure } from '@origintrail-official/dkg-publisher';
import { isInventoryPersistenceFailure } from '../../rfc64/inventory-persistence-failure.js';
import { SwmCatalogAuthorityNotReady, SwmInventoryWriteFailure } from '../swm-inventory-write.js';

/** Cause code of a committed share whose inventory handoff has not completed yet. */
export const SWM_INVENTORY_HANDOFF_PENDING_CODE = 'SWM_INVENTORY_HANDOFF_PENDING';

/** Closed set, so the daemon can name the waiting step without quoting a raw dependency error. */
type InventoryHandoffPendingReason =
  | 'inactive-lane' | 'authority-transition' | 'projection-admission' | 'confirmed-ownership';

/** The queue replays the same committed operation; the typed cause says which step it waits on. */
export function inventoryHandoffPendingFailure(reason: InventoryHandoffPendingReason, message: string): Error {
  return createPromoteRetryableFailure(Object.assign(new Error(message), { code: SWM_INVENTORY_HANDOFF_PENDING_CODE, reason }));
}

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
