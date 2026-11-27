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
  activationRecords: 512,
  activationBundleBytes: 128 * 1024 * 1024,
  activationVerificationClosureBytes: 256 * 1024 * 1024,
  activationLeaves: 4,
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
  serviceRecordsPerMinuteP10: 60,
  closureServiceBytesPerMinuteP10: 24 * 1024 * 1024,
  arrivalRecordsPerMinuteP99: 16,
  closureArrivalBytesPerMinuteP99: 8 * 1024 * 1024,
  maxDrainMinutes: 18,
  requesterRequestsPerSlice: 12,
  requesterSliceSeconds: 3,
  providerRequestRefillPerMinute: 256,
  providerResponseBytesRefillPerMinute: 32 * 1024 * 1024,
  minimumRequestsPerActiveRecord: 3,
  requesterOverheadRequestsPerMinute: 48,
  providerOverheadRequestsPerMinute: 64,
  loadIntervalSeconds: 60,
  minimumLoadIntervals: 30,
  maximumLoadIntervals: 180,
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

export interface PairedLoadIntervalV1 {
  readonly ordinal: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly requesterSampleDigest: string;
  readonly providerSampleDigest: string;
  readonly cacheState: 'cold' | 'warm';
  readonly servicedRecords: number;
  readonly servicedClosureBytes: number;
  readonly arrivedRecords: number;
  readonly arrivedClosureBytes: number;
  readonly requesterExactRequests: number;
  readonly providerExactRequests: number;
  readonly backlogDeltaRecords: number;
}

