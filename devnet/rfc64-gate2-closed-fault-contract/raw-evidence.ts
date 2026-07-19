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
 * RFC-64 Gate 2 "closed fault-contract" raw evidence document.
 *
 * This module is FIXTURES-ONLY. It synthesizes an in-process evidence document
 * modelling the cold late-join + multi-peer failover acceptance contract. It
 * never connects to, imports, or exercises product runtime. Every produced
 * document carries productBoundary:"not-connected" and gateEvaluation:
 * "not-evaluated" so it can never be read as a real Gate 2 product pass.
 */

export const GATE2_RAW_SCHEMA_VERSION =
  'dkg-rfc64-gate2-closed-fault-contract-raw-v1';
export const GATE2_CONTRACT = 'rfc64-gate2-closed-fault-contract-v1';
export const GATE2_PRODUCT_BOUNDARY = 'not-connected';
export const GATE2_GATE_EVALUATION = 'not-evaluated';
export const GATE2_GENERATED_BY = 'Klod';
export const GATE2_SOURCE_REVIEW =
  'urn:rfc64:coordination:review-summary:rfc64-reviewsummary-klod-gate2-latejoin-failover-20260719T175943Z';
export const GATE2_SOURCE_COMMIT = '9dda05edb0fc489da8b6990e2e605898eafe3f16';

/** Canonical deterministic digests (0x + 64 lowercase hex). */
const HEAD_DIGEST = `0x${'a1'.repeat(32)}`;
const POLICY_DIGEST = `0x${'b2'.repeat(32)}`;
const INVENTORY_SET_ROOT_DIGEST = `0x${'c3'.repeat(32)}`;
const CHAIN_MERKLE_ROOT = `0x${'d4'.repeat(32)}`;
const BUNDLE_ROOT = `0x${'e5'.repeat(32)}`;
const CHUNK_TREE_ROOT = `0x${'f6'.repeat(32)}`;
const RECONCILER_ID = `rfc64-reconciler-${'17'.repeat(32)}`;

/**
 * The canonical converged cardinality/row count shared across scenarios. The
 * verifier asserts these values AGREE with each other (cross-binding), not that
 * they equal any pinned literal.
 */
const CANONICAL_COUNT = 128;

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

export interface ReconcilerEvidence {
  readonly canonicalReconcilerId: string;
  readonly triggers: {
    readonly subscribe: string;
    readonly reconnect: string;
    readonly catchUp: string;
    readonly restart: string;
    readonly lateJoin: string;
  };
}

export interface ColdLateJoinScenario {
  readonly reconciler: ReconcilerEvidence;
  readonly pathA: {
    readonly watermark: number;
    readonly head: number;
    readonly producerKnowledgeAssetCount: number;
  };
  readonly pathB: { readonly synced: boolean };
  readonly head: number;
  readonly authoredCatalogCardinality: number;
  readonly rawEnumerationCount: number;
  readonly headDerivedFrom: string;
  readonly emptyStartMarker: {
    readonly startedEmpty: boolean;
    readonly observedInitialKaCount: number;
    readonly convergedToCanonicalParity: boolean;
    readonly authorSealsIncluded: boolean;
  };
  readonly authoredHeadDigest: string;
  readonly authoredRowSetCount: number;
  readonly policyDigest: string;
  readonly networkDurability: {
    readonly asserted: boolean;
    readonly eligibleHolderCount: number;
    readonly failureDomains: readonly string[];
    readonly signedUnexpiredHostingReceipts: number;
    readonly d22JournalPresent: boolean;
    readonly ingressAcceptedOnly: boolean;
  };
}

export interface MultiProviderFailoverScenario {
  readonly providerSwitch: {
    readonly priorProvider: string;
    readonly successorProvider: string;
    readonly totalChunks: number;
    readonly lastVerifiedChunkBoundaryOffset: number;
    readonly resumedAtOffset: number;
    readonly remainingChunksAfterSwitch: number;
    readonly refetchedEarlierChunks: boolean;
    readonly integrityVerifiedIndependentOfProvider: boolean;
  };
  readonly censorship: {
    readonly peerReturnedCleanEmpty: boolean;
    readonly backoffCleared: boolean;
    readonly flaggedViaCensorshipTelemetry: boolean;
  };
  readonly failoverLatency: {
    readonly perEndpointAttemptBudgetMs: number;
    readonly endpointAttempts: number;
    readonly totalFailoverBudgetMs: number;
    readonly observedDeadPeerReselectionMs: number;
    readonly measuredAgainst: string;
    readonly reconcilerBackoffMs: number;
    readonly withinBudget: boolean;
  };
}

