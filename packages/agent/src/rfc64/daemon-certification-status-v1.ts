// SPDX-License-Identifier: Apache-2.0

import type { Rfc64CatalogOperationalStatusV1 } from '../dkg-agent-rfc64-catalog.js';
import type { Rfc64CatalogRolloutModeV1 } from './catalog-rollout-authority-v1.js';

export const RFC64_DAEMON_CERTIFICATION_STATUS_SCHEMA_V1 =
  'dkg-rfc64-daemon-certification-status-v1' as const;

export interface Rfc64DaemonCertificationOperationalStatusV1 {
  readonly contextGraphId: string;
  readonly effectiveMode: Rfc64CatalogRolloutModeV1;
  readonly legacySyncAllowed: boolean;
  readonly phase: Rfc64CatalogOperationalStatusV1['phase'];
  readonly authorityState: Rfc64CatalogOperationalStatusV1['authorityState'];
  readonly authorityFreshness: Rfc64CatalogOperationalStatusV1['authorityFreshness'];
  readonly catalogServiceStarted: boolean;
  readonly expectedCatalogHeadDigest: string | null;
  readonly appliedCatalogHeadDigest: string | null;
  readonly expectedInventoryDigest: string | null;
  readonly appliedInventoryDigest: string | null;
  readonly expectedRowCount: string | null;
  readonly appliedRowCount: string | null;
  readonly missingRowCount: string | null;
  readonly catalogVersion: string | null;
  readonly lastSuccessfulAdvanceAt: string | null;
}

export interface Rfc64DaemonCertificationStatusV1 {
  readonly schema: typeof RFC64_DAEMON_CERTIFICATION_STATUS_SCHEMA_V1;
  readonly commit: string | null;
  readonly networkId: string;
  readonly syncReconcilerEnabled: boolean;
  readonly chain: Readonly<{
    readonly configured: boolean;
    readonly rpcEndpointCount: number;
    readonly chainId: string | null;
  }> | null;
  readonly catalog: Readonly<{
    readonly enabled: boolean;
    readonly killSwitch: boolean;
    readonly contextGraphModes: Readonly<Record<string, Rfc64CatalogRolloutModeV1>>;
    readonly contextGraphs: readonly Readonly<Rfc64DaemonCertificationOperationalStatusV1>[];
  }>;
}

export interface CreateRfc64DaemonCertificationStatusInputV1 {
  readonly commit: string | null;
  readonly networkId: string;
  readonly syncReconcilerEnabled: boolean;
  readonly chain: Readonly<{
    readonly configured: boolean;
    readonly rpcEndpointCount: number;
    readonly chainId: string | number | null;
  }> | null;
  readonly catalog: Readonly<{
    readonly enabled: boolean;
    readonly killSwitch: boolean;
    readonly contextGraphModes: Readonly<Record<string, Rfc64CatalogRolloutModeV1>>;
    readonly contextGraphs: readonly Readonly<Rfc64CatalogOperationalStatusV1>[];
  }>;
}

/**
 * Build the narrow, non-secret `/api/status` projection consumed by release
 * certification. Keeping the projection at the producer boundary prevents
 * certification code from reinterpreting the daemon's larger operator shape.
 */
export function createRfc64DaemonCertificationStatusV1(
  input: CreateRfc64DaemonCertificationStatusInputV1,
): Readonly<Rfc64DaemonCertificationStatusV1> {
  return Object.freeze({
    schema: RFC64_DAEMON_CERTIFICATION_STATUS_SCHEMA_V1,
    commit: input.commit,
    networkId: input.networkId,
    syncReconcilerEnabled: input.syncReconcilerEnabled,
    chain: input.chain === null
      ? null
      : Object.freeze({
          configured: input.chain.configured,
          rpcEndpointCount: input.chain.rpcEndpointCount,
          chainId: input.chain.chainId === null ? null : String(input.chain.chainId),
        }),
    catalog: Object.freeze({
      enabled: input.catalog.enabled,
      killSwitch: input.catalog.killSwitch,
      contextGraphModes: Object.freeze({ ...input.catalog.contextGraphModes }),
      contextGraphs: Object.freeze(input.catalog.contextGraphs.map((status) => Object.freeze({
        contextGraphId: status.contextGraphId,
        effectiveMode: status.effectiveMode,
        legacySyncAllowed: status.legacySyncAllowed,
        phase: status.phase,
        authorityState: status.authorityState,
        authorityFreshness: status.authorityFreshness,
        catalogServiceStarted: status.catalogServiceStarted,
        expectedCatalogHeadDigest: status.expectedCatalogHeadDigest,
        appliedCatalogHeadDigest: status.appliedCatalogHeadDigest,
        expectedInventoryDigest: status.expectedInventoryDigest,
        appliedInventoryDigest: status.appliedInventoryDigest,
        expectedRowCount: status.expectedRowCount,
        appliedRowCount: status.appliedRowCount,
        missingRowCount: status.missingRowCount,
        catalogVersion: status.catalogVersion,
        lastSuccessfulAdvanceAt: status.lastSuccessfulAdvanceAt,
      }))),
    }),
  });
}

