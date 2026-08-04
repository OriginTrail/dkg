import { createHash } from 'node:crypto';

import {
  classifyRedactedOwnedSubjectV1,
  expectedRedactedProfileRootV1,
  expectedProfileLinkPredicateV1,
  isAllowedOwnedObjectRelationshipV1,
  isAllowedProfilePredicateV1,
  isCanonicalPeerAliasV1,
  peerAliasOrdinalV1,
  redactedX25519SubjectV1,
  requiresOwnedObjectRelationshipV1,
} from './subjects.js';

export {
  classifyRedactedOwnedSubjectV1 as classifyOwnedSubjectV1,
  expectedRedactedProfileRootV1,
  expectedProfileLinkPredicateV1,
  isAllowedOwnedObjectRelationshipV1,
  isAllowedProfilePredicateV1,
  isCanonicalPeerAliasV1,
  peerAliasOrdinalV1,
  redactedX25519SubjectV1,
  requiresOwnedObjectRelationshipV1,
  PROFILE_LINK_PREDICATES_V1,
} from './subjects.js';
export type { OwnedProfileSubjectKindV1 } from './subjects.js';

export const SYSTEM_RECORD_LIMITS_V1 = Object.freeze({
  activationRecords: 1_024,
  activationBundleBytes: 128 * 1024 * 1024,
  activationLeaves: 8,
  hardRecords: 262_144,
  leafMinRows: 128,
  leafMaxRows: 512,
  internalMinEntries: 128,
  internalMaxEntries: 256,
  maxTreeHeight: 3,
  maxRowBytes: 512,
  maxPeerIdBytes: 256,
  maxLeafBytes: 256 * 1024,
  maxProfileQuads: 10_000,
  maxOwnedSubjects: 2_048,
  maxUpdateObjects: 6,
  maxUpdateBytes: 1024 * 1024,
  serviceRecordsPerMinuteP10: 120,
  serviceBytesPerMinuteP10: 24 * 1024 * 1024,
  arrivalRecordsPerMinuteP99: 60,
  arrivalBytesPerMinuteP99: 8 * 1024 * 1024,
  maxDrainMinutes: 18,
} as const);

export interface RedactedProfileQuadV1 {
  readonly subject: string;
  readonly predicate: string;
  readonly objectKind: 'iri' | 'literal';
  readonly objectBytes: number;
  readonly objectOwnedSubject: string | null;
}

export interface RedactedProfileEvidenceV1 {
  readonly recordId: string;
  readonly peerKeys: readonly string[];
  readonly rootSubject: string;
  readonly disposition: 'candidate' | 'missing-peer' | 'multi-peer-root' | 'peer-multi-root';
  readonly sourceRootShape: 'canonical-wallet' | 'legacy-peer' | 'invalid';
  readonly lastSeenAgeBucket: 'under-1h' | '1-6h' | '6-24h';
  readonly authorityKind: 'eoa' | 'eip1271' | 'unknown';
  readonly capability: 'unsupported' | 'capable' | 'unknown';
  readonly linkedSubjects: readonly string[];
  readonly derivedSubjects: readonly string[];
  readonly quads: readonly RedactedProfileQuadV1[];
  readonly nquadsBytes: number;
  readonly bundleBytes: number | null;
}

export interface SystemSyncObservationV1 {
  readonly graph: 'agents' | 'ontology';
  readonly topLevelAttempts: number;
  readonly distinctPeers: number;
  readonly pageRetries: number;
  readonly failedAttempts: number | null;
  readonly verifiedTriples: number;
  readonly insertedTriples: number | null;
}

export interface CharacterizationFixtureV1 {
  readonly schemaVersion: 1;
  readonly fixtureId: string;
  readonly provenance: {
    readonly sourceCommit: string;
    readonly network: string;
    readonly captureStartedAt: string;
    readonly captureEndedAt: string;
    readonly observationTime: string;
    readonly profileSnapshotKind: string;
    readonly sourceUrls: readonly string[];
    readonly extractionQuerySha256: string;
    readonly populationInputSha256: string;
    readonly detailInputSha256: string;
    readonly diagnosticsArtifactSha256: string;
    readonly profileEvidenceSha256: string;
    readonly manifestSha256: string;
    readonly redactionPolicy: string;
    readonly agentsMetaExcluded: true;
  };
  readonly staleThresholdMs: number;
  readonly systemSync: readonly SystemSyncObservationV1[];
  readonly profilePopulation: {
    readonly observedRoots: number;
    readonly observedPeerKeys: number;
    readonly activeRoots: number;
    readonly activeProfiles: number;
    readonly candidateProfiles: number;
    readonly ambiguousProfiles: number;
    readonly staleProfiles: number;
    readonly unknownFreshnessProfiles: number;
    readonly missingPeerRoots: number;
    readonly duplicatePeerKeys: number;
    readonly sharedRootSubjects: number;
    readonly detailedProfileScope: 'active';
  };
  readonly profiles: readonly RedactedProfileEvidenceV1[];
  readonly loadMeasurement: {
    readonly serviceRecordsPerMinuteP10: number | null;
    readonly serviceBytesPerMinuteP10: number | null;
    readonly arrivalRecordsPerMinuteP99: number | null;
    readonly arrivalBytesPerMinuteP99: number | null;
    readonly backlogSlope: number | null;
  };
}

