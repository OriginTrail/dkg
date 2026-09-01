// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64CatalogBootstrapConfigV1,
  Rfc64CatalogBootstrapPolicyV1,
  Rfc64PublicCatalogBootstrapConfigV1,
} from '../dkg-agent-types.js';

export type Rfc64SwmRecoveryLaneV1 = 'ordinary-private' | 'selected-public';

export interface Rfc64SwmRecoveryTargetV1 {
  readonly contextGraphId: string;
  readonly lane: Rfc64SwmRecoveryLaneV1;
}

export interface Rfc64PeerSwmRecoveryPlanV1 {
  readonly providerPeerId: string;
  readonly targets: readonly Readonly<Rfc64SwmRecoveryTargetV1>[];
}

export interface Rfc64AuthorizedSwmRecoveryPlanV1 {
  readonly kind: 'rfc64-authorized-swm-recovery-v1';
  readonly providerPeerId: string;
  readonly targets: readonly Readonly<Rfc64SwmRecoveryTargetV1>[];
}

type Rfc64RecoveryConfigV1 = Readonly<
  Rfc64CatalogBootstrapConfigV1 | Rfc64PublicCatalogBootstrapConfigV1
>;

export interface Rfc64SwmRecoveryRuntimeAuthorityV1 {
  readonly ordinaryPrivateRecoveryAllowed: boolean;
  readonly selectedPublicRecoveryAllowed: boolean;
}

