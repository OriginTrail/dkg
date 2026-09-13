// SPDX-License-Identifier: Apache-2.0

export const RFC64_DAEMON_CERTIFICATION_STATUS_SCHEMA_V1 =
  'dkg-rfc64-daemon-certification-status-v1' as const;

type RolloutMode = 'legacy' | 'shadow' | 'catalog';
type OperationalPhase =
  | 'inactive'
  | 'resolving-authority'
  | 'bootstrapping'
  | 'applying'
  | 'blocked'
  | 'known-incomplete'
  | 'unknown-freshness'
  | 'complete';
type AuthorityState = 'inactive' | 'resolving' | 'accepted' | 'blocked';
type AuthorityFreshness = 'current' | 'unknown' | null;

export interface Rfc64DaemonCertificationOperationalStatusV1 {
  readonly contextGraphId: string;
  readonly effectiveMode: RolloutMode;
  readonly legacySyncAllowed: boolean;
  readonly phase: OperationalPhase;
  readonly authorityState: AuthorityState;
  readonly authorityFreshness: AuthorityFreshness;
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

interface Rfc64DaemonCertificationChainStatusV1 {
  readonly configured: boolean;
  readonly rpcEndpointCount: number;
  readonly chainId: string | null;
}

interface Rfc64DaemonCertificationCatalogStatusV1 {
  readonly enabled: boolean;
  readonly killSwitch: boolean;
  readonly contextGraphModes: Readonly<Record<string, RolloutMode>>;
  readonly contextGraphs: readonly Readonly<Rfc64DaemonCertificationOperationalStatusV1>[];
}

export interface Rfc64DaemonCertificationStatusV1 {
  readonly schema: typeof RFC64_DAEMON_CERTIFICATION_STATUS_SCHEMA_V1;
  readonly daemonIdentity: string;
  readonly commit: string | null;
  readonly networkId: string;
  readonly syncReconcilerEnabled: boolean;
  readonly chain: Readonly<Rfc64DaemonCertificationChainStatusV1> | null;
  readonly catalog: Readonly<Rfc64DaemonCertificationCatalogStatusV1>;
}

export interface CreateRfc64DaemonCertificationStatusInputV1 {
  readonly daemonIdentity: string;
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
    readonly contextGraphModes: Readonly<Record<string, RolloutMode>>;
    readonly contextGraphs: readonly Rfc64DaemonCertificationOperationalStatusV1[];
  }>;
}

export const RFC64_DAEMON_CERTIFICATION_COMPLETE_PARITY_KEYS_V1 = Object.freeze([
  'expectedCatalogHeadDigest',
  'appliedCatalogHeadDigest',
  'expectedInventoryDigest',
  'appliedInventoryDigest',
  'expectedRowCount',
  'appliedRowCount',
  'missingRowCount',
  'catalogVersion',
] as const satisfies readonly (keyof Rfc64DaemonCertificationOperationalStatusV1)[]);

const ROLLOUT_MODES = ['legacy', 'shadow', 'catalog'] as const;
const OPERATIONAL_PHASES = [
  'inactive',
  'resolving-authority',
  'bootstrapping',
  'applying',
  'blocked',
  'known-incomplete',
  'unknown-freshness',
  'complete',
] as const;
const AUTHORITY_STATES = ['inactive', 'resolving', 'accepted', 'blocked'] as const;
const AUTHORITY_FRESHNESS = ['current', 'unknown'] as const;

/** Build the narrow, detached `/api/status` projection consumed by certification. */
export function createRfc64DaemonCertificationStatusV1(
  input: CreateRfc64DaemonCertificationStatusInputV1,
): Readonly<Rfc64DaemonCertificationStatusV1> {
  return projectStatus(input, true);
}

/** Decode and detach an untrusted JSON value returned by the daemon status endpoint. */
export function decodeRfc64DaemonCertificationStatusV1(
  input: unknown,
): Readonly<Rfc64DaemonCertificationStatusV1> {
  return projectStatus(input, false);
}

function projectStatus(
  input: unknown,
  allowNumericChainId: boolean,
): Rfc64DaemonCertificationStatusV1 {
  const source = record(input, '$');
  if (!allowNumericChainId) {
    literal(source.schema, RFC64_DAEMON_CERTIFICATION_STATUS_SCHEMA_V1, '$.schema');
  }
  return Object.freeze({
    schema: RFC64_DAEMON_CERTIFICATION_STATUS_SCHEMA_V1,
    daemonIdentity: nonEmptyString(source.daemonIdentity, '$.daemonIdentity'),
    commit: nullableString(source.commit, '$.commit'),
    networkId: string(source.networkId, '$.networkId'),
    syncReconcilerEnabled: boolean(source.syncReconcilerEnabled, '$.syncReconcilerEnabled'),
    chain: source.chain === null ? null : projectChain(source.chain, allowNumericChainId),
    catalog: projectCatalog(source.catalog),
  });
}

function projectChain(
  input: unknown,
  allowNumericChainId: boolean,
): Rfc64DaemonCertificationChainStatusV1 {
  const source = record(input, '$.chain');
  const chainId = source.chainId === null
    ? null
    : allowNumericChainId
      ? canonicalString(source.chainId, '$.chain.chainId')
      : string(source.chainId, '$.chain.chainId');
  return Object.freeze({
    configured: boolean(source.configured, '$.chain.configured'),
    rpcEndpointCount: number(source.rpcEndpointCount, '$.chain.rpcEndpointCount'),
    chainId,
  });
}

