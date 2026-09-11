// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64CatalogShadowExecutionStatusV1,
} from '@origintrail-official/dkg-agent';

/**
 * CLI-owned allow-list for unknown or version-skewed agent status providers.
 * The projection is rebuilt field-by-field so provider-only data cannot cross
 * the public HTTP boundary.
 */
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
    || !hasConsistentShadowSafetyEvidenceV1(receiver)
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

function hasConsistentShadowSafetyEvidenceV1(
  receiver: Readonly<Record<string, unknown>>,
): boolean {
  const staged = receiver.staged;
  const authoritativeApplyCount = receiver.authoritativeApplyCount;
  return isNonNegativeSafeIntegerV1(staged)
    && isNonNegativeSafeIntegerV1(authoritativeApplyCount)
    && receiver.stagingObserved === (staged > 0)
    && receiver.stageOnlyInvariantSatisfied === (authoritativeApplyCount === 0);
}
