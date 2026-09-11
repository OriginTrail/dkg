// SPDX-License-Identifier: Apache-2.0

/** Fixed-cardinality, privacy-safe evidence for an RFC-64 shadow rollout. */

import type { Rfc64CatalogRolloutModeV1 } from './catalog-rollout-authority-v1.js';
import type { Rfc64PublicCatalogReceiverCompletionOutcomeV1 } from
  './public-catalog-reconciliation-outcome-v1.js';

const MAX_TRACKED_SHADOW_CONTEXT_GRAPHS_V1 = 1_024;
const MAX_SAFE_COUNTER_V1 = Number.MAX_SAFE_INTEGER;

interface Rfc64CatalogShadowInventoryObserverRawV1 {
  readonly attemptedUpserts: number;
  readonly attemptedRemovals: number;
  readonly appliedUpserts: number;
  readonly appliedRemovals: number;
  readonly existingUpserts: number;
  readonly absentRemovals: number;
  readonly failed: number;
  readonly casRetries: number;
}

interface Rfc64CatalogShadowProjectionSupervisorRawV1 {
  readonly running: boolean;
  readonly pass: number;
  readonly lastPassStartedAtMs: number | null;
  readonly lastPassCompletedAtMs: number | null;
  readonly repairs: readonly Readonly<{
    readonly contextGraphId: string;
    readonly outcome: 'pending' | 'reconciled' | 'no-inventory' | 'failed';
  }>[];
}

interface Rfc64CatalogShadowBootstrapRawV1 {
  readonly running: boolean;
  readonly pass: number;
  readonly lastPassStartedAtMs: number | null;
  readonly lastPassCompletedAtMs: number | null;
  readonly targets: readonly Readonly<{
    readonly scope: Readonly<{ readonly contextGraphId: string }>;
    readonly mode: Rfc64CatalogRolloutModeV1;
    readonly outcome: string;
  }>[];
}

export interface Rfc64CatalogShadowReceiverCompletionCountersV1 {
  readonly trackedTargets: number;
  readonly staged: number;
  readonly notFound: number;
  readonly failed: number;
  readonly authoritativeApplyCount: number;
}

interface MutableRfc64CatalogShadowReceiverCompletionCountersV1 {
  trackedTargets: number;
  staged: number;
  notFound: number;
  failed: number;
  authoritativeApplyCount: number;
}

interface Rfc64CatalogShadowReceiverCompletionStateV1 {
  readonly byContextGraph: Map<
    string,
    MutableRfc64CatalogShadowReceiverCompletionCountersV1
  >;
  /** Aggregate overflow is conservative: violations can never disappear at capacity. */
  readonly overflow: MutableRfc64CatalogShadowReceiverCompletionCountersV1;
}

const shadowReceiverCompletionsByOwnerV1 = new WeakMap<
  object,
  Rfc64CatalogShadowReceiverCompletionStateV1
>();

function incrementBoundedCounterV1(value: number): number {
  return Math.min(MAX_SAFE_COUNTER_V1, value + 1);
}

/**
 * Record one actual receiver terminal event. The tracker is process-local,
 * bounded by CG count, and never exposes the identifiers it uses to scope
 * counters. Recording at this boundary preserves an apply violation even if a
 * higher-level bootstrap classifier subsequently reports the target as failed.
 */
export function observeRfc64CatalogShadowReceiverCompletionV1(
  owner: object,
  contextGraphId: string,
  mode: Rfc64CatalogRolloutModeV1,
  outcome: Rfc64PublicCatalogReceiverCompletionOutcomeV1,
): void {
  if (mode !== 'shadow') return;
  let state = shadowReceiverCompletionsByOwnerV1.get(owner);
  if (state === undefined) {
    state = {
      byContextGraph: new Map(),
      overflow: emptyReceiverCompletionCountersV1(),
    };
    shadowReceiverCompletionsByOwnerV1.set(owner, state);
  }
  let counters = state.byContextGraph.get(contextGraphId);
  if (counters === undefined) {
    if (state.byContextGraph.size >= MAX_TRACKED_SHADOW_CONTEXT_GRAPHS_V1) {
      counters = state.overflow;
    } else {
      counters = emptyReceiverCompletionCountersV1();
      state.byContextGraph.set(contextGraphId, counters);
    }
  }
  counters.trackedTargets = incrementBoundedCounterV1(counters.trackedTargets);
  if (outcome === 'staged-only') {
    counters.staged = incrementBoundedCounterV1(counters.staged);
  } else if (outcome === 'not-found') {
    counters.notFound = incrementBoundedCounterV1(counters.notFound);
  } else if (outcome === 'applied') {
    counters.authoritativeApplyCount = incrementBoundedCounterV1(
      counters.authoritativeApplyCount,
    );
  } else if (outcome === 'failed' || outcome === 'dropped' || outcome === 'closed') {
    counters.failed = incrementBoundedCounterV1(counters.failed);
  }
}

