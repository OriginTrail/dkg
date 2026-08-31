import { hasStoreOperationOutcome } from './store-operation-outcome.js';
import type { TripleStoreCapability } from './unsupported-capability-error.js';

export type AtomicReplaceCapability = Extract<
  TripleStoreCapability,
  'replaceGraph' | 'replaceGraphAndSubject' | 'replaceSubject' | 'replaceSubjectPrefix'
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
  return hasStoreOperationOutcome(error, capability, 'not_started');
}
