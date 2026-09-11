// SPDX-License-Identifier: Apache-2.0

/** Fixed-cardinality, privacy-safe evidence for an RFC-64 shadow rollout. */

import type {
  Rfc64CatalogExecutionPlanV1,
  Rfc64CatalogRolloutModeV1,
} from './catalog-rollout-authority-v1.js';
import type { Rfc64CatalogResponsibilitySelectionV1 } from
  './catalog-responsibility-registry-v1.js';
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

function incrementBoundedCounterV1(value: number): number {
  return Math.min(MAX_SAFE_COUNTER_V1, value + 1);
}

export type Rfc64CatalogShadowTerminalEventV1 = Readonly<{
  readonly kind: 'receiver-completed';
  readonly contextGraphId: string;
  readonly outcome: Rfc64PublicCatalogReceiverCompletionOutcomeV1;
}>;

export interface Rfc64CatalogShadowObservabilityRuntimeOptionsV1 {
  readonly executionPlan: Rfc64CatalogExecutionPlanV1;
  readonly readResponsibility: (
    contextGraphId: string,
  ) => Rfc64CatalogResponsibilitySelectionV1;
  readonly readResponsibilities: () => readonly Rfc64CatalogResponsibilitySelectionV1[];
}

export type Rfc64CatalogShadowObservabilitySnapshotInputV1 = Omit<
  ProjectRfc64CatalogShadowExecutionStatusInputV1,
  'shadowContextGraphIds' | 'receiverCompletions'
>;

/**
 * Agent-owned shadow lifecycle evidence. This runtime owns both the canonical
 * live shadow scope and all receiver terminal accounting, so transport and
 * responsibility code never need to coordinate observability state.
 */
