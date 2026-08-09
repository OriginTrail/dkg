import { sha256 } from '@noble/hashes/sha2.js';

import {
  hasOwnDataProperty,
  snapshotDataArray,
  snapshotExactDataRecord,
} from './sync-wire-objects.js';
import { type Digest32V1 } from './sync-wire-scalars.js';
import {
  copyBoundedSystemRecordBytesV1,
  failSystemRecordObjectV1 as fail,
} from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_MAX_ACTIVATION_BUNDLE_BYTES,
  SYSTEM_RECORD_MAX_ACTIVATION_CLOSURE_BYTES,
  SYSTEM_RECORD_MAX_ACTIVATION_INVENTORY_LEAVES,
  SYSTEM_RECORD_MAX_ACTIVATION_METADATA_BYTES,
  SYSTEM_RECORD_MAX_ACTIVATION_RECORDS,
  SYSTEM_RECORD_MAX_ACTIVATION_REFERENCES,
  SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_BYTES,
  SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_OBJECTS,
  SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_REFERENCES,
  SYSTEM_RECORD_MAX_CLOSURE_BYTES,
  SYSTEM_RECORD_MAX_CLOSURE_OBJECTS,
  SYSTEM_RECORD_MAX_CLOSURE_SIDECAR_LIVE_METADATA_BYTES,
  SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_AGGREGATE_BYTES,
  SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_METADATA_BYTES,
  SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_REFERENCES,
  SYSTEM_RECORD_MAX_CONFLICT_SIDECARS,
  SYSTEM_RECORD_MAX_INVENTORY_RECORDS,
  SYSTEM_RECORD_MAX_SIDECAR_BYTES,
  SYSTEM_RECORD_MAX_SIDECAR_OBJECTS,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  type SystemRecordObjectKindV1,
} from './system-record-limits-v1.js';

import { digest } from './system-record-agent-profile-primitives-v1-internal.js';
import { deriveSystemRecordArtifactIdentitiesV1 } from './system-record-object-identity-descriptors-v1-internal.js';

interface SystemRecordCacheReferenceFactsV1 {
  readonly byteLength: number;
  readonly fingerprint: string;
}

const MINT_SYSTEM_RECORD_CACHE_REFERENCE_V1 = Symbol('mint-system-record-cache-reference-v1');
const SYSTEM_RECORD_CACHE_REFERENCE_FACTS_V1 = new WeakMap<
  object,
  SystemRecordCacheReferenceFactsV1
>();

class SystemRecordCacheReferenceValueV1 {
  declare private readonly __opaqueSystemRecordCacheReferenceV1: void;

  constructor(
    token: typeof MINT_SYSTEM_RECORD_CACHE_REFERENCE_V1,
    /** Semantic object identity used by authority, closure edges, and inventory rows. */
    public readonly digest: Digest32V1,
    /** Exact physical cache identity; signed controls bind their complete envelope bytes. */
    public readonly cacheDigest: Digest32V1,
    public readonly objectKind: SystemRecordObjectKindV1,
    facts: SystemRecordCacheReferenceFactsV1,
  ) {
    if (token !== MINT_SYSTEM_RECORD_CACHE_REFERENCE_V1) {
      fail('system-record-closure', 'cache reference is factory-only');
    }
    SYSTEM_RECORD_CACHE_REFERENCE_FACTS_V1.set(this, Object.freeze({ ...facts }));
    Object.freeze(this);
  }
}

/**
 * Process-local, factory-only accounting capability bound to exact canonical bytes.
 * It must not be reconstructed, cloned, serialized, or transferred between module instances.
 */
export type SystemRecordCacheReferenceV1 = SystemRecordCacheReferenceValueV1;