/** Locale-independent ordering shared by recovery plans and admission state. */
export function compareRfc64ContextGraphIdsV1(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Private recovery replaces the whole local graph, so redundant complete
 * providers cannot all be writers. The operator-pinned list order elects one
 * stable owner; changing that order is the explicit failover boundary.
 */
export function isRfc64PrivateRecoveryOwnerV1(
  completeSwmProviders: readonly string[],
  providerPeerId: string,
): boolean {
  return completeSwmProviders[0] === providerPeerId;
}

/** Graphs reserved by an accepted policy with at least one complete provider. */
export function resolveRfc64SelectedRecoveryContextGraphIdsV1(
  config: Rfc64RecoveryConfigV1 | undefined,
): readonly string[] {
  if (config === undefined) return Object.freeze([]);
  return Object.freeze(acceptedPoliciesV1(config)
    .filter(({ completeSwmProviders = [] }) => completeSwmProviders.length > 0)
    .map(({ policyEnvelope }) => policyEnvelope.payload.contextGraphId));
}

/** Private graphs that need SWM recovery without entering durable sync scope. */
export function resolveRfc64PrivateRecoveryContextGraphIdsV1(
  config: Rfc64RecoveryConfigV1 | undefined,
): readonly string[] {
  if (config === undefined) return Object.freeze([]);
  return Object.freeze(acceptedPoliciesV1(config)
    .filter(({ policyEnvelope, completeSwmProviders = [] }) => (
      policyEnvelope.payload.accessPolicy === 1
      && completeSwmProviders.length > 0
    ))
    .map(({ policyEnvelope }) => policyEnvelope.payload.contextGraphId));
}

/** Snapshot one provider's complete recovery authority at the config boundary. */
export function resolveRfc64PeerSwmRecoveryPlanV1(
  config: Rfc64RecoveryConfigV1 | undefined,
  providerPeerId: string,
): Readonly<Rfc64PeerSwmRecoveryPlanV1> {
  const byContextGraph = new Map<string, Rfc64SwmRecoveryLaneV1>();
  if (config !== undefined) {
    for (const { policyEnvelope, completeSwmProviders = [] } of acceptedPoliciesV1(config)) {
      if (!completeSwmProviders.includes(providerPeerId)) continue;
      const lane = policyEnvelope.payload.accessPolicy === 1
        ? 'ordinary-private'
        : 'selected-public';
      if (
        lane === 'ordinary-private'
        && !isRfc64PrivateRecoveryOwnerV1(completeSwmProviders, providerPeerId)
      ) {
        continue;
      }
      byContextGraph.set(policyEnvelope.payload.contextGraphId, lane);
    }
  }
  return Object.freeze({
    providerPeerId,
    targets: Object.freeze([...byContextGraph]
      .sort(([left], [right]) => compareRfc64ContextGraphIdsV1(left, right))
      .map(([contextGraphId, lane]) => Object.freeze({ contextGraphId, lane }))),
  });
}

/**
 * Canonical live recovery plan for one graph-complete provider. Configuration
 * proves provider ownership; receiver authority and runtime selection prove
 * whether that lane may execute now. Catalog mode never widens legacy gossip:
 * it admits only an explicitly configured target that is selected for Track-2.
 */
export function resolveRfc64ActivePeerSwmRecoveryPlanV1(
  config: Rfc64RecoveryConfigV1 | undefined,
  providerPeerId: string,
  resolveRuntimeAuthority: (
    contextGraphId: string,
  ) => Readonly<Rfc64SwmRecoveryRuntimeAuthorityV1>,
): Readonly<Rfc64PeerSwmRecoveryPlanV1> {
  const configured = resolveRfc64PeerSwmRecoveryPlanV1(config, providerPeerId);
  return Object.freeze({
    ...configured,
    targets: Object.freeze(configured.targets.filter(({ contextGraphId, lane }) => {
      const authority = resolveRuntimeAuthority(contextGraphId);
      return lane === 'selected-public'
        ? authority.selectedPublicRecoveryAllowed
        : authority.ordinaryPrivateRecoveryAllowed;
    })),
  });
}

/** Accepted recovery lane for a graph, independent of local store contents. */
export function resolveRfc64SwmRecoveryLaneV1(
  config: Rfc64RecoveryConfigV1 | undefined,
  contextGraphId: string,
): Rfc64SwmRecoveryLaneV1 | undefined {
  if (config === undefined) return undefined;
  const policy = acceptedPoliciesV1(config).find(
    ({ policyEnvelope }) => policyEnvelope.payload.contextGraphId === contextGraphId,
  );
  if (policy === undefined) return undefined;
  return policy.policyEnvelope.payload.accessPolicy === 1
    ? 'ordinary-private'
    : 'selected-public';
}

/** Recovery scopes for which one peer is explicitly graph-complete. */
export function resolveRfc64SelectedRecoveryContextGraphIdsForProviderV1(
  config: Rfc64RecoveryConfigV1 | undefined,
  providerPeerId: string,
): readonly string[] {
  if (config === undefined) return Object.freeze([]);
  return Object.freeze(acceptedPoliciesV1(config)
    .filter(({ completeSwmProviders = [] }) => completeSwmProviders.includes(providerPeerId))
    .map(({ policyEnvelope }) => policyEnvelope.payload.contextGraphId));
}

/** Reject contradictory lanes and produce one stable target per Context Graph. */
export function canonicalizeRfc64SwmRecoveryTargetsV1(
  targets: readonly Readonly<Rfc64SwmRecoveryTargetV1>[],
): readonly Readonly<Rfc64SwmRecoveryTargetV1>[] | null {
  const lanes = new Map<string, Rfc64SwmRecoveryLaneV1>();
  for (const { contextGraphId, lane } of targets) {
    const current = lanes.get(contextGraphId);
    if (current !== undefined && current !== lane) return null;
    lanes.set(contextGraphId, lane);
  }
  return Object.freeze([...lanes]
    .sort(([left], [right]) => compareRfc64ContextGraphIdsV1(left, right))
    .map(([contextGraphId, lane]) => Object.freeze({ contextGraphId, lane })));
}

export function sameRfc64SwmRecoveryTargetsV1(
  left: readonly Readonly<Rfc64SwmRecoveryTargetV1>[],
  right: readonly Readonly<Rfc64SwmRecoveryTargetV1>[],
): boolean {
  return left.length === right.length && left.every((target, index) => {
    const expected = right[index];
    return expected !== undefined
      && target.contextGraphId === expected.contextGraphId
      && target.lane === expected.lane;
  });
}

function acceptedPoliciesV1(
  config: Rfc64RecoveryConfigV1,
): readonly Rfc64CatalogBootstrapPolicyV1[] {
  return 'acceptedPolicies' in config
    ? config.acceptedPolicies
    : config.acceptedPublicPolicies;
}
