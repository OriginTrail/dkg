import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SYSTEM_RECORD_LIMITS_V1,
  assertEvidenceSourceUrlV1,
  characterizeFixtureV1,
  classifyOwnedSubjectV1,
  evaluateLoadEnvelopeV1,
  expectedProfileLinkPredicateV1,
  loadCaptureDigestV1,
  loadIntervalSampleDigestV1,
  manifestDigestInput,
  parseCharacterizationFixtureV1,
  referenceBTreeBoundsV1,
  referenceInventoryRowEncodedBytesV1,
  referenceRequestBudgetV1,
  sha256Canonical,
  type CharacterizationFixtureV1,
  type LoadCaptureExpectationV1,
  type PairedLoadIntervalV1,
  type RedactedProfileEvidenceV1,
} from './model.js';
import { deriveProfilePopulationV1 } from './population.js';
import { runCharacterizationCli } from './characterize.js';

const here = dirname(fileURLToPath(import.meta.url));
const LOAD_CAPTURE_ID = 'capture:testnet-cold-0001';
const LOAD_REQUESTER_SOURCE = 'peer:requester-0001';
const LOAD_PROVIDER_SOURCE = 'peer:provider-0001';
const LOAD_CAPTURE_EXPECTATION = loadCaptureExpectation(loadIntervals());

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
    records: 512,
    minimumLeaves: 1,
    maximumLeaves: 4,
    maximumHeight: 2,
  });
  assert.equal(referenceBTreeBoundsV1(255).maximumLeaves, 1);
  assert.equal(referenceBTreeBoundsV1(256).maximumLeaves, 2);
  assert.equal(referenceBTreeBoundsV1(512).maximumLeaves, 4);
  assert.equal(referenceBTreeBoundsV1(32_768).maximumHeight, 2);
  assert.equal(referenceBTreeBoundsV1(32_895).maximumHeight, 2);
  assert.equal(referenceBTreeBoundsV1(32_896).maximumHeight, 3);
  assert.equal(
    referenceInventoryRowEncodedBytesV1(SYSTEM_RECORD_LIMITS_V1.maxPeerIdBytes),
    340,
  );
  assert.equal(
    referenceInventoryRowEncodedBytesV1(SYSTEM_RECORD_LIMITS_V1.maxPeerIdBytes, true),
    372,
  );
  assert.deepEqual(referenceBTreeBoundsV1(SYSTEM_RECORD_LIMITS_V1.hardRecords), {
    records: 262_144,
    minimumLeaves: 512,
    maximumLeaves: 2_048,
    maximumHeight: 3,
  });
  assert.throws(() => referenceBTreeBoundsV1(262_145), /records must be an integer/);
  assert.deepEqual(referenceRequestBudgetV1(), {
    serviceRequestsPerMinute: 180,
    requesterRequestsPerMinute: 240,
    providerRequestsPerMinute: 256,
    requesterHeadroomPerMinute: 60,
    providerHeadroomPerMinute: 76,
    requesterActivationCeilingPerMinute: 228,
    providerActivationCeilingPerMinute: 244,
    providerByteHeadroomPerMinute: 8 * 1024 * 1024,
    feasible: true,
  });
});

