// SPDX-License-Identifier: Apache-2.0
import type { AgentWorkLifetime } from './agent-work-lifetime.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord, ContextGraphSubscriptionStore } from './dkg-agent-types.js';
import type { ContextGraphDormancyReason } from './context-graph-subscription-dormancy.js';
import { isContextGraphSubscriptionStoredAgain } from './context-graph-subscription-policy.js';
import { vmRecoveryRetryDelay } from './vm-recovery-pass-authority.js';

export function isCommittedSubscription(
  subscriptions: ReadonlyMap<string, ContextGraphSub>,
  dormancy: ReadonlyMap<string, ContextGraphDormancyReason>, id: string,
): boolean {
  const row = subscriptions.get(id);
  return Boolean((row?.subscribed || row?.coreHosted) && !dormancy.has(id));
}

type Dormancy = ReadonlyMap<string, ContextGraphDormancyReason>;
interface UnboundActivationWait {
  id: string;
  cancelled: boolean;
  intent?: ContextGraphSubscriptionRecord;
  activationIntent?: ContextGraphSubscriptionRecord;
  activated?: ContextGraphSub;
}
// Only physical waits are retained. Durable intent exists before a canonical
// live identity can be projected, and internal activation may heal its binding.
const unboundWaits = new WeakMap<Dormancy, Set<UnboundActivationWait>>();

export function cancelUnboundSubscriptionActivation(dormancy: Dormancy, id: string): void {
  for (const wait of unboundWaits.get(dormancy) ?? []) {
    // Once committed, ordinary readiness writes are allowed; live lineage
    // fences deletion/recreation from then on.
    if (wait.id === id && !wait.activated) wait.cancelled = true;
  }
}

export function recordPersistedSubscriptionActivation(
  dormancy: Dormancy, intent: ContextGraphSubscriptionRecord, activated: ContextGraphSub,
): void {
  for (const wait of unboundWaits.get(dormancy) ?? []) {
    if (wait.id !== intent.id || wait.activated) continue;
    wait.activationIntent = { ...intent };
    wait.activated = activated;
  }
}

function sameDurableIntent(left: ContextGraphSubscriptionRecord, right: ContextGraphSubscriptionRecord): boolean {
  return left.id === right.id && left.subscribed === right.subscribed
    && (left.coreHosted === true) === (right.coreHosted === true)
    && left.syncScoped === right.syncScoped
    && left.onChainId === right.onChainId && left.onChainHash === right.onChainHash;
}

/** Wait only for an authority-recovery activation already owned by the lifecycle.
 * Denied, disabled and capped subscriptions retain their existing inactive behavior.
 * The caller supplies its original deadline signal; no new deadline or RPC is added. */
export async function waitForSubscriptionActivation(
  workLifetime: AgentWorkLifetime, isStarted: () => boolean,
  subscriptions: ReadonlyMap<string, ContextGraphSub>,
  dormancy: Dormancy, id: string, caller: AbortSignal,
  store?: ContextGraphSubscriptionStore,
): Promise<void> {
  if (dormancy.get(id) !== 'authorityUnavailable') return;
  const subscription = subscriptions.get(id);
  const cold: UnboundActivationWait | undefined = subscription === undefined ? { id, cancelled: false } : undefined;
  const generation = workLifetime.generation;
  const signal = AbortSignal.any([caller, workLifetime.signal]);
  const changed = () => new Error('Subscription activation ownership changed');
  const assertCurrent = () => {
    if (signal.aborted || generation !== workLifetime.generation || !isStarted() || cold?.cancelled) throw changed();
    if (cold?.intent && cold.activationIntent && !sameDurableIntent(cold.intent, cold.activationIntent)) throw changed();
    const owner = subscription ?? cold?.activated;
    if (owner && !isContextGraphSubscriptionStoredAgain(owner, subscriptions.get(id))) throw changed();
  };
  if (cold) {
    const waits = unboundWaits.get(dormancy) ?? new Set<UnboundActivationWait>();
    waits.add(cold); unboundWaits.set(dormancy, waits);
  }
  try {
    assertCurrent();
    await workLifetime.track((async () => {
      if (cold) {
        const intent = store?.load ? await store.load(id) : (await store?.loadAll())?.find(row => row.id === id);
        assertCurrent();
        if (!intent || (!intent.subscribed && !intent.coreHosted)) throw changed();
        cold.intent = { ...intent };
      }
      while (dormancy.get(id) === 'authorityUnavailable') {
        assertCurrent();
        await vmRecoveryRetryDelay(2_500, signal);
      }
      assertCurrent();
      if (cold && !cold.activated) throw changed();
    })());
  } finally {
    if (cold) {
      const waits = unboundWaits.get(dormancy);
      waits?.delete(cold);
      if (waits?.size === 0) unboundWaits.delete(dormancy);
    }
  }
}
