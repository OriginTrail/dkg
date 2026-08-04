import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SYSTEM_RECORD_LIMITS_V1,
  assertEvidenceSourceUrlV1,
  characterizeFixtureV1,
  classifyOwnedSubjectV1,
  evaluateLoadEnvelopeV1,
  expectedProfileLinkPredicateV1,
  manifestDigestInput,
  parseCharacterizationFixtureV1,
  referenceBTreeBoundsV1,
  referenceInventoryRowEncodedBytesV1,
  sha256Canonical,
  type CharacterizationFixtureV1,
  type RedactedProfileEvidenceV1,
} from './model.js';
import { deriveProfilePopulationV1 } from './population.js';

const here = dirname(fileURLToPath(import.meta.url));

test('classifies only the frozen exact profile subject shapes', () => {
  const root = 'did:dkg:agent:0x0000000000000000000000000000000000000001';
  assert.equal(classifyOwnedSubjectV1(root, root), 'root');
  assert.equal(classifyOwnedSubjectV1(root, `${root}/.well-known/genid/cap1`), 'capability');
  assert.equal(classifyOwnedSubjectV1(root, `${root}/.well-known/genid/offering2`), 'offering');
  assert.equal(classifyOwnedSubjectV1(root, `${root}/.well-known/genid/registration`), 'registration');
  assert.equal(classifyOwnedSubjectV1(root, `${root}/.well-known/genid/hosting`), 'hosting');
  assert.equal(classifyOwnedSubjectV1(root, `${root}#fixture-x25519-0001`), 'x25519');
  assert.equal(classifyOwnedSubjectV1(root, `${root}#x25519-${'a'.repeat(32)}`), null);
  assert.equal(classifyOwnedSubjectV1(root, `${root}/other`), null);
  assert.equal(classifyOwnedSubjectV1(root, `${root}/.well-known/arbitrary`), null);
  assert.equal(classifyOwnedSubjectV1(root, `${root}/.well-known/genid/cap0`), null);
  assert.equal(classifyOwnedSubjectV1(root, `${root}/.well-known/genid/cap%31`), null);
  assert.equal(classifyOwnedSubjectV1(root, `${root}#x25519-${'A'.repeat(32)}`), null);
  assert.equal(classifyOwnedSubjectV1(root, `${root}/.well-known/../escape`), null);
  assert.equal(
    expectedProfileLinkPredicateV1('hosting'),
    'https://dkg.origintrail.io/skill#hostingProfile',
  );
});

test('proves the reference B+tree hard and activation ceilings algebraically', () => {
  assert.deepEqual(referenceBTreeBoundsV1(0), {
    records: 0,
    minimumLeaves: 0,
    maximumLeaves: 0,
    maximumHeight: 0,
  });
  assert.deepEqual(referenceBTreeBoundsV1(SYSTEM_RECORD_LIMITS_V1.activationRecords), {
    records: 1_024,
    minimumLeaves: 2,
    maximumLeaves: 8,
    maximumHeight: 2,
  });
  assert.equal(referenceBTreeBoundsV1(255).maximumLeaves, 1);
  assert.equal(referenceBTreeBoundsV1(256).maximumLeaves, 2);
  assert.equal(referenceBTreeBoundsV1(512).maximumLeaves, 4);
  assert.equal(referenceBTreeBoundsV1(32_767).maximumHeight, 2);
  assert.equal(referenceBTreeBoundsV1(32_768).maximumHeight, 3);
  assert.equal(
    referenceInventoryRowEncodedBytesV1(SYSTEM_RECORD_LIMITS_V1.maxPeerIdBytes),
    340,
  );
  assert.deepEqual(referenceBTreeBoundsV1(SYSTEM_RECORD_LIMITS_V1.hardRecords), {
    records: 262_144,
    minimumLeaves: 512,
    maximumLeaves: 2_048,
    maximumHeight: 3,
  });
  assert.throws(() => referenceBTreeBoundsV1(262_145), /records must be an integer/);
});

