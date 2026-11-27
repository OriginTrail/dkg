// SPDX-License-Identifier: Apache-2.0
import { isBoundedOperationTimeoutError } from './bounded-operation.js';
import { contextGraphReadAuthorityDependencyOf, unavailableContextGraphReadAuthorityDecision,
  type ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';
import type { SubscriptionRetryLease } from './subscription-retry-executor.js';

/** Authority policy converts bounded transport failures to the canonical decision. */
export async function checkSubscriptionAuthority(
  lease: SubscriptionRetryLease,
  work: (signal: AbortSignal) => Promise<ContextGraphReadAuthorityDecision>,
): Promise<ContextGraphReadAuthorityDecision> {
  try { return await lease.check(work); }
  catch (error) {
    return unavailableContextGraphReadAuthorityDecision('legacy-local',
      isBoundedOperationTimeoutError(error) ? 'authority-check-timeout' : 'unexpected-authority-error',
      contextGraphReadAuthorityDependencyOf(error));
  }
}
