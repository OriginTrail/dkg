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

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { Rfc64CatalogBootstrapPartitionV1 } from
  './dkg-agent-rfc64-catalog-bootstrap.js';
import { mapWithConcurrency } from './map-with-concurrency.js';
import type { Rfc64CatalogWorkloadOwnerV1 } from './rfc64/catalog-runtime-v1.js';
import { Rfc64CoalescingSupervisorV1 } from
  './rfc64/coalescing-supervisor-v1.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from
  './rfc64/finalized-private-placement-repair-store-v1.js';
import {
  boundedRfc64SupervisorErrorV1,
  rfc64SupervisorErrorMessageV1,
} from './rfc64/supervisor-status-v1.js';

const MAX_CONCURRENT_REPAIRS_V1 = 4;
const FINALIZED_PRIVATE_RETRY_INTERVAL_MS_V1 = 5_000;

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
}

export interface Rfc64SwmCatalogProjectionSupervisorStatusV1 {
  readonly running: boolean;
  readonly pass: number;
  readonly retryIntervalMs: number;
  readonly lastPassStartedAtMs: number | null;
  readonly lastPassCompletedAtMs: number | null;
  readonly repairs: readonly Rfc64PublicCatalogAuthorRepairStatusV1[];
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
}

interface ProjectionSupervisorStateV1 {
  readonly retryIntervalMs?: number;
  readonly repairs: MutableAuthorRepairStatusV1[];
  readonly runner: Rfc64CoalescingSupervisorV1;
  readonly finalizedPrivateRunner: Rfc64CoalescingSupervisorV1;
  readonly finalizedPrivateAttemptWaiters: Map<string, Set<() => void>>;
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
  readonly listFinalizedPrivateRepairs: () => readonly Readonly<
    Rfc64FinalizedPrivatePlacementRepairV1
  >[];
  readonly repairFinalizedPrivatePlacement: (
    repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
  ) => Promise<void>;
  readonly reconcile: (params: Readonly<{
    readonly contextGraphId: ContextGraphIdV1;
    readonly authorAddress: EvmAddressV1;
    readonly signal: AbortSignal;
  }>) => Promise<ProjectionReconciliationV1>;
  readonly warn: (ctx: OperationContext, message: string) => void;
}

/** Feature-local owner for projection admission, mutable repair state, and its runner. */
export class Rfc64SwmCatalogProjectionOwnerV1 implements Rfc64CatalogWorkloadOwnerV1 {
  readonly #dependencies: ProjectionOwnerDependenciesV1;
  #state: ProjectionSupervisorStateV1 | undefined;
  #admissionClosed = false;

