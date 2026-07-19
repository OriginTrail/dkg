import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';

/**
 * RFC-64 Gate 3 "cold late-join" raw evidence document.
 *
 * This module is FIXTURES-ONLY. It synthesizes an in-process evidence document
 * modelling the cold late-join acceptance contract (a receiver that starts from
 * an EMPTY store, with NO prior live announcement, discovers the authenticated
 * current head, bootstraps its predecessors within a declared bound, converges
 * EXACTLY to the publisher's inventory, survives a restart without refetching,
 * and leaves state unchanged when handed an invalidly-authorized head).
 *
 * It never connects to, imports, or exercises product runtime. Every produced
 * document carries productBoundary:"not-connected" and gateEvaluation:
 * "not-evaluated" so it can never be read as a real Gate 3 product pass.
 */

export const GATE3_RAW_SCHEMA_VERSION =
  'dkg-rfc64-gate3-cold-late-join-raw-v1';
export const GATE3_CONTRACT = 'rfc64-gate3-cold-late-join-v1';
export const GATE3_PRODUCT_BOUNDARY = 'not-connected';
export const GATE3_GATE_EVALUATION = 'not-evaluated';
export const GATE3_GENERATED_BY = 'Klod';
export const GATE3_SOURCE_REVIEW =
  'urn:rfc64:coordination:review-summary:rfc64-reviewsummary-klod-gate2-latejoin-failover-20260719T175943Z';
export const GATE3_SOURCE_COMMIT = '1bb183f8b8bf75bea9ed3b696831a3d920011716';

/**
 * The canonical converged cardinality shared across scenarios. The verifier
 * asserts these values AGREE with each other (cross-binding), not that they
 * equal any pinned literal. It equals the modelled row-digest array length.
 */
const CANONICAL_ROW_COUNT = 8;

/** Canonical deterministic digests (0x + 64 lowercase hex). */
const HEAD_DIGEST = `0x${'a1'.repeat(32)}`;
const INVENTORY_SET_ROOT_DIGEST = `0x${'c3'.repeat(32)}`;
const SIGNATURE_DIGEST = `0x${'b2'.repeat(32)}`;
const INVALID_HEAD_DIGEST = `0x${'de'.repeat(32)}`;
const HEAD_AUTHORITY_ID = `rfc64-head-authority-${'17'.repeat(32)}`;

/** A single deterministic 0x + 64 lowercase-hex digest keyed by a byte value. */
function digestForByte(byteValue: number): string {
  return `0x${byteValue.toString(16).padStart(2, '0').repeat(32)}`;
}

/** Publisher/receiver cold-start eras + ISO timestamps (strictly ordered). */
const PUBLISHER_CATALOG_SEALED_AT = '2026-07-19T10:00:00.000Z';
const PUBLISHER_CATALOG_SEALED_AT_ERA = 1000;
const RECEIVER_STARTED_AT = '2026-07-19T12:00:00.000Z';
const RECEIVER_STARTED_AT_ERA = 2000;

export interface AtomicArtifactWriteResult {
  readonly sha256: string;
  readonly durability:
    | 'posix-file-fsync-rename-directory-fsync-v1'
    | 'windows-file-fsync-rename-topology-validated-v1';
}

interface DirectoryIdentity {
  readonly realPath: string;
  readonly device: string;
  readonly inode: string;
}

/**
 * The receiver joins cold: no live announcement was consumed, discovery is
 * pull-driven, and the store began empty.
 */
export interface NoPriorAnnouncementScenario {
  readonly liveAnnouncementConsumed: boolean;
  readonly discoveryMode: string;
  readonly dependsOnOriginalAnnounce: boolean;
  readonly emptyStartMarker: boolean;
  readonly initialAppliedInventoryCount: number;
  readonly receiverStartedAt: string;
  readonly receiverStartedAtEra: number;
}

/**
 * The receiver discovers the authenticated CURRENT head (not a stale/superseded
 * one), verifies its authorization, and applies it.
 */