export interface FreshCheckpointAuthorityFailoverScenario {
  readonly privateCgCuratorKill: {
    readonly curatorKilled: boolean;
    readonly overlappingLocatorHolderCount: number;
    readonly membersKeepServing: boolean;
    readonly fallbackState: string;
    readonly falseComplete: boolean;
    readonly silentStall: boolean;
  };
  readonly authorityFailover: {
    readonly passiveCanSignBeforePromotion: boolean;
    readonly oldCanSignAfterPromotion: boolean;
    readonly checkpointAcceptedBeforeQuorum: boolean;
    readonly journalQuorumReplicas: number;
    readonly distinctFailureDomains: number;
    readonly crashAfterQuorumRecoversExactClosure: boolean;
    readonly continuingHistories: number;
    readonly lastWriterWins: boolean;
    readonly freshnessOnAmbiguity: string;
    readonly checkpointAuthorityRole: string;
    readonly bulkPayloadServedBy: string;
    readonly healthierEligibleHolderAvailable: boolean;
  };
  readonly swmAdmission: {
    readonly acceptedOnlyAfterCommitByNamedCheckpoint: boolean;
    readonly namedCheckpointHeadDigest: string;
    readonly overloadShedMode: string;
    readonly shedReason: string;
    readonly maxQueueAgeBounded: boolean;
    readonly perPrincipalFairness: boolean;
  };
}

export interface AppliedSealAndPostReadsScenario {
  readonly appliedHeadDigest: string;
  readonly appliedRowCount: number;
  readonly inventorySetRoot: { readonly digest: string; readonly leafCount: number };
  readonly appliedInventoryReadback: {
    readonly matchesAuthoredCandidateSet: boolean;
    readonly authoredCandidateSetCount: number;
    readonly appliedSetCount: number;
    readonly forgedOrWrongAuthorRowsApplied: number;
  };
  readonly contentPromotion: {
    readonly recomputedContentRoot: string;
    readonly chainMerkleRoot: string;
    readonly bundleRoot: string;
    readonly chunkTreeRoot: string;
    readonly chunkProofsRecorded: boolean;
    readonly rootMatchInferred: boolean;
    readonly promoted: boolean;
  };
  readonly completion: {
    readonly status: string;
    readonly appliedSetRootMatch: boolean;
    readonly aggregateCgParity: boolean;
    readonly everyActiveSubgraphSealMatches: boolean;
    readonly independentlyDerivedChainCoverage: boolean;
    readonly runnableSqlCount: number;
    readonly postReadsFrozen: boolean;
    readonly swmContinuity: { readonly kind: string };
    readonly policyDigest: string;
    readonly watermark: number;
    readonly head: number;
  };
  readonly oracle: {
    readonly syncState: string;
    readonly freshnessState: string;
    readonly knownIncompleteReasons: readonly string[];
    readonly missingVmOrdinals: readonly number[];
    readonly networkDurabilitySummary: string;
  };
}

export interface WatermarkGapReportingScenario {
  readonly requestedOrdinal: number;
  readonly laterOrdinalsMaterialized: readonly number[];
  readonly missingVmOrdinals: readonly number[];
  readonly watermarkWedged: boolean;
  readonly selfHealedWhenOrdinalReturned: boolean;
  readonly head: number;
}

export interface ZeroEligibleTerminalOutcomeScenario {
  readonly eligibleProviderCount: number;
  readonly allDenied: boolean;
  readonly terminalState: string;
  readonly silentRetry: boolean;
  readonly emptySuccessReported: boolean;
  readonly observableTerminal: boolean;
}

export interface ProviderContinuationScenario {
  readonly checkpointExpiry: {
    readonly checkpointExpired: boolean;
    readonly openMode: {
      readonly freshnessState: string;
      readonly servesVerifiedBytes: boolean;
      readonly reportsFresh: boolean;
      readonly reportsComplete: boolean;
    };
    readonly inviteOnlyMode: {
      readonly refusesNewDisclosure: boolean;
      readonly refusesJoin: boolean;
      readonly refusesIngress: boolean;
    };
    readonly higherChainFrontierFlipsFreshness: boolean;
  };
  readonly ownershipTransfer: {
    readonly ownershipTransferred: boolean;
    readonly joinerAtFullParity: boolean;
    readonly freshnessState: string;
    readonly reportedAggregateComplete: boolean;
    readonly permanentUntilCertified: boolean;
  };
}

