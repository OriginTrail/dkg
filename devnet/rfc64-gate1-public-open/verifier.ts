import { createHash } from 'node:crypto';

import { stableJson } from '../rfc64-persistence-lifecycle/evidence.js';
import {
  GATE1_ADAPTER_PROTOCOL_VERSION,
  GATE1_RAW_SCHEMA_VERSION,
  GATE1_REAL_DKG_AGENT_ADAPTER_ID,
  REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
  appliedReadBackFromTransfer,
  semanticReadBackFromTransfer,
  type Gate1ForgedEvidence,
  type Gate1TransferEvidence,
} from './model.js';

const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/u;
const DIGEST_PATTERN = /^0x[0-9a-f]{64}$/u;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/u;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/u;
const UAL_PATTERN = /^did:dkg:[^/]+\/(0x[0-9a-f]{40})\/(0|[1-9][0-9]*)$/u;
const SWM_GRAPH_PATTERN =
  /^did:dkg:context-graph:.+\/_shared_memory\/(0x[0-9a-f]{40})\/(0|[1-9][0-9]*)$/u;
const PRODUCTION_REASON =
  'two real DKGAgent processes completed production publish, announce, synchronize, authorization-negative, SIGKILL, restart, reannounce, and exact readback';
const PRODUCTION_REPLACEMENT_CONTRACT =
  'real DKGAgent production APIs only; no fixture adapter or synthesized product evidence';

export interface Gate1VerifiedEvidence {
  readonly rawArtifactSha256: string;
  readonly sourceCommit: string;
}

export function verifyGate1ArtifactBytes(
  rawBytes: Uint8Array,
  expectedHead: string,
): Gate1VerifiedEvidence {
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
  exact(evaluation.status, 'PASS', '$.gateEvaluation.status');
  exact(evaluation.reason, PRODUCTION_REASON, '$.gateEvaluation.reason');

  const adapter = closedRecord(artifact.adapter, '$.adapter', [
    'id',
    'inspectedProductCommits',
    'productBoundary',
    'protocolVersion',
    'requiredProductionOperations',
    'replacementContract',
  ]);
  exact(adapter.id, GATE1_REAL_DKG_AGENT_ADAPTER_ID, '$.adapter.id');
  exact(adapter.protocolVersion, GATE1_ADAPTER_PROTOCOL_VERSION, '$.adapter.protocolVersion');
  exact(adapter.productBoundary, 'connected', '$.adapter.productBoundary');
  exactJson(
    adapter.requiredProductionOperations,
    REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
    '$.adapter.requiredProductionOperations',
  );
  exact(adapter.replacementContract, PRODUCTION_REPLACEMENT_CONTRACT, '$.adapter.replacementContract');
  exactJson(adapter.inspectedProductCommits, [expectedHead], '$.adapter.inspectedProductCommits');

  const repository = closedRecord(artifact.repository, '$.repository', [
    'testedHeadCommit',
    'trackedSourceCleanAfterProcesses',
    'trackedSourceCleanBeforeSpawn',
  ]);
  exact(repository.testedHeadCommit, expectedHead, '$.repository.testedHeadCommit');
  exact(repository.trackedSourceCleanBeforeSpawn, true, '$.repository.trackedSourceCleanBeforeSpawn');
  exact(repository.trackedSourceCleanAfterProcesses, true, '$.repository.trackedSourceCleanAfterProcesses');

  const fixture = verifyRuntimeEvidence(artifact.fixture);
  const peers = verifyReady(artifact.ready);
  verifyProcessBoundary(artifact.processBoundary);
  verifyPhases(artifact.phases, peers, fixture);
}