export interface CharacterizationSourceV1 extends Omit<
  CharacterizationFixtureV1,
  'provenance'
> {
  readonly provenance: Omit<
    CharacterizationFixtureV1['provenance'],
    'profileEvidenceSha256' | 'manifestSha256'
  >;
}

export interface BTreeBoundsV1 {
  readonly records: number;
  readonly minimumLeaves: number;
  readonly maximumLeaves: number;
  readonly maximumHeight: number;
}

export interface LoadEnvelopeVerdictV1 {
  readonly eligible: boolean;
  readonly recordDrainMinutes: number | null;
  readonly byteDrainMinutes: number | null;
  readonly failures: readonly string[];
}

export interface CharacterizationResultV1 {
  readonly fixtureId: string;
  readonly activeProfiles: number;
  readonly candidateProfiles: number;
  readonly ambiguousProfiles: number;
  readonly staleProfiles: number;
  readonly unknownFreshnessProfiles: number;
  readonly duplicatePeerKeys: number;
  readonly sharedRootSubjects: number;
  readonly invalidOwnedSubjects: readonly string[];
  readonly profileStats: {
    readonly quads: QuantilesV1;
    readonly subjects: QuantilesV1;
    readonly nquadsBytes: QuantilesV1;
  };
  readonly authority: Readonly<Record<RedactedProfileEvidenceV1['authorityKind'], number>>;
  readonly capability: Readonly<Record<RedactedProfileEvidenceV1['capability'], number>>;
  readonly tree: BTreeBoundsV1;
  readonly loadEnvelope: LoadEnvelopeVerdictV1;
  readonly systemSync: readonly SystemSyncObservationV1[];
}

