import { createHash } from 'node:crypto';

import { stableJson } from './evidence.js';

export const GATE0_RAW_SCHEMA_VERSION = 'dkg-rfc64-gate0-persistence-evidence-v3';
export const GATE0_VERDICT_SCHEMA_VERSION = 'dkg-rfc64-gate0-persistence-verdict-v1';

const SHA256_PATTERN = /^0x[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/u;
const OBJECT_ROOT = 'rfc64-sync/control-objects-v1';
const EXPECTED_FIXTURE = Object.freeze({
  objectDigest: '0xeec5dff9739afed395f8723e22c2a269e90f094422d42dc4c83b7cbb78c4a320',
  signatureVariantDigest: '0x446e5876feb11ef43d611fa634bb0d1960896cff889c06bcbcab98790246f1d9',
  objectFileSha256: '0x37ca991c9bc1757d7b4e0839f6308aa3970a7020a940c5d885879e2c0db9d67f',
  signatureFileSha256: '0x04f0668c46bd319cfd7353ec7831f01e2e1fb04dc7b3920a496b0ec4d2fe1947',
  objectFileByteLength: 292,
  signatureFileByteLength: 326,
});

interface VerifiedSnapshot {
  readonly filesCanonical: string;
}

export interface Gate0VerifiedEvidence {
  readonly sourceCommit: string;
  readonly rawArtifactSha256: string;
}

export function verifyGate0ArtifactBytes(
  rawBytes: Uint8Array,
  expectedHead: string,
  expectedPlatform: NodeJS.Platform,
): Gate0VerifiedEvidence {
  requireMatch(expectedHead, COMMIT_PATTERN, 'expected repository HEAD');
  if (rawBytes.byteLength === 0 || rawBytes.byteLength > 1_000_000) {
    fail('$', 'raw artifact size is outside the closed verifier bound');
  }
  let rawText: string;
  try {
    rawText = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  } catch (cause) {
    throw new Error('Gate 0 artifact is not valid UTF-8', { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch (cause) {
    throw new Error('Gate 0 artifact is not valid JSON', { cause });
  }
  let canonical: string;
  try {
    canonical = stableJson(parsed);
  } catch (cause) {
    throw new Error('Gate 0 artifact contains a lossy or non-plain data shape', { cause });
  }
  if (canonical !== rawText) {
    fail('$', 'raw artifact is not the exact canonical stable JSON encoding');
  }

  verifyClosedArtifact(parsed, expectedHead, expectedPlatform);
  return {
    sourceCommit: expectedHead,
    rawArtifactSha256: sha256(rawBytes),
  };
}

function verifyClosedArtifact(
  value: unknown,
  expectedHead: string,
  expectedPlatform: NodeJS.Platform,
): void {
  const artifact = closedRecord(value, '$', [
    'checks',
    'filesystemSecurity',
    'fixture',
    'gate',
    'gateEvaluation',
    'harnessChecksPassed',
    'invocation',
    'phases',
    'productionBaselineCommit',
    'repository',
    'runtimeBoundary',
    'schemaVersion',
  ]);
  exact(artifact.schemaVersion, GATE0_RAW_SCHEMA_VERSION, '$.schemaVersion');
  exact(artifact.gate, 'OT-RFC-64 Gate 0', '$.gate');
  exact(
    artifact.invocation,
    'pnpm test:gate0:rfc64-persistence-lifecycle',
    '$.invocation',
  );
  exact(artifact.productionBaselineCommit, expectedHead, '$.productionBaselineCommit');
  exact(artifact.harnessChecksPassed, true, '$.harnessChecksPassed');

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

  const runtime = closedRecord(artifact.runtimeBoundary, '$.runtimeBoundary', [
    'agentClass',
    'controlChannel',
    'processModel',
    'publicDebugEndpointAdded',
  ]);
  exact(runtime.agentClass, 'DKGAgent', '$.runtimeBoundary.agentClass');
  exact(
    runtime.processModel,
    'three independent production agent processes',
    '$.runtimeBoundary.processModel',
  );
  exact(
    runtime.controlChannel,
    'stdio and POSIX process signals only',
    '$.runtimeBoundary.controlChannel',
  );
  exact(
    runtime.publicDebugEndpointAdded,
    false,
    '$.runtimeBoundary.publicDebugEndpointAdded',
  );

  const evaluation = closedRecord(artifact.gateEvaluation, '$.gateEvaluation', [
    'reason',
    'status',
  ]);
  exact(evaluation.status, 'not-evaluated', '$.gateEvaluation.status');
  exact(
    evaluation.reason,
    'raw lifecycle evidence requires separate fail-closed verification',
    '$.gateEvaluation.reason',
  );

  verifyFilesystemSecurity(artifact.filesystemSecurity, expectedPlatform);
  verifyChecks(artifact.checks, expectedPlatform);

  const fixture = closedRecord(artifact.fixture, '$.fixture', [
    'objectDigest',
    'objectFileSha256',
    'signatureFileSha256',
    'signatureVariantDigest',
  ]);
  const objectDigest = digest(fixture.objectDigest, '$.fixture.objectDigest');
  const signatureVariantDigest = digest(
    fixture.signatureVariantDigest,
    '$.fixture.signatureVariantDigest',
  );
  const objectFileSha256 = digest(
    fixture.objectFileSha256,
    '$.fixture.objectFileSha256',
  );
  const signatureFileSha256 = digest(
    fixture.signatureFileSha256,
    '$.fixture.signatureFileSha256',
  );
  exact(objectDigest, EXPECTED_FIXTURE.objectDigest, '$.fixture.objectDigest');
  exact(
    signatureVariantDigest,
    EXPECTED_FIXTURE.signatureVariantDigest,
    '$.fixture.signatureVariantDigest',
  );
  exact(
    objectFileSha256,
    EXPECTED_FIXTURE.objectFileSha256,
    '$.fixture.objectFileSha256',
  );
  exact(
    signatureFileSha256,
    EXPECTED_FIXTURE.signatureFileSha256,
    '$.fixture.signatureFileSha256',
  );

  const phases = closedRecord(artifact.phases, '$.phases', [
    'gracefulRestart',
    'initialRunningOwner',
    'operatingSystemLeaseRecovery',
  ]);
  const expectedFiles = expectedFileEvidence(
    objectDigest,
    signatureVariantDigest,
    objectFileSha256,
    signatureFileSha256,
  );

  const initial = closedRecord(phases.initialRunningOwner, '$.phases.initialRunningOwner', [
    'agentStarted',
    'contender',
    'inventoryOperational',
    'namespaceDurability',
    'persistenceClosed',
    'snapshot',
    'staged',
    'verifiedRead',
  ]);
  exact(initial.agentStarted, true, '$.phases.initialRunningOwner.agentStarted');
  exact(
    initial.inventoryOperational,
    true,
    '$.phases.initialRunningOwner.inventoryOperational',
  );
  exact(initial.persistenceClosed, false, '$.phases.initialRunningOwner.persistenceClosed');
  exact(initial.staged, true, '$.phases.initialRunningOwner.staged');
  exact(initial.verifiedRead, true, '$.phases.initialRunningOwner.verifiedRead');
  exact(
    initial.namespaceDurability,
    expectedPlatform === 'win32'
      ? 'windows-file-flush-hardlink-no-replace-v1'
      : 'posix-hardlink-no-replace-directory-fsync-v1',
    '$.phases.initialRunningOwner.namespaceDurability',
  );
  verifyLeaseBusy(initial.contender, '$.phases.initialRunningOwner.contender');
  const initialSnapshot = verifySnapshot(
    initial.snapshot,
    '$.phases.initialRunningOwner.snapshot',
    expectedFiles,
    objectDigest,
    expectedPlatform,
  );

  const graceful = closedRecord(phases.gracefulRestart, '$.phases.gracefulRestart', [
    'agentStarted',
    'contender',
    'exactContentFilesEqual',
    'inventoryOperational',
    'persistenceClosed',
    'priorExit',
    'snapshot',
    'staged',
    'verifiedRead',
  ]);
  exact(graceful.agentStarted, true, '$.phases.gracefulRestart.agentStarted');
  exact(
    graceful.inventoryOperational,
    true,
    '$.phases.gracefulRestart.inventoryOperational',
  );
  exact(graceful.persistenceClosed, false, '$.phases.gracefulRestart.persistenceClosed');
  exact(graceful.staged, false, '$.phases.gracefulRestart.staged');
  exact(graceful.verifiedRead, true, '$.phases.gracefulRestart.verifiedRead');
  exact(
    graceful.exactContentFilesEqual,
    true,
    '$.phases.gracefulRestart.exactContentFilesEqual',
  );
  verifyLeaseBusy(graceful.contender, '$.phases.gracefulRestart.contender');
  verifyExit(graceful.priorExit, '$.phases.gracefulRestart.priorExit', 0, null);
  const gracefulSnapshot = verifySnapshot(
    graceful.snapshot,
    '$.phases.gracefulRestart.snapshot',
    expectedFiles,
    objectDigest,
    expectedPlatform,
  );

  const recovery = closedRecord(
    phases.operatingSystemLeaseRecovery,
    '$.phases.operatingSystemLeaseRecovery',
    [
      'agentStarted',
      'contender',
      'exactContentFilesEqual',
      'finalGracefulExit',
      'inventoryOperational',
      'persistenceClosed',
      'snapshot',
      'staged',
      'uncleanExit',
      'verifiedRead',
    ],
  );
  exact(recovery.agentStarted, true, '$.phases.operatingSystemLeaseRecovery.agentStarted');
  exact(
    recovery.inventoryOperational,
    true,
    '$.phases.operatingSystemLeaseRecovery.inventoryOperational',
  );
  exact(
    recovery.persistenceClosed,
    false,
    '$.phases.operatingSystemLeaseRecovery.persistenceClosed',
  );
  exact(recovery.staged, false, '$.phases.operatingSystemLeaseRecovery.staged');
  exact(recovery.verifiedRead, true, '$.phases.operatingSystemLeaseRecovery.verifiedRead');
  exact(
    recovery.exactContentFilesEqual,
    true,
    '$.phases.operatingSystemLeaseRecovery.exactContentFilesEqual',
  );
  verifyLeaseBusy(
    recovery.contender,
    '$.phases.operatingSystemLeaseRecovery.contender',
  );
  verifyExit(
    recovery.uncleanExit,
    '$.phases.operatingSystemLeaseRecovery.uncleanExit',
    null,
    'SIGKILL',
  );
  verifyExit(
    recovery.finalGracefulExit,
    '$.phases.operatingSystemLeaseRecovery.finalGracefulExit',
    0,
    null,
  );
  const recoverySnapshot = verifySnapshot(
    recovery.snapshot,
    '$.phases.operatingSystemLeaseRecovery.snapshot',
    expectedFiles,
    objectDigest,
    expectedPlatform,
  );

  if (
    gracefulSnapshot.filesCanonical !== initialSnapshot.filesCanonical
    || recoverySnapshot.filesCanonical !== initialSnapshot.filesCanonical
  ) {
    fail('$.phases', 'durable file evidence changed across lifecycle phases');
  }
}

function verifyFilesystemSecurity(value: unknown, platform: NodeJS.Platform): void {
  if (platform === 'win32') {
    const evidence = closedRecord(value, '$.filesystemSecurity', [
      'inheritedAccessRulesAllowed',
      'otherSidAllowRulesAllowed',
      'platform',
      'policy',
      'productionPolicyChecksPassed',
    ]);
    exact(evidence.platform, 'win32', '$.filesystemSecurity.platform');
    exact(
      evidence.policy,
      'windows-protected-current-user-owner-only-full-control-v1',
      '$.filesystemSecurity.policy',
    );
    exact(
      evidence.productionPolicyChecksPassed,
      true,
      '$.filesystemSecurity.productionPolicyChecksPassed',
    );
    exact(
      evidence.inheritedAccessRulesAllowed,
      false,
      '$.filesystemSecurity.inheritedAccessRulesAllowed',
    );
    exact(
      evidence.otherSidAllowRulesAllowed,
      false,
      '$.filesystemSecurity.otherSidAllowRulesAllowed',
    );
    return;
  }
  const evidence = closedRecord(value, '$.filesystemSecurity', [
    'platform',
    'policy',
    'requiredDirectoryMode',
    'requiredFileMode',
  ]);
  exact(evidence.platform, platform, '$.filesystemSecurity.platform');
  exact(evidence.policy, 'posix-owner-only-mode-v1', '$.filesystemSecurity.policy');
  exact(evidence.requiredFileMode, '0600', '$.filesystemSecurity.requiredFileMode');
  exact(
    evidence.requiredDirectoryMode,
    '0700',
    '$.filesystemSecurity.requiredDirectoryMode',
  );
}

function verifyChecks(value: unknown, platform: NodeJS.Platform): void {
  const checks = closedRecord(value, '$.checks', [
    'competingLeaseRejectedWhileRunning',
    'durableControlObjectBytesPreserved',
    'exactObjectCount',
    'exactSignatureCount',
    'gracefulRestartSucceeded',
    'inventoryOperationalWhileRunning',
    'operatingSystemLeaseRecoveredAfterSigkill',
    'ownerOnlyFileModes',
    'productionAgentStarted',
    'publicRuntimeDebugEndpointAdded',
    'storedEnvelopeSignatureReverifiedOnEveryStart',
  ]);
  for (const key of [
    'competingLeaseRejectedWhileRunning',
    'durableControlObjectBytesPreserved',
    'gracefulRestartSucceeded',
    'inventoryOperationalWhileRunning',
    'operatingSystemLeaseRecoveredAfterSigkill',
    'productionAgentStarted',
    'storedEnvelopeSignatureReverifiedOnEveryStart',
  ]) {
    exact(checks[key], true, `$.checks.${key}`);
  }
  exact(checks.exactObjectCount, 1, '$.checks.exactObjectCount');
  exact(checks.exactSignatureCount, 1, '$.checks.exactSignatureCount');
  exact(
    checks.ownerOnlyFileModes,
    platform === 'win32' ? 'not-applicable' : true,
    '$.checks.ownerOnlyFileModes',
  );
  exact(
    checks.publicRuntimeDebugEndpointAdded,
    false,
    '$.checks.publicRuntimeDebugEndpointAdded',
  );
}

function verifySnapshot(
  value: unknown,
  path: string,
  expectedFiles: readonly Record<string, unknown>[],
  objectDigest: string,
  platform: NodeJS.Platform,
): VerifiedSnapshot {
  const snapshot = closedRecord(value, path, [
    'counts',
    'files',
    'inventoryFileMode',
    'leaseFileMode',
    'namespaceDirectoryModes',
  ]);
  const counts = closedRecord(snapshot.counts, `${path}.counts`, ['objects', 'signatures']);
  exact(counts.objects, 1, `${path}.counts.objects`);
  exact(counts.signatures, 1, `${path}.counts.signatures`);

  if (!Array.isArray(snapshot.files) || snapshot.files.length !== 2) {
    fail(`${path}.files`, 'must contain exactly one object and one signature file');
  }
  for (let index = 0; index < expectedFiles.length; index += 1) {
    const actual = closedRecord(snapshot.files[index], `${path}.files[${index}]`, [
      'byteLength',
      'kind',
      'mode',
      'relativePath',
      'sha256',
    ]);
    const expected = expectedFiles[index];
    exact(actual.kind, expected.kind, `${path}.files[${index}].kind`);
    exact(
      actual.relativePath,
      expected.relativePath,
      `${path}.files[${index}].relativePath`,
    );
    exact(actual.sha256, expected.sha256, `${path}.files[${index}].sha256`);
    exact(
      actual.byteLength,
      expected.byteLength,
      `${path}.files[${index}].byteLength`,
    );
    exact(
      actual.mode,
      platform === 'win32' ? null : '0600',
      `${path}.files[${index}].mode`,
    );
  }

  exact(snapshot.inventoryFileMode, platform === 'win32' ? null : '0600', `${path}.inventoryFileMode`);
  exact(snapshot.leaseFileMode, platform === 'win32' ? null : '0600', `${path}.leaseFileMode`);
  const objectHex = objectDigest.slice(2);
  const prefix = objectHex.slice(0, 2);
  const expectedDirectories = [
    'rfc64-sync',
    OBJECT_ROOT,
    `${OBJECT_ROOT}/objects`,
    `${OBJECT_ROOT}/objects/${prefix}`,
    `${OBJECT_ROOT}/signatures`,
    `${OBJECT_ROOT}/signatures/${prefix}`,
    `${OBJECT_ROOT}/signatures/${prefix}/${objectHex}`,
  ];
  if (
    !Array.isArray(snapshot.namespaceDirectoryModes)
    || snapshot.namespaceDirectoryModes.length !== expectedDirectories.length
  ) {
    fail(`${path}.namespaceDirectoryModes`, 'contains an unexpected directory list');
  }
  for (let index = 0; index < expectedDirectories.length; index += 1) {
    const directory = closedRecord(
      snapshot.namespaceDirectoryModes[index],
      `${path}.namespaceDirectoryModes[${index}]`,
      ['mode', 'relativePath'],
    );
    exact(
      directory.relativePath,
      expectedDirectories[index],
      `${path}.namespaceDirectoryModes[${index}].relativePath`,
    );
    exact(
      directory.mode,
      platform === 'win32' ? null : '0700',
      `${path}.namespaceDirectoryModes[${index}].mode`,
    );
  }
  return { filesCanonical: stableJson(snapshot.files) };
}

function expectedFileEvidence(
  objectDigest: string,
  signatureVariantDigest: string,
  objectFileSha256: string,
  signatureFileSha256: string,
): readonly Record<string, unknown>[] {
  const objectHex = objectDigest.slice(2);
  const signatureHex = signatureVariantDigest.slice(2);
  const prefix = objectHex.slice(0, 2);
  return [
    {
      kind: 'object',
      relativePath: `${OBJECT_ROOT}/objects/${prefix}/${objectHex}.jcs`,
      sha256: objectFileSha256,
      byteLength: EXPECTED_FIXTURE.objectFileByteLength,
    },
    {
      kind: 'signature',
      relativePath: `${OBJECT_ROOT}/signatures/${prefix}/${objectHex}/${signatureHex}.jcs`,
      sha256: signatureFileSha256,
      byteLength: EXPECTED_FIXTURE.signatureFileByteLength,
    },
  ];
}

function verifyLeaseBusy(value: unknown, path: string): void {
  const contender = closedRecord(value, path, ['acquired', 'errorCode', 'event']);
  exact(contender.event, 'lease-probe', `${path}.event`);
  exact(contender.acquired, false, `${path}.acquired`);
  exact(contender.errorCode, 'database-busy', `${path}.errorCode`);
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
    fail(path, 'must be a closed plain object');
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort(compareCodeUnits);
  const sortedExpected = [...expectedKeys].sort(compareCodeUnits);
  if (
    actualKeys.length !== sortedExpected.length
    || actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    fail(path, `has unexpected fields: ${JSON.stringify(actualKeys)}`);
  }
  return record;
}

function digest(value: unknown, path: string): string {
  requireMatch(value, SHA256_PATTERN, path);
  return value as string;
}

function requireMatch(value: unknown, pattern: RegExp, path: string): void {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(path, 'has an invalid exact encoding');
  }
}

function exact(actual: unknown, expected: unknown, path: string): void {
  if (!Object.is(actual, expected)) {
    fail(path, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: Uint8Array): string {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

function fail(path: string, message: string): never {
  throw new Error(`Gate 0 artifact verification failed at ${path}: ${message}`);
}
