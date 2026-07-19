import { createHash } from 'node:crypto';

import { stableJson } from '../rfc64-persistence-lifecycle/evidence.js';
import {
  GATE2_ADAPTER_PROTOCOL_VERSION,
  GATE2_RAW_SCHEMA_VERSION,
  GATE2_REAL_DKG_AGENT_ADAPTER_ID,
  GATE2_VERDICT_SCHEMA_VERSION,
  REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
  appliedReadBackFromInventories,
  type Gate2AuthoredInventory,
  type Gate2ReceivedInventory,
} from './model.js';
import { sha256Digest } from './src/canonical.ts';
import {
  GATE_EVALUATION,
  PRODUCT_BOUNDARY,
  RAW_SCHEMA_ID,
  type AssetRowV1,
} from './src/schema.ts';
import { verify as verifyInventoryContract } from './src/verify.ts';

const COMMIT = /^[0-9a-f]{40,64}$/u;
const DIGEST = /^0x[0-9a-f]{64}$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;
const UAL = /^did:dkg:([^/]+)\/(0x[0-9a-f]{40})\/(0|[1-9][0-9]*)$/u;
const PRODUCTION_REASON =
  'two real DKGAgent processes completed production 1-to-2-to-3 exact-set publication, '
  + 'synchronization, authorization-negative, SIGKILL, same-head replay, and exact readback';
const REPLACEMENT_CONTRACT =
  'real DKGAgent production APIs only; no fixture adapter or synthesized product evidence';
const MAX_RAW_BYTES = 2 * 1024 * 1024;

export interface Gate2VerifiedEvidence {
  readonly rawArtifactSha256: string;
  readonly sourceCommit: string;
}

export interface Gate2PassVerdict {
  readonly gate: 'OT-RFC-64 Gate 2 multi-asset completeness';
  readonly productBoundary: 'connected';
  readonly rawArtifactSha256: string;
  readonly schemaVersion: typeof GATE2_VERDICT_SCHEMA_VERSION;
  readonly sourceCommit: string;
  readonly status: 'PASS';
}

export function buildGate2PassVerdict(
  verified: Gate2VerifiedEvidence,
): Readonly<Gate2PassVerdict> {
  return Object.freeze({
    gate: 'OT-RFC-64 Gate 2 multi-asset completeness',
    productBoundary: 'connected',
    rawArtifactSha256: verified.rawArtifactSha256,
    schemaVersion: GATE2_VERDICT_SCHEMA_VERSION,
    sourceCommit: verified.sourceCommit,
    status: 'PASS',
  });
}