/** Create an exact byte-derived accounting reference; unbranded caller counters are rejected. */
export function createSystemRecordCacheReferenceV1(
  objectKind: SystemRecordObjectKindV1,
  objectDigest: Digest32V1,
  canonicalBytes: Uint8Array,
): SystemRecordCacheReferenceV1 {
  digest(objectDigest, 'cache reference digest');
  if (!Object.prototype.hasOwnProperty.call(SYSTEM_RECORD_OBJECT_CAPS_V1, objectKind)) {
    fail('system-record-closure', 'cache reference bytes exceed their object-kind cap');
  }
  let ownedBytes: Uint8Array;
  try {
    ownedBytes = copyBoundedSystemRecordBytesV1(
      canonicalBytes,
      SYSTEM_RECORD_OBJECT_CAPS_V1[objectKind],
      'cache reference canonical bytes',
    );
  } catch (cause) {
    fail('system-record-closure', 'cache reference bytes exceed their object-kind cap', cause);
  }
  if (ownedBytes.byteLength < 1)
    fail('system-record-closure', 'cache reference bytes must not be empty');
  const identities = deriveSystemRecordArtifactIdentitiesV1(
    objectKind,
    ownedBytes,
    'cache reference',
  );
  if (identities.semanticDigest !== objectDigest) {
    fail(
      'system-record-closure',
      'cache reference semantic digest does not bind its canonical bytes',
    );
  }
  return new SystemRecordCacheReferenceValueV1(
    MINT_SYSTEM_RECORD_CACHE_REFERENCE_V1,
    identities.semanticDigest,
    identities.cacheDigest,
    objectKind,
    {
      byteLength: ownedBytes.byteLength,
      fingerprint: Buffer.from(sha256(ownedBytes)).toString('hex'),
    },
  );
}

export interface SystemRecordCacheRowAccountingV1 {
  readonly closure: readonly SystemRecordCacheReferenceV1[];
  readonly sidecar?: readonly SystemRecordCacheReferenceV1[];
  readonly metadata: SystemRecordCacheMetadataV1;
  readonly sidecarMetadata?: SystemRecordCacheMetadataV1;
}

const MINT_SYSTEM_RECORD_CACHE_METADATA_V1 = Symbol('mint-system-record-cache-metadata-v1');
const SYSTEM_RECORD_CACHE_METADATA_BYTES_V1 = new WeakMap<object, number>();

class SystemRecordCacheMetadataValueV1 {
  declare private readonly __opaqueSystemRecordCacheMetadataV1: void;

  constructor(token: typeof MINT_SYSTEM_RECORD_CACHE_METADATA_V1, byteLength: number) {
    if (token !== MINT_SYSTEM_RECORD_CACHE_METADATA_V1) {
      fail('system-record-closure', 'cache metadata is factory-only');
    }
    SYSTEM_RECORD_CACHE_METADATA_BYTES_V1.set(this, byteLength);
    Object.freeze(this);
  }
}

/**
 * Process- and module-instance-local metadata accounting capability. Serialization,
 * structured cloning, worker transfer, reconstruction, or verification by a duplicate
 * loaded module instance intentionally loses the private byte-accounting authority.
 */
export type SystemRecordCacheMetadataV1 = SystemRecordCacheMetadataValueV1;

/** Brand the exact encoded metadata bytes that B2 will include in its atomic baseline preflight. */
export function createSystemRecordCacheMetadataV1(
  encodedMetadata: Uint8Array,
): SystemRecordCacheMetadataV1 {
  let ownedBytes: Uint8Array;
  try {
    ownedBytes = copyBoundedSystemRecordBytesV1(
      encodedMetadata,
      SYSTEM_RECORD_MAX_CLOSURE_SIDECAR_LIVE_METADATA_BYTES,
      'cache metadata bytes',
    );
  } catch (cause) {
    fail('system-record-closure', 'cache metadata bytes exceed the live metadata bound', cause);
  }
  return new SystemRecordCacheMetadataValueV1(
    MINT_SYSTEM_RECORD_CACHE_METADATA_V1,
    ownedBytes.byteLength,
  );
}

export interface SystemRecordCachePreflightResultV1 {
  /** Exact proposed cohort delta; B2 must combine it with its full physical-cache baseline. */
  readonly cohortPhysicalObjects: number;
  readonly cohortPhysicalBytes: number;
  readonly closureReferences: number;
  readonly closurePhysicalBytes: number;
  readonly closureReferencedBytes: number;
  readonly sidecarReferences: number;
  readonly sidecars: number;
  readonly sidecarPhysicalBytes: number;
  readonly sidecarReferencedBytes: number;
  readonly activationBundleBytes: number;
  readonly activationInventoryLeaves: number;
  readonly metadataBytes: number;
}

