// SPDX-License-Identifier: Apache-2.0

/** Canonical live RFC-64 graph-complete SWM recovery runtime. */

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  projectRfc64CatalogReceiverAuthorityV1,
  type Rfc64CatalogAuthorityPolicyV1,
} from './rfc64/public-catalog-activation-config-v1.js';
import {
  resolveRfc64ActivePeerSwmRecoveryPlanV1,
  resolveRfc64SwmRecoveryLaneV1,
  resolveRfc64SwmRecoveryRuntimeAuthorityV1,
  type Rfc64ActivePeerSwmRecoveryPlanV1,
  type Rfc64SwmRecoveryTargetV1,
  type Rfc64SwmRecoveryRuntimeAuthorityV1,
} from './rfc64/swm-recovery-plan-v1.js';
import type { RecoveryExecutionGuard } from
  './sync/requester/recovery-execution-guard.js';

type Rfc64RecoveryConfigV1 = Parameters<
  typeof resolveRfc64ActivePeerSwmRecoveryPlanV1
>[0];

export interface Rfc64SwmRecoverySelectionV1 {
  /** The single canonical answer consumed by both public and private lanes. */
  readonly selected: boolean;
}

interface Rfc64SwmRecoveryRuntimeSelectionV1 {
  readonly selectedContextGraphs: readonly string[];
  readonly eligibleContextGraphs: readonly string[];
  readonly subscriptionDriven: boolean;
}

export class Rfc64SwmRecoveryTargetRevokedErrorV1 extends Error {
  readonly code = 'RFC64_SWM_RECOVERY_TARGET_REVOKED' as const;

  constructor(readonly contextGraphId: string) {
    super(`RFC-64 SWM recovery authority was revoked for "${contextGraphId}"`);
    this.name = 'Rfc64SwmRecoveryTargetRevokedErrorV1';
  }
}

/** One graph-scoped lease over the live RFC-64 recovery authority. */
export class Rfc64SwmRecoveryTargetLeaseV1 implements RecoveryExecutionGuard {
  constructor(
    readonly contextGraphId: string,
    readonly signal: AbortSignal,
    readonly isCurrent: () => boolean,
  ) {}

  assertCurrent(): void {
    if (this.isCurrent()) return;
    const reason = this.signal.reason;
    if (reason instanceof Error) throw reason;
    throw new Rfc64SwmRecoveryTargetRevokedErrorV1(this.contextGraphId);
  }
}

/**
 * One selection projection for current-state and explicit transition checks.
 * `receiverActive` is derived here rather than accepted as a second boolean,
 * so contradictory snapshots are unrepresentable.
 */
export function projectRfc64SwmRecoveryAuthorityForSelectionV1(input: Readonly<{
  contextGraphId: string;
  lane: ReturnType<typeof resolveRfc64SwmRecoveryLaneV1>;
  configuredAuthority: Readonly<Rfc64CatalogAuthorityPolicyV1>;
  selection: Readonly<Rfc64SwmRecoverySelectionV1>;
}>): Readonly<Rfc64SwmRecoveryRuntimeAuthorityV1> {
  return resolveRfc64SwmRecoveryRuntimeAuthorityV1({
    contextGraphId: input.contextGraphId,
    lane: input.lane,
    configuredAuthority: input.configuredAuthority,
    receiverAuthority: projectRfc64CatalogReceiverAuthorityV1(
      input.configuredAuthority,
      { active: input.configuredAuthority.eligible && input.selection.selected },
    ),
    runtimeSelected: input.selection.selected,
  });
}

export interface Rfc64SwmRecoveryRuntimePortsV1 {
  readonly authority: Readonly<{
    resolveRuntimeSelection: () => Readonly<Rfc64SwmRecoveryRuntimeSelectionV1>;
    resolveConfigured: (
      contextGraphId: string,
    ) => Readonly<Rfc64CatalogAuthorityPolicyV1>;
    resolveRecoveryConfig: () => Rfc64RecoveryConfigV1;
  }>;
  readonly admission: Readonly<{
    invalidateContextGraph: (contextGraphId: string) => readonly string[];
  }>;
  readonly cooldown: Readonly<{
    deleteProvider: (providerPeerId: string) => void;
  }>;
}

/**
 * Cohesive owner of recovery authority projection, lease generations,
 * selection invalidation and provider cooldown reset.
 * The agent supplies narrow ports and exposes only delegate methods.
 */
export class Rfc64SwmRecoveryRuntimeV1 {
  readonly #controllers = new Map<string, AbortController>();

  constructor(private readonly ports: Rfc64SwmRecoveryRuntimePortsV1) {}

  resolveRuntimeAuthority(
    contextGraphId: string,
  ): Readonly<Rfc64SwmRecoveryRuntimeAuthorityV1> {
    const selection = this.ports.authority.resolveRuntimeSelection();
    return this.projectAuthority(
      contextGraphId,
      selection.selectedContextGraphs.includes(contextGraphId),
    );
  }

  selectionChanged(
    contextGraphId: string,
    transition: Readonly<{
      previousSubscribed: boolean;
      nextSubscribed: boolean;
    }>,
  ): boolean {
    const selection = this.ports.authority.resolveRuntimeSelection();
    const eligible = selection.eligibleContextGraphs.includes(contextGraphId);
    const authorityFor = (subscribed: boolean) => this.projectAuthority(
      contextGraphId,
      eligible && (!selection.subscriptionDriven || subscribed),
    );
    return authorityFor(transition.previousSubscribed).active
      !== authorityFor(transition.nextSubscribed).active;
  }

