import type { WalObjectV1 } from '../protocol/wal-object.js';
import type { WalEip191Signer } from '../protocol/signatures.js';

export type WalObjectOrigin = 'LOCAL' | 'REMOTE' | 'GENESIS' | 'SNAPSHOT';
export type IdempotencyStatus = 'COMMITTED' | 'MATERIALIZATION_PENDING' | 'MATERIALIZED';
export type AdmissionState = 'STAGED' | 'ADMITTED' | 'BLOCKED' | 'QUARANTINED';
export type RetryState = 'READY' | 'LEASED' | 'BLOCKED';
export type LocalCommitWorkState = 'PENDING' | 'QUEUED' | 'MATERIALIZED' | 'BLOCKED';

export interface AdmissionRecord {
  objectId: Uint8Array;
  state: AdmissionState;
  proofBytes: Uint8Array | null;
  closureBytes: Uint8Array | null;
  providerPeerId: Uint8Array | null;
  reasonCode: string | null;
  updatedAtMs: number;
}

export interface WalObjectMetadataRecord {
  objectId: Uint8Array;
  namespaceId: Uint8Array;
  writerId: Uint8Array;
  writerEpoch: bigint;
  sequence: bigint;
  previousObjectId: Uint8Array | null;
  payloadLength: number;
  canonicalLength: number;
  origin: WalObjectOrigin;
  admittedAtMs: number;
}

