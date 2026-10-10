// SPDX-License-Identifier: Apache-2.0

/** Restart-safe local SWM-inventory to catalog projection supervisor. */

import {
  assertCanonicalEvmAddress,
  assertContextGraphIdV1,
  createOperationContext,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { withDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { Rfc64CatalogBootstrapPartitionV1 } from
  './dkg-agent-rfc64-catalog-bootstrap.js';
import { mapWithConcurrency } from './map-with-concurrency.js';
import type { Rfc64CatalogWorkloadOwnerV1 } from './rfc64/catalog-runtime-v1.js';
import { CoalescingRecurringTask } from './coalescing-recurring-task.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from
  './rfc64/finalized-private-placement-repair-store-v1.js';
import {
  catalogRepairDiagnosticV1,
  catalogRepairErrorSummaryV1,
  CatalogRepairLaneInactiveErrorV1,
  type CatalogRepairDiagnosticV1,
} from './rfc64/catalog-repair-diagnostics-v1.js';
import { CatalogRepairRetryV1, type CatalogRepairRevisionHintV1 } from './rfc64/catalog-repair-retry-v1.js';
import {
  catalogPlacementTimingV1,
  type CatalogPlacementAttemptV1,
  type CatalogPlacementTimingV1,
  type CatalogPlacementWaiterObserverV1,
  type FinalizedPrivatePlacementQueueStatusV1,
} from './internal/catalog-placement-timing.js';
import { FinalizedPrivatePlacementWaitersV1 } from './internal/finalized-private-placement-waiters.js';

// Match the default background store lane; repair fanout must not flood its queue.
const MAX_CONCURRENT_REPAIRS_V1 = 1;
const DEFAULT_PROJECTION_RETRY_INTERVAL_MS_V1 = 5_000;

export type Rfc64PublicCatalogAuthorRepairOutcomeV1 =
  | 'pending'
  | 'reconciled'
  | 'no-inventory'
  | 'failed';

export interface Rfc64PublicCatalogAuthorRepairStatusV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly authorAddress: EvmAddressV1;
  readonly outcome: Rfc64PublicCatalogAuthorRepairOutcomeV1;
  readonly attempts: number;
  readonly inventoryHeadObjectDigest: Digest32V1 | null;
  readonly catalogVersion: string | null;
  readonly inventoryRowCount: string | null;
  readonly lastError: string | null;
  readonly updatedAtMs: number | null;
  readonly diagnostic: Readonly<CatalogRepairDiagnosticV1> | null;
  readonly consecutiveFailures: number;
  readonly nextAttemptAtMs: number | null;
}

export interface Rfc64SwmCatalogProjectionSupervisorStatusV1 {
  readonly running: boolean;
  readonly pass: number;
  readonly retryIntervalMs: number;
  readonly lastPassStartedAtMs: number | null;
  readonly lastPassCompletedAtMs: number | null;
  readonly repairs: readonly Rfc64PublicCatalogAuthorRepairStatusV1[];
  /** GH#3081 — aggregate finalized-private queue evidence; observation only. */
  readonly finalizedPrivatePlacement: Readonly<FinalizedPrivatePlacementQueueStatusV1>;
}

interface MutableAuthorRepairStatusV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly authorAddress: EvmAddressV1;
  outcome: Rfc64PublicCatalogAuthorRepairOutcomeV1;
  attempts: number;
  inventoryHeadObjectDigest: Digest32V1 | null;
  catalogVersion: string | null;
  inventoryRowCount: string | null;
  lastError: string | null;
  updatedAtMs: number | null;
  dirty: boolean;
  pendingMutationRequest: boolean;
  diagnostic: Readonly<CatalogRepairDiagnosticV1> | null;
  readonly retry: CatalogRepairRetryV1;
}

interface ProjectionSupervisorStateV1 {
  readonly retryIntervalMs?: number;
  readonly repairs: MutableAuthorRepairStatusV1[];
  readonly runner: CoalescingRecurringTask;
  publicMutationTimer: ReturnType<typeof setTimeout> | undefined;
  readonly finalizedPrivateRunner: CoalescingRecurringTask;
  readonly finalizedPrivateWaiters: FinalizedPrivatePlacementWaitersV1;
  finalizedPrivateWaiterTimer: ReturnType<typeof setTimeout> | undefined;
  readonly finalizedPrivateRetries: Map<string, {
    readonly contextGraphId: ContextGraphIdV1;
    retry: CatalogRepairRetryV1;
    attempts: number;
  }>;
  pass: number;
  lastPassStartedAtMs: number | null;
  lastPassCompletedAtMs: number | null;
}

