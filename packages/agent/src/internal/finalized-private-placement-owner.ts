// SPDX-License-Identifier: Apache-2.0
import { createOperationContext, type AuthorCatalogScopeV1, type ContextGraphIdV1, type OperationContext } from '@origintrail-official/dkg-core';
import { withDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';
import { CoalescingRecurringTask } from '../coalescing-recurring-task.js';
import { CatalogRepairConditionErrorV1, CatalogRepairLaneInactiveErrorV1, catalogRepairDiagnosticV1 } from '../rfc64/catalog-repair-diagnostics-v1.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1, Rfc64PrivatePlacementFailureWriteV1 } from '../rfc64/finalized-private-placement-repair-store-v1.js';
import { resetPrivatePlacementFailureStateV1, summarizePrivatePlacementFailuresV1, type PrivatePlacementFailureStateV1 } from '../rfc64/private-placement-failure-state-v1.js';
import { finalizedPlacementAuthorityRevisionV1, finalizedPlacementDecisionInputV1, readFinalizedPlacementAuthorityV1, resolveFinalizedPlacementDecisionV1, type FinalizedPlacementDecisionV1, type FinalizedPlacementAuthorityV1 } from './finalized-placement-decision.js';
import { FinalizedPrivateRepairRetryV1 } from './finalized-private-repair-retry.js';
import { finalizedPrivateRepairKeyV1 } from './finalized-private-placement-key.js';
import type { CatalogPlacementTimingV1, CatalogPlacementAttemptV1, CatalogPlacementWaiterObserverV1, FinalizedPrivatePlacementQueueStatusV1 } from './catalog-placement-timing.js';
import type { FullCatalogParkingV1 } from './full-catalog-parking.js';
import { FinalizedPrivatePlacementWaitersV1 } from './finalized-private-placement-waiters.js';
import { createMainThreadTimeSlice } from '../main-thread-time-slice.js';
import { NextTurnRecurringTaskV1 } from './next-turn-recurring-task.js';

/** What admission reads of a marker's placement decision. */
type MarkerDecisionV1 =
  | Readonly<{ status: 'ready' | 'inactive'; capacityScope: Readonly<AuthorCatalogScopeV1> | undefined }>
  | Readonly<{ status: 'unavailable'; error: Error; capacityScope: Readonly<AuthorCatalogScopeV1> | undefined }>;
interface RetryEntry {
  readonly key: string;
  readonly repair: Rfc64FinalizedPrivatePlacementRepairV1;
  readonly retry: FinalizedPrivateRepairRetryV1;
  failureHistoryRead: boolean;
  attempts: number;
  /** GH#3134 — the decision under the available authority last read, and what it read of it. */
  decided?: Readonly<{ input: string; decision: MarkerDecisionV1 }>;
}
interface ResetPlan {
  readonly repair: Rfc64FinalizedPrivatePlacementRepairV1;
  readonly key: string;
  readonly state: PrivatePlacementFailureStateV1 | null;
}
interface GraphLane {
  readonly id: ContextGraphIdV1;
  readonly entries: Set<RetryEntry>;
  revision?: string;
  resetPending: boolean;
}
/** GH#3134 — one graph's authority as a pass read it since its last await. */
interface GraphRead {
  readonly authority: FinalizedPlacementAuthorityV1;
  /** The lane revision; undefined while the authority is unavailable. */
  readonly revision: string | undefined;
  /** What a placement decision reads of the authority; undefined while it is unavailable. */
  readonly decisionInput: string | undefined;
  /** An unavailable authority over a pending reset: the lane's waiters are released already. */
  blocked: boolean;
}
interface PassState {
  readonly blockedGraphs: Set<ContextGraphIdV1>;
  /** Cleared at every await: nothing read before one admits a marker after it. */
  readonly graphs: Map<string, GraphRead>;
}
type LaneReconciliation =
  | { readonly kind: 'decision'; readonly decision: MarkerDecisionV1; readonly resetCommitted: boolean }
  | { readonly kind: 'blocked'; readonly resetCommitted: false };
const BLOCKED: LaneReconciliation = Object.freeze({ kind: 'blocked', resetCommitted: false });
interface Dependencies {
  listFinalizedPrivateRepairsAsync(signal: AbortSignal): Promise<readonly Rfc64FinalizedPrivatePlacementRepairV1[]>;
  listFinalizedPrivateRepairs(): readonly Rfc64FinalizedPrivatePlacementRepairV1[];
  readFinalizedPlacementAuthority(contextGraphId: string): FinalizedPlacementAuthorityV1;
  repairFinalizedPrivatePlacement(repair: Rfc64FinalizedPrivatePlacementRepairV1, placement: CatalogPlacementAttemptV1): Promise<void>;
  readPrivateFailure(repair: Rfc64FinalizedPrivatePlacementRepairV1): PrivatePlacementFailureStateV1 | null;
  writePrivateFailures(entries: readonly Rfc64PrivatePlacementFailureWriteV1[]): void;
  warn(ctx: OperationContext, message: string): void;
}
interface Options {
  readonly retryIntervalMs: number;
  readonly timing: () => CatalogPlacementTimingV1;
  readonly fullCatalogs: FullCatalogParkingV1;
  readonly ctx: OperationContext;
}
export interface Rfc64FinalizedPrivatePlacementRepairRequestV1 {
  readonly accepted: boolean;
  /** Settles after this exact repair's first admitted attempt; publication never waits on it. */
  readonly whenAttempted: Promise<void>;
}

/** Owns private repair evidence, scheduling, persistence ordering and waiter lifetime. */
export class FinalizedPrivatePlacementOwnerV1 {
  readonly #dependencies: Dependencies;
  readonly #options: Options;
  readonly #retries = new Map<string, RetryEntry>();
  readonly #lanes = new Map<string, GraphLane>();
  readonly #waiters = new FinalizedPrivatePlacementWaitersV1();
  readonly #runner: NextTurnRecurringTaskV1;
  #arrivedDuringListing: Map<string, ContextGraphIdV1> | undefined;
  #waiterTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(dependencies: Dependencies, options: Options) {
    this.#dependencies = dependencies;
    this.#options = options;
    this.#runner = new NextTurnRecurringTaskV1(new CoalescingRecurringTask({
      retryIntervalMs: options.retryIntervalMs,
      runPass: async signal => {
        let failed = false;
        try { await this.#runPass(signal); }
        catch (error) { failed = true; throw error; }
        finally {
          this.#arrivedDuringListing = undefined;
          options.timing().passEnded();
          options.fullCatalogs.passEnded();
          // Failed queue reads must not spin on an already-due waiter.
          this.#scheduleWaiterWake(failed ? (options.retryIntervalMs > 0 ? options.retryIntervalMs : 5_000) : 0);
        }
      },
      onError: error => this.#warn('catalog_private_repair_pass_failed', error),
      closingMessage: 'RFC-64 finalized-private placement repair closing',
    }));
  }

  get running(): boolean { return this.#runner.running; }
  get closed(): boolean { return this.#runner.closed; }
  requestPass(): boolean { return this.#runner.requestNextTurn(); }
  whenIdle(): Promise<void> { return this.#runner.whenIdle(); }

  /** Observe an inactive edge without admitting a placement. */
  observeLaneAvailability(contextGraphId: string): void {
    if (this.closed) return;
    let lane = this.#lanes.get(contextGraphId);
    if (!lane) {
      lane = { id: contextGraphId as ContextGraphIdV1, entries: new Set(), resetPending: false };
      this.#lanes.set(contextGraphId, lane);
    }
    try {
      this.#commitLaneReset(lane, laneRevisionV1(this.#readAuthority(contextGraphId)));
    } catch (error) { this.#warn('catalog_private_repair_lane_reset_failed', error); }
  }

  request(repair: Rfc64FinalizedPrivatePlacementRepairV1, observer?: CatalogPlacementWaiterObserverV1): Rfc64FinalizedPrivatePlacementRepairRequestV1 {
    const key = finalizedPrivateRepairKeyV1(repair);
    this.#arrivedDuringListing?.set(key, repair.contextGraphId);
    this.#options.timing().owed(key);
    const rejected = (): Rfc64FinalizedPrivatePlacementRepairRequestV1 => {
      try { observer?.released(); } catch { /* Observation cannot prevent waiter settlement. */ }
      return Object.freeze({ accepted: false, whenAttempted: Promise.resolve() });
    };
    if (this.closed) return rejected();
    let laneAccepts = false;
    let decision: FinalizedPlacementDecisionV1;
    try {
      decision = resolveFinalizedPlacementDecisionV1(repair, () => this.#readAuthority(repair.contextGraphId));
      if (decision.status === 'unavailable') throw decision.error;
      laneAccepts = decision.status === 'ready';
    }
    finally {
      // A refused durable marker still needs a bounded liveness pass.
      if (!laneAccepts && this.#options.retryIntervalMs > 0) this.#runner.schedule(this.#options.retryIntervalMs);
    }
    if (!laneAccepts) {
      try { this.observeLaneAvailability(repair.contextGraphId); }
      catch (error) { this.#warn('catalog_private_repair_lane_reset_failed', error); }
      return rejected();
    }
    const waiter = this.#waiters.add(key, this.#options.timing().now(), observer);
    // Keep durable queue listing and repair work off the caller's stack.
    if (!this.#runner.requestNextTurn()) { waiter.withdraw(); return rejected(); }
    return Object.freeze({ accepted: true, whenAttempted: waiter.whenAttempted });
  }

  status(): Readonly<FinalizedPrivatePlacementQueueStatusV1> {
    return Object.freeze({ ...this.#options.timing().queueStatus(this.#waiters.summary(), this.running),
      failures: summarizePrivatePlacementFailuresV1([...this.#retries.values()].map(entry => entry.retry.snapshot())) });
  }

  /** Commit every reset before changing memory, generations or wakeups. */
  retryFailed(): number {
    if (this.closed) throw new Error('Private placement owner is closed');
    const resets: ResetPlan[] = [];
    for (const repair of this.#dependencies.listFinalizedPrivateRepairs()) {
      const reset = this.#prepareReset(repair, finalizedPrivateRepairKeyV1(repair));
      if (reset.state) resets.push(reset);
    }
    if (!resets.length) return 0;
    this.#commitResets(resets);
    this.#runner.requestNextTurn();
    return resets.length;
  }

  async close(): Promise<void> {
    clearTimeout(this.#waiterTimer);
    this.#waiterTimer = undefined;
    await this.#runner.close();
    this.#waiters.releaseAll();
    this.#retries.clear();
    this.#lanes.clear();
  }

  #entry(repair: Rfc64FinalizedPrivatePlacementRepairV1, key = finalizedPrivateRepairKeyV1(repair)): RetryEntry {
    let entry = this.#retries.get(key);
    if (!entry) {
      entry = { key, repair, retry: new FinalizedPrivateRepairRetryV1(), failureHistoryRead: false, attempts: 0 };
      this.#retries.set(key, entry);
      let lane = this.#lanes.get(repair.contextGraphId);
      if (!lane) {
        lane = { id: repair.contextGraphId, entries: new Set(), resetPending: false };
        this.#lanes.set(repair.contextGraphId, lane);
      }
      lane.entries.add(entry);
    }
    return entry;
  }

  #forget(key: string, preserveLane = false): void {
    const entry = this.#retries.get(key);
    if (!entry) return;
    this.#retries.delete(key);
    const lane = this.#lanes.get(entry.repair.contextGraphId)!;
    lane.entries.delete(entry);
    if (!preserveLane && !lane.entries.size) this.#lanes.delete(lane.id);
  }

  #readAuthority(contextGraphId: string): FinalizedPlacementAuthorityV1 {
    return readFinalizedPlacementAuthorityV1(() => this.#dependencies.readFinalizedPlacementAuthority(contextGraphId));
  }

  #commitLaneReset(lane: GraphLane, revision: string | undefined): boolean {
    if (revision === undefined) return false;
    lane.resetPending ||= lane.revision !== undefined && lane.revision !== revision;
    // Initial discovery can yield before any siblings are registered. Remember
    // every observed edge, but defer its durable reset until the complete snapshot
    // is registered. Even an inactive/active round trip must retain resetPending.
    if (this.#arrivedDuringListing || lane.entries.size === 0 || !lane.resetPending) {
      lane.revision = revision;
      return false;
    }
    this.#commitResets([...lane.entries].map(entry => this.#prepareReset(entry.repair, entry.key)));
    // Publish the graph transition only after the complete durable batch commits.
    lane.revision = revision;
    lane.resetPending = false;
    return true;
  }

  /** Unread evidence is not absence; a reset must resolve it before consuming its edge. */
  #prepareReset(repair: Rfc64FinalizedPrivatePlacementRepairV1, key: string): ResetPlan {
    const entry = this.#retries.get(key);
    const previous = entry?.failureHistoryRead ? entry.retry.snapshot()
      : this.#dependencies.readPrivateFailure(repair) ?? entry?.retry.snapshot();
    return { repair, key, state: previous ? resetPrivatePlacementFailureStateV1(previous) : null };
  }

  #restoreFailureHistory(entry: RetryEntry): boolean {
    if (entry.failureHistoryRead) return true;
    try {
      entry.retry.restore(this.#dependencies.readPrivateFailure(entry.repair), Date.now());
      entry.failureHistoryRead = true;
      return true;
    } catch { return false; } // Unread hints cannot park owed work or authorize overwriting old evidence.
  }

  /** Persist the prepared evidence before fencing any loaded scheduling generation. */
  #commitResets(resets: readonly ResetPlan[]): void {
    const writes = resets.filter((reset): reset is ResetPlan & Rfc64PrivatePlacementFailureWriteV1 => reset.state !== null);
    if (writes.length) this.#dependencies.writePrivateFailures(writes.map(({ repair, state }) => ({ repair, state })));
    // Lane resets also fence loaded entries that have not recorded a failure yet.
    for (const { key, state } of resets) {
      const entry = this.#retries.get(key);
      if (entry) { entry.retry.retryNow(state); entry.failureHistoryRead = true; }
    }
  }

  #releaseLaneWaiters(lane: GraphLane, inFlightKey?: string): void {
    // Waiters are few; a lane can hold thousands of parked siblings (GH#3134).
    for (const key of this.#waiters.keys()) {
      const entry = this.#retries.get(key);
      if (entry !== undefined && key !== inFlightKey && lane.entries.has(entry)) this.#waiters.release(key);
    }
  }

  /** One graph's authority, read once between awaits of a pass (GH#3134). */
  #graphRead(contextGraphId: string, pass: PassState): GraphRead {
    let read = pass.graphs.get(contextGraphId);
    if (read === undefined) {
      const authority = this.#readAuthority(contextGraphId);
      read = { authority, revision: laneRevisionV1(authority), decisionInput: finalizedPlacementDecisionInputV1(authority), blocked: false };
      pass.graphs.set(contextGraphId, read);
    }
    return read;
  }

  /** The marker's decision under `read`; one made under an available authority is kept while it reads the same. */
  #decision(entry: RetryEntry, repair: Rfc64FinalizedPrivatePlacementRepairV1, read: GraphRead): MarkerDecisionV1 {
    const input = read.decisionInput;
    if (input !== undefined && entry.decided?.input === input) return entry.decided.decision;
    const decision = resolveFinalizedPlacementDecisionV1(repair, () => read.authority);
    entry.decided = input === undefined ? undefined : Object.freeze({ input, decision });
    return decision;
  }

  /** Graph authority resets commit before independently classifying marker compatibility. */
  #reconcileLane(entry: RetryEntry, repair: Rfc64FinalizedPrivatePlacementRepairV1, pass: PassState, inFlightKey?: string): LaneReconciliation {
    const contextGraphId = repair.contextGraphId;
    if (pass.blockedGraphs.has(contextGraphId)) return BLOCKED;
    const read = this.#graphRead(contextGraphId, pass);
    if (read.blocked) return BLOCKED;
    const lane = this.#lanes.get(contextGraphId)!;
    if (read.authority.status === 'unavailable' && lane.resetPending) {
      this.#releaseLaneWaiters(lane, inFlightKey);
      // Until the next await nothing reads differently or adds a waiter.
      read.blocked = true;
      return BLOCKED;
    }
    try {
      const resetCommitted = this.#commitLaneReset(lane, read.revision);
      return { kind: 'decision', decision: this.#decision(entry, repair, read), resetCommitted };
    } catch (error) {
      pass.blockedGraphs.add(contextGraphId);
      this.#releaseLaneWaiters(lane, inFlightKey);
      this.#warn('catalog_private_repair_lane_reset_failed', error);
      return BLOCKED;
    }
  }

  async #runPass(signal: AbortSignal): Promise<void> {
    const timing = this.#options.timing();
    const arrivedDuringListing = new Map<string, ContextGraphIdV1>();
    this.#arrivedDuringListing = arrivedDuringListing;
    timing.passReading();
    const repairs = await this.#dependencies.listFinalizedPrivateRepairsAsync(signal);
    const checkpoint = createMainThreadTimeSlice({ sliceMs: 8, maxIterations: 32 });
    const queued: Array<{ repair: Rfc64FinalizedPrivatePlacementRepairV1; key: string }> = [];
    const currentKeys = new Set<string>();
    for (const repair of repairs) {
      if (signal.aborted) return;
      const key = finalizedPrivateRepairKeyV1(repair);
      queued.push({ repair, key });
      currentKeys.add(key);
      const pause = checkpoint();
      if (pause) await pause;
    }
    if (signal.aborted) return;
    this.#arrivedDuringListing = undefined;
    timing.passStarted(currentKeys);
    for (const key of arrivedDuringListing.keys()) timing.owed(key);
    // Establish every queued sibling before the first awaited placement. A lane
    // notification during that attempt must also reset later parked siblings.
    for (const { repair, key } of queued) this.#entry(repair, key);
    for (const key of this.#retries.keys()) if (!currentKeys.has(key)) this.#forget(key, true);
    // One lane record owns observed revisions, including before discovery. A
    // successful snapshot retires absent graphs unless a late request needs the
    // next snapshot; failed listings leave observations intact.
    const arrivingGraphs = new Set<string>(arrivedDuringListing.values());
    for (const [graph, lane] of this.#lanes) {
      if (lane.entries.size === 0 && !arrivingGraphs.has(graph)) this.#lanes.delete(graph);
    }
    for (const key of this.#waiters.keys()) if (!currentKeys.has(key) && !arrivedDuringListing.has(key)) this.#waiters.release(key);
    this.#options.fullCatalogs.passStarted(currentKeys);
    const pass: PassState = { blockedGraphs: new Set(), graphs: new Map() };
    // A parked marker needs no await of its own: a graph's authority is read once between two
    // awaits, the checkpoint's turns and the attempts (GH#3134).
    for (const { repair, key } of queued) {
      const pause = checkpoint();
      if (pause) { await pause; pass.graphs.clear(); }
      if (signal.aborted) return;
      const entry = this.#entry(repair, key);
      // Read durable hints inside the sliced loop. Lane resets still read any
      // not-yet-restored sibling before committing the complete reset batch.
      this.#restoreFailureHistory(entry);
      const lane = this.#reconcileLane(entry, repair, pass);
      if (lane.kind === 'blocked') continue;
      // Capacity still owns admission and wakeups, even after a durable scheduling reset.
      if (this.#options.fullCatalogs.park(key, repair, lane.decision.capacityScope)) { this.#waiters.release(key); continue; }
      if (entry.retry.parked) { this.#waiters.release(key); continue; }
      if (!entry.retry.eligible(Date.now())) {
        timing.cooldownSkipped(); this.#waiters.cooldownSkipped(key); continue;
      }
      const attemptGeneration = entry.retry.generation;
      entry.attempts += 1;
      const placement = timing.admit(key);
      try {
        // No await separates the reconciled authority from admission.
        if (lane.decision.status === 'inactive') throw new CatalogRepairLaneInactiveErrorV1();
        if (lane.decision.status === 'unavailable') throw lane.decision.error;
        await withDefaultStoreWorkPriority('background', () => this.#dependencies.repairFinalizedPrivatePlacement(repair, placement.attempt));
        placement.end('completed');
        this.#forget(key);
      } catch (error) {
        placement.end('failed');
        // The attempt may have awaited: its outcome is judged on the lane as it reads now.
        pass.graphs.clear();
        if (!signal.aborted) {
          const afterAttempt = this.#reconcileLane(entry, repair, pass, key);
          if (afterAttempt.kind === 'blocked') continue;
          if (afterAttempt.resetCommitted) this.#runner.request();
          if (attemptGeneration !== entry.retry.generation) continue;
          const historyRead = this.#restoreFailureHistory(entry);
          const capacityOwned = this.#options.fullCatalogs.placementRefused(key, repair, error, afterAttempt.decision.capacityScope);
          const recorded = capacityOwned
            ? entry.retry.recordCapacityFailure(attemptGeneration, Date.now())
            : entry.retry.fail(attemptGeneration, Date.now(), this.#options.retryIntervalMs, catalogRepairDiagnosticV1(error).kind);
          if (recorded) {
            try {
              if (!historyRead) throw new Error('Private placement failure history is unread');
              this.#dependencies.writePrivateFailures([{ repair, state: entry.retry.snapshot()! }]);
            }
            catch { this.#warnFailure(new CatalogRepairConditionErrorV1('persistence_unavailable',
              'Private placement failure history could not persist; owed work is retained'), entry); }
          }
          if (!capacityOwned) this.#warnFailure(error, entry);
        }
      } finally { pass.graphs.clear(); this.#waiters.release(key, placement); }
    }
  }

  #scheduleWaiterWake(minimumDelayMs: number): void {
    clearTimeout(this.#waiterTimer); this.#waiterTimer = undefined;
    if (this.closed) return;
    let earliest = Infinity;
    for (const key of this.#waiters.keys()) earliest = Math.min(earliest, this.#retries.get(key)?.retry.nextAttemptAtMs ?? Date.now());
    if (!Number.isFinite(earliest)) return;
    this.#waiterTimer = setTimeout(() => {
      this.#waiterTimer = undefined;
      if (!this.closed) this.#runner.request();
    }, Math.min(2_147_483_647, Math.max(minimumDelayMs, earliest - Date.now())));
    this.#waiterTimer.unref?.();
  }

  #warn(event: string, error: unknown): void {
    try { this.#dependencies.warn(this.#options.ctx, JSON.stringify({ event, diagnostic: catalogRepairDiagnosticV1(error) })); }
    catch { /* Diagnostics cannot alter lifecycle behavior. */ }
  }

  #warnFailure(error: unknown, entry: RetryEntry): void {
    try { this.#dependencies.warn(createOperationContext('system'), JSON.stringify({ event: 'catalog_private_repair_failed',
      diagnostic: catalogRepairDiagnosticV1(error), attempt: entry.attempts,
      consecutiveFailures: entry.retry.consecutiveFailures, nextAttemptAtMs: entry.retry.nextAttemptAtMs })); }
    catch { /* Diagnostics cannot alter repair state or waiter settlement. */ }
  }
}

function laneRevisionV1(authority: FinalizedPlacementAuthorityV1): string | undefined {
  const hint = finalizedPlacementAuthorityRevisionV1(authority);
  return hint === undefined ? undefined : JSON.stringify(hint);
}
