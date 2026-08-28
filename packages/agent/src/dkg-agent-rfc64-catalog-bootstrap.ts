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
import type { DKGAgent } from './dkg-agent.js';
import type {
  Rfc64CatalogBootstrapConfigV1,
  Rfc64CatalogBootstrapPolicyV1,
  Rfc64PublicCatalogBootstrapConfigV1,
  Rfc64PublicCatalogBootstrapScopeV1,
} from './dkg-agent-types.js';
import { mapWithConcurrency } from './map-with-concurrency.js';
import { Rfc64CatalogSynchronizationErrorV1 } from
  './rfc64/catalog-synchronization-error-v1.js';
import { resolveRfc64PeerSwmRecoveryPlanV1 } from
  './rfc64/swm-recovery-plan-v1.js';

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
    && hasNoAuthorizedProviderTerminalReasonV1(error);
  return Object.freeze({
    outcome: knownIncomplete
      ? 'known-incomplete'
      : error === null ? 'not-found' : 'failed',
    completionReason: knownIncomplete ? 'no-authorized-provider' : null,
  });
}

function hasNoAuthorizedProviderTerminalReasonV1(error: unknown): boolean {
  let current = error;
  const visited = new Set<object>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      current instanceof Rfc64CatalogSynchronizationErrorV1
      && current.terminalReason === 'no-authorized-provider'
    ) {
      return true;
    }
    if (
      (typeof current !== 'object' && typeof current !== 'function')
      || current === null
      || visited.has(current)
    ) {
      return false;
    }
    visited.add(current);
    try {
      current = (current as { readonly cause?: unknown }).cause;
    } catch {
      return false;
    }
  }
  return false;
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
  catalogPhaseReady: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  abortController: AbortController | null;
  run: Promise<void> | null;
}

const STATES = new WeakMap<DKGAgent, BootstrapStateV1>();

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
    return policy?.completeSwmProviders ?? Object.freeze([]);
  }

  /** Accept pinned policies and start the first bounded provider pass. */
  startRfc64PublicCatalogBootstrapV1(this: DKGAgent, ctx: OperationContext): void {
    const config = this.resolveRuntimeRfc64CatalogBootstrapV1();
    const previous = STATES.get(this);
    if (config === undefined || (previous !== undefined && !previous.closed)) return;
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
      catalogPhaseReady: false,
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
  }

  /**
   * Canonical recovery prerequisite for graph-complete RFC-64 providers.
   * Non-provider peers are unaffected. Configured providers remain blocked
   * until the first complete catalog phase settles, including contained
   * not-found/failure outcomes; shutdown closes the boundary again.
   */
  isRfc64CatalogBootstrapSwmRecoveryReadyV1(
    this: DKGAgent,
    providerPeerId: string,
  ): boolean {
    const state = STATES.get(this);
    if (state === undefined) return true;
    const configuredProvider = state.config.acceptedPolicies.some(
      ({ completeSwmProviders = [] }) => completeSwmProviders.includes(providerPeerId),
    );
    if (!configuredProvider) return true;
    return !state.closed && state.catalogPhaseReady;
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
      const connectedCompleteSwmProviders = new Set<string>();
      await mapWithConcurrency(
        completeSwmProviders,
        MAX_CONCURRENT_TARGETS_V1,
        async (providerPeerId) => {
          if (state.closed || abortController.signal.aborted) return;
          try {
            await this.connectToPeerId(providerPeerId, {
              timeoutMs: COMPLETE_SWM_PROVIDER_DIAL_TIMEOUT_MS_V1,
            });
            connectedCompleteSwmProviders.add(providerPeerId);
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
      // Closing aborts target synchronization by design. It must not turn the
      // incomplete phase into readiness or admit new SWM work during teardown.
      if (state.closed || abortController.signal.aborted) return;
      state.catalogPhaseReady = true;
      // The VM catalog and graph-complete SWM inventory are two independently
      // authorized recovery planes for one private Context Graph. Apply every
      // catalog target before starting SWM recovery so a cold catalog bootstrap
      // cannot race an SWM materialization and misclassify that valid state as
      // an omitted catalog row. Catalog misses/failures do not suppress SWM:
      // target synchronization contains them in its status and this phase still
      // queues every provider that was successfully connected above.
      for (const providerPeerId of connectedCompleteSwmProviders) {
        // A pre-existing connection has no new connection:open event. One
        // immutable provider plan owns admission for every selected graph,
        // including mixed public/private providers.
        this.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
          resolveRfc64PeerSwmRecoveryPlanV1(state.config, providerPeerId),
          (_peerId, error) => {
            this.log.warn(
              state.ctx,
              `RFC-64 complete SWM provider sync failed for ${providerPeerId.slice(-8)}: ${errorMessageV1(error)}`,
            );
          },
          0,
        );
      }
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
    // `state.running` exposes that a refresh is in progress. Keep the target's
    // last completed snapshot intact until this attempt itself completes so a
    // healthy, durably applied catalog does not transiently regress to pending
    // (and lose its head/row evidence) on every periodic revalidation pass.
    // New targets already start as pending in the state initializer below.
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
        target.providerPeerId = applied.appliedProviderPeerId
          ?? applied.providerPeerIds[0]
          ?? null;
        // Discovery is hedged across the full bounded provider set before the
        // receiver selects an exact highest head for activation.
        target.attempts = target.providers.length;
        target.appliedHeadDigest = applied.currentCatalogHeadDigest;
        target.catalogVersion = applied.catalogVersion;
        target.inventoryRowCount = applied.inventoryRowCount;
        target.lastError = null;
        target.updatedAtMs = Date.now();
        return;
      }
      // A null result means the bounded provider loop completed without a
      // current head. Preserve the number of providers that were attempted.
      target.attempts = target.providers.length;
    } catch (error) {
      if (signal.aborted) return;
      // The bounded discovery call snapshots and attempts the complete
      // configured provider set before it reports a terminal failure. Keep
      // that work visible for both failed and known-incomplete outcomes.
      target.attempts = target.providers.length;
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