export interface QuantilesV1 {
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export function assertEvidenceSourceUrlV1(value: string): void {
  if (!/^https:\/\/github\.com\/OriginTrail\/dkg\/issues\/2052(?:#issuecomment-[1-9][0-9]*)?$/.test(value)) {
    throw new TypeError('evidence source URL is outside the fixed public allowlist');
  }
}

export function parseCharacterizationFixtureV1(input: unknown): CharacterizationFixtureV1 {
  if (!isRecord(input) || input.schemaVersion !== 1 || typeof input.fixtureId !== 'string') {
    throw new TypeError('characterization fixture must be a V1 object');
  }
  assertExactKeys(input, [
    'schemaVersion',
    'fixtureId',
    'provenance',
    'staleThresholdMs',
    'systemSync',
    'profilePopulation',
    'profiles',
    'loadMeasurement',
  ], 'characterization fixture');
  const provenance = decodeProvenance(input.provenance);
  const staleThresholdMs = input.staleThresholdMs;
  assertFiniteInteger(staleThresholdMs, 'staleThresholdMs', 1);
  const systemSync = decodeSystemObservations(input.systemSync);
  const profiles = decodeProfiles(input.profiles);
  const profilePopulation = decodeProfilePopulation(input.profilePopulation, profiles);
  const loadMeasurement = decodeLoadMeasurement(input.loadMeasurement);
  const fixture: CharacterizationFixtureV1 = {
    schemaVersion: 1,
    fixtureId: input.fixtureId,
    provenance,
    staleThresholdMs,
    systemSync,
    profilePopulation,
    profiles,
    loadMeasurement,
  };

  const actualDigest = sha256Canonical(fixture.profiles);
  if (actualDigest !== fixture.provenance.profileEvidenceSha256) {
    throw new TypeError(
      `profile evidence digest mismatch: expected ${fixture.provenance.profileEvidenceSha256}, got ${actualDigest}`,
    );
  }
  const actualManifestDigest = sha256Canonical(manifestDigestInput(fixture));
  if (actualManifestDigest !== fixture.provenance.manifestSha256) {
    throw new TypeError(
      `manifest digest mismatch: expected ${fixture.provenance.manifestSha256}, got ${actualManifestDigest}`,
    );
  }
  return fixture;
}

export function buildCharacterizationFixtureV1(
  source: CharacterizationSourceV1,
): CharacterizationFixtureV1 {
  const draft: CharacterizationFixtureV1 = {
    ...source,
    provenance: {
      ...source.provenance,
      profileEvidenceSha256: sha256Canonical(source.profiles),
      manifestSha256: '',
    },
  };
  return parseCharacterizationFixtureV1({
    ...draft,
    provenance: {
      ...draft.provenance,
      manifestSha256: sha256Canonical(manifestDigestInput(draft)),
    },
  });
}

export function characterizationSourceFromFixtureV1(
  fixture: CharacterizationFixtureV1,
): CharacterizationSourceV1 {
  const { profileEvidenceSha256: _profileDigest, manifestSha256: _manifest, ...provenance } =
    fixture.provenance;
  return { ...fixture, provenance };
}

export function characterizeFixtureV1(fixture: CharacterizationFixtureV1): CharacterizationResultV1 {
  const active = [...fixture.profiles];

  const invalidOwnedSubjects: string[] = [];
  for (const profile of fixture.profiles) {
    if (profile.sourceRootShape !== 'canonical-wallet') {
      invalidOwnedSubjects.push(`${profile.recordId}:source-root:${profile.sourceRootShape}`);
    }
    const linked = new Set(profile.linkedSubjects);
    const derived = new Set(profile.derivedSubjects);
    for (const quad of profile.quads) {
      const subject = quad.subject;
      const kind = classifyRedactedOwnedSubjectV1(profile.rootSubject, subject);
      if (kind === null) {
        invalidOwnedSubjects.push(`${profile.recordId}:${subject}`);
      } else if (
        ['capability', 'offering', 'registration', 'hosting'].includes(kind)
        && !linked.has(subject)
      ) {
        invalidOwnedSubjects.push(`${profile.recordId}:${subject}:unlinked`);
      } else if (kind === 'x25519' && !derived.has(subject)) {
        invalidOwnedSubjects.push(`${profile.recordId}:${subject}:underived`);
      } else if (!isAllowedProfilePredicateV1(kind, quad.predicate)) {
        invalidOwnedSubjects.push(`${profile.recordId}:${subject}:predicate:${quad.predicate}`);
      }
    }
  }

  const activeQuads = active.map((profile) => profile.quads.length);
  const activeSubjects = active.map(
    (profile) => new Set(profile.quads.map((quad) => quad.subject)).size,
  );
  const activeBytes = active.map((profile) => profile.nquadsBytes);
  const activeBundleBytes = active.every((profile) => profile.bundleBytes !== null)
    ? active.reduce((sum, profile) => sum + (profile.bundleBytes as number), 0)
    : null;

  return {
    fixtureId: fixture.fixtureId,
    activeProfiles: fixture.profilePopulation.activeProfiles,
    candidateProfiles: fixture.profilePopulation.candidateProfiles,
    ambiguousProfiles: fixture.profilePopulation.ambiguousProfiles,
    staleProfiles: fixture.profilePopulation.staleProfiles,
    unknownFreshnessProfiles: fixture.profilePopulation.unknownFreshnessProfiles,
    duplicatePeerKeys: fixture.profilePopulation.duplicatePeerKeys,
    sharedRootSubjects: fixture.profilePopulation.sharedRootSubjects,
    invalidOwnedSubjects: Object.freeze(invalidOwnedSubjects.sort()),
    profileStats: {
      quads: quantiles(activeQuads),
      subjects: quantiles(activeSubjects),
      nquadsBytes: quantiles(activeBytes),
    },
    authority: countEnum(fixture.profiles, 'authorityKind', ['eoa', 'eip1271', 'unknown']),
    capability: countEnum(fixture.profiles, 'capability', ['unsupported', 'capable', 'unknown']),
    tree: referenceBTreeBoundsV1(fixture.profilePopulation.activeProfiles),
    loadEnvelope: evaluateLoadEnvelopeV1({
      activeRecords: fixture.profilePopulation.activeProfiles,
      activeBundleBytes,
      inventoryLeaves: referenceBTreeBoundsV1(fixture.profilePopulation.activeProfiles).maximumLeaves,
      ...fixture.loadMeasurement,
    }),
    systemSync: fixture.systemSync,
  };
}

export function referenceBTreeBoundsV1(records: number): BTreeBoundsV1 {
  assertFiniteInteger(records, 'records', 0, SYSTEM_RECORD_LIMITS_V1.hardRecords);
  if (records === 0) {
    return { records, minimumLeaves: 0, maximumLeaves: 0, maximumHeight: 0 };
  }
  const minimumLeaves = Math.ceil(records / SYSTEM_RECORD_LIMITS_V1.leafMaxRows);
  const maximumLeaves = records < 2 * SYSTEM_RECORD_LIMITS_V1.leafMinRows
    ? 1
    : Math.floor(records / SYSTEM_RECORD_LIMITS_V1.leafMinRows);
  const maximumHeight = maximumLeaves <= 1
    ? 1
    : maximumLeaves < 2 * SYSTEM_RECORD_LIMITS_V1.internalMinEntries
      ? 2
      : 3;
  if (maximumLeaves > 2_048 || maximumHeight > SYSTEM_RECORD_LIMITS_V1.maxTreeHeight) {
    throw new RangeError('reference B+tree exceeds the V1 structural envelope');
  }
  return { records, minimumLeaves, maximumLeaves, maximumHeight };
}

/** Reference size of the compact leaf row; signed heads are exact-fetched by digest. */
export function referenceInventoryRowEncodedBytesV1(peerIdBytes: number): number {
  assertFiniteInteger(
    peerIdBytes,
    'peerIdBytes',
    1,
    SYSTEM_RECORD_LIMITS_V1.maxPeerIdBytes,
  );
  const bytes = 1 + 32 + 2 + peerIdBytes + 8 + 8 + 32 + 1;
  if (bytes > SYSTEM_RECORD_LIMITS_V1.maxRowBytes) {
    throw new RangeError('reference inventory row exceeds the V1 encoded row limit');
  }
  return bytes;
}

export function evaluateLoadEnvelopeV1(input: {
  readonly activeRecords: number;
  readonly activeBundleBytes: number | null;
  readonly inventoryLeaves: number;
  readonly serviceRecordsPerMinuteP10: number | null;
  readonly serviceBytesPerMinuteP10: number | null;
  readonly arrivalRecordsPerMinuteP99: number | null;
  readonly arrivalBytesPerMinuteP99: number | null;
  readonly backlogSlope: number | null;
}): LoadEnvelopeVerdictV1 {
  assertFiniteInteger(input.activeRecords, 'activeRecords', 0, SYSTEM_RECORD_LIMITS_V1.hardRecords);
  if (input.activeBundleBytes !== null) {
    assertFiniteInteger(input.activeBundleBytes, 'activeBundleBytes', 0);
  }
  assertFiniteInteger(input.inventoryLeaves, 'inventoryLeaves', 0, 2_048);
  assertOptionalNonnegativeRate(input.serviceRecordsPerMinuteP10, 'serviceRecordsPerMinuteP10');
  assertOptionalNonnegativeRate(input.serviceBytesPerMinuteP10, 'serviceBytesPerMinuteP10');
  assertOptionalNonnegativeRate(input.arrivalRecordsPerMinuteP99, 'arrivalRecordsPerMinuteP99');
  assertOptionalNonnegativeRate(input.arrivalBytesPerMinuteP99, 'arrivalBytesPerMinuteP99');
  if (input.backlogSlope !== null && !Number.isFinite(input.backlogSlope)) {
    throw new TypeError('backlogSlope must be finite or null');
  }
  const failures: string[] = [];
  if (input.activeRecords > SYSTEM_RECORD_LIMITS_V1.activationRecords) {
    failures.push('active_record_cap');
  }
  if (input.activeBundleBytes === null) {
    failures.push('bundle_measurement_unavailable');
  } else if (input.activeBundleBytes > SYSTEM_RECORD_LIMITS_V1.activationBundleBytes) {
    failures.push('active_bundle_byte_cap');
  }
  if (input.inventoryLeaves > SYSTEM_RECORD_LIMITS_V1.activationLeaves) {
    failures.push('inventory_leaf_cap');
  }

  const rates = [
    input.serviceRecordsPerMinuteP10,
    input.serviceBytesPerMinuteP10,
    input.arrivalRecordsPerMinuteP99,
    input.arrivalBytesPerMinuteP99,
    input.backlogSlope,
  ];
  if (rates.some((value) => value === null)) {
    failures.push('load_measurement_unavailable');
    return { eligible: false, recordDrainMinutes: null, byteDrainMinutes: null, failures };
  }

  const serviceRecords = input.serviceRecordsPerMinuteP10 as number;
  const serviceBytes = input.serviceBytesPerMinuteP10 as number;
  const arrivalRecords = input.arrivalRecordsPerMinuteP99 as number;
  const arrivalBytes = input.arrivalBytesPerMinuteP99 as number;
  const backlogSlope = input.backlogSlope as number;
  if (serviceRecords < SYSTEM_RECORD_LIMITS_V1.serviceRecordsPerMinuteP10) {
    failures.push('record_service_floor');
  }
  if (serviceBytes < SYSTEM_RECORD_LIMITS_V1.serviceBytesPerMinuteP10) {
    failures.push('byte_service_floor');
  }
  if (arrivalRecords > SYSTEM_RECORD_LIMITS_V1.arrivalRecordsPerMinuteP99) {
    failures.push('record_arrival_ceiling');
  }
  if (arrivalBytes > SYSTEM_RECORD_LIMITS_V1.arrivalBytesPerMinuteP99) {
    failures.push('byte_arrival_ceiling');
  }
  if (backlogSlope >= 0) failures.push('nonnegative_backlog_slope');

  const recordDrainMinutes = serviceRecords > arrivalRecords
    ? input.activeRecords / (serviceRecords - arrivalRecords)
    : Number.POSITIVE_INFINITY;
  const byteDrainMinutes = input.activeBundleBytes !== null && serviceBytes > arrivalBytes
    ? input.activeBundleBytes / (serviceBytes - arrivalBytes)
    : input.activeBundleBytes === null
      ? null
      : Number.POSITIVE_INFINITY;
  if (recordDrainMinutes > SYSTEM_RECORD_LIMITS_V1.maxDrainMinutes) {
    failures.push('record_drain_deadline');
  }
  if (byteDrainMinutes !== null && byteDrainMinutes > SYSTEM_RECORD_LIMITS_V1.maxDrainMinutes) {
    failures.push('byte_drain_deadline');
  }
  return {
    eligible: failures.length === 0,
    recordDrainMinutes,
    byteDrainMinutes,
    failures,
  };
}

export function sha256Canonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function evidenceDigestInput(
  fixture: Pick<CharacterizationFixtureV1,
    'staleThresholdMs' | 'systemSync' | 'profilePopulation' | 'profiles' | 'loadMeasurement'>,
): unknown {
  return {
    staleThresholdMs: fixture.staleThresholdMs,
    systemSync: fixture.systemSync,
    profilePopulation: fixture.profilePopulation,
    profiles: fixture.profiles,
    loadMeasurement: fixture.loadMeasurement,
  };
}

export function manifestDigestInput(
  fixture: CharacterizationFixtureV1,
): unknown {
  const { manifestSha256: _manifestSha256, ...provenance } = fixture.provenance;
  return {
    schemaVersion: fixture.schemaVersion,
    fixtureId: fixture.fixtureId,
    provenance,
    ...evidenceDigestInput(fixture) as Record<string, unknown>,
  };
}

function quantiles(values: readonly number[]): QuantilesV1 {
  if (values.length === 0) return { min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sorted: readonly number[], value: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * value) - 1);
  return sorted[index];
}

function countEnum<
  T extends RedactedProfileEvidenceV1,
  K extends 'authorityKind' | 'capability',
  V extends T[K] & string,
>(values: readonly T[], key: K, variants: readonly V[]): Readonly<Record<V, number>> {
  const result = Object.fromEntries(variants.map((variant) => [variant, 0])) as Record<V, number>;
  for (const value of values) result[value[key] as V] += 1;
  return Object.freeze(result);
}

function decodeProvenance(value: unknown): CharacterizationFixtureV1['provenance'] {
  assertProvenance(value);
  return value;
}

function decodeSystemObservations(value: unknown): readonly SystemSyncObservationV1[] {
  if (!Array.isArray(value)) throw new TypeError('systemSync must be an array');
  return value.map((observation) => {
    assertSystemObservation(observation);
    return observation;
  });
}

function decodeProfiles(value: unknown): readonly RedactedProfileEvidenceV1[] {
  if (!Array.isArray(value)) throw new TypeError('profiles must be an array');
  const profiles = value.map((profile) => {
    assertProfile(profile);
    return profile;
  });
  assertProfileSet(profiles);
  return profiles;
}

function decodeProfilePopulation(
  value: unknown,
  profiles: readonly RedactedProfileEvidenceV1[],
): CharacterizationFixtureV1['profilePopulation'] {
  assertProfilePopulation(value, profiles);
  return value;
}

function decodeLoadMeasurement(value: unknown): CharacterizationFixtureV1['loadMeasurement'] {
  assertLoadMeasurement(value);
  return value;
}

function assertProvenance(value: unknown): asserts value is CharacterizationFixtureV1['provenance'] {
  if (!isRecord(value)) throw new TypeError('provenance must be an object');
  assertExactKeys(value, [
    'sourceCommit',
    'network',
    'captureStartedAt',
    'captureEndedAt',
    'observationTime',
    'profileSnapshotKind',
    'sourceUrls',
    'extractionQuerySha256',
    'populationInputSha256',
    'detailInputSha256',
    'diagnosticsArtifactSha256',
    'profileEvidenceSha256',
    'manifestSha256',
    'redactionPolicy',
    'agentsMetaExcluded',
  ], 'provenance');
  for (const key of [
    'sourceCommit',
    'network',
    'captureStartedAt',
    'captureEndedAt',
    'observationTime',
    'profileSnapshotKind',
    'extractionQuerySha256',
    'populationInputSha256',
    'detailInputSha256',
    'diagnosticsArtifactSha256',
    'profileEvidenceSha256',
    'manifestSha256',
    'redactionPolicy',
  ]) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new TypeError(`provenance.${key} must be a non-empty string`);
    }
  }
  if (!/^[0-9a-f]{40}$/.test(value.sourceCommit as string)) {
    throw new TypeError('provenance.sourceCommit must be a full lowercase Git SHA');
  }
  if (!Array.isArray(value.sourceUrls) || value.sourceUrls.some((url) => typeof url !== 'string')) {
    throw new TypeError('provenance.sourceUrls must be a string array');
  }
  for (const sourceUrl of value.sourceUrls as string[]) assertEvidenceSourceUrlV1(sourceUrl);
  if (value.agentsMetaExcluded !== true) {
    throw new TypeError('agentsMetaExcluded must be true');
  }
  parseTimestamp(value.captureStartedAt as string, 'captureStartedAt');
  parseTimestamp(value.captureEndedAt as string, 'captureEndedAt');
  parseTimestamp(value.observationTime as string, 'observationTime');
  const captureStart = parseTimestamp(value.captureStartedAt as string, 'captureStartedAt');
  const captureEnd = parseTimestamp(value.captureEndedAt as string, 'captureEndedAt');
  const observation = parseTimestamp(value.observationTime as string, 'observationTime');
  if (captureStart > captureEnd || captureEnd > observation) {
    throw new TypeError('provenance timestamps must be ordered capture start <= end <= observation');
  }
  for (const key of [
    'extractionQuerySha256',
    'populationInputSha256',
    'detailInputSha256',
    'diagnosticsArtifactSha256',
    'profileEvidenceSha256',
    'manifestSha256',
  ]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(value[key] as string)) {
      throw new TypeError(`provenance.${key} must be a canonical SHA-256 digest`);
    }
  }
}