test('accepts the heartbeat-aware activation load equation with deadline reserve', () => {
  const baselineIntervals = loadIntervals();
  const ownershipSample = baselineIntervals[0];
  const changedProvider = {
    ...ownershipSample,
    providerExactRequests: ownershipSample.providerExactRequests + 1,
  };
  const changedRequester = {
    ...ownershipSample,
    servicedRecords: ownershipSample.servicedRecords + 1,
  };
  assert.equal(
    loadIntervalSampleDigestV1(
      LOAD_CAPTURE_ID,
      LOAD_REQUESTER_SOURCE,
      'requester',
      ownershipSample,
    ),
    loadIntervalSampleDigestV1(
      LOAD_CAPTURE_ID,
      LOAD_REQUESTER_SOURCE,
      'requester',
      changedProvider,
    ),
  );
  assert.equal(
    loadIntervalSampleDigestV1(
      LOAD_CAPTURE_ID,
      LOAD_PROVIDER_SOURCE,
      'provider',
      ownershipSample,
    ),
    loadIntervalSampleDigestV1(
      LOAD_CAPTURE_ID,
      LOAD_PROVIDER_SOURCE,
      'provider',
      changedRequester,
    ),
  );
  const verdict = evaluateLoadEnvelopeV1({
    activeRecords: 512,
    activeBundleBytes: 128 * 1024 * 1024,
    activeVerificationClosureBytes: 256 * 1024 * 1024,
    inventoryLeaves: 4,
    ...loadMeasurement(baselineIntervals),
  }, LOAD_CAPTURE_EXPECTATION);
  assert.equal(verdict.eligible, true);
  assert.ok(verdict.recordDrainMinutes !== null && verdict.recordDrainMinutes < 18);
  assert.equal(verdict.closureDrainMinutes, 16);

  const reorderedKeys = baselineIntervals.map((interval) => ({
    backlogDeltaRecords: interval.backlogDeltaRecords,
    providerExactRequests: interval.providerExactRequests,
    requesterExactRequests: interval.requesterExactRequests,
    arrivedClosureBytes: interval.arrivedClosureBytes,
    arrivedRecords: interval.arrivedRecords,
    servicedClosureBytes: interval.servicedClosureBytes,
    servicedRecords: interval.servicedRecords,
    cacheState: interval.cacheState,
    providerSampleDigest: interval.providerSampleDigest,
    requesterSampleDigest: interval.requesterSampleDigest,
    endedAt: interval.endedAt,
    startedAt: interval.startedAt,
    ordinal: interval.ordinal,
  }));
  const reorderedMeasurement = {
    ...loadMeasurement(baselineIntervals),
    pairedIntervals: reorderedKeys,
  };
  assert.equal(evaluateLoadEnvelopeV1({
    activeRecords: 512,
    activeBundleBytes: 128 * 1024 * 1024,
    activeVerificationClosureBytes: 256 * 1024 * 1024,
    inventoryLeaves: 4,
    ...reorderedMeasurement,
  }, LOAD_CAPTURE_EXPECTATION).eligible, true);
});

test('rejects every activation resource cap at the first overflow value', () => {
  const baseline = {
    activeRecords: SYSTEM_RECORD_LIMITS_V1.activationRecords,
    activeBundleBytes: SYSTEM_RECORD_LIMITS_V1.activationBundleBytes,
    activeVerificationClosureBytes:
      SYSTEM_RECORD_LIMITS_V1.activationVerificationClosureBytes,
    inventoryLeaves: SYSTEM_RECORD_LIMITS_V1.activationLeaves,
    ...loadMeasurement(loadIntervals()),
  };
  const overflows = [
    [
      { activeRecords: SYSTEM_RECORD_LIMITS_V1.activationRecords + 1 },
      'active_record_cap',
    ],
    [
      { activeBundleBytes: SYSTEM_RECORD_LIMITS_V1.activationBundleBytes + 1 },
      'active_bundle_byte_cap',
    ],
    [
      {
        activeVerificationClosureBytes:
          SYSTEM_RECORD_LIMITS_V1.activationVerificationClosureBytes + 1,
      },
      'active_closure_byte_cap',
    ],
    [
      { inventoryLeaves: SYSTEM_RECORD_LIMITS_V1.activationLeaves + 1 },
      'inventory_leaf_cap',
    ],
  ] as const;

  for (const [overflow, expectedFailure] of overflows) {
    const verdict = evaluateLoadEnvelopeV1(
      { ...baseline, ...overflow },
      LOAD_CAPTURE_EXPECTATION,
    );
    assert.equal(verdict.eligible, false);
    assert.deepEqual(verdict.failures, [expectedFailure]);
  }
});

