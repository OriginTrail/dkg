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
import { Rfc64CoalescingSupervisorV1 } from
  './rfc64/coalescing-supervisor-v1.js';
import { resolveRfc64PeerSwmRecoveryPlanV1 } from
  './rfc64/swm-recovery-plan-v1.js';
import {
  resolveRfc64CatalogExecutionPlanAuthorityV1,
  type Rfc64CatalogExecutionPlanV1,
  type Rfc64CatalogRolloutModeV1,
} from './rfc64/public-catalog-activation-config-v1.js';

const MAX_STATUS_ERROR_BYTES_V1 = 1024;
const MAX_CONCURRENT_TARGETS_V1 = 4;
const COMPLETE_SWM_PROVIDER_DIAL_TIMEOUT_MS_V1 = 10_000;
const UTF8 = new TextEncoder();

export type Rfc64PublicCatalogBootstrapOutcomeV1 =
  | 'inactive'
  | 'pending'
  | 'applied'
  | 'shadow-staged'
  | 'not-found'
  | 'known-incomplete'
  | 'failed';

export type Rfc64CatalogBootstrapCompletionReasonV1 =
  | 'no-authorized-provider';

export interface Rfc64PublicCatalogBootstrapTargetStatusV1 {
  readonly scope: Readonly<Rfc64PublicCatalogBootstrapScopeV1>;
  readonly providers: readonly string[];
  readonly mode: Extract<Rfc64CatalogRolloutModeV1, 'shadow' | 'catalog'>;
  readonly outcome: Rfc64PublicCatalogBootstrapOutcomeV1;
  readonly completionReason: Rfc64CatalogBootstrapCompletionReasonV1 | null;
  readonly attempts: number;
  readonly providerPeerId: string | null;
  readonly appliedHeadDigest: Digest32V1 | null;
  readonly stagedHeadDigest: Digest32V1 | null;
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
  readonly mode: Extract<Rfc64CatalogRolloutModeV1, 'shadow' | 'catalog'>;
  readonly requiresPrivateVm: boolean;
  outcome: Rfc64PublicCatalogBootstrapOutcomeV1;
  completionReason: Rfc64CatalogBootstrapCompletionReasonV1 | null;
  attempts: number;
  providerPeerId: string | null;
  appliedHeadDigest: Digest32V1 | null;
  stagedHeadDigest: Digest32V1 | null;
  catalogVersion: string | null;
  inventoryRowCount: string | null;
  lastError: string | null;
  updatedAtMs: number | null;
}

interface Rfc64CatalogBootstrapTargetPlanV1 extends Pick<
  MutableTargetStatusV1,
  'scope' | 'providers' | 'mode' | 'requiresPrivateVm'
> {}

export interface Rfc64CatalogBootstrapPartitionV1 {
  readonly retryIntervalMs?: number;
  readonly track2Policies: readonly Rfc64CatalogBootstrapPolicyV1[];
  readonly track2Targets: readonly Rfc64CatalogBootstrapTargetPlanV1[];
  readonly legacyRecoveryConfig: Readonly<{
    readonly acceptedPolicies: readonly Rfc64CatalogBootstrapPolicyV1[];
    readonly retryIntervalMs?: number;
  }>;
}

