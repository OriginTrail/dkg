import assert from 'node:assert/strict';
import test from 'node:test';

import { stableJson } from '../rfc64-persistence-lifecycle/evidence.js';
import {
  GATE1_ADAPTER_PROTOCOL_VERSION,
  GATE1_FIXTURE,
  GATE1_FIXTURE_ADAPTER_ID,
  GATE1_RAW_SCHEMA_VERSION,
  INSPECTED_PRODUCT_COMMITS,
  REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
  expectedAppliedReadBack,
  type Gate1TransferFixture,
} from './model.js';
import { verifyGate1ArtifactBytes } from './verifier.js';

const HEAD = 'a'.repeat(40);

test('accepts the complete canonical deterministic harness evidence', () => {
  const result = verifyGate1ArtifactBytes(bytes(goldenArtifact()), HEAD);
  assert.equal(result.sourceCommit, HEAD);
  assert.match(result.rawArtifactSha256, /^0x[0-9a-f]{64}$/u);
});

test('rejects non-canonical JSON before interpreting evidence', () => {
  const text = JSON.stringify(goldenArtifact());
  assert.throws(
    () => verifyGate1ArtifactBytes(Buffer.from(text), HEAD),
    /not exact canonical stable JSON/,
  );
});

test('rejects an extra top-level field', () => {
  const artifact = goldenArtifact() as Record<string, unknown>;
  artifact.untrusted = true;
  reject(artifact, /failed at \$: must contain exactly keys/);
});

test('pins the artifact to the independently observed repository commit', () => {
  const artifact = goldenArtifact();
  artifact.repository.testedHeadCommit = 'b'.repeat(40);
  reject(artifact, /repository\.testedHeadCommit/);
});

test('pins both inspected product commits at the adapter boundary', () => {
  const artifact = goldenArtifact();
  artifact.adapter.inspectedProductCommits[0] = 'c'.repeat(40);
  reject(artifact, /adapter\.inspectedProductCommits/);
});

test('pins the six production adapter operations without interim service internals', () => {
  const artifact = goldenArtifact();
  artifact.adapter.requiredProductionOperations[0] = 'interimServiceMethod';
  reject(artifact, /adapter\.requiredProductionOperations/);
});

test('does not allow the fixture adapter to claim a formal production gate', () => {
  const artifact = goldenArtifact();
  artifact.adapter.productBoundary = 'production';
  reject(artifact, /adapter\.productBoundary/);
  const evaluated = goldenArtifact();
  evaluated.gateEvaluation.status = 'PASS';
  reject(evaluated, /gateEvaluation\.status/);
});

test('requires exact distinct author and receiver peer identities', () => {
  const artifact = goldenArtifact();
  artifact.ready.receiver.peerId = artifact.ready.author.peerId;
  reject(artifact, /ready\.receiver\.peerId/);
});

const exactPositiveMutations: ReadonlyArray<readonly [string, (artifact: GoldenArtifact) => void]> = [
  ['catalog head digest', (artifact) => {
    artifact.phases.positiveSync.exact.head.catalogHeadDigest = digest('1');
  }],
  ['catalog row digest', (artifact) => {
    artifact.phases.positiveSync.exact.catalogRowDigest = digest('2');
  }],
  ['bundle digest', (artifact) => {
    artifact.phases.positiveSync.exact.bundleDigest = digest('3');
  }],
  ['content digest', (artifact) => {
    artifact.phases.positiveSync.exact.contentDigest = digest('4');
  }],
  ['UAL', (artifact) => { artifact.phases.positiveSync.exact.kaUal += '/wrong'; }],
  ['inventory row count', (artifact) => {
    artifact.phases.positiveSync.exact.inventoryRowCount = 2;
  }],
  ['activated quad count', (artifact) => {
    artifact.phases.positiveSync.exact.activatedQuadCount = 3;
  }],
];

for (const [label, mutate] of exactPositiveMutations) {
  test(`rejects changed exact positive ${label}`, () => {
    const artifact = goldenArtifact();
    mutate(artifact);
    reject(artifact, /phases\.positiveSync\.exact/);
  });
}

test('requires exact durable applied-head readback after positive activation', () => {
  const artifact = goldenArtifact();
  artifact.phases.positiveSync.appliedReadBack.currentCatalogHeadDigest = digest('5');
  reject(artifact, /phases\.positiveSync\.appliedReadBack/);
});

test('requires the exact semantic quad/count/digest post-read', () => {
  const artifact = goldenArtifact();
  artifact.phases.positiveSync.semanticPostRead.activatedQuadCount = 1;
  reject(artifact, /phases\.positiveSync\.semanticPostRead/);
});

test('requires forged-author failure to leave zero activation and no applied head', () => {
  const activated = goldenArtifact();
  activated.phases.forgedAuthor.activationAfter = 1;
  reject(activated, /forgedAuthor\.activationAfter/);

  const applied = goldenArtifact();
  applied.phases.forgedAuthor.appliedHeadAfter = expectedAppliedReadBack(GATE1_FIXTURE.positive);
  reject(applied, /forgedAuthor\.appliedHeadAfter/);
});

test('requires the forged author to fail at cryptographic transfer admission', () => {
  const artifact = goldenArtifact();
  artifact.phases.forgedAuthor.failureCode = 'catalog-native-receiver-activation';
  reject(artifact, /forgedAuthor\.failureCode/);
});

test('requires an unclean receiver crash after a durable repair intent', () => {
  const cleanExit = goldenArtifact();
  cleanExit.phases.restartRepair.crashExit = { code: 0, signal: null };
  reject(cleanExit, /restartRepair\.crashExit\.code/);

  const noIntent = goldenArtifact();
  noIntent.phases.restartRepair.gap.repairIntentDurable = false;
  reject(noIntent, /restartRepair\.gap\.repairIntentDurable/);
});

