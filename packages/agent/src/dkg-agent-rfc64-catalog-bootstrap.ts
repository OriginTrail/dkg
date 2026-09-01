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
  Rfc64CatalogBootstrapPolicyV1,
  Rfc64PublicCatalogBootstrapScopeV1,
} from './dkg-agent-types.js';
import { mapWithConcurrency } from './map-with-concurrency.js';
import type { Rfc64CatalogWorkloadOwnerV1 } from './rfc64/catalog-runtime-v1.js';
import { Rfc64CatalogSynchronizationErrorV1 } from
  './rfc64/catalog-synchronization-error-v1.js';
import { Rfc64CoalescingSupervisorV1 } from
  './rfc64/coalescing-supervisor-v1.js';
import { resolveRfc64ActivePeerSwmRecoveryPlanV1 } from
  './rfc64/swm-recovery-plan-v1.js';
import {
  resolveRfc64RuntimeCatalogBootstrapConfigV1,
  resolveRfc64CatalogExecutionPlanAuthorityV1,
  type Rfc64CatalogExecutionPlanV1,
  type Rfc64CatalogRolloutModeV1,
} from './rfc64/public-catalog-activation-config-v1.js';
import {
  boundedRfc64SupervisorErrorV1,
  rfc64SupervisorErrorMessageV1,
} from './rfc64/supervisor-status-v1.js';

const MAX_CONCURRENT_TARGETS_V1 = 4;
const COMPLETE_SWM_PROVIDER_DIAL_TIMEOUT_MS_V1 = 10_000;

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
  readonly recoveryConfig: Readonly<{
    readonly acceptedPolicies: readonly Rfc64CatalogBootstrapPolicyV1[];
    readonly retryIntervalMs?: number;
  }>;
}

interface BootstrapStateV1 {
  readonly retryIntervalMs?: number;
  readonly recoveryConfig: Rfc64CatalogBootstrapPartitionV1['recoveryConfig'];
  readonly targets: MutableTargetStatusV1[];
  readonly runner: Rfc64CoalescingSupervisorV1;
  pass: number;
  lastPassStartedAtMs: number | null;
  lastPassCompletedAtMs: number | null;
}

type CatalogSynchronizationResultV1 = Awaited<ReturnType<
  DKGAgent['synchronizeRfc64CatalogRolloutFromProvidersV1']
>>;

interface BootstrapOwnerDependenciesV1 {
  readonly resolvePartition: () => Rfc64CatalogBootstrapPartitionV1 | undefined;
  readonly resolveReceiverAuthority: (contextGraphId: string) => Readonly<{
    readonly legacySyncAllowed: boolean;
    readonly track2Enabled: boolean;
  }>;
  readonly resolveRecoveryPlan: (
    providerPeerId: string,
  ) => ReturnType<typeof resolveRfc64ActivePeerSwmRecoveryPlanV1>;
  readonly acceptTrack2Policies: (
    policies: readonly Rfc64CatalogBootstrapPolicyV1[],
  ) => void;
  readonly connectToPeerId: (peerId: string, options: Readonly<{
    readonly timeoutMs: number;
  }>) => Promise<unknown>;
  readonly queueRecoveryPlan: (
    plan: ReturnType<typeof resolveRfc64ActivePeerSwmRecoveryPlanV1>,
    onError: (peerId: string, error: unknown) => void,
    delayMs: number,
  ) => void;
  readonly synchronizeTarget: (params: Readonly<{
    readonly remotePeerIds: readonly string[];
    readonly scope: Readonly<Rfc64PublicCatalogBootstrapScopeV1>;
    readonly signal: AbortSignal;
  }>) => Promise<CatalogSynchronizationResultV1>;
  readonly warn: (ctx: OperationContext, message: string) => void;
}

/** Feature-local owner for bootstrap state, target transitions, and its runner. */
export class Rfc64CatalogBootstrapOwnerV1 implements Rfc64CatalogWorkloadOwnerV1 {
  readonly #dependencies: BootstrapOwnerDependenciesV1;
  #state: BootstrapStateV1 | undefined;
  #catalogPhaseReady = false;
  #configuredRecoveryProviders = new Set<string>();

