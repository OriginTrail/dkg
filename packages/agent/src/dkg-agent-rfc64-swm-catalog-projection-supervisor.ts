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

const MAX_CONCURRENT_REPAIRS_V1 = 4;
const MAX_STATUS_ERROR_BYTES_V1 = 1024;
const UTF8 = new TextEncoder();

export type Rfc64PublicCatalogAuthorRepairOutcomeV1 =
  | 'pending'
  | 'inactive'
  | 'unavailable'
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
  liveAdmission: boolean;
}

interface ProjectionSupervisorStateV1 {
  readonly retryIntervalMs?: number;
  readonly repairs: MutableAuthorRepairStatusV1[];
  readonly ctx: OperationContext;
  closed: boolean;
  running: boolean;
  pass: number;
  lastPassStartedAtMs: number | null;
  lastPassCompletedAtMs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  abortController: AbortController | null;
  run: Promise<void> | null;
}

const STATES = new WeakMap<DKGAgent, ProjectionSupervisorStateV1>();
const CLOSED = new WeakSet<DKGAgent>();

export class Rfc64SwmCatalogProjectionSupervisorMethods extends DKGAgentBase {
  /** Seed bounded local-author projection work from selected catalog scopes. */
  startRfc64SwmCatalogProjectionSupervisorV1(
    this: DKGAgent,
    ctx: OperationContext,
  ): void {
    const config = this.resolveRuntimeRfc64ProjectionBootstrapConfigV1();
    if (config === undefined) return;
    CLOSED.delete(this);
    const partition = partitionRfc64CatalogBootstrapV1(
      config,
      this.config.rfc64CatalogRollout,
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
        if (this.resolveRfc64AcceptedPublicRootLaneV1(contextGraphId, null) === null) {
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
            liveAdmission: false,
          }];
        });
      },
    );
    if (repairs.length === 0) return;
    const existing = STATES.get(this);
    if (existing !== undefined) {
      if (existing.closed) return;
      for (const repair of repairs) {
        if (existing.repairs.some((candidate) => (
          candidate.contextGraphId === repair.contextGraphId
          && candidate.authorAddress === repair.authorAddress
        ))) continue;
        existing.repairs.push(repair);
      }
      this.launchRfc64SwmCatalogProjectionPassV1(existing);
      return;
    }
    const state: ProjectionSupervisorStateV1 = {
      retryIntervalMs: partition.retryIntervalMs,
      repairs,
      ctx,
      closed: false,
      running: false,
      pass: 0,
      lastPassStartedAtMs: null,
      lastPassCompletedAtMs: null,
      timer: null,
      abortController: null,
      run: null,
    };
    STATES.set(this, state);
    this.launchRfc64SwmCatalogProjectionPassV1(state);
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
    if (CLOSED.has(this)) return false;
    assertContextGraphIdV1(params.contextGraphId, 'SWM catalog projection contextGraphId');
    const authorAddress = params.authorAddress.toLowerCase() as EvmAddressV1;
    assertCanonicalEvmAddress(authorAddress, 'SWM catalog projection authorAddress');
    // This entry point is internal to a mutation that already proved the
    // author seal and local signing capability. Startup discovery remains
    // restricted to registered local authors; live requests do not repeat a
    // registry check that can lag custodial author activation.
    if (this.resolveRfc64AcceptedPublicRootLaneV1(params.contextGraphId, null) === null) {
      return false;
    }

    let state = STATES.get(this);
    if (state === undefined) {
      const config = this.resolveRuntimeRfc64ProjectionBootstrapConfigV1();
      const retryIntervalMs = config === undefined
        ? undefined
        : partitionRfc64CatalogBootstrapV1(
          config,
          this.config.rfc64CatalogRollout,
        ).retryIntervalMs;
      state = {
        retryIntervalMs,
        repairs: [],
        ctx: params.ctx ?? createOperationContext('system'),
        closed: false,
        running: false,
        pass: 0,
        lastPassStartedAtMs: null,
        lastPassCompletedAtMs: null,
        timer: null,
        abortController: null,
        run: null,
      };
      STATES.set(this, state);
    }
    if (state.closed) return false;
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
        liveAdmission: true,
      };
      state.repairs.push(repair);
    } else {
      repair.dirty = true;
      repair.liveAdmission = true;
    }
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.launchRfc64SwmCatalogProjectionPassV1(state);
    return true;
  }

  readRfc64SwmCatalogProjectionSupervisorStatusV1(
    this: DKGAgent,
  ): Readonly<Rfc64SwmCatalogProjectionSupervisorStatusV1> | null {
    const state = STATES.get(this);
    if (state === undefined) return null;
    return Object.freeze({
      running: state.running,
      pass: state.pass,
      retryIntervalMs: state.retryIntervalMs ?? 0,
      lastPassStartedAtMs: state.lastPassStartedAtMs,
      lastPassCompletedAtMs: state.lastPassCompletedAtMs,
      repairs: Object.freeze(state.repairs.map(({
        dirty: _dirty,
        liveAdmission: _liveAdmission,
        ...repair
      }) => Object.freeze(repair))),
    });
  }

  async whenRfc64SwmCatalogProjectionSupervisorIdleV1(this: DKGAgent): Promise<void> {
    const state = STATES.get(this);
    if (state === undefined) return;
    while (state.run !== null) {
      const current = state.run;
      await current;
      if (state.run === current) return;
    }
  }

  async closeRfc64SwmCatalogProjectionSupervisorV1(this: DKGAgent): Promise<void> {
    CLOSED.add(this);
    const state = STATES.get(this);
    if (state === undefined) return;
    state.closed = true;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.abortController?.abort(new Error('RFC-64 SWM catalog projection closing'));
    await state.run?.catch(() => undefined);
    STATES.delete(this);
  }

  private launchRfc64SwmCatalogProjectionPassV1(
    this: DKGAgent,
    state: ProjectionSupervisorStateV1,
  ): void {
    if (state.closed || state.run !== null) return;
    const run = this.runRfc64SwmCatalogProjectionPassV1(state)
      .catch((error) => {
        this.log.warn(
          state.ctx,
          `RFC-64 SWM catalog projection pass failed: ${errorMessageV1(error)}`,
        );
      })
      .finally(() => {
        if (state.run === run) state.run = null;
        if (!state.closed && state.repairs.some((repair) => repair.dirty)) {
          this.launchRfc64SwmCatalogProjectionPassV1(state);
          return;
        }
        const retryIntervalMs = state.retryIntervalMs ?? 0;
        if (!state.closed && retryIntervalMs > 0) {
          state.timer = setTimeout(() => {
            state.timer = null;
            for (const repair of state.repairs) repair.dirty = true;
            this.launchRfc64SwmCatalogProjectionPassV1(state);
          }, retryIntervalMs);
          state.timer.unref?.();
        }
      });
    state.run = run;
  }

  private async runRfc64SwmCatalogProjectionPassV1(
    this: DKGAgent,
    state: ProjectionSupervisorStateV1,
  ): Promise<void> {
    state.running = true;
    const abortController = new AbortController();
    state.abortController = abortController;
    try {
      while (!state.closed && !abortController.signal.aborted) {
        const pending = state.repairs.filter((repair) => repair.dirty);
        if (pending.length === 0) break;
        for (const repair of pending) repair.dirty = false;
        state.pass += 1;
        state.lastPassStartedAtMs = Date.now();
        await mapWithConcurrency(
          pending,
          MAX_CONCURRENT_REPAIRS_V1,
          async (repair) => {
            if (state.closed || abortController.signal.aborted) return;
            await this.reconcileRfc64LocalSwmCatalogProjectionV1(
              repair,
              abortController.signal,
            );
          },
        );
        state.lastPassCompletedAtMs = Date.now();
      }
    } finally {
      if (state.abortController === abortController) state.abortController = null;
      state.running = false;
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
      const result = repair.liveAdmission
        ? await this.reconcileRfc64PublicCatalogFromSwmInventoryV1({
          contextGraphId: repair.contextGraphId,
          authorAddress: repair.authorAddress,
          signal,
        }).then((reconciliation) => reconciliation === null
          ? Object.freeze({ outcome: 'no-inventory' as const })
          : Object.freeze({ outcome: 'reconciled' as const, reconciliation }))
        : await this.repairRfc64LocalPublicCatalogAuthorV1({
          contextGraphId: repair.contextGraphId,
          authorAddress: repair.authorAddress,
          signal,
        });
      if (signal.aborted) return;
      if (result.outcome === 'inactive' || result.outcome === 'no-inventory') {
        Object.assign(repair, {
          outcome: result.outcome,
          inventoryHeadObjectDigest: null,
          catalogVersion: null,
          inventoryRowCount: null,
          lastError: null,
          updatedAtMs: Date.now(),
        });
        return;
      }
      if (result.outcome === 'unavailable') {
        Object.assign(repair, {
          outcome: 'unavailable',
          inventoryHeadObjectDigest: null,
          catalogVersion: null,
          inventoryRowCount: null,
          lastError: boundedErrorV1(result.error),
          updatedAtMs: Date.now(),
        });
        return;
      }
      Object.assign(repair, {
        outcome: 'reconciled',
        inventoryHeadObjectDigest: result.reconciliation.inventoryHeadObjectDigest,
        catalogVersion: result.reconciliation.appliedHead?.catalogVersion ?? null,
        inventoryRowCount:
          result.reconciliation.appliedHead?.inventoryRowCount
          ?? String(result.reconciliation.targetAssetCount),
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