export interface SystemRecordCachePreflightInputV1 {
  readonly mode: 'live' | 'activation';
  readonly rows: readonly SystemRecordCacheRowAccountingV1[];
  readonly inventoryLeaves?: readonly SystemRecordCacheReferenceV1[];
}

interface NormalizedCachePreflightInputV1 {
  readonly mode: SystemRecordCachePreflightInputV1['mode'];
  readonly rows: readonly SystemRecordCacheRowAccountingV1[];
  readonly inventoryLeaves: readonly SystemRecordCacheReferenceV1[];
}

interface CacheAccountingAccumulatorV1 {
  readonly physical: Map<
    Digest32V1,
    {
      reference: SystemRecordCacheReferenceV1;
      facts: SystemRecordCacheReferenceFactsV1;
    }
  >;
  readonly closurePhysical: Map<Digest32V1, SystemRecordCacheReferenceFactsV1>;
  readonly sidecarPhysical: Map<Digest32V1, SystemRecordCacheReferenceFactsV1>;
  readonly bundlePhysical: Map<Digest32V1, SystemRecordCacheReferenceFactsV1>;
  closureReferences: number;
  closureReferencedBytes: number;
  sidecarReferences: number;
  sidecars: number;
  sidecarReferencedBytes: number;
  metadataBytes: number;
  sidecarMetadataBytes: number;
}

interface CacheAccountingTotalsV1 {
  readonly physicalBytes: number;
  readonly closurePhysicalBytes: number;
  readonly sidecarPhysicalBytes: number;
  readonly closureSidecarPhysicalBytes: number;
  readonly activationBundleBytes: number;
}

function normalizeCachePreflightInputV1(
  input: SystemRecordCachePreflightInputV1,
): NormalizedCachePreflightInputV1 {
  const hasInventoryLeaves = hasOwnDataProperty(input, 'inventoryLeaves');
  const exact = snapshotExactDataRecord(
    input,
    ['mode', 'rows', ...(hasInventoryLeaves ? ['inventoryLeaves'] : [])],
    'cache preflight input',
  );
  if (exact.mode !== 'live' && exact.mode !== 'activation') {
    fail('system-record-closure', 'cache preflight mode is invalid');
  }
  let rows: readonly SystemRecordCacheRowAccountingV1[];
  let inventoryLeaves: readonly SystemRecordCacheReferenceV1[];
  try {
    rows = snapshotDataArray(exact.rows, 'cache rows', {
      maxLength: exact.mode === 'activation'
        ? SYSTEM_RECORD_MAX_ACTIVATION_RECORDS
        : SYSTEM_RECORD_MAX_INVENTORY_RECORDS,
    }) as readonly SystemRecordCacheRowAccountingV1[];
    inventoryLeaves = snapshotDataArray(
      hasInventoryLeaves ? exact.inventoryLeaves : [],
      'activation inventory leaves',
      { maxLength: SYSTEM_RECORD_MAX_ACTIVATION_INVENTORY_LEAVES },
    ) as readonly SystemRecordCacheReferenceV1[];
  } catch (cause) {
    fail('system-record-closure', 'cache cohort arrays exceed their closed bounds', cause);
  }
  if (exact.mode === 'live' && inventoryLeaves.length !== 0) {
    fail('system-record-closure', 'live preflight must not carry activation inventory leaves');
  }
  if (inventoryLeaves.length > SYSTEM_RECORD_MAX_ACTIVATION_INVENTORY_LEAVES) {
    fail('system-record-closure', 'activation inventory exceeds its leaf bound');
  }
  return Object.freeze({ mode: exact.mode, rows, inventoryLeaves });
}

function createCacheAccountingAccumulatorV1(): CacheAccountingAccumulatorV1 {
  return {
    physical: new Map(),
    closurePhysical: new Map(),
    sidecarPhysical: new Map(),
    bundlePhysical: new Map(),
    closureReferences: 0,
    closureReferencedBytes: 0,
    sidecarReferences: 0,
    sidecars: 0,
    sidecarReferencedBytes: 0,
    metadataBytes: 0,
    sidecarMetadataBytes: 0,
  };
}