  constructor(dependencies: BootstrapOwnerDependenciesV1) {
    this.#dependencies = dependencies;
  }

  start(ctx: OperationContext): void {
    if (this.#state !== undefined) return;
    const partition = this.#dependencies.resolvePartition();
    if (partition === undefined) return;
    this.#dependencies.acceptTrack2Policies(partition.track2Policies);
    const hasRecoveryProviders = partition.recoveryConfig.acceptedPolicies.some(
      ({ completeSwmProviders = [] }) => completeSwmProviders.length > 0,
    );
    if (partition.track2Policies.length === 0 && !hasRecoveryProviders) return;
    this.#catalogPhaseReady = false;
    this.#configuredRecoveryProviders = new Set(
      partition.recoveryConfig.acceptedPolicies.flatMap(
        ({ completeSwmProviders = [] }) => completeSwmProviders,
      ),
    );
    let state!: BootstrapStateV1;
    const runner = new Rfc64CoalescingSupervisorV1({
      retryIntervalMs: partition.retryIntervalMs,
      runPass: (signal) => this.#runPass(state, ctx, signal),
      onError: (error) => {
        this.#dependencies.warn(
          ctx,
          `RFC-64 public catalog bootstrap pass failed: ${rfc64SupervisorErrorMessageV1(error)}`,
        );
      },
      closingMessage: 'RFC-64 public catalog bootstrap closing',
    });
    state = {
      retryIntervalMs: partition.retryIntervalMs,
      recoveryConfig: partition.recoveryConfig,
      targets: partition.track2Targets.map(newPendingTargetV1),
      runner,
      pass: 0,
      lastPassStartedAtMs: null,
      lastPassCompletedAtMs: null,
    };
    this.#state = state;
    runner.request();
  }

  status(): Readonly<Rfc64PublicCatalogBootstrapStatusV1> | null {
    const state = this.#state;
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

  async whenIdle(): Promise<void> {
    await this.#state?.runner.whenIdle();
  }

  request(): void {
    this.#state?.runner.request();
  }

  invalidate(contextGraphId: string): void {
    // A completed inactive/older pass cannot authorize the newly selected
    // scope. Close readiness synchronously before aborting/coalescing work so
    // peer-connect scheduling cannot slip through ahead of the fresh catalog.
    this.#catalogPhaseReady = false;
    this.#state?.runner.invalidateAndRequest(
      `RFC-64 receiver selection changed for ${contextGraphId}`,
    );
  }

  async close(): Promise<void> {
    const state = this.#state;
    if (state === undefined) return;
    this.#catalogPhaseReady = false;
    await state.runner.close();
    this.#state = undefined;
  }

  /** Gate graph-complete SWM recovery until the first catalog phase settles. */
  isRecoveryReady(providerPeerId: string): boolean {
    return !this.#configuredRecoveryProviders.has(providerPeerId)
      || this.#catalogPhaseReady;
  }

  async #runPass(
    state: BootstrapStateV1,
    ctx: OperationContext,
    signal: AbortSignal,
  ): Promise<void> {
    state.pass += 1;
    state.lastPassStartedAtMs = Date.now();
    try {
      const configuredProviders = [...new Set(state.recoveryConfig.acceptedPolicies.flatMap(
        ({ completeSwmProviders = [] }) => completeSwmProviders,
      ))];
      const recoveryPlans = new Map(configuredProviders
        .map((providerPeerId) => (
          [providerPeerId, this.#dependencies.resolveRecoveryPlan(providerPeerId)] as const
        ))
        .filter(([, plan]) => plan.targets.length > 0));
      const connectedCompleteSwmProviders = new Set<string>();
      await mapWithConcurrency(
        [...recoveryPlans.keys()],
        MAX_CONCURRENT_TARGETS_V1,
        async (providerPeerId) => {
          if (signal.aborted) return;
          try {
            await this.#dependencies.connectToPeerId(providerPeerId, {
              timeoutMs: COMPLETE_SWM_PROVIDER_DIAL_TIMEOUT_MS_V1,
            });
            if (!signal.aborted) connectedCompleteSwmProviders.add(providerPeerId);
          } catch (error) {
            this.#dependencies.warn(
              ctx,
              `RFC-64 complete SWM provider ${providerPeerId.slice(-8)} is not dialable: ${rfc64SupervisorErrorMessageV1(error)}`,
            );
          }
        },
      );
      await mapWithConcurrency(state.targets, MAX_CONCURRENT_TARGETS_V1, async (target) => {
        if (signal.aborted) return;
        await this.#synchronizeTarget(target, signal);
      });
      if (signal.aborted) return;
      this.#catalogPhaseReady = true;
      for (const providerPeerId of connectedCompleteSwmProviders) {
        const recoveryPlan = recoveryPlans.get(providerPeerId);
        if (recoveryPlan === undefined) continue;
        this.#dependencies.queueRecoveryPlan(
          recoveryPlan,
          (_peerId, error) => {
            this.#dependencies.warn(
              ctx,
              `RFC-64 complete SWM provider sync failed for ${providerPeerId.slice(-8)}: ${rfc64SupervisorErrorMessageV1(error)}`,
            );
          },
          0,
        );
      }
    } finally {
      state.lastPassCompletedAtMs = Date.now();
    }
  }

  async #synchronizeTarget(target: MutableTargetStatusV1, signal: AbortSignal): Promise<void> {
    if (!this.#dependencies.resolveReceiverAuthority(target.scope.contextGraphId).track2Enabled) {
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
      const synchronized = await this.#dependencies.synchronizeTarget({
        remotePeerIds: target.providers,
        scope: target.scope,
        signal,
      });
      if (synchronized !== null) {
        if (target.mode === 'shadow' && synchronized.completionOutcome !== 'staged-only') {
          throw new Error(
            `RFC-64 shadow bootstrap unexpectedly completed as ${synchronized.completionOutcome}`,
          );
        }
        if (target.mode === 'catalog' && synchronized.completionOutcome === 'staged-only') {
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
          attempts: target.providers.length,
          catalogVersion: synchronized.catalogVersion,
          inventoryRowCount: synchronized.inventoryRowCount,
          lastError: null,
          updatedAtMs: Date.now(),
        });
        return;
      }
      target.attempts = target.providers.length;
    } catch (error) {
      if (signal.aborted) return;
      target.attempts = target.providers.length;
      terminalError = error;
      lastError = boundedRfc64SupervisorErrorV1(error);
    }
    const classification = classifyRfc64CatalogBootstrapFailureV1(
      target.requiresPrivateVm,
      terminalError,
    );
    Object.assign(target, {
      outcome: classification.outcome,
      completionReason: classification.completionReason,
      providerPeerId: null,
      appliedHeadDigest: null,
      stagedHeadDigest: null,
      catalogVersion: null,
      inventoryRowCount: null,
      lastError,
      updatedAtMs: Date.now(),
    });
  }
}

