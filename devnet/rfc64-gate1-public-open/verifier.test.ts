import assert from 'node:assert/strict';
import test from 'node:test';

import { stableJson } from '../rfc64-persistence-lifecycle/evidence.js';
import {
  GATE1_ADAPTER_PROTOCOL_VERSION,
  GATE1_RAW_SCHEMA_VERSION,
  GATE1_REAL_DKG_AGENT_ADAPTER_ID,
  REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
  appliedReadBackFromTransfer,
  semanticReadBackFromTransfer,
  type Gate1TransferEvidence,
} from './model.js';
import { verifyGate1ArtifactBytes } from './verifier.js';

const HEAD = 'a'.repeat(40);
const AUTHOR = `0x${'11'.repeat(20)}`;
const ATTACKER = `0x${'aa'.repeat(20)}`;
const POSITIVE = transfer({ head: '6', previous: '7', version: '1' });
const REPAIR = transfer({ head: '8', previous: '6', version: '2' });

test('accepts canonical production-shaped evidence with exact runtime continuity', () => {
  const result = verifyGate1ArtifactBytes(bytes(goldenArtifact()), HEAD);
  assert.equal(result.sourceCommit, HEAD);
  assert.match(result.rawArtifactSha256, /^0x[0-9a-f]{64}$/u);
});

test('rejects non-canonical JSON before interpreting evidence', () => {
  assert.throws(
    () => verifyGate1ArtifactBytes(Buffer.from(JSON.stringify(goldenArtifact())), HEAD),
    /not exact canonical stable JSON/,
  );
});

test('rejects fixture-era not-connected and not-evaluated false passes', () => {
  const disconnected = goldenArtifact();
  disconnected.adapter.productBoundary = 'not-connected';
  reject(disconnected, /adapter\.productBoundary/);

  const unevaluated = goldenArtifact();
  unevaluated.gateEvaluation.status = 'not-evaluated';
  reject(unevaluated, /gateEvaluation\.status/);
});

test('rejects an extra top-level field', () => {
  const artifact = goldenArtifact() as Record<string, unknown>;
  artifact.untrusted = true;
  reject(artifact, /failed at \$: must contain exactly keys/);
});

test('pins the artifact and inspected product commit to the repository HEAD', () => {
  const repository = goldenArtifact();
  repository.repository.testedHeadCommit = 'b'.repeat(40);
  reject(repository, /repository\.testedHeadCommit/);

  const inspected = goldenArtifact();
  inspected.adapter.inspectedProductCommits[0] = 'c'.repeat(40);
  reject(inspected, /adapter\.inspectedProductCommits/);
});

test('pins the six production adapter operations', () => {
  const artifact = goldenArtifact();
  artifact.adapter.requiredProductionOperations[0] = 'interimServiceMethod';
  reject(artifact, /adapter\.requiredProductionOperations/);
});

test('requires exact distinct real DKGAgent peer identities', () => {
  const artifact = goldenArtifact();
  artifact.ready.receiver.peerId = artifact.ready.author.peerId;
  reject(artifact, /author and receiver peer IDs must be distinct/);
});

test('rejects malformed product digests, UALs, addresses, and counts', () => {
  const digestMutation = goldenArtifact();
  digestMutation.fixture.positive.bundleDigest = 'fixture-bundle';
  reject(digestMutation, /fixture\.positive\.bundleDigest/);

  const ualMutation = goldenArtifact();
  ualMutation.fixture.positive.kaUal = 'did:dkg:wrong';
  reject(ualMutation, /fixture\.positive\.kaUal/);

  const addressMutation = goldenArtifact();
  addressMutation.fixture.positive.authorAddress = AUTHOR.toUpperCase();
  reject(addressMutation, /fixture\.positive\.authorAddress/);

  const countMutation = goldenArtifact();
  countMutation.fixture.positive.inventoryRowCount = 2;
  reject(countMutation, /fixture\.positive\.inventoryRowCount/);
});

test('requires replay to retain exact row, content, bundle, UAL, and counts', () => {
  const fields: ReadonlyArray<keyof Gate1TransferEvidence> = [
    'bundleDigest',
    'catalogRowDigest',
    'contentDigest',
    'kaUal',
    'activatedQuadCount',
  ];
  for (const [index, field] of fields.entries()) {
    const artifact = goldenArtifact();
    (artifact.fixture.repairSuccessor as unknown as Record<string, unknown>)[field] =
      typeof artifact.fixture.repairSuccessor[field] === 'number'
        ? 3
        : digest(String(index + 1));
    reject(artifact, new RegExp(`repairSuccessor\\.${field}`));
  }
});

test('requires the product inventory digest to remain equal for the exact replayed row', () => {
  const artifact = goldenArtifact();
  artifact.fixture.repairSuccessor.head.appliedInventoryDigest = digest('9');
  reject(artifact, /repairSuccessor\.head\.appliedInventoryDigest/);
});

