// SPDX-License-Identifier: Apache-2.0

/** Restart-safe, operator-pinned public catalog cold-start supervisor. */

import {
  computeContextGraphPolicyObjectDigestV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type OperationContext,
} from '@origintrail-official/dkg-core';

import { DKGAgentBase } from './dkg-agent-base.js';
import { Rfc64CatalogSynchronizationErrorV1 } from './dkg-agent-rfc64-catalog-sync.js';
import type { DKGAgent } from './dkg-agent.js';
import type {
  Rfc64CatalogBootstrapConfigV1,
  Rfc64CatalogBootstrapPolicyV1,
  Rfc64PublicCatalogBootstrapConfigV1,
  Rfc64PublicCatalogBootstrapScopeV1,
} from './dkg-agent-types.js';
import { mapWithConcurrency } from './map-with-concurrency.js';

const MAX_STATUS_ERROR_BYTES_V1 = 1024;
const MAX_CONCURRENT_TARGETS_V1 = 4;
const COMPLETE_SWM_PROVIDER_DIAL_TIMEOUT_MS_V1 = 10_000;
const UTF8 = new TextEncoder();

export type Rfc64PublicCatalogBootstrapOutcomeV1 =
  | 'pending'
  | 'applied'
  | 'not-found'
  | 'known-incomplete'
  | 'failed';

export type Rfc64CatalogBootstrapCompletionReasonV1 =
  | 'no-authorized-provider';

export interface Rfc64PublicCatalogBootstrapTargetStatusV1 {
  readonly scope: Readonly<Rfc64PublicCatalogBootstrapScopeV1>;
  readonly providers: readonly string[];
  readonly outcome: Rfc64PublicCatalogBootstrapOutcomeV1;
  readonly completionReason: Rfc64CatalogBootstrapCompletionReasonV1 | null;
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

export function classifyRfc64CatalogBootstrapFailureV1(
  requiresPrivateVm: boolean,
  error: unknown | null,
): Readonly<{
  outcome: Extract<Rfc64PublicCatalogBootstrapOutcomeV1, 'not-found' | 'known-incomplete' | 'failed'>;
  completionReason: Rfc64CatalogBootstrapCompletionReasonV1 | null;
}> {
  const knownIncomplete = requiresPrivateVm
    && error instanceof Rfc64CatalogSynchronizationErrorV1
    && error.terminalReason === 'no-authorized-provider';
  return Object.freeze({
    outcome: knownIncomplete
      ? 'known-incomplete'
      : error === null ? 'not-found' : 'failed',
    completionReason: knownIncomplete ? 'no-authorized-provider' : null,
  });
}

interface MutableTargetStatusV1 {
  readonly scope: Readonly<Rfc64PublicCatalogBootstrapScopeV1>;
  readonly providers: readonly string[];
  readonly requiresPrivateVm: boolean;
  outcome: Rfc64PublicCatalogBootstrapOutcomeV1;
  completionReason: Rfc64CatalogBootstrapCompletionReasonV1 | null;
  attempts: number;
  providerPeerId: string | null;
  appliedHeadDigest: Digest32V1 | null;
  catalogVersion: string | null;
  inventoryRowCount: string | null;
  lastError: string | null;
  updatedAtMs: number | null;
}

interface BootstrapStateV1 {
  readonly config: Readonly<{
    readonly acceptedPolicies: readonly Rfc64CatalogBootstrapPolicyV1[];
    readonly retryIntervalMs?: number;
  }>;
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

/**
 * Normalize catalog authority into the scheduler's feature-neutral reserved
 * recovery scope. Policies without a graph-complete SWM provider confer no
 * reservation.
 */
export function resolveRfc64SelectedRecoveryContextGraphIdsV1(
  config: Readonly<Rfc64CatalogBootstrapConfigV1 | Rfc64PublicCatalogBootstrapConfigV1>
    | undefined,
): readonly string[] {
  if (config === undefined) return Object.freeze([]);
  return Object.freeze(acceptedPoliciesV1(config)
    .filter(({ policyEnvelope, completeSwmProviders = [] }) => (
      policyEnvelope.payload.accessPolicy === 0
      && completeSwmProviders.length > 0
    ))
    .map(({ policyEnvelope }) => policyEnvelope.payload.contextGraphId));
}

/** Selected recovery scopes for which one peer is explicitly graph-complete. */
export function resolveRfc64SelectedRecoveryContextGraphIdsForProviderV1(
  config: Readonly<Rfc64CatalogBootstrapConfigV1 | Rfc64PublicCatalogBootstrapConfigV1>
    | undefined,
  providerPeerId: string,
): readonly string[] {
  if (config === undefined) return Object.freeze([]);
  return Object.freeze(acceptedPoliciesV1(config)
    .filter(({ policyEnvelope, completeSwmProviders = [] }) => (
      policyEnvelope.payload.accessPolicy === 0
      && completeSwmProviders.includes(providerPeerId)
    ))
    .map(({ policyEnvelope }) => policyEnvelope.payload.contextGraphId));
}

export class Rfc64CatalogBootstrapMethods extends DKGAgentBase {
  /**
   * Exact operator-pinned graph-complete SWM providers for one accepted policy.
   * These are deliberately separate from per-author catalog providers: only
   * this explicit graph-wide assertion may let one peer end the SWM walk.
   */
  resolveRfc64CompleteSwmProviderPeerIdsV1(
    this: DKGAgent,
    contextGraphId: string,
  ): readonly string[] {
    const config = this.config.rfc64CatalogBootstrap
      ?? this.config.rfc64PublicCatalogBootstrap;
    if (config === undefined) return Object.freeze([]);
    const policy = acceptedPoliciesV1(config).find(
      ({ policyEnvelope }) => policyEnvelope.payload.contextGraphId === contextGraphId,
    );
    return policy?.policyEnvelope.payload.accessPolicy === 0
      ? policy.completeSwmProviders ?? Object.freeze([])
      : Object.freeze([]);
  }