type ProjectionReconciliationV1 = Awaited<ReturnType<
  DKGAgent['reconcileRfc64PublicCatalogFromSwmInventoryV1']
>>;

export interface Rfc64FinalizedPrivatePlacementRepairRequestV1 {
  readonly accepted: boolean;
  /** Settles after this exact repair's first admitted attempt, independent of other work. */
  readonly whenAttempted: Promise<void>;
}

interface ProjectionOwnerDependenciesV1 {
  readonly resolvePartition: () => Rfc64CatalogBootstrapPartitionV1 | undefined;
  readonly listLocalAuthorAddresses: () => readonly EvmAddressV1[];
  readonly acceptsPublicRootLane: (contextGraphId: ContextGraphIdV1) => boolean;
  readonly acceptsFinalizedPrivateLane: (contextGraphId: ContextGraphIdV1) => boolean;
  readonly readRepairRevision: (
    contextGraphId: ContextGraphIdV1, authorAddress: EvmAddressV1,
  ) => CatalogRepairRevisionHintV1 | null;
  readonly listFinalizedPrivateRepairs: () => readonly Readonly<
    Rfc64FinalizedPrivatePlacementRepairV1
  >[];
  /** `placement` is the admitted attempt's recorder (GH#3081, observation only). */
  readonly repairFinalizedPrivatePlacement: (
    repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
    placement: CatalogPlacementAttemptV1,
  ) => Promise<void>;
  readonly reconcile: (params: Readonly<{
    readonly contextGraphId: ContextGraphIdV1;
    readonly authorAddress: EvmAddressV1;
    readonly signal: AbortSignal;
  }>) => Promise<ProjectionReconciliationV1>;
  readonly warn: (ctx: OperationContext, message: string) => void;
  /** GH#3081 — the placement timing to record into, resolved at each use; the owner's own by default. */
  readonly placementTiming?: () => CatalogPlacementTimingV1;
}

/** Feature-local owner for projection admission, mutable repair state, and its runner. */
export class Rfc64SwmCatalogProjectionOwnerV1 implements Rfc64CatalogWorkloadOwnerV1 {
  readonly #dependencies: ProjectionOwnerDependenciesV1;
  readonly #timing: () => CatalogPlacementTimingV1;
  #state: ProjectionSupervisorStateV1 | undefined;
  #admissionClosed = false;

  constructor(dependencies: ProjectionOwnerDependenciesV1) {
    this.#dependencies = dependencies;
    this.#timing = dependencies.placementTiming ?? (() => catalogPlacementTimingV1(this));
  }

