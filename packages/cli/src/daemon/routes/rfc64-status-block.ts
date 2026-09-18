// SPDX-License-Identifier: Apache-2.0

import {
  buildRfc64CatalogConfigurationEvidenceV1,
  type DKGAgent,
  type Rfc64CatalogStatusSnapshotV1,
} from '@origintrail-official/dkg-agent';

import { sanitizeRfc64CatalogShadowExecutionStatusV1 } from './rfc64-status-contract.js';

export { buildRfc64CatalogConfigurationEvidenceV1 };

/** One package-boundary capability; subsystem topology remains agent-owned. */
export interface Rfc64StatusReaderV1 {
  readonly readRfc64CatalogStatusSnapshotV1?:
    OmitThisParameter<DKGAgent['readRfc64CatalogStatusSnapshotV1']>;
}

const RFC64_STATUS_SNAPSHOT_FIELDS_V1 = Object.freeze([
  'rfc64Catalog',
  'rfc64PublicCatalog',
  'schemaVersion',
]);
const RFC64_PUBLIC_STATUS_FIELDS_V1 = Object.freeze([
  'autoPublishEnabled',
  'bootstrap',
  'completeSwmProviders',
  'enabled',
  'rollout',
  'runtimeSelection',
  'selectedContextGraphs',
  'service',
]);
const RFC64_CATALOG_STATUS_FIELDS_V1 = Object.freeze([
  'authorityRpcCircuit',
  'autoPublishEnabled',
  'configuration',
  'contextGraphs',
  'enabled',
  'privateAuthorityConfigured',
  'privateRecovery',
  'resourceTelemetry',
  'responsibilities',
  'rollout',
  'runtimeSelection',
  'selectedContextGraphs',
  'selectedPrivateContextGraphs',
  'selectedPublicContextGraphs',
  'shadowExecution',
]);

/**
 * Validate the version and rebuild the HTTP boundary from an explicit
 * allow-list. Unknown top-level fields or block fields indicate package skew
 * and fail closed instead of being serialized accidentally.
 */
export function sanitizeRfc64CatalogStatusSnapshotV1(
  input: unknown,
): Rfc64CatalogStatusSnapshotV1 | null {
  if (!isRecordV1(input) || input.schemaVersion !== 1) return null;
  if (!hasExactFieldsV1(input, RFC64_STATUS_SNAPSHOT_FIELDS_V1)) return null;
  const publicCatalog = input.rfc64PublicCatalog;
  const catalog = input.rfc64Catalog;
  if (
    !isRecordV1(publicCatalog)
    || !hasExactFieldsV1(publicCatalog, RFC64_PUBLIC_STATUS_FIELDS_V1)
    || !isRecordV1(catalog)
    || !hasExactFieldsV1(catalog, RFC64_CATALOG_STATUS_FIELDS_V1)
  ) return null;
  const authorityRpcCircuit = sanitizeRfc64AuthorityRpcCircuitSnapshotV1(
    catalog.authorityRpcCircuit,
  );
  const shadowExecution = catalog.shadowExecution === null
    ? null
    : sanitizeRfc64CatalogShadowExecutionStatusV1(catalog.shadowExecution);
  const selectedPublicContextGraphs = stringArrayV1(catalog.selectedPublicContextGraphs);

  return Object.freeze({
    schemaVersion: 1,
    rfc64PublicCatalog: Object.freeze({
      enabled: publicCatalog.enabled,
      selectedContextGraphs: stringArrayV1(publicCatalog.selectedContextGraphs),
      runtimeSelection: projectRecordV1(publicCatalog.runtimeSelection, [
        'selectedContextGraphs',
        'subscriptionDriven',
      ]),
      rollout: projectRecordV1(publicCatalog.rollout, [
        'contextGraphModes',
        'killSwitch',
      ]),
      autoPublishEnabled: publicCatalog.autoPublishEnabled,
      completeSwmProviders: projectRecordArrayV1(publicCatalog.completeSwmProviders, [
        'accessPolicy',
        'contextGraphId',
        'providers',
        'publishPolicy',
      ]),
      service: sanitizeRfc64ServiceStatsV1(publicCatalog.service),
      bootstrap: sanitizeRfc64PublicBootstrapV1(
        publicCatalog.bootstrap,
        new Set(selectedPublicContextGraphs),
      ),
    }),
    rfc64Catalog: Object.freeze({
      enabled: catalog.enabled,
      selectedContextGraphs: stringArrayV1(catalog.selectedContextGraphs),
      selectedPublicContextGraphs,
      selectedPrivateContextGraphs: stringArrayV1(catalog.selectedPrivateContextGraphs),
      runtimeSelection: projectRecordV1(catalog.runtimeSelection, [
        'eligibleContextGraphs',
        'selectedContextGraphs',
        'subscriptionDriven',
      ]),
      responsibilities: projectRecordArrayV1(catalog.responsibilities, [
        'active',
        'contextGraphId',
        'mode',
        'responsibilityReason',
        'responsible',
        'selectionSource',
      ]),
      authorityRpcCircuit,
      contextGraphs: sanitizeRfc64OperationalStatusesV1(catalog.contextGraphs),
      shadowExecution,
      configuration: projectRecordV1(catalog.configuration, [
        'activationManifestPresent',
        'catalogControlPresent',
        'defaultMode',
        'deprecatedDisabledOverride',
        'deprecatedPublicControlPresent',
        'digest',
        'killSwitch',
        'legacyOverrideCount',
        'schemaVersion',
        'shadowOverrideCount',
        'source',
      ]),
      autoPublishEnabled: catalog.autoPublishEnabled,
      rollout: projectRecordV1(catalog.rollout, [
        'contextGraphModes',
        'defaultMode',
        'killSwitch',
      ]),
      privateAuthorityConfigured: catalog.privateAuthorityConfigured,
      privateRecovery: projectRecordArrayV1(catalog.privateRecovery, [
        'accessPolicy',
        'completionReasons',
        'contextGraphId',
        'mode',
        'outcomeCounts',
        'publishPolicy',
        'targetCount',
        'vmRequired',
      ]),
      resourceTelemetry: projectNullableRecordV1(catalog.resourceTelemetry, [
        'controlObjectCacheHits',
        'controlObjectNetworkFetches',
        'kaBundleCacheBytes',
        'kaBundleCacheHits',
        'kaBundleNetworkBytes',
        'kaBundleNetworkFetches',
        'providerAttempts',
        'providerBackoffMs',
        'providerSuccesses',
        'providerSwitches',
      ]),
    }),
  }) as unknown as Rfc64CatalogStatusSnapshotV1;
}