test('accepts the heartbeat-aware activation load equation with deadline reserve', () => {
  const verdict = evaluateLoadEnvelopeV1({
    activeRecords: 1_024,
    activeBundleBytes: 128 * 1024 * 1024,
    inventoryLeaves: 8,
    serviceRecordsPerMinuteP10: 120,
    serviceBytesPerMinuteP10: 24 * 1024 * 1024,
    arrivalRecordsPerMinuteP99: 60,
    arrivalBytesPerMinuteP99: 8 * 1024 * 1024,
    backlogSlope: -1,
  });
  assert.equal(verdict.eligible, true);
  assert.ok(verdict.recordDrainMinutes !== null && verdict.recordDrainMinutes < 18);
  assert.equal(verdict.byteDrainMinutes, 8);
});

test('blocks activation when arrivals saturate service or measurements are absent', () => {
  const saturated = evaluateLoadEnvelopeV1({
    activeRecords: 1_024,
    activeBundleBytes: 1,
    inventoryLeaves: 8,
    serviceRecordsPerMinuteP10: 120,
    serviceBytesPerMinuteP10: 24 * 1024 * 1024,
    arrivalRecordsPerMinuteP99: 120,
    arrivalBytesPerMinuteP99: 1,
    backlogSlope: 0,
  });
  assert.equal(saturated.eligible, false);
  assert.ok(saturated.failures.includes('record_arrival_ceiling'));
  assert.ok(saturated.failures.includes('record_drain_deadline'));
  assert.ok(saturated.failures.includes('nonnegative_backlog_slope'));

  const absent = evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    inventoryLeaves: 1,
    serviceRecordsPerMinuteP10: null,
    serviceBytesPerMinuteP10: null,
    arrivalRecordsPerMinuteP99: null,
    arrivalBytesPerMinuteP99: null,
    backlogSlope: null,
  });
  assert.deepEqual(absent.failures, ['load_measurement_unavailable']);
  assert.throws(() => evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    inventoryLeaves: 1,
    serviceRecordsPerMinuteP10: 120,
    serviceBytesPerMinuteP10: 1,
    arrivalRecordsPerMinuteP99: -1,
    arrivalBytesPerMinuteP99: 0,
    backlogSlope: -1,
  }), /arrivalRecordsPerMinuteP99 must be non-negative/);
});

test('groups by peer key, detects root collisions, and rejects unredacted subjects', () => {
  const first = { ...profile(1, 'peer:0001'), disposition: 'peer-multi-root' as const };
  const second = {
    ...profile(2, 'peer:0001'),
    disposition: 'peer-multi-root' as const,
  };
  const shared = {
    ...profile(3, 'peer:0002'),
    peerKeys: ['peer:0002', 'peer:0003'],
    disposition: 'multi-peer-root' as const,
  };
  const invalid = {
    ...profile(4, 'peer:0004'),
    quads: [{
      subject: 'urn:external:1',
      predicate: 'https://schema.org/name',
      objectKind: 'literal' as const,
      objectBytes: 4,
      objectOwnedSubject: null,
    }],
  };
  const fixture = parseCharacterizationFixtureV1(withDigest({
    ...baseFixture(),
    profiles: [first, second, shared],
  }));
  const result = characterizeFixtureV1(fixture);
  assert.equal(result.duplicatePeerKeys, 1);
  assert.equal(result.sharedRootSubjects, 1);
  assert.equal(result.ambiguousProfiles, 3);
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [invalid],
    })),
    /quad subject is outside the redacted owned grammar/,
  );
});

