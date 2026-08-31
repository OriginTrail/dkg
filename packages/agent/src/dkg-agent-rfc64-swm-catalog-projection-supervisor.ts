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
import {
  partitionRfc64CatalogBootstrapV1,
} from './dkg-agent-rfc64-catalog-bootstrap.js';
import type {
  Rfc64CatalogBootstrapConfigV1,
  Rfc64CatalogBootstrapPolicyV1,
  Rfc64PublicCatalogBootstrapConfigV1,
} from './dkg-agent-types.js';
import { mapWithConcurrency } from './map-with-concurrency.js';
import { Rfc64CoalescingSupervisorV1 } from
  './rfc64/coalescing-supervisor-v1.js';

const MAX_CONCURRENT_REPAIRS_V1 = 4;
const MAX_STATUS_ERROR_BYTES_V1 = 1024;
const UTF8 = new TextEncoder();

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

export interface ProjectionSupervisorStateV1 {
  readonly retryIntervalMs?: number;
  readonly repairs: MutableAuthorRepairStatusV1[];
  readonly ctx: OperationContext;
  readonly runner: Rfc64CoalescingSupervisorV1;
  pass: number;
  lastPassStartedAtMs: number | null;
  lastPassCompletedAtMs: number | null;
}

export class Rfc64SwmCatalogProjectionSupervisorMethods extends DKGAgentBase {
  /** Seed bounded local-author projection work from selected catalog scopes. */
  startRfc64SwmCatalogProjectionSupervisorV1(
    this: DKGAgent,
    ctx: OperationContext,
  ): void {
    // Same-instance restart reopens live admission even when no bootstrap
    // manifest exists and the first scope will arrive through SHARE.
    const config = this.resolveRuntimeRfc64ProjectionBootstrapConfigV1();
    if (config === undefined) return;
    const partition = partitionRfc64CatalogBootstrapV1(
      config,
      this.config.rfc64CatalogExecutionPlan,
    );
    const localAuthors = this.listLocalAgents().map(
      ({ agentAddress }) => agentAddress.toLowerCase() as EvmAddressV1,
    );
    // Remote discovery targets are not a local-author inventory manifest.
    // Derive the bounded restart plan from explicitly accepted catalog scopes
    // crossed with the node's finite local-agent registry instead. A missing
    // inventory is a cheap no-op, while an empty durable inventory must remain
    // discoverable so a post-VM retraction can be repaired after restart.
    const repairKeys = new Set<string>();
    const repairs = partition.track2Policies.flatMap(
      ({ policyEnvelope }): MutableAuthorRepairStatusV1[] => {
        const contextGraphId = policyEnvelope.payload.contextGraphId as ContextGraphIdV1;
        if (this.resolveRfc64CatalogAuthoringLaneV1(contextGraphId, null) === null) {
          return [];
        }
        return localAuthors.flatMap((authorAddress) => {
          const key = `${contextGraphId}\n${authorAddress}`;
          if (repairKeys.has(key)) return [];
          repairKeys.add(key);
          return [{
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
          }];
        });
      },
    );
    if (repairs.length === 0) return;
    const existing = this.rfc64CatalogRuntimeV1.readProjectionState();
    if (existing !== undefined) {
      if (existing.runner.closed) return;
      for (const repair of repairs) {
        if (existing.repairs.some((candidate) => (
          candidate.contextGraphId === repair.contextGraphId
          && candidate.authorAddress === repair.authorAddress
        ))) continue;
        existing.repairs.push(repair);
      }
      existing.runner.request();
      return;
    }
    let state!: ProjectionSupervisorStateV1;
    const runner = this.createRfc64SwmCatalogProjectionRunnerV1(
      () => state,
      partition.retryIntervalMs,
      ctx,
    );
    state = {
      retryIntervalMs: partition.retryIntervalMs,
      repairs,
      ctx,
      runner,
      pass: 0,
      lastPassStartedAtMs: null,
      lastPassCompletedAtMs: null,
    };
    this.rfc64CatalogRuntimeV1.writeProjectionState(state);
    runner.request();
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
    if (this.rfc64CatalogRuntimeV1.projectionAdmissionClosed) return false;
    assertContextGraphIdV1(params.contextGraphId, 'SWM catalog projection contextGraphId');
    const authorAddress = params.authorAddress.toLowerCase() as EvmAddressV1;
    assertCanonicalEvmAddress(authorAddress, 'SWM catalog projection authorAddress');
    // This entry point is internal to a mutation that already proved the
    // author seal and local signing capability. Startup discovery remains
    // restricted to registered local authors; live requests do not repeat a
    // registry check that can lag custodial author activation.
    if (this.resolveRfc64CatalogAuthoringLaneV1(params.contextGraphId, null) === null) {
      return false;
    }

    let state = this.rfc64CatalogRuntimeV1.readProjectionState();
    if (state === undefined) {
      const config = this.resolveRuntimeRfc64ProjectionBootstrapConfigV1();
      const retryIntervalMs = config === undefined
        ? undefined
        : partitionRfc64CatalogBootstrapV1(
          config,
          this.config.rfc64CatalogExecutionPlan,
        ).retryIntervalMs;
      let created!: ProjectionSupervisorStateV1;
      const runner = this.createRfc64SwmCatalogProjectionRunnerV1(
        () => created,
        retryIntervalMs,
        params.ctx ?? createOperationContext('system'),
      );
      created = {
        retryIntervalMs,
        repairs: [],
        ctx: params.ctx ?? createOperationContext('system'),
        runner,
        pass: 0,
        lastPassStartedAtMs: null,
        lastPassCompletedAtMs: null,
      };
      state = created;
      this.rfc64CatalogRuntimeV1.writeProjectionState(state);
    }
    if (state.runner.closed) return false;
    let repair = state.repairs.find(
      (candidate) => candidate.contextGraphId === params.contextGraphId
        && candidate.authorAddress === authorAddress,
    );
    if (repair === undefined) {
      repair = {
        contextGraphId: params.contextGraphId,
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
      state.repairs.push(repair);
    } else {
      repair.dirty = true;
    }
    return state.runner.request();
  }

  readRfc64SwmCatalogProjectionSupervisorStatusV1(
    this: DKGAgent,
  ): Readonly<Rfc64SwmCatalogProjectionSupervisorStatusV1> | null {
    const state = this.rfc64CatalogRuntimeV1.readProjectionState();
    if (state === undefined) return null;
    return Object.freeze({
      running: state.runner.running,
      pass: state.pass,
      retryIntervalMs: state.retryIntervalMs ?? 0,
      lastPassStartedAtMs: state.lastPassStartedAtMs,
      lastPassCompletedAtMs: state.lastPassCompletedAtMs,
      repairs: Object.freeze(state.repairs.map(({ dirty: _dirty, ...repair }) => (
        Object.freeze(repair)
      ))),
    });
  }

  async whenRfc64SwmCatalogProjectionSupervisorIdleV1(this: DKGAgent): Promise<void> {
    const state = this.rfc64CatalogRuntimeV1.readProjectionState();
    await state?.runner.whenIdle();
  }

  async closeRfc64SwmCatalogProjectionSupervisorV1(this: DKGAgent): Promise<void> {
    this.rfc64CatalogRuntimeV1.closeProjectionAdmission();
    const state = this.rfc64CatalogRuntimeV1.readProjectionState();
    if (state === undefined) return;
    await state.runner.close();
    this.rfc64CatalogRuntimeV1.clearProjectionState();
  }

  private createRfc64SwmCatalogProjectionRunnerV1(
    this: DKGAgent,
    resolveState: () => ProjectionSupervisorStateV1,
    retryIntervalMs: number | undefined,
    ctx: OperationContext,
  ): Rfc64CoalescingSupervisorV1 {
    return new Rfc64CoalescingSupervisorV1({
      retryIntervalMs,
      runPass: (signal) => this.runRfc64SwmCatalogProjectionPassV1(
        resolveState(),
        signal,
      ),
      onError: (error) => {
        this.log.warn(
          ctx,
          `RFC-64 SWM catalog projection pass failed: ${errorMessageV1(error)}`,
        );
      },
      beforePeriodicPass: () => {
        for (const repair of resolveState().repairs) repair.dirty = true;
      },
      closingMessage: 'RFC-64 SWM catalog projection closing',
    });
  }

  private async runRfc64SwmCatalogProjectionPassV1(
    this: DKGAgent,
    state: ProjectionSupervisorStateV1,
    signal: AbortSignal,
  ): Promise<void> {
    const pending = state.repairs.filter((repair) => repair.dirty);
    if (pending.length === 0) return;
    for (const repair of pending) repair.dirty = false;
    state.pass += 1;
    state.lastPassStartedAtMs = Date.now();
    try {
      await mapWithConcurrency(
        pending,
        MAX_CONCURRENT_REPAIRS_V1,
        async (repair) => {
          if (signal.aborted) return;
          await this.reconcileRfc64LocalSwmCatalogProjectionV1(repair, signal);
        },
      );
    } finally {
      state.lastPassCompletedAtMs = Date.now();
    }
  }

  private async reconcileRfc64LocalSwmCatalogProjectionV1(
    this: DKGAgent,
    repair: MutableAuthorRepairStatusV1,
    signal: AbortSignal,
  ): Promise<void> {
    repair.attempts += 1;
    try {
      // Startup discovery proves local-author ownership before enqueueing;
      // live mutations prove their own author seal and signing admission. Both
      // boundaries therefore enqueue the same immutable scope and execute the
      // same exact-state reconciliation operation here. A queued scope never
      // changes policy based on which event most recently dirtied it.
      const reconciliation = await this.reconcileRfc64PublicCatalogFromSwmInventoryV1({
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
        lastError: boundedErrorV1(errorMessageV1(error)),
        updatedAtMs: Date.now(),
      });
      this.log.warn(
        createOperationContext('system'),
        `RFC-64 local SWM catalog projection failed for ${repair.contextGraphId} / ${repair.authorAddress}: ${errorMessageV1(error)}`,
      );
    }
  }

  private resolveRuntimeRfc64ProjectionBootstrapConfigV1(
    this: DKGAgent,
  ): Readonly<{
    readonly acceptedPolicies: readonly Rfc64CatalogBootstrapPolicyV1[];
    readonly retryIntervalMs?: number;
  }> | undefined {
    const current = this.config.rfc64CatalogBootstrap;
    if (current !== undefined) return current;
    const legacy: Rfc64PublicCatalogBootstrapConfigV1 | undefined =
      this.config.rfc64PublicCatalogBootstrap;
    if (legacy === undefined) return undefined;
    return Object.freeze({
      acceptedPolicies: legacy.acceptedPublicPolicies,
      ...(legacy.retryIntervalMs === undefined
        ? {}
        : { retryIntervalMs: legacy.retryIntervalMs }),
    }) as Rfc64CatalogBootstrapConfigV1;
  }
}

function errorMessageV1(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedErrorV1(input: string): string {
  if (UTF8.encode(input).byteLength <= MAX_STATUS_ERROR_BYTES_V1) return input;
  let output = '';
  for (const character of input) {
    if (UTF8.encode(`${output}${character}`).byteLength > MAX_STATUS_ERROR_BYTES_V1) break;
    output += character;
  }
  return output;
}