/**
 * Read the agent-owned DTO and unwrap it into the two legacy HTTP blocks.
 */
export async function buildRfc64StatusBlocksV1(input: Readonly<{
  agent: Rfc64StatusReaderV1;
}>) {
  const readSnapshot = input.agent.readRfc64CatalogStatusSnapshotV1;
  if (typeof readSnapshot !== 'function') {
    throw new Error(
      'RFC-64 status snapshot capability is unavailable; agent and CLI versions must match',
    );
  }
  const snapshot = sanitizeRfc64CatalogStatusSnapshotV1(
    await readSnapshot.call(input.agent),
  );
  if (snapshot === null) {
    throw new Error('RFC-64 status snapshot schema is unsupported or malformed');
  }
  return Object.freeze({
    rfc64PublicCatalog: snapshot.rfc64PublicCatalog,
    rfc64Catalog: snapshot.rfc64Catalog,
  });
}

const RFC64_AUTHORITY_RPC_CIRCUIT_STATES_V1 = new Set([
  'closed',
  'open',
  'half-open',
]);

/** Allow-list the public circuit DTO so provider details cannot cross HTTP. */
export function sanitizeRfc64AuthorityRpcCircuitSnapshotV1(
  input: unknown,
): Readonly<{
  state: 'closed' | 'open' | 'half-open';
  consecutiveExhaustions: number;
  retryAtMs: number | null;
}> | null {
  if (!isRecordV1(input)) return null;
  if (!RFC64_AUTHORITY_RPC_CIRCUIT_STATES_V1.has(input.state as string)) return null;
  if (!isNonNegativeSafeIntegerV1(input.consecutiveExhaustions)) return null;
  if (input.retryAtMs !== null && !isNonNegativeSafeIntegerV1(input.retryAtMs)) return null;
  return Object.freeze({
    state: input.state as 'closed' | 'open' | 'half-open',
    consecutiveExhaustions: input.consecutiveExhaustions,
    retryAtMs: input.retryAtMs as number | null,
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

function hasExactFieldsV1(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const fields = Object.keys(value).sort();
  return fields.length === expected.length
    && fields.every((field, index) => field === expected[index]);
}

function stringArrayV1(input: unknown): readonly string[] {
  return Array.isArray(input)
    ? Object.freeze(input.filter((value): value is string => typeof value === 'string'))
    : Object.freeze([]);
}

function projectRecordV1(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (!isRecordV1(input)) return null;
  return Object.freeze(Object.fromEntries(fields.flatMap((field) => (
    Object.hasOwn(input, field) ? [[field, input[field]]] : []
  ))));
}

function projectNullableRecordV1(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> | null {
  return input === null ? null : projectRecordV1(input, fields);
}

function projectRecordArrayV1(
  input: unknown,
  fields: readonly string[],
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(input)) return Object.freeze([]);
  return Object.freeze(input.flatMap((value) => {
    const projected = projectRecordV1(value, fields);
    return projected === null ? [] : [projected];
  }));
}

function sanitizeRfc64ServiceStatsV1(input: unknown): Readonly<Record<string, unknown>> | null {
  if (input === null || !isRecordV1(input)) return null;
  const projected = projectRecordV1(input, ['acceptedPolicies', 'started'])!;
  return Object.freeze({
    ...projected,
    ...(Object.hasOwn(input, 'receiver')
      ? {
          receiver: projectRecordV1(input.receiver, [
            'admissionDeferred',
            'applied',
            'dedupedAlreadyApplied',
            'dedupedInFlight',
            'deferred',
            'droppedProviders',
            'droppedQueueFull',
            'failed',
            'inFlight',
            'notFound',
            'providerAttempts',
            'providerBackoffMs',
            'providerSuccesses',
            'providerSwitches',
            'queued',
            'scheduled',
            'stagedOnly',
            'supersededQueued',
          ]),
        }
      : {}),
    ...(Object.hasOwn(input, 'nativeReceiver')
      ? {
          nativeReceiver: projectNullableRecordV1(input.nativeReceiver, [
            'controlObjectCacheHits',
            'controlObjectNetworkFetches',
            'kaBundleCacheBytes',
            'kaBundleCacheHits',
            'kaBundleNetworkBytes',
            'kaBundleNetworkFetches',
          ]),
        }
      : {}),
  });
}

function sanitizeRfc64PublicBootstrapV1(
  input: unknown,
  selectedPublicContextGraphs: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | null {
  if (input === null || !isRecordV1(input)) return null;
  const projected = projectRecordV1(input, [
    'lastPassCompletedAtMs',
    'lastPassStartedAtMs',
    'pass',
    'retryIntervalMs',
    'running',
  ])!;
  const targets = Array.isArray(input.targets)
    ? input.targets.flatMap((target) => {
        if (!isRecordV1(target) || !isRecordV1(target.scope)) return [];
        const contextGraphId = target.scope.contextGraphId;
        if (typeof contextGraphId !== 'string' || !selectedPublicContextGraphs.has(contextGraphId)) {
          return [];
        }
        return [Object.freeze({
          ...projectRecordV1(target, [
            'appliedHeadDigest',
            'attempts',
            'catalogVersion',
            'completionReason',
            'inventoryRowCount',
            'lastError',
            'mode',
            'outcome',
            'providerPeerId',
            'providers',
            'stagedHeadDigest',
            'updatedAtMs',
          ]),
          scope: projectRecordV1(target.scope, [
            'authorAddress',
            'catalogEra',
            'contextGraphId',
            'networkId',
            'subGraphName',
          ]),
        })];
      })
    : [];
  return Object.freeze({ ...projected, targets: Object.freeze(targets) });
}

function sanitizeRfc64OperationalStatusesV1(
  input: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(input)) return Object.freeze([]);
  return Object.freeze(input.flatMap((status) => {
    if (!isRecordV1(status)) return [];
    return [Object.freeze({
      ...projectRecordV1(status, [
        'accessPolicy',
        'appliedCatalogHeadDigest',
        'appliedInventoryDigest',
        'appliedRowCount',
        'authorHeadCount',
        'authorityEra',
        'authorityFreshness',
        'authorityState',
        'catalogServiceStarted',
        'catalogVersion',
        'contextGraphId',
        'effectiveMode',
        'expectedCatalogHeadDigest',
        'expectedInventoryDigest',
        'expectedRowCount',
        'lastSuccessfulAdvanceAt',
        'legacyReadOnlyCount',
        'legacySyncAllowed',
        'missingRowCount',
        'phase',
        'policyDigest',
        'policySource',
        'publishPolicy',
        'responsibilityReason',
        'selectionSource',
        'stableReason',
      ]),
      ...(Object.hasOwn(status, 'providerHealth')
        ? {
            providerHealth: projectRecordV1(status.providerHealth, [
              'attempts',
              'backoffMs',
              'candidateCount',
              'successes',
              'switches',
            ]),
          }
        : {}),
    })];
  }));
}