test('blocks activation when arrivals saturate service or measurements are absent', () => {
  const untrusted = evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...loadMeasurement(loadIntervals()),
  }, null);
  assert.deepEqual(untrusted.failures, ['load_capture_expectation_unavailable']);

  const saturatedIntervals = loadIntervals({
    arrivedRecords: 60,
    arrivedClosureBytes: 1,
    requesterExactRequests: 229,
    providerExactRequests: 245,
    backlogDeltaRecords: 0,
  });
  const saturated = evaluateLoadEnvelopeV1({
    activeRecords: 512,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 4,
    ...loadMeasurement(saturatedIntervals),
  }, loadCaptureExpectation(saturatedIntervals));
  assert.equal(saturated.eligible, false);
  assert.ok(saturated.failures.includes('record_arrival_ceiling'));
  assert.ok(saturated.failures.includes('record_drain_deadline'));
  assert.ok(saturated.failures.includes('nonnegative_backlog_slope'));
  assert.ok(saturated.failures.includes('requester_request_ceiling'));
  assert.ok(saturated.failures.includes('provider_request_ceiling'));

  const closureOverflow = evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes:
      SYSTEM_RECORD_LIMITS_V1.activationVerificationClosureBytes + 1,
    inventoryLeaves: 1,
    ...loadMeasurement(loadIntervals()),
  }, LOAD_CAPTURE_EXPECTATION);
  assert.ok(closureOverflow.failures.includes('active_closure_byte_cap'));

  const mixed = loadIntervals();
  mixed[14] = resignLoadInterval({ ...mixed[14], cacheState: 'warm' });
  const warm = evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...loadMeasurement(mixed),
  }, loadCaptureExpectation(mixed));
  assert.ok(warm.failures.includes('cold_measurement_required'));

  const shortIntervals = loadIntervals().slice(0, 29);
  const short = evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...loadMeasurement(shortIntervals),
  }, loadCaptureExpectation(shortIntervals));
  assert.ok(short.failures.includes('insufficient_paired_intervals'));

  const marginalFalsePositive = loadIntervals();
  marginalFalsePositive[14] = resignLoadInterval({
    ...marginalFalsePositive[14],
    servicedRecords: 100,
    requesterExactRequests: 228,
    providerExactRequests: 244,
  });
  const paired = evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...loadMeasurement(marginalFalsePositive),
  }, loadCaptureExpectation(marginalFalsePositive));
  assert.ok(paired.failures.includes('requester_service_counter_inconsistent'));
  assert.ok(paired.failures.includes('provider_service_counter_inconsistent'));

  const reordered = loadIntervals().reverse();
  const invalidIntervals = loadIntervals({ arrivedRecords: -1 });
  assert.throws(() => evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...loadMeasurement(reordered),
  }, LOAD_CAPTURE_EXPECTATION), /contiguous zero-based ordinals/);

  const duplicatedSample = loadIntervals();
  duplicatedSample[1] = {
    ...duplicatedSample[1],
    requesterSampleDigest: duplicatedSample[0].requesterSampleDigest,
  };
  assert.throws(() => evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...loadMeasurement(duplicatedSample),
  }, LOAD_CAPTURE_EXPECTATION), /requester sample digests must be unique/);

  const gap = loadIntervals();
  gap[1] = {
    ...gap[1],
    startedAt: '2026-08-04T20:02:00Z',
    endedAt: '2026-08-04T20:03:00Z',
  };
  assert.throws(() => evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...loadMeasurement(gap),
  }, LOAD_CAPTURE_EXPECTATION), /strictly contiguous and ordered/);

  const unboundCapture = loadMeasurement(loadIntervals());
  assert.throws(() => evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...unboundCapture,
    captureDigest: `sha256:${'0'.repeat(64)}`,
  }, LOAD_CAPTURE_EXPECTATION), /captureDigest does not bind/);

  assert.throws(() => evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...loadMeasurement(loadIntervals()),
  }, { ...LOAD_CAPTURE_EXPECTATION, captureId: 'capture:different' }),
  /capture identity does not match/);
  assert.throws(() => evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...loadMeasurement(loadIntervals()),
  }, { ...LOAD_CAPTURE_EXPECTATION, requesterSource: 'peer:different-requester' }),
  /capture identity does not match/);
  assert.throws(() => evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...loadMeasurement(loadIntervals()),
  }, { ...LOAD_CAPTURE_EXPECTATION, startedAt: '2026-08-04T19:59:00Z' }),
  /do not cover the trusted activation window/);

  for (const invalidStartedAt of [
    '2026-08-04T20:00:00.000Z',
    '2026-08-04T20:00:00+00:00',
  ]) {
    assert.throws(() => evaluateLoadEnvelopeV1({
      activeRecords: 1,
      activeBundleBytes: 1,
      activeVerificationClosureBytes: 1,
      inventoryLeaves: 1,
      ...loadMeasurement(loadIntervals()),
    }, { ...LOAD_CAPTURE_EXPECTATION, startedAt: invalidStartedAt }),
    /canonical V1 second-precision timestamp/);

    const timestampIntervals = loadIntervals();
    timestampIntervals[0] = resignLoadInterval({
      ...timestampIntervals[0],
      startedAt: invalidStartedAt,
    });
    assert.throws(() => evaluateLoadEnvelopeV1({
      activeRecords: 1,
      activeBundleBytes: 1,
      activeVerificationClosureBytes: 1,
      inventoryLeaves: 1,
      ...loadMeasurement(timestampIntervals),
    }, LOAD_CAPTURE_EXPECTATION), /canonical V1 second-precision timestamp/);
  }

  const fullIntervals = loadIntervals();
  const trimmed = fullIntervals.slice(1).map((interval, ordinal) => resignLoadInterval({
    ...interval,
    ordinal,
  }));
  assert.throws(() => evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...loadMeasurement(trimmed),
  }, LOAD_CAPTURE_EXPECTATION), /trusted endpoint sample manifests|trusted activation window/);

  const suffixTrimmed = fullIntervals.slice(0, -1);
  assert.throws(() => evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...loadMeasurement(suffixTrimmed),
  }, LOAD_CAPTURE_EXPECTATION), /trusted endpoint sample manifests|trusted activation window/);

  const endpointOriginal = loadIntervals().map((interval, index) => resignLoadInterval({
    ...interval,
    providerExactRequests: 180 + index,
  }));
  const endpointSwap = [...endpointOriginal];
  endpointSwap[0] = resignLoadInterval({
    ...endpointSwap[0],
    providerExactRequests: endpointOriginal[1].providerExactRequests,
  });
  endpointSwap[1] = resignLoadInterval({
    ...endpointSwap[1],
    providerExactRequests: endpointOriginal[0].providerExactRequests,
  });
  const swappedCapture = loadMeasurement(endpointSwap);
  assert.throws(() => evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...swappedCapture,
  }, loadCaptureExpectation(endpointOriginal)), /trusted endpoint manifest/);

  const absent = evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...loadMeasurement(null),
  }, null);
  assert.deepEqual(absent.failures, ['load_measurement_unavailable']);
  assert.throws(() => evaluateLoadEnvelopeV1({
    activeRecords: 1,
    activeBundleBytes: 1,
    activeVerificationClosureBytes: 1,
    inventoryLeaves: 1,
    ...loadMeasurement(invalidIntervals),
  }, loadCaptureExpectation(invalidIntervals)), /arrivedRecords must be an integer/);
});