test('requires the repair head to advance one version from the positive head', () => {
  const wrongPrevious = goldenArtifact();
  wrongPrevious.fixture.repairSuccessor.head.previousCatalogHeadDigest = digest('9');
  reject(wrongPrevious, /repairSuccessor\.head\.previousCatalogHeadDigest/);

  const skippedVersion = goldenArtifact();
  skippedVersion.fixture.repairSuccessor.head.catalogVersion = '3';
  reject(skippedVersion, /repairSuccessor\.head\.catalogVersion/);
});

test('requires the four receiver-verified control objects from product evidence', () => {
  const artifact = goldenArtifact();
  artifact.phases.positiveSync.controlObjectsVerified = 3;
  reject(artifact, /positiveSync\.controlObjectsVerified/);
});

test('requires exact durable and semantic readback after positive synchronization', () => {
  const applied = goldenArtifact();
  applied.phases.positiveSync.appliedReadBack.currentCatalogHeadDigest = digest('9');
  reject(applied, /positiveSync\.appliedReadBack/);

  const semantic = goldenArtifact();
  semantic.phases.positiveSync.semanticPostRead.activatedQuadCount = 1;
  reject(semantic, /positiveSync\.semanticPostRead/);
});

test('requires forged transfer rejection to leave the positive state exactly unchanged', () => {
  const activated = goldenArtifact();
  activated.phases.forgedAuthor.activationAfter = 3;
  reject(activated, /forgedAuthor\.activationAfter/);

  const applied = goldenArtifact();
  (applied.phases.forgedAuthor as unknown as Record<string, unknown>).appliedHeadAfter = null;
  reject(applied, /forgedAuthor\.appliedHeadAfter/);

  const wrongFailure = goldenArtifact();
  wrongFailure.fixture.forged.expectedFailureCode = 'catalog-native-receiver-transfer';
  reject(wrongFailure, /fixture\.forged\.expectedFailureCode/);
});

test('requires real SIGKILL followed by explicit replay, not fictional startup repair', () => {
  const cleanExit = goldenArtifact();
  cleanExit.phases.restartRepair.crashExit = { code: 0, signal: null };
  reject(cleanExit, /restartRepair\.crashExit\.code/);

  const inventedIntent = goldenArtifact();
  inventedIntent.phases.restartRepair.gap.repairIntentDurable = true;
  reject(inventedIntent, /restartRepair\.gap\.repairIntentDurable/);

  const inventedStartupRepair = goldenArtifact();
  inventedStartupRepair.phases.restartRepair.restartedReady.startupRepair = {
    repaired: true,
  };
  reject(inventedStartupRepair, /restartRepair\.restartedReady\.startupRepair/);
});

test('requires pre-crash continuity and exact post-reannounce replay readback', () => {
  const prematureSuccessor = goldenArtifact();
  prematureSuccessor.phases.restartRepair.gap.semanticBeforeCrash =
    semanticReadBackFromTransfer(REPAIR);
  reject(prematureSuccessor, /restartRepair\.gap\.semanticBeforeCrash/);

  const wrongApplied = goldenArtifact();
  wrongApplied.phases.restartRepair.readBack.appliedReadBack.currentCatalogHeadDigest =
    POSITIVE.head.catalogHeadDigest;
  reject(wrongApplied, /restartRepair\.readBack\.appliedReadBack/);

  const duplicate = goldenArtifact();
  duplicate.phases.restartRepair.readBack.semanticPostRead.activatedQuadCount = 4;
  reject(duplicate, /restartRepair\.readBack\.semanticPostRead/);
});

