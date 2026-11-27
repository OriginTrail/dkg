// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphSubscriptionRehydrationInternalStatus } from './dkg-agent-types.js';
export interface SubscriptionAccountingFacts {
  readonly persisted: boolean;
  readonly active: boolean;
  readonly hosted: boolean;
}
export interface SubscriptionAccountingChange {
  readonly id: string;
  readonly before: SubscriptionAccountingFacts;
  readonly after: SubscriptionAccountingFacts;
}
/** Fold normalized lifecycle facts; the lifecycle owner already applied state and membership. */
export function accountSubscriptionChanges(
  status: ContextGraphSubscriptionRehydrationInternalStatus, changes: readonly SubscriptionAccountingChange[],
): ContextGraphSubscriptionRehydrationInternalStatus {
  let { persistedTotal, activated } = status;
  const hosted = new Set(status.hostedActivatedIds ?? []);
  for (const { id, before, after } of changes) {
    persistedTotal = Math.max(0, persistedTotal + Number(after.persisted) - Number(before.persisted));
    activated = Math.max(0, activated + Number(after.active) - Number(before.active));
    if (after.hosted) hosted.add(id); else hosted.delete(id);
  }
  return { ...status, persistedTotal, activated, hostedActivated: hosted.size,
    hostedActivatedIds: [...hosted].sort(), updatedAt: Date.now() };
}
