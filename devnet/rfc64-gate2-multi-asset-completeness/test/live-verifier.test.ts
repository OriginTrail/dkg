import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stableJson } from '../../rfc64-persistence-lifecycle/evidence.ts';
import {
  GATE2_ADAPTER_PROTOCOL_VERSION,
  GATE2_RAW_SCHEMA_VERSION,
  GATE2_REAL_DKG_AGENT_ADAPTER_ID,
  REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
  appliedReadBackFromInventories,
} from '../model.ts';
import {
  buildGate2PassVerdict,
  verifyGate2ArtifactBytes,
} from '../live-verifier.ts';
import { canonicalDocument, sha256Digest, type CanonicalValue } from '../src/canonical.ts';
import { generateCompleteFixture } from '../src/generate.ts';
import { computeAppliedInventoryDigest } from '../src/product-digests.ts';
import {
  buildGate2ExecutedRuntimeManifestV1,
  buildGate2RuntimeManifestFromEntriesV1,
  buildGate2RuntimeProvenanceV1,
} from '../runtime-provenance.ts';

const SOURCE_COMMIT = 'a'.repeat(40);
const AUTHOR_PEER = '12D3KooWGate2Author';
const RECEIVER_PEER = '12D3KooWGate2Receiver';
const PROJECTIONS = [
  '<https://example.org/fixture-1> <https://schema.org/name> "One" .\n',
  '<https://example.org/fixture-2> <https://schema.org/name> "Two" .\n',
  '<https://example.org/fixture-3> <https://schema.org/name> "Three" .\n',
];
const KA_PROJECTION_DIGEST_DOMAIN_V1 = 'dkg-ka-projection-v1\n';
const RUNTIME_FILES = [
  { path: 'packages/agent/dist/index.js', byteLength: 1, sha256: `0x${'1'.repeat(64)}` },
  { path: 'packages/chain/dist/index.js', byteLength: 2, sha256: `0x${'2'.repeat(64)}` },
  { path: 'packages/core/dist/index.js', byteLength: 3, sha256: `0x${'3'.repeat(64)}` },
  { path: 'packages/storage/dist/index.js', byteLength: 4, sha256: `0x${'4'.repeat(64)}` },
] as const;
const RUNTIME_MANIFEST = buildGate2RuntimeManifestFromEntriesV1(SOURCE_COMMIT, RUNTIME_FILES);
const EXECUTED_RUNTIME = buildGate2ExecutedRuntimeManifestV1(SOURCE_COMMIT, RUNTIME_FILES);
const RUNTIME_PROVENANCE = buildGate2RuntimeProvenanceV1(RUNTIME_MANIFEST, [
  { id: 'author', loaded: EXECUTED_RUNTIME },
  { id: 'receiverBeforeCrash', loaded: EXECUTED_RUNTIME },
  { id: 'receiverAfterRestart', loaded: EXECUTED_RUNTIME },
]);

