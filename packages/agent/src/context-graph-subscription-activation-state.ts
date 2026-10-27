// SPDX-License-Identifier: Apache-2.0
import type { AgentWorkLifetime } from './agent-work-lifetime.js';
import type { ContextGraphSub } from './dkg-agent-types.js';
import type { ContextGraphDormancyReason } from './context-graph-subscription-dormancy.js';
import { vmRecoveryRetryDelay } from './vm-recovery-pass-authority.js';

export function isCommittedSubscription(
  subscriptions: ReadonlyMap<string, ContextGraphSub>,
  dormancy: ReadonlyMap<string, ContextGraphDormancyReason>, id: string,
): boolean {
  const row = subscriptions.get(id);
  return Boolean((row?.subscribed || row?.coreHosted) && !dormancy.has(id));
}

/** Wait only for an authority-recovery activation already owned by the lifecycle.
 * Denied, disabled and capped subscriptions retain their existing inactive behavior.
 * The caller supplies its original deadline signal; no new deadline or RPC is added. */
export async function waitForSubscriptionActivation(
  workLifetime: AgentWorkLifetime, isStarted: () => boolean,
  dormancy: ReadonlyMap<string, ContextGraphDormancyReason>, id: string, caller: AbortSignal,
): Promise<void> {
  if (dormancy.get(id) !== 'authorityUnavailable') return;
  const generation = workLifetime.generation;
  const signal = AbortSignal.any([caller, workLifetime.signal]);
  const assertCurrent = () => {
    if (signal.aborted || generation !== workLifetime.generation || !isStarted())
      throw new Error('Subscription activation ownership changed');
  };
  assertCurrent();
  await workLifetime.track((async () => {
    while (dormancy.get(id) === 'authorityUnavailable') {
      assertCurrent();
      await vmRecoveryRetryDelay(2_500, signal);
    }
    assertCurrent();
  })());
}