export interface LoadIntervalIdentityV1 {
  readonly ordinal: number;
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface RequesterLoadSampleV1 extends LoadIntervalIdentityV1 {
  readonly cacheState: 'cold' | 'warm';
  readonly servicedRecords: number;
  readonly servicedClosureBytes: number;
  readonly arrivedRecords: number;
  readonly arrivedClosureBytes: number;
  readonly requesterExactRequests: number;
  readonly backlogDeltaRecords: number;
}

export interface ProviderLoadSampleV1 extends LoadIntervalIdentityV1 {
  readonly providerExactRequests: number;
}

export interface LoadCaptureExpectationV1 {
  readonly captureId: string;
  readonly requesterSource: string;
  readonly providerSource: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly requesterSampleDigests: readonly string[];
  readonly providerSampleDigests: readonly string[];
}

export interface LoadEnvelopeEvidenceV1 {
  readonly schemaVersion: 1;
  readonly fixtureId: string;
  readonly fixtureManifestSha256: string;
  readonly activeVerificationClosureBytes: number;
  readonly capture: LoadCaptureExpectationV1;
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
    readonly intervalSeconds: 60;
    readonly captureId: string | null;
    readonly requesterSource: string | null;
    readonly providerSource: string | null;
    readonly pairedIntervals: readonly PairedLoadIntervalV1[] | null;
    readonly captureDigest: string | null;
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
  readonly closureDrainMinutes: number | null;
  readonly failures: readonly string[];
}

export interface RequestBudgetVerdictV1 {
  readonly serviceRequestsPerMinute: number;
  readonly requesterRequestsPerMinute: number;
  readonly providerRequestsPerMinute: number;
  readonly requesterHeadroomPerMinute: number;
  readonly providerHeadroomPerMinute: number;
  readonly requesterActivationCeilingPerMinute: number;
  readonly providerActivationCeilingPerMinute: number;
  readonly providerByteHeadroomPerMinute: number;
  readonly feasible: boolean;
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

export function parseLoadEnvelopeEvidenceV1(input: unknown): LoadEnvelopeEvidenceV1 {
  if (!isRecord(input) || input.schemaVersion !== 1) {
    throw new TypeError('load-envelope evidence must be a V1 object');
  }
  assertExactKeys(input, [
    'schemaVersion',
    'fixtureId',
    'fixtureManifestSha256',
    'activeVerificationClosureBytes',
    'capture',
  ], 'load-envelope evidence');
  if (typeof input.fixtureId !== 'string' || input.fixtureId.length === 0) {
    throw new TypeError('load-envelope evidence fixtureId must be non-empty');
  }
  assertSha256(input.fixtureManifestSha256, 'load-envelope evidence fixtureManifestSha256');
  assertFiniteInteger(
    input.activeVerificationClosureBytes,
    'load-envelope evidence activeVerificationClosureBytes',
    0,
  );
  assertLoadCaptureExpectation(input.capture);
  return input as unknown as LoadEnvelopeEvidenceV1;
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

export function characterizeFixtureV1(
  fixture: CharacterizationFixtureV1,
  loadEnvelopeEvidence: LoadEnvelopeEvidenceV1 | null = null,
): CharacterizationResultV1 {
  if (loadEnvelopeEvidence !== null) {
    if (
      loadEnvelopeEvidence.fixtureId !== fixture.fixtureId
      || loadEnvelopeEvidence.fixtureManifestSha256 !== fixture.provenance.manifestSha256
    ) {
      throw new TypeError('load-envelope evidence does not bind the exact fixture');
    }
  }
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
  const activeSubjects = active.map((profile) => profileOwnedSubjectsV1(profile).size);
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
      activeVerificationClosureBytes:
        loadEnvelopeEvidence?.activeVerificationClosureBytes ?? null,
      inventoryLeaves: referenceBTreeBoundsV1(fixture.profilePopulation.activeProfiles).maximumLeaves,
      ...fixture.loadMeasurement,
    }, loadEnvelopeEvidence?.capture ?? null),
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
    : maximumLeaves <= SYSTEM_RECORD_LIMITS_V1.internalMaxEntries
      ? 2
      : 3;
  if (maximumLeaves > 2_048 || maximumHeight > SYSTEM_RECORD_LIMITS_V1.maxTreeHeight) {
    throw new RangeError('reference B+tree exceeds the V1 structural envelope');
  }
  return { records, minimumLeaves, maximumLeaves, maximumHeight };
}

/** Reference size of the compact leaf row; signed objects are exact-fetched by digest. */
export function referenceInventoryRowEncodedBytesV1(
  peerIdBytes: number,
  hasConflictEvidence = false,
): number {
  assertFiniteInteger(
    peerIdBytes,
    'peerIdBytes',
    1,
    SYSTEM_RECORD_LIMITS_V1.maxPeerIdBytes,
  );
  const bytes = 1 + 32 + 2 + peerIdBytes + 8 + 8 + 32
    + (hasConflictEvidence ? 32 : 0) + 1;
  if (bytes > SYSTEM_RECORD_LIMITS_V1.maxRowBytes) {
    throw new RangeError('reference inventory row exceeds the V1 encoded row limit');
  }
  return bytes;
}

/** Algebraic floor proving the frozen service target fits both single-stream budgets. */
export function referenceRequestBudgetV1(): RequestBudgetVerdictV1 {
  const serviceRequestsPerMinute = SYSTEM_RECORD_LIMITS_V1.serviceRecordsPerMinuteP10
    * SYSTEM_RECORD_LIMITS_V1.minimumRequestsPerActiveRecord;
  const requesterRequestsPerMinute = SYSTEM_RECORD_LIMITS_V1.requesterRequestsPerSlice
    * (60 / SYSTEM_RECORD_LIMITS_V1.requesterSliceSeconds);
  const providerRequestsPerMinute = SYSTEM_RECORD_LIMITS_V1.providerRequestRefillPerMinute;
  const requesterHeadroomPerMinute = requesterRequestsPerMinute - serviceRequestsPerMinute;
  const providerHeadroomPerMinute = providerRequestsPerMinute - serviceRequestsPerMinute;
  const requesterActivationCeilingPerMinute = serviceRequestsPerMinute
    + SYSTEM_RECORD_LIMITS_V1.requesterOverheadRequestsPerMinute;
  const providerActivationCeilingPerMinute = serviceRequestsPerMinute
    + SYSTEM_RECORD_LIMITS_V1.providerOverheadRequestsPerMinute;
  const providerByteHeadroomPerMinute =
    SYSTEM_RECORD_LIMITS_V1.providerResponseBytesRefillPerMinute
    - SYSTEM_RECORD_LIMITS_V1.closureServiceBytesPerMinuteP10;
  return {
    serviceRequestsPerMinute,
    requesterRequestsPerMinute,
    providerRequestsPerMinute,
    requesterHeadroomPerMinute,
    providerHeadroomPerMinute,
    requesterActivationCeilingPerMinute,
    providerActivationCeilingPerMinute,
    providerByteHeadroomPerMinute,
    feasible:
      requesterActivationCeilingPerMinute < requesterRequestsPerMinute
      && providerActivationCeilingPerMinute < providerRequestsPerMinute
      && providerByteHeadroomPerMinute > 0,
  };
}

export function evaluateLoadEnvelopeV1(input: {
  readonly activeRecords: number;
  readonly activeBundleBytes: number | null;
  readonly activeVerificationClosureBytes: number | null;
  readonly inventoryLeaves: number;
  readonly intervalSeconds: 60;
  readonly captureId: string | null;
  readonly requesterSource: string | null;
  readonly providerSource: string | null;
  readonly pairedIntervals: readonly PairedLoadIntervalV1[] | null;
  readonly captureDigest: string | null;
}, expectedCapture: LoadCaptureExpectationV1 | null): LoadEnvelopeVerdictV1 {
  if (!referenceRequestBudgetV1().feasible) {
    throw new RangeError('frozen request budgets cannot satisfy the activation service floor');
  }
  assertFiniteInteger(input.activeRecords, 'activeRecords', 0, SYSTEM_RECORD_LIMITS_V1.hardRecords);
  if (input.activeBundleBytes !== null) {
    assertFiniteInteger(input.activeBundleBytes, 'activeBundleBytes', 0);
  }
  if (input.activeVerificationClosureBytes !== null) {
    assertFiniteInteger(
      input.activeVerificationClosureBytes,
      'activeVerificationClosureBytes',
      0,
    );
  }
  assertFiniteInteger(input.inventoryLeaves, 'inventoryLeaves', 0, 2_048);
  if (input.intervalSeconds !== SYSTEM_RECORD_LIMITS_V1.loadIntervalSeconds) {
    throw new RangeError('intervalSeconds must be the frozen one-minute window');
  }
  if (
    input.pairedIntervals !== null
    && input.pairedIntervals.length > SYSTEM_RECORD_LIMITS_V1.maximumLoadIntervals
  ) {
    throw new RangeError('pairedIntervals exceeds the frozen sample cap');
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
  if (input.activeVerificationClosureBytes === null) {
    failures.push('closure_measurement_unavailable');
  } else if (
    input.activeVerificationClosureBytes
      > SYSTEM_RECORD_LIMITS_V1.activationVerificationClosureBytes
  ) {
    failures.push('active_closure_byte_cap');
  }
  if (input.inventoryLeaves > SYSTEM_RECORD_LIMITS_V1.activationLeaves) {
    failures.push('inventory_leaf_cap');
  }

  if (input.pairedIntervals === null) {
    if (
      input.captureId !== null
      || input.requesterSource !== null
      || input.providerSource !== null
      || input.captureDigest !== null
    ) {
      throw new TypeError('absent pairedIntervals requires null capture metadata');
    }
    if (expectedCapture !== null) {
      throw new TypeError('absent pairedIntervals requires no expected capture');
    }
    failures.push('load_measurement_unavailable');
    return { eligible: false, recordDrainMinutes: null, closureDrainMinutes: null, failures };
  }
  if (expectedCapture === null) {
    failures.push('load_capture_expectation_unavailable');
    return { eligible: false, recordDrainMinutes: null, closureDrainMinutes: null, failures };
  }
  assertLoadCapture({ ...input, pairedIntervals: input.pairedIntervals }, expectedCapture);
  if (input.pairedIntervals.length < SYSTEM_RECORD_LIMITS_V1.minimumLoadIntervals) {
    failures.push('insufficient_paired_intervals');
  }
  if (input.pairedIntervals.length === 0) {
    return { eligible: false, recordDrainMinutes: null, closureDrainMinutes: null, failures };
  }
  for (const [index, interval] of input.pairedIntervals.entries()) {
    assertLoadInterval(interval, index);
  }
  if (input.pairedIntervals.some((interval) => interval.cacheState !== 'cold')) {
    failures.push('cold_measurement_required');
  }
  if (input.pairedIntervals.some((interval) => interval.requesterExactRequests
    < interval.servicedRecords * SYSTEM_RECORD_LIMITS_V1.minimumRequestsPerActiveRecord)) {
    failures.push('requester_service_counter_inconsistent');
  }
  if (input.pairedIntervals.some((interval) => interval.providerExactRequests
    < interval.servicedRecords * SYSTEM_RECORD_LIMITS_V1.minimumRequestsPerActiveRecord)) {
    failures.push('provider_service_counter_inconsistent');
  }

  const serviceRecords = loadPercentile(input.pairedIntervals, 'servicedRecords', 0.1);
  const closureServiceBytes = loadPercentile(
    input.pairedIntervals,
    'servicedClosureBytes',
    0.1,
  );
  const arrivalRecords = loadPercentile(input.pairedIntervals, 'arrivedRecords', 0.99);
  const closureArrivalBytes = loadPercentile(
    input.pairedIntervals,
    'arrivedClosureBytes',
    0.99,
  );
  const requesterExactRequests = loadPercentile(
    input.pairedIntervals,
    'requesterExactRequests',
    0.99,
  );
  const providerExactRequests = loadPercentile(
    input.pairedIntervals,
    'providerExactRequests',
    0.99,
  );
  const backlogDelta = input.pairedIntervals.reduce(
    (sum, interval) => sum + interval.backlogDeltaRecords,
    0,
  );
  if (serviceRecords < SYSTEM_RECORD_LIMITS_V1.serviceRecordsPerMinuteP10) {
    failures.push('record_service_floor');
  }
  if (closureServiceBytes < SYSTEM_RECORD_LIMITS_V1.closureServiceBytesPerMinuteP10) {
    failures.push('closure_byte_service_floor');
  }
  if (arrivalRecords > SYSTEM_RECORD_LIMITS_V1.arrivalRecordsPerMinuteP99) {
    failures.push('record_arrival_ceiling');
  }
  if (closureArrivalBytes > SYSTEM_RECORD_LIMITS_V1.closureArrivalBytesPerMinuteP99) {
    failures.push('closure_byte_arrival_ceiling');
  }
  const requestBudget = referenceRequestBudgetV1();
  if (requesterExactRequests > requestBudget.requesterActivationCeilingPerMinute) {
    failures.push('requester_request_ceiling');
  }
  if (providerExactRequests > requestBudget.providerActivationCeilingPerMinute) {
    failures.push('provider_request_ceiling');
  }
  if (backlogDelta >= 0) failures.push('nonnegative_backlog_slope');

  const recordDrainMinutes = serviceRecords > arrivalRecords
    ? input.activeRecords / (serviceRecords - arrivalRecords)
    : Number.POSITIVE_INFINITY;
  const closureDrainMinutes = input.activeVerificationClosureBytes !== null
    && closureServiceBytes > closureArrivalBytes
    ? input.activeVerificationClosureBytes / (closureServiceBytes - closureArrivalBytes)
    : input.activeVerificationClosureBytes === null
      ? null
      : Number.POSITIVE_INFINITY;
  if (recordDrainMinutes > SYSTEM_RECORD_LIMITS_V1.maxDrainMinutes) {
    failures.push('record_drain_deadline');
  }
  if (
    closureDrainMinutes !== null
    && closureDrainMinutes > SYSTEM_RECORD_LIMITS_V1.maxDrainMinutes
  ) {
    failures.push('closure_drain_deadline');
  }
  return {
    eligible: failures.length === 0,
    recordDrainMinutes,
    closureDrainMinutes,
    failures,
  };
}

export function loadIntervalSampleDigestV1(
  captureId: string,
  source: string,
  endpointRole: 'requester',
  interval: RequesterLoadSampleV1,
): string;
export function loadIntervalSampleDigestV1(
  captureId: string,
  source: string,
  endpointRole: 'provider',
  interval: ProviderLoadSampleV1,
): string;
export function loadIntervalSampleDigestV1(
  captureId: string,
  source: string,
  endpointRole: 'requester' | 'provider',
  interval: RequesterLoadSampleV1 | ProviderLoadSampleV1,
): string {
  const common = {
    captureId,
    source,
    endpointRole,
    ordinal: interval.ordinal,
    startedAt: interval.startedAt,
    endedAt: interval.endedAt,
  };
  if (endpointRole === 'requester') {
    const requester = interval as RequesterLoadSampleV1;
    return sha256Canonical({
      ...common,
      cacheState: requester.cacheState,
      servicedRecords: requester.servicedRecords,
      servicedClosureBytes: requester.servicedClosureBytes,
      arrivedRecords: requester.arrivedRecords,
      arrivedClosureBytes: requester.arrivedClosureBytes,
      requesterExactRequests: requester.requesterExactRequests,
      backlogDeltaRecords: requester.backlogDeltaRecords,
    });
  }
  return sha256Canonical({
    ...common,
    providerExactRequests: (interval as ProviderLoadSampleV1).providerExactRequests,
  });
}

export function loadCaptureDigestV1(input: {
  readonly captureId: string;
  readonly requesterSource: string;
  readonly providerSource: string;
  readonly intervalSeconds: 60;
  readonly pairedIntervals: readonly PairedLoadIntervalV1[];
}): string {
  return sha256Canonical({
    captureId: input.captureId,
    requesterSource: input.requesterSource,
    providerSource: input.providerSource,
    intervalSeconds: input.intervalSeconds,
    pairedIntervals: input.pairedIntervals.map((interval) => ({
      ordinal: interval.ordinal,
      startedAt: interval.startedAt,
      endedAt: interval.endedAt,
      requesterSampleDigest: interval.requesterSampleDigest,
      providerSampleDigest: interval.providerSampleDigest,
      cacheState: interval.cacheState,
      servicedRecords: interval.servicedRecords,
      servicedClosureBytes: interval.servicedClosureBytes,
      arrivedRecords: interval.arrivedRecords,
      arrivedClosureBytes: interval.arrivedClosureBytes,
      requesterExactRequests: interval.requesterExactRequests,
      providerExactRequests: interval.providerExactRequests,
      backlogDeltaRecords: interval.backlogDeltaRecords,
    })),
  });
}

function assertLoadInterval(interval: PairedLoadIntervalV1, index: number): void {
  if (!isRecord(interval)) throw new TypeError(`pairedIntervals[${index}] must be an object`);
  assertExactKeys(interval, [
    'ordinal',
    'startedAt',
    'endedAt',
    'requesterSampleDigest',
    'providerSampleDigest',
    'cacheState',
    'servicedRecords',
    'servicedClosureBytes',
    'arrivedRecords',
    'arrivedClosureBytes',
    'requesterExactRequests',
    'providerExactRequests',
    'backlogDeltaRecords',
  ], `pairedIntervals[${index}]`);
  assertFiniteInteger(interval.ordinal, `pairedIntervals[${index}].ordinal`, 0);
  if (typeof interval.startedAt !== 'string' || typeof interval.endedAt !== 'string') {
    throw new TypeError(`pairedIntervals[${index}] timestamps must be strings`);
  }
  assertSha256(interval.requesterSampleDigest, `pairedIntervals[${index}].requesterSampleDigest`);
  assertSha256(interval.providerSampleDigest, `pairedIntervals[${index}].providerSampleDigest`);
  if (interval.cacheState !== 'cold' && interval.cacheState !== 'warm') {
    throw new TypeError(`pairedIntervals[${index}].cacheState must be cold or warm`);
  }
  for (const key of [
    'servicedRecords',
    'servicedClosureBytes',
    'arrivedRecords',
    'arrivedClosureBytes',
    'requesterExactRequests',
    'providerExactRequests',
  ] as const) {
    assertFiniteInteger(interval[key], `pairedIntervals[${index}].${key}`, 0);
  }
  assertFiniteInteger(
    interval.backlogDeltaRecords,
    `pairedIntervals[${index}].backlogDeltaRecords`,
    -SYSTEM_RECORD_LIMITS_V1.hardRecords,
    SYSTEM_RECORD_LIMITS_V1.hardRecords,
  );
}

function assertLoadCapture(input: {
  readonly intervalSeconds: 60;
  readonly captureId: string | null;
  readonly requesterSource: string | null;
  readonly providerSource: string | null;
  readonly pairedIntervals: readonly PairedLoadIntervalV1[];
  readonly captureDigest: string | null;
}, expected: LoadCaptureExpectationV1 | null): void {
  if (
    typeof input.captureId !== 'string'
    || !/^capture:[a-z0-9][a-z0-9._-]{0,63}$/.test(input.captureId)
  ) {
    throw new TypeError('captureId must use the canonical capture identifier grammar');
  }
  if (
    typeof input.requesterSource !== 'string'
    || !/^[a-z0-9][a-z0-9:._-]{0,127}$/.test(input.requesterSource)
  ) {
    throw new TypeError('requesterSource must use the canonical source identifier grammar');
  }
  if (
    typeof input.providerSource !== 'string'
    || !/^[a-z0-9][a-z0-9:._-]{0,127}$/.test(input.providerSource)
  ) {
    throw new TypeError('providerSource must use the canonical source identifier grammar');
  }
  if (expected !== null) {
    assertLoadCaptureExpectation(expected);
    if (
      expected.captureId !== input.captureId
      || expected.requesterSource !== input.requesterSource
      || expected.providerSource !== input.providerSource
    ) {
      throw new TypeError('capture identity does not match the trusted activation manifest');
    }
    const expectedStartedAt = parseCanonicalV1Timestamp(
      expected.startedAt,
      'expected capture start',
    );
    const expectedEndedAt = parseCanonicalV1Timestamp(
      expected.endedAt,
      'expected capture end',
    );
    if (expectedEndedAt <= expectedStartedAt) {
      throw new TypeError('expected capture bounds must be increasing');
    }
    if (input.pairedIntervals.length === 0) {
      throw new TypeError('pairedIntervals cannot satisfy a non-empty expected capture');
    }
    if (
      expected.requesterSampleDigests.length !== input.pairedIntervals.length
      || expected.providerSampleDigests.length !== input.pairedIntervals.length
    ) {
      throw new TypeError('trusted endpoint sample manifests must cover every interval');
    }
  }
  assertSha256(input.captureDigest, 'captureDigest');
  const requesterDigests = new Set<string>();
  const providerDigests = new Set<string>();
  for (const [index, interval] of input.pairedIntervals.entries()) {
    if (interval.ordinal !== index) {
      throw new TypeError('pairedIntervals must have contiguous zero-based ordinals');
    }
    const startedAt = parseCanonicalV1Timestamp(
      interval.startedAt,
      `pairedIntervals[${index}].startedAt`,
    );
    const endedAt = parseCanonicalV1Timestamp(
      interval.endedAt,
      `pairedIntervals[${index}].endedAt`,
    );
    if (endedAt - startedAt !== input.intervalSeconds * 1000) {
      throw new TypeError('pairedIntervals must use exact one-minute windows');
    }
    if (index > 0) {
      const priorEnd = Date.parse(input.pairedIntervals[index - 1].endedAt);
      if (startedAt !== priorEnd) {
        throw new TypeError('pairedIntervals must be strictly contiguous and ordered');
      }
    }
    if (requesterDigests.has(interval.requesterSampleDigest)) {
      throw new TypeError('requester sample digests must be unique');
    }
    if (providerDigests.has(interval.providerSampleDigest)) {
      throw new TypeError('provider sample digests must be unique');
    }
    const digestInput = {
      ordinal: interval.ordinal,
      startedAt: interval.startedAt,
      endedAt: interval.endedAt,
      cacheState: interval.cacheState,
      servicedRecords: interval.servicedRecords,
      servicedClosureBytes: interval.servicedClosureBytes,
      arrivedRecords: interval.arrivedRecords,
      arrivedClosureBytes: interval.arrivedClosureBytes,
      requesterExactRequests: interval.requesterExactRequests,
      providerExactRequests: interval.providerExactRequests,
      backlogDeltaRecords: interval.backlogDeltaRecords,
    };
    if (interval.requesterSampleDigest !== loadIntervalSampleDigestV1(
      input.captureId,
      input.requesterSource,
      'requester',
      digestInput,
    )) {
      throw new TypeError('requester sample digest does not bind its interval/source');
    }
    if (interval.providerSampleDigest !== loadIntervalSampleDigestV1(
      input.captureId,
      input.providerSource,
      'provider',
      digestInput,
    )) {
      throw new TypeError('provider sample digest does not bind its interval/source');
    }
    if (expected !== null && (
      interval.requesterSampleDigest !== expected.requesterSampleDigests[index]
      || interval.providerSampleDigest !== expected.providerSampleDigests[index]
    )) {
      throw new TypeError('paired interval samples do not match the trusted endpoint manifest');
    }
    requesterDigests.add(interval.requesterSampleDigest);
    providerDigests.add(interval.providerSampleDigest);
  }
  if (expected !== null && (
      input.pairedIntervals[0].startedAt !== expected.startedAt
      || input.pairedIntervals[input.pairedIntervals.length - 1].endedAt !== expected.endedAt
  )) {
    throw new TypeError('pairedIntervals do not cover the trusted activation window');
  }
  const expectedDigest = loadCaptureDigestV1({
    captureId: input.captureId,
    requesterSource: input.requesterSource,
    providerSource: input.providerSource,
    intervalSeconds: input.intervalSeconds,
    pairedIntervals: input.pairedIntervals,
  });
  if (input.captureDigest !== expectedDigest) {
    throw new TypeError('captureDigest does not bind the paired interval evidence');
  }
}

function assertLoadCaptureExpectation(
  value: unknown,
): asserts value is LoadCaptureExpectationV1 {
  if (!isRecord(value)) throw new TypeError('load capture expectation must be an object');
  assertExactKeys(value, [
    'captureId',
    'requesterSource',
    'providerSource',
    'startedAt',
    'endedAt',
    'requesterSampleDigests',
    'providerSampleDigests',
  ], 'load capture expectation');
  if (
    typeof value.captureId !== 'string'
    || !/^capture:[a-z0-9][a-z0-9._-]{0,63}$/.test(value.captureId)
  ) {
    throw new TypeError('load capture expectation captureId is invalid');
  }
  for (const key of ['requesterSource', 'providerSource'] as const) {
    if (
      typeof value[key] !== 'string'
      || !/^[a-z0-9][a-z0-9:._-]{0,127}$/.test(value[key] as string)
    ) {
      throw new TypeError(`load capture expectation ${key} is invalid`);
    }
  }
  for (const key of ['startedAt', 'endedAt'] as const) {
    if (typeof value[key] !== 'string') {
      throw new TypeError(`load capture expectation ${key} must be a string`);
    }
  }
  for (const key of ['requesterSampleDigests', 'providerSampleDigests'] as const) {
    const digests = value[key];
    if (!Array.isArray(digests) || digests.length > SYSTEM_RECORD_LIMITS_V1.maximumLoadIntervals) {
      throw new TypeError(`load capture expectation ${key} exceeds the sample cap`);
    }
    for (const [index, digest] of digests.entries()) {
      assertSha256(digest, `load capture expectation ${key}[${index}]`);
    }
    if (new Set(digests).size !== digests.length) {
      throw new TypeError(`load capture expectation ${key} must be unique`);
    }
  }
}

function loadPercentile(
  intervals: readonly PairedLoadIntervalV1[],
  key: 'servicedRecords' | 'servicedClosureBytes' | 'arrivedRecords'
    | 'arrivedClosureBytes' | 'requesterExactRequests' | 'providerExactRequests',
  percentileValue: number,
): number {
  const sorted = intervals.map((interval) => interval[key]).sort((left, right) => left - right);
  return percentile(sorted, percentileValue);
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
  const ownedSubjects = new Set<unknown>([
    value.rootSubject,
    ...(value.linkedSubjects as string[]),
    ...(value.derivedSubjects as string[]),
    ...(value.quads as Array<{ readonly subject?: unknown }>).map((quad) => quad.subject),
  ]);
  if (ownedSubjects.size > SYSTEM_RECORD_LIMITS_V1.maxOwnedSubjects) {
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
      subjectKind === 'root'
      && quad.predicate === 'https://dkg.network/ontology#peerId'
      && quad.objectKind !== 'literal'
    ) {
      throw new TypeError('profile peerId object must be a literal');
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

function profileOwnedSubjectsV1(profile: RedactedProfileEvidenceV1): ReadonlySet<string> {
  return new Set([
    profile.rootSubject,
    ...profile.linkedSubjects,
    ...profile.derivedSubjects,
    ...profile.quads.map((quad) => quad.subject),
  ]);
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
    'intervalSeconds',
    'captureId',
    'requesterSource',
    'providerSource',
    'pairedIntervals',
    'captureDigest',
  ], 'load measurement');
  if (value.intervalSeconds !== SYSTEM_RECORD_LIMITS_V1.loadIntervalSeconds) {
    throw new TypeError('loadMeasurement.intervalSeconds must be 60');
  }
  if (value.pairedIntervals === null) {
    if (
      value.captureId !== null
      || value.requesterSource !== null
      || value.providerSource !== null
      || value.captureDigest !== null
    ) {
      throw new TypeError('absent load intervals require null capture metadata');
    }
    return;
  }
  if (!Array.isArray(value.pairedIntervals)) {
    throw new TypeError('loadMeasurement.pairedIntervals must be an array or null');
  }
  if (value.pairedIntervals.length > SYSTEM_RECORD_LIMITS_V1.maximumLoadIntervals) {
    throw new TypeError('loadMeasurement.pairedIntervals exceeds the frozen sample cap');
  }
  for (const [index, interval] of value.pairedIntervals.entries()) {
    assertLoadInterval(interval as PairedLoadIntervalV1, index);
  }
  assertLoadCapture(value as unknown as {
    intervalSeconds: 60;
    captureId: string | null;
    requesterSource: string | null;
    providerSource: string | null;
    pairedIntervals: readonly PairedLoadIntervalV1[];
    captureDigest: string | null;
  }, null);
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

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a canonical sha256 digest`);
  }
}

function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be an ISO timestamp`);
  return timestamp;
}

function parseCanonicalV1Timestamp(value: string, label: string): number {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/.test(value)) {
    throw new TypeError(`${label} must be a canonical V1 second-precision timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace('.000Z', 'Z') !== value) {
    throw new TypeError(`${label} must be a valid canonical V1 timestamp`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
