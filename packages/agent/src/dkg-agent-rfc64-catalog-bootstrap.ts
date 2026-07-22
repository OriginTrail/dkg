// SPDX-License-Identifier: Apache-2.0

/** Restart-safe, operator-pinned public catalog cold-start supervisor. */

import {
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type OperationContext,
} from '@origintrail-official/dkg-core';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type {
  Rfc64PublicCatalogBootstrapConfigV1,
  Rfc64PublicCatalogBootstrapScopeV1,
} from './dkg-agent-types.js';

const MAX_STATUS_ERROR_BYTES_V1 = 1024;
const MAX_CONCURRENT_TARGETS_V1 = 4;
const UTF8 = new TextEncoder();

export type Rfc64PublicCatalogBootstrapOutcomeV1 =
  | 'pending'
  | 'applied'
  | 'not-found'
  | 'failed';

export interface Rfc64PublicCatalogBootstrapTargetStatusV1 {
  readonly scope: Readonly<Rfc64PublicCatalogBootstrapScopeV1>;
  readonly providers: readonly string[];
  readonly outcome: Rfc64PublicCatalogBootstrapOutcomeV1;
  readonly attempts: number;
  readonly providerPeerId: string | null;
  readonly appliedHeadDigest: Digest32V1 | null;
  readonly catalogVersion: string | null;
  readonly inventoryRowCount: string | null;
  readonly lastError: string | null;
  readonly updatedAtMs: number | null;
}

export interface Rfc64PublicCatalogBootstrapStatusV1 {
  readonly running: boolean;
  readonly pass: number;
  readonly retryIntervalMs: number;
  readonly lastPassStartedAtMs: number | null;
  readonly lastPassCompletedAtMs: number | null;
  readonly targets: readonly Rfc64PublicCatalogBootstrapTargetStatusV1[];
}

interface MutableTargetStatusV1 {
  readonly scope: Readonly<Rfc64PublicCatalogBootstrapScopeV1>;
  readonly providers: readonly string[];
  outcome: Rfc64PublicCatalogBootstrapOutcomeV1;
  attempts: number;
  providerPeerId: string | null;
  appliedHeadDigest: Digest32V1 | null;
  catalogVersion: string | null;
  inventoryRowCount: string | null;
  lastError: string | null;
  updatedAtMs: number | null;
}

interface BootstrapStateV1 {
  readonly config: Readonly<Rfc64PublicCatalogBootstrapConfigV1>;
  readonly targets: MutableTargetStatusV1[];
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

const STATES = new WeakMap<DKGAgent, BootstrapStateV1>();

export class Rfc64CatalogBootstrapMethods extends DKGAgentBase {
  /** Accept pinned policies and start the first bounded provider pass. */
  startRfc64PublicCatalogBootstrapV1(this: DKGAgent, ctx: OperationContext): void {
    const config = this.config.rfc64PublicCatalogBootstrap;
    if (config === undefined || STATES.has(this)) return;
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error('RFC-64 bootstrap requires the public catalog service');
    }
    for (const accepted of config.acceptedPublicPolicies) {
      service.acceptPolicySnapshot({
        policy: accepted.policy,
        policyDigest: accepted.policyDigest,
      });
    }
    const state: BootstrapStateV1 = {
      config,
      targets: config.targets.map((target) => ({
        scope: target.scope,
        providers: target.providers,
        outcome: 'pending',
        attempts: 0,
        providerPeerId: null,
        appliedHeadDigest: null,
        catalogVersion: null,
        inventoryRowCount: null,
        lastError: null,
        updatedAtMs: null,
      })),
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
    this.launchRfc64PublicCatalogBootstrapPassV1(state);
  }

  /** Immutable bounded observability for release harnesses and daemon adapters. */
  readRfc64PublicCatalogBootstrapStatusV1(
    this: DKGAgent,
  ): Readonly<Rfc64PublicCatalogBootstrapStatusV1> | null {
    const state = STATES.get(this);
    if (state === undefined) return null;
    return Object.freeze({
      running: state.running,
      pass: state.pass,
      retryIntervalMs: state.config.retryIntervalMs ?? 0,
      lastPassStartedAtMs: state.lastPassStartedAtMs,
      lastPassCompletedAtMs: state.lastPassCompletedAtMs,
      targets: Object.freeze(state.targets.map(snapshotTargetStatusV1)),
    });
  }

  /** Wait for the currently running startup/refresh pass only. */
  async whenRfc64PublicCatalogBootstrapIdleV1(this: DKGAgent): Promise<void> {
    const state = STATES.get(this);
    if (state === undefined) return;
    while (state.run !== null) {
      const current = state.run;
      await current;
      if (state.run === current) return;
    }
  }

