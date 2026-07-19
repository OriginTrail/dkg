import type { WalObjectV1 } from '../protocol/wal-object.js';

export type WalObjectOrigin = 'LOCAL' | 'REMOTE' | 'GENESIS' | 'SNAPSHOT';
export type IdempotencyStatus = 'COMMITTED' | 'MATERIALIZATION_PENDING' | 'MATERIALIZED';
export type AdmissionState = 'STAGED' | 'ADMITTED' | 'BLOCKED' | 'QUARANTINED';
export type RetryState = 'READY' | 'LEASED' | 'BLOCKED';

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
  logicalKey: Uint8Array;
  desiredHeadsDigest: Uint8Array;
  desiredStateDigest: Uint8Array;
  appliedHeadsDigest?: Uint8Array | null;
  appliedStateDigest?: Uint8Array | null;
  status: 'PENDING' | 'APPLIED' | 'BLOCKED';
  attempts: number;
  retryAtMs: number;
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