function assertProfile(value: unknown): asserts value is RedactedProfileEvidenceV1 {
  if (!isRecord(value)) throw new TypeError('profile must be an object');
  assertExactKeys(value, [
    'recordId',
    'peerKeys',
    'rootSubject',
    'disposition',
    'sourceRootShape',
    'lastSeenAgeBucket',
    'authorityKind',
    'capability',
    'linkedSubjects',
    'derivedSubjects',
    'quads',
    'nquadsBytes',
    'bundleBytes',
  ], 'profile');
  for (const key of ['recordId', 'rootSubject']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new TypeError(`profile.${key} must be a non-empty string`);
    }
  }
  if (expectedRedactedProfileRootV1(value.recordId as string) !== value.rootSubject) {
    throw new TypeError('profile record/root aliases are not canonical or do not match');
  }
  if (!Array.isArray(value.peerKeys) || value.peerKeys.some((key) => typeof key !== 'string')) {
    throw new TypeError('profile.peerKeys must be a string array');
  }
  assertSortedUniqueStrings(value.peerKeys as string[], 'profile.peerKeys');
  if ((value.peerKeys as string[]).some((peerKey) => !isCanonicalPeerAliasV1(peerKey))) {
    throw new TypeError('profile.peerKeys must contain only fixture-local ordinal aliases');
  }
  if (!['candidate', 'missing-peer', 'multi-peer-root', 'peer-multi-root'].includes(value.disposition as string)) {
    throw new TypeError('profile.disposition is invalid');
  }
  const expectedPeerCount = value.disposition === 'missing-peer'
    ? 0
    : value.disposition === 'multi-peer-root'
      ? 2
      : 1;
  if (
    (value.disposition === 'multi-peer-root' && (value.peerKeys as string[]).length < expectedPeerCount)
    || (value.disposition !== 'multi-peer-root' && (value.peerKeys as string[]).length !== expectedPeerCount)
  ) {
    throw new TypeError('profile peer count contradicts disposition');
  }
  if (!['canonical-wallet', 'legacy-peer', 'invalid'].includes(value.sourceRootShape as string)) {
    throw new TypeError('profile.sourceRootShape is invalid');
  }
  if (!['under-1h', '1-6h', '6-24h'].includes(value.lastSeenAgeBucket as string)) {
    throw new TypeError('profile.lastSeenAgeBucket is invalid');
  }
  if (!['eoa', 'eip1271', 'unknown'].includes(value.authorityKind as string)) {
    throw new TypeError('profile.authorityKind is invalid');
  }
  if (!['unsupported', 'capable', 'unknown'].includes(value.capability as string)) {
    throw new TypeError('profile.capability is invalid');
  }
  for (const key of ['linkedSubjects', 'derivedSubjects', 'quads']) {
    if (!Array.isArray(value[key])) throw new TypeError(`profile.${key} must be an array`);
  }
  assertSortedUniqueStrings(value.linkedSubjects as string[], 'profile.linkedSubjects');
  assertSortedUniqueStrings(value.derivedSubjects as string[], 'profile.derivedSubjects');
  for (const subject of value.derivedSubjects as string[]) {
    if (classifyRedactedOwnedSubjectV1(value.rootSubject as string, subject) !== 'x25519') {
      throw new TypeError('profile.derivedSubjects must contain only redacted x25519 subjects');
    }
  }
  if ((value.quads as unknown[]).length > SYSTEM_RECORD_LIMITS_V1.maxProfileQuads) {
    throw new TypeError('profile.quads exceeds the V1 per-record limit');
  }
  const subjects = new Set(
    (value.quads as Array<{ readonly subject?: unknown }>).map((quad) => quad.subject),
  );
  if (subjects.size > SYSTEM_RECORD_LIMITS_V1.maxOwnedSubjects) {
    throw new TypeError('profile owned subjects exceed the V1 per-record limit');
  }
  assertFiniteInteger(value.nquadsBytes, 'profile.nquadsBytes', 0, 1024 * 1024);
  if (value.bundleBytes !== null) {
    assertFiniteInteger(value.bundleBytes, 'profile.bundleBytes', 0, 1024 * 1024);
  }
  const referencedX25519 = new Set<string>();
  for (const quad of value.quads as unknown[]) {
    if (!isRecord(quad)) throw new TypeError('profile quad must be an object');
    assertExactKeys(quad, [
      'subject',
      'predicate',
      'objectKind',
      'objectBytes',
      'objectOwnedSubject',
    ], 'profile quad');
    if (typeof quad.subject !== 'string' || typeof quad.predicate !== 'string') {
      throw new TypeError('profile quad subject and predicate must be strings');
    }
    if (quad.objectKind !== 'iri' && quad.objectKind !== 'literal') {
      throw new TypeError('profile quad objectKind is invalid');
    }
    if (quad.objectOwnedSubject !== null && typeof quad.objectOwnedSubject !== 'string') {
      throw new TypeError('profile quad objectOwnedSubject must be a string or null');
    }
    if (quad.objectKind !== 'iri' && quad.objectOwnedSubject !== null) {
      throw new TypeError('only an IRI object may reference an owned subject');
    }
    const subjectKind = classifyRedactedOwnedSubjectV1(value.rootSubject as string, quad.subject);
    if (subjectKind === null) {
      throw new TypeError('profile quad subject is outside the redacted owned grammar');
    }
    if (!isAllowedProfilePredicateV1(subjectKind, quad.predicate)) {
      throw new TypeError('profile quad predicate is outside the frozen allowlist');
    }
    if (
      requiresOwnedObjectRelationshipV1(subjectKind, quad.predicate)
      && quad.objectOwnedSubject === null
    ) {
      throw new TypeError('profile quad relationship predicate requires an owned IRI target');
    }
    if (subjectKind === 'x25519') referencedX25519.add(quad.subject);
    if (quad.objectOwnedSubject !== null) {
      const objectKind = classifyRedactedOwnedSubjectV1(
        value.rootSubject as string,
        quad.objectOwnedSubject,
      );
      if (
        objectKind === null
        || !isAllowedOwnedObjectRelationshipV1(
          value.rootSubject as string,
          quad.subject,
          quad.predicate,
          quad.objectOwnedSubject,
        )
      ) {
        throw new TypeError('profile quad owned-object relationship is invalid');
      }
      if (objectKind === 'x25519') referencedX25519.add(quad.objectOwnedSubject);
    }
    assertFiniteInteger(quad.objectBytes, 'profile quad objectBytes', 0, 1024 * 1024);
  }
  const derivedX25519 = new Set(value.derivedSubjects as string[]);
  if (
    derivedX25519.size !== referencedX25519.size
    || [...derivedX25519].some((subject) => !referencedX25519.has(subject))
  ) {
    throw new TypeError('profile derived and referenced x25519 aliases must match exactly');
  }
  const expectedDerivedAliases = (value.derivedSubjects as string[]).map((_, index) => (
    redactedX25519SubjectV1(value.rootSubject as string, index + 1)
  ));
  if (JSON.stringify(expectedDerivedAliases) !== JSON.stringify(value.derivedSubjects)) {
    throw new TypeError('profile x25519 aliases must be dense fixture-local ordinals');
  }
  const derivedLinks = [...new Set((value.quads as RedactedProfileQuadV1[])
    .filter((quad) => quad.subject === value.rootSubject && quad.objectOwnedSubject !== null)
    .filter((quad) => {
      const kind = classifyRedactedOwnedSubjectV1(
        value.rootSubject as string,
        quad.objectOwnedSubject as string,
      );
      return kind !== null && expectedProfileLinkPredicateV1(kind) === quad.predicate;
    })
    .map((quad) => quad.objectOwnedSubject as string))]
    .sort();
  if (JSON.stringify(derivedLinks) !== JSON.stringify(value.linkedSubjects)) {
    throw new TypeError('profile.linkedSubjects does not match canonical root-link quads');
  }
}