export class Rfc64CatalogShadowObservabilityRuntimeV1 {
  readonly #readResponsibilities:
    Rfc64CatalogShadowObservabilityRuntimeOptionsV1['readResponsibilities'];
  readonly #readResponsibility:
    Rfc64CatalogShadowObservabilityRuntimeOptionsV1['readResponsibility'];
  readonly #configuredShadowContextGraphIds: ReadonlySet<string>;
  readonly #receiverCompletions: Rfc64CatalogShadowReceiverCompletionStateV1 = {
    byContextGraph: new Map(),
    overflow: emptyReceiverCompletionCountersV1(),
  };

  constructor(options: Rfc64CatalogShadowObservabilityRuntimeOptionsV1) {
    this.#readResponsibility = options.readResponsibility;
    this.#readResponsibilities = options.readResponsibilities;
    this.#configuredShadowContextGraphIds = new Set([
      ...Object.entries(options.executionPlan.selectedAuthority)
        .filter(([, authority]) => authority.mode === 'shadow')
        .map(([contextGraphId]) => contextGraphId),
      ...Object.entries(options.executionPlan.contextGraphModes)
        .filter(([, mode]) => mode === 'shadow')
        .map(([contextGraphId]) => contextGraphId),
    ]);
  }

  /**
   * Record one actual terminal event. Filtering happens here against the
   * current runtime-owned scope; callers cannot accidentally provide a stale
   * or independently-derived rollout mode.
   */
  recordTerminalEvent(event: Rfc64CatalogShadowTerminalEventV1): void {
    if (!this.isShadowContextGraph(event.contextGraphId)) return;
    let counters = this.#receiverCompletions.byContextGraph.get(event.contextGraphId);
    if (counters === undefined) {
      if (
        this.#receiverCompletions.byContextGraph.size
        >= MAX_TRACKED_SHADOW_CONTEXT_GRAPHS_V1
      ) {
        counters = this.#receiverCompletions.overflow;
      } else {
        counters = emptyReceiverCompletionCountersV1();
        this.#receiverCompletions.byContextGraph.set(event.contextGraphId, counters);
      }
    }
    counters.trackedTargets = incrementBoundedCounterV1(counters.trackedTargets);
    if (event.outcome === 'staged-only') {
      counters.staged = incrementBoundedCounterV1(counters.staged);
    } else if (event.outcome === 'not-found') {
      counters.notFound = incrementBoundedCounterV1(counters.notFound);
    } else if (event.outcome === 'applied') {
      counters.authoritativeApplyCount = incrementBoundedCounterV1(
        counters.authoritativeApplyCount,
      );
    } else if (
      event.outcome === 'failed'
      || event.outcome === 'dropped'
      || event.outcome === 'closed'
    ) {
      counters.failed = incrementBoundedCounterV1(counters.failed);
    }
  }

  /** Constant-time point classification for receiver terminal-event hot paths. */
  isShadowContextGraph(contextGraphId: string): boolean {
    if (this.#configuredShadowContextGraphIds.has(contextGraphId)) return true;
    const responsibility = this.#readResponsibility(contextGraphId);
    return responsibility.responsible && responsibility.mode === 'shadow';
  }

  /** Enumerate and sort the full scope only when producing an operator snapshot. */
  listShadowContextGraphIds(): readonly string[] {
    const contextGraphIds = new Set(this.#configuredShadowContextGraphIds);
    for (const responsibility of this.#readResponsibilities()) {
      if (responsibility.responsible && responsibility.mode === 'shadow') {
        contextGraphIds.add(responsibility.contextGraphId);
      }
    }
    return Object.freeze([...contextGraphIds].sort());
  }

  /** One fixed-cardinality, privacy-safe snapshot for the whole shadow lifecycle. */
  snapshot(
    input: Readonly<Rfc64CatalogShadowObservabilitySnapshotInputV1>,
  ): Readonly<Rfc64CatalogShadowExecutionStatusV1> | null {
    const shadowContextGraphIds = this.listShadowContextGraphIds();
    const totals = emptyReceiverCompletionCountersV1();
    for (const contextGraphId of new Set(shadowContextGraphIds)) {
      const counters = this.#receiverCompletions.byContextGraph.get(contextGraphId);
      if (counters === undefined) continue;
      addReceiverCompletionCountersV1(totals, counters);
    }
    if (shadowContextGraphIds.length > 0) {
      addReceiverCompletionCountersV1(totals, this.#receiverCompletions.overflow);
    }
    return projectRfc64CatalogShadowExecutionStatusV1({
      ...input,
      shadowContextGraphIds,
      receiverCompletions: Object.freeze(totals),
    });
  }
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
  if (!isRecordV1(input)) return null;
  const inventory = input.inventoryObserver;
  const projection = input.projectionSupervisor;
  const receiver = input.receiverStaging;
  if (
    input.schemaVersion !== 1
    || !isNonNegativeSafeIntegerV1(input.contextGraphCount)
    || input.legacyAuthorityRetained !== true
    || input.authoritativeApplyAllowed !== false
    || !isRecordV1(inventory)
    || inventory.scope !== 'process'
    || !hasNonNegativeSafeIntegersV1(inventory, [
      'inFlight',
      'attemptedUpserts',
      'attemptedRemovals',
      'committedMutations',
      'noOpMutations',
      'failedMutations',
      'casRetries',
    ])
    || !isRecordV1(projection)
    || typeof projection.running !== 'boolean'
    || !hasNonNegativeSafeIntegersV1(projection, [
      'passes',
      'trackedAuthorScopes',
      'pending',
      'reconciled',
      'noInventory',
      'failed',
    ])
    || !isNullableTimestampMsV1(projection.lastPassStartedAtMs)
    || !isNullableTimestampMsV1(projection.lastPassCompletedAtMs)
    || !isRecordV1(receiver)
    || typeof receiver.running !== 'boolean'
    || !hasNonNegativeSafeIntegersV1(receiver, [
      'passes',
      'trackedTargets',
      'pending',
      'staged',
      'notFound',
      'knownIncomplete',
      'failed',
      'authoritativeApplyCount',
    ])
    || typeof receiver.stagingObserved !== 'boolean'
    || typeof receiver.stageOnlyInvariantSatisfied !== 'boolean'
    || !isNullableTimestampMsV1(receiver.lastPassStartedAtMs)
    || !isNullableTimestampMsV1(receiver.lastPassCompletedAtMs)
  ) return null;
  const status = input as unknown as Readonly<Rfc64CatalogShadowExecutionStatusV1>;
  const validatedInventory = status.inventoryObserver;
  const validatedProjection = status.projectionSupervisor;
  const validatedReceiver = status.receiverStaging;
  return Object.freeze({
    schemaVersion: 1,
    contextGraphCount: status.contextGraphCount,
    legacyAuthorityRetained: true,
    authoritativeApplyAllowed: false,
    inventoryObserver: Object.freeze({
      scope: 'process' as const,
      inFlight: validatedInventory.inFlight,
      attemptedUpserts: validatedInventory.attemptedUpserts,
      attemptedRemovals: validatedInventory.attemptedRemovals,
      committedMutations: validatedInventory.committedMutations,
      noOpMutations: validatedInventory.noOpMutations,
      failedMutations: validatedInventory.failedMutations,
      casRetries: validatedInventory.casRetries,
    }),
    projectionSupervisor: Object.freeze({
      running: validatedProjection.running,
      passes: validatedProjection.passes,
      trackedAuthorScopes: validatedProjection.trackedAuthorScopes,
      pending: validatedProjection.pending,
      reconciled: validatedProjection.reconciled,
      noInventory: validatedProjection.noInventory,
      failed: validatedProjection.failed,
      lastPassStartedAtMs: validatedProjection.lastPassStartedAtMs,
      lastPassCompletedAtMs: validatedProjection.lastPassCompletedAtMs,
    }),
    receiverStaging: Object.freeze({
      running: validatedReceiver.running,
      passes: validatedReceiver.passes,
      trackedTargets: validatedReceiver.trackedTargets,
      pending: validatedReceiver.pending,
      staged: validatedReceiver.staged,
      notFound: validatedReceiver.notFound,
      knownIncomplete: validatedReceiver.knownIncomplete,
      failed: validatedReceiver.failed,
      authoritativeApplyCount: validatedReceiver.authoritativeApplyCount,
      stagingObserved: validatedReceiver.stagingObserved,
      stageOnlyInvariantSatisfied: validatedReceiver.stageOnlyInvariantSatisfied,
      lastPassStartedAtMs: validatedReceiver.lastPassStartedAtMs,
      lastPassCompletedAtMs: validatedReceiver.lastPassCompletedAtMs,
    }),
  });
}

function isRecordV1(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonNegativeSafeIntegerV1(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasNonNegativeSafeIntegersV1(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => isNonNegativeSafeIntegerV1(value[field]));
}

function isNullableTimestampMsV1(value: unknown): value is number | null {
  return value === null || isNonNegativeSafeIntegerV1(value);
}

/**
 * Aggregate raw supervisor state without retaining scopes, authors, providers,
 * object digests, UALs, or error strings. The output has a fixed schema and is
 * therefore safe for the public, frequently-polled daemon status route.
 */
function projectRfc64CatalogShadowExecutionStatusV1(
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