  /** Stop future retries and abort/drain the current pass before service close. */
  async closeRfc64PublicCatalogBootstrapV1(this: DKGAgent): Promise<void> {
    const state = STATES.get(this);
    if (state === undefined) return;
    state.closed = true;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.abortController?.abort(new Error('RFC-64 public catalog bootstrap closing'));
    await state.run?.catch(() => undefined);
    STATES.delete(this);
  }

  private launchRfc64PublicCatalogBootstrapPassV1(
    this: DKGAgent,
    state: BootstrapStateV1,
  ): void {
    if (state.closed || state.run !== null) return;
    const run = this.runRfc64PublicCatalogBootstrapPassV1(state)
      .catch((error) => {
        this.log.warn(
          state.ctx,
          `RFC-64 public catalog bootstrap pass failed: ${errorMessageV1(error)}`,
        );
      })
      .finally(() => {
        if (state.run === run) state.run = null;
        const retryIntervalMs = state.config.retryIntervalMs ?? 0;
        if (!state.closed && retryIntervalMs > 0) {
          state.timer = setTimeout(() => {
            state.timer = null;
            this.launchRfc64PublicCatalogBootstrapPassV1(state);
          }, retryIntervalMs);
          state.timer.unref?.();
        }
      });
    state.run = run;
  }

  private async runRfc64PublicCatalogBootstrapPassV1(
    this: DKGAgent,
    state: BootstrapStateV1,
  ): Promise<void> {
    state.running = true;
    state.pass += 1;
    state.lastPassStartedAtMs = Date.now();
    const abortController = new AbortController();
    state.abortController = abortController;
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_TARGETS_V1, state.targets.length) },
      async () => {
        while (!state.closed) {
          const index = cursor;
          cursor += 1;
          const target = state.targets[index];
          if (target === undefined) return;
          await this.synchronizeRfc64PublicCatalogBootstrapTargetV1(
            target,
            abortController.signal,
          );
        }
      },
    );
    try {
      await Promise.all(workers);
    } finally {
      if (state.abortController === abortController) state.abortController = null;
      state.running = false;
      state.lastPassCompletedAtMs = Date.now();
    }
  }

  private async synchronizeRfc64PublicCatalogBootstrapTargetV1(
    this: DKGAgent,
    target: MutableTargetStatusV1,
    signal: AbortSignal,
  ): Promise<void> {
    let sawNotFound = false;
    let lastError: string | null = null;
    for (const providerPeerId of target.providers) {
      if (signal.aborted) return;
      target.attempts += 1;
      try {
        const applied = await this.synchronizeRfc64PublicCatalogFromProviderV1({
          remotePeerId: providerPeerId,
          scope: target.scope,
          signal,
        });
        if (applied === null) {
          sawNotFound = true;
          continue;
        }
        target.outcome = 'applied';
        target.providerPeerId = providerPeerId;
        target.appliedHeadDigest = applied.currentCatalogHeadDigest;
        target.catalogVersion = applied.catalogVersion;
        target.inventoryRowCount = applied.inventoryRowCount;
        target.lastError = null;
        target.updatedAtMs = Date.now();
        return;
      } catch (error) {
        if (signal.aborted) return;
        lastError = boundedErrorV1(errorMessageV1(error));
      }
    }
    target.outcome = lastError === null && sawNotFound ? 'not-found' : 'failed';
    target.providerPeerId = null;
    target.lastError = lastError;
    target.updatedAtMs = Date.now();
  }
}

function snapshotTargetStatusV1(
  target: MutableTargetStatusV1,
): Readonly<Rfc64PublicCatalogBootstrapTargetStatusV1> {
  return Object.freeze({
    scope: Object.freeze({
      networkId: target.scope.networkId as NetworkIdV1,
      contextGraphId: target.scope.contextGraphId as ContextGraphIdV1,
      subGraphName: target.scope.subGraphName,
      authorAddress: target.scope.authorAddress as EvmAddressV1,
      catalogEra: target.scope.catalogEra,
    }),
    providers: Object.freeze([...target.providers]),
    outcome: target.outcome,
    attempts: target.attempts,
    providerPeerId: target.providerPeerId,
    appliedHeadDigest: target.appliedHeadDigest,
    catalogVersion: target.catalogVersion,
    inventoryRowCount: target.inventoryRowCount,
    lastError: target.lastError,
    updatedAtMs: target.updatedAtMs,
  });
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