test('requires restart to advance the durable predecessor to the exact successor', () => {
  const artifact = goldenArtifact();
  artifact.phases.restartRepair.restartedReady.startupRepair.after.currentCatalogHeadDigest =
    GATE1_FIXTURE.positive.head.catalogHeadDigest;
  reject(artifact, /restartRepair\.restartedReady\.startupRepair/);
});

test('requires exact semantic and applied readback after restart repair', () => {
  const applied = goldenArtifact();
  applied.phases.restartRepair.readBack.appliedReadBack.appliedInventoryDigest = digest('6');
  reject(applied, /restartRepair\.readBack\.appliedReadBack/);

  const semantic = goldenArtifact();
  semantic.phases.restartRepair.readBack.semanticPostRead.contentDigest = digest('7');
  reject(semantic, /restartRepair\.readBack\.semanticPostRead/);
});

function buildGoldenArtifact() {
  const positiveApplied = mutable(expectedAppliedReadBack(GATE1_FIXTURE.positive));
  const repairApplied = mutable(expectedAppliedReadBack(GATE1_FIXTURE.repairSuccessor));
  const positiveSemantic = semantic(GATE1_FIXTURE.positive);
  const repairSemantic = semantic(GATE1_FIXTURE.repairSuccessor);
  const startupRepair = {
    action: 'advanced-applied-head-from-durable-intent',
    after: mutable(repairApplied),
    before: mutable(positiveApplied),
    repaired: true,
    semanticPostRead: mutable(repairSemantic),
  };
  return {
    adapter: {
      id: GATE1_FIXTURE_ADAPTER_ID,
      inspectedProductCommits: [...INSPECTED_PRODUCT_COMMITS],
      productBoundary: 'not-connected',
      protocolVersion: GATE1_ADAPTER_PROTOCOL_VERSION,
      requiredProductionOperations: [...REQUIRED_PRODUCTION_ADAPTER_OPERATIONS],
      replacementContract:
        'replace adapter-process commands with production DKGAgent operations without changing evidence schema',
    },
    fixture: {
      forged: mutable(GATE1_FIXTURE.forged),
      positive: mutable(GATE1_FIXTURE.positive),
      repairSuccessor: mutable(GATE1_FIXTURE.repairSuccessor),
    },
    gate: 'OT-RFC-64 Gate 1 harness contract',
    gateEvaluation: {
      reason:
        'deterministic adapter proves orchestration and fail-closed evidence verification, not production Gate 1',
      status: 'not-evaluated',
    },
    harnessChecksPassed: true,
    invocation: 'pnpm test:gate1:rfc64-public-open-harness',
    phases: {
      forgedAuthor: {
        activationAfter: 0,
        activationBefore: 0,
        appliedHeadAfter: null as unknown,
        appliedHeadBefore: null as unknown,
        attemptedCatalogHeadDigest: GATE1_FIXTURE.forged.attemptedCatalogHeadDigest,
        failureCode: GATE1_FIXTURE.forged.expectedFailureCode,
        recoveredAuthorAddress: GATE1_FIXTURE.forged.recoveredAuthorAddress,
        servedByPeerId: GATE1_FIXTURE.authorPeerId,
        testedByPeerId: GATE1_FIXTURE.receiverPeerId,
      },
      positiveSync: {
        appliedReadBack: mutable(positiveApplied),
        controlObjectsVerified: 3,
        exact: mutable(GATE1_FIXTURE.positive),
        receivedByPeerId: GATE1_FIXTURE.receiverPeerId,
        semanticPostRead: mutable(positiveSemantic),
        servedByPeerId: GATE1_FIXTURE.authorPeerId,
      },
      restartRepair: {
        crashExit: { code: null as number | null, signal: 'SIGKILL' as string | null },
        gap: {
          appliedBeforeCrash: mutable(positiveApplied),
          repairIntentDurable: true,
          semanticBeforeCrash: mutable(repairSemantic),
          target: mutable(repairApplied),
        },
        readBack: {
          appliedReadBack: mutable(repairApplied),
          semanticPostRead: mutable(repairSemantic),
        },
        restartedReady: {
          adapterId: GATE1_FIXTURE_ADAPTER_ID,
          peerId: GATE1_FIXTURE.receiverPeerId,
          protocolVersion: GATE1_ADAPTER_PROTOCOL_VERSION,
          role: 'receiver',
          startupRepair,
        },
        successorServedByPeerId: GATE1_FIXTURE.authorPeerId,
      },
    },
    processBoundary: {
      authorInstances: 1,
      model: 'two concurrent adapter peer processes plus one receiver restart',
      receiverInstances: 2,
      stoppedExits: {
        author: { code: 0, signal: null },
        restartedReceiver: { code: 0, signal: null },
      },
    },
    ready: {
      author: {
        adapterId: GATE1_FIXTURE_ADAPTER_ID,
        peerId: GATE1_FIXTURE.authorPeerId,
        protocolVersion: GATE1_ADAPTER_PROTOCOL_VERSION,
        role: 'author',
        startupRepair: null as unknown,
      },
      receiver: {
        adapterId: GATE1_FIXTURE_ADAPTER_ID,
        peerId: GATE1_FIXTURE.receiverPeerId,
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

function semantic(fixture: Gate1TransferFixture) {
  return {
    activatedQuadCount: fixture.activatedQuadCount,
    catalogHeadDigest: fixture.head.catalogHeadDigest,
    catalogRowDigest: fixture.catalogRowDigest,
    contentDigest: fixture.contentDigest,
    kaUal: fixture.kaUal,
    swmGraph: fixture.swmGraph,
  };
}

function mutable<T>(value: T): T {
  return structuredClone(value);
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
