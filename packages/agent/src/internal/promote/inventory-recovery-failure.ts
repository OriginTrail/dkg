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
const INVENTORY_HANDOFF_PENDING_REASONS: ReadonlySet<string> = new Set<InventoryHandoffPendingReason>(
  ['inactive-lane', 'authority-transition', 'projection-admission', 'confirmed-ownership']);

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

/** Failures of the confirmed VM ownership step: they keep the recovery answer whatever their cause. */
const CONFIRMED_OWNERSHIP_FAILURES = new WeakSet<object>();

/** As throwInventoryRecoveryFailure, for the confirmed VM ownership step. */
export async function throwConfirmedOwnershipFailure(error: unknown): Promise<never> {
  try { return await throwInventoryRecoveryFailure(error); } catch (failure) {
    if (typeof failure === 'object' && failure !== null) CONFIRMED_OWNERSHIP_FAILURES.add(failure);
    throw failure;
  }
}

/** The queue's retryable marker, read by its code as the publisher's own guard does. */
function retryableFailure(error: unknown): error is Error {
  return error instanceof Error && Reflect.get(error, 'code') === 'PROMOTE_RETRYABLE_FAILURE';
}

/** The typed waiting step of a retryable handoff failure; anything else has none. */
export function inventoryHandoffPendingReason(error: unknown): InventoryHandoffPendingReason | undefined {
  if (!retryableFailure(error)) return undefined;
  const cause: unknown = error.cause;
  if (!(cause instanceof Error) || Reflect.get(cause, 'code') !== SWM_INVENTORY_HANDOFF_PENDING_CODE) return undefined;
  const reason: unknown = Reflect.get(cause, 'reason');
  return typeof reason === 'string' && INVENTORY_HANDOFF_PENDING_REASONS.has(reason)
    ? reason as InventoryHandoffPendingReason : undefined;
}

/**
 * Closed reasons a committed share may be answered as shared while its durable
 * job still owes the catalog handoff: the authoring lane or authority changed
 * after admission. Confirmed VM ownership (any failure of that step) and signer
 * failures are not among them.
 */
export type CommittedShareCatalogHandoffReason =
  | 'inactive-lane' | 'authority-transition' | 'projection-admission' | 'authority-not-ready';

export interface CommittedSharePendingCatalogHandoff {
  readonly reason: CommittedShareCatalogHandoffReason;
  readonly result: Readonly<{ promotedCount: number; sealed: true; publishReady: true; shareOperationId: string }>;
}

const COMMITTED_SHARE_PENDING_CATALOG_HANDOFF = Symbol.for('dkg.agent.committedSharePendingCatalogHandoff.v1');

export function committedSharePendingReason(error: unknown): CommittedShareCatalogHandoffReason | undefined {
  if (typeof error === 'object' && error !== null && CONFIRMED_OWNERSHIP_FAILURES.has(error)) return undefined;
  const reason = inventoryHandoffPendingReason(error);
  if (reason === 'inactive-lane' || reason === 'authority-transition' || reason === 'projection-admission') return reason;
  return reason === undefined && retryableFailure(error) && error.cause instanceof SwmCatalogAuthorityNotReady
    ? 'authority-not-ready' : undefined;
}

/**
 * Record the committed share on the failure that keeps its durable obligation.
 * The failure's identity, code, cause, message and serialized form are unchanged.
 */
export function attachCommittedShare<E>(error: E, result: CommittedSharePendingCatalogHandoff['result']): E {
  const reason = committedSharePendingReason(error);
  if (reason === undefined || !Object.isExtensible(error)
    || Object.getOwnPropertyDescriptor(error, COMMITTED_SHARE_PENDING_CATALOG_HANDOFF)) return error;
  Object.defineProperty(error, COMMITTED_SHARE_PENDING_CATALOG_HANDOFF, {
    value: Object.freeze({ reason, result: Object.freeze({ ...result }) }),
  });
  return error;
}

/** The committed share carried by a pending handoff failure whose typed cause still matches it. */
export function committedSharePendingCatalogHandoff(error: unknown): CommittedSharePendingCatalogHandoff | undefined {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return undefined;
  const value: unknown = Object.getOwnPropertyDescriptor(error, COMMITTED_SHARE_PENDING_CATALOG_HANDOFF)?.value;
  if (typeof value !== 'object' || value === null) return undefined;
  const { reason, result } = value as Partial<CommittedSharePendingCatalogHandoff>;
  return reason !== undefined && reason === committedSharePendingReason(error)
    && typeof result?.shareOperationId === 'string' && typeof result.promotedCount === 'number'
    ? value as CommittedSharePendingCatalogHandoff : undefined;
}
