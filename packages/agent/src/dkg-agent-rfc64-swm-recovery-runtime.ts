// SPDX-License-Identifier: Apache-2.0

/** Canonical live RFC-64 graph-complete SWM recovery runtime. */

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  resolveRfc64RuntimeCatalogBootstrapConfigV1,
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

export interface Rfc64SwmRecoverySelectionSnapshotV1 {
  readonly runtimeSelected: boolean;
  readonly receiverActive: boolean;
}

export type Rfc64CatalogRecoveryQueueOutcomeV1 = Readonly<
  | { kind: 'not-authorized' }
  | { kind: 'queued' }
  | { kind: 'rejected' }
>;

export class Rfc64SwmRecoveryTargetRevokedErrorV1 extends Error {
  readonly code = 'RFC64_SWM_RECOVERY_TARGET_REVOKED' as const;

  constructor(readonly contextGraphId: string) {
    super(`RFC-64 SWM recovery authority was revoked for "${contextGraphId}"`);
    this.name = 'Rfc64SwmRecoveryTargetRevokedErrorV1';
  }
}

/**
 * One graph-scoped lease over the live RFC-64 recovery authority.
 *
 * Requester algorithms stay policy-agnostic: selected-recovery construction
 * decorates their dependency ports with this lease once, at the lifecycle
 * boundary. `run()` checks both sides of an awaited operation, while the
 * signal gives transport an immediate cancellation path.
 */
export class Rfc64SwmRecoveryTargetLeaseV1 {
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

  runSync<T>(operation: () => T): T {
    this.assertCurrent();
    const result = operation();
    this.assertCurrent();
    return result;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertCurrent();
    const result = await operation();
    this.assertCurrent();
    return result;
  }
}

/** Pure selection projection shared by current-state and transition resolution. */
export function projectRfc64SwmRecoveryAuthorityForSelectionV1(input: Readonly<{
  contextGraphId: string;
  lane: ReturnType<typeof resolveRfc64SwmRecoveryLaneV1>;
  configuredAuthority: Readonly<Rfc64CatalogAuthorityPolicyV1>;
  selection: Readonly<Rfc64SwmRecoverySelectionSnapshotV1>;
}>): Readonly<Rfc64SwmRecoveryRuntimeAuthorityV1> {
  return resolveRfc64SwmRecoveryRuntimeAuthorityV1({
    contextGraphId: input.contextGraphId,
    lane: input.lane,
    configuredAuthority: input.configuredAuthority,
    receiverAuthority: projectRfc64CatalogReceiverAuthorityV1(
      input.configuredAuthority,
      { active: input.selection.receiverActive },
    ),
    runtimeSelected: input.selection.runtimeSelected,
  });
}

function resolveConfiguredRfc64SwmRecoveryLaneV1(
  config: Parameters<typeof resolveRfc64SwmRecoveryLaneV1>[0],
  contextGraphId: string,
): ReturnType<typeof resolveRfc64SwmRecoveryLaneV1> {
  return resolveRfc64SwmRecoveryLaneV1(config, contextGraphId);
}

export class Rfc64SwmRecoveryRuntimeMethods extends DKGAgentBase {
  /** Resolve live graph authority from the canonical current selection registry. */
  resolveRfc64SwmRecoveryRuntimeAuthorityV1(
    this: DKGAgent,
    contextGraphId: string,
  ): Readonly<Rfc64SwmRecoveryRuntimeAuthorityV1> {
    const selection = this.readRfc64CatalogRuntimeSelectionV1();
    const configuredAuthority = this.resolveRfc64CatalogServingAuthorityV1(contextGraphId);
    const runtimeSelected = selection.selectedContextGraphs.includes(contextGraphId);
    return projectRfc64SwmRecoveryAuthorityForSelectionV1({
      contextGraphId,
      lane: resolveConfiguredRfc64SwmRecoveryLaneV1(
        this.config.rfc64CatalogBootstrap ?? this.config.rfc64PublicCatalogBootstrap,
        contextGraphId,
      ),
      configuredAuthority,
      selection: {
        runtimeSelected,
        receiverActive: configuredAuthority.eligible && runtimeSelected,
      },
    });
  }