export function verifyGate2ArtifactBytes(
  rawBytes: Uint8Array,
  expectedHead: string,
): Gate2VerifiedEvidence {
  matchString(expectedHead, COMMIT, 'expected repository HEAD');
  if (rawBytes.byteLength < 1 || rawBytes.byteLength > MAX_RAW_BYTES) {
    fail('$', 'raw artifact size is outside the closed verifier bound');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  } catch (cause) {
    throw new Error('Gate 2 artifact is not valid UTF-8', { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error('Gate 2 artifact is not valid JSON', { cause });
  }
  if (stableJson(parsed) !== text) fail('$', 'raw artifact is not exact canonical stable JSON');
  verifyArtifact(parsed, expectedHead);
  return Object.freeze({
    rawArtifactSha256: `0x${createHash('sha256').update(rawBytes).digest('hex')}`,
    sourceCommit: expectedHead,
  });
}

function verifyArtifact(value: unknown, expectedHead: string): void {
  const raw = closedRecord(value, '$', [
    'adapter',
    'authorizationNegative',
    'gate',
    'gateEvaluation',
    'harnessChecksPassed',
    'inventory',
    'invocation',
    'policy',
    'processBoundary',
    'ready',
    'repository',
    'restartReplay',
    'schemaVersion',
    'transitions',
    'transport',
  ]);
  exact(raw.schemaVersion, GATE2_RAW_SCHEMA_VERSION, '$.schemaVersion');
  exact(raw.gate, 'OT-RFC-64 Gate 2 multi-asset completeness', '$.gate');
  exact(raw.invocation, 'pnpm test:gate2:rfc64-multi-asset-harness', '$.invocation');
  exact(raw.harnessChecksPassed, true, '$.harnessChecksPassed');
  const evaluation = closedRecord(raw.gateEvaluation, '$.gateEvaluation', ['reason', 'status']);
  exact(evaluation.status, 'PASS', '$.gateEvaluation.status');
  exact(evaluation.reason, PRODUCTION_REASON, '$.gateEvaluation.reason');

  const adapter = closedRecord(raw.adapter, '$.adapter', [
    'id',
    'inspectedProductCommits',
    'productBoundary',
    'protocolVersion',
    'replacementContract',
    'requiredProductionOperations',
  ]);
  exact(adapter.id, GATE2_REAL_DKG_AGENT_ADAPTER_ID, '$.adapter.id');
  exact(adapter.protocolVersion, GATE2_ADAPTER_PROTOCOL_VERSION, '$.adapter.protocolVersion');
  exact(adapter.productBoundary, 'connected', '$.adapter.productBoundary');
  exact(adapter.replacementContract, REPLACEMENT_CONTRACT, '$.adapter.replacementContract');
  exactJson(
    adapter.requiredProductionOperations,
    REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
    '$.adapter.requiredProductionOperations',
  );
  exactJson(adapter.inspectedProductCommits, [expectedHead], '$.adapter.inspectedProductCommits');

  const repository = closedRecord(raw.repository, '$.repository', [
    'testedHeadCommit',
    'trackedSourceCleanAfterProcesses',
    'trackedSourceCleanBeforeSpawn',
  ]);
  exact(repository.testedHeadCommit, expectedHead, '$.repository.testedHeadCommit');
  exact(repository.trackedSourceCleanBeforeSpawn, true, '$.repository.cleanBefore');
  exact(repository.trackedSourceCleanAfterProcesses, true, '$.repository.cleanAfter');

  const peers = verifyReadyPair(raw.ready);
  verifyProcessBoundary(raw.processBoundary);
  const policy = verifyPolicy(raw.policy);
  const inventories = verifyInventories(raw.inventory, policy);
  const transitions = verifyTransitions(raw.transitions, inventories.authored.catalogHeadDigest);
  const transport = verifyTransport(raw.transport, peers, policy.policyDigest, transitions);
  const expectedApplied = appliedReadBackFromInventories(
    inventories.authored,
    inventories.received,
    transitions.finalVersion,
  );
  const positiveWire = verifyWireSynchronization(
    closedRecord(raw.authorizationNegative, '$.authorizationNegative', [
      'attemptedCatalogHeadDigest',
      'catalogAuthorAddress',
      'expectedFailureCode',
      'forgedAppliedHead',
      'forgedSynchronization',
      'positiveAppliedAfter',
      'positiveAppliedBefore',
      'positiveInventoryAfter',
      'positiveInventoryBefore',
      'recoveredAuthorAddress',
      'semanticAfter',
      'semanticBefore',
      'servedByPeerId',
      'testedByPeerId',
    ]),
    '$.authorizationNegative',
    inventories,
    expectedApplied,
    peers,
  );
  exact(
    transport.verifiedControlObjectCount,
    positiveWire.verifiedControlObjectCount,
    '$.transport.verifiedControlObjectCount',
  );
  verifyRestart(
    raw.restartReplay,
    inventories,
    expectedApplied,
    peers,
    positiveWire.semantic,
  );
}

function verifyInventories(
  value: unknown,
  policy: { networkId: string; contextGraphId: string },
): { authored: Gate2AuthoredInventory; received: Gate2ReceivedInventory } {
  const inventory = closedRecord(value, '$.inventory', ['authored', 'received']);
  const contractRaw = {
    schema: RAW_SCHEMA_ID,
    productBoundary: PRODUCT_BOUNDARY,
    gateEvaluation: GATE_EVALUATION,
    authored: inventory.authored,
    received: inventory.received,
  };
  const verdict = verifyInventoryContract(contractRaw);
  if (!verdict.fixtureComplete || Object.values(verdict.checks).some((check) => !check)) {
    fail('$.inventory', `exact-set completeness rejected: ${verdict.rejectReasons.join('; ')}`);
  }
  const authored = inventory.authored as Gate2AuthoredInventory;
  const received = inventory.received as Gate2ReceivedInventory;
  exact(authored.signedRows.length, 3, '$.inventory.authored.signedRows.length');
  exact(received.activatedRows.length, 3, '$.inventory.received.activatedRows.length');
  exact(authored.catalogScope.networkId, policy.networkId, '$.inventory.authored.scope.networkId');
  exact(
    authored.catalogScope.contextGraphId,
    policy.contextGraphId,
    '$.inventory.authored.scope.contextGraphId',
  );
  return { authored, received };
}

function verifyTransitions(
  value: unknown,
  finalHead: string,
): { finalSignatureVariantDigest: string; finalVersion: string } {
  const entries = closedArray(value, '$.transitions', 3);
  let previousHead: string | undefined;
  let finalSignatureVariantDigest = '';
  for (const [index, entry] of entries.entries()) {
    const transition = closedRecord(entry, `$.transitions[${index}]`, [
      'catalogHeadDigest',
      'catalogVersion',
      'inventoryRowCount',
      'previousCatalogHeadDigest',
      'signatureVariantDigest',
    ]);
    const head = digest(transition.catalogHeadDigest, `$.transitions[${index}].catalogHeadDigest`);
    const predecessor = digest(
      transition.previousCatalogHeadDigest,
      `$.transitions[${index}].previousCatalogHeadDigest`,
    );
    exact(transition.inventoryRowCount, index + 1, `$.transitions[${index}].inventoryRowCount`);
    exact(transition.catalogVersion, String(index + 1), `$.transitions[${index}].catalogVersion`);
    if (previousHead !== undefined) {
      exact(predecessor, previousHead, `$.transitions[${index}].previousCatalogHeadDigest`);
    }
    previousHead = head;
    finalSignatureVariantDigest = digest(
      transition.signatureVariantDigest,
      `$.transitions[${index}].signatureVariantDigest`,
    );
  }
  exact(previousHead, finalHead, '$.transitions final head');
  return { finalSignatureVariantDigest, finalVersion: '3' };
}

function verifyTransport(
  value: unknown,
  peers: { author: string; receiver: string },
  policyDigest: string,
  transitions: { finalSignatureVariantDigest: string },
): { verifiedControlObjectCount: number } {
  const transport = closedRecord(value, '$.transport', [
    'finalAnnouncementPolicyDigest',
    'finalSignatureVariantDigest',
    'receivedByPeerId',
    'servedByPeerId',
    'verifiedControlObjectCount',
  ]);
  exact(transport.servedByPeerId, peers.author, '$.transport.servedByPeerId');
  exact(transport.receivedByPeerId, peers.receiver, '$.transport.receivedByPeerId');
  exact(
    transport.finalAnnouncementPolicyDigest,
    policyDigest,
    '$.transport.finalAnnouncementPolicyDigest',
  );
  exact(
    transport.finalSignatureVariantDigest,
    transitions.finalSignatureVariantDigest,
    '$.transport.finalSignatureVariantDigest',
  );
  const verifiedControlObjectCount = exactInteger(
    transport.verifiedControlObjectCount,
    4,
    '$.transport.verifiedControlObjectCount',
  );
  return { verifiedControlObjectCount };
}

function verifyWireSynchronization(
  negative: Record<string, unknown>,
  path: string,
  inventories: { authored: Gate2AuthoredInventory; received: Gate2ReceivedInventory },
  expectedApplied: unknown,
  peers: { author: string; receiver: string },
): { semantic: unknown; verifiedControlObjectCount: number } {
  exact(negative.expectedFailureCode, 'catalog-native-receiver-authorization', `${path}.failureCode`);
  digest(negative.attemptedCatalogHeadDigest, `${path}.attemptedCatalogHeadDigest`);
  const author = address(negative.catalogAuthorAddress, `${path}.catalogAuthorAddress`);
  exact(author, inventories.authored.catalogScope.authorAddress, `${path}.catalogAuthorAddress`);
  const recovered = address(negative.recoveredAuthorAddress, `${path}.recoveredAuthorAddress`);
  if (recovered === author) fail(`${path}.recoveredAuthorAddress`, 'must differ from author');
  exact(negative.forgedAppliedHead, null, `${path}.forgedAppliedHead`);
  exact(negative.forgedSynchronization, null, `${path}.forgedSynchronization`);
  exact(negative.servedByPeerId, peers.author, `${path}.servedByPeerId`);
  exact(negative.testedByPeerId, peers.receiver, `${path}.testedByPeerId`);
  exactJson(negative.positiveAppliedBefore, expectedApplied, `${path}.positiveAppliedBefore`);
  exactJson(negative.positiveAppliedAfter, expectedApplied, `${path}.positiveAppliedAfter`);
  exactJson(
    negative.positiveInventoryAfter,
    negative.positiveInventoryBefore,
    `${path}.positiveInventoryAfter`,
  );
  const wire = verifyPositiveWireInventory(
    negative.positiveInventoryBefore,
    `${path}.positiveInventoryBefore`,
    inventories,
  );
  exactJson(negative.semanticAfter, negative.semanticBefore, `${path}.semanticAfter`);
  verifySemanticState(negative.semanticBefore, `${path}.semanticBefore`, wire.rows);
  return {
    semantic: negative.semanticBefore,
    verifiedControlObjectCount: wire.verifiedControlObjectCount,
  };
}

function verifyPositiveWireInventory(
  value: unknown,
  path: string,
  inventories: { authored: Gate2AuthoredInventory; received: Gate2ReceivedInventory },
): { rows: readonly WireRow[]; verifiedControlObjectCount: number } {
  const wire = closedRecord(value, path, [
    'activatedTripleCount',
    'appliedHeadStatus',
    'catalogHeadDigest',
    'inventoryDigest',
    'inventoryRowCount',
    'rows',
    'verifiedControlObjectCount',
  ]);
  exact(wire.appliedHeadStatus, 'applied', `${path}.appliedHeadStatus`);
  exact(wire.catalogHeadDigest, inventories.authored.catalogHeadDigest, `${path}.catalogHeadDigest`);
  exact(wire.inventoryDigest, inventories.received.declaredInventoryDigest, `${path}.inventoryDigest`);
  exact(wire.inventoryRowCount, 3, `${path}.inventoryRowCount`);
  const verifiedControlObjectCount = exactInteger(
    wire.verifiedControlObjectCount,
    4,
    `${path}.verifiedControlObjectCount`,
  );
  const rows = closedArray(wire.rows, `${path}.rows`, 3).map((entry, index) => {
    const row = closedRecord(entry, `${path}.rows[${index}]`, [
      'activatedTripleCount',
      'bundleDigest',
      'catalogRowDigest',
      'contentDigest',
      'kaId',
      'kaUal',
      'sealDigest',
      'swmGraph',
    ]);
    const contractRow: AssetRowV1 = {
      kaId: decimal(row.kaId, `${path}.rows[${index}].kaId`),
      catalogRowDigest: digest(row.catalogRowDigest, `${path}.rows[${index}].catalogRowDigest`),
      contentDigest: digest(row.contentDigest, `${path}.rows[${index}].contentDigest`),
      sealDigest: digest(row.sealDigest, `${path}.rows[${index}].sealDigest`),
      bundleDigest: digest(row.bundleDigest, `${path}.rows[${index}].bundleDigest`),
      kaUal: boundedString(row.kaUal, `${path}.rows[${index}].kaUal`),
      activatedTripleCount: positiveInteger(
        row.activatedTripleCount,
        `${path}.rows[${index}].activatedTripleCount`,
      ),
    };
    exactJson(
      contractRow,
      inventories.received.activatedRows[index],
      `${path}.rows[${index}] product row`,
    );
    return Object.freeze({
      ...contractRow,
      swmGraph: boundedString(row.swmGraph, `${path}.rows[${index}].swmGraph`),
    });
  });
  exact(
    wire.activatedTripleCount,
    rows.reduce((total, row) => total + row.activatedTripleCount, 0),
    `${path}.activatedTripleCount`,
  );
  return { rows: Object.freeze(rows), verifiedControlObjectCount };
}

interface WireRow extends AssetRowV1 {
  readonly swmGraph: string;
}

const KA_PROJECTION_DIGEST_DOMAIN_V1 = 'dkg-ka-projection-v1\n';

function verifySemanticState(value: unknown, path: string, rows: readonly WireRow[]): void {
  const semantic = closedArray(value, path, 3);
  semantic.forEach((entry, index) => {
    const state = closedRecord(entry, `${path}[${index}]`, ['kaId', 'readBack']);
    exact(state.kaId, rows[index]!.kaId, `${path}[${index}].kaId`);
    const readBack = closedRecord(state.readBack, `${path}[${index}].readBack`, [
      'activatedQuadCount',
      'projectionNQuads',
      'swmGraph',
    ]);
    exact(
      readBack.activatedQuadCount,
      rows[index]!.activatedTripleCount,
      `${path}[${index}].activatedQuadCount`,
    );
    exact(readBack.swmGraph, rows[index]!.swmGraph, `${path}[${index}].swmGraph`);
    const projection = boundedString(
      readBack.projectionNQuads,
      `${path}[${index}].projectionNQuads`,
      256 * 1024,
    );
    exact(
      sha256Digest(KA_PROJECTION_DIGEST_DOMAIN_V1, projection),
      rows[index]!.contentDigest,
      `${path}[${index}].projection digest`,
    );
  });
}

function verifyRestart(
  value: unknown,
  inventories: { authored: Gate2AuthoredInventory; received: Gate2ReceivedInventory },
  expectedApplied: unknown,
  peers: { author: string; receiver: string },
  semanticBefore: unknown,
): void {
  const restart = closedRecord(value, '$.restartReplay', [
    'appliedReadBack',
    'crashExit',
    'processLocalSynchronization',
    'reannouncementAcknowledgedByPeerId',
    'receiverStats',
    'restartedReady',
    'semanticPostRead',
    'successorServedByPeerId',
  ]);
  exactJson(restart.appliedReadBack, expectedApplied, '$.restartReplay.appliedReadBack');
  verifyExit(restart.crashExit, '$.restartReplay.crashExit', null, 'SIGKILL');
  exact(restart.processLocalSynchronization, null, '$.restartReplay.processLocalSynchronization');
  exact(
    restart.reannouncementAcknowledgedByPeerId,
    peers.receiver,
    '$.restartReplay.reannouncementAcknowledgedByPeerId',
  );
  exact(restart.successorServedByPeerId, peers.author, '$.restartReplay.successorServedByPeerId');
  const stats = closedRecord(restart.receiverStats, '$.restartReplay.receiverStats', [
    'applied',
    'dedupedAlreadyApplied',
  ]);
  exact(stats.applied, 0, '$.restartReplay.receiverStats.applied');
  exact(stats.dedupedAlreadyApplied, 1, '$.restartReplay.receiverStats.dedupedAlreadyApplied');
  const restartedPeer = verifyReadyEvent(
    restart.restartedReady,
    '$.restartReplay.restartedReady',
    'receiver',
  );
  exact(restartedPeer, peers.receiver, '$.restartReplay.restartedReady.peerId');
  exactJson(restart.semanticPostRead, semanticBefore, '$.restartReplay.semanticPostRead');
  const rows = inventories.received.activatedRows.map((row, index) => ({
    ...row,
    swmGraph: (closedRecord(
      (closedArray(semanticBefore, '$.authorizationNegative.semanticBefore', 3)[index] as unknown),
      `$.authorizationNegative.semanticBefore[${index}]`,
      ['kaId', 'readBack'],
    ).readBack as Record<string, unknown>).swmGraph as string,
  }));
  verifySemanticState(restart.semanticPostRead, '$.restartReplay.semanticPostRead', rows);
}

function verifyReadyPair(value: unknown): { author: string; receiver: string } {
  const ready = closedRecord(value, '$.ready', ['author', 'receiver']);
  const author = verifyReadyEvent(ready.author, '$.ready.author', 'author');
  const receiver = verifyReadyEvent(ready.receiver, '$.ready.receiver', 'receiver');
  if (author === receiver) fail('$.ready', 'author and receiver peers must be distinct');
  return { author, receiver };
}

function verifyReadyEvent(value: unknown, path: string, role: 'author' | 'receiver'): string {
  const ready = closedRecord(value, path, [
    'adapterId',
    'peerId',
    'protocolVersion',
    'role',
    'startupRepair',
  ]);
  exact(ready.adapterId, GATE2_REAL_DKG_AGENT_ADAPTER_ID, `${path}.adapterId`);
  exact(ready.protocolVersion, GATE2_ADAPTER_PROTOCOL_VERSION, `${path}.protocolVersion`);
  exact(ready.role, role, `${path}.role`);
  exact(ready.startupRepair, null, `${path}.startupRepair`);
  return boundedString(ready.peerId, `${path}.peerId`);
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

function verifyPolicy(value: unknown): {
  contextGraphId: string;
  networkId: string;
  policyDigest: string;
} {
  const policy = closedRecord(value, '$.policy', [
    'authorPolicyDigest',
    'contextGraphId',
    'networkId',
    'receiverPolicyDigest',
  ]);
  const policyDigest = digest(policy.authorPolicyDigest, '$.policy.authorPolicyDigest');
  exact(policy.receiverPolicyDigest, policyDigest, '$.policy.receiverPolicyDigest');
  return {
    contextGraphId: boundedString(policy.contextGraphId, '$.policy.contextGraphId'),
    networkId: boundedString(policy.networkId, '$.policy.networkId'),
    policyDigest,
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
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'must be plain');
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (stableJson(keys) !== stableJson(expected)) {
    fail(path, `must contain exactly keys ${expected.join(', ')}`);
  }
  return value as Record<string, unknown>;
}

function closedArray(value: unknown, path: string, exactLength: number): unknown[] {
  if (!Array.isArray(value) || value.length !== exactLength) {
    fail(path, `must be an Array of exactly ${exactLength} entries`);
  }
  return value;
}

function digest(value: unknown, path: string): string {
  return matchString(value, DIGEST, path);
}

function address(value: unknown, path: string): string {
  return matchString(value, ADDRESS, path);
}

function decimal(value: unknown, path: string): string {
  return matchString(value, DECIMAL, path);
}

function matchString(value: unknown, pattern: RegExp, path: string): string {
  const text = boundedString(value, path);
  if (!pattern.test(text)) fail(path, 'is malformed');
  return text;
}

function boundedString(value: unknown, path: string, max = 4_096): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    fail(path, 'must be a bounded non-empty string');
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(path, 'must be a positive safe integer');
  }
  return value as number;
}

function exactInteger(value: unknown, expected: number, path: string): number {
  if (!Number.isSafeInteger(value) || value !== expected) fail(path, `must equal ${expected}`);
  return value as number;
}

function exact(actual: unknown, expected: unknown, path: string): void {
  if (!Object.is(actual, expected)) fail(path, `must equal ${JSON.stringify(expected)}`);
}

function exactJson(actual: unknown, expected: unknown, path: string): void {
  if (stableJson(actual) !== stableJson(expected)) fail(path, 'must equal exact product evidence');
}

function fail(path: string, message: string): never {
  throw new Error(`Gate 2 evidence verification failed at ${path}: ${message}`);
}
