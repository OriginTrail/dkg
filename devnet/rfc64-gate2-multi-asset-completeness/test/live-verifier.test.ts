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
import { sha256Digest } from '../src/canonical.ts';
import { generateCompleteFixture } from '../src/generate.ts';
import { computeAppliedInventoryDigest } from '../src/product-digests.ts';

const SOURCE_COMMIT = 'a'.repeat(40);
const AUTHOR_PEER = '12D3KooWGate2Author';
const RECEIVER_PEER = '12D3KooWGate2Receiver';
const PROJECTIONS = [
  '<https://example.org/fixture-1> <https://schema.org/name> "One" .\n',
  '<https://example.org/fixture-2> <https://schema.org/name> "Two" .\n',
  '<https://example.org/fixture-3> <https://schema.org/name> "Three" .\n',
];

function sample(): any {
  const fixture: any = JSON.parse(JSON.stringify(generateCompleteFixture(3)));
  fixture.authored.signedRows.forEach((row: any, index: number) => {
    row.contentDigest = sha256Digest(PROJECTIONS[index]!);
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
  return Buffer.from(stableJson(JSON.parse(JSON.stringify(value)) as unknown), 'utf8');
}

test('connected artifact verifies and raw/verdict schemas are two-run byte-identical', () => {
  const firstRaw = bytes(sample());
  const secondRaw = bytes(sample());
  assert.deepEqual(firstRaw, secondRaw);
  const firstVerified = verifyGate2ArtifactBytes(firstRaw, SOURCE_COMMIT);
  const secondVerified = verifyGate2ArtifactBytes(secondRaw, SOURCE_COMMIT);
  assert.deepEqual(firstVerified, secondVerified);
  assert.equal(
    stableJson(buildGate2PassVerdict(firstVerified)),
    stableJson(buildGate2PassVerdict(secondVerified)),
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
      () => verifyGate2ArtifactBytes(bytes(raw), SOURCE_COMMIT),
      /Gate 2 evidence verification failed at \$\.inventory/u,
    );
  });
}

test('a fixture boundary cannot masquerade as a connected Gate 2 pass', () => {
  const raw = sample();
  raw.adapter.productBoundary = 'not-connected';
  assert.throws(
    () => verifyGate2ArtifactBytes(bytes(raw), SOURCE_COMMIT),
    /\$\.adapter\.productBoundary/u,
  );
});