function projectCatalog(input: unknown): Rfc64DaemonCertificationCatalogStatusV1 {
  const source = record(input, '$.catalog');
  const contextGraphs = array(source.contextGraphs, '$.catalog.contextGraphs').map(
    (value, index) => projectOperational(value, `$.catalog.contextGraphs[${index}]`),
  );
  const seen = new Set<string>();
  for (const [index, status] of contextGraphs.entries()) {
    if (seen.has(status.contextGraphId)) {
      malformed(
        `$.catalog.contextGraphs[${index}].contextGraphId`,
        'unique context graph ID',
      );
    }
    seen.add(status.contextGraphId);
  }
  return Object.freeze({
    enabled: boolean(source.enabled, '$.catalog.enabled'),
    killSwitch: boolean(source.killSwitch, '$.catalog.killSwitch'),
    contextGraphModes: rolloutModeDictionary(
      source.contextGraphModes,
      '$.catalog.contextGraphModes',
    ),
    contextGraphs: Object.freeze(contextGraphs),
  });
}

function projectOperational(
  input: unknown,
  path: string,
): Rfc64DaemonCertificationOperationalStatusV1 {
  const source = record(input, path);
  return Object.freeze({
    contextGraphId: nonEmptyString(source.contextGraphId, `${path}.contextGraphId`),
    effectiveMode: oneOf(source.effectiveMode, ROLLOUT_MODES, `${path}.effectiveMode`),
    legacySyncAllowed: boolean(source.legacySyncAllowed, `${path}.legacySyncAllowed`),
    phase: oneOf(source.phase, OPERATIONAL_PHASES, `${path}.phase`),
    authorityState: oneOf(source.authorityState, AUTHORITY_STATES, `${path}.authorityState`),
    authorityFreshness: source.authorityFreshness === null
      ? null
      : oneOf(source.authorityFreshness, AUTHORITY_FRESHNESS, `${path}.authorityFreshness`),
    catalogServiceStarted: boolean(
      source.catalogServiceStarted,
      `${path}.catalogServiceStarted`,
    ),
    expectedCatalogHeadDigest: nullableString(
      source.expectedCatalogHeadDigest,
      `${path}.expectedCatalogHeadDigest`,
    ),
    appliedCatalogHeadDigest: nullableString(
      source.appliedCatalogHeadDigest,
      `${path}.appliedCatalogHeadDigest`,
    ),
    expectedInventoryDigest: nullableString(
      source.expectedInventoryDigest,
      `${path}.expectedInventoryDigest`,
    ),
    appliedInventoryDigest: nullableString(
      source.appliedInventoryDigest,
      `${path}.appliedInventoryDigest`,
    ),
    expectedRowCount: nullableString(source.expectedRowCount, `${path}.expectedRowCount`),
    appliedRowCount: nullableString(source.appliedRowCount, `${path}.appliedRowCount`),
    missingRowCount: nullableString(source.missingRowCount, `${path}.missingRowCount`),
    catalogVersion: nullableString(source.catalogVersion, `${path}.catalogVersion`),
    lastSuccessfulAdvanceAt: nullableString(
      source.lastSuccessfulAdvanceAt,
      `${path}.lastSuccessfulAdvanceAt`,
    ),
  });
}

function rolloutModeDictionary(
  input: unknown,
  path: string,
): Readonly<Record<string, RolloutMode>> {
  const source = record(input, path);
  const output: Record<string, RolloutMode> = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    nonEmptyString(key, `${path} key`);
    output[key] = oneOf(value, ROLLOUT_MODES, `${path}.${key}`);
  }
  return Object.freeze(output);
}

function record(input: unknown, path: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    malformed(path, 'object');
  }
  return input as Record<string, unknown>;
}

function array(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) malformed(path, 'array');
  return input;
}

function string(input: unknown, path: string): string {
  if (typeof input !== 'string') malformed(path, 'string');
  return input;
}

function nonEmptyString(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.length === 0) malformed(path, 'non-empty string');
  return input;
}

function nullableString(input: unknown, path: string): string | null {
  return input === null ? null : string(input, path);
}

function boolean(input: unknown, path: string): boolean {
  if (typeof input !== 'boolean') malformed(path, 'boolean');
  return input;
}

function number(input: unknown, path: string): number {
  if (typeof input !== 'number') malformed(path, 'number');
  return input;
}

function canonicalString(input: unknown, path: string): string {
  if (typeof input !== 'string' && typeof input !== 'number') {
    malformed(path, 'string or number');
  }
  return String(input);
}

function literal<const Value extends string>(input: unknown, value: Value, path: string): Value {
  if (input !== value) malformed(path, JSON.stringify(value));
  return value;
}

function oneOf<const Values extends readonly string[]>(
  input: unknown,
  values: Values,
  path: string,
): Values[number] {
  if (typeof input !== 'string' || !values.includes(input)) {
    malformed(path, values.join(' | '));
  }
  return input as Values[number];
}

function malformed(path: string, expected: string): never {
  throw new TypeError(`Invalid RFC-64 daemon certification status at ${path}; expected ${expected}`);
}
