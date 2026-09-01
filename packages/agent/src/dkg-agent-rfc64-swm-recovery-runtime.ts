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
