// SPDX-License-Identifier: Apache-2.0
import type { SubscriptionDormancyTransition } from './context-graph-subscription-activation-state.js';
import type { ContextGraphSubscriptionRehydrationInternalStatus } from './dkg-agent-types.js';

export type SubscriptionAccountingChange = Readonly<{
  dormancy: SubscriptionDormancyTransition;
} & ({ kind: 'saved'; persisted: boolean; active: boolean; hosted: boolean }
  | { kind: 'cleared' | 'deactivated' })>;

/** Account for explicit lifecycle facts, independent of the mutable dormancy map. */
export function accountSubscriptionChanges(
  status: ContextGraphSubscriptionRehydrationInternalStatus, accounted: Set<string>,
  changes: readonly SubscriptionAccountingChange[],
): ContextGraphSubscriptionRehydrationInternalStatus {
  let { persistedTotal, activated } = status;
  const hosted = new Set(status.hostedActivatedIds ?? []);
  for (const change of changes) {
    const { id, before, after } = change.dormancy;
    const wasPersisted = accounted.has(id);
    const wasActive = wasPersisted && before === undefined;
    const isPersisted = change.kind === 'saved' ? change.persisted : change.kind === 'deactivated' && wasPersisted;
    const isActive = isPersisted && change.kind === 'saved' && change.active && after === undefined;
    persistedTotal = Math.max(0, persistedTotal + Number(isPersisted) - Number(wasPersisted));
    activated = Math.max(0, activated + Number(isActive) - Number(wasActive));
    if (isPersisted) accounted.add(id); else accounted.delete(id);
    if (isActive && change.kind === 'saved' && change.hosted) hosted.add(id); else hosted.delete(id);
  }
  return { ...status, persistedTotal, activated, hostedActivated: hosted.size,
    hostedActivatedIds: [...hosted].sort(), updatedAt: Date.now() };
}