function verifyRuntimeEvidence(value: unknown): {
  forged: Gate1ForgedEvidence;
  positive: Gate1TransferEvidence;
  repair: Gate1TransferEvidence;
} {
  const evidence = closedRecord(value, '$.fixture', ['forged', 'positive', 'repairSuccessor']);
  const positive = verifyTransfer(evidence.positive, '$.fixture.positive');
  const repair = verifyTransfer(evidence.repairSuccessor, '$.fixture.repairSuccessor');
  const forgedRecord = closedRecord(evidence.forged, '$.fixture.forged', [
    'attemptedCatalogHeadDigest',
    'catalogAuthorAddress',
    'expectedFailureCode',
    'recoveredAuthorAddress',
  ]);
  const forged: Gate1ForgedEvidence = {
    attemptedCatalogHeadDigest: digest(forgedRecord.attemptedCatalogHeadDigest, '$.fixture.forged.attemptedCatalogHeadDigest'),
    catalogAuthorAddress: address(forgedRecord.catalogAuthorAddress, '$.fixture.forged.catalogAuthorAddress'),
    expectedFailureCode: boundedString(forgedRecord.expectedFailureCode, '$.fixture.forged.expectedFailureCode'),
    recoveredAuthorAddress: address(forgedRecord.recoveredAuthorAddress, '$.fixture.forged.recoveredAuthorAddress'),
  };
  exact(forged.catalogAuthorAddress, positive.authorAddress, '$.fixture.forged.catalogAuthorAddress');
  exact(
    forged.expectedFailureCode,
    'catalog-native-receiver-authorization',
    '$.fixture.forged.expectedFailureCode',
  );
  if (forged.recoveredAuthorAddress === forged.catalogAuthorAddress) {
    fail('$.fixture.forged.recoveredAuthorAddress', 'must differ from the catalog author');
  }

  // The restart/replay successor is the same exact one-row inventory. A new
  // head/version may advance, but no semantic row, bundle, UAL, count, or
  // applied inventory commitment may change or duplicate.
  const stableFields: ReadonlyArray<keyof Gate1TransferEvidence> = [
    'activatedQuadCount',
    'authorAddress',
    'bundleByteLength',
    'bundleDigest',
    'catalogRowDigest',
    'contentByteLength',
    'contentDigest',
    'inventoryRowCount',
    'kaUal',
    'swmGraph',
  ];
  for (const field of stableFields) {
    exactJson(repair[field], positive[field], `$.fixture.repairSuccessor.${field}`);
  }
  exact(
    repair.head.appliedInventoryDigest,
    positive.head.appliedInventoryDigest,
    '$.fixture.repairSuccessor.head.appliedInventoryDigest',
  );
  exact(
    repair.head.previousCatalogHeadDigest,
    positive.head.catalogHeadDigest,
    '$.fixture.repairSuccessor.head.previousCatalogHeadDigest',
  );
  if (repair.head.catalogHeadDigest === positive.head.catalogHeadDigest) {
    fail('$.fixture.repairSuccessor.head.catalogHeadDigest', 'must advance to a distinct head');
  }
  const positiveVersion = BigInt(positive.head.catalogVersion);
  const repairVersion = BigInt(repair.head.catalogVersion);
  if (repairVersion !== positiveVersion + 1n) {
    fail('$.fixture.repairSuccessor.head.catalogVersion', 'must advance exactly one version');
  }
  return { forged, positive, repair };
}

function verifyTransfer(value: unknown, path: string): Gate1TransferEvidence {
  const transfer = closedRecord(value, path, [
    'activatedQuadCount',
    'authorAddress',
    'bundleByteLength',
    'bundleDigest',
    'catalogRowDigest',
    'contentByteLength',
    'contentDigest',
    'head',
    'inventoryRowCount',
    'kaUal',
    'swmGraph',
  ]);
  const head = closedRecord(transfer.head, `${path}.head`, [
    'appliedInventoryDigest',
    'catalogHeadDigest',
    'catalogVersion',
    'previousCatalogHeadDigest',
  ]);
  const authorAddress = address(transfer.authorAddress, `${path}.authorAddress`);
  const kaUal = matchString(transfer.kaUal, UAL_PATTERN, `${path}.kaUal`);
  const ualMatch = UAL_PATTERN.exec(kaUal)!;
  if (ualMatch[1] !== authorAddress) fail(`${path}.kaUal`, 'must name the catalog author');
  const activatedQuadCount = positiveSafeInteger(transfer.activatedQuadCount, `${path}.activatedQuadCount`);
  const result: Gate1TransferEvidence = {
    activatedQuadCount,
    authorAddress,
    bundleByteLength: positiveSafeInteger(transfer.bundleByteLength, `${path}.bundleByteLength`),
    bundleDigest: digest(transfer.bundleDigest, `${path}.bundleDigest`),
    catalogRowDigest: digest(transfer.catalogRowDigest, `${path}.catalogRowDigest`),
    contentByteLength: positiveSafeInteger(transfer.contentByteLength, `${path}.contentByteLength`),
    contentDigest: digest(transfer.contentDigest, `${path}.contentDigest`),
    head: {
      appliedInventoryDigest: digest(head.appliedInventoryDigest, `${path}.head.appliedInventoryDigest`),
      catalogHeadDigest: digest(head.catalogHeadDigest, `${path}.head.catalogHeadDigest`),
      catalogVersion: matchString(head.catalogVersion, DECIMAL_PATTERN, `${path}.head.catalogVersion`),
      previousCatalogHeadDigest: digest(head.previousCatalogHeadDigest, `${path}.head.previousCatalogHeadDigest`),
    },
    inventoryRowCount: exactSafeInteger(transfer.inventoryRowCount, 1, `${path}.inventoryRowCount`),
    kaUal,
    swmGraph: boundedString(transfer.swmGraph, `${path}.swmGraph`),
  };
  const swmMatch = SWM_GRAPH_PATTERN.exec(result.swmGraph);
  if (swmMatch === null) fail(`${path}.swmGraph`, 'must use the production shared-memory graph form');
  if (swmMatch[1] !== authorAddress || swmMatch[2] !== ualMatch[2]) {
    fail(`${path}.swmGraph`, 'must name the same catalog author and KA number as the UAL');
  }
  return result;
}