  /** Observe a real inactive edge without reopening admission or starting work. */
  observeLaneAvailability(contextGraphId: string): void {
    if (this.#admissionClosed || this.#state === undefined) return;
    for (const repair of this.#state.repairs) {
      if (repair.contextGraphId !== contextGraphId) continue;
      try {
        if (!this.#dependencies.acceptsPublicRootLane(repair.contextGraphId)) {
          repair.retry.observe(null);
        }
      } catch { /* Scheduling hints must not reject a subscription transition. */ }
    }
    for (const entry of this.#state.finalizedPrivateRetries.values()) {
      if (entry.contextGraphId !== contextGraphId) continue;
      try {
        if (!this.#dependencies.acceptsFinalizedPrivateLane(entry.contextGraphId)) {
          entry.retry.observe(null);
        }
      } catch { /* The periodic admission check remains authoritative. */ }
    }
  }

  start(ctx: OperationContext): void {
    this.#admissionClosed = false;
    const partition = this.#dependencies.resolvePartition();
    const localAuthors = this.#dependencies.listLocalAuthorAddresses();
    const repairKeys = new Set<string>();
    const repairs = (partition?.track2Policies ?? []).flatMap(
      ({ policyEnvelope }): MutableAuthorRepairStatusV1[] => {
        const contextGraphId = policyEnvelope.payload.contextGraphId as ContextGraphIdV1;
        if (!this.#dependencies.acceptsPublicRootLane(contextGraphId)) return [];
        return localAuthors.flatMap((authorAddress) => {
          const key = `${contextGraphId}\n${authorAddress}`;
          if (repairKeys.has(key)) return [];
          repairKeys.add(key);
          return [newPendingRepairV1(contextGraphId, authorAddress)];
        });
      },
    );
    const hasFinalizedPrivateRepairs = this.#dependencies.listFinalizedPrivateRepairs().length > 0;
    const existing = this.#state;
    if (existing !== undefined) {
      if (existing.runner.closed || existing.finalizedPrivateRunner.closed) return;
      let publicRepairRequested = false;
      for (const repair of repairs) {
        const current = existing.repairs.find((candidate) => (
          candidate.contextGraphId === repair.contextGraphId
          && candidate.authorAddress === repair.authorAddress
        ));
        if (current === undefined) {
          existing.repairs.push(repair);
          publicRepairRequested = true;
        }
      }
      for (const current of existing.repairs) {
        const changed = this.#observeRevision(current.retry, current.contextGraphId, current.authorAddress);
        if (changed) {
          current.pendingMutationRequest = true;
          current.dirty = true;
          publicRepairRequested = true;
        }
        if ((changed || current.outcome === 'failed') && current.retry.eligible(Date.now())) {
          current.dirty = true;
          publicRepairRequested = true;
        }
      }
      if (publicRepairRequested) existing.runner.request();
      if (hasFinalizedPrivateRepairs) existing.finalizedPrivateRunner.request();
      return;
    }
    if (repairs.length === 0 && !hasFinalizedPrivateRepairs) return;
    const retryIntervalMs = partition?.retryIntervalMs
      ?? DEFAULT_PROJECTION_RETRY_INTERVAL_MS_V1;
    this.#state = this.#createState(
      retryIntervalMs,
      retryIntervalMs,
      repairs,
      ctx,
    );
    if (repairs.length > 0) this.#state.runner.request();
    if (hasFinalizedPrivateRepairs) this.#state.finalizedPrivateRunner.request();
  }

  request(params: Readonly<{
    readonly contextGraphId: ContextGraphIdV1;
    readonly authorAddress: EvmAddressV1;
    readonly ctx: OperationContext;
  }>): boolean {
    if (this.#admissionClosed) return false;
    if (!this.#dependencies.acceptsPublicRootLane(params.contextGraphId)) {
      this.#state?.repairs.find((repair) => repair.contextGraphId === params.contextGraphId
        && repair.authorAddress === params.authorAddress)?.retry.observe(null);
      return false;
    }
    let state = this.#state;
    if (state === undefined) {
      const retryIntervalMs = this.#dependencies.resolvePartition()?.retryIntervalMs
        ?? DEFAULT_PROJECTION_RETRY_INTERVAL_MS_V1;
      state = this.#createState(
        retryIntervalMs,
        retryIntervalMs,
        [],
        params.ctx,
      );
      this.#state = state;
    }
    if (state.runner.closed) return false;
    let repair = state.repairs.find(
      (candidate) => candidate.contextGraphId === params.contextGraphId
        && candidate.authorAddress === params.authorAddress,
    );
    if (repair === undefined) {
      repair = newPendingRepairV1(params.contextGraphId, params.authorAddress);
      state.repairs.push(repair);
    }
    const changed = this.#observeRevision(repair.retry, repair.contextGraphId, repair.authorAddress);
    if (changed === undefined || changed) {
      repair.pendingMutationRequest = true;
      repair.dirty = true;
    }
    if (!repair.retry.eligible(Date.now())) {
      // A cheap pass arms the pending mutation's deadline without admitting
      // canonical store work before the unchanged failure cooldown expires.
      if (repair.pendingMutationRequest) state.runner.request();
      return true;
    }
    repair.dirty = true;
    return state.runner.request();
  }