test('the CLI requires and accepts exact external load-envelope evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-2052-load-envelope-'));
  const fixturePath = join(directory, 'fixture.json');
  const evidencePath = join(directory, 'evidence.json');
  const intervals = loadIntervals();
  const fixture = withDigest({
    ...baseFixture(),
    loadMeasurement: loadMeasurement(intervals),
  });
  const evidence = {
    schemaVersion: 1 as const,
    fixtureId: fixture.fixtureId,
    fixtureManifestSha256: fixture.provenance.manifestSha256,
    activeVerificationClosureBytes: 0,
    capture: loadCaptureExpectation(intervals),
  };
  try {
    await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`, 'utf8');
    await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8');
    assert.equal(await runCharacterizationCli([
      '--fixture', fixturePath,
      '--load-envelope-evidence', evidencePath,
      '--require-load-envelope',
    ], () => undefined), 0);
    assert.equal(await runCharacterizationCli([
      '--fixture', fixturePath,
      '--require-load-envelope',
    ], () => undefined), 1);
    await writeFile(evidencePath, `${JSON.stringify({
      ...evidence,
      fixtureManifestSha256: `sha256:${'0'.repeat(64)}`,
    })}\n`, 'utf8');
    await assert.rejects(runCharacterizationCli([
      '--fixture', fixturePath,
      '--load-envelope-evidence', evidencePath,
      '--require-load-envelope',
    ], () => undefined), /does not bind the exact fixture/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  assert.throws(
    () => parseCharacterizationFixtureV1(withDigest({
      ...baseFixture(),
      profiles: [{
        ...base,
        quads: [{ ...base.quads[0], objectKind: 'iri' as const }],
      }],
    })),
    /peerId object must be a literal/,
  );
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
    quads: [...base.quads, {
      subject: base.rootSubject,
      predicate: 'http://www.w3.org/ns/prov#wasGeneratedBy',
      objectKind: 'iri' as const,
      objectBytes: 32,
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
  const fixture = parseCharacterizationFixtureV1(raw);
  const result = characterizeFixtureV1(fixture);
  assert.deepEqual(fixture.profilePopulation, {
    observedRoots: 1_819,
    observedPeerKeys: 1_807,
    activeRoots: 4,
    activeProfiles: 4,
    candidateProfiles: 3,
    ambiguousProfiles: 1,
    staleProfiles: 245,
    unknownFreshnessProfiles: 1_570,
    missingPeerRoots: 0,
    duplicatePeerKeys: 20,
    sharedRootSubjects: 10,
    detailedProfileScope: 'active',
  });
  assert.equal(result.profileStats.quads.p99, 2_252);
  assert.equal(result.profileStats.nquadsBytes.p99, 463_357);
  assert.equal(result.profileStats.subjects.p99, 3);
  assert.equal(result.invalidOwnedSubjects.length, 0);
  assert.equal(result.loadEnvelope.eligible, false);
  assert.ok(result.loadEnvelope.failures.includes('bundle_measurement_unavailable'));
  assert.ok(result.loadEnvelope.failures.includes('closure_measurement_unavailable'));
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
      intervalSeconds: 60,
      captureId: null,
      requesterSource: null,
      providerSource: null,
      pairedIntervals: null,
      captureDigest: null,
    },
  };
}

function loadIntervals(
  overrides: Partial<PairedLoadIntervalV1> = {},
): PairedLoadIntervalV1[] {
  const interval = {
    cacheState: 'cold' as const,
    servicedRecords: 60,
    servicedClosureBytes: 24 * 1024 * 1024,
    arrivedRecords: 16,
    arrivedClosureBytes: 8 * 1024 * 1024,
    requesterExactRequests: 180,
    providerExactRequests: 180,
    backlogDeltaRecords: -1,
    ...overrides,
  };
  const startedAt = Date.parse('2026-08-04T20:00:00Z');
  return Array.from(
    { length: SYSTEM_RECORD_LIMITS_V1.minimumLoadIntervals },
    (_, ordinal) => {
      const sample = {
        ...interval,
        ordinal,
        startedAt: new Date(startedAt + ordinal * 60_000).toISOString().replace('.000Z', 'Z'),
        endedAt: new Date(startedAt + (ordinal + 1) * 60_000).toISOString().replace('.000Z', 'Z'),
      };
      return {
        ...sample,
        requesterSampleDigest: loadIntervalSampleDigestV1(
          LOAD_CAPTURE_ID,
          LOAD_REQUESTER_SOURCE,
          'requester',
          sample,
        ),
        providerSampleDigest: loadIntervalSampleDigestV1(
          LOAD_CAPTURE_ID,
          LOAD_PROVIDER_SOURCE,
          'provider',
          sample,
        ),
      };
    },
  );
}

function loadMeasurement(
  pairedIntervals: readonly PairedLoadIntervalV1[] | null,
): CharacterizationFixtureV1['loadMeasurement'] {
  if (pairedIntervals === null) {
    return {
      intervalSeconds: 60,
      captureId: null,
      requesterSource: null,
      providerSource: null,
      pairedIntervals: null,
      captureDigest: null,
    };
  }
  const capture = {
    captureId: LOAD_CAPTURE_ID,
    requesterSource: LOAD_REQUESTER_SOURCE,
    providerSource: LOAD_PROVIDER_SOURCE,
    intervalSeconds: 60 as const,
    pairedIntervals,
  };
  return { ...capture, captureDigest: loadCaptureDigestV1(capture) };
}

function loadCaptureExpectation(
  pairedIntervals: readonly PairedLoadIntervalV1[],
): LoadCaptureExpectationV1 {
  if (pairedIntervals.length === 0) throw new TypeError('test capture must be non-empty');
  return {
    captureId: LOAD_CAPTURE_ID,
    requesterSource: LOAD_REQUESTER_SOURCE,
    providerSource: LOAD_PROVIDER_SOURCE,
    startedAt: pairedIntervals[0].startedAt,
    endedAt: pairedIntervals[pairedIntervals.length - 1].endedAt,
    requesterSampleDigests: pairedIntervals.map((interval) => interval.requesterSampleDigest),
    providerSampleDigests: pairedIntervals.map((interval) => interval.providerSampleDigest),
  };
}

function resignLoadInterval(interval: PairedLoadIntervalV1): PairedLoadIntervalV1 {
  const {
    requesterSampleDigest: _requesterSampleDigest,
    providerSampleDigest: _providerSampleDigest,
    ...sample
  } = interval;
  return {
    ...sample,
    requesterSampleDigest: loadIntervalSampleDigestV1(
      LOAD_CAPTURE_ID,
      LOAD_REQUESTER_SOURCE,
      'requester',
      sample,
    ),
    providerSampleDigest: loadIntervalSampleDigestV1(
      LOAD_CAPTURE_ID,
      LOAD_PROVIDER_SOURCE,
      'provider',
      sample,
    ),
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