test('rejects a fixture whose redacted evidence digest is not reproducible', () => {
  const fixture = withDigest({ ...baseFixture(), profiles: [profile(1, 'peer:0001')] });
  const corrupted = {
    ...fixture,
    profiles: fixture.profiles.map((value, index) => index === 0
      ? { ...value, nquadsBytes: value.nquadsBytes + 1 }
      : value),
  };
  assert.throws(() => parseCharacterizationFixtureV1(corrupted), /digest mismatch/);

  const populationCorrupted = {
    ...fixture,
    profilePopulation: {
      ...fixture.profilePopulation,
      observedPeerKeys: fixture.profilePopulation.observedPeerKeys + 1,
    },
  };
  assert.throws(() => parseCharacterizationFixtureV1(populationCorrupted), /manifest digest mismatch/);
  const provenanceCorrupted = {
    ...fixture,
    provenance: {
      ...fixture.provenance,
      sourceCommit: 'a297a7b6ffb6df82305c1f7eb76864a8b7a77c35',
    },
  };
  assert.throws(() => parseCharacterizationFixtureV1(provenanceCorrupted), /manifest digest mismatch/);

  const secretUrl = signFixture({
    ...fixture,
    provenance: {
      ...fixture.provenance,
      sourceUrls: ['https://user:secret@example.com/evidence?token=sensitive'],
    },
  });
  assert.throws(
    () => parseCharacterizationFixtureV1(secretUrl),
    /fixed public allowlist/,
  );
  assert.doesNotThrow(
    () => assertEvidenceSourceUrlV1(
      'https://github.com/OriginTrail/dkg/issues/2052#issuecomment-5181539933',
    ),
  );
});

test('rejects malicious root links and per-record envelope overflow', () => {
  const base = profile(1, 'peer:0001');
  const nested = `${base.rootSubject}/.well-known/genid/hosting`;
  const malicious = {
    ...base,
    linkedSubjects: [nested],
    quads: [
      ...base.quads,
      {
        subject: base.rootSubject,
        predicate: 'https://schema.org/name',
        objectKind: 'iri' as const,
        objectBytes: 64,
        objectOwnedSubject: nested,
      },
    ],
  };
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({ ...baseFixture(), profiles: [malicious] })),
    /owned-object relationship is invalid/,
  );

  const missingRootLinkTarget = {
    ...base,
    quads: [
      ...base.quads,
      {
        subject: base.rootSubject,
        predicate: 'http://www.w3.org/ns/prov#wasGeneratedBy',
        objectKind: 'iri' as const,
        objectBytes: 64,
        objectOwnedSubject: null,
      },
    ],
  };
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [missingRootLinkTarget],
    })),
    /relationship predicate requires an owned IRI target/,
  );

  const oversized = {
    ...base,
    quads: Array.from({ length: SYSTEM_RECORD_LIMITS_V1.maxProfileQuads + 1 }, () => base.quads[0]),
  };
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({ ...baseFixture(), profiles: [oversized] })),
    /quads exceeds/,
  );
});

test('rejects arbitrary derived and owned-object identifiers with valid digests', () => {
  const base = profile(1, 'peer:0001');
  const profileWithUnknownField = { ...base, rawPeerId: '12D3KooW-sensitive' };
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [profileWithUnknownField],
    })),
    /profile must contain exactly the declared schema fields/,
  );
  const quadWithUnknownField = { ...base.quads[0], rawObject: 'secret-token' };
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [{
        ...base,
        quads: [quadWithUnknownField],
      }],
    })),
    /profile quad must contain exactly the declared schema fields/,
  );
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [{ ...base, derivedSubjects: ['raw-peer-or-key-value'] }],
    })),
    /derivedSubjects must contain only redacted x25519 subjects/,
  );

  const arbitraryObject = {
    ...base,
    quads: [{
      ...base.quads[0],
      objectKind: 'iri' as const,
      objectOwnedSubject: 'urn:raw:wallet-or-token',
    }],
  };
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [arbitraryObject],
    })),
    /owned-object relationship is invalid/,
  );

  const unreferenced = `${base.rootSubject}#fixture-x25519-0001`;
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [{ ...base, derivedSubjects: [unreferenced] }],
    })),
    /derived and referenced x25519 aliases must match exactly/,
  );

  const referencedButUnderived = {
    ...base,
    quads: [
      ...base.quads,
      {
        subject: unreferenced,
        predicate: 'https://dkg.network/ontology#revokedAt',
        objectKind: 'literal' as const,
        objectBytes: 24,
        objectOwnedSubject: null,
      },
    ],
  };
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [referencedButUnderived],
    })),
    /derived and referenced x25519 aliases must match exactly/,
  );
});