function sample(): any {
  const fixture: any = JSON.parse(JSON.stringify(generateCompleteFixture(3)));
  fixture.authored.signedRows.forEach((row: any, index: number) => {
    row.contentDigest = sha256Digest(
      KA_PROJECTION_DIGEST_DOMAIN_V1,
      PROJECTIONS[index]!,
    );
    fixture.received.activatedRows[index].contentDigest = row.contentDigest;
  });
  fixture.received.declaredInventoryDigest = computeAppliedInventoryDigest(
    fixture.authored.declaredCatalogScopeDigest,
    fixture.received.activatedRows,
  );
  const authored = fixture.authored;
  const received = fixture.received;
  const expectedApplied = appliedReadBackFromInventories(authored, received, '3');
  const wireRows = received.activatedRows.map((row: any) => ({
    ...row,
    swmGraph: `did:dkg:context-graph:${authored.catalogScope.contextGraphId}`
      + `/_shared_memory/${authored.catalogScope.authorAddress}/${row.kaUal.split('/').at(-1)}`,
  }));
  const wire = {
    activatedTripleCount: wireRows.reduce(
      (total: number, row: any) => total + row.activatedTripleCount,
      0,
    ),
    appliedHeadStatus: 'applied',
    catalogHeadDigest: authored.catalogHeadDigest,
    inventoryDigest: received.declaredInventoryDigest,
    inventoryRowCount: 3,
    rows: wireRows,
    verifiedControlObjectCount: 4,
  };
  const semantic = wireRows.map((row: any, index: number) => ({
    kaId: row.kaId,
    readBack: {
      activatedQuadCount: row.activatedTripleCount,
      projectionNQuads: PROJECTIONS[index],
      swmGraph: row.swmGraph,
    },
  }));
  const ready = (role: 'author' | 'receiver', peerId: string) => ({
    adapterId: GATE2_REAL_DKG_AGENT_ADAPTER_ID,
    peerId,
    protocolVersion: GATE2_ADAPTER_PROTOCOL_VERSION,
    role,
    runtimeBuildManifestDigest: RUNTIME_MANIFEST.manifestDigest,
    startupRepair: null,
  });
  const digest = (byte: string) => `0x${byte.repeat(64)}`;
  const policyDigest = digest('9');
  return {
    adapter: {
      id: GATE2_REAL_DKG_AGENT_ADAPTER_ID,
      inspectedProductCommits: [SOURCE_COMMIT],
      productBoundary: 'connected',
      protocolVersion: GATE2_ADAPTER_PROTOCOL_VERSION,
      requiredProductionOperations: REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
      replacementContract:
        'real DKGAgent production APIs only; no fixture adapter or synthesized product evidence',
      runtimeBuildManifestDigest: RUNTIME_MANIFEST.manifestDigest,
    },
    authorizationNegative: {
      attemptedCatalogHeadDigest: digest('8'),
      catalogAuthorAddress: authored.catalogScope.authorAddress,
      expectedFailureCode: 'catalog-native-receiver-authorization',
      forgedAppliedHead: null,
      forgedSynchronization: null,
      positiveAppliedAfter: expectedApplied,
      positiveAppliedBefore: expectedApplied,
      positiveInventoryAfter: wire,
      positiveInventoryBefore: wire,
      recoveredAuthorAddress: '0x2222222222222222222222222222222222222222',
      semanticAfter: semantic,
      semanticBefore: semantic,
      servedByPeerId: AUTHOR_PEER,
      testedByPeerId: RECEIVER_PEER,
    },
    gate: 'OT-RFC-64 Gate 2 multi-asset completeness',
    gateEvaluation: {
      reason:
        'two real DKGAgent processes completed production 1-to-2-to-3 exact-set publication, '
          + 'synchronization, authorization-negative, SIGKILL, same-head replay, and exact readback',
      status: 'PASS',
    },
    harnessChecksPassed: true,
    inventory: { authored, received },
    invocation: 'pnpm test:gate2:rfc64-multi-asset-harness',
    policy: {
      authorPolicyDigest: policyDigest,
      contextGraphId: authored.catalogScope.contextGraphId,
      networkId: authored.catalogScope.networkId,
      receiverPolicyDigest: policyDigest,
    },
    processBoundary: {
      authorInstances: 1,
      model: 'two real DKGAgent peer processes plus one receiver restart',
      receiverInstances: 2,
      stoppedExits: {
        author: { code: 0, signal: null },
        restartedReceiver: { code: 0, signal: null },
      },
    },
    ready: {
      author: ready('author', AUTHOR_PEER),
      receiver: ready('receiver', RECEIVER_PEER),
    },
    repository: {
      testedHeadCommit: SOURCE_COMMIT,
      trackedSourceCleanAfterProcesses: true,
      trackedSourceCleanBeforeSpawn: true,
    },
    restartReplay: {
      appliedReadBack: expectedApplied,
      crashExit: { code: null, signal: 'SIGKILL' },
      processLocalSynchronization: null,
      reannouncementAcknowledgedByPeerId: RECEIVER_PEER,
      receiverStats: { applied: 0, dedupedAlreadyApplied: 1 },
      restartedReady: ready('receiver', RECEIVER_PEER),
      semanticPostRead: semantic,
      successorServedByPeerId: AUTHOR_PEER,
    },
    runtimeProvenance: RUNTIME_PROVENANCE,
    schemaVersion: GATE2_RAW_SCHEMA_VERSION,
    transitions: [
      {
        catalogHeadDigest: digest('1'),
        catalogVersion: '1',
        inventoryRowCount: 1,
        previousCatalogHeadDigest: digest('0'),
        signatureVariantDigest: digest('4'),
      },
      {
        catalogHeadDigest: digest('2'),
        catalogVersion: '2',
        inventoryRowCount: 2,
        previousCatalogHeadDigest: digest('1'),
        signatureVariantDigest: digest('5'),
      },
      {
        catalogHeadDigest: authored.catalogHeadDigest,
        catalogVersion: '3',
        inventoryRowCount: 3,
        previousCatalogHeadDigest: digest('2'),
        signatureVariantDigest: digest('6'),
      },
    ],
    transport: {
      finalAnnouncementPolicyDigest: policyDigest,
      finalSignatureVariantDigest: digest('6'),
      receivedByPeerId: RECEIVER_PEER,
      servedByPeerId: AUTHOR_PEER,
      verifiedControlObjectCount: 4,
    },
  };
}

function bytes(value: unknown): Buffer {
  return Buffer.from(
    canonicalDocument(JSON.parse(JSON.stringify(value)) as CanonicalValue),
    'utf8',
  );
}