export interface CrashRestartScenario {
  readonly antiRollback: {
    readonly receiverHighWater: number;
    readonly failoverSuccessorHighWater: number;
    readonly rolledBackCheckpointHighWater: number;
    readonly rejectedAsAuthorityHistoryConflict: boolean;
    readonly wipedSqliteColdRestartAcceptedRolledBack: boolean;
  };
  readonly crashMidApply: {
    readonly appliedSealsPersisted: boolean;
    readonly retrySkipsVerifiedRows: boolean;
    readonly doubleApplied: boolean;
    readonly falseComplete: boolean;
    readonly verifiedRowsSkippedCount: number;
    readonly appliedRowCount: number;
  };
}

export interface Gate2RawEvidence {
  readonly schemaVersion: string;
  readonly contract: string;
  readonly productBoundary: string;
  readonly gateEvaluation: string;
  readonly generatedBy: string;
  readonly sourceReview: string;
  readonly sourceCommit: string;
  readonly coldLateJoin: ColdLateJoinScenario;
  readonly multiProviderFailover: MultiProviderFailoverScenario;
  readonly freshCheckpointAuthorityFailover: FreshCheckpointAuthorityFailoverScenario;
  readonly appliedSealAndPostReads: AppliedSealAndPostReadsScenario;
  readonly watermarkGapReporting: WatermarkGapReportingScenario;
  readonly zeroEligibleTerminalOutcome: ZeroEligibleTerminalOutcomeScenario;
  readonly providerContinuation: ProviderContinuationScenario;
  readonly crashRestart: CrashRestartScenario;
}

/**
 * Build the deterministic golden Gate 2 raw evidence fixture. Returns a fresh
 * object graph on every call so callers may mutate a clone without leaking.
 */
