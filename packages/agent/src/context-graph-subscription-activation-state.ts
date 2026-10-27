// SPDX-License-Identifier: Apache-2.0
import type { AgentWorkLifetime } from './agent-work-lifetime.js';
import { accountSubscriptionChanges } from './context-graph-subscription-accounting.js';
import { rehydratedSubscriptionReachedSafeState } from './context-graph-subscription-authority-recovery.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord, ContextGraphSubscriptionRehydrationInternalStatus } from './dkg-agent-types.js';
import type { ContextGraphDormancyReason } from './context-graph-subscription-dormancy.js';
import { contextGraphSubscriptionAdmissionPremisesEqual, isContextGraphSubscriptionStoredAgain } from './context-graph-subscription-policy.js';

type Dormancy = ReadonlyMap<string, ContextGraphDormancyReason>;
export type SubscriptionDormancyTransition = Readonly<{
  id: string;
  before: ContextGraphDormancyReason | undefined;
  after: ContextGraphDormancyReason | undefined;
}>;
function applyDormancy(dormancy: Map<string, ContextGraphDormancyReason>, id: string, after: ContextGraphDormancyReason | undefined): SubscriptionDormancyTransition {
  const transition = Object.freeze({ id, before: dormancy.get(id), after });
  if (after === undefined) dormancy.delete(id); else dormancy.set(id, after);
  return transition;
}
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
const activationHandleBrand: unique symbol = Symbol('subscription-activation');
type ActivationHandle = Readonly<{ id: string; [activationHandleBrand]: true }>;
type ActivationOutcome = { kind: 'committed'; subscription: ContextGraphSub } | { kind: 'cancelled' };
type ActivationPhase = { kind: 'queued' } | { kind: 'installing'; subscription: ContextGraphSub }
  | { kind: 'settled'; outcome: ActivationOutcome };
interface ActivationAttempt {
  readonly handle: ActivationHandle;
  readonly intent: ContextGraphSubscriptionRecord;
  repaired?: ContextGraphSubscriptionRecord;
  phase: ActivationPhase;
  readonly listeners: Set<() => void>;
}

export interface SubscriptionActivationPorts {
  readonly subscribedContextGraphs: ReadonlyMap<string, ContextGraphSub>;
  readonly contextGraphSubscriptionDormancyById: Map<string, ContextGraphDormancyReason>;
  readonly contextGraphSubscriptionRehydrationPendingIds: Set<string>;
  readonly contextGraphSubscriptionRehydrationSlotIds: Set<string>;
  readonly contextGraphSubscriptionRehydrationAccountedIds: Set<string>;
  getStatus(): ContextGraphSubscriptionRehydrationInternalStatus | null;
  setStatus(status: ContextGraphSubscriptionRehydrationInternalStatus): void;
  publish(id: string): void;
}

/** Owns activation attempts and their outcomes. External handles carry identity only;
 * waiters never load or reinterpret durable intent or mutate attempt phases. */