function collectCacheAccountingRowV1(
  accumulator: CacheAccountingAccumulatorV1,
  row: SystemRecordCacheRowAccountingV1,
): void {
  const hasSidecar = hasOwnDataProperty(row, 'sidecar');
  const hasSidecarMetadata = hasOwnDataProperty(row, 'sidecarMetadata');
  const exactRow = snapshotExactDataRecord(
    row,
    [
      'closure',
      'metadata',
      ...(hasSidecar ? ['sidecar'] : []),
      ...(hasSidecarMetadata ? ['sidecarMetadata'] : []),
    ],
    'cache accounting row',
  );
  let closure: readonly SystemRecordCacheReferenceV1[];
  let sidecar: readonly SystemRecordCacheReferenceV1[] | undefined;
  try {
    closure = snapshotDataArray(exactRow.closure, 'cache row closure', {
      maxLength: SYSTEM_RECORD_MAX_CLOSURE_OBJECTS,
    }) as readonly SystemRecordCacheReferenceV1[];
    sidecar = hasSidecar
      ? (snapshotDataArray(exactRow.sidecar, 'cache row sidecar', {
          maxLength: SYSTEM_RECORD_MAX_SIDECAR_OBJECTS,
        }) as readonly SystemRecordCacheReferenceV1[])
      : undefined;
  } catch (cause) {
    fail('system-record-closure', 'cache row arrays exceed their closed bounds', cause);
  }
  const rowMetadataBytes = requireCacheMetadataBytes(exactRow.metadata, 'cache row metadata');
  if (hasSidecar !== hasSidecarMetadata) {
    fail(
      'system-record-closure',
      'cache row sidecar and sidecar metadata must be present together',
    );
  }
  const rowSidecarMetadataBytes = hasSidecarMetadata
    ? requireCacheMetadataBytes(exactRow.sidecarMetadata, 'cache row sidecar metadata')
    : 0;
  const rowClosureBytes = accountCacheReferencesV1(
    accumulator,
    closure,
    accumulator.closurePhysical,
    'closure',
  );
  if (rowClosureBytes > SYSTEM_RECORD_MAX_CLOSURE_BYTES) {
    fail('system-record-closure', 'row closure exceeds its byte bound');
  }
  accumulator.closureReferences += closure.length;
  accumulator.closureReferencedBytes += rowClosureBytes;
  if (
    !Number.isSafeInteger(accumulator.closureReferences) ||
    !Number.isSafeInteger(accumulator.closureReferencedBytes)
  ) {
    fail('system-record-closure', 'aggregate closure accounting overflow');
  }
  for (const reference of closure) {
    if (reference.objectKind === 'profile-bundle') {
      accumulator.bundlePhysical.set(
        reference.cacheDigest,
        requireCacheReferenceFacts(reference, 'closure'),
      );
    }
  }
  if (sidecar !== undefined) {
    accumulator.sidecars += 1;
    const rowSidecarBytes = accountCacheReferencesV1(
      accumulator,
      sidecar,
      accumulator.sidecarPhysical,
      'sidecar',
    );
    if (
      sidecar.filter((reference) => reference.objectKind === 'conflict-evidence').length !== 1 ||
      sidecar.some(
        (reference) =>
          reference.objectKind !== 'conflict-evidence' &&
          reference.objectKind !== 'agent-profile-head' &&
          reference.objectKind !== 'authority-transition' &&
          reference.objectKind !== 'fork-resolution',
      )
    ) {
      fail(
        'system-record-closure',
        'row sidecar must contain one evidence object and only signed controls',
      );
    }
    if (rowSidecarBytes > SYSTEM_RECORD_MAX_SIDECAR_BYTES) {
      fail('system-record-closure', 'row sidecar exceeds its byte bound');
    }
    accumulator.sidecarReferences += sidecar.length;
    accumulator.sidecarReferencedBytes += rowSidecarBytes;
    if (
      !Number.isSafeInteger(accumulator.sidecarReferences) ||
      !Number.isSafeInteger(accumulator.sidecarReferencedBytes)
    ) {
      fail('system-record-closure', 'aggregate sidecar accounting overflow');
    }
  }
  accumulator.metadataBytes += rowMetadataBytes + rowSidecarMetadataBytes;
  accumulator.sidecarMetadataBytes += rowSidecarMetadataBytes;
  if (!Number.isSafeInteger(accumulator.metadataBytes)) {
    fail('system-record-closure', 'cache metadata accounting overflow');
  }
}