export interface AuthenticatedCurrentHeadDiscoveryScenario {
  readonly discoveredHeadDigest: string;
  readonly headApplied: boolean;
  readonly headIsCurrent: boolean;
  readonly frontierHeadDigest: string;
  readonly supersededCandidateDigests: readonly string[];
  readonly headAuthorization: {
    readonly verified: boolean;
    readonly authorityId: string;
    readonly signatureDigest: string;
  };
}

/** Predecessor bootstrap terminates within a finite, positive declared bound. */
export interface BoundedPredecessorBootstrapScenario {
  readonly predecessorBootstrapSteps: number;
  readonly declaredBound: number;
  readonly boundIsFinite: boolean;
  readonly walkTerminatedWithinBound: boolean;
  readonly predecessorChainDigests: readonly string[];
}

/**
 * The receiver converges EXACTLY to the publisher's authored inventory: same
 * inventory-set root, same row count, same row digests, no missing/extra/dup.
 */
export interface ExactConvergenceScenario {
  readonly publisher: {
    readonly authoredHeadDigest: string;
    readonly inventorySetRoot: string;
    readonly authoredRowCount: number;
    readonly catalogSealedAt: string;
    readonly catalogSealedAtEra: number;
  };
  readonly receiver: {
    readonly appliedHeadDigest: string;
    readonly inventorySetRoot: string;
    readonly appliedRowCount: number;
  };
  readonly inventoryLeafCount: number;
  readonly authoredRowDigests: readonly string[];
  readonly appliedRowDigests: readonly string[];
  readonly missingRowCount: number;
  readonly extraRowCount: number;
  readonly duplicateRowCount: number;
}

/** A restart preserves convergence: no refetch-from-zero, roots unchanged. */
export interface ReceiverRestartScenario {
  readonly restartCount: number;
  readonly appliedInventorySetRoot: string;
  readonly appliedRowCount: number;
  readonly appliedHeadDigest: string;
  readonly refetchedFromZero: boolean;
  readonly convergenceHeld: boolean;
}

/**
 * An invalidly-authorized discovered head is fail-closed: zero rows applied
 * from it and the post-state root is byte-identical to the pre-state root.
 */
export interface AuthorizationNegativeUnchangedScenario {
  readonly invalidHeadDigest: string;
  readonly invalidHeadAuthorizationVerified: boolean;
  readonly rowsAppliedFromInvalidHead: number;
  readonly preStateRoot: string;
  readonly postStateRoot: string;
  readonly stateUnchanged: boolean;
  readonly rejectedRowDigests: readonly string[];
}

export interface Gate3RawEvidence {
  readonly schemaVersion: string;
  readonly contract: string;
  readonly productBoundary: string;
  readonly gateEvaluation: string;
  readonly generatedBy: string;
  readonly sourceReview: string;
  readonly sourceCommit: string;
  readonly noPriorAnnouncement: NoPriorAnnouncementScenario;
  readonly authenticatedCurrentHeadDiscovery: AuthenticatedCurrentHeadDiscoveryScenario;
  readonly boundedPredecessorBootstrap: BoundedPredecessorBootstrapScenario;
  readonly exactConvergence: ExactConvergenceScenario;
  readonly receiverRestart: ReceiverRestartScenario;
  readonly authorizationNegativeUnchanged: AuthorizationNegativeUnchangedScenario;
}

/**
 * Build the deterministic golden Gate 3 raw evidence fixture. Returns a fresh
 * object graph on every call so callers may mutate a clone without leaking.
 */