  constructor(dependencies: ProjectionOwnerDependenciesV1) {
    this.#dependencies = dependencies;
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
    if (repairs.length === 0 && !hasFinalizedPrivateRepairs) return;
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
        } else if (current.outcome === 'failed') {
          // Re-entering start is an authorization/subscription transition, not
          // a new inventory observation. Retry a failed repair, but do not turn
          // a completed no-inventory or reconciled result into duplicate work.
          current.dirty = true;
          publicRepairRequested = true;
        }
      }
      if (publicRepairRequested) existing.runner.request();
      if (hasFinalizedPrivateRepairs) existing.finalizedPrivateRunner.request();
      return;
    }
    const retryIntervalMs = partition?.retryIntervalMs;
    this.#state = this.#createState(
      retryIntervalMs,
      retryIntervalMs ?? FINALIZED_PRIVATE_RETRY_INTERVAL_MS_V1,
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
    if (!this.#dependencies.acceptsPublicRootLane(params.contextGraphId)) return false;
    let state = this.#state;
    if (state === undefined) {
      state = this.#createState(
        this.#dependencies.resolvePartition()?.retryIntervalMs,
        this.#dependencies.resolvePartition()?.retryIntervalMs
          ?? FINALIZED_PRIVATE_RETRY_INTERVAL_MS_V1,
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
    } else {
      repair.dirty = true;
    }
    return state.runner.request();
  }

  /** Enqueue one already-durable chain-confirmed private placement transition. */
  requestFinalizedPrivate(params: Readonly<{
    readonly repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>;
    readonly ctx: OperationContext;
  }>): Rfc64FinalizedPrivatePlacementRepairRequestV1 {
    const rejected = (): Rfc64FinalizedPrivatePlacementRepairRequestV1 => Object.freeze({
      accepted: false,
      whenAttempted: Promise.resolve(),
    });
    if (this.#admissionClosed) return rejected();
    if (!this.#dependencies.acceptsFinalizedPrivateLane(params.repair.contextGraphId)) {
      return rejected();
    }
    let state = this.#state;
    if (state === undefined) {
      const retryIntervalMs = this.#dependencies.resolvePartition()?.retryIntervalMs
        ?? FINALIZED_PRIVATE_RETRY_INTERVAL_MS_V1;
      state = this.#createState(retryIntervalMs, retryIntervalMs, [], params.ctx);
      this.#state = state;
    }
    if (state.finalizedPrivateRunner.closed) return rejected();
    const key = finalizedPrivateRepairKeyV1(params.repair);
    let settleAttempt!: () => void;
    const whenAttempted = new Promise<void>((resolve) => { settleAttempt = resolve; });
    const waiters = state.finalizedPrivateAttemptWaiters.get(key) ?? new Set<() => void>();
    waiters.add(settleAttempt);
    state.finalizedPrivateAttemptWaiters.set(key, waiters);
    if (!state.finalizedPrivateRunner.request()) {
      waiters.delete(settleAttempt);
      if (waiters.size === 0) state.finalizedPrivateAttemptWaiters.delete(key);
      settleAttempt();
      return rejected();
    }
    return Object.freeze({ accepted: true, whenAttempted });
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
      repairs: Object.freeze(state.repairs.map(({ dirty: _dirty, ...repair }) => (
        Object.freeze(repair)
      ))),
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
    await Promise.all([state.runner.close(), state.finalizedPrivateRunner.close()]);
    for (const waiters of state.finalizedPrivateAttemptWaiters.values()) {
      for (const settle of waiters) settle();
    }
    state.finalizedPrivateAttemptWaiters.clear();
    this.#state = undefined;
  }

  #createState(
    retryIntervalMs: number | undefined,
    finalizedPrivateRetryIntervalMs: number,
    repairs: MutableAuthorRepairStatusV1[],
    ctx: OperationContext,
  ): ProjectionSupervisorStateV1 {
    let state!: ProjectionSupervisorStateV1;
    const runner = new Rfc64CoalescingSupervisorV1({
      retryIntervalMs,
      runPass: (signal) => this.#runPass(state, signal),
      onError: (error) => {
        this.#dependencies.warn(
          ctx,
          `RFC-64 SWM catalog projection pass failed: ${rfc64SupervisorErrorMessageV1(error)}`,
        );
      },
      beforePeriodicPass: () => {
        for (const repair of state.repairs) repair.dirty = true;
      },
      closingMessage: 'RFC-64 SWM catalog projection closing',
    });
    const finalizedPrivateRunner = new Rfc64CoalescingSupervisorV1({
      retryIntervalMs: finalizedPrivateRetryIntervalMs,
      runPass: (signal) => this.#runFinalizedPrivatePass(state, signal),
      onError: (error) => {
        this.#dependencies.warn(
          ctx,
          `RFC-64 finalized-private repair pass failed: ${rfc64SupervisorErrorMessageV1(error)}`,
        );
      },
      closingMessage: 'RFC-64 finalized-private placement repair closing',
    });
    state = {
      retryIntervalMs,
      repairs,
      runner,
      finalizedPrivateRunner,
      finalizedPrivateAttemptWaiters: new Map(),
      pass: 0,
      lastPassStartedAtMs: null,
      lastPassCompletedAtMs: null,
    };
    return state;
  }

  async #runPass(state: ProjectionSupervisorStateV1, signal: AbortSignal): Promise<void> {
    const pending = state.repairs.filter((repair) => repair.dirty);
    if (pending.length === 0) return;
    for (const repair of pending) repair.dirty = false;
    state.pass += 1;
    state.lastPassStartedAtMs = Date.now();
    try {
      await mapWithConcurrency(pending, MAX_CONCURRENT_REPAIRS_V1, async (repair) => {
        if (signal.aborted) return;
        await this.#reconcile(repair, signal);
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
    await mapWithConcurrency(repairs, MAX_CONCURRENT_REPAIRS_V1, async (repair) => {
      const key = finalizedPrivateRepairKeyV1(repair);
      try {
        if (signal.aborted) return;
        await this.#dependencies.repairFinalizedPrivatePlacement(repair);
      } catch (error) {
        if (!signal.aborted) {
          this.#dependencies.warn(
            createOperationContext('system'),
            `RFC-64 finalized-private placement repair failed for ${repair.contextGraphId} / ${repair.kaUal}: ${boundedRfc64SupervisorErrorV1(error)}`,
          );
        }
      } finally {
        const waiters = state.finalizedPrivateAttemptWaiters.get(key);
        if (waiters !== undefined) {
          state.finalizedPrivateAttemptWaiters.delete(key);
          for (const settle of waiters) settle();
        }
      }
    });
  }

  async #reconcile(repair: MutableAuthorRepairStatusV1, signal: AbortSignal): Promise<void> {
    repair.attempts += 1;
    try {
      const reconciliation = await this.#dependencies.reconcile({
        contextGraphId: repair.contextGraphId,
        authorAddress: repair.authorAddress,
        signal,
      });
      if (signal.aborted) return;
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
      Object.assign(repair, {
        outcome: 'failed',
        inventoryHeadObjectDigest: null,
        catalogVersion: null,
        inventoryRowCount: null,
        lastError: boundedRfc64SupervisorErrorV1(error),
        updatedAtMs: Date.now(),
      });
      this.#dependencies.warn(
        createOperationContext('system'),
        `RFC-64 local SWM catalog projection failed for ${repair.contextGraphId} / ${repair.authorAddress}: ${rfc64SupervisorErrorMessageV1(error)}`,
      );
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
  };
}

function finalizedPrivateRepairKeyV1(
  repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
): string {
  return JSON.stringify([
    repair.contextGraphId,
    repair.authorAddress,
    repair.kaUal,
    repair.assertionVersion,
    repair.sealDigest,
  ]);
}

export class Rfc64SwmCatalogProjectionSupervisorMethods extends DKGAgentBase {
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