  /** Enqueue one already-durable chain-confirmed private placement transition. */
  requestFinalizedPrivate(params: Readonly<{
    readonly repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>;
    readonly ctx: OperationContext;
    /** GH#3081 — told about this waiter's cooldown skips and the attempt that releases it. */
    readonly observer?: CatalogPlacementWaiterObserverV1;
  }>): Rfc64FinalizedPrivatePlacementRepairRequestV1 {
    const rejected = (): Rfc64FinalizedPrivatePlacementRepairRequestV1 => Object.freeze({
      accepted: false,
      whenAttempted: Promise.resolve(),
    });
    if (this.#admissionClosed) return rejected();
    if (!this.#dependencies.acceptsFinalizedPrivateLane(params.repair.contextGraphId)) {
      this.#state?.finalizedPrivateRetries.get(finalizedPrivateRepairKeyV1(params.repair))
        ?.retry.observe(null);
      return rejected();
    }
    let state = this.#state;
    if (state === undefined) {
      const retryIntervalMs = this.#dependencies.resolvePartition()?.retryIntervalMs
        ?? DEFAULT_PROJECTION_RETRY_INTERVAL_MS_V1;
      state = this.#createState(retryIntervalMs, retryIntervalMs, [], params.ctx);
      this.#state = state;
    }
    if (state.finalizedPrivateRunner.closed) return rejected();
    const key = finalizedPrivateRepairKeyV1(params.repair);
    const waiter = state.finalizedPrivateWaiters.add(key, this.#timing().now(), params.observer);
    if (!state.finalizedPrivateRunner.request()) {
      waiter.withdraw();
      return rejected();
    }
    return Object.freeze({ accepted: true, whenAttempted: waiter.whenAttempted });
  }

  status(): Readonly<Rfc64SwmCatalogProjectionSupervisorStatusV1> | null {
    const state = this.#state;
    if (state === undefined) return null;
    return Object.freeze({
      running: state.runner.running || state.finalizedPrivateRunner.running,
      pass: state.pass,
      retryIntervalMs: state.retryIntervalMs ?? 0,
      lastPassStartedAtMs: state.lastPassStartedAtMs,
      lastPassCompletedAtMs: state.lastPassCompletedAtMs,
      repairs: Object.freeze(state.repairs.map(({
        dirty: _dirty, pendingMutationRequest: _pendingMutationRequest, retry, ...repair
      }) => (
        Object.freeze({ ...repair, consecutiveFailures: retry.consecutiveFailures,
          nextAttemptAtMs: retry.nextAttemptAtMs })
      ))),
      finalizedPrivatePlacement: this.#timing().queueStatus(
        state.finalizedPrivateWaiters.summary(),
        state.finalizedPrivateRunner.running,
      ),
    });
  }

  async whenIdle(): Promise<void> {
    const state = this.#state;
    if (state === undefined) return;
    await Promise.all([state.runner.whenIdle(), state.finalizedPrivateRunner.whenIdle()]);
  }

  async close(): Promise<void> {
    this.#admissionClosed = true;
    const state = this.#state;
    if (state === undefined) return;
    clearTimeout(state.publicMutationTimer);
    state.publicMutationTimer = undefined;
    clearTimeout(state.finalizedPrivateWaiterTimer);
    state.finalizedPrivateWaiterTimer = undefined;
    await Promise.all([state.runner.close(), state.finalizedPrivateRunner.close()]);
    state.finalizedPrivateWaiters.releaseAll();
    state.finalizedPrivateRetries.clear();
    this.#state = undefined;
  }

  #createState(
    retryIntervalMs: number | undefined,
    finalizedPrivateRetryIntervalMs: number,
    repairs: MutableAuthorRepairStatusV1[],
    ctx: OperationContext,
  ): ProjectionSupervisorStateV1 {
    let state!: ProjectionSupervisorStateV1;
    const runner = new CoalescingRecurringTask({
      retryIntervalMs,
      runPass: async (signal) => {
        try {
          await this.#runPass(state, signal);
        } finally {
          this.#schedulePublicMutationWake(state);
        }
      },
      onError: (error) => {
        this.#dependencies.warn(
          ctx,
          JSON.stringify({ event: 'catalog_repair_pass_failed', diagnostic: catalogRepairDiagnosticV1(error) }),
        );
      },
      beforePeriodicPass: () => {
        // Live inventory mutations already dirty their exact scope. The timer
        // is the bounded liveness path for failures, not a reason to rebuild
        // every healthy catalog from its complete inventory every five seconds.
        for (const repair of state.repairs) {
          if (repair.outcome !== 'failed') continue;
          this.#observeRevision(repair.retry, repair.contextGraphId, repair.authorAddress);
          if (repair.retry.eligible(Date.now())) repair.dirty = true;
        }
      },
      closingMessage: 'RFC-64 SWM catalog projection closing',
    });
    const finalizedPrivateRunner = new CoalescingRecurringTask({
      retryIntervalMs: finalizedPrivateRetryIntervalMs,
      runPass: async (signal) => {
        let failed = false;
        try {
          await this.#runFinalizedPrivatePass(state, signal);
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          this.#timing().passEnded();
          // A failed durable queue read must not spin on an already-due waiter.
          this.#schedulePrivateWaiterWake(state, failed
            ? (finalizedPrivateRetryIntervalMs > 0
              ? finalizedPrivateRetryIntervalMs : DEFAULT_PROJECTION_RETRY_INTERVAL_MS_V1)
            : 0);
        }
      },
      onError: (error) => {
        this.#dependencies.warn(
          ctx,
          JSON.stringify({ event: 'catalog_private_repair_pass_failed', diagnostic: catalogRepairDiagnosticV1(error) }),
        );
      },
      closingMessage: 'RFC-64 finalized-private placement repair closing',
    });
    state = {
      retryIntervalMs,
      repairs,
      runner,
      publicMutationTimer: undefined,
      finalizedPrivateRunner,
      finalizedPrivateWaiters: new FinalizedPrivatePlacementWaitersV1(),
      finalizedPrivateWaiterTimer: undefined,
      finalizedPrivateRetries: new Map(),
      pass: 0,
      lastPassStartedAtMs: null,
      lastPassCompletedAtMs: null,
    };
    return state;
  }

  async #runPass(state: ProjectionSupervisorStateV1, signal: AbortSignal): Promise<void> {
    const pending = state.repairs.filter((repair) => repair.dirty && repair.retry.eligible(Date.now()));
    if (pending.length === 0) return;
    for (const repair of pending) repair.dirty = false;
    state.pass += 1;
    state.lastPassStartedAtMs = Date.now();
    try {
      await mapWithConcurrency(pending, MAX_CONCURRENT_REPAIRS_V1, async (repair) => {
        if (signal.aborted) return;
        await this.#reconcile(repair, state.retryIntervalMs, signal);
      });
    } finally {
      state.lastPassCompletedAtMs = Date.now();
    }
  }

  async #runFinalizedPrivatePass(
    state: ProjectionSupervisorStateV1,
    signal: AbortSignal,
  ): Promise<void> {
    const repairs = this.#dependencies.listFinalizedPrivateRepairs();
    this.#timing().passStarted(repairs.length);
    const currentKeys = new Set(repairs.map(finalizedPrivateRepairKeyV1));
    for (const key of state.finalizedPrivateRetries.keys()) {
      if (!currentKeys.has(key)) state.finalizedPrivateRetries.delete(key);
    }
    for (const key of state.finalizedPrivateWaiters.keys()) {
      if (!currentKeys.has(key)) state.finalizedPrivateWaiters.release(key);
    }
    await mapWithConcurrency(repairs, MAX_CONCURRENT_REPAIRS_V1, async (repair) => {
      if (signal.aborted) return;
      const key = finalizedPrivateRepairKeyV1(repair);
      let entry = state.finalizedPrivateRetries.get(key);
      if (entry === undefined) {
        entry = { contextGraphId: repair.contextGraphId, retry: new CatalogRepairRetryV1(), attempts: 0 };
        state.finalizedPrivateRetries.set(key, entry);
      }
      this.#observePrivateLane(entry.retry, repair.contextGraphId);
      if (!entry.retry.eligible(Date.now())) {
        this.#timing().cooldownSkipped();
        state.finalizedPrivateWaiters.cooldownSkipped(key);
        return;
      }
      const attemptGeneration = entry.retry.generation;
      entry.attempts += 1;
      const placement = this.#timing().admit();
      try {
        if (!this.#dependencies.acceptsFinalizedPrivateLane(repair.contextGraphId)) {
          throw new CatalogRepairLaneInactiveErrorV1();
        }
        await withDefaultStoreWorkPriority('background', () => (
          this.#dependencies.repairFinalizedPrivatePlacement(repair, placement.attempt)
        ));
        placement.end('completed');
        state.finalizedPrivateRetries.delete(key);
      } catch (error) {
        placement.end('failed');
        if (!signal.aborted) {
          const changed = this.#observePrivateLane(entry.retry, repair.contextGraphId);
          entry.retry.fail(attemptGeneration, Date.now(), state.retryIntervalMs, catalogRepairDiagnosticV1(error).kind);
          if (changed) state.finalizedPrivateRunner.request();
          this.#warnFailure('catalog_private_repair_failed', error, entry.attempts, entry.retry);
        }
      } finally {
        state.finalizedPrivateWaiters.release(key, placement);
      }
    });
  }

  /** Retain changed or unknown explicit mutations through cooldown, even in one-pass mode. */
  #schedulePublicMutationWake(state: ProjectionSupervisorStateV1): void {
    clearTimeout(state.publicMutationTimer);
    state.publicMutationTimer = undefined;
    if (this.#state !== state || this.#admissionClosed || state.runner.closed) return;
    let earliest = Infinity;
    for (const repair of state.repairs) {
      if (repair.pendingMutationRequest) {
        earliest = Math.min(earliest, repair.retry.nextAttemptAtMs ?? Date.now());
      }
    }
    if (!Number.isFinite(earliest)) return;
    state.publicMutationTimer = setTimeout(() => {
      state.publicMutationTimer = undefined;
      if (this.#state !== state || this.#admissionClosed || state.runner.closed) return;
      for (const repair of state.repairs) {
        if (repair.pendingMutationRequest) repair.dirty = true;
      }
      state.runner.request();
    }, Math.min(2_147_483_647, Math.max(0, earliest - Date.now())));
    state.publicMutationTimer.unref?.();
  }

  /** Accepted cooldown requests need one wake even when periodic retries are disabled. */
  #schedulePrivateWaiterWake(state: ProjectionSupervisorStateV1, minimumDelayMs: number): void {
    clearTimeout(state.finalizedPrivateWaiterTimer);
    state.finalizedPrivateWaiterTimer = undefined;
    if (this.#state !== state || this.#admissionClosed || state.finalizedPrivateRunner.closed) return;
    let earliest = Infinity;
    for (const key of state.finalizedPrivateWaiters.keys()) {
      const deadline = state.finalizedPrivateRetries.get(key)?.retry.nextAttemptAtMs;
      earliest = Math.min(earliest, deadline ?? Date.now());
    }
    if (!Number.isFinite(earliest)) return;
    state.finalizedPrivateWaiterTimer = setTimeout(() => {
      state.finalizedPrivateWaiterTimer = undefined;
      if (this.#state === state && !this.#admissionClosed && !state.finalizedPrivateRunner.closed) {
        state.finalizedPrivateRunner.request();
      }
    }, Math.min(2_147_483_647, Math.max(minimumDelayMs, earliest - Date.now())));
    state.finalizedPrivateWaiterTimer.unref?.();
  }

  #observePrivateLane(retry: CatalogRepairRetryV1, contextGraphId: ContextGraphIdV1): boolean {
    try {
      // Exact durable identity already partitions private retries. An unrelated
      // mutation of the author's inventory must not reset this repair's backoff.
      return retry.observe(this.#dependencies.acceptsFinalizedPrivateLane(contextGraphId) ? { scopeIdentity: 'finalized-private', headRevision: 'active' } : null);
    } catch {
      return false;
    }
  }

  #observeRevision(
    retry: CatalogRepairRetryV1,
    contextGraphId: ContextGraphIdV1,
    authorAddress: EvmAddressV1,
  ): boolean | undefined {
    try {
      const active = this.#dependencies.acceptsPublicRootLane(contextGraphId);
      return retry.observe(active
        ? this.#dependencies.readRepairRevision(contextGraphId, authorAddress) : null);
    } catch {
      // A hint failure must not reject the mutation caller or reset its cooldown.
      return undefined;
    }
  }

  #warnFailure(event: string, error: unknown, attempt: number, retry: CatalogRepairRetryV1): void {
    try {
      this.#dependencies.warn(createOperationContext('system'), JSON.stringify({
        event, diagnostic: catalogRepairDiagnosticV1(error), attempt,
        consecutiveFailures: retry.consecutiveFailures, nextAttemptAtMs: retry.nextAttemptAtMs,
      }));
    } catch { /* Diagnostics must not alter repair state or waiter settlement. */ }
  }

  async #reconcile(
    repair: MutableAuthorRepairStatusV1,
    retryIntervalMs: number | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    // Consume only at actual admission. A newer mutation received
    // during this attempt must survive both its success and failure paths.
    repair.pendingMutationRequest = false;
    this.#observeRevision(repair.retry, repair.contextGraphId, repair.authorAddress);
    const attemptGeneration = repair.retry.generation;
    repair.attempts += 1;
    try {
      if (!this.#dependencies.acceptsPublicRootLane(repair.contextGraphId)) {
        throw new CatalogRepairLaneInactiveErrorV1();
      }
      const reconciliation = await withDefaultStoreWorkPriority('background', () => this.#dependencies.reconcile({
        contextGraphId: repair.contextGraphId,
        authorAddress: repair.authorAddress,
        signal,
      }));
      if (signal.aborted) return;
      repair.retry.reset();
      repair.diagnostic = null;
      if (reconciliation === null) {
        Object.assign(repair, {
          outcome: 'no-inventory',
          inventoryHeadObjectDigest: null,
          catalogVersion: null,
          inventoryRowCount: null,
          lastError: null,
          updatedAtMs: Date.now(),
        });
        return;
      }
      Object.assign(repair, {
        outcome: 'reconciled',
        inventoryHeadObjectDigest: reconciliation.inventoryHeadObjectDigest,
        catalogVersion: reconciliation.appliedHead?.catalogVersion ?? null,
        inventoryRowCount:
          reconciliation.appliedHead?.inventoryRowCount
          ?? String(reconciliation.targetAssetCount),
        lastError: null,
        updatedAtMs: Date.now(),
      });
    } catch (error) {
      if (signal.aborted) return;
      const changed = this.#observeRevision(repair.retry, repair.contextGraphId, repair.authorAddress);
      if (changed) repair.pendingMutationRequest = true;
      if (repair.retry.fail(attemptGeneration, Date.now(), retryIntervalMs, catalogRepairDiagnosticV1(error).kind)) {
        // Duplicate same-head wakes received while this attempt was active do
        // not get to bypass the newly established failure deadline.
        repair.dirty = repair.pendingMutationRequest;
      } else {
        repair.dirty = true;
        // A head may change without an explicit notification while draining.
        if (changed) this.#state?.runner.request();
      }
      Object.assign(repair, {
        outcome: 'failed',
        inventoryHeadObjectDigest: null,
        catalogVersion: null,
        inventoryRowCount: null,
        lastError: catalogRepairErrorSummaryV1(error),
        diagnostic: catalogRepairDiagnosticV1(error),
        updatedAtMs: Date.now(),
      });
      this.#warnFailure('catalog_repair_failed', error, repair.attempts, repair.retry);
    }
  }
}