/** Decode an untrusted JSON value returned by the daemon status endpoint. */
export function decodeRfc64DaemonCertificationStatusV1(
  input: unknown,
): Readonly<Rfc64DaemonCertificationStatusV1> {
  const root = record(input, '$');
  literal(
    root.schema,
    RFC64_DAEMON_CERTIFICATION_STATUS_SCHEMA_V1,
    '$.schema',
  );
  nullableString(root.commit, '$.commit');
  string(root.networkId, '$.networkId');
  boolean(root.syncReconcilerEnabled, '$.syncReconcilerEnabled');
  const chain = root.chain === null ? null : record(root.chain, '$.chain');
  if (chain !== null) {
    boolean(chain.configured, '$.chain.configured');
    number(chain.rpcEndpointCount, '$.chain.rpcEndpointCount');
    nullableString(chain.chainId, '$.chain.chainId');
  }
  const catalog = record(root.catalog, '$.catalog');
  boolean(catalog.enabled, '$.catalog.enabled');
  boolean(catalog.killSwitch, '$.catalog.killSwitch');
  const contextGraphModes = record(
    catalog.contextGraphModes,
    '$.catalog.contextGraphModes',
  );
  for (const [contextGraphId, mode] of Object.entries(contextGraphModes)) {
    nonEmptyString(contextGraphId, '$.catalog.contextGraphModes key');
    rolloutMode(mode, `$.catalog.contextGraphModes.${contextGraphId}`);
  }
  if (!Array.isArray(catalog.contextGraphs)) {
    malformed('$.catalog.contextGraphs', 'array');
  }
  const contextGraphIds = new Set<string>();
  for (const [index, value] of catalog.contextGraphs.entries()) {
    const path = `$.catalog.contextGraphs[${index}]`;
    const status = record(value, path);
    nonEmptyString(status.contextGraphId, `${path}.contextGraphId`);
    if (contextGraphIds.has(status.contextGraphId)) {
      malformed(`${path}.contextGraphId`, 'unique context graph ID');
    }
    contextGraphIds.add(status.contextGraphId);
    rolloutMode(status.effectiveMode, `${path}.effectiveMode`);
    boolean(status.legacySyncAllowed, `${path}.legacySyncAllowed`);
    oneOf(status.phase, [
      'inactive',
      'resolving-authority',
      'bootstrapping',
      'applying',
      'blocked',
      'known-incomplete',
      'unknown-freshness',
      'complete',
    ], `${path}.phase`);
    oneOf(status.authorityState, [
      'inactive',
      'resolving',
      'accepted',
      'blocked',
    ], `${path}.authorityState`);
    if (status.authorityFreshness !== null) {
      oneOf(status.authorityFreshness, ['current', 'unknown'], `${path}.authorityFreshness`);
    }
    boolean(status.catalogServiceStarted, `${path}.catalogServiceStarted`);
    for (const key of [
      'expectedCatalogHeadDigest',
      'appliedCatalogHeadDigest',
      'expectedInventoryDigest',
      'appliedInventoryDigest',
      'expectedRowCount',
      'appliedRowCount',
      'missingRowCount',
      'catalogVersion',
      'lastSuccessfulAdvanceAt',
    ]) nullableString(status[key], `${path}.${key}`);
  }
  return input as Readonly<Rfc64DaemonCertificationStatusV1>;
}

function record(input: unknown, path: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    malformed(path, 'object');
  }
  return input as Record<string, unknown>;
}

function string(input: unknown, path: string): asserts input is string {
  if (typeof input !== 'string') malformed(path, 'string');
}

function nonEmptyString(input: unknown, path: string): asserts input is string {
  if (typeof input !== 'string' || input.length === 0) malformed(path, 'non-empty string');
}

function nullableString(input: unknown, path: string): asserts input is string | null {
  if (input !== null && typeof input !== 'string') malformed(path, 'string or null');
}

function boolean(input: unknown, path: string): asserts input is boolean {
  if (typeof input !== 'boolean') malformed(path, 'boolean');
}

function number(input: unknown, path: string): asserts input is number {
  if (typeof input !== 'number') malformed(path, 'number');
}

function literal(input: unknown, expected: string, path: string): void {
  if (input !== expected) malformed(path, JSON.stringify(expected));
}

function rolloutMode(input: unknown, path: string): asserts input is Rfc64CatalogRolloutModeV1 {
  oneOf(input, ['legacy', 'shadow', 'catalog'], path);
}

function oneOf<T extends string>(
  input: unknown,
  expected: readonly T[],
  path: string,
): asserts input is T {
  if (typeof input !== 'string' || !expected.includes(input as T)) {
    malformed(path, expected.join(' | '));
  }
}

function malformed(path: string, expected: string): never {
  throw new TypeError(`Invalid RFC-64 daemon certification status at ${path}; expected ${expected}`);
}