function verifyReady(value: unknown): { author: string; receiver: string } {
  const ready = closedRecord(value, '$.ready', ['author', 'receiver']);
  const author = verifyReadyEvent(ready.author, '$.ready.author', 'author');
  const receiver = verifyReadyEvent(ready.receiver, '$.ready.receiver', 'receiver');
  if (author === receiver) fail('$.ready', 'author and receiver peer IDs must be distinct');
  return { author, receiver };
}

function verifyReadyEvent(value: unknown, path: string, role: 'author' | 'receiver'): string {
  const event = closedRecord(value, path, [
    'adapterId',
    'peerId',
    'protocolVersion',
    'role',
    'startupRepair',
  ]);
  exact(event.adapterId, GATE1_REAL_DKG_AGENT_ADAPTER_ID, `${path}.adapterId`);
  exact(event.protocolVersion, GATE1_ADAPTER_PROTOCOL_VERSION, `${path}.protocolVersion`);
  exact(event.role, role, `${path}.role`);
  exact(event.startupRepair, null, `${path}.startupRepair`);
  return boundedString(event.peerId, `${path}.peerId`);
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
    'two real DKGAgent peer processes plus one receiver restart',
    '$.processBoundary.model',
  );
  const exits = closedRecord(boundary.stoppedExits, '$.processBoundary.stoppedExits', [
    'author',
    'restartedReceiver',
  ]);
  verifyExit(exits.author, '$.processBoundary.stoppedExits.author', 0, null);
  verifyExit(exits.restartedReceiver, '$.processBoundary.stoppedExits.restartedReceiver', 0, null);
}

function verifyPhases(
  value: unknown,
  peers: { author: string; receiver: string },
  runtime: {
    forged: Gate1ForgedEvidence;
    positive: Gate1TransferEvidence;
    repair: Gate1TransferEvidence;
  },
): void {
  const phases = closedRecord(value, '$.phases', [
    'forgedAuthor',
    'positiveSync',
    'restartRepair',
  ]);
  verifyForgedAuthor(phases.forgedAuthor, peers, runtime.forged, runtime.positive);
  verifyPositiveSync(phases.positiveSync, peers, runtime.positive);
  verifyRestartRepair(phases.restartRepair, peers, runtime.positive, runtime.repair);
}

function verifyForgedAuthor(
  value: unknown,
  peers: { author: string; receiver: string },
  forged: Gate1ForgedEvidence,
  positive: Gate1TransferEvidence,
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
  exact(
    phase.activationBefore,
    positive.activatedQuadCount,
    '$.phases.forgedAuthor.activationBefore',
  );
  exact(
    phase.activationAfter,
    positive.activatedQuadCount,
    '$.phases.forgedAuthor.activationAfter',
  );
  exactJson(
    phase.appliedHeadBefore,
    appliedReadBackFromTransfer(positive),
    '$.phases.forgedAuthor.appliedHeadBefore',
  );
  exactJson(
    phase.appliedHeadAfter,
    appliedReadBackFromTransfer(positive),
    '$.phases.forgedAuthor.appliedHeadAfter',
  );
  exact(phase.attemptedCatalogHeadDigest, forged.attemptedCatalogHeadDigest, '$.phases.forgedAuthor.attemptedCatalogHeadDigest');
  exact(phase.failureCode, forged.expectedFailureCode, '$.phases.forgedAuthor.failureCode');
  exact(phase.recoveredAuthorAddress, forged.recoveredAuthorAddress, '$.phases.forgedAuthor.recoveredAuthorAddress');
}