const projectionOwnersV1 = new WeakMap<DKGAgent, Rfc64SwmCatalogProjectionOwnerV1>();

export function bindRfc64SwmCatalogProjectionOwnerV1(
  agent: DKGAgent,
  owner: Rfc64SwmCatalogProjectionOwnerV1,
): Rfc64SwmCatalogProjectionOwnerV1 {
  if (projectionOwnersV1.has(agent)) {
    throw new Error('RFC-64 SWM catalog projection owner is already bound');
  }
  projectionOwnersV1.set(agent, owner);
  return owner;
}

function projectionOwnerV1(agent: DKGAgent): Rfc64SwmCatalogProjectionOwnerV1 {
  const owner = projectionOwnersV1.get(agent);
  if (owner === undefined) throw new Error('RFC-64 SWM catalog projection owner is not bound');
  return owner;
}

function newPendingRepairV1(
  contextGraphId: ContextGraphIdV1,
  authorAddress: EvmAddressV1,
): MutableAuthorRepairStatusV1 {
  return {
    contextGraphId,
    authorAddress,
    outcome: 'pending',
    attempts: 0,
    inventoryHeadObjectDigest: null,
    catalogVersion: null,
    inventoryRowCount: null,
    lastError: null,
    updatedAtMs: null,
    dirty: true,
    pendingMutationRequest: false,
    diagnostic: null,
    retry: new CatalogRepairRetryV1(),
  };
}