  /** Accept pinned policies and start the first bounded provider pass. */
  startRfc64PublicCatalogBootstrapV1(this: DKGAgent, ctx: OperationContext): void {
    const config = this.resolveRuntimeRfc64CatalogBootstrapV1();
    if (config === undefined || STATES.has(this)) return;
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error('RFC-64 bootstrap requires the public catalog service');
    }
    for (const accepted of config.acceptedPolicies) {
      service.acceptPolicySnapshot({
        policy: accepted.policyEnvelope.payload,
        policyDigest: computeContextGraphPolicyObjectDigestV1(accepted.policyEnvelope),
        roster: accepted.rosterEnvelope?.payload,
      });
    }
    const targets = config.acceptedPolicies.flatMap(({
      policyEnvelope,
      targets: policyTargets,
      completeSwmProviders = [],
    }) => (
      policyTargets.map((target) => ({
        scope: Object.freeze({
          networkId: policyEnvelope.payload.networkId,
          contextGraphId: policyEnvelope.payload.contextGraphId,
          subGraphName: null,
          authorAddress: target.authorAddress,
          catalogEra: policyEnvelope.payload.era,
        }),
        // Private recovery uses only graph-complete providers for every signed
        // author catalog. Per-author candidates cannot widen that authority.
        providers: policyEnvelope.payload.accessPolicy === 1
          ? completeSwmProviders
          : target.providers,
        requiresPrivateVm:
          policyEnvelope.payload.accessPolicy === 1
          && policyEnvelope.payload.source.kind === 'finalized-chain',
      }))
    ));
    const state: BootstrapStateV1 = {
      config,
      targets: targets.map((target) => ({
        scope: target.scope,
        providers: target.providers,
        requiresPrivateVm: target.requiresPrivateVm,
        outcome: 'pending',
        completionReason: null,
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
    try {
      const completeSwmProviders = [...new Set(
        state.config.acceptedPolicies.flatMap(
          ({ completeSwmProviders: providers = [] }) => providers,
        ),
      )];
      const publicCompleteSwmProviders = new Set(
        state.config.acceptedPolicies.flatMap(
          ({ policyEnvelope, completeSwmProviders: providers = [] }) => (
            policyEnvelope.payload.accessPolicy === 0 ? providers : []
          ),
        ),
      );
      await mapWithConcurrency(
        completeSwmProviders,
        MAX_CONCURRENT_TARGETS_V1,
        async (providerPeerId) => {
          if (state.closed || abortController.signal.aborted) return;
          try {
            await this.connectToPeerId(providerPeerId, {
              timeoutMs: COMPLETE_SWM_PROVIDER_DIAL_TIMEOUT_MS_V1,
            });
            // A pre-existing connection has no new connection:open event. Ask
            // the lifecycle scheduler to seed or resume the selected lane; it
            // owns the seed/incomplete/complete state transition and becomes a
            // no-op after exact plane proof.
            if (publicCompleteSwmProviders.has(providerPeerId)) {
              this.queueSelectedSwmFromPeerOnConnect(
                providerPeerId,
                (_peerId, error) => {
                  this.log.warn(
                    state.ctx,
                    `RFC-64 complete SWM provider sync failed for ${providerPeerId.slice(-8)}: ${errorMessageV1(error)}`,
                  );
                },
                0,
              );
            }
          } catch (error) {
            this.log.warn(
              state.ctx,
              `RFC-64 complete SWM provider ${providerPeerId.slice(-8)} is not dialable: ${errorMessageV1(error)}`,
            );
          }
        },
      );
      await mapWithConcurrency(
        state.targets,
        MAX_CONCURRENT_TARGETS_V1,
        async (target) => {
          if (state.closed) return;
          await this.synchronizeRfc64PublicCatalogBootstrapTargetV1(
            target,
            abortController.signal,
          );
        },
      );
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
    target.outcome = 'pending';
    target.completionReason = null;
    target.attempts = 0;
    target.providerPeerId = null;
    target.appliedHeadDigest = null;
    target.catalogVersion = null;
    target.inventoryRowCount = null;
    target.lastError = null;
    target.attempts = 0;
    let lastError: string | null = null;
    let terminalError: unknown | null = null;
    try {
      const applied = await this.synchronizeRfc64CatalogFromProvidersV1({
        remotePeerIds: target.providers,
        scope: target.scope,
        signal,
      });
      if (applied !== null) {
        target.outcome = 'applied';
        target.completionReason = null;
        target.providerPeerId = applied.appliedProviderPeerId;
        target.attempts = applied.providerAttempts;
        target.appliedHeadDigest = applied.currentCatalogHeadDigest;
        target.catalogVersion = applied.catalogVersion;
        target.inventoryRowCount = applied.inventoryRowCount;
        target.lastError = null;
        target.updatedAtMs = Date.now();
        return;
      }
    } catch (error) {
      if (signal.aborted) return;
      terminalError = error;
      lastError = boundedErrorV1(errorMessageV1(error));
    }
    const classification = classifyRfc64CatalogBootstrapFailureV1(
      target.requiresPrivateVm,
      terminalError,
    );
    target.outcome = classification.outcome;
    target.completionReason = classification.completionReason;
    target.providerPeerId = null;
    target.appliedHeadDigest = null;
    target.catalogVersion = null;
    target.inventoryRowCount = null;
    target.lastError = lastError;
    target.updatedAtMs = Date.now();
  }

  private resolveRuntimeRfc64CatalogBootstrapV1(
    this: DKGAgent,
  ): BootstrapStateV1['config'] | undefined {
    const current = this.config.rfc64CatalogBootstrap;
    if (current !== undefined) return current;
    const legacy = this.config.rfc64PublicCatalogBootstrap;
    if (legacy === undefined) return undefined;
    return Object.freeze({
      acceptedPolicies: legacy.acceptedPublicPolicies,
      ...(legacy.retryIntervalMs === undefined
        ? {}
        : { retryIntervalMs: legacy.retryIntervalMs }),
    });
  }
}

function acceptedPoliciesV1(
  config: Readonly<Rfc64CatalogBootstrapConfigV1 | Rfc64PublicCatalogBootstrapConfigV1>,
): readonly Rfc64CatalogBootstrapPolicyV1[] {
  return 'acceptedPolicies' in config
    ? config.acceptedPolicies
    : config.acceptedPublicPolicies;
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
    completionReason: target.completionReason,
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