function buildGoldenArtifact() {
  const forged = {
    attemptedCatalogHeadDigest: digest('9'),
    catalogAuthorAddress: AUTHOR,
    expectedFailureCode: 'catalog-native-receiver-authorization',
    recoveredAuthorAddress: ATTACKER,
  };
  return {
    adapter: {
      id: GATE1_REAL_DKG_AGENT_ADAPTER_ID,
      inspectedProductCommits: [HEAD],
      productBoundary: 'connected',
      protocolVersion: GATE1_ADAPTER_PROTOCOL_VERSION,
      requiredProductionOperations: [...REQUIRED_PRODUCTION_ADAPTER_OPERATIONS],
      replacementContract:
        'real DKGAgent production APIs only; no fixture adapter or synthesized product evidence',
    },
    fixture: {
      forged: structuredClone(forged),
      positive: structuredClone(POSITIVE),
      repairSuccessor: structuredClone(REPAIR),
    },
    gate: 'OT-RFC-64 Gate 1 harness contract',
    gateEvaluation: {
      reason:
        'two real DKGAgent processes completed production publish, announce, synchronize, authorization-negative, SIGKILL, restart, reannounce, and exact readback',
      status: 'PASS',
    },
    harnessChecksPassed: true,
    invocation: 'pnpm test:gate1:rfc64-public-open-harness',
    phases: {
      forgedAuthor: {
        activationAfter: POSITIVE.activatedQuadCount,
        activationBefore: POSITIVE.activatedQuadCount,
        appliedHeadAfter: structuredClone(appliedReadBackFromTransfer(POSITIVE)),
        appliedHeadBefore: structuredClone(appliedReadBackFromTransfer(POSITIVE)),
        attemptedCatalogHeadDigest: forged.attemptedCatalogHeadDigest,
        failureCode: forged.expectedFailureCode,
        recoveredAuthorAddress: forged.recoveredAuthorAddress,
        servedByPeerId: 'peer-author-real',
        testedByPeerId: 'peer-receiver-real',
      },
      positiveSync: {
        appliedReadBack: structuredClone(appliedReadBackFromTransfer(POSITIVE)),
        controlObjectsVerified: 4,
        exact: structuredClone(POSITIVE),
        receivedByPeerId: 'peer-receiver-real',
        semanticPostRead: structuredClone(semanticReadBackFromTransfer(POSITIVE)),
        servedByPeerId: 'peer-author-real',
      },
      restartRepair: {
        crashExit: { code: null as number | null, signal: 'SIGKILL' as string | null },
        gap: {
          appliedBeforeCrash: structuredClone(appliedReadBackFromTransfer(POSITIVE)),
          repairIntentDurable: false,
          semanticBeforeCrash: structuredClone(semanticReadBackFromTransfer(POSITIVE)),
          target: structuredClone(appliedReadBackFromTransfer(REPAIR)),
        },
        readBack: {
          appliedReadBack: structuredClone(appliedReadBackFromTransfer(REPAIR)),
          semanticPostRead: structuredClone(semanticReadBackFromTransfer(REPAIR)),
        },
        restartedReady: {
          adapterId: GATE1_REAL_DKG_AGENT_ADAPTER_ID,
          peerId: 'peer-receiver-real',
          protocolVersion: GATE1_ADAPTER_PROTOCOL_VERSION,
          role: 'receiver',
          startupRepair: null as unknown,
        },
        successorServedByPeerId: 'peer-author-real',
      },
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
      author: {
        adapterId: GATE1_REAL_DKG_AGENT_ADAPTER_ID,
        peerId: 'peer-author-real',
        protocolVersion: GATE1_ADAPTER_PROTOCOL_VERSION,
        role: 'author',
        startupRepair: null as unknown,
      },
      receiver: {
        adapterId: GATE1_REAL_DKG_AGENT_ADAPTER_ID,
        peerId: 'peer-receiver-real',
        protocolVersion: GATE1_ADAPTER_PROTOCOL_VERSION,
        role: 'receiver',
        startupRepair: null as unknown,
      },
    },
    repository: {
      testedHeadCommit: HEAD,
      trackedSourceCleanAfterProcesses: true,
      trackedSourceCleanBeforeSpawn: true,
    },
    schemaVersion: GATE1_RAW_SCHEMA_VERSION,
  };
}

type DeepMutable<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer Item)[]
        ? DeepMutable<Item>[]
        : T extends object
          ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
          : T;

type GoldenArtifact = DeepMutable<ReturnType<typeof buildGoldenArtifact>>;

function goldenArtifact(): GoldenArtifact {
  return structuredClone(buildGoldenArtifact()) as GoldenArtifact;
}

function transfer(input: { head: string; previous: string; version: string }): Gate1TransferEvidence {
  return {
    activatedQuadCount: 2,
    authorAddress: AUTHOR,
    bundleByteLength: 300,
    bundleDigest: digest('2'),
    catalogRowDigest: digest('3'),
    contentByteLength: 168,
    contentDigest: digest('4'),
    head: {
      appliedInventoryDigest: digest('5'),
      catalogHeadDigest: digest(input.head),
      catalogVersion: input.version,
      previousCatalogHeadDigest: digest(input.previous),
    },
    inventoryRowCount: 1,
    kaUal: `did:dkg:otp:20430/${AUTHOR}/7`,
    swmGraph:
      `did:dkg:context-graph:0x${'bb'.repeat(20)}/gate-1/_shared_memory/${AUTHOR}/7`,
  };
}

function bytes(value: unknown): Buffer {
  return Buffer.from(stableJson(value), 'utf8');
}

function reject(value: unknown, pattern: RegExp): void {
  assert.throws(() => verifyGate1ArtifactBytes(bytes(value), HEAD), pattern);
}

function digest(nibble: string): string {
  return `0x${nibble.repeat(64)}`;
}