export interface QuarantineRecord {
  entryId: Uint8Array;
  providerPeerId: Uint8Array;
  reasonCode: string;
  relativePath: string | null;
  byteLength: number;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface FinalizeLocalWalInput {
  objectId: Uint8Array;
  object: WalObjectV1;
  canonicalLength: number;
  checkpointId: Uint8Array;
  checkpointBytes: Uint8Array;
  idempotencyKey: string;
  requestDigest: Uint8Array;
  status?: IdempotencyStatus;
  policyObjectId?: Uint8Array | null;
  createdAtMs?: number;
}

export interface FinalizeLocalWalResult {
  status: 'committed' | 'already-committed';
  objectId: Uint8Array;
  checkpointId: Uint8Array;
  objectSetRoot: Uint8Array;
  objectCount: bigint;
  sequence: bigint;
}

/**
 * Complete local authoring input. Canonical adapter plaintext must already be
 * compiled before this call. Public payload bytes are fully encoded up front;
 * only a private sequence-bound envelope may be finalized in the locked lane.
 * Sequence allocation and both signatures happen while that lane is locked.
 */
export interface CommitLocalWalInput {
  namespaceId: Uint8Array;
  writerId: Uint8Array;
  writerEpoch: bigint;
  /** Complete public payload bytes, frozen before the author lane is acquired. */
  payloadBytes?: Uint8Array;
  /**
   * Sequence-bound envelope finalizer for private payloads. The canonical
   * plaintext adapter content must already exist before commitLocal is called.
   * This synchronous callback may only finalize local bytes (including a
   * nonce claim); it must perform no network, RDF-store, or semantic work.
   */
  buildPayloadBytes?: (coordinates: LocalWalPayloadCoordinates) => Uint8Array;
  signer: WalEip191Signer;
  idempotencyKey: string;
  requestDigest: Uint8Array;
  status?: IdempotencyStatus;
  policyObjectId?: Uint8Array | null;
  /** `self` binds an epoch-zero snapshot checkpoint to the object being authored. */
  baselineSnapshotObjectId?: Uint8Array | null | 'self';
  compactionFloor?: bigint;
  maximumObjectBytes?: bigint;
  /** Present for DkgMutationV1; persisted as the post-commit recovery outbox. */
  logicalKey?: Uint8Array;
  /** Exact local logical-key heads used to compile this mutation. */
  baseHeads?: readonly Uint8Array[];
  createdAtMs?: number;
}

export interface LocalWalPayloadCoordinates {
  readonly namespaceId: Uint8Array;
  readonly writerId: Uint8Array;
  readonly writerEpoch: bigint;
  readonly sequence: bigint;
  readonly previousObjectId: Uint8Array | null;
}

export interface LocalCommitWorkRecord {
  objectId: Uint8Array;
  namespaceId: Uint8Array;
  logicalKey: Uint8Array;
  state: LocalCommitWorkState;
  lastError: string | null;
  updatedAtMs: number;
}

export interface RollbackHighWater {
  collectionId: Uint8Array;
  vectorEpoch: bigint;
  vectorNumber: bigint;
  vectorId: Uint8Array;
  updatedAtMs: number;
}

export interface RollbackProtectionStatus {
  state: 'available' | 'blocked';
  reason?: string;
}

export interface RetryQueueEntry {
  key: string;
  kind: string;
  payload: Uint8Array;
  priority: number;
  attempts: number;
  maximumAttempts: number;
  availableAtMs: number;
  leaseUntilMs: number | null;
  state: RetryState;
  lastError: string | null;
}

export interface WalControlIntegrity {
  state: 'complete' | 'blocked';
  reasons: readonly string[];
  objects: number;
  checkpoints: number;
  queued: number;
  quarantinedBytes: number;
}

export interface ObjectRangeRecord {
  objectId: Uint8Array;
  offset: number;
  length: number;
  totalLength: number;
  relativePath: string;
  providerPeerId?: Uint8Array | null;
  receivedAtMs: number;
  expiresAtMs: number;
}

export interface IbltCacheRecord {
  headId: Uint8Array;
  reconciliationSeed: Uint8Array;
  firstSymbolIndex: bigint;
  symbolCount: number;
  canonicalBytes: Uint8Array;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface ClaimPrivatePayloadNonceInput {
  namespaceId: Uint8Array;
  writerId: Uint8Array;
  writerEpoch: bigint;
  sequence: bigint;
  keyEpoch: bigint;
  nonce: Uint8Array;
  claimedAtMs?: number;
}

export interface VectorRecord {
  vectorId: Uint8Array;
  collectionId: Uint8Array;
  vectorEpoch: bigint;
  vectorNumber: bigint;
  canonicalBytes: Uint8Array;
  status: 'VERIFIED' | 'CURRENT' | 'EXPIRED' | 'REVOKED';
  expiresAtMs: number;
  createdAtMs: number;
}

export interface MaterializationRecord {
  namespaceId: Uint8Array;
  logicalKey: Uint8Array;
  desiredHeadsDigest: Uint8Array;
  desiredConflictHeadsDigest: Uint8Array;
  desiredStateDigest: Uint8Array;
  sourceVectorId: Uint8Array;
  appliedHeadsDigest?: Uint8Array | null;
  appliedConflictHeadsDigest?: Uint8Array | null;
  appliedStateDigest?: Uint8Array | null;
  status: 'PENDING' | 'APPLIED' | 'BLOCKED';
  attempts: number;
  retryAtMs: number;
  lastError?: string | null;
  updatedAtMs: number;
}

export interface PeerStateRecord {
  peerId: Uint8Array;
  successCount: number;
  failureCount: number;
  backoffUntilMs: number;
  availabilityHint?: Uint8Array | null;
  updatedAtMs: number;
}

export interface GcQueueRecord {
  targetId: Uint8Array;
  relativePath: string;
  byteLength: number;
  eligibleAtMs: number;
  state?: 'PENDING' | 'BLOCKED';
  createdAtMs: number;
}

export type RetentionEpochState =
  | 'INSTALLED'
  | 'VECTOR_BOUND'
  | 'GC_ELIGIBLE'
  | 'GC_COMPLETE';

export interface RetentionEpochRecord {
  snapshotObjectId: Uint8Array;
  namespaceId: Uint8Array;
  writerId: Uint8Array;
  coveredWriterEpoch: bigint;
  newWriterEpoch: bigint;
  coveredCheckpointId: Uint8Array;
  compactionFloor: bigint;
  graceStartedAtMs: number;
  graceEndsAtMs: number;
  vectorId: Uint8Array | null;
  state: RetentionEpochState;
  updatedAtMs: number;
}

export interface InstallRetentionEpochInput {
  snapshotObjectId: Uint8Array;
  namespaceId: Uint8Array;
  writerId: Uint8Array;
  coveredWriterEpoch: bigint;
  newWriterEpoch: bigint;
  coveredCheckpointId: Uint8Array;
  compactionFloor: bigint;
  graceStartedAtMs: number;
  graceEndsAtMs: number;
  updatedAtMs: number;
}

export interface RetentionCustodyReceiptRecord {
  receiptId: Uint8Array;
  snapshotObjectId: Uint8Array;
  custodianAgentAddress: Uint8Array;
  custodianPeerId: Uint8Array;
  membershipCheckpointId: Uint8Array;
  canonicalBytes: Uint8Array;
  expiresAtMs: number;
  recordedAtMs: number;
}

export interface RetentionGcObjectRecord {
  snapshotObjectId: Uint8Array;
  objectId: Uint8Array;
  state: 'ELIGIBLE' | 'RETIRED';
  updatedAtMs: number;
}
