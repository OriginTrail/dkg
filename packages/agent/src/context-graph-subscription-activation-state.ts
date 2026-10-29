// SPDX-License-Identifier: Apache-2.0
import type { AgentWorkLifetime } from './agent-work-lifetime.js';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { accountSubscriptionChanges, type SubscriptionAccountingChange } from './context-graph-subscription-accounting.js';
import { rehydratedSubscriptionReachedSafeState, type PersistedContextGraphSubscriptionActivationOptions, type PersistedContextGraphSubscriptionActivationPorts } from './context-graph-subscription-authority-recovery.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord, ContextGraphSubscriptionRehydrationInternalStatus } from './dkg-agent-types.js';
import type { ContextGraphDormancyReason } from './context-graph-subscription-dormancy.js';
import { contextGraphSubscriptionAdmissionPremisesEqual, isContextGraphSubscriptionStoredAgain } from './context-graph-subscription-policy.js';

type Dormancy = ReadonlyMap<string, ContextGraphDormancyReason>;
function applyDormancy(dormancy: Map<string, ContextGraphDormancyReason>, id: string, after: ContextGraphDormancyReason | undefined): void {
  if (after === undefined) dormancy.delete(id); else dormancy.set(id, after);
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
type ActivationOutcome = { kind: 'committed'; subscription: ContextGraphSub } | { kind: 'cancelled' };
type ActivationPhase = { kind: 'queued' } | { kind: 'installing'; subscription: ContextGraphSub }
  | { kind: 'settled'; outcome: ActivationOutcome };
interface ActivationAttempt {
  readonly intent: ContextGraphSubscriptionRecord;
  repaired?: ContextGraphSubscriptionRecord;
  phase: ActivationPhase;
  readonly listeners: Set<() => void>;
}

export type SubscriptionLifecycleEvent = Readonly<{ id: string } & (
  | { kind: 'dormancy'; reason: ContextGraphDormancyReason | undefined }
  | { kind: 'cleared' | 'deactivated' }
)>;

type SubscriptionActivationCommit = Readonly<{ id: string; kind: 'activated'; subscription: ContextGraphSub }>;
// These facts are decided by owner methods, never supplied through the public lifecycle API.
type SubscriptionOwnerDecision = Readonly<{ id: string;
  kind: 'persistence-acknowledged' | 'intent-replaced';
  reason: ContextGraphDormancyReason | undefined; persisted: boolean; active: boolean; hosted: boolean;
}>;
type TransitionEvent = SubscriptionLifecycleEvent | SubscriptionActivationCommit | SubscriptionOwnerDecision;
type SubscriptionFacts = { persisted: boolean; active: boolean; hosted: boolean };
type TransitionDecision = {
  facts: SubscriptionFacts;
  reason: ContextGraphDormancyReason | undefined;
  pending: boolean;
  slot: 'retain' | 'release' | 'acquire';
  clearRevision: boolean;
  settlement: ActivationOutcome | undefined;
};
function shouldHoldRollingSlot(subscription: ContextGraphSub, persisted: boolean,
  status: ContextGraphSubscriptionRehydrationInternalStatus | null): boolean {
  return status?.rehydrationEnabled === true && status.activationCap > 0 && persisted
    && subscription.coreHosted !== true && subscription.subscribed
    && !rehydratedSubscriptionReachedSafeState(subscription);
}
/** Event semantics are decided once, before any shared collection or waiter is changed. */
function reduceSubscriptionTransition(event: TransitionEvent, current: {
  facts: SubscriptionFacts;
  live: ContextGraphSub | undefined; status: ContextGraphSubscriptionRehydrationInternalStatus | null;
}): TransitionDecision {
  const normalized = (persisted: boolean, liveActive: boolean, hosted: boolean,
    reason: ContextGraphDormancyReason | undefined, settlement: ActivationOutcome | undefined,
    slot: TransitionDecision['slot'] = reason === undefined ? 'retain' : 'release', clearRevision = false): TransitionDecision => {
    const active = persisted && liveActive && reason === undefined;
    return { facts: { persisted, active, hosted: active && hosted }, reason,
      pending: reason === 'activationCap', slot, clearRevision, settlement };
  };
  switch (event.kind) {
    case 'persistence-acknowledged':
      return normalized(event.persisted, event.active, event.hosted, event.reason, undefined);
    case 'intent-replaced':
      return normalized(event.persisted, event.active, event.hosted, event.reason, { kind: 'cancelled' });
    case 'dormancy':
      return normalized(current.facts.persisted, Boolean(current.live?.subscribed || current.live?.coreHosted),
        current.live?.coreHosted === true, event.reason,
        event.reason === 'authorityUnavailable' || event.reason === 'activationCap' ? undefined : { kind: 'cancelled' });
    case 'cleared':
      return normalized(false, false, false, undefined, { kind: 'cancelled' }, 'release', true);
    case 'deactivated':
      return normalized(current.facts.persisted, false, false, 'deactivated', { kind: 'cancelled' });
    case 'activated':
      return normalized(true, true, event.subscription.coreHosted === true, undefined,
        { kind: 'committed', subscription: event.subscription },
        shouldHoldRollingSlot(event.subscription, true, current.status) ? 'acquire' : 'release');
    default: {
      const exhaustive: never = event;
      throw new Error(`Unknown subscription transition: ${String(exhaustive)}`);
    }
  }
}

export interface SubscriptionActivationPorts {
  readonly subscribedContextGraphs: ReadonlyMap<string, ContextGraphSub>;
  readonly contextGraphSubscriptionDormancyById: Map<string, ContextGraphDormancyReason>;
  readonly contextGraphSubscriptionRehydrationPendingIds: Set<string>;
  readonly contextGraphSubscriptionRehydrationSlotIds: Set<string>;
  readonly contextGraphSubscriptionRehydrationAccountedIds: Set<string>;
  getStatus(): ContextGraphSubscriptionRehydrationInternalStatus | null;
  setStatus(status: ContextGraphSubscriptionRehydrationInternalStatus): void;
  slotReleased(): void;
  clearPersistRevision(id: string): void;
  publish(id: string): void;
}

/** Owns activation attempts and their outcomes. The attempt object owns generation identity;
 * waiters never load or reinterpret durable intent or mutate attempt phases. */
export class ContextGraphSubscriptionActivations {
  constructor(private readonly ports: SubscriptionActivationPorts) {}
  private readonly pending = new Map<string, ActivationAttempt>();
  // Startup uses the same incremental transitions as retries, but only publishes
  // the completed report once the startup lifecycle finishes its authority pass.
  private startupAccounting: ContextGraphSubscriptionRehydrationInternalStatus | null = null;
  beginRehydration(rows: readonly ContextGraphSubscriptionRecord[], options: {
    rehydrationEnabled: boolean; systemExcluded: number; activationCap: number;
  }): void {
    this.ports.contextGraphSubscriptionRehydrationAccountedIds.clear();
    this.startupAccounting = { ...options, persistedTotal: 0, activated: 0,
      hostedActivated: 0, hostedActivatedIds: [], capDisabled: options.activationCap === 0,
      completedAt: 0, updatedAt: Date.now() };
    this.apply(rows.map(row => ({ id: row.id, kind: 'persistence-acknowledged', persisted: true,
      active: false, hosted: false,
      reason: options.rehydrationEnabled ? 'authorityUnavailable' : 'rehydrationDisabled' })));
  }
  completeRehydration(): ContextGraphSubscriptionRehydrationInternalStatus {
    if (!this.startupAccounting) throw new Error('Subscription rehydration accounting was not initialized');
    const completedAt = Date.now();
    const status = { ...this.startupAccounting, completedAt, updatedAt: completedAt };
    this.startupAccounting = null;
    this.ports.setStatus(status);
    return status;
  }
  /** Publish partial progress so surviving startup intents have a recovery owner. */
  finishPartialRehydration(): ContextGraphSubscriptionRehydrationInternalStatus | null {
    return this.startupAccounting ? this.completeRehydration() : null;
  }
  reset(rows: readonly ContextGraphSubscriptionRecord[]): void {
    for (const id of this.pending.keys()) this.cancel(id);
    this.ports.contextGraphSubscriptionDormancyById.clear();
    for (const row of rows) this.attemptFor(row);
  }
  resetScheduler(): void {
    this.ports.contextGraphSubscriptionRehydrationPendingIds.clear();
    this.ports.contextGraphSubscriptionRehydrationSlotIds.clear();
  }
  /** Persistence acknowledges durability; only intent replacement or commit retires an activation. */
  recordPersistence(id: string, persisted?: Pick<ContextGraphSubscriptionRecord, 'subscribed' | 'coreHosted'>): void {
    const live = this.ports.subscribedContextGraphs.get(id);
    const isPersisted = persisted?.subscribed === true || persisted?.coreHosted === true;
    const active = !this.pending.has(id) && (live?.subscribed === true || live?.coreHosted === true);
    const reason = isPersisted && !active
      ? this.ports.contextGraphSubscriptionDormancyById.get(id)
        ?? ((this.startupAccounting ?? this.ports.getStatus())?.rehydrationEnabled ? 'authorityUnavailable' : 'rehydrationDisabled')
      : undefined;
    this.apply([{ id, kind: 'persistence-acknowledged', reason, persisted: isPersisted, active, hosted: live?.coreHosted === true }]);
  }
  /** One policy owns slot occupancy during startup, activation commit and readiness changes. */
  private reconcileRollingSlot(id: string, subscription: ContextGraphSub, persisted: boolean): boolean {
    const ports = this.ports, status = this.startupAccounting ?? ports.getStatus();
    if (shouldHoldRollingSlot(subscription, persisted, status)) {
      ports.contextGraphSubscriptionRehydrationSlotIds.add(id);
      return false;
    }
    return ports.contextGraphSubscriptionRehydrationSlotIds.delete(id);
  }
  updateReadiness(id: string, subscription: ContextGraphSub, release: 'deactivation' | 'activation-rollback' | 'rolling-rollback' = 'deactivation'): boolean {
    const released = this.reconcileRollingSlot(id, subscription, this.ports.contextGraphSubscriptionRehydrationAccountedIds.has(id));
    if (released && release !== 'rolling-rollback') this.ports.slotReleased();
    return released;
  }
  private attemptFor(row: ContextGraphSubscriptionRecord): ActivationAttempt {
    const current = this.pending.get(row.id);
    if (current && (sameDurableIntent(current.intent, row)
      || (current.repaired && sameDurableIntent(current.repaired, row)))) return current;
    this.cancel(row.id);
    const attempt: ActivationAttempt = { intent: { ...row }, phase: { kind: 'queued' }, listeners: new Set() };
    this.pending.set(row.id, attempt);
    return attempt;
  }
  private settle(attempt: ActivationAttempt, outcome: ActivationOutcome): void {
    if (attempt.phase.kind === 'settled') return;
    this.pending.delete(attempt.intent.id);
    attempt.phase = { kind: 'settled', outcome };
    for (const notify of attempt.listeners) notify();
    attempt.listeners.clear();
  }
  cancel(id: string): void {
    const attempt = this.pending.get(id);
    if (attempt) this.settle(attempt, { kind: 'cancelled' });
  }
  /** A new live intent supersedes the dormant activation independently of disk I/O. */
  replaceLiveIntent(id: string, subscription: ContextGraphSub): void {
    if (!this.pending.has(id) && (!this.ports.contextGraphSubscriptionDormancyById.has(id)
      || (!subscription.subscribed && !subscription.coreHosted))) return;
    this.apply([{ id, kind: 'intent-replaced',
      persisted: this.ports.contextGraphSubscriptionRehydrationAccountedIds.has(id),
      active: subscription.subscribed || subscription.coreHosted === true,
      hosted: subscription.coreHosted === true,
      reason: subscription.subscribed || subscription.coreHosted ? undefined : 'deactivated' }]);
  }
  /** Explicit unsubscribe retires member intent even before a live row was installed. */
  unsubscribe(id: string): void {
    const ports = this.ports, live = ports.subscribedContextGraphs.get(id);
    if (live) this.replaceLiveIntent(id, live);
    else if (this.pending.has(id) || ports.contextGraphSubscriptionDormancyById.has(id)
      || ports.contextGraphSubscriptionRehydrationPendingIds.has(id)
      || ports.contextGraphSubscriptionRehydrationAccountedIds.has(id)) this.transition({ id, kind: 'deactivated' });
  }
  /** Explicit lifecycle facts use the same bookkeeping operation as activation. */
  transition(event: SubscriptionLifecycleEvent): void { this.transitionBatch([event]); }
  /** Apply all collection and accounting effects before notifying any waiter. */
  transitionBatch(events: Iterable<SubscriptionLifecycleEvent>): void { this.apply(events); }
  private apply(events: Iterable<TransitionEvent>): void {
    const ports = this.ports;
    const changes: SubscriptionAccountingChange[] = [];
    const status = this.startupAccounting ?? ports.getStatus();
    const hostedBefore = new Set(status?.hostedActivatedIds ?? []);
    const plans = [...new Map([...events].map(event => [event.id, event])).values()].map(event => {
      const id = event.id;
      const persisted = ports.contextGraphSubscriptionRehydrationAccountedIds.has(id);
      const reason = ports.contextGraphSubscriptionDormancyById.get(id);
      const before = { persisted, active: persisted && reason === undefined, hosted: hostedBefore.has(id) };
      return { id, before, decision: reduceSubscriptionTransition(event, {
        facts: before,
        live: ports.subscribedContextGraphs.get(id), status,
      }) };
    });
    let released = false;
    for (const { id, before, decision } of plans) {
      applyDormancy(ports.contextGraphSubscriptionDormancyById, id, decision.reason);
      if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(id)) continue;
      if (decision.facts.persisted) ports.contextGraphSubscriptionRehydrationAccountedIds.add(id);
      else ports.contextGraphSubscriptionRehydrationAccountedIds.delete(id);
      changes.push({ id, before, after: decision.facts });
      if (decision.pending) ports.contextGraphSubscriptionRehydrationPendingIds.add(id);
      else ports.contextGraphSubscriptionRehydrationPendingIds.delete(id);
      if (decision.slot === 'acquire') ports.contextGraphSubscriptionRehydrationSlotIds.add(id);
      else if (decision.slot === 'release') released = ports.contextGraphSubscriptionRehydrationSlotIds.delete(id) || released;
    }
    if (status && changes.length) {
      const next = accountSubscriptionChanges(status, changes);
      if (this.startupAccounting) this.startupAccounting = next;
      else ports.setStatus(next);
    }
    for (const { id, decision } of plans) {
      if (decision.clearRevision && !(Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(id)) ports.clearPersistRevision(id);
    }
    if (released) ports.slotReleased();
    for (const { id, decision } of plans) {
      const attempt = this.pending.get(id);
      if (attempt && decision.settlement) this.settle(attempt, decision.settlement);
    }
  }
  private assertOwned(attempt: ActivationAttempt): void {
    if (this.pending.get(attempt.intent.id) !== attempt) throw changed();
  }
  /** One retry owns installation, repair, network effects, rollback and commit. */
  async activate(row: ContextGraphSubscriptionRecord, ports: PersistedContextGraphSubscriptionActivationPorts,
    options: PersistedContextGraphSubscriptionActivationOptions = {}): Promise<ContextGraphSub> {
    const attempt = this.attemptFor(row);
    if (attempt.phase.kind !== 'queued') throw changed();
    const previous = this.ports.subscribedContextGraphs.get(row.id);
    const restorePendingMeta = options.restorePendingMeta === true;
    const subscription = ports.install(row, { onChainId: options.onChainId, restorePendingMeta,
      updateRehydrationStatus: options.updateRehydrationStatus !== false });
    this.assertOwned(attempt);
    attempt.phase = { kind: 'installing', subscription };
    try {
      await options.prepare?.(subscription, isCurrent => this.persistRepair(attempt, subscription, ports, isCurrent));
      this.assertInstalled(attempt);
      if (options.isCurrent && !options.isCurrent(subscription)) {
        throw new Error(`Persisted subscription activation for "${row.id}" became stale`);
      }
      if (!restorePendingMeta) {
        if (row.syncScoped) ports.trackSync(row.id);
        if (row.subscribed) { ports.subscribe(row.id); ports.persistMembership(row.id); }
      }
      return this.commit(attempt, ports.commit);
    } catch (error) {
      try {
        // A live subscribe may take custody of the very same provisional row.
        // Attempt identity, rather than row identity alone, authorizes rollback.
        if (this.isInstalled(attempt)) {
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
  private isInstalled(attempt: ActivationAttempt): boolean {
    const phase = attempt.phase;
    const live = this.ports.subscribedContextGraphs.get(attempt.intent.id);
    return this.pending.get(attempt.intent.id) === attempt && live !== undefined
      && (live.subscribed || live.coreHosted === true) && phase.kind === 'installing'
      && isContextGraphSubscriptionStoredAgain(phase.subscription, live)
      && contextGraphSubscriptionAdmissionPremisesEqual(phase.subscription, live);
  }
  /** Mandatory generation fence after asynchronous preparation and before commit. */
  private assertInstalled(attempt: ActivationAttempt): void {
    if (!this.isInstalled(attempt)) throw changed();
  }
  /** The installing retry owns both strict persistence and acknowledgement. */
  private async persistRepair(attempt: ActivationAttempt, subscription: ContextGraphSub,
    ports: PersistedContextGraphSubscriptionActivationPorts, isCurrent: () => boolean = () => true): Promise<void> {
    const isRetryCurrent = () => this.isInstalled(attempt)
      && attempt.phase.kind === 'installing' && attempt.phase.subscription === subscription;
    const assertRetry = () => { if (!isRetryCurrent()) throw changed(); };
    assertRetry();
    // The strict writer owns the queued write's typed cancellation error.
    const record = await ports.persistBinding(attempt.intent.id, subscription, attempt.intent.syncScoped,
      () => isRetryCurrent() && isCurrent());
    assertRetry();
    if (!record) return;
    // Preserving independent Core custody can add hosting to the saved row.
    // That is not a binding repair of this attempt's member intent; canonical
    // commit still validates the custody transfer before applying it.
    if (sameIntent(attempt.intent, record)) attempt.repaired = { ...record };
  }
  /** One owner commits bookkeeping, settles waiters, then publishes activation. */
  private commit(attempt: ActivationAttempt, write: (id: string) => ContextGraphSub): ContextGraphSub {
    const ports = this.ports, id = attempt.intent.id;
    // Fence the old owner before the verified transition retires any wire custody.
    this.assertInstalled(attempt);
    const live = write(id);
    // The canonical setter may legitimately start a new line when it adopts
    // verified Core hosting. The canonical write returns its committed row.
    if (this.pending.get(id) !== attempt || ports.subscribedContextGraphs.get(id) !== live
      || (!live.subscribed && !live.coreHosted)) throw changed();
    this.apply([{ id, kind: 'activated', subscription: live }]);
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

/** The lifecycle owns the invariant across every consumer await. */
export type OwnedSubscriptionActivation = Readonly<{
  subscription: ContextGraphSub;
  assertCurrent(): void;
}>;

/** Await the lifecycle's existing activation within the caller's original lifetime.
 * Denied, disabled and capped subscriptions retain their existing inactive behavior. */
export function waitForSubscriptionActivation(
  workLifetime: AgentWorkLifetime, isStarted: () => boolean,
  subscriptions: ReadonlyMap<string, ContextGraphSub>, dormancy: Dormancy,
  id: string, caller: AbortSignal, activations: ContextGraphSubscriptionActivations,
): Promise<OwnedSubscriptionActivation> | undefined {
  if (dormancy.get(id) !== 'authorityUnavailable') return;
  const generation = workLifetime.generation;
  const signal = AbortSignal.any([caller, workLifetime.signal]);
  const assertLifetime = () => {
    if (signal.aborted || generation !== workLifetime.generation || !isStarted()) throw changed();
  };
  assertLifetime();
  return workLifetime.track(activations.wait(id, signal)).then(outcome => {
    assertLifetime();
    const live = subscriptions.get(id);
    // Preserve the caller's inactive-subscription error after an explicit unsubscribe.
    const inactive = live && !live.subscribed && !live.coreHosted && dormancy.get(id) !== 'authorityUnavailable';
    const captured = inactive ? live : outcome.kind === 'committed' ? outcome.subscription : undefined;
    if (!captured) throw changed();
    const assertCurrent = () => {
      assertLifetime();
      const current = subscriptions.get(id);
      if (!isContextGraphSubscriptionStoredAgain(captured, current)
        || !contextGraphSubscriptionAdmissionPremisesEqual(captured, current)
        || ((captured.subscribed || captured.coreHosted) && dormancy.has(id))) throw changed();
    };
    assertCurrent();
    return { subscription: live!, assertCurrent };
  });
}
