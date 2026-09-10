// SPDX-License-Identifier: Apache-2.0

/** Fixed-cardinality, privacy-safe evidence for an RFC-64 shadow rollout. */

import type { Rfc64PublicCatalogBootstrapStatusV1 } from
  '../dkg-agent-rfc64-catalog-bootstrap.js';
import type { Rfc64SwmCatalogProjectionSupervisorStatusV1 } from
  '../dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import type { Rfc64SwmAuthorInventoryShadowStatusV1 } from
  './swm-inventory-shadow-runtime-v1.js';

export interface Rfc64CatalogShadowExecutionStatusV1 {
  readonly schemaVersion: 1;
  /** Count only: cleartext CG ids remain on the existing operator status surface. */
  readonly contextGraphCount: number;
  /** Shadow keeps the established sync lane as semantic authority. */
  readonly legacyAuthorityRetained: true;
  /** Shadow may verify and stage catalog objects, but cannot apply them. */
  readonly authoritativeApplyAllowed: false;
  readonly inventoryObserver: Readonly<{
    /** These process-wide counters are not attributable to any private CG. */
    readonly scope: 'process';
    readonly inFlight: number;
    readonly attemptedUpserts: number;
    readonly attemptedRemovals: number;
    readonly committedMutations: number;
    readonly noOpMutations: number;
    readonly failedMutations: number;
    readonly casRetries: number;
  }>;
  readonly projectionSupervisor: Readonly<{
    readonly running: boolean;
    readonly passes: number;
    readonly trackedAuthorScopes: number;
    readonly pending: number;
    readonly reconciled: number;
    readonly noInventory: number;
    readonly failed: number;
    readonly lastPassStartedAtMs: number | null;
    readonly lastPassCompletedAtMs: number | null;
  }>;
  readonly receiverStaging: Readonly<{
    readonly running: boolean;
    readonly passes: number;
    readonly trackedTargets: number;
    readonly pending: number;
    readonly staged: number;
    readonly notFound: number;
    readonly knownIncomplete: number;
    readonly failed: number;
    /** Defensive evidence: this must remain zero for every shadow target. */
    readonly authoritativeApplyCount: number;
    /** Positive evidence, kept distinct from the absence of an invariant violation. */
    readonly stagingObserved: boolean;
    readonly stageOnlyInvariantSatisfied: boolean;
    readonly lastPassStartedAtMs: number | null;
    readonly lastPassCompletedAtMs: number | null;
  }>;
}

export interface ProjectRfc64CatalogShadowExecutionStatusInputV1 {
  readonly shadowContextGraphIds: readonly string[];
  readonly inventoryObserver: Readonly<Rfc64SwmAuthorInventoryShadowStatusV1>;
  readonly projectionSupervisor:
    Readonly<Rfc64SwmCatalogProjectionSupervisorStatusV1> | null;
  readonly bootstrap: Readonly<Rfc64PublicCatalogBootstrapStatusV1> | null;
  readonly inFlightInventoryObservers: number;
}

/**
 * Aggregate raw supervisor state without retaining scopes, authors, providers,
 * object digests, UALs, or error strings. The output has a fixed schema and is
 * therefore safe for the public, frequently-polled daemon status route.
 */
export function projectRfc64CatalogShadowExecutionStatusV1(
  input: Readonly<ProjectRfc64CatalogShadowExecutionStatusInputV1>,
): Readonly<Rfc64CatalogShadowExecutionStatusV1> | null {
  const shadowContextGraphIds = new Set(input.shadowContextGraphIds);
  if (shadowContextGraphIds.size === 0) return null;

  const repairs = input.projectionSupervisor?.repairs.filter(
    ({ contextGraphId }) => shadowContextGraphIds.has(contextGraphId),
  ) ?? [];
  const targets = input.bootstrap?.targets.filter(
    ({ mode, scope }) => mode === 'shadow'
      && shadowContextGraphIds.has(scope.contextGraphId),
  ) ?? [];
  const authoritativeApplyCount = targets.filter(
    ({ outcome, appliedHeadDigest }) => outcome === 'applied' || appliedHeadDigest !== null,
  ).length;
  const inventory = input.inventoryObserver;

  return Object.freeze({
    schemaVersion: 1,
    contextGraphCount: shadowContextGraphIds.size,
    legacyAuthorityRetained: true,
    authoritativeApplyAllowed: false,
    inventoryObserver: Object.freeze({
      scope: 'process' as const,
      inFlight: input.inFlightInventoryObservers,
      attemptedUpserts: inventory.attemptedUpserts,
      attemptedRemovals: inventory.attemptedRemovals,
      committedMutations: inventory.appliedUpserts + inventory.appliedRemovals,
      noOpMutations: inventory.existingUpserts + inventory.absentRemovals,
      failedMutations: inventory.failed,
      casRetries: inventory.casRetries,
    }),
    projectionSupervisor: Object.freeze({
      running: input.projectionSupervisor?.running ?? false,
      passes: input.projectionSupervisor?.pass ?? 0,
      trackedAuthorScopes: repairs.length,
      pending: repairs.filter(({ outcome }) => outcome === 'pending').length,
      reconciled: repairs.filter(({ outcome }) => outcome === 'reconciled').length,
      noInventory: repairs.filter(({ outcome }) => outcome === 'no-inventory').length,
      failed: repairs.filter(({ outcome }) => outcome === 'failed').length,
      lastPassStartedAtMs: input.projectionSupervisor?.lastPassStartedAtMs ?? null,
      lastPassCompletedAtMs: input.projectionSupervisor?.lastPassCompletedAtMs ?? null,
    }),
    receiverStaging: Object.freeze({
      running: input.bootstrap?.running ?? false,
      passes: input.bootstrap?.pass ?? 0,
      trackedTargets: targets.length,
      pending: targets.filter(({ outcome }) => outcome === 'pending').length,
      staged: targets.filter(({ outcome }) => outcome === 'shadow-staged').length,
      notFound: targets.filter(({ outcome }) => outcome === 'not-found').length,
      knownIncomplete: targets.filter(({ outcome }) => outcome === 'known-incomplete').length,
      failed: targets.filter(({ outcome }) => outcome === 'failed').length,
      authoritativeApplyCount,
      stagingObserved: targets.some(({ outcome }) => outcome === 'shadow-staged'),
      stageOnlyInvariantSatisfied: authoritativeApplyCount === 0,
      lastPassStartedAtMs: input.bootstrap?.lastPassStartedAtMs ?? null,
      lastPassCompletedAtMs: input.bootstrap?.lastPassCompletedAtMs ?? null,
    }),
  });
}