function finalizedPrivateRepairKeyV1(
  repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
): string {
  return JSON.stringify([
    repair.version,
    repair.contextGraphId,
    repair.authorAddress,
    repair.inventoryScope.networkId,
    repair.inventoryScope.contextGraphId,
    repair.inventoryScope.governanceChainId,
    repair.inventoryScope.governanceContractAddress,
    repair.inventoryScope.ownershipTransitionDigest,
    repair.inventoryScope.authorAddress,
    repair.inventoryScope.subGraphName,
    repair.inventoryScope.era,
    repair.assertionCoordinate,
    repair.kaUal,
    repair.assertionVersion,
    repair.sealDigest,
  ]);
}

export class Rfc64SwmCatalogProjectionSupervisorMethods extends DKGAgentBase {
  observeRfc64SwmCatalogProjectionLaneAvailabilityV1(
    this: DKGAgent,
    contextGraphId: string,
  ): void {
    // Subscription selection can be initialized before the workload is bound.
    projectionOwnersV1.get(this)?.observeLaneAvailability(contextGraphId);
  }

  /** Seed bounded local-author projection work from selected catalog scopes. */
  startRfc64SwmCatalogProjectionSupervisorV1(
    this: DKGAgent,
    ctx: OperationContext,
  ): void {
    projectionOwnerV1(this).start(ctx);
  }