const bootstrapOwnersV1 = new WeakMap<DKGAgent, Rfc64CatalogBootstrapOwnerV1>();

export function bindRfc64CatalogBootstrapOwnerV1(
  agent: DKGAgent,
  owner: Rfc64CatalogBootstrapOwnerV1,
): Rfc64CatalogBootstrapOwnerV1 {
  if (bootstrapOwnersV1.has(agent)) {
    throw new Error('RFC-64 catalog bootstrap owner is already bound');
  }
  bootstrapOwnersV1.set(agent, owner);
  return owner;
}

function bootstrapOwnerV1(agent: DKGAgent): Rfc64CatalogBootstrapOwnerV1 {
  const owner = bootstrapOwnersV1.get(agent);
  if (owner === undefined) throw new Error('RFC-64 catalog bootstrap owner is not bound');
  return owner;
}

function newPendingTargetV1(
  target: Rfc64CatalogBootstrapTargetPlanV1,
): MutableTargetStatusV1 {
  return {
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
  };
}

export class Rfc64CatalogBootstrapMethods extends DKGAgentBase {
  /** One provider's configured recovery proof projected through live selection. */
  resolveActiveRfc64SwmRecoveryPlanV1(
    this: DKGAgent,
    providerPeerId: string,
  ): ReturnType<typeof resolveRfc64ActivePeerSwmRecoveryPlanV1> {
    return resolveRfc64ActivePeerSwmRecoveryPlanV1(
      this.config.rfc64CatalogBootstrap ?? this.config.rfc64PublicCatalogBootstrap,
      providerPeerId,
      this.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs,
      (contextGraphId) => this.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId),
    );
  }

  /**
   * Exact operator-pinned graph-complete SWM providers for one accepted policy.
   * These are deliberately separate from per-author catalog providers: only
   * this explicit graph-wide assertion may let one peer end the SWM walk.
   */
  resolveRfc64CompleteSwmProviderPeerIdsV1(
    this: DKGAgent,
    contextGraphId: string,
  ): readonly string[] {
    const config = resolveRfc64RuntimeCatalogBootstrapConfigV1(
      this.config.rfc64CatalogBootstrap,
      this.config.rfc64PublicCatalogBootstrap,
    );
    if (config === undefined) return Object.freeze([]);
    const policy = config.acceptedPolicies.find(
      ({ policyEnvelope }) => policyEnvelope.payload.contextGraphId === contextGraphId,
    );
    return policy?.completeSwmProviders ?? Object.freeze([]);
  }

  /** Accept pinned policies and start the first bounded provider pass. */
  startRfc64PublicCatalogBootstrapV1(this: DKGAgent, ctx: OperationContext): void {
    bootstrapOwnerV1(this).start(ctx);
  }

  /** Immutable bounded observability for release harnesses and daemon adapters. */
  readRfc64PublicCatalogBootstrapStatusV1(
    this: DKGAgent,
  ): Readonly<Rfc64PublicCatalogBootstrapStatusV1> | null {
    return bootstrapOwnerV1(this).status();
  }

  /** Wait through the current pass and any subscription-triggered follow-up. */
  async whenRfc64PublicCatalogBootstrapIdleV1(this: DKGAgent): Promise<void> {
    await bootstrapOwnerV1(this).whenIdle();
  }

  /** Re-evaluate targets immediately after an edge subscription changes. */
  requestRfc64PublicCatalogBootstrapPassV1(this: DKGAgent): void {
    bootstrapOwnerV1(this).request();
  }

  /** Cancel stale selection work and coalesce one pass against the new registry state. */
  invalidateRfc64PublicCatalogBootstrapPassV1(
    this: DKGAgent,
    contextGraphId: string,
  ): void {
    bootstrapOwnerV1(this).invalidate(contextGraphId);
  }

  /** Stop future retries and abort/drain the current pass before service close. */
  async closeRfc64PublicCatalogBootstrapV1(this: DKGAgent): Promise<void> {
    await bootstrapOwnerV1(this).close();
  }

  /** Canonical readiness gate for configured graph-complete recovery providers. */
  isRfc64CatalogBootstrapSwmRecoveryReadyV1(
    this: DKGAgent,
    providerPeerId: string,
  ): boolean {
    return bootstrapOwnerV1(this).isRecoveryReady(providerPeerId);
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
  const recoveryPolicies: Rfc64CatalogBootstrapPolicyV1[] = [];
  for (const accepted of config.acceptedPolicies) {
    const { policyEnvelope, targets, completeSwmProviders = [] } = accepted;
    const authority = resolveRfc64CatalogExecutionPlanAuthorityV1(
      executionPlan,
      policyEnvelope.payload.contextGraphId,
    );
    const mode = authority.mode;
    // Complete-provider recovery is an explicit RFC-64 lane in catalog mode,
    // not legacy gossip authority. Preserve every policy here and apply live
    // receiver authority in each bootstrap pass.
    recoveryPolicies.push(accepted);
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
    recoveryConfig: Object.freeze({
      acceptedPolicies: Object.freeze(recoveryPolicies),
      ...retry,
    }),
  });
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