export interface BootstrapStateV1 {
  readonly retryIntervalMs?: number;
  readonly legacyRecoveryConfig: Rfc64CatalogBootstrapPartitionV1['legacyRecoveryConfig'];
  readonly targets: MutableTargetStatusV1[];
  readonly ctx: OperationContext;
  readonly runner: Rfc64CoalescingSupervisorV1;
  pass: number;
  lastPassStartedAtMs: number | null;
  lastPassCompletedAtMs: number | null;
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
    if (!this.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId).legacySyncAllowed) {
      return Object.freeze([]);
    }
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
    if (
      config === undefined
      || this.rfc64CatalogRuntimeV1.readBootstrapState() !== undefined
    ) return;
    const service = this.rfc64PublicCatalogServiceV1;
    const partition = partitionRfc64CatalogBootstrapV1(
      config,
      this.config.rfc64CatalogExecutionPlan,
    );
    if (partition.track2Policies.length > 0 && service === undefined) {
      throw new Error('RFC-64 Track-2 bootstrap requires the public catalog service');
    }
    for (const accepted of partition.track2Policies) {
      const { policyEnvelope } = accepted;
      service!.acceptPolicySnapshot({
        policy: policyEnvelope.payload,
        policyDigest: computeContextGraphPolicyObjectDigestV1(policyEnvelope),
        roster: accepted.rosterEnvelope?.payload,
      });
    }
    const hasLegacyRecoveryProviders = partition.legacyRecoveryConfig.acceptedPolicies.some(
      ({ completeSwmProviders = [] }) => completeSwmProviders.length > 0,
    );
    if (
      partition.track2Policies.length === 0
      && !hasLegacyRecoveryProviders
    ) return;
    let state!: BootstrapStateV1;
    const runner = new Rfc64CoalescingSupervisorV1({
      retryIntervalMs: partition.retryIntervalMs,
      runPass: (signal) => this.runRfc64PublicCatalogBootstrapPassV1(state, signal),
      onError: (error) => {
        this.log.warn(
          ctx,
          `RFC-64 public catalog bootstrap pass failed: ${errorMessageV1(error)}`,
        );
      },
      closingMessage: 'RFC-64 public catalog bootstrap closing',
    });
    state = {
      retryIntervalMs: partition.retryIntervalMs,
      legacyRecoveryConfig: partition.legacyRecoveryConfig,
      targets: partition.track2Targets.map((target) => ({
        mode: target.mode,
        scope: target.scope,
        providers: target.providers,
        requiresPrivateVm: target.requiresPrivateVm,
        outcome: 'pending',
        completionReason: null,
        attempts: 0,
        providerPeerId: null,
        appliedHeadDigest: null,
        stagedHeadDigest: null,
        catalogVersion: null,
        inventoryRowCount: null,
        lastError: null,
        updatedAtMs: null,
      })),
      ctx,
      runner,
      pass: 0,
      lastPassStartedAtMs: null,
      lastPassCompletedAtMs: null,
    };
    this.rfc64CatalogRuntimeV1.writeBootstrapState(state);
    runner.request();
  }

  /** Immutable bounded observability for release harnesses and daemon adapters. */
  readRfc64PublicCatalogBootstrapStatusV1(
    this: DKGAgent,
  ): Readonly<Rfc64PublicCatalogBootstrapStatusV1> | null {
    const state = this.rfc64CatalogRuntimeV1.readBootstrapState();
    if (state === undefined) return null;
    return Object.freeze({
      running: state.runner.running,
      pass: state.pass,
      retryIntervalMs: state.retryIntervalMs ?? 0,
      lastPassStartedAtMs: state.lastPassStartedAtMs,
      lastPassCompletedAtMs: state.lastPassCompletedAtMs,
      targets: Object.freeze(state.targets.map(snapshotTargetStatusV1)),
    });
  }

  /** Wait through the current pass and any subscription-triggered follow-up. */
  async whenRfc64PublicCatalogBootstrapIdleV1(this: DKGAgent): Promise<void> {
    const state = this.rfc64CatalogRuntimeV1.readBootstrapState();
    await state?.runner.whenIdle();
  }

  /** Stop future retries and abort/drain the current pass before service close. */
  async closeRfc64PublicCatalogBootstrapV1(this: DKGAgent): Promise<void> {
    const state = this.rfc64CatalogRuntimeV1.readBootstrapState();
    if (state === undefined) return;
    await state.runner.close();
    this.rfc64CatalogRuntimeV1.clearBootstrapState();
  }

  /** Re-evaluate targets immediately after an edge subscription changes. */
  requestRfc64PublicCatalogBootstrapPassV1(this: DKGAgent): void {
    this.rfc64CatalogRuntimeV1
      .readBootstrapState()
      ?.runner.request();
  }

  /** Cancel stale selection work and coalesce one pass against the new registry state. */
  invalidateRfc64PublicCatalogBootstrapPassV1(
    this: DKGAgent,
    contextGraphId: string,
  ): void {
    this.rfc64CatalogRuntimeV1
      .readBootstrapState()
      ?.runner.invalidateAndRequest(
        `RFC-64 receiver selection changed for ${contextGraphId}`,
      );
  }

  private async runRfc64PublicCatalogBootstrapPassV1(
    this: DKGAgent,
    state: BootstrapStateV1,
    signal: AbortSignal,
  ): Promise<void> {
    state.pass += 1;
    state.lastPassStartedAtMs = Date.now();
    try {
      const activeLegacyPolicies = state.legacyRecoveryConfig.acceptedPolicies.filter(
        ({ policyEnvelope }) => this.resolveRfc64CatalogReceiverAuthorityV1(
          policyEnvelope.payload.contextGraphId,
        ).legacySyncAllowed,
      );
      const activeLegacyRecoveryConfig = Object.freeze({
        ...state.legacyRecoveryConfig,
        acceptedPolicies: Object.freeze(activeLegacyPolicies),
      });
      const completeSwmProviders = [...new Set(activeLegacyPolicies.flatMap(
        ({ completeSwmProviders: providers = [] }) => providers,
      ))];
      await mapWithConcurrency(
        completeSwmProviders,
        MAX_CONCURRENT_TARGETS_V1,
        async (providerPeerId) => {
          if (signal.aborted) return;
          try {
            await this.connectToPeerId(providerPeerId, {
              timeoutMs: COMPLETE_SWM_PROVIDER_DIAL_TIMEOUT_MS_V1,
            });
            // A pre-existing connection has no new connection:open event. One
            // immutable provider plan owns admission for every selected graph,
            // including mixed public/private providers.
            this.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
              resolveRfc64PeerSwmRecoveryPlanV1(
                activeLegacyRecoveryConfig,
                providerPeerId,
              ),
              (_peerId, error) => {
                this.log.warn(
                  state.ctx,
                  `RFC-64 complete SWM provider sync failed for ${providerPeerId.slice(-8)}: ${errorMessageV1(error)}`,
                );
              },
              0,
            );
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
          if (signal.aborted) return;
          await this.synchronizeRfc64PublicCatalogBootstrapTargetV1(
            target,
            signal,
          );
        },
      );
    } finally {
      state.lastPassCompletedAtMs = Date.now();
    }
  }

  private async synchronizeRfc64PublicCatalogBootstrapTargetV1(
    this: DKGAgent,
    target: MutableTargetStatusV1,
    signal: AbortSignal,
  ): Promise<void> {
    const authority = this.resolveRfc64CatalogReceiverAuthorityV1(
      target.scope.contextGraphId,
    );
    if (!authority.track2Enabled) {
      Object.assign(target, {
        outcome: 'inactive' as const,
        completionReason: null,
        attempts: 0,
        providerPeerId: null,
        appliedHeadDigest: null,
        stagedHeadDigest: null,
        catalogVersion: null,
        inventoryRowCount: null,
        lastError: null,
        updatedAtMs: Date.now(),
      });
      return;
    }
    // `state.running` exposes that a refresh is in progress. Keep the target's
    // last completed snapshot intact until this attempt itself completes so a
    // healthy, durably applied catalog does not transiently regress to pending
    // (and lose its head/row evidence) on every periodic revalidation pass.
    // New targets already start as pending in the state initializer below.
    let lastError: string | null = null;
    let terminalError: unknown | null = null;
    try {
      const synchronized = await this.synchronizeRfc64CatalogRolloutFromProvidersV1({
        remotePeerIds: target.providers,
        scope: target.scope,
        signal,
      });
      if (synchronized !== null) {
        if (
          target.mode === 'shadow'
          && synchronized.completionOutcome !== 'staged-only'
        ) {
          throw new Error(
            `RFC-64 shadow bootstrap unexpectedly completed as ${synchronized.completionOutcome}`,
          );
        }
        if (
          target.mode === 'catalog'
          && synchronized.completionOutcome === 'staged-only'
        ) {
          throw new Error('RFC-64 catalog bootstrap unexpectedly completed as staged-only');
        }
        const providerPeerId = synchronized.appliedProviderPeerId
          ?? synchronized.providerPeerIds[0]
          ?? null;
        const completion = synchronized.completionOutcome === 'staged-only'
          ? Object.freeze({
            outcome: 'shadow-staged' as const,
            appliedHeadDigest: null,
            stagedHeadDigest: synchronized.stagedHeadDigest,
          })
          : Object.freeze({
            outcome: 'applied' as const,
            appliedHeadDigest: synchronized.appliedHead.currentCatalogHeadDigest,
            stagedHeadDigest: null,
          });
        Object.assign(target, completion, {
          completionReason: null,
          providerPeerId,
          // Preserve the public field's existing discovery-provider contract.
          // Reconciliation attempts remain internal evidence and never change
          // the meaning of this status between success and failure.
          attempts: target.providers.length,
          catalogVersion: synchronized.catalogVersion,
          inventoryRowCount: synchronized.inventoryRowCount,
          lastError: null,
          updatedAtMs: Date.now(),
        });
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
    target.stagedHeadDigest = null;
    target.catalogVersion = null;
    target.inventoryRowCount = null;
    target.lastError = lastError;
    target.updatedAtMs = Date.now();
  }

  private resolveRuntimeRfc64CatalogBootstrapV1(
    this: DKGAgent,
  ): Readonly<{
    readonly acceptedPolicies: readonly Rfc64CatalogBootstrapPolicyV1[];
    readonly retryIntervalMs?: number;
  }> | undefined {
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

/** Resolve each accepted policy exactly once into immutable lifecycle lanes. */
export function partitionRfc64CatalogBootstrapV1(
  config: Readonly<{
    readonly acceptedPolicies: readonly Rfc64CatalogBootstrapPolicyV1[];
    readonly retryIntervalMs?: number;
  }>,
  executionPlan: Rfc64CatalogExecutionPlanV1,
): Rfc64CatalogBootstrapPartitionV1 {
  const track2Policies: Rfc64CatalogBootstrapPolicyV1[] = [];
  const track2Targets: Rfc64CatalogBootstrapTargetPlanV1[] = [];
  const legacyPolicies: Rfc64CatalogBootstrapPolicyV1[] = [];
  for (const accepted of config.acceptedPolicies) {
    const { policyEnvelope, targets, completeSwmProviders = [] } = accepted;
    const authority = resolveRfc64CatalogExecutionPlanAuthorityV1(
      executionPlan,
      policyEnvelope.payload.contextGraphId,
    );
    const mode = authority.mode;
    if (authority.legacySyncAllowed) legacyPolicies.push(accepted);
    if (!authority.track2Enabled) continue;
    track2Policies.push(accepted);
    for (const target of targets) {
      track2Targets.push(Object.freeze({
        mode: mode as Extract<Rfc64CatalogRolloutModeV1, 'shadow' | 'catalog'>,
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
      }));
    }
  }
  const retry = config.retryIntervalMs === undefined
    ? {}
    : { retryIntervalMs: config.retryIntervalMs };
  return Object.freeze({
    ...retry,
    track2Policies: Object.freeze(track2Policies),
    track2Targets: Object.freeze(track2Targets),
    legacyRecoveryConfig: Object.freeze({
      acceptedPolicies: Object.freeze(legacyPolicies),
      ...retry,
    }),
  });
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
    mode: target.mode,
    outcome: target.outcome,
    completionReason: target.completionReason,
    attempts: target.attempts,
    providerPeerId: target.providerPeerId,
    appliedHeadDigest: target.appliedHeadDigest,
    stagedHeadDigest: target.stagedHeadDigest,
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
