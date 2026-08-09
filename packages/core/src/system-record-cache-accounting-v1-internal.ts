import { sha256 } from '@noble/hashes/sha2.js';

import {
  hasOwnDataProperty,
  snapshotDataArray,
  snapshotExactDataRecord,
} from './sync-wire-objects.js';
import { type Digest32V1 } from './sync-wire-scalars.js';
import {
  copyBoundedSystemRecordBytesV1,
  digestSystemRecordBytesV1,
  failSystemRecordObjectV1 as fail,
} from './system-record-codec-primitives-v1.js';
import { parseCanonicalSignedSystemRecordRootDescriptorEnvelopeV1 } from './system-record-inventory-codecs-v1-internal.js';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
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
import {
  computeSignedSystemRecordEnvelopeDigestV1,
  parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1,
  parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
} from './system-record-signatures-v1-internal.js';

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
  const identities = deriveCacheReferenceArtifactIdentitiesV1(
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

/** Pure all-or-nothing aggregate preflight; shared physical digests are charged once. */
export function preflightSystemRecordCacheAccountingV1(
  input: SystemRecordCachePreflightInputV1,
): SystemRecordCachePreflightResultV1 {
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
      maxLength:
        exact.mode === 'activation'
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
  const physical = new Map<
    Digest32V1,
    {
      reference: SystemRecordCacheReferenceV1;
      facts: SystemRecordCacheReferenceFactsV1;
    }
  >();
  const closurePhysical = new Map<Digest32V1, SystemRecordCacheReferenceFactsV1>();
  const sidecarPhysical = new Map<Digest32V1, SystemRecordCacheReferenceFactsV1>();
  const bundlePhysical = new Map<Digest32V1, SystemRecordCacheReferenceFactsV1>();
  let closureReferences = 0;
  let closureReferencedBytes = 0;
  let sidecarReferences = 0;
  let sidecars = 0;
  let sidecarReferencedBytes = 0;
  let metadataBytes = 0;
  let sidecarMetadataBytes = 0;
  for (const row of rows) {
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
    const rowClosureBytes = accountReferences(closure, closurePhysical, 'closure');
    if (rowClosureBytes > SYSTEM_RECORD_MAX_CLOSURE_BYTES) {
      fail('system-record-closure', 'row closure exceeds its byte bound');
    }
    closureReferences += closure.length;
    closureReferencedBytes += rowClosureBytes;
    if (!Number.isSafeInteger(closureReferences) || !Number.isSafeInteger(closureReferencedBytes)) {
      fail('system-record-closure', 'aggregate closure accounting overflow');
    }
    for (const reference of closure) {
      if (reference.objectKind === 'profile-bundle') {
        bundlePhysical.set(reference.cacheDigest, requireCacheReferenceFacts(reference, 'closure'));
      }
    }
    if (sidecar !== undefined) {
      sidecars += 1;
      const rowSidecarBytes = accountReferences(sidecar, sidecarPhysical, 'sidecar');
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
      sidecarReferences += sidecar.length;
      sidecarReferencedBytes += rowSidecarBytes;
      if (
        !Number.isSafeInteger(sidecarReferences) ||
        !Number.isSafeInteger(sidecarReferencedBytes)
      ) {
        fail('system-record-closure', 'aggregate sidecar accounting overflow');
      }
    }
    metadataBytes += rowMetadataBytes + rowSidecarMetadataBytes;
    sidecarMetadataBytes += rowSidecarMetadataBytes;
    if (!Number.isSafeInteger(metadataBytes))
      fail('system-record-closure', 'cache metadata accounting overflow');
    if (
      closurePhysical.size > SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_OBJECTS ||
      closureReferences > SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_REFERENCES ||
      metadataBytes > SYSTEM_RECORD_MAX_CLOSURE_SIDECAR_LIVE_METADATA_BYTES ||
      sidecars > SYSTEM_RECORD_MAX_CONFLICT_SIDECARS ||
      sidecarReferences > SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_REFERENCES ||
      sidecarMetadataBytes > SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_METADATA_BYTES
    ) {
      fail('system-record-closure', 'aggregate cache accounting exceeds a live V1 bound');
    }
  }
  accountReferences(inventoryLeaves, new Map(), 'activation inventory');
  if (inventoryLeaves.some((reference) => reference.objectKind !== 'inventory-leaf')) {
    fail('system-record-closure', 'activation inventory may contain only leaf objects');
  }
  const physicalBytes = [...physical.values()].reduce(
    (sum, entry) => sum + entry.facts.byteLength,
    0,
  );
  const closurePhysicalBytes = sumPhysicalBytes(closurePhysical);
  const sidecarPhysicalBytes = sumPhysicalBytes(sidecarPhysical);
  const closureSidecarPhysicalBytes = sumPhysicalBytes(
    new Map([...closurePhysical, ...sidecarPhysical]),
  );
  const activationBundleBytes = sumPhysicalBytes(bundlePhysical);
  if (
    closurePhysical.size > SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_OBJECTS ||
    closurePhysicalBytes > SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_BYTES ||
    closureReferences > SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_REFERENCES ||
    metadataBytes > SYSTEM_RECORD_MAX_CLOSURE_SIDECAR_LIVE_METADATA_BYTES ||
    sidecars > SYSTEM_RECORD_MAX_CONFLICT_SIDECARS ||
    sidecarReferences > SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_REFERENCES ||
    sidecarPhysicalBytes > SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_AGGREGATE_BYTES ||
    sidecarMetadataBytes > SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_METADATA_BYTES
  ) {
    fail('system-record-closure', 'aggregate cache accounting exceeds a live V1 bound');
  }
  if (
    exact.mode === 'activation' &&
    (activationBundleBytes > SYSTEM_RECORD_MAX_ACTIVATION_BUNDLE_BYTES ||
      closureSidecarPhysicalBytes > SYSTEM_RECORD_MAX_ACTIVATION_CLOSURE_BYTES ||
      closureReferences + sidecarReferences + inventoryLeaves.length >
        SYSTEM_RECORD_MAX_ACTIVATION_REFERENCES ||
      metadataBytes > SYSTEM_RECORD_MAX_ACTIVATION_METADATA_BYTES)
  ) {
    fail('system-record-closure', 'activation cache accounting exceeds its cohort bound');
  }
  return Object.freeze({
    cohortPhysicalObjects: physical.size,
    cohortPhysicalBytes: physicalBytes,
    closureReferences,
    closurePhysicalBytes,
    closureReferencedBytes,
    sidecarReferences,
    sidecars,
    sidecarPhysicalBytes,
    sidecarReferencedBytes,
    activationBundleBytes,
    activationInventoryLeaves: inventoryLeaves.length,
    metadataBytes,
  });

  function accountReferences(
    references: readonly SystemRecordCacheReferenceV1[],
    category: Map<Digest32V1, SystemRecordCacheReferenceFactsV1>,
    label: string,
  ): number {
    let total = 0;
    const logical = new Set<string>();
    for (const reference of references as readonly SystemRecordCacheReferenceV1[]) {
      const facts = requireCacheReferenceFacts(reference, label);
      digest(reference.digest, `${label} digest`);
      digest(reference.cacheDigest, `${label} cache digest`);
      const logicalKey = `${reference.objectKind}:${reference.digest}`;
      if (logical.has(logicalKey)) {
        fail('system-record-closure', `${label} contains a duplicate semantic reference`);
      }
      logical.add(logicalKey);
      const prior = physical.get(reference.cacheDigest);
      if (
        prior !== undefined &&
        (prior.reference.objectKind !== reference.objectKind ||
          prior.reference.digest !== reference.digest ||
          prior.facts.byteLength !== facts.byteLength ||
          prior.facts.fingerprint !== facts.fingerprint)
      ) {
        fail(
          'system-record-closure',
          'one cache digest was reported with conflicting canonical bytes',
        );
      }
      physical.set(reference.cacheDigest, { reference, facts });
      category.set(reference.cacheDigest, facts);
      total += facts.byteLength;
      if (!Number.isSafeInteger(total))
        fail('system-record-closure', `${label} byte accounting overflow`);
    }
    return total;
  }

  function sumPhysicalBytes(
    references: ReadonlyMap<Digest32V1, SystemRecordCacheReferenceFactsV1>,
  ): number {
    return [...references.values()].reduce((sum, facts) => sum + facts.byteLength, 0);
  }
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

function deriveCacheReferenceArtifactIdentitiesV1(
  objectKind: SystemRecordObjectKindV1,
  canonicalBytes: Uint8Array,
  label: string,
): Readonly<{ semanticDigest: Digest32V1; cacheDigest: Digest32V1 }> {
  let semanticDigest: Digest32V1;
  let cacheDigest: Digest32V1;
  if (objectKind === 'agent-profile-head') {
    const envelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(canonicalBytes);
    semanticDigest = envelope.objectDigest;
    cacheDigest = computeSignedSystemRecordEnvelopeDigestV1(envelope);
  } else if (objectKind === 'authority-transition') {
    const envelope = parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1(canonicalBytes);
    semanticDigest = envelope.objectDigest;
    cacheDigest = computeSignedSystemRecordEnvelopeDigestV1(envelope);
  } else if (objectKind === 'fork-resolution') {
    const envelope = parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1(canonicalBytes);
    semanticDigest = envelope.objectDigest;
    cacheDigest = computeSignedSystemRecordEnvelopeDigestV1(envelope);
  } else if (objectKind === 'root-descriptor') {
    const envelope = parseCanonicalSignedSystemRecordRootDescriptorEnvelopeV1(canonicalBytes);
    semanticDigest = envelope.objectDigest;
    cacheDigest = digestSystemRecordBytesV1(
      SYSTEM_RECORD_DIGEST_DOMAINS_V1.signedRootDescriptorEnvelope,
      canonicalBytes,
    );
  } else {
    const domains: Record<
      Exclude<
        SystemRecordObjectKindV1,
        'agent-profile-head' | 'authority-transition' | 'fork-resolution' | 'root-descriptor'
      >,
      string
    > = {
      'inventory-internal': SYSTEM_RECORD_DIGEST_DOMAINS_V1.inventoryInternal,
      'inventory-leaf': SYSTEM_RECORD_DIGEST_DOMAINS_V1.inventoryLeaf,
      'conflict-evidence': SYSTEM_RECORD_DIGEST_DOMAINS_V1.conflictEvidence,
      'owned-subject-table': SYSTEM_RECORD_DIGEST_DOMAINS_V1.ownedSubjectTable,
      'profile-bundle': SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
    };
    semanticDigest = digestSystemRecordBytesV1(domains[objectKind], canonicalBytes);
    cacheDigest = semanticDigest;
  }
  if (semanticDigest.length !== 66 || cacheDigest.length !== 66) {
    fail('system-record-closure', `${label} artifact identity is invalid`);
  }
  return Object.freeze({ semanticDigest, cacheDigest });
}
