import { StoreSchedulerBusyError } from './store-priority-scheduler.js';
import {
  UnsupportedTripleStoreCapabilityError,
  type TripleStoreCapability,
} from './unsupported-capability-error.js';

export type AtomicReplaceCapability = Extract<
  TripleStoreCapability,
  'replaceGraph' | 'replaceGraphAndSubject' | 'replaceSubject'
>;

/**
 * True only when the storage contract proves an atomic replace body never ran.
 * Every other rejection is indeterminate: it may have committed before its
 * response was lost and therefore requires cache/log reconciliation.
 */
export function isAtomicReplaceOperationNotStarted(
  error: unknown,
  capability: AtomicReplaceCapability,
): boolean {
  return error instanceof StoreSchedulerBusyError || (
    error instanceof UnsupportedTripleStoreCapabilityError
    && error.capability === capability
  );
}