export class ContextGraphSubscriptionActivations {
  constructor(private readonly ports: SubscriptionActivationPorts) {}
  private readonly pending = new Map<string, ActivationAttempt>();
  reset(rows: readonly ContextGraphSubscriptionRecord[], dormancy: Map<string, ContextGraphDormancyReason>): void {
    for (const id of this.pending.keys()) this.cancel(id);
    dormancy.clear();
    for (const row of rows) this.observe(row);
  }
  observe(row: ContextGraphSubscriptionRecord): ActivationHandle {
    const current = this.pending.get(row.id);
    if (current && (sameDurableIntent(current.intent, row)
      || (current.repaired && sameDurableIntent(current.repaired, row)))) return current.handle;
    this.cancel(row.id);
    const handle: ActivationHandle = Object.freeze({ id: row.id, [activationHandleBrand]: true as const });
    this.pending.set(row.id, { handle, intent: { ...row }, phase: { kind: 'queued' }, listeners: new Set() });
    return handle;
  }
  get(id: string): ActivationHandle | undefined { return this.pending.get(id)?.handle; }
  private settle(attempt: ActivationAttempt, outcome: ActivationOutcome): void {
    if (attempt.phase.kind === 'settled') return;
    this.pending.delete(attempt.handle.id);
    attempt.phase = { kind: 'settled', outcome };
    for (const notify of attempt.listeners) notify();
    attempt.listeners.clear();
  }
  cancel(id: string): void {
    const attempt = this.pending.get(id);
    if (attempt) this.settle(attempt, { kind: 'cancelled' });
  }
  /** One explicit transition updates both dormancy and pending ownership. */
  transition(dormancy: Map<string, ContextGraphDormancyReason>, id: string, reason: ContextGraphDormancyReason | undefined, account: (transition: SubscriptionDormancyTransition) => void = () => {}): void {
    this.transitionBatch(dormancy, [[id, reason]], transitions => account(transitions[0]));
  }
  /** Apply the entire change and its accounting before notifying any waiters. */
  transitionBatch(dormancy: Map<string, ContextGraphDormancyReason>, changes: Iterable<readonly [string, ContextGraphDormancyReason | undefined]>, account: (transitions: readonly SubscriptionDormancyTransition[]) => void): void {
    const transitions = [...new Map(changes)].map(([id, reason]) => applyDormancy(dormancy, id, reason));
    account(transitions);
    for (const { id, after } of transitions) {
      if (after !== 'authorityUnavailable' && after !== 'activationCap') this.cancel(id);
    }
  }
  private owned(handle: ActivationHandle): ActivationAttempt {
    const attempt = this.pending.get(handle.id);
    if (!attempt || attempt.handle !== handle) throw changed();
    return attempt;
  }
  install(handle: ActivationHandle, subscription: ContextGraphSub): void {
    this.owned(handle).phase = { kind: 'installing', subscription };
  }
  repaired(row: ContextGraphSubscriptionRecord, live: ContextGraphSub): void {
    const attempt = this.pending.get(row.id), phase = attempt?.phase;
    if (attempt && phase && phase.kind === 'installing'
      && sameIntent(attempt.intent, row) && isContextGraphSubscriptionStoredAgain(phase.subscription, live))
      attempt.repaired = { ...row };
  }
  /** One owner commits bookkeeping, settles waiters, then publishes activation. */
  commit(handle: ActivationHandle, live: ContextGraphSub, claimRollingSlot: boolean): void {
    const ports = this.ports, id = handle.id;
    const attempt = this.owned(handle), phase = attempt.phase;
    if (ports.subscribedContextGraphs.get(id) !== live || (!live.subscribed && !live.coreHosted)
      || phase.kind !== 'installing'
      || !isContextGraphSubscriptionStoredAgain(phase.subscription, live)
      || !contextGraphSubscriptionAdmissionPremisesEqual(phase.subscription, live)) throw changed();
    const dormancy = applyDormancy(ports.contextGraphSubscriptionDormancyById, id, undefined);
    ports.contextGraphSubscriptionRehydrationPendingIds.delete(id);
    if (claimRollingSlot && !live.coreHosted && !rehydratedSubscriptionReachedSafeState(live))
      ports.contextGraphSubscriptionRehydrationSlotIds.add(id);
    const status = ports.getStatus();
    if (status) ports.setStatus(accountSubscriptionChanges(status, ports.contextGraphSubscriptionRehydrationAccountedIds,
      [{ dormancy, kind: 'saved', persisted: true, active: true, hosted: live.coreHosted === true }]));
    this.settle(attempt, { kind: 'committed', subscription: live });
    ports.publish(id);
  }
  wait(id: string, signal: AbortSignal): Promise<ActivationOutcome> {
    const attempt = this.pending.get(id);
    if (!attempt) return Promise.reject(changed());
    return new Promise((resolve, reject) => {
      const finish = () => {
        if (!signal.aborted && attempt.phase.kind !== 'settled') return;
        attempt.listeners.delete(finish); signal.removeEventListener('abort', finish);
        if (signal.aborted) reject(changed());
        else if (attempt.phase.kind === 'settled') resolve(attempt.phase.outcome);
      };
      attempt.listeners.add(finish); signal.addEventListener('abort', finish, { once: true });
      finish();
    });
  }
}

/** Await the lifecycle's existing activation within the caller's original lifetime.
 * Denied, disabled and capped subscriptions retain their existing inactive behavior. */
export function waitForSubscriptionActivation(
  workLifetime: AgentWorkLifetime, isStarted: () => boolean,
  subscriptions: ReadonlyMap<string, ContextGraphSub>, dormancy: Dormancy,
  id: string, caller: AbortSignal, activations: ContextGraphSubscriptionActivations,
): Promise<void> | undefined {
  if (dormancy.get(id) !== 'authorityUnavailable') return;
  const generation = workLifetime.generation;
  const signal = AbortSignal.any([caller, workLifetime.signal]);
  const assertCurrent = () => {
    if (signal.aborted || generation !== workLifetime.generation || !isStarted()) throw changed();
  };
  assertCurrent();
  return workLifetime.track(activations.wait(id, signal)).then(outcome => {
    assertCurrent();
    const live = subscriptions.get(id);
    // Preserve the caller's inactive-subscription error after an explicit unsubscribe.
    if (live && !live.subscribed && !live.coreHosted && dormancy.get(id) !== 'authorityUnavailable') return;
    if (outcome.kind !== 'committed' || !live || dormancy.has(id)
      || !isContextGraphSubscriptionStoredAgain(outcome.subscription, live)
      || !contextGraphSubscriptionAdmissionPremisesEqual(outcome.subscription, live)) throw changed();
  });
}