test('connected artifact verifies and raw/verdict schemas are two-run byte-identical', () => {
  const firstRaw = bytes(sample());
  const secondRaw = bytes(sample());
  assert.deepEqual(firstRaw, secondRaw);
  const firstVerified = verifyGate2ArtifactBytes(firstRaw, SOURCE_COMMIT, RUNTIME_MANIFEST);
  const secondVerified = verifyGate2ArtifactBytes(secondRaw, SOURCE_COMMIT, RUNTIME_MANIFEST);
  assert.deepEqual(firstVerified, secondVerified);
  assert.equal(
    canonicalDocument(buildGate2PassVerdict(firstVerified) as unknown as CanonicalValue),
    canonicalDocument(buildGate2PassVerdict(secondVerified) as unknown as CanonicalValue),
  );
  assert.match(firstVerified.rawArtifactSha256, /^0x[0-9a-f]{64}$/u);
});

for (const [label, mutate] of [
  ['missing', (raw: any) => { raw.inventory.received.activatedRows.pop(); }],
  ['extra', (raw: any) => {
    raw.inventory.received.activatedRows.push(
      JSON.parse(JSON.stringify(generateCompleteFixture(4))).received.activatedRows[3],
    );
  }],
  ['duplicate', (raw: any) => {
    raw.inventory.received.activatedRows.splice(
      1,
      0,
      { ...raw.inventory.received.activatedRows[0] },
    );
  }],
  ['mismatch', (raw: any) => {
    raw.inventory.received.activatedRows[1].bundleDigest = `0x${'f'.repeat(64)}`;
  }],
] as const) {
  test(`${label} inventory mutation is rejected by the connected verifier`, () => {
    const raw = sample();
    mutate(raw);
    assert.throws(
      () => verifyGate2ArtifactBytes(bytes(raw), SOURCE_COMMIT, RUNTIME_MANIFEST),
      /Gate 2 evidence verification failed at \$\.inventory/u,
    );
  });
}

test('a fixture boundary cannot masquerade as a connected Gate 2 pass', () => {
  const raw = sample();
  raw.adapter.productBoundary = 'not-connected';
  assert.throws(
    () => verifyGate2ArtifactBytes(bytes(raw), SOURCE_COMMIT, RUNTIME_MANIFEST),
    /\$\.adapter\.productBoundary/u,
  );
});

test('only exact RFC 8785 JSON with one trailing LF is accepted', () => {
  const raw = sample();
  const exactBytes = bytes(raw);
  assert.doesNotThrow(() => verifyGate2ArtifactBytes(
    exactBytes,
    SOURCE_COMMIT,
    RUNTIME_MANIFEST,
  ));
  const canonical = exactBytes.toString('utf8');
  for (const invalid of [
    Buffer.from(stableJson(JSON.parse(JSON.stringify(raw))), 'utf8'),
    Buffer.from(canonical.slice(0, -1), 'utf8'),
    Buffer.from(`${canonical}\n`, 'utf8'),
    Buffer.from(`${canonical.slice(0, -1)}\r\n`, 'utf8'),
  ]) {
    assert.throws(
      () => verifyGate2ArtifactBytes(invalid, SOURCE_COMMIT, RUNTIME_MANIFEST),
      /canonical document/u,
    );
  }
  const verdict = canonicalDocument(
    buildGate2PassVerdict(verifyGate2ArtifactBytes(
      exactBytes,
      SOURCE_COMMIT,
      RUNTIME_MANIFEST,
    )) as unknown as CanonicalValue,
  );
  assert.equal((verdict.match(/\n/gu) ?? []).length, 1);
});

test('conflated per-KA content digests are rejected even with a recomputed inventory digest', () => {
  const raw = sample();
  raw.inventory.authored.signedRows[1].contentDigest =
    raw.inventory.authored.signedRows[0].contentDigest;
  raw.inventory.received.activatedRows[1].contentDigest =
    raw.inventory.received.activatedRows[0].contentDigest;
  raw.inventory.received.declaredInventoryDigest = computeAppliedInventoryDigest(
    raw.inventory.authored.declaredCatalogScopeDigest,
    raw.inventory.received.activatedRows,
  );
  assert.throws(
    () => verifyGate2ArtifactBytes(bytes(raw), SOURCE_COMMIT, RUNTIME_MANIFEST),
    /content digests must be distinct per KA/u,
  );
});

test('copied semantic projections cannot masquerade as three complete assets', () => {
  const raw = sample();
  raw.authorizationNegative.semanticBefore[1].readBack.projectionNQuads = PROJECTIONS[0];
  raw.authorizationNegative.semanticAfter[1].readBack.projectionNQuads = PROJECTIONS[0];
  raw.restartReplay.semanticPostRead[1].readBack.projectionNQuads = PROJECTIONS[0];
  assert.throws(
    () => verifyGate2ArtifactBytes(bytes(raw), SOURCE_COMMIT, RUNTIME_MANIFEST),
    /projection/u,
  );
});
