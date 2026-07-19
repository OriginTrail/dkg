import { createHash } from 'node:crypto';

import { stableJson } from '../rfc64-persistence-lifecycle/evidence.js';
import {
  GATE1_ADAPTER_PROTOCOL_VERSION,
  GATE1_FIXTURE,
  GATE1_FIXTURE_ADAPTER_ID,
  GATE1_RAW_SCHEMA_VERSION,
  INSPECTED_PRODUCT_COMMITS,
  REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
  assertFixtureDerivations,
  expectedAppliedReadBack,
  type Gate1TransferFixture,
} from './model.js';

const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/u;

export interface Gate1VerifiedEvidence {
  readonly rawArtifactSha256: string;
  readonly sourceCommit: string;
}
export function verifyGate1ArtifactBytes(
  rawBytes: Uint8Array,
  expectedHead: string,
): Gate1VerifiedEvidence {
  assertFixtureDerivations();
  requireMatch(expectedHead, COMMIT_PATTERN, 'expected repository HEAD');
  if (rawBytes.byteLength === 0 || rawBytes.byteLength > 1_000_000) {
    fail('$', 'raw artifact size is outside the closed verifier bound');
  }
  let rawText: string;
  try {
    rawText = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  } catch (cause) {
    throw new Error('Gate 1 artifact is not valid UTF-8', { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch (cause) {
    throw new Error('Gate 1 artifact is not valid JSON', { cause });
  }
  let canonical: string;
  try {
    canonical = stableJson(parsed);
  } catch (cause) {
    throw new Error('Gate 1 artifact contains a lossy or non-plain JSON shape', { cause });
  }
  if (canonical !== rawText) fail('$', 'raw artifact is not exact canonical stable JSON');
  verifyClosedArtifact(parsed, expectedHead);
  return Object.freeze({
    rawArtifactSha256: `0x${createHash('sha256').update(rawBytes).digest('hex')}`,
    sourceCommit: expectedHead,
  });
}

function verifyClosedArtifact(value: unknown, expectedHead: string): void {
  const artifact = closedRecord(value, '$', [
    'adapter',
    'fixture',
    'gate',
    'gateEvaluation',
    'harnessChecksPassed',
    'invocation',
    'phases',
    'processBoundary',
    'ready',
    'repository',
    'schemaVersion',
  ]);
  exact(artifact.schemaVersion, GATE1_RAW_SCHEMA_VERSION, '$.schemaVersion');
  exact(artifact.gate, 'OT-RFC-64 Gate 1 harness contract', '$.gate');
  exact(
    artifact.invocation,
    'pnpm test:gate1:rfc64-public-open-harness',
    '$.invocation',
  );
  exact(artifact.harnessChecksPassed, true, '$.harnessChecksPassed');

  const evaluation = closedRecord(artifact.gateEvaluation, '$.gateEvaluation', [
    'reason',
    'status',
  ]);
  exact(evaluation.status, 'not-evaluated', '$.gateEvaluation.status');
  exact(
    evaluation.reason,
    'deterministic adapter proves orchestration and fail-closed evidence verification, not production Gate 1',
    '$.gateEvaluation.reason',
  );

  const adapter = closedRecord(artifact.adapter, '$.adapter', [
    'id',
    'inspectedProductCommits',
    'productBoundary',
    'protocolVersion',
    'requiredProductionOperations',
    'replacementContract',
  ]);
  exact(adapter.id, GATE1_FIXTURE_ADAPTER_ID, '$.adapter.id');
  exact(adapter.protocolVersion, GATE1_ADAPTER_PROTOCOL_VERSION, '$.adapter.protocolVersion');
  exact(adapter.productBoundary, 'not-connected', '$.adapter.productBoundary');
  exactJson(
    adapter.requiredProductionOperations,
    REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
    '$.adapter.requiredProductionOperations',
  );
  exact(
    adapter.replacementContract,
    'replace adapter-process commands with production DKGAgent operations without changing evidence schema',
    '$.adapter.replacementContract',
  );
  exactJson(
    adapter.inspectedProductCommits,
    INSPECTED_PRODUCT_COMMITS,
    '$.adapter.inspectedProductCommits',
  );

  const repository = closedRecord(artifact.repository, '$.repository', [
    'testedHeadCommit',
    'trackedSourceCleanAfterProcesses',
    'trackedSourceCleanBeforeSpawn',
  ]);
  exact(repository.testedHeadCommit, expectedHead, '$.repository.testedHeadCommit');
  exact(
    repository.trackedSourceCleanBeforeSpawn,
    true,
    '$.repository.trackedSourceCleanBeforeSpawn',
  );
  exact(
    repository.trackedSourceCleanAfterProcesses,
    true,
    '$.repository.trackedSourceCleanAfterProcesses',
  );

  verifyFixture(artifact.fixture);
  const peers = verifyReady(artifact.ready);
  verifyProcessBoundary(artifact.processBoundary);
  verifyPhases(artifact.phases, peers);
}

function verifyFixture(value: unknown): void {
  const fixture = closedRecord(value, '$.fixture', ['forged', 'positive', 'repairSuccessor']);
  exactJson(fixture.forged, GATE1_FIXTURE.forged, '$.fixture.forged');
  exactJson(fixture.positive, GATE1_FIXTURE.positive, '$.fixture.positive');
  exactJson(
    fixture.repairSuccessor,
    GATE1_FIXTURE.repairSuccessor,
    '$.fixture.repairSuccessor',
  );
}

function verifyReady(value: unknown): { author: string; receiver: string } {
  const ready = closedRecord(value, '$.ready', ['author', 'receiver']);
  const author = verifyReadyEvent(ready.author, '$.ready.author', 'author', null);
  const receiver = verifyReadyEvent(ready.receiver, '$.ready.receiver', 'receiver', null);
  exact(author, GATE1_FIXTURE.authorPeerId, '$.ready.author.peerId');
  exact(receiver, GATE1_FIXTURE.receiverPeerId, '$.ready.receiver.peerId');
  if (author === receiver) fail('$.ready', 'author and receiver peer IDs must be distinct');
  return { author, receiver };
}

function verifyReadyEvent(
  value: unknown,
  path: string,
  role: 'author' | 'receiver',
  expectedRepair: unknown,
): string {
  const event = closedRecord(value, path, [
    'adapterId',
    'peerId',
    'protocolVersion',
    'role',
    'startupRepair',
  ]);
  exact(event.adapterId, GATE1_FIXTURE_ADAPTER_ID, `${path}.adapterId`);
  exact(event.protocolVersion, GATE1_ADAPTER_PROTOCOL_VERSION, `${path}.protocolVersion`);
  exact(event.role, role, `${path}.role`);
  exactJson(event.startupRepair, expectedRepair, `${path}.startupRepair`);
  return nonEmptyString(event.peerId, `${path}.peerId`);
}

function verifyProcessBoundary(value: unknown): void {
  const boundary = closedRecord(value, '$.processBoundary', [
    'authorInstances',
    'model',
    'receiverInstances',
    'stoppedExits',
  ]);
  exact(boundary.authorInstances, 1, '$.processBoundary.authorInstances');
  exact(boundary.receiverInstances, 2, '$.processBoundary.receiverInstances');
  exact(
    boundary.model,
    'two concurrent adapter peer processes plus one receiver restart',
    '$.processBoundary.model',
  );
  const exits = closedRecord(boundary.stoppedExits, '$.processBoundary.stoppedExits', [
    'author',
    'restartedReceiver',
  ]);
  verifyExit(exits.author, '$.processBoundary.stoppedExits.author', 0, null);
  verifyExit(
    exits.restartedReceiver,
    '$.processBoundary.stoppedExits.restartedReceiver',
    0,
    null,
  );
}

function verifyPhases(
  value: unknown,
  peers: { author: string; receiver: string },
): void {
  const phases = closedRecord(value, '$.phases', [
    'forgedAuthor',
    'positiveSync',
    'restartRepair',
  ]);
  verifyForgedAuthor(phases.forgedAuthor, peers);
  verifyPositiveSync(phases.positiveSync, peers);
  verifyRestartRepair(phases.restartRepair, peers);
}

function verifyForgedAuthor(
  value: unknown,
  peers: { author: string; receiver: string },
): void {
  const phase = closedRecord(value, '$.phases.forgedAuthor', [
    'activationAfter',
    'activationBefore',
    'appliedHeadAfter',
    'appliedHeadBefore',
    'attemptedCatalogHeadDigest',
    'failureCode',
    'recoveredAuthorAddress',
    'servedByPeerId',
    'testedByPeerId',
  ]);
  exact(phase.servedByPeerId, peers.author, '$.phases.forgedAuthor.servedByPeerId');
  exact(phase.testedByPeerId, peers.receiver, '$.phases.forgedAuthor.testedByPeerId');
  exact(phase.activationBefore, 0, '$.phases.forgedAuthor.activationBefore');
  exact(phase.activationAfter, 0, '$.phases.forgedAuthor.activationAfter');
  exact(phase.appliedHeadBefore, null, '$.phases.forgedAuthor.appliedHeadBefore');
  exact(phase.appliedHeadAfter, null, '$.phases.forgedAuthor.appliedHeadAfter');
  exact(
    phase.attemptedCatalogHeadDigest,
    GATE1_FIXTURE.forged.attemptedCatalogHeadDigest,
    '$.phases.forgedAuthor.attemptedCatalogHeadDigest',
  );
  exact(
    phase.failureCode,
    GATE1_FIXTURE.forged.expectedFailureCode,
    '$.phases.forgedAuthor.failureCode',
  );
  exact(
    phase.recoveredAuthorAddress,
    GATE1_FIXTURE.forged.recoveredAuthorAddress,
    '$.phases.forgedAuthor.recoveredAuthorAddress',
  );
}

function verifyPositiveSync(
  value: unknown,
  peers: { author: string; receiver: string },
): void {
  const phase = closedRecord(value, '$.phases.positiveSync', [
    'appliedReadBack',
    'controlObjectsVerified',
    'exact',
    'receivedByPeerId',
    'semanticPostRead',
    'servedByPeerId',
  ]);
  exact(phase.servedByPeerId, peers.author, '$.phases.positiveSync.servedByPeerId');
  exact(phase.receivedByPeerId, peers.receiver, '$.phases.positiveSync.receivedByPeerId');
  exact(phase.controlObjectsVerified, 3, '$.phases.positiveSync.controlObjectsVerified');
  exactJson(phase.exact, GATE1_FIXTURE.positive, '$.phases.positiveSync.exact');
  exactJson(
    phase.appliedReadBack,
    expectedAppliedReadBack(GATE1_FIXTURE.positive),
    '$.phases.positiveSync.appliedReadBack',
  );
  exactJson(
    phase.semanticPostRead,
    expectedSemantic(GATE1_FIXTURE.positive),
    '$.phases.positiveSync.semanticPostRead',
  );
}

function verifyRestartRepair(
  value: unknown,
  peers: { author: string; receiver: string },
): void {
  const phase = closedRecord(value, '$.phases.restartRepair', [
    'crashExit',
    'gap',
    'readBack',
    'restartedReady',
    'successorServedByPeerId',
  ]);
  exact(
    phase.successorServedByPeerId,
    peers.author,
    '$.phases.restartRepair.successorServedByPeerId',
  );
  verifyExit(phase.crashExit, '$.phases.restartRepair.crashExit', null, 'SIGKILL');
  const gap = closedRecord(phase.gap, '$.phases.restartRepair.gap', [
    'appliedBeforeCrash',
    'repairIntentDurable',
    'semanticBeforeCrash',
    'target',
  ]);
  exact(gap.repairIntentDurable, true, '$.phases.restartRepair.gap.repairIntentDurable');
  exactJson(
    gap.appliedBeforeCrash,
    expectedAppliedReadBack(GATE1_FIXTURE.positive),
    '$.phases.restartRepair.gap.appliedBeforeCrash',
  );
  exactJson(
    gap.target,
    expectedAppliedReadBack(GATE1_FIXTURE.repairSuccessor),
    '$.phases.restartRepair.gap.target',
  );
  exactJson(
    gap.semanticBeforeCrash,
    expectedSemantic(GATE1_FIXTURE.repairSuccessor),
    '$.phases.restartRepair.gap.semanticBeforeCrash',
  );

  const expectedRepair = {
    action: 'advanced-applied-head-from-durable-intent',
    after: expectedAppliedReadBack(GATE1_FIXTURE.repairSuccessor),
    before: expectedAppliedReadBack(GATE1_FIXTURE.positive),
    repaired: true,
    semanticPostRead: expectedSemantic(GATE1_FIXTURE.repairSuccessor),
  };
  const restartedPeer = verifyReadyEvent(
    phase.restartedReady,
    '$.phases.restartRepair.restartedReady',
    'receiver',
    expectedRepair,
  );
  exact(restartedPeer, peers.receiver, '$.phases.restartRepair.restartedReady.peerId');
  const readBack = closedRecord(phase.readBack, '$.phases.restartRepair.readBack', [
    'appliedReadBack',
    'semanticPostRead',
  ]);
  exactJson(
    readBack.appliedReadBack,
    expectedAppliedReadBack(GATE1_FIXTURE.repairSuccessor),
    '$.phases.restartRepair.readBack.appliedReadBack',
  );
  exactJson(
    readBack.semanticPostRead,
    expectedSemantic(GATE1_FIXTURE.repairSuccessor),
    '$.phases.restartRepair.readBack.semanticPostRead',
  );
}

function expectedSemantic(fixture: Gate1TransferFixture): Record<string, unknown> {
  return {
    activatedQuadCount: fixture.activatedQuadCount,
    catalogHeadDigest: fixture.head.catalogHeadDigest,
    catalogRowDigest: fixture.catalogRowDigest,
    contentDigest: fixture.contentDigest,
    kaUal: fixture.kaUal,
    swmGraph: fixture.swmGraph,
  };
}

function verifyExit(
  value: unknown,
  path: string,
  expectedCode: number | null,
  expectedSignal: string | null,
): void {
  const exit = closedRecord(value, path, ['code', 'signal']);
  exact(exit.code, expectedCode, `${path}.code`);
  exact(exit.signal, expectedSignal, `${path}.signal`);
}

function closedRecord(
  value: unknown,
  path: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'must be a plain object');
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (stableJson(keys) !== stableJson(expected)) {
    fail(path, `must contain exactly keys ${expected.join(', ')}`);
  }
  return value as Record<string, unknown>;
}

function exact(actual: unknown, expected: unknown, path: string): void {
  if (!Object.is(actual, expected)) fail(path, `must equal ${JSON.stringify(expected)}`);
}

function exactJson(actual: unknown, expected: unknown, path: string): void {
  if (stableJson(actual) !== stableJson(expected)) fail(path, 'does not equal pinned exact value');
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    fail(path, 'must be a bounded non-empty string');
  }
  return value;
}

function requireMatch(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new Error(`${label} is malformed`);
}

function fail(path: string, message: string): never {
  throw new Error(`Gate 1 evidence verification failed at ${path}: ${message}`);
}