function assertProfileSet(profiles: readonly RedactedProfileEvidenceV1[]): void {
  const recordIds = new Set<string>();
  const roots = new Set<string>();
  const peerToProfiles = new Map<string, RedactedProfileEvidenceV1[]>();
  for (const [index, profile] of profiles.entries()) {
    const expectedRecordId = `record:${String(index + 1).padStart(4, '0')}`;
    if (profile.recordId !== expectedRecordId) {
      throw new TypeError('profile record/root aliases must form the dense fixture ordinal sequence');
    }
    if (recordIds.has(profile.recordId) || roots.has(profile.rootSubject)) {
      throw new TypeError('profile record and root aliases must be unique');
    }
    recordIds.add(profile.recordId);
    roots.add(profile.rootSubject);
    for (const peerKey of profile.peerKeys) {
      const owners = peerToProfiles.get(peerKey) ?? [];
      owners.push(profile);
      peerToProfiles.set(peerKey, owners);
    }
  }
  for (const owners of peerToProfiles.values()) {
    if (owners.length > 1 && owners.some((profile) => profile.disposition === 'candidate')) {
      throw new TypeError('candidate profile peer alias is shared by another active root');
    }
  }
}

function assertSystemObservation(value: unknown): asserts value is SystemSyncObservationV1 {
  if (!isRecord(value) || (value.graph !== 'agents' && value.graph !== 'ontology')) {
    throw new TypeError('system sync observation graph is invalid');
  }
  assertExactKeys(value, [
    'graph',
    'topLevelAttempts',
    'distinctPeers',
    'pageRetries',
    'failedAttempts',
    'verifiedTriples',
    'insertedTriples',
  ], 'system sync observation');
  for (const key of [
    'topLevelAttempts',
    'distinctPeers',
    'pageRetries',
    'verifiedTriples',
  ]) {
    assertFiniteInteger(value[key], `systemSync.${key}`, 0);
  }
  for (const key of ['failedAttempts', 'insertedTriples']) {
    if (value[key] !== null) assertFiniteInteger(value[key], `systemSync.${key}`, 0);
  }
}