  /**
   * Enqueue one already-admitted local author scope without waiting for catalog
   * signing, storage, or peer fan-out. Repeated requests coalesce onto the
   * latest durable inventory snapshot owned by this supervisor.
   */
  requestRfc64SwmCatalogProjectionV1(
    this: DKGAgent,
    params: Readonly<{
      readonly contextGraphId: ContextGraphIdV1;
      readonly authorAddress: EvmAddressV1;
      readonly ctx?: OperationContext;
    }>,
  ): boolean {
    assertContextGraphIdV1(params.contextGraphId, 'SWM catalog projection contextGraphId');
    const authorAddress = params.authorAddress.toLowerCase() as EvmAddressV1;
    assertCanonicalEvmAddress(authorAddress, 'SWM catalog projection authorAddress');
    return projectionOwnerV1(this).request({
      contextGraphId: params.contextGraphId,
      authorAddress,
      ctx: params.ctx ?? createOperationContext('system'),
    });
  }

  requestRfc64FinalizedPrivateCatalogPlacementRepairV1(
    this: DKGAgent,
    params: Readonly<{
      readonly repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>;
      readonly ctx?: OperationContext;
    }>,
  ): Rfc64FinalizedPrivatePlacementRepairRequestV1 {
    return projectionOwnerV1(this).requestFinalizedPrivate({
      repair: params.repair,
      ctx: params.ctx ?? createOperationContext('system'),
    });
  }

  /** The same request, whose waiter tells `observer` about its cooldown skips and releasing attempt. */
  protected requestObservedRfc64FinalizedPrivateCatalogPlacementRepairV1(
    this: DKGAgent,
    params: Readonly<{ readonly repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>; readonly ctx: OperationContext }>,
    observer: CatalogPlacementWaiterObserverV1,
  ): Rfc64FinalizedPrivatePlacementRepairRequestV1 {
    return projectionOwnerV1(this).requestFinalizedPrivate({ ...params, observer });
  }

  readRfc64SwmCatalogProjectionSupervisorStatusV1(
    this: DKGAgent,
  ): Readonly<Rfc64SwmCatalogProjectionSupervisorStatusV1> | null {
    return projectionOwnerV1(this).status();
  }

  async whenRfc64SwmCatalogProjectionSupervisorIdleV1(this: DKGAgent): Promise<void> {
    await projectionOwnerV1(this).whenIdle();
  }

  async closeRfc64SwmCatalogProjectionSupervisorV1(this: DKGAgent): Promise<void> {
    await projectionOwnerV1(this).close();
  }

}
