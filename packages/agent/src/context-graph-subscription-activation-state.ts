// SPDX-License-Identifier: Apache-2.0
import type { AgentWorkLifetime } from './agent-work-lifetime.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord } from './dkg-agent-types.js';
import type { ContextGraphDormancyReason } from './context-graph-subscription-dormancy.js';
import { contextGraphSubscriptionAdmissionPremisesEqual, isContextGraphSubscriptionStoredAgain } from './context-graph-subscription-policy.js';

type Dormancy = ReadonlyMap<string, ContextGraphDormancyReason>;
const changed = () => new Error('Subscription activation ownership changed');
export function isCommittedSubscription(
  subscriptions: ReadonlyMap<string, ContextGraphSub>, dormancy: Dormancy, id: string,
): boolean {
  const row = subscriptions.get(id);
  return Boolean((row?.subscribed || row?.coreHosted) && !dormancy.has(id));
}

function sameIntent(left: ContextGraphSubscriptionRecord, right: ContextGraphSubscriptionRecord): boolean {
  return left.id === right.id && left.subscribed === right.subscribed
    && (left.coreHosted === true) === (right.coreHosted === true) && left.syncScoped === right.syncScoped;
}
function sameDurableIntent(left: ContextGraphSubscriptionRecord, right: ContextGraphSubscriptionRecord): boolean {
  return sameIntent(left, right) && left.onChainId === right.onChainId && left.onChainHash === right.onChainHash;
}
class Activation {
  readonly intent: ContextGraphSubscriptionRecord;
  repaired?: ContextGraphSubscriptionRecord;
  installed?: ContextGraphSub;
  ready?: ContextGraphSub;
  committed?: ContextGraphSub;
  settled = false;
  private readonly listeners = new Set<() => void>();
  constructor(intent: ContextGraphSubscriptionRecord) { this.intent = { ...intent }; }
  settle(): void {
    this.settled = true;
    for (const notify of this.listeners) notify();
    this.listeners.clear();
  }
  wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.listeners.delete(finish); signal.removeEventListener('abort', finish);
        if (signal.aborted) reject(changed()); else resolve();
      };
      if (this.settled || signal.aborted) { finish(); return; }
      this.listeners.add(finish); signal.addEventListener('abort', finish, { once: true });
    });
  }
}

/** Lifecycle-owned durable intent. Waiters never load or reinterpret the store.
 * Only the activation transaction can attach a repaired binding and live row. */
export class ContextGraphSubscriptionActivations {
  private readonly pending = new Map<string, Activation>();
  reset(rows: readonly ContextGraphSubscriptionRecord[]): void {
    for (const id of this.pending.keys()) this.cancel(id);
    for (const row of rows) this.observe(row);
  }
  observe(row: ContextGraphSubscriptionRecord): Activation {
    const current = this.pending.get(row.id);
    if (current && (sameDurableIntent(current.intent, row)
      || (current.repaired && sameDurableIntent(current.repaired, row)))) return current;
    this.cancel(row.id);
    const activation = new Activation(row);
    this.pending.set(row.id, activation);
    return activation;
  }
  get(id: string): Activation | undefined { return this.pending.get(id); }
  cancel(id: string): void {
    const activation = this.pending.get(id);
    this.pending.delete(id); activation?.settle();
  }
  reconcile(dormancy: Dormancy): void {
    // Capped intent is still queued for activation and may later need authority recovery.
    for (const id of this.pending.keys()) {
      const reason = dormancy.get(id);
      if (reason !== 'authorityUnavailable' && reason !== 'activationCap') this.cancel(id);
    }
  }
  install(activation: Activation, row: ContextGraphSub): void {
    if (this.pending.get(activation.intent.id) !== activation) throw changed();
    activation.installed = row;
    activation.ready = undefined;
  }
  stage(activation: Activation, row: ContextGraphSub): void {
    this.install(activation, row);
    activation.ready = row;
  }
  repaired(row: ContextGraphSubscriptionRecord, live: ContextGraphSub): void {
    const activation = this.pending.get(row.id);
    if (activation?.installed && sameIntent(activation.intent, row)
      && isContextGraphSubscriptionStoredAgain(activation.installed, live)) activation.repaired = { ...row };
  }
  complete(id: string, live: ContextGraphSub | undefined): void {
    const activation = this.pending.get(id);
    if (!activation) return;
    if (live && activation.ready && isContextGraphSubscriptionStoredAgain(activation.ready, live)
      && contextGraphSubscriptionAdmissionPremisesEqual(activation.ready, live)) activation.committed = live;
    this.cancel(id);
  }
}

/** Await the lifecycle's existing activation within the caller's original lifetime.
 * Denied, disabled and capped subscriptions retain their existing inactive behavior. */
export async function waitForSubscriptionActivation(
  workLifetime: AgentWorkLifetime, isStarted: () => boolean,
  subscriptions: ReadonlyMap<string, ContextGraphSub>, dormancy: Dormancy,
  id: string, caller: AbortSignal, activations: ContextGraphSubscriptionActivations,
): Promise<void> {
  if (dormancy.get(id) !== 'authorityUnavailable') return;
  const activation = activations.get(id), generation = workLifetime.generation;
  const signal = AbortSignal.any([caller, workLifetime.signal]);
  const assertCurrent = () => {
    if (signal.aborted || generation !== workLifetime.generation || !isStarted()) throw changed();
  };
  assertCurrent();
  if (!activation) throw changed();
  await workLifetime.track(activation.wait(signal));
  assertCurrent();
  const live = subscriptions.get(id);
  // Preserve the caller's inactive-subscription error after an explicit unsubscribe.
  if (live && !live.subscribed && !live.coreHosted && dormancy.get(id) !== 'authorityUnavailable') return;
  if (!activation.committed || !live || dormancy.has(id)
    || !isContextGraphSubscriptionStoredAgain(activation.committed, live)
    || !contextGraphSubscriptionAdmissionPremisesEqual(activation.committed, live)) throw changed();
}