function accountCacheReferencesV1(
  accumulator: CacheAccountingAccumulatorV1,
  references: readonly SystemRecordCacheReferenceV1[],
  category: Map<Digest32V1, SystemRecordCacheReferenceFactsV1>,
  label: string,
): number {
  let total = 0;
  const logical = new Set<string>();
  for (const reference of references) {
    const facts = requireCacheReferenceFacts(reference, label);
    digest(reference.digest, `${label} digest`);
    digest(reference.cacheDigest, `${label} cache digest`);
    const logicalKey = `${reference.objectKind}:${reference.digest}`;
    if (logical.has(logicalKey)) {
      fail('system-record-closure', `${label} contains a duplicate semantic reference`);
    }
    logical.add(logicalKey);
    const prior = accumulator.physical.get(reference.cacheDigest);
    if (
      prior !== undefined &&
      (prior.reference.objectKind !== reference.objectKind ||
        prior.reference.digest !== reference.digest ||
        prior.facts.byteLength !== facts.byteLength ||
        prior.facts.fingerprint !== facts.fingerprint)
    ) {
      fail('system-record-closure', 'one cache digest was reported with conflicting canonical bytes');
    }
    accumulator.physical.set(reference.cacheDigest, { reference, facts });
    category.set(reference.cacheDigest, facts);
    total += facts.byteLength;
    if (!Number.isSafeInteger(total)) {
      fail('system-record-closure', `${label} byte accounting overflow`);
    }
  }
  return total;
}

function assertIncrementalCacheAccountingBoundsV1(
  accumulator: CacheAccountingAccumulatorV1,
): void {
  if (
    accumulator.closurePhysical.size > SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_OBJECTS ||
    accumulator.closureReferences > SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_REFERENCES ||
    accumulator.metadataBytes > SYSTEM_RECORD_MAX_CLOSURE_SIDECAR_LIVE_METADATA_BYTES ||
    accumulator.sidecars > SYSTEM_RECORD_MAX_CONFLICT_SIDECARS ||
    accumulator.sidecarReferences > SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_REFERENCES ||
    accumulator.sidecarMetadataBytes > SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_METADATA_BYTES
  ) {
    fail('system-record-closure', 'aggregate cache accounting exceeds a live V1 bound');
  }
}

function assertFinalLiveCacheAccountingBoundsV1(
  accumulator: CacheAccountingAccumulatorV1,
  totals: CacheAccountingTotalsV1,
): void {
  assertIncrementalCacheAccountingBoundsV1(accumulator);
  if (
    totals.closurePhysicalBytes > SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_BYTES ||
    totals.sidecarPhysicalBytes > SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_AGGREGATE_BYTES
  ) {
    fail('system-record-closure', 'aggregate cache accounting exceeds a live V1 bound');
  }
}

function sumCachePhysicalBytesV1(
  references: ReadonlyMap<Digest32V1, SystemRecordCacheReferenceFactsV1>,
): number {
  return [...references.values()].reduce((sum, facts) => sum + facts.byteLength, 0);
}

function computeCacheAccountingTotalsV1(
  accumulator: CacheAccountingAccumulatorV1,
): CacheAccountingTotalsV1 {
  return Object.freeze({
    physicalBytes: [...accumulator.physical.values()].reduce(
      (sum, entry) => sum + entry.facts.byteLength,
      0,
    ),
    closurePhysicalBytes: sumCachePhysicalBytesV1(accumulator.closurePhysical),
    sidecarPhysicalBytes: sumCachePhysicalBytesV1(accumulator.sidecarPhysical),
    closureSidecarPhysicalBytes: sumCachePhysicalBytesV1(
      new Map([...accumulator.closurePhysical, ...accumulator.sidecarPhysical]),
    ),
    activationBundleBytes: sumCachePhysicalBytesV1(accumulator.bundlePhysical),
  });
}