export function buildGate3RawEvidence(): Gate3RawEvidence {
  const rowDigests = Array.from({ length: CANONICAL_ROW_COUNT }, (_, index) =>
    digestForByte(0x20 + index),
  );
  const predecessorChainDigests = Array.from({ length: 3 }, (_, index) =>
    digestForByte(0x40 + index),
  );
  const rejectedRowDigests = Array.from({ length: 2 }, (_, index) =>
    digestForByte(0x60 + index),
  );

  return {
    schemaVersion: GATE3_RAW_SCHEMA_VERSION,
    contract: GATE3_CONTRACT,
    productBoundary: GATE3_PRODUCT_BOUNDARY,
    gateEvaluation: GATE3_GATE_EVALUATION,
    generatedBy: GATE3_GENERATED_BY,
    sourceReview: GATE3_SOURCE_REVIEW,
    sourceCommit: GATE3_SOURCE_COMMIT,
    noPriorAnnouncement: {
      liveAnnouncementConsumed: false,
      discoveryMode: 'pull-driven-from-cold',
      dependsOnOriginalAnnounce: false,
      emptyStartMarker: true,
      initialAppliedInventoryCount: 0,
      receiverStartedAt: RECEIVER_STARTED_AT,
      receiverStartedAtEra: RECEIVER_STARTED_AT_ERA,
    },
    authenticatedCurrentHeadDiscovery: {
      discoveredHeadDigest: HEAD_DIGEST,
      headApplied: true,
      headIsCurrent: true,
      frontierHeadDigest: HEAD_DIGEST,
      supersededCandidateDigests: [],
      headAuthorization: {
        verified: true,
        authorityId: HEAD_AUTHORITY_ID,
        signatureDigest: SIGNATURE_DIGEST,
      },
    },
    boundedPredecessorBootstrap: {
      predecessorBootstrapSteps: 3,
      declaredBound: 16,
      boundIsFinite: true,
      walkTerminatedWithinBound: true,
      predecessorChainDigests,
    },
    exactConvergence: {
      publisher: {
        authoredHeadDigest: HEAD_DIGEST,
        inventorySetRoot: INVENTORY_SET_ROOT_DIGEST,
        authoredRowCount: CANONICAL_ROW_COUNT,
        catalogSealedAt: PUBLISHER_CATALOG_SEALED_AT,
        catalogSealedAtEra: PUBLISHER_CATALOG_SEALED_AT_ERA,
      },
      receiver: {
        appliedHeadDigest: HEAD_DIGEST,
        inventorySetRoot: INVENTORY_SET_ROOT_DIGEST,
        appliedRowCount: CANONICAL_ROW_COUNT,
      },
      inventoryLeafCount: CANONICAL_ROW_COUNT,
      authoredRowDigests: rowDigests,
      appliedRowDigests: [...rowDigests],
      missingRowCount: 0,
      extraRowCount: 0,
      duplicateRowCount: 0,
    },
    receiverRestart: {
      restartCount: 1,
      appliedInventorySetRoot: INVENTORY_SET_ROOT_DIGEST,
      appliedRowCount: CANONICAL_ROW_COUNT,
      appliedHeadDigest: HEAD_DIGEST,
      refetchedFromZero: false,
      convergenceHeld: true,
    },
    authorizationNegativeUnchanged: {
      invalidHeadDigest: INVALID_HEAD_DIGEST,
      invalidHeadAuthorizationVerified: false,
      rowsAppliedFromInvalidHead: 0,
      preStateRoot: INVENTORY_SET_ROOT_DIGEST,
      postStateRoot: INVENTORY_SET_ROOT_DIGEST,
      stateUnchanged: true,
      rejectedRowDigests,
    },
  };
}

