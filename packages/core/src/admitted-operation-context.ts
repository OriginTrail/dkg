import type { OperationContext } from './logger.js';

declare const admittedOperationContextBrand: unique symbol;

/**
 * One operation and cancellation signal paired at an admission boundary.
 * Downstream packages can consume the pair but cannot construct or re-pair it
 * structurally; the owner that admits the work must use the factory below.
 */
export interface AdmittedOperationContext {
  readonly operation: Readonly<OperationContext>;
  readonly signal: AbortSignal;
  readonly [admittedOperationContextBrand]: true;
}

/** Establishes immutable operation attribution for one admitted signal owner. */
export function createAdmittedOperationContext(
  operation: OperationContext,
  signal: AbortSignal,
): AdmittedOperationContext {
  signal.throwIfAborted();
  return Object.freeze({
    operation: Object.freeze({ ...operation }),
    signal,
  }) as AdmittedOperationContext;
}