test('binds fixture-local aliases and profile dispositions across the profile set', () => {
  const base = profile(1, 'peer:0001');
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [{ ...base, recordId: 'raw-record-or-key' }],
    })),
    /record\/root aliases are not canonical/,
  );
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [{ ...base, peerKeys: ['raw-peer-or-key'] }],
    })),
    /fixture-local ordinal aliases/,
  );

  const valid = withDigest({ ...baseFixture(), profiles: [base] });
  const duplicateRoot = signFixture({
    ...valid,
    profiles: [base, { ...base }],
    profilePopulation: {
      ...valid.profilePopulation,
      activeRoots: 2,
      activeProfiles: 2,
      candidateProfiles: 2,
    },
  });
  assert.throws(
    () => parseCharacterizationFixtureV1(duplicateRoot),
    /dense fixture ordinal sequence|must be unique/,
  );

  const sharedCandidate = profile(2, 'peer:0001');
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [base, sharedCandidate],
    })),
    /candidate profile peer alias is shared/,
  );

  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [profile(9_999, 'peer:0001')],
    })),
    /dense fixture ordinal sequence/,
  );
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [profile(1, 'peer:9999')],
    })),
    /peer aliases exceed the observed peer population/,
  );

  const sparseKey = `${base.rootSubject}#fixture-x25519-9999`;
  const sparseKeyProfile = {
    ...base,
    derivedSubjects: [sparseKey],
    quads: [
      ...base.quads,
      {
        subject: sparseKey,
        predicate: 'https://dkg.network/ontology#revokedAt',
        objectKind: 'literal' as const,
        objectBytes: 24,
        objectOwnedSubject: null,
      },
    ],
  };
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [sparseKeyProfile],
    })),
    /x25519 aliases must be dense fixture-local ordinals/,
  );
});

test('accepts only the production x25519 revokedBy relationship', () => {
  const base = profile(1, 'peer:0001');
  const key = `${base.rootSubject}#fixture-x25519-0001`;
  const valid = {
    ...base,
    derivedSubjects: [key],
    quads: [
      ...base.quads,
      {
        subject: key,
        predicate: 'https://dkg.network/ontology#revokedBy',
        objectKind: 'iri' as const,
        objectBytes: 58,
        objectOwnedSubject: base.rootSubject,
      },
    ],
  };
  assert.doesNotThrow(
    () => parseCharacterizationFixtureV1(withDigest({ ...baseFixture(), profiles: [valid] })),
  );

  const reversed = {
    ...valid,
    quads: [
      ...base.quads,
      {
        subject: key,
        predicate: 'https://dkg.network/ontology#revokedBy',
        objectKind: 'iri' as const,
        objectBytes: 58,
        objectOwnedSubject: key,
      },
    ],
  };
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({ ...baseFixture(), profiles: [reversed] })),
    /owned-object relationship is invalid/,
  );

  const missingTarget = {
    ...valid,
    quads: [
      ...base.quads,
      {
        subject: key,
        predicate: 'https://dkg.network/ontology#revokedBy',
        objectKind: 'iri' as const,
        objectBytes: 58,
        objectOwnedSubject: null,
      },
    ],
  };
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [missingTarget],
    })),
    /relationship predicate requires an owned IRI target/,
  );
});