  /** Compare explicit pre/post subscription snapshots through the same authority policy. */
  rfc64SwmRecoverySelectionChangedV1(
    this: DKGAgent,
    contextGraphId: string,
    transition: Readonly<{
      previousSubscribed: boolean;
      nextSubscribed: boolean;
    }>,
  ): boolean {
    const runtimeSelection = this.readRfc64CatalogRuntimeSelectionV1();
    const configuredAuthority = this.resolveRfc64CatalogServingAuthorityV1(contextGraphId);
    const lane = resolveConfiguredRfc64SwmRecoveryLaneV1(
      this.config.rfc64CatalogBootstrap ?? this.config.rfc64PublicCatalogBootstrap,
      contextGraphId,
    );
    const eligible = runtimeSelection.eligibleContextGraphs.includes(contextGraphId);
    const authorityFor = (subscribed: boolean) => (
      projectRfc64SwmRecoveryAuthorityForSelectionV1({
        contextGraphId,
        lane,
        configuredAuthority,
        selection: {
          runtimeSelected: eligible && (!runtimeSelection.subscriptionDriven || subscribed),
          receiverActive: configuredAuthority.eligible
            && (!runtimeSelection.subscriptionDriven || subscribed),
        },
      })
    );
    return authorityFor(transition.previousSubscribed).active
      !== authorityFor(transition.nextSubscribed).active;
  }

  /** One provider's configured recovery proof projected through live authority. */
  resolveActiveRfc64SwmRecoveryPlanV1(
    this: DKGAgent,
    providerPeerId: string,
  ): Readonly<Rfc64ActivePeerSwmRecoveryPlanV1> {
    return resolveRfc64ActivePeerSwmRecoveryPlanV1(
      this.config.rfc64CatalogBootstrap ?? this.config.rfc64PublicCatalogBootstrap,
      providerPeerId,
      (contextGraphId) => this.resolveRfc64SwmRecoveryRuntimeAuthorityV1(contextGraphId),
    );
  }

  /** Acquire one target's graph-scoped cancellation and live-authority lease. */
  acquireRfc64SwmRecoveryTargetLeaseV1(
    this: DKGAgent,
    target: Readonly<Rfc64SwmRecoveryTargetV1>,
  ): Rfc64SwmRecoveryTargetLeaseV1 {
    let controller = this.rfc64SwmRecoverySelectionControllers.get(target.contextGraphId);
    if (controller === undefined) {
      controller = new AbortController();
      this.rfc64SwmRecoverySelectionControllers.set(target.contextGraphId, controller);
    }
    const isCurrent = () => {
      if (
        controller.signal.aborted
        || this.rfc64SwmRecoverySelectionControllers.get(target.contextGraphId) !== controller
      ) return false;
      const authority = this.resolveRfc64SwmRecoveryRuntimeAuthorityV1(target.contextGraphId);
      return authority.active && authority.lane === target.lane;
    };
    return Object.freeze(new Rfc64SwmRecoveryTargetLeaseV1(
      target.contextGraphId,
      controller.signal,
      isCurrent,
    ));
  }

  /** Exact operator-pinned graph-complete SWM providers for one accepted policy. */
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

  /** Fence stale owners and cooldowns for every provider affected by a selection change. */
  invalidateRfc64SwmRecoverySelectionStateV1(
    this: DKGAgent,
    contextGraphId: string,
  ): readonly string[] {
    const currentController = this.rfc64SwmRecoverySelectionControllers.get(contextGraphId);
    currentController?.abort(new Rfc64SwmRecoveryTargetRevokedErrorV1(contextGraphId));
    this.rfc64SwmRecoverySelectionControllers.set(contextGraphId, new AbortController());
    const affectedProviders = new Set([
      ...this.selectedSwmBootstrapAdmission.invalidateContextGraph(contextGraphId),
      ...this.resolveRfc64CompleteSwmProviderPeerIdsV1(contextGraphId),
    ]);
    for (const providerPeerId of affectedProviders) {
      this.rfc64ExactCatchupOnConnectAt.delete(providerPeerId);
    }
    return Object.freeze([...affectedProviders]);
  }

  /** Authorize and queue one catalog-pass plan with an explicit orchestration outcome. */
  queueRfc64CatalogRecoveryPlanV1(
    this: DKGAgent,
    plan: Readonly<Rfc64ActivePeerSwmRecoveryPlanV1>,
    onError: (peerId: string, error: unknown) => void,
    delayMs: number,
  ): Rfc64CatalogRecoveryQueueOutcomeV1 {
    const authorizedPlan = this.rfc64SwmRecoveryCoordinatorV1.authorizeForCatalogPass(
      plan,
      this.config.syncReconcilerTiming.stalenessThresholdMs,
    );
    if (authorizedPlan === null) return Object.freeze({ kind: 'not-authorized' });
    return Object.freeze({
      kind: this.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
        authorizedPlan,
        onError,
        delayMs,
      ) ? 'queued' : 'rejected',
    });
  }
}