export function stableJson(value: unknown): string {
  const normalized = normalizePlainJsonValue(value, '$', new WeakSet<object>());
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function atomicWriteStableJson(
  artifactPathInput: string,
  value: unknown,
): AtomicArtifactWriteResult {
  const artifactPath = resolve(artifactPathInput);
  const parentPath = dirname(artifactPath);
  mkdirSync(parentPath, { recursive: true, mode: 0o700 });
  const parentIdentity = inspectDirectory(parentPath, 'artifact parent directory');
  assertReplaceableArtifactTarget(artifactPath);

  const bytes = Buffer.from(stableJson(value), 'utf8');
  const intendedSha256 = sha256Hex(bytes);
  const tempPath = resolve(
    parentPath,
    `.${basename(artifactPath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let fileDescriptor: number | null = null;
  let renamed = false;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    fileDescriptor = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    fchmodSync(fileDescriptor, 0o600);
    writeAll(fileDescriptor, bytes);
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = null;

    assertSameDirectory(parentPath, parentIdentity);
    assertRegularOwnerOnlyFile(tempPath, 'artifact sibling temp file');
    assertReplaceableArtifactTarget(artifactPath);
    renameSync(tempPath, artifactPath);
    renamed = true;

    assertSameDirectory(parentPath, parentIdentity);
    assertRegularOwnerOnlyFile(artifactPath, 'published artifact');
    const durability = fsyncArtifactParent(parentPath);
    assertSameDirectory(parentPath, parentIdentity);

    const publishedBytes = readFileSync(artifactPath);
    const publishedSha256 = sha256Hex(publishedBytes);
    if (!publishedBytes.equals(bytes) || publishedSha256 !== intendedSha256) {
      throw new Error('Published Gate 3 artifact bytes did not match the fsynced temp file');
    }
    return { sha256: publishedSha256, durability };
  } finally {
    if (fileDescriptor !== null) closeSync(fileDescriptor);
    if (!renamed) rmSync(tempPath, { force: true });
  }
}

function normalizePlainJsonValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`${path} contains a non-lossless JSON number`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} contains unsupported ${typeof value}`);
  }
  if (seen.has(value)) {
    throw new TypeError(`${path} repeats or cycles an object reference`);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(`${path} is not a plain array`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new TypeError(`${path} has a symbol-keyed array property`);
    }
    const expectedKeys = new Set<string>(['length']);
    for (let index = 0; index < value.length; index += 1) {
      expectedKeys.add(String(index));
    }
    if (
      ownKeys.length !== expectedKeys.size
      || ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))
    ) {
      throw new TypeError(`${path} is sparse or has non-index array properties`);
    }
    return value.map((_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${path}[${index}] is not an enumerable data property`);
      }
      return normalizePlainJsonValue(descriptor.value, `${path}[${index}]`, seen);
    });
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} is not a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new TypeError(`${path} has a symbol-keyed object property`);
  }
  const entries = ownKeys
    .map((key): readonly [string, unknown] => {
      if (typeof key !== 'string') throw new TypeError(`${path} has an invalid key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${path}.${key} is not an enumerable data property`);
      }
      return [key, normalizePlainJsonValue(descriptor.value, `${path}.${key}`, seen)];
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries);
}

function inspectDirectory(path: string, label: string): DirectoryIdentity {
  const topology = lstatSync(path);
  if (topology.isSymbolicLink() || !topology.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory: ${path}`);
  }
  const identity = statSync(path, { bigint: true });
  return {
    realPath: realpathSync.native(path),
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
  };
}

function assertSameDirectory(path: string, expected: DirectoryIdentity): void {
  const actual = inspectDirectory(path, 'artifact parent directory');
  if (
    actual.realPath !== expected.realPath
    || actual.device !== expected.device
    || actual.inode !== expected.inode
  ) {
    throw new Error(`Artifact parent directory topology changed during publication: ${path}`);
  }
}

function assertReplaceableArtifactTarget(path: string): void {
  try {
    const topology = lstatSync(path);
    if (topology.isSymbolicLink() || !topology.isFile()) {
      throw new Error(`Artifact target must be absent or a non-symlink regular file: ${path}`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

function assertRegularOwnerOnlyFile(path: string, label: string): void {
  const topology = lstatSync(path);
  if (topology.isSymbolicLink() || !topology.isFile()) {
    throw new Error(`${label} must be a non-symlink regular file: ${path}`);
  }
  if (process.platform !== 'win32' && (topology.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must have mode 0600: ${path}`);
  }
}

function writeAll(fileDescriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(
      fileDescriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (written <= 0) throw new Error('Artifact sibling temp write made no progress');
    offset += written;
  }
}

function fsyncArtifactParent(
  parentPath: string,
): AtomicArtifactWriteResult['durability'] {
  if (process.platform === 'win32') {
    return 'windows-file-fsync-rename-topology-validated-v1';
  }
  const directoryDescriptor = openSync(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
  return 'posix-file-fsync-rename-directory-fsync-v1';
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