test('rejects profile population counts that contradict signed profile evidence', () => {
  const ambiguous = {
    ...profile(1, 'peer:0001'),
    disposition: 'peer-multi-root' as const,
  };
  const valid = withDigest({ ...baseFixture(), profiles: [ambiguous] });
  const contradictory = signFixture({
    ...valid,
    profilePopulation: {
      ...valid.profilePopulation,
      candidateProfiles: 1,
      ambiguousProfiles: 0,
    },
  });
  assert.throws(
    () => parseCharacterizationFixtureV1(contradictory),
    /counts contradict profile evidence/,
  );

  const contradictoryActiveCount = signFixture({
    ...valid,
    profilePopulation: {
      ...valid.profilePopulation,
      activeRoots: 0,
      activeProfiles: 0,
    },
  });
  assert.throws(
    () => parseCharacterizationFixtureV1(contradictoryActiveCount),
    /active root\/profile counts do not match detailed profile evidence/,
  );

  const missingPeer = {
    ...profile(1, 'peer:0001'),
    peerKeys: [],
    disposition: 'missing-peer' as const,
  };
  const validMissingPeer = withDigest({ ...baseFixture(), profiles: [missingPeer] });
  assert.throws(
    () => parseCharacterizationFixtureV1(signFixture({
      ...validMissingPeer,
      profilePopulation: { ...validMissingPeer.profilePopulation, missingPeerRoots: 0 },
    })),
    /population totals contradict active detailed evidence/,
  );

  const multiPeer = {
    ...profile(1, 'peer:0001'),
    peerKeys: ['peer:0001', 'peer:0002'],
    disposition: 'multi-peer-root' as const,
  };
  const validMultiPeer = withDigest({ ...baseFixture(), profiles: [multiPeer] });
  assert.throws(
    () => parseCharacterizationFixtureV1(signFixture({
      ...validMultiPeer,
      profilePopulation: { ...validMultiPeer.profilePopulation, sharedRootSubjects: 0 },
    })),
    /population totals contradict active detailed evidence/,
  );

  const firstShared = { ...profile(1, 'peer:0001'), disposition: 'peer-multi-root' as const };
  const secondShared = { ...profile(2, 'peer:0001'), disposition: 'peer-multi-root' as const };
  const validShared = withDigest({ ...baseFixture(), profiles: [firstShared, secondShared] });
  assert.throws(
    () => parseCharacterizationFixtureV1(signFixture({
      ...validShared,
      profilePopulation: { ...validShared.profilePopulation, duplicatePeerKeys: 0 },
    })),
    /population totals contradict active detailed evidence/,
  );

  const firstMulti = {
    ...profile(1, 'peer:0001'),
    peerKeys: ['peer:0001', 'peer:0002'],
    disposition: 'multi-peer-root' as const,
  };
  const secondMulti = {
    ...profile(2, 'peer:0001'),
    peerKeys: ['peer:0001', 'peer:0003'],
    disposition: 'multi-peer-root' as const,
  };
  const validMultiShared = withDigest({
    ...baseFixture(),
    profiles: [firstMulti, secondMulti],
  });
  assert.throws(
    () => parseCharacterizationFixtureV1(signFixture({
      ...validMultiShared,
      profilePopulation: { ...validMultiShared.profilePopulation, duplicatePeerKeys: 0 },
    })),
    /population totals contradict active detailed evidence/,
  );

  const single = withDigest({
    ...baseFixture(),
    profiles: [profile(1, 'peer:0001')],
  });
  assert.throws(
    () => parseCharacterizationFixtureV1(signFixture({
      ...single,
      profilePopulation: { ...single.profilePopulation, duplicatePeerKeys: 2 },
    })),
    /relationship counts exceed the observed population/,
  );
  assert.throws(
    () => parseCharacterizationFixtureV1(signFixture({
      ...single,
      profilePopulation: {
        ...single.profilePopulation,
        missingPeerRoots: 1,
        sharedRootSubjects: 1,
      },
    })),
    /relationship counts exceed the observed population/,
  );
});

test('loads the committed r27 fixture and keeps baseline activation fail-closed', async () => {
  const raw = JSON.parse(
    await readFile(resolve(here, 'fixtures/r27-v1.json'), 'utf8'),
  ) as unknown;
  const result = characterizeFixtureV1(parseCharacterizationFixtureV1(raw));
  assert.equal(result.invalidOwnedSubjects.length, 0);
  assert.ok(result.activeProfiles > 0);
  assert.equal(result.ambiguousProfiles, 1);
  assert.equal(result.loadEnvelope.eligible, false);
  assert.ok(result.loadEnvelope.failures.includes('bundle_measurement_unavailable'));
  assert.ok(result.loadEnvelope.failures.includes('load_measurement_unavailable'));
});

