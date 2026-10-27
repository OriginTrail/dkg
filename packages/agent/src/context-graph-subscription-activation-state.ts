// SPDX-License-Identifier: Apache-2.0
import type { AgentWorkLifetime } from './agent-work-lifetime.js';
import { accountSubscriptionChanges } from './context-graph-subscription-accounting.js';
import { rehydratedSubscriptionReachedSafeState, type PersistedContextGraphSubscriptionActivationOptions, type PersistedContextGraphSubscriptionActivationPorts } from './context-graph-subscription-authority-recovery.js';
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
  reset(rows: readonly ContextGraphSubscriptionRecord[]): void {
    for (const id of this.pending.keys()) this.cancel(id);
    this.ports.contextGraphSubscriptionDormancyById.clear();
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
  transition(id: string, reason: ContextGraphDormancyReason | undefined, account: (transition: SubscriptionDormancyTransition) => void = () => {}): void {
    this.transitionBatch([[id, reason]], transitions => account(transitions[0]));
  }
  /** Apply the entire change and its accounting before notifying any waiters. */
  transitionBatch(changes: Iterable<readonly [string, ContextGraphDormancyReason | undefined]>, account: (transitions: readonly SubscriptionDormancyTransition[]) => void): void {
    const transitions = [...new Map(changes)].map(([id, reason]) => applyDormancy(this.ports.contextGraphSubscriptionDormancyById, id, reason));
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
  /** One retry owns installation, repair, network effects, rollback and commit. */
  async activate<Transition extends Readonly<{ subscription: ContextGraphSub }>>(row: ContextGraphSubscriptionRecord, ports: PersistedContextGraphSubscriptionActivationPorts<Transition>,
    options: PersistedContextGraphSubscriptionActivationOptions = {}): Promise<ContextGraphSub> {
    const handle = this.observe(row), attempt = this.owned(handle);
    if (attempt.phase.kind !== 'queued') throw changed();
    const previous = this.ports.subscribedContextGraphs.get(row.id);
    const restorePendingMeta = options.restorePendingMeta === true;
    const subscription = ports.install(row, { onChainId: options.onChainId, restorePendingMeta,
      updateRehydrationStatus: options.updateRehydrationStatus !== false });
    this.owned(handle);
    attempt.phase = { kind: 'installing', subscription };
    let networkEffectsStarted = false;
    try {
      await options.prepare?.(subscription, record => this.repaired(handle, subscription, record));
      this.assertInstalled(handle);
      if (options.isCurrent && !options.isCurrent(subscription)) {
        throw new Error(`Persisted subscription activation for "${row.id}" became stale`);
      }
      if (!restorePendingMeta) {
        networkEffectsStarted = true;
        if (row.syncScoped) ports.trackSync(row.id);
        if (row.subscribed) { ports.subscribe(row.id); ports.persistMembership(row.id); }
      }
      const plan = ports.prepareCommit(row.id);
      return this.commit(handle, plan, ports.applyCommit, options.claimRollingSlot === true);
    } catch (error) {
      try {
        // Before network effects, preserve a concurrently replaced generation.
        // All network ports are synchronous, so later changes belong to this retry.
        if (networkEffectsStarted || this.ports.subscribedContextGraphs.get(row.id) === subscription) {
          try { ports.rollbackNetworkEffects(row.id, options.rollbackSlotRelease ?? 'activation-rollback'); }
          finally {
            ports.remove(row.id);
            if (previous && !previous.subscribed && previous.coreHosted !== true) ports.restoreInactive?.(row.id, previous);
          }
        }
      } finally {
        // Durable repairs and waiters belong to the intent, not this failed retry.
        if (this.pending.get(row.id) === attempt && attempt.phase.kind === 'installing') attempt.phase = { kind: 'queued' };
      }
      throw error;
    }
  }
  /** Mandatory generation fence after asynchronous preparation and before commit. */
  private assertInstalled(handle: ActivationHandle): ActivationAttempt {
    const attempt = this.owned(handle), phase = attempt.phase;
    const live = this.ports.subscribedContextGraphs.get(handle.id);
    if (!live || (!live.subscribed && !live.coreHosted) || phase.kind !== 'installing'
      || !isContextGraphSubscriptionStoredAgain(phase.subscription, live)
      || !contextGraphSubscriptionAdmissionPremisesEqual(phase.subscription, live)) throw changed();
    return attempt;
  }
  /** Activation preparation explicitly reports its acknowledged durable repair. */
  private repaired(handle: ActivationHandle, subscription: ContextGraphSub, row: ContextGraphSubscriptionRecord): void {
    const attempt = this.owned(handle);
    if (attempt.phase.kind !== 'installing' || attempt.phase.subscription !== subscription) throw changed();
    // Preserving independent Core custody can add hosting to the saved row.
    // That is not a binding repair of this attempt's member intent; canonical
    // commit still validates the custody transfer before applying it.
    if (sameIntent(attempt.intent, row)) attempt.repaired = { ...row };
  }
  /** One owner commits bookkeeping, settles waiters, then publishes activation. */
  private commit<Transition extends Readonly<{ subscription: ContextGraphSub }>>(handle: ActivationHandle, transition: Transition, apply: (transition: Transition) => ContextGraphSub, claimRollingSlot: boolean): ContextGraphSub {
    const ports = this.ports, id = handle.id;
    // Fence the old owner before the verified transition retires any wire custody.
    const attempt = this.assertInstalled(handle);
    const live = apply(transition);
    // The canonical setter may legitimately start a new line when it adopts
    // verified Core hosting. Validate against the authorized projection instead.
    if (this.pending.get(id) !== attempt || ports.subscribedContextGraphs.get(id) !== live
      || !contextGraphSubscriptionAdmissionPremisesEqual(transition.subscription, live)) throw changed();
    const dormancy = applyDormancy(ports.contextGraphSubscriptionDormancyById, id, undefined);
    ports.contextGraphSubscriptionRehydrationPendingIds.delete(id);
    if (claimRollingSlot && !live.coreHosted && !rehydratedSubscriptionReachedSafeState(live))
      ports.contextGraphSubscriptionRehydrationSlotIds.add(id);
    const status = ports.getStatus();
    if (status) ports.setStatus(accountSubscriptionChanges(status, ports.contextGraphSubscriptionRehydrationAccountedIds,
      [{ dormancy, kind: 'saved', persisted: true, active: true, hosted: live.coreHosted === true }]));
    this.settle(attempt, { kind: 'committed', subscription: live });
    ports.publish(id);
    return live;
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