export function buildGate2RawEvidence(): Gate2RawEvidence {
  return {
    schemaVersion: GATE2_RAW_SCHEMA_VERSION,
    contract: GATE2_CONTRACT,
    productBoundary: GATE2_PRODUCT_BOUNDARY,
    gateEvaluation: GATE2_GATE_EVALUATION,
    generatedBy: GATE2_GENERATED_BY,
    sourceReview: GATE2_SOURCE_REVIEW,
    sourceCommit: GATE2_SOURCE_COMMIT,
    coldLateJoin: {
      reconciler: {
        canonicalReconcilerId: RECONCILER_ID,
        triggers: {
          subscribe: RECONCILER_ID,
          reconnect: RECONCILER_ID,
          catchUp: RECONCILER_ID,
          restart: RECONCILER_ID,
          lateJoin: RECONCILER_ID,
        },
      },
      pathA: {
        watermark: CANONICAL_COUNT,
        head: CANONICAL_COUNT,
        producerKnowledgeAssetCount: CANONICAL_COUNT,
      },
      pathB: { synced: true },
      head: CANONICAL_COUNT,
      authoredCatalogCardinality: CANONICAL_COUNT,
      rawEnumerationCount: CANONICAL_COUNT,
      headDerivedFrom: 'authored-catalog-cardinality',
      emptyStartMarker: {
        startedEmpty: true,
        observedInitialKaCount: 0,
        convergedToCanonicalParity: true,
        authorSealsIncluded: true,
      },
      authoredHeadDigest: HEAD_DIGEST,
      authoredRowSetCount: CANONICAL_COUNT,
      policyDigest: POLICY_DIGEST,
      networkDurability: {
        asserted: true,
        eligibleHolderCount: 2,
        failureDomains: ['failure-domain-a', 'failure-domain-b'],
        signedUnexpiredHostingReceipts: 2,
        d22JournalPresent: true,
        ingressAcceptedOnly: false,
      },
    },
    multiProviderFailover: {
      providerSwitch: {
        priorProvider: 'provider-a',
        successorProvider: 'provider-b',
        totalChunks: 64,
        lastVerifiedChunkBoundaryOffset: 48,
        resumedAtOffset: 48,
        remainingChunksAfterSwitch: 16,
        refetchedEarlierChunks: false,
        integrityVerifiedIndependentOfProvider: true,
      },
      censorship: {
        peerReturnedCleanEmpty: true,
        backoffCleared: false,
        flaggedViaCensorshipTelemetry: true,
      },
      failoverLatency: {
        perEndpointAttemptBudgetMs: 4000,
        endpointAttempts: 3,
        totalFailoverBudgetMs: 12000,
        observedDeadPeerReselectionMs: 3200,
        measuredAgainst: 'observed-dead-peer-reselection',
        reconcilerBackoffMs: 300000,
        withinBudget: true,
      },
    },
    freshCheckpointAuthorityFailover: {
      privateCgCuratorKill: {
        curatorKilled: true,
        overlappingLocatorHolderCount: 2,
        membersKeepServing: true,
        fallbackState: 'serving',
        falseComplete: false,
        silentStall: false,
      },
      authorityFailover: {
        passiveCanSignBeforePromotion: false,
        oldCanSignAfterPromotion: false,
        checkpointAcceptedBeforeQuorum: false,
        journalQuorumReplicas: 2,
        distinctFailureDomains: 2,
        crashAfterQuorumRecoversExactClosure: true,
        continuingHistories: 1,
        lastWriterWins: false,
        freshnessOnAmbiguity: 'unknown-freshness',
        checkpointAuthorityRole: 'control-plane-only',
        bulkPayloadServedBy: 'eligible-holder',
        healthierEligibleHolderAvailable: true,
      },
      swmAdmission: {
        acceptedOnlyAfterCommitByNamedCheckpoint: true,
        namedCheckpointHeadDigest: HEAD_DIGEST,
        overloadShedMode: 'queued-or-rejected',
        shedReason: 'deterministic-frozen-reason:queue-capacity-exceeded',
        maxQueueAgeBounded: true,
        perPrincipalFairness: true,
      },
    },
    appliedSealAndPostReads: {
      appliedHeadDigest: HEAD_DIGEST,
      appliedRowCount: CANONICAL_COUNT,
      inventorySetRoot: { digest: INVENTORY_SET_ROOT_DIGEST, leafCount: CANONICAL_COUNT },
      appliedInventoryReadback: {
        matchesAuthoredCandidateSet: true,
        authoredCandidateSetCount: CANONICAL_COUNT,
        appliedSetCount: CANONICAL_COUNT,
        forgedOrWrongAuthorRowsApplied: 0,
      },
      contentPromotion: {
        recomputedContentRoot: CHAIN_MERKLE_ROOT,
        chainMerkleRoot: CHAIN_MERKLE_ROOT,
        bundleRoot: BUNDLE_ROOT,
        chunkTreeRoot: CHUNK_TREE_ROOT,
        chunkProofsRecorded: true,
        rootMatchInferred: false,
        promoted: true,
      },
      completion: {
        status: 'complete',
        appliedSetRootMatch: true,
        aggregateCgParity: true,
        everyActiveSubgraphSealMatches: true,
        independentlyDerivedChainCoverage: true,
        runnableSqlCount: 0,
        postReadsFrozen: true,
        swmContinuity: { kind: 'initial-owner-lineage' },
        policyDigest: POLICY_DIGEST,
        watermark: CANONICAL_COUNT,
        head: CANONICAL_COUNT,
      },
      oracle: {
        syncState: 'complete',
        freshnessState: 'fresh',
        knownIncompleteReasons: [],
        missingVmOrdinals: [],
        networkDurabilitySummary: 'network-durable',
      },
    },
    watermarkGapReporting: {
      requestedOrdinal: 42,
      laterOrdinalsMaterialized: [43, 44, 45],
      missingVmOrdinals: [42],
      watermarkWedged: false,
      selfHealedWhenOrdinalReturned: true,
      head: CANONICAL_COUNT,
    },
    zeroEligibleTerminalOutcome: {
      eligibleProviderCount: 0,
      allDenied: true,
      terminalState: 'known-incomplete:no-authorized-provider',
      silentRetry: false,
      emptySuccessReported: false,
      observableTerminal: true,
    },
    providerContinuation: {
      checkpointExpiry: {
        checkpointExpired: true,
        openMode: {
          freshnessState: 'unknown-freshness',
          servesVerifiedBytes: true,
          reportsFresh: false,
          reportsComplete: false,
        },
        inviteOnlyMode: {
          refusesNewDisclosure: true,
          refusesJoin: true,
          refusesIngress: true,
        },
        higherChainFrontierFlipsFreshness: true,
      },
      ownershipTransfer: {
        ownershipTransferred: true,
        joinerAtFullParity: true,
        freshnessState: 'unknown-freshness:ownership-swm-continuity-uncertified',
        reportedAggregateComplete: false,
        permanentUntilCertified: true,
      },
    },
    crashRestart: {
      antiRollback: {
        receiverHighWater: 130,
        failoverSuccessorHighWater: 128,
        rolledBackCheckpointHighWater: 126,
        rejectedAsAuthorityHistoryConflict: true,
        wipedSqliteColdRestartAcceptedRolledBack: false,
      },
      crashMidApply: {
        appliedSealsPersisted: true,
        retrySkipsVerifiedRows: true,
        doubleApplied: false,
        falseComplete: false,
        verifiedRowsSkippedCount: 48,
        appliedRowCount: CANONICAL_COUNT,
      },
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
      throw new Error('Published Gate 2 artifact bytes did not match the fsynced temp file');
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