/** Aggregate cumulative receiver evidence for the current canonical shadow scope. */
export function readRfc64CatalogShadowReceiverCompletionCountersV1(
  owner: object,
  shadowContextGraphIds: readonly string[],
): Readonly<Rfc64CatalogShadowReceiverCompletionCountersV1> {
  const totals = emptyReceiverCompletionCountersV1();
  const state = shadowReceiverCompletionsByOwnerV1.get(owner);
  if (state !== undefined) {
    for (const contextGraphId of new Set(shadowContextGraphIds)) {
      const counters = state.byContextGraph.get(contextGraphId);
      if (counters === undefined) continue;
      addReceiverCompletionCountersV1(totals, counters);
    }
    if (shadowContextGraphIds.length > 0) {
      addReceiverCompletionCountersV1(totals, state.overflow);
    }
  }
  return Object.freeze(totals);
}

function emptyReceiverCompletionCountersV1(
): MutableRfc64CatalogShadowReceiverCompletionCountersV1 {
  return {
    trackedTargets: 0,
    staged: 0,
    notFound: 0,
    failed: 0,
    authoritativeApplyCount: 0,
  };
}

function addReceiverCompletionCountersV1(
  target: MutableRfc64CatalogShadowReceiverCompletionCountersV1,
  source: Readonly<MutableRfc64CatalogShadowReceiverCompletionCountersV1>,
): void {
  for (const field of Object.keys(target) as Array<keyof typeof target>) {
    target[field] = Math.min(MAX_SAFE_COUNTER_V1, target[field] + source[field]);
  }
}

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
    /** Cumulative terminal receiver completions for the current shadow scope. */
    readonly trackedTargets: number;
    /** Current bootstrap targets that have not reached the receiver boundary yet. */
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
  readonly inventoryObserver: Readonly<Rfc64CatalogShadowInventoryObserverRawV1>;
  readonly projectionSupervisor:
    Readonly<Rfc64CatalogShadowProjectionSupervisorRawV1> | null;
  readonly bootstrap: Readonly<Rfc64CatalogShadowBootstrapRawV1> | null;
  readonly receiverCompletions:
    Readonly<Rfc64CatalogShadowReceiverCompletionCountersV1>;
  readonly inFlightInventoryObservers: number;
}

/** CLI-boundary allow-list for unknown or version-skewed status providers. */
export function sanitizeRfc64CatalogShadowExecutionStatusV1(
  input: unknown,
): Readonly<Rfc64CatalogShadowExecutionStatusV1> | null {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  const status = input as Readonly<Rfc64CatalogShadowExecutionStatusV1>;
  return Object.freeze({
    schemaVersion: status.schemaVersion,
    contextGraphCount: status.contextGraphCount,
    legacyAuthorityRetained: status.legacyAuthorityRetained,
    authoritativeApplyAllowed: status.authoritativeApplyAllowed,
    inventoryObserver: Object.freeze({
      scope: status.inventoryObserver.scope,
      inFlight: status.inventoryObserver.inFlight,
      attemptedUpserts: status.inventoryObserver.attemptedUpserts,
      attemptedRemovals: status.inventoryObserver.attemptedRemovals,
      committedMutations: status.inventoryObserver.committedMutations,
      noOpMutations: status.inventoryObserver.noOpMutations,
      failedMutations: status.inventoryObserver.failedMutations,
      casRetries: status.inventoryObserver.casRetries,
    }),
    projectionSupervisor: Object.freeze({
      running: status.projectionSupervisor.running,
      passes: status.projectionSupervisor.passes,
      trackedAuthorScopes: status.projectionSupervisor.trackedAuthorScopes,
      pending: status.projectionSupervisor.pending,
      reconciled: status.projectionSupervisor.reconciled,
      noInventory: status.projectionSupervisor.noInventory,
      failed: status.projectionSupervisor.failed,
      lastPassStartedAtMs: status.projectionSupervisor.lastPassStartedAtMs,
      lastPassCompletedAtMs: status.projectionSupervisor.lastPassCompletedAtMs,
    }),
    receiverStaging: Object.freeze({
      running: status.receiverStaging.running,
      passes: status.receiverStaging.passes,
      trackedTargets: status.receiverStaging.trackedTargets,
      pending: status.receiverStaging.pending,
      staged: status.receiverStaging.staged,
      notFound: status.receiverStaging.notFound,
      knownIncomplete: status.receiverStaging.knownIncomplete,
      failed: status.receiverStaging.failed,
      authoritativeApplyCount: status.receiverStaging.authoritativeApplyCount,
      stagingObserved: status.receiverStaging.stagingObserved,
      stageOnlyInvariantSatisfied: status.receiverStaging.stageOnlyInvariantSatisfied,
      lastPassStartedAtMs: status.receiverStaging.lastPassStartedAtMs,
      lastPassCompletedAtMs: status.receiverStaging.lastPassCompletedAtMs,
    }),
  });
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
  const receiver = input.receiverCompletions;
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
      trackedTargets: receiver.trackedTargets,
      pending: targets.filter(({ outcome }) => outcome === 'pending').length,
      staged: receiver.staged,
      notFound: receiver.notFound,
      knownIncomplete: targets.filter(({ outcome }) => outcome === 'known-incomplete').length,
      failed: receiver.failed,
      authoritativeApplyCount: receiver.authoritativeApplyCount,
      stagingObserved: receiver.staged > 0,
      stageOnlyInvariantSatisfied: receiver.authoritativeApplyCount === 0,
      lastPassStartedAtMs: input.bootstrap?.lastPassStartedAtMs ?? null,
      lastPassCompletedAtMs: input.bootstrap?.lastPassCompletedAtMs ?? null,
    }),
  });
}