function assertActivationCacheAccountingBoundsV1(
  normalized: NormalizedCachePreflightInputV1,
  accumulator: CacheAccountingAccumulatorV1,
  totals: CacheAccountingTotalsV1,
): void {
  if (
    normalized.mode === 'activation' &&
    (totals.activationBundleBytes > SYSTEM_RECORD_MAX_ACTIVATION_BUNDLE_BYTES ||
      totals.closureSidecarPhysicalBytes > SYSTEM_RECORD_MAX_ACTIVATION_CLOSURE_BYTES ||
      accumulator.closureReferences +
          accumulator.sidecarReferences +
          normalized.inventoryLeaves.length >
        SYSTEM_RECORD_MAX_ACTIVATION_REFERENCES ||
      accumulator.metadataBytes > SYSTEM_RECORD_MAX_ACTIVATION_METADATA_BYTES)
  ) {
    fail('system-record-closure', 'activation cache accounting exceeds its cohort bound');
  }
}

function projectCacheAccountingResultV1(
  normalized: NormalizedCachePreflightInputV1,
  accumulator: CacheAccountingAccumulatorV1,
  totals: CacheAccountingTotalsV1,
): SystemRecordCachePreflightResultV1 {
  return Object.freeze({
    cohortPhysicalObjects: accumulator.physical.size,
    cohortPhysicalBytes: totals.physicalBytes,
    closureReferences: accumulator.closureReferences,
    closurePhysicalBytes: totals.closurePhysicalBytes,
    closureReferencedBytes: accumulator.closureReferencedBytes,
    sidecarReferences: accumulator.sidecarReferences,
    sidecars: accumulator.sidecars,
    sidecarPhysicalBytes: totals.sidecarPhysicalBytes,
    sidecarReferencedBytes: accumulator.sidecarReferencedBytes,
    activationBundleBytes: totals.activationBundleBytes,
    activationInventoryLeaves: normalized.inventoryLeaves.length,
    metadataBytes: accumulator.metadataBytes,
  });
}

/** Pure all-or-nothing aggregate preflight; shared physical digests are charged once. */
export function preflightSystemRecordCacheAccountingV1(
  input: SystemRecordCachePreflightInputV1,
): SystemRecordCachePreflightResultV1 {
  const normalized = normalizeCachePreflightInputV1(input);
  const accumulator = createCacheAccountingAccumulatorV1();
  for (const row of normalized.rows) {
    collectCacheAccountingRowV1(accumulator, row);
    assertIncrementalCacheAccountingBoundsV1(accumulator);
  }
  accountCacheReferencesV1(
    accumulator,
    normalized.inventoryLeaves,
    new Map(),
    'activation inventory',
  );
  if (
    normalized.inventoryLeaves.some((reference) => reference.objectKind !== 'inventory-leaf')
  ) {
    fail('system-record-closure', 'activation inventory may contain only leaf objects');
  }
  const totals = computeCacheAccountingTotalsV1(accumulator);
  assertFinalLiveCacheAccountingBoundsV1(accumulator, totals);
  assertActivationCacheAccountingBoundsV1(normalized, accumulator, totals);
  return projectCacheAccountingResultV1(normalized, accumulator, totals);
}

function requireCacheMetadataBytes(value: unknown, label: string): number {
  const byteLength =
    typeof value === 'object' && value !== null
      ? SYSTEM_RECORD_CACHE_METADATA_BYTES_V1.get(value)
      : undefined;
  if (byteLength === undefined || Object.keys(value as object).length !== 0) {
    fail('system-record-closure', `${label} was not derived from encoded bytes`);
  }
  return byteLength;
}

function requireCacheReferenceFacts(
  reference: SystemRecordCacheReferenceV1,
  label: string,
): SystemRecordCacheReferenceFactsV1 {
  const facts =
    typeof reference === 'object' && reference !== null
      ? SYSTEM_RECORD_CACHE_REFERENCE_FACTS_V1.get(reference)
      : undefined;
  if (
    facts === undefined ||
    Object.keys(reference).sort().join('\u0000') !== 'cacheDigest\u0000digest\u0000objectKind'
  ) {
    fail('system-record-closure', `${label} reference was not derived from canonical bytes`);
  }
  digest(reference.digest, `${label} digest`);
  digest(reference.cacheDigest, `${label} cache digest`);
  if (!Object.prototype.hasOwnProperty.call(SYSTEM_RECORD_OBJECT_CAPS_V1, reference.objectKind)) {
    fail('system-record-closure', `${label} object kind is invalid`);
  }
  return facts;
}