function assertLoadMeasurement(value: unknown): asserts value is CharacterizationFixtureV1['loadMeasurement'] {
  if (!isRecord(value)) throw new TypeError('loadMeasurement must be an object');
  assertExactKeys(value, [
    'serviceRecordsPerMinuteP10',
    'serviceBytesPerMinuteP10',
    'arrivalRecordsPerMinuteP99',
    'arrivalBytesPerMinuteP99',
    'backlogSlope',
  ], 'load measurement');
  for (const key of [
    'serviceRecordsPerMinuteP10',
    'serviceBytesPerMinuteP10',
    'arrivalRecordsPerMinuteP99',
    'arrivalBytesPerMinuteP99',
    'backlogSlope',
  ]) {
    if (key === 'backlogSlope') {
      if (value[key] !== null && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
        throw new TypeError(`loadMeasurement.${key} must be finite or null`);
      }
    } else {
      assertOptionalNonnegativeRate(value[key] as number | null, `loadMeasurement.${key}`);
    }
  }
}

function assertProfilePopulation(
  value: unknown,
  profiles: readonly RedactedProfileEvidenceV1[],
): asserts value is CharacterizationFixtureV1['profilePopulation'] {
  if (!isRecord(value) || value.detailedProfileScope !== 'active') {
    throw new TypeError('profilePopulation must be an active-scope object');
  }
  assertExactKeys(value, [
    'observedRoots',
    'observedPeerKeys',
    'activeRoots',
    'activeProfiles',
    'candidateProfiles',
    'ambiguousProfiles',
    'staleProfiles',
    'unknownFreshnessProfiles',
    'missingPeerRoots',
    'duplicatePeerKeys',
    'sharedRootSubjects',
    'detailedProfileScope',
  ], 'profile population');
  for (const key of [
    'observedRoots',
    'observedPeerKeys',
    'activeRoots',
    'activeProfiles',
    'candidateProfiles',
    'ambiguousProfiles',
    'staleProfiles',
    'unknownFreshnessProfiles',
    'missingPeerRoots',
    'duplicatePeerKeys',
    'sharedRootSubjects',
  ]) {
    assertFiniteInteger(value[key], `profilePopulation.${key}`, 0);
  }
  if (value.activeProfiles !== profiles.length || value.activeRoots !== profiles.length) {
    throw new TypeError('active root/profile counts do not match detailed profile evidence');
  }
  const candidateProfiles = profiles.filter((profile) => profile.disposition === 'candidate').length;
  const ambiguousProfiles = profiles.length - candidateProfiles;
  if (
    value.candidateProfiles !== candidateProfiles
    || value.ambiguousProfiles !== ambiguousProfiles
  ) {
    throw new TypeError('candidate and ambiguous profile counts contradict profile evidence');
  }
  const detailedPeerAliases = new Set(profiles.flatMap((profile) => [...profile.peerKeys]));
  if (
    detailedPeerAliases.size > (value.observedPeerKeys as number)
    || [...detailedPeerAliases].some((peerKey) => (
      (peerAliasOrdinalV1(peerKey) ?? Number.MAX_SAFE_INTEGER) > (value.observedPeerKeys as number)
    ))
  ) {
    throw new TypeError('profile peer aliases exceed the observed peer population');
  }
  const activeMissingPeerRoots = profiles.filter(
    (profile) => profile.disposition === 'missing-peer',
  ).length;
  const activeSharedRootSubjects = profiles.filter(
    (profile) => profile.disposition === 'multi-peer-root',
  ).length;
  const peerOccurrences = new Map<string, number>();
  for (const profile of profiles) {
    for (const peerKey of profile.peerKeys) {
      peerOccurrences.set(peerKey, (peerOccurrences.get(peerKey) ?? 0) + 1);
    }
  }
  const activeDuplicatePeerKeys = new Set([
    ...[...peerOccurrences.entries()]
      .filter(([, occurrences]) => occurrences > 1)
      .map(([peerKey]) => peerKey),
    ...profiles
      .filter((profile) => profile.disposition === 'peer-multi-root')
      .flatMap((profile) => [...profile.peerKeys]),
  ]);
  if (
    (value.missingPeerRoots as number) < activeMissingPeerRoots
    || (value.sharedRootSubjects as number) < activeSharedRootSubjects
    || (value.duplicatePeerKeys as number) < activeDuplicatePeerKeys.size
  ) {
    throw new TypeError('profile population totals contradict active detailed evidence');
  }
  if (
    (value.duplicatePeerKeys as number) > (value.observedPeerKeys as number)
    || (value.missingPeerRoots as number) + (value.sharedRootSubjects as number)
      > (value.observedRoots as number)
  ) {
    throw new TypeError('profile population relationship counts exceed the observed population');
  }
  if (
    (value.activeRoots as number) +
      (value.staleProfiles as number) +
      (value.unknownFreshnessProfiles as number) !==
    value.observedRoots
  ) {
    throw new TypeError('profilePopulation freshness counts do not sum to observedRoots');
  }
}

function assertOptionalNonnegativeRate(value: number | null, label: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${label} must be non-negative and finite or null`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(canonicalExpected)) {
    throw new TypeError(`${label} must contain exactly the declared schema fields`);
  }
}

function assertSortedUniqueStrings(values: readonly string[], label: string): void {
  for (let index = 0; index < values.length; index += 1) {
    if (typeof values[index] !== 'string' || values[index].length === 0) {
      throw new TypeError(`${label} must contain non-empty strings`);
    }
    if (index > 0 && values[index - 1] >= values[index]) {
      throw new TypeError(`${label} must be sorted and duplicate-free`);
    }
  }
}

function assertFiniteInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer in ${minimum}..${maximum}`);
  }
}

function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be an ISO timestamp`);
  return timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