function verifyPositiveSync(
  value: unknown,
  peers: { author: string; receiver: string },
  positive: Gate1TransferEvidence,
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
  exact(phase.controlObjectsVerified, 4, '$.phases.positiveSync.controlObjectsVerified');
  exactJson(phase.exact, positive, '$.phases.positiveSync.exact');
  exactJson(phase.appliedReadBack, appliedReadBackFromTransfer(positive), '$.phases.positiveSync.appliedReadBack');
  exactJson(phase.semanticPostRead, semanticReadBackFromTransfer(positive), '$.phases.positiveSync.semanticPostRead');
}

function verifyRestartRepair(
  value: unknown,
  peers: { author: string; receiver: string },
  positive: Gate1TransferEvidence,
  repair: Gate1TransferEvidence,
): void {
  const phase = closedRecord(value, '$.phases.restartRepair', [
    'crashExit',
    'gap',
    'readBack',
    'restartedReady',
    'successorServedByPeerId',
  ]);
  exact(phase.successorServedByPeerId, peers.author, '$.phases.restartRepair.successorServedByPeerId');
  verifyExit(phase.crashExit, '$.phases.restartRepair.crashExit', null, 'SIGKILL');
  const gap = closedRecord(phase.gap, '$.phases.restartRepair.gap', [
    'appliedBeforeCrash',
    'repairIntentDurable',
    'semanticBeforeCrash',
    'target',
  ]);
  exact(gap.repairIntentDurable, false, '$.phases.restartRepair.gap.repairIntentDurable');
  exactJson(gap.appliedBeforeCrash, appliedReadBackFromTransfer(positive), '$.phases.restartRepair.gap.appliedBeforeCrash');
  exactJson(gap.semanticBeforeCrash, semanticReadBackFromTransfer(positive), '$.phases.restartRepair.gap.semanticBeforeCrash');
  exactJson(gap.target, appliedReadBackFromTransfer(repair), '$.phases.restartRepair.gap.target');
  const restartedPeer = verifyReadyEvent(
    phase.restartedReady,
    '$.phases.restartRepair.restartedReady',
    'receiver',
  );
  exact(restartedPeer, peers.receiver, '$.phases.restartRepair.restartedReady.peerId');
  const readBack = closedRecord(phase.readBack, '$.phases.restartRepair.readBack', [
    'appliedReadBack',
    'semanticPostRead',
  ]);
  exactJson(readBack.appliedReadBack, appliedReadBackFromTransfer(repair), '$.phases.restartRepair.readBack.appliedReadBack');
  exactJson(readBack.semanticPostRead, semanticReadBackFromTransfer(repair), '$.phases.restartRepair.readBack.semanticPostRead');
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

function digest(value: unknown, path: string): string {
  return matchString(value, DIGEST_PATTERN, path);
}

function address(value: unknown, path: string): string {
  return matchString(value, ADDRESS_PATTERN, path);
}

function matchString(value: unknown, pattern: RegExp, path: string): string {
  const result = boundedString(value, path);
  if (!pattern.test(result)) fail(path, 'is malformed');
  return result;
}

function boundedString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    fail(path, 'must be a bounded non-empty string');
  }
  return value;
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(path, 'must be a positive safe integer');
  }
  return value as number;
}

function exactSafeInteger(value: unknown, expected: number, path: string): number {
  if (!Number.isSafeInteger(value) || value !== expected) fail(path, `must equal ${expected}`);
  return value as number;
}

function exact(actual: unknown, expected: unknown, path: string): void {
  if (!Object.is(actual, expected)) fail(path, `must equal ${JSON.stringify(expected)}`);
}

function exactJson(actual: unknown, expected: unknown, path: string): void {
  if (stableJson(actual) !== stableJson(expected)) fail(path, 'does not equal exact runtime evidence');
}

function requireMatch(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new Error(`${label} is malformed`);
}

function fail(path: string, message: string): never {
  throw new Error(`Gate 1 evidence verification failed at ${path}: ${message}`);
}
