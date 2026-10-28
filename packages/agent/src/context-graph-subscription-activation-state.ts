// SPDX-License-Identifier: Apache-2.0
import type { AgentWorkLifetime } from './agent-work-lifetime.js';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { accountSubscriptionChanges, type SubscriptionAccountingChange } from './context-graph-subscription-accounting.js';
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
  | { kind: 'saved'; reason: ContextGraphDormancyReason | undefined; persisted: boolean; active: boolean; hosted: boolean }
  | { kind: 'cleared' | 'deactivated' }
)>;

type SubscriptionActivationCommit = Readonly<{ id: string; kind: 'activated'; subscription: ContextGraphSub; claimRollingSlot: boolean }>;

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
    this.apply(rows.map(row => ({ id: row.id, kind: 'saved', persisted: true,
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
  abandonRehydration(): void { this.startupAccounting = null; }
  reset(rows: readonly ContextGraphSubscriptionRecord[]): void {
    for (const id of this.pending.keys()) this.cancel(id);
    this.ports.contextGraphSubscriptionDormancyById.clear();
    for (const row of rows) this.attemptFor(row);
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
    if (!this.pending.has(id)) return;
    this.ports.contextGraphSubscriptionRehydrationPendingIds.delete(id);
    this.transition({ id, kind: 'saved',
      persisted: this.ports.contextGraphSubscriptionRehydrationAccountedIds.has(id),
      active: subscription.subscribed || subscription.coreHosted === true,
      hosted: subscription.coreHosted === true,
      reason: subscription.subscribed || subscription.coreHosted ? undefined : 'deactivated' });
  }
  /** Explicit lifecycle facts use the same bookkeeping operation as activation. */
  transition(event: SubscriptionLifecycleEvent): void { this.transitionBatch([event]); }
  /** Apply the entire batch and its accounting before cancelling any waiters. */
  transitionBatch(events: Iterable<SubscriptionLifecycleEvent>): void {
    for (const { id, after } of this.apply(events)) {
      if (after !== 'authorityUnavailable' && after !== 'activationCap') this.cancel(id);
    }
  }
  private apply(events: Iterable<SubscriptionLifecycleEvent | SubscriptionActivationCommit>): SubscriptionDormancyTransition[] {
    const ports = this.ports;
    const changes: SubscriptionAccountingChange[] = [];
    const cleanup: string[] = [];
    let released = false;
    const transitions = [...new Map([...events].map(event => [event.id, event])).values()].map(event => {
      const { id, kind } = event;
      const reason = kind === 'saved' || kind === 'dormancy' ? event.reason
        : kind === 'deactivated' ? 'deactivated' : undefined;
      const dormancy = applyDormancy(ports.contextGraphSubscriptionDormancyById, id, reason);
      if (kind === 'dormancy' || (kind !== 'activated' && (Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(id))) return dormancy;
      if (kind === 'activated') {
        ports.contextGraphSubscriptionRehydrationPendingIds.delete(id);
        if (event.claimRollingSlot && !event.subscription.coreHosted && !rehydratedSubscriptionReachedSafeState(event.subscription))
          ports.contextGraphSubscriptionRehydrationSlotIds.add(id);
        changes.push({ dormancy, kind: 'saved', persisted: true, active: true, hosted: event.subscription.coreHosted === true });
      } else if (kind === 'saved') {
        changes.push({ dormancy, kind, persisted: event.persisted, active: event.active, hosted: event.hosted });
      } else {
        ports.contextGraphSubscriptionRehydrationPendingIds.delete(id);
        released = ports.contextGraphSubscriptionRehydrationSlotIds.delete(id) || released;
        changes.push({ dormancy, kind });
        if (kind === 'cleared') cleanup.push(id);
      }
      return dormancy;
    });
    const status = this.startupAccounting ?? ports.getStatus();
    if (status && changes.length) {
      const next = accountSubscriptionChanges(status, ports.contextGraphSubscriptionRehydrationAccountedIds, changes);
      if (this.startupAccounting) this.startupAccounting = next;
      else ports.setStatus(next);
    }
    for (const id of cleanup) ports.clearPersistRevision(id);
    if (released) ports.slotReleased();
    return transitions;
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
    let networkEffectsStarted = false;
    try {
      await options.prepare?.(subscription, isCurrent => this.persistRepair(attempt, subscription, ports, isCurrent));
      this.assertInstalled(attempt);
      if (options.isCurrent && !options.isCurrent(subscription)) {
        throw new Error(`Persisted subscription activation for "${row.id}" became stale`);
      }
      if (!restorePendingMeta) {
        networkEffectsStarted = true;
        if (row.syncScoped) ports.trackSync(row.id);
        if (row.subscribed) { ports.subscribe(row.id); ports.persistMembership(row.id); }
      }
      return this.commit(attempt, ports.commit, options.claimRollingSlot === true);
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
  private commit(attempt: ActivationAttempt, write: (id: string) => ContextGraphSub, claimRollingSlot: boolean): ContextGraphSub {
    const ports = this.ports, id = attempt.intent.id;
    // Fence the old owner before the verified transition retires any wire custody.
    this.assertInstalled(attempt);
    const live = write(id);
    // The canonical setter may legitimately start a new line when it adopts
    // verified Core hosting. The canonical write returns its committed row.
    if (this.pending.get(id) !== attempt || ports.subscribedContextGraphs.get(id) !== live
      || (!live.subscribed && !live.coreHosted)) throw changed();
    this.apply([{ id, kind: 'activated', subscription: live, claimRollingSlot }]);
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