function profile(index: number, peerKey: string): RedactedProfileEvidenceV1 {
  const root = `did:dkg:agent:0x${index.toString(16).padStart(40, '0')}`;
  return {
    recordId: `record:${String(index).padStart(4, '0')}`,
    peerKeys: [peerKey],
    rootSubject: root,
    disposition: 'candidate',
    sourceRootShape: 'canonical-wallet',
    lastSeenAgeBucket: '1-6h',
    authorityKind: 'unknown',
    capability: 'unsupported',
    linkedSubjects: [],
    derivedSubjects: [],
    quads: [{
      subject: root,
      predicate: 'https://dkg.network/ontology#peerId',
      objectKind: 'literal',
      objectBytes: 12,
      objectOwnedSubject: null,
    }],
    nquadsBytes: 256,
    bundleBytes: 384,
  };
}

function baseFixture(): Omit<CharacterizationFixtureV1, 'profiles'> & { profiles: RedactedProfileEvidenceV1[] } {
  return {
    schemaVersion: 1,
    fixtureId: 'test',
    provenance: {
      sourceCommit: 'c297a7b6ffb6df82305c1f7eb76864a8b7a77c35',
      network: 'testnet',
      captureStartedAt: '2026-08-04T11:00:00.000Z',
      captureEndedAt: '2026-08-04T13:00:00.000Z',
      observationTime: '2026-08-04T13:00:00.000Z',
      profileSnapshotKind: 'synthetic test fixture',
      sourceUrls: ['https://github.com/OriginTrail/dkg/issues/2052'],
      extractionQuerySha256: `sha256:${'0'.repeat(64)}`,
      populationInputSha256: `sha256:${'1'.repeat(64)}`,
      detailInputSha256: `sha256:${'2'.repeat(64)}`,
      diagnosticsArtifactSha256: `sha256:${'3'.repeat(64)}`,
      profileEvidenceSha256: `sha256:${'4'.repeat(64)}`,
      manifestSha256: `sha256:${'5'.repeat(64)}`,
      redactionPolicy: 'test',
      agentsMetaExcluded: true,
    },
    staleThresholdMs: 86_400_000,
    systemSync: [],
    profilePopulation: {
      observedRoots: 0,
      observedPeerKeys: 0,
      activeRoots: 0,
      activeProfiles: 0,
      candidateProfiles: 0,
      ambiguousProfiles: 0,
      staleProfiles: 0,
      unknownFreshnessProfiles: 0,
      missingPeerRoots: 0,
      duplicatePeerKeys: 0,
      sharedRootSubjects: 0,
      detailedProfileScope: 'active',
    },
    profiles: [],
    loadMeasurement: {
      serviceRecordsPerMinuteP10: null,
      serviceBytesPerMinuteP10: null,
      arrivalRecordsPerMinuteP99: null,
      arrivalBytesPerMinuteP99: null,
      backlogSlope: null,
    },
  };
}

function withDigest(fixture: CharacterizationFixtureV1): CharacterizationFixtureV1 {
  const profilePopulation = deriveProfilePopulationV1(
    fixture.profiles.map((profile) => ({
      root: profile.rootSubject,
      peerKeys: profile.peerKeys,
      freshness: 'active',
    })),
    fixture.profiles,
  );
  return signFixture({
    ...fixture,
    profilePopulation,
  });
}

function signFixture(fixture: CharacterizationFixtureV1): CharacterizationFixtureV1 {
  const profileEvidenceSha256 = sha256Canonical(fixture.profiles);
  const draft = {
    ...fixture,
    provenance: { ...fixture.provenance, profileEvidenceSha256, manifestSha256: '' },
  };
  return {
    ...draft,
    provenance: {
      ...draft.provenance,
      manifestSha256: sha256Canonical(manifestDigestInput(draft)),
    },
  };
}
