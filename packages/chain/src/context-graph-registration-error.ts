// SPDX-License-Identifier: Apache-2.0

import { isChainRpcTransportError } from './chain-rpc-transport-error.js';

const DEFINITIVE_CONTEXT_GRAPH_REGISTRATION_ERROR_CODES = new Set([
  'ACTION_REJECTED',
  'CALL_EXCEPTION',
  'INSUFFICIENT_FUNDS',
  'INVALID_ARGUMENT',
  'UNPREDICTABLE_GAS_LIMIT',
]);

export type ContextGraphRegistrationFailureDisposition =
  | 'definitive-failure'
  | 'outcome-ambiguous';

interface ContextGraphRegistrationFailureLike {
  code?: unknown;
  txHash?: unknown;
  receipt?: { status?: unknown };
  contextGraphRegistrationSubmitted?: unknown;
}

/**
 * Classify a failed Context Graph registration at the chain boundary.
 *
 * The agent owns the durable transition, but it must not interpret provider or
 * EVM error shapes. Only a chain-owned definitive verdict permits the durable
 * pending fence to return to `unregistered`.
 */
export function classifyContextGraphRegistrationFailure(
  error: unknown,
): ContextGraphRegistrationFailureDisposition {
  if (!error || typeof error !== 'object') return 'outcome-ambiguous';
  const record = error as ContextGraphRegistrationFailureLike;
  if (record.contextGraphRegistrationSubmitted === false) return 'definitive-failure';
  if (record.receipt?.status === 0) return 'definitive-failure';
  const code = typeof record.code === 'string' ? record.code : '';
  if (DEFINITIVE_CONTEXT_GRAPH_REGISTRATION_ERROR_CODES.has(code)) {
    return 'definitive-failure';
  }
  // A transport failure before the adapter has a signed/broadcast transaction
  // hash is pre-submission. Once a hash exists, or receipt lookup itself
  // failed, the registration outcome remains ambiguous.
  if (isChainRpcTransportError(error)) {
    return error.code !== 'RPC_RECEIPT_LOOKUP_FAILED'
      && typeof error.txHash !== 'string'
      ? 'definitive-failure'
      : 'outcome-ambiguous';
  }
  return 'outcome-ambiguous';
}

/** Mark a preparatory failure as occurring before registration submission. */
export function markContextGraphRegistrationNotSubmitted(error: unknown): Error {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (Object.isExtensible(failure)) {
    Object.defineProperty(failure, 'contextGraphRegistrationSubmitted', {
      configurable: true,
      enumerable: false,
      value: false,
    });
    return failure;
  }
  return Object.assign(
    new Error(failure.message, { cause: error }),
    { contextGraphRegistrationSubmitted: false as const },
  );
}
