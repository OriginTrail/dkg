import assert from 'node:assert/strict';
import test from 'node:test';

import { stableJson } from './evidence.js';
import {
  GATE0_RAW_SCHEMA_VERSION,
  verifyGate0ArtifactBytes,
} from './verifier.js';

const HEAD = 'a'.repeat(40);
const OBJECT_DIGEST = `0x${'11'.repeat(32)}`;
const SIGNATURE_DIGEST = `0x${'22'.repeat(32)}`;
const OBJECT_SHA256 = `0x${'33'.repeat(32)}`;
const SIGNATURE_SHA256 = `0x${'44'.repeat(32)}`;

type JsonPath = readonly (string | number)[];

test('verifier accepts the exact closed POSIX and Windows evidence schemas', () => {
  for (const platform of ['linux', 'win32'] as const) {
    const verified = verifyGate0ArtifactBytes(
      Buffer.from(stableJson(validArtifact(platform))),
      HEAD,
      platform,
    );
    assert.equal(verified.sourceCommit, HEAD);
    assert.match(verified.rawArtifactSha256, /^0x[0-9a-f]{64}$/u);
  }
});

test('every required field, leaf value, object closure, and array bound fails closed', () => {
  for (const platform of ['linux', 'win32'] as const) {
    const valid = validArtifact(platform);
    const locations = collectLocations(valid);
    assert.ok(locations.properties.length > 100);
    assert.ok(locations.leaves.length > 100);
    assert.ok(locations.objects.length > 30);
    assert.ok(locations.arrays.length >= 6);

    for (const path of locations.properties) {
      const mutation = structuredClone(valid);
      const parent = valueAt(mutation, path.slice(0, -1)) as Record<string, unknown>;
      delete parent[path.at(-1) as string];
      assertRejected(mutation, platform, `deleted ${formatPath(path)}`);
    }
    for (const path of locations.leaves) {
      const mutation = structuredClone(valid);
      const parent = valueAt(mutation, path.slice(0, -1)) as Record<string | number, unknown>;
      const key = path.at(-1) as string | number;
      parent[key] = mutatedLeaf(parent[key]);
      assertRejected(mutation, platform, `mutated ${formatPath(path)}`);
    }
    for (const path of locations.objects) {
      const mutation = structuredClone(valid);
      const record = valueAt(mutation, path) as Record<string, unknown>;
      record.unexpectedVerifierMutation = true;
      assertRejected(mutation, platform, `extended ${formatPath(path)}`);
    }
    for (const path of locations.arrays) {
      const mutation = structuredClone(valid);
      const array = valueAt(mutation, path) as unknown[];
      array.push(null);
      assertRejected(mutation, platform, `extended ${formatPath(path)}`);
    }
  }
});

