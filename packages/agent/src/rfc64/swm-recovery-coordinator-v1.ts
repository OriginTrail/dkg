// SPDX-License-Identifier: Apache-2.0

import {
  canonicalizeRfc64SwmRecoveryTargetsV1,
  sameRfc64SwmRecoveryTargetsV1,
  type Rfc64AuthorizedSwmRecoveryPlanV1,
  type Rfc64PeerSwmRecoveryPlanV1,
} from './swm-recovery-plan-v1.js';

export type { Rfc64AuthorizedSwmRecoveryPlanV1 } from './swm-recovery-plan-v1.js';

export interface Rfc64SwmRecoveryAdmissionPortV1 {
  readonly selectedPublicContextGraphIds: () => readonly string[];
  readonly requestSelectedPublicAdmission:
    (providerPeerId: string, contextGraphIds: readonly string[]) => boolean;
  readonly refreshSelectedPublicAdmission: (
    providerPeerId: string,
    contextGraphIds: readonly string[],
    minimumTerminalAgeMs: number,
  ) => boolean;
  readonly selectedPublicAdmissionSnapshot: (providerPeerId: string) => Readonly<{
    contextGraphIds: readonly string[];
    phase: 'retry-required' | 'terminal';
  }> | null;
  readonly configuredRecoveryPlan:
    (providerPeerId: string) => Readonly<Rfc64PeerSwmRecoveryPlanV1>;
  readonly isCatalogReady: (providerPeerId: string) => boolean;
  readonly isPeerAccepted: (providerPeerId: string) => boolean;
  readonly isStarted: () => boolean;
}

export interface Rfc64SwmRecoveryCoordinatorDependenciesV1 {
  readonly admission: Rfc64SwmRecoveryAdmissionPortV1;
}

/**
 * RFC-64's complete-provider authorization boundary. Queueing, cooldown,
 * dispatch and reconciler accounting remain owned by the canonical selected-
 * SWM on-connect scheduler; this class only admits and revalidates typed plans.
 */
export class Rfc64SwmRecoveryCoordinatorV1 {
  constructor(private readonly deps: Rfc64SwmRecoveryCoordinatorDependenciesV1) {}

  admitSelectedPublic(
    providerPeerId: string,
    contextGraphIds: readonly string[],
  ): boolean {
    return this.deps.admission.isCatalogReady(providerPeerId)
      && this.deps.admission.requestSelectedPublicAdmission(
        providerPeerId,
        contextGraphIds,
      );
  }

  refreshSelectedPublic(
    providerPeerId: string,
    contextGraphIds: readonly string[],
    minimumTerminalAgeMs: number,
  ): boolean {
    return this.deps.admission.isCatalogReady(providerPeerId)
      && this.deps.admission.refreshSelectedPublicAdmission(
        providerPeerId,
        contextGraphIds,
        minimumTerminalAgeMs,
      );
  }

  authorize(
    recoveryPlan: Readonly<Rfc64PeerSwmRecoveryPlanV1>,
  ): Readonly<Rfc64AuthorizedSwmRecoveryPlanV1> | null {
    if (!this.deps.admission.isCatalogReady(recoveryPlan.providerPeerId)) return null;
    const selectedPublic = new Set(this.deps.admission.selectedPublicContextGraphIds());
    const canonicalTargets = canonicalizeRfc64SwmRecoveryTargetsV1(recoveryPlan.targets);
    if (canonicalTargets === null) return null;
    const configuredTargets = canonicalizeRfc64SwmRecoveryTargetsV1(
      this.deps.admission.configuredRecoveryPlan(recoveryPlan.providerPeerId).targets,
    );
    if (configuredTargets === null) return null;
    const configuredTargetKeys = new Set(configuredTargets.map(recoveryTargetKey));
    const eligible = canonicalTargets.filter((target) => (
      configuredTargetKeys.has(recoveryTargetKey(target))
      && (
        target.lane === 'ordinary-private'
        || selectedPublic.has(target.contextGraphId)
      )
    ));
    if (eligible.length === 0) return null;
    const requestedPublic = eligible
      .filter(({ lane }) => lane === 'selected-public')
      .map(({ contextGraphId }) => contextGraphId);
    const publicAccepted = requestedPublic.length > 0
      && this.admitSelectedPublic(recoveryPlan.providerPeerId, requestedPublic);
    const acceptedTargets = eligible.filter(
      ({ lane }) => lane === 'ordinary-private' || publicAccepted,
    );
    if (acceptedTargets.length === 0) return null;
    return Object.freeze({
      kind: 'rfc64-authorized-swm-recovery-v1',
      providerPeerId: recoveryPlan.providerPeerId,
      targets: Object.freeze(acceptedTargets),
    });
  }

  revalidate(
    authorized: Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>,
  ): Readonly<Rfc64AuthorizedSwmRecoveryPlanV1> {
    if (
      !this.deps.admission.isStarted()
      || !this.deps.admission.isPeerAccepted(authorized.providerPeerId)
      || !this.deps.admission.isCatalogReady(authorized.providerPeerId)
    ) {
      throw new Error('RFC-64 SWM recovery provider is not admitted or catalog-ready');
    }
    const configured = this.deps.admission.configuredRecoveryPlan(
      authorized.providerPeerId,
    );
    const selectedPublic = new Set(
      this.deps.admission.selectedPublicContextGraphIds(),
    );
    const configuredPublicTargets = configured.targets.filter(
      ({ contextGraphId, lane }) => lane === 'selected-public'
        && selectedPublic.has(contextGraphId),
    );
    const configuredPublicIds = configuredPublicTargets.map(
      ({ contextGraphId }) => contextGraphId,
    );
    const admission = this.deps.admission.selectedPublicAdmissionSnapshot(
      authorized.providerPeerId,
    );
    const admittedPublicTargets = admission?.phase === 'retry-required'
      && sameStringArray(admission.contextGraphIds, configuredPublicIds)
      ? configuredPublicTargets
      : [];
    const expectedTargets = canonicalizeRfc64SwmRecoveryTargetsV1([
      ...configured.targets.filter(({ lane }) => lane === 'ordinary-private'),
      ...admittedPublicTargets,
    ]);
    const suppliedTargets = canonicalizeRfc64SwmRecoveryTargetsV1(authorized.targets);
    if (
      authorized.kind !== 'rfc64-authorized-swm-recovery-v1'
      || expectedTargets === null
      || suppliedTargets === null
      || !sameRfc64SwmRecoveryTargetsV1(suppliedTargets, expectedTargets)
    ) {
      throw new Error('RFC-64 SWM recovery plan is not authorized by current configuration');
    }

    return Object.freeze({
      kind: 'rfc64-authorized-swm-recovery-v1',
      providerPeerId: authorized.providerPeerId,
      targets: Object.freeze(suppliedTargets),
    });
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function recoveryTargetKey(target: Readonly<{
  contextGraphId: string;
  lane: 'ordinary-private' | 'selected-public';
}>): string {
  return `${target.lane}\n${target.contextGraphId}`;
}