  resolveActivePlan(
    providerPeerId: string,
  ): Readonly<Rfc64ActivePeerSwmRecoveryPlanV1> {
    return resolveRfc64ActivePeerSwmRecoveryPlanV1(
      this.ports.authority.resolveRecoveryConfig(),
      providerPeerId,
      (contextGraphId) => this.resolveRuntimeAuthority(contextGraphId),
    );
  }

  acquireTargetLease(
    target: Readonly<Rfc64SwmRecoveryTargetV1>,
  ): Rfc64SwmRecoveryTargetLeaseV1 {
    let controller = this.#controllers.get(target.contextGraphId);
    if (controller === undefined) {
      controller = new AbortController();
      this.#controllers.set(target.contextGraphId, controller);
    }
    const captured = controller;
    return Object.freeze(new Rfc64SwmRecoveryTargetLeaseV1(
      target.contextGraphId,
      captured.signal,
      () => {
        const authority = this.resolveRuntimeAuthority(target.contextGraphId);
        return !captured.signal.aborted
          && this.#controllers.get(target.contextGraphId) === captured
          && authority.active
          && authority.lane === target.lane;
      },
    ));
  }

  resolveCompleteProviderPeerIds(contextGraphId: string): readonly string[] {
    const config = this.ports.authority.resolveRecoveryConfig();
    if (config === undefined) return Object.freeze([]);
    const policies = 'acceptedPolicies' in config
      ? config.acceptedPolicies
      : config.acceptedPublicPolicies;
    const policy = policies.find(
      ({ policyEnvelope }) => policyEnvelope.payload.contextGraphId === contextGraphId,
    );
    return policy?.completeSwmProviders ?? Object.freeze([]);
  }

  invalidateSelectionState(contextGraphId: string): readonly string[] {
    const current = this.#controllers.get(contextGraphId);
    current?.abort(new Rfc64SwmRecoveryTargetRevokedErrorV1(contextGraphId));
    // Recreate lazily on the next lease acquisition so invalidations for
    // inactive graphs do not leave dormant controller generations behind.
    this.#controllers.delete(contextGraphId);

    const affectedProviders = new Set([
      ...this.ports.admission.invalidateContextGraph(contextGraphId),
      ...this.resolveCompleteProviderPeerIds(contextGraphId),
    ]);
    for (const providerPeerId of affectedProviders) {
      this.ports.cooldown.deleteProvider(providerPeerId);
    }
    return Object.freeze([...affectedProviders]);
  }

  private projectAuthority(
    contextGraphId: string,
    selected: boolean,
  ): Readonly<Rfc64SwmRecoveryRuntimeAuthorityV1> {
    const config = this.ports.authority.resolveRecoveryConfig();
    return projectRfc64SwmRecoveryAuthorityForSelectionV1({
      contextGraphId,
      lane: resolveRfc64SwmRecoveryLaneV1(config, contextGraphId),
      configuredAuthority: this.ports.authority.resolveConfigured(contextGraphId),
      selection: { selected },
    });
  }
}

/** Build the one runtime owner from explicitly typed composition-root ports. */
export function createRfc64SwmRecoveryRuntimeV1(
  ports: Rfc64SwmRecoveryRuntimePortsV1,
): Rfc64SwmRecoveryRuntimeV1 {
  return new Rfc64SwmRecoveryRuntimeV1(ports);
}

/** Thin delegates over DKGAgent's definitely initialized runtime owner. */
export class Rfc64SwmRecoveryRuntimeMethods extends DKGAgentBase {
  resolveRfc64SwmRecoveryRuntimeAuthorityV1(
    this: DKGAgent,
    contextGraphId: string,
  ): Readonly<Rfc64SwmRecoveryRuntimeAuthorityV1> {
    return this.rfc64SwmRecoveryRuntimeV1.resolveRuntimeAuthority(contextGraphId);
  }

  rfc64SwmRecoverySelectionChangedV1(
    this: DKGAgent,
    contextGraphId: string,
    transition: Readonly<{
      previousSubscribed: boolean;
      nextSubscribed: boolean;
    }>,
  ): boolean {
    return this.rfc64SwmRecoveryRuntimeV1.selectionChanged(
      contextGraphId,
      transition,
    );
  }

  resolveActiveRfc64SwmRecoveryPlanV1(
    this: DKGAgent,
    providerPeerId: string,
  ): Readonly<Rfc64ActivePeerSwmRecoveryPlanV1> {
    return this.rfc64SwmRecoveryRuntimeV1.resolveActivePlan(providerPeerId);
  }

  acquireRfc64SwmRecoveryTargetLeaseV1(
    this: DKGAgent,
    target: Readonly<Rfc64SwmRecoveryTargetV1>,
  ): Rfc64SwmRecoveryTargetLeaseV1 {
    return this.rfc64SwmRecoveryRuntimeV1.acquireTargetLease(target);
  }

  resolveRfc64CompleteSwmProviderPeerIdsV1(
    this: DKGAgent,
    contextGraphId: string,
  ): readonly string[] {
    return this.rfc64SwmRecoveryRuntimeV1
      .resolveCompleteProviderPeerIds(contextGraphId);
  }

  invalidateRfc64SwmRecoverySelectionStateV1(
    this: DKGAgent,
    contextGraphId: string,
  ): readonly string[] {
    return this.rfc64SwmRecoveryRuntimeV1.invalidateSelectionState(contextGraphId);
  }

}