test('verifier rejects malformed, non-canonical, duplicate, and lossy JSON encodings', () => {
  const valid = validArtifact('linux');
  const canonical = stableJson(valid);
  const duplicate = canonical.replace(
    /^\{\n/u,
    '{\n  "gate": "OT-RFC-64 Gate 0",\n',
  );
  const negativeZero = canonical.replace('"byteLength": 292', '"byteLength": -0');
  for (const bytes of [
    Buffer.from('{'),
    Buffer.from(JSON.stringify(valid)),
    Buffer.from(`${canonical} `),
    Buffer.from(duplicate),
    Buffer.from(negativeZero),
    Buffer.from([0xff]),
  ]) {
    assert.throws(() => verifyGate0ArtifactBytes(bytes, HEAD, 'linux'));
  }
});

test('verifier rejects reordered or phase-divergent exact file evidence', () => {
  const reordered = validArtifact('linux');
  reordered.phases.initialRunningOwner.snapshot.files.reverse();
  assertRejected(reordered, 'linux', 'reordered initial files');

  const reorderedDirectories = validArtifact('linux');
  reorderedDirectories.phases.gracefulRestart.snapshot.namespaceDirectoryModes.reverse();
  assertRejected(reorderedDirectories, 'linux', 'reordered directories');

  const changedLength = validArtifact('linux');
  changedLength.phases.operatingSystemLeaseRecovery.snapshot.files[0].byteLength += 1;
  assertRejected(changedLength, 'linux', 'phase-divergent byte length');
});

function assertRejected(
  artifact: ReturnType<typeof validArtifact>,
  platform: NodeJS.Platform,
  label: string,
): void {
  assert.throws(
    () => verifyGate0ArtifactBytes(Buffer.from(stableJson(artifact)), HEAD, platform),
    undefined,
    `verifier accepted mutation: ${label}`,
  );
}

function validArtifact(platform: 'linux' | 'win32') {
  const posix = platform !== 'win32';
  const snapshot = () => ({
    counts: { objects: 1, signatures: 1 },
    inventoryFileMode: posix ? '0600' : null,
    leaseFileMode: posix ? '0600' : null,
    namespaceDirectoryModes: directoryPaths().map((relativePath) => ({
      relativePath,
      mode: posix ? '0700' : null,
    })),
    files: [
      {
        kind: 'object',
        relativePath: objectPath(),
        byteLength: 292,
        sha256: OBJECT_SHA256,
        mode: posix ? '0600' : null,
      },
      {
        kind: 'signature',
        relativePath: signaturePath(),
        byteLength: 326,
        sha256: SIGNATURE_SHA256,
        mode: posix ? '0600' : null,
      },
    ],
  });
  const contender = () => ({
    event: 'lease-probe',
    acquired: false,
    errorCode: 'database-busy',
  });
  return {
    schemaVersion: GATE0_RAW_SCHEMA_VERSION,
    gate: 'OT-RFC-64 Gate 0',
    productionBaselineCommit: HEAD,
    invocation: 'pnpm test:gate0:rfc64-persistence-lifecycle',
    repository: {
      testedHeadCommit: HEAD,
      trackedSourceCleanBeforeSpawn: true,
      trackedSourceCleanAfterProcesses: true,
    },
    filesystemSecurity: posix
      ? {
          platform,
          policy: 'posix-owner-only-mode-v1',
          requiredFileMode: '0600',
          requiredDirectoryMode: '0700',
        }
      : {
          platform: 'win32',
          policy: 'windows-protected-current-user-owner-only-full-control-v1',
          productionPolicyChecksPassed: true,
          inheritedAccessRulesAllowed: false,
          otherSidAllowRulesAllowed: false,
        },
    runtimeBoundary: {
      agentClass: 'DKGAgent',
      processModel: 'three independent production agent processes',
      controlChannel: 'stdio and POSIX process signals only',
      publicDebugEndpointAdded: false,
    },
    fixture: {
      objectDigest: OBJECT_DIGEST,
      signatureVariantDigest: SIGNATURE_DIGEST,
      objectFileSha256: OBJECT_SHA256,
      signatureFileSha256: SIGNATURE_SHA256,
    },
    phases: {
      initialRunningOwner: {
        agentStarted: true,
        inventoryOperational: true,
        persistenceClosed: false,
        staged: true,
        verifiedRead: true,
        namespaceDurability: posix
          ? 'posix-hardlink-no-replace-directory-fsync-v1'
          : 'windows-file-flush-hardlink-no-replace-v1',
        contender: contender(),
        snapshot: snapshot(),
      },
      gracefulRestart: {
        agentStarted: true,
        inventoryOperational: true,
        persistenceClosed: false,
        staged: false,
        priorExit: { code: 0, signal: null },
        verifiedRead: true,
        contender: contender(),
        exactContentFilesEqual: true,
        snapshot: snapshot(),
      },
      operatingSystemLeaseRecovery: {
        agentStarted: true,
        inventoryOperational: true,
        persistenceClosed: false,
        staged: false,
        uncleanExit: { code: null, signal: 'SIGKILL' },
        verifiedRead: true,
        contender: contender(),
        exactContentFilesEqual: true,
        finalGracefulExit: { code: 0, signal: null },
        snapshot: snapshot(),
      },
    },
    checks: {
      productionAgentStarted: true,
      inventoryOperationalWhileRunning: true,
      competingLeaseRejectedWhileRunning: true,
      gracefulRestartSucceeded: true,
      operatingSystemLeaseRecoveredAfterSigkill: true,
      durableControlObjectBytesPreserved: true,
      storedEnvelopeSignatureReverifiedOnEveryStart: true,
      exactObjectCount: 1,
      exactSignatureCount: 1,
      ownerOnlyFileModes: posix ? true : 'not-applicable',
      publicRuntimeDebugEndpointAdded: false,
    },
    harnessChecksPassed: true,
    gateEvaluation: {
      status: 'not-evaluated',
      reason: 'raw lifecycle evidence requires separate fail-closed verification',
    },
  };
}

function objectPath(): string {
  const objectHex = OBJECT_DIGEST.slice(2);
  return `rfc64-sync/control-objects-v1/objects/${objectHex.slice(0, 2)}/${objectHex}.jcs`;
}

function signaturePath(): string {
  const objectHex = OBJECT_DIGEST.slice(2);
  return `rfc64-sync/control-objects-v1/signatures/${objectHex.slice(0, 2)}/${objectHex}/${SIGNATURE_DIGEST.slice(2)}.jcs`;
}

function directoryPaths(): string[] {
  const objectHex = OBJECT_DIGEST.slice(2);
  const prefix = objectHex.slice(0, 2);
  return [
    'rfc64-sync',
    'rfc64-sync/control-objects-v1',
    'rfc64-sync/control-objects-v1/objects',
    `rfc64-sync/control-objects-v1/objects/${prefix}`,
    'rfc64-sync/control-objects-v1/signatures',
    `rfc64-sync/control-objects-v1/signatures/${prefix}`,
    `rfc64-sync/control-objects-v1/signatures/${prefix}/${objectHex}`,
  ];
}

function mutatedLeaf(value: unknown): unknown {
  if (value === null) return 'mutated-null';
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'string') return `${value}-mutated`;
  throw new Error(`Unexpected non-leaf mutation value: ${String(value)}`);
}

function collectLocations(root: unknown): {
  properties: JsonPath[];
  leaves: JsonPath[];
  objects: JsonPath[];
  arrays: JsonPath[];
} {
  const result = {
    properties: [] as JsonPath[],
    leaves: [] as JsonPath[],
    objects: [] as JsonPath[],
    arrays: [] as JsonPath[],
  };
  const visit = (value: unknown, path: JsonPath): void => {
    if (Array.isArray(value)) {
      result.arrays.push(path);
      value.forEach((nested, index) => visit(nested, [...path, index]));
      return;
    }
    if (value !== null && typeof value === 'object') {
      result.objects.push(path);
      for (const [key, nested] of Object.entries(value)) {
        const propertyPath = [...path, key];
        result.properties.push(propertyPath);
        visit(nested, propertyPath);
      }
      return;
    }
    result.leaves.push(path);
  };
  visit(root, []);
  return result;
}

function valueAt(root: unknown, path: JsonPath): unknown {
  let current = root;
  for (const key of path) {
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function formatPath(path: JsonPath): string {
  return path.length === 0 ? '$' : `$.${path.join('.')}`;
}
