// SPDX-License-Identifier: Apache-2.0

import { isChainRpcTransportError } from '@origintrail-official/dkg-chain';
import { isStoreOperationTimeoutError, isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import type {
  ContextGraphReadAuthorityDependency,
  RegisteredContextGraphAuthorityUnavailable,
  RegisteredContextGraphAuthorityUnavailableReason,
} from './registered-context-graph-authority.js';

export type { ContextGraphReadAuthorityDependency } from './registered-context-graph-authority.js';

/**
 * The dependency a caught authority-source error belongs to, read from the
 * stable codes of it and its `cause` chain: store deadlines, recovery and
 * admission shedding, or chain RPC transport failures.
 */
export function contextGraphReadAuthorityDependencyOf(error: unknown): ContextGraphReadAuthorityDependency {
  try {
    let current = error;
    for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
      if (isStoreOperationTimeoutError(current) || isStoreSchedulerBusyError(current)) return 'store';
      if (isChainRpcTransportError(current)) return 'chain';
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // A hostile error shape says nothing about its dependency.
  }
  return 'unknown';
}

/**
 * The dependency behind each typed unavailable reason. Only a local chain
 * binding lookup can fail on either the store or the chain, so its producers
 * record the classified dependency of their error; every other reason names
 * one fixed dependency.
 */
const REGISTERED_AUTHORITY_UNAVAILABLE_DEPENDENCY: Readonly<
  Record<RegisteredContextGraphAuthorityUnavailableReason, ContextGraphReadAuthorityDependency>
> = {
  'chain-access-policy-timeout': 'chain',
  'chain-access-policy-unknown': 'chain',
  'chain-access-policy-unavailable': 'chain',
  'chain-name-binding-unavailable': 'chain',
  'chain-participant-authority-unsupported': 'chain',
  'chain-participant-authority-unavailable': 'chain',
  'chain-participant-authority-invalid': 'chain',
  'finalized-name-absence-unaccepted': 'chain',
  'authority-circuit-open': 'chain',
  'local-existence-unavailable': 'store',
  'local-chain-binding-unavailable': 'local-state',
};

/** Which dependency an unavailable registered authority names: the one its producer classified, or its reason's. */
export function registeredContextGraphAuthorityUnavailableDependency(
  unavailable: RegisteredContextGraphAuthorityUnavailable,
): ContextGraphReadAuthorityDependency {
  return unavailable.dependency
    ?? REGISTERED_AUTHORITY_UNAVAILABLE_DEPENDENCY[unavailable.reason]
    ?? 'unknown';
}
