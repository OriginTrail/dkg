import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { encodeCanonicalCbor } from '../protocol/canonical-cbor.js';
import { decodeProtocolTuple, encodeProtocolTuple } from '../protocol/codec.js';
import { protocolTupleId } from '../protocol/hashes.js';
import { signSingleProtocolTuple, verifySingleSignedProtocolTuple } from '../protocol/signatures.js';
import type { ProtocolTuple } from '../protocol/schema.js';
import { createWalObjectV1, type WalObjectV1 } from '../protocol/wal-object.js';
import { walObjectId } from '../reconciliation/ids.js';
import { MutableSetCommitment } from '../reconciliation/set-commitment.js';
import {
  PACKED_DEFAULT_SEGMENT_TARGET_BYTES,
  PACKED_HARD_MAXIMUM_OBJECT_BYTES,
  PackedObjectTransactionAppend,
  PACKED_GC_SCHEMA_SQL,
  packedWriteMutexFor,
} from '../store/packed-transaction.js';
import { controlError, WalControlStoreError } from './errors.js';
import { blobU64, bytesEqual, fixedBytes, MAX_U64, safeInteger, u64Blob } from './integers.js';
import {
  WAL_CONTROL_SCHEMA_SQL,
  WAL_CONTROL_SCHEMA_VERSION,
  WAL_CONTROL_MIGRATION_1_TO_2_SQL,
  WAL_CONTROL_MIGRATION_2_TO_3_SQL,
  WAL_CONTROL_MIGRATION_3_TO_4_SQL,
  WAL_CONTROL_MIGRATION_4_TO_5_SQL,
  WAL_CONTROL_MIGRATION_5_TO_6_SQL,
  WAL_CONTROL_MIGRATION_6_TO_7_SQL,
  WAL_ROLLBACK_SCHEMA_SQL,
  WAL_ROLLBACK_SCHEMA_VERSION,
} from './schema.js';
import type {
  AdmissionState,
  AdmissionRecord,
  ClaimPrivatePayloadNonceInput,
  CommitLocalWalInput,
  FinalizeLocalWalInput,
  FinalizeLocalWalResult,
  GcQueueRecord,
  IbltCacheRecord,
  LocalCommitWorkRecord,
  LocalCommitWorkState,
  MaterializationRecord,
  ObjectRangeRecord,
  PeerStateRecord,
  QuarantineRecord,
  RetryState,
  RetryQueueEntry,
  RollbackHighWater,
  RollbackProtectionStatus,
  InstallRetentionEpochInput,
  RetentionCustodyReceiptRecord,
  RetentionEpochRecord,
  RetentionEpochState,
  RetentionGcObjectRecord,
  VectorRecord,
  WalControlIntegrity,
  WalObjectMetadataRecord,
  WalObjectOrigin,
} from './types.js';

const EMPTY_NODE_KEY = Buffer.alloc(0);
const DEFAULT_MAXIMUM_QUEUE_ENTRIES = 100_000;
const DEFAULT_MAXIMUM_QUEUE_BYTES = 256 * 1_048_576;
const DEFAULT_MAXIMUM_QUARANTINE_ENTRIES_PER_PEER = 10_000;
const DEFAULT_MAXIMUM_QUARANTINE_BYTES_PER_PEER = 256 * 1_048_576;
const DEFAULT_QUARANTINE_RETENTION_MS = 24 * 60 * 60 * 1_000;

interface IdempotencyRow {
  request_digest: Buffer;
  object_id: Buffer;
  checkpoint_id: Buffer;
  object_set_root: Buffer;
  object_count: Buffer;
  sequence: Buffer;
}

interface LaneRow {
  next_sequence: Buffer;
  next_checkpoint_number: Buffer;
  previous_object_id: Buffer | null;
  current_checkpoint_id: Buffer;
  current_set_root: Buffer;
  object_count: Buffer;
}

interface RootNodeRow { node_bytes: Buffer; object_count: Buffer }
interface CountRow { count: number; bytes?: number | null }
interface GuardRow { guard_id: Buffer }
interface VersionRow { version: number }
interface IntegrityRow { quick_check: string }
interface MaterializationRow {
  namespace_id: Buffer;
  logical_key: Buffer;
  desired_heads_digest: Buffer;
  desired_conflict_heads_digest: Buffer;
  desired_state_digest: Buffer;
  source_vector_id: Buffer;
  applied_heads_digest: Buffer | null;
  applied_conflict_heads_digest: Buffer | null;
  applied_state_digest: Buffer | null;
  status: MaterializationRecord['status'];
  attempts: number;
  retry_at_ms: number;
  last_error: string | null;
  updated_at_ms: number;
}

interface RetentionEpochRow {
  snapshot_object_id: Buffer;
  namespace_id: Buffer;
  writer_id: Buffer;
  covered_writer_epoch: Buffer;
  new_writer_epoch: Buffer;
  covered_checkpoint_id: Buffer;
  compaction_floor: Buffer;
  grace_started_at_ms: number;
  grace_ends_at_ms: number;
  vector_id: Buffer | null;
  state: RetentionEpochState;
  updated_at_ms: number;
}

interface RetentionReceiptRow {
  receipt_id: Buffer;
  snapshot_object_id: Buffer;
  custodian_agent_address: Buffer;
  custodian_peer_id: Buffer;
  membership_checkpoint_id: Buffer;
  canonical_bytes: Buffer;
  expires_at_ms: number;
  recorded_at_ms: number;
}

export type WalControlTransactionPoint =
  | 'after-object-file-sync'
  | 'after-packed-index-insert'
  | 'after-object-insert'
  | 'after-set-update'
  | 'after-checkpoint-insert'
  | 'after-local-work-insert'
  | 'after-remote-object-insert'
  | 'after-remote-object-admit'
  | 'after-replay-enqueue'
  | 'after-quarantine-insert'
  | 'after-quarantine-state'
  | 'after-retention-snapshot-install'
  | 'after-retention-receipt-persist'
  | 'after-retention-vector-bind'
  | 'after-retention-floor-advance'
  | 'after-retention-gc-complete'
  | 'before-commit'
  | 'after-commit'
  | 'after-rollback';

export interface WalControlStoreOptions {
  root: string;
  busyTimeoutMs?: number;
  segmentTargetBytes?: number;
  maximumObjectBytes?: bigint;
  maximumQueueEntries?: number;
  maximumQueueBytes?: number;
  maximumQuarantineEntriesPerPeer?: number;
  maximumQuarantineBytesPerPeer?: number;
  quarantineRetentionMs?: number;
  now?: () => number;
  transactionHook?: (point: WalControlTransactionPoint) => void | Promise<void>;
  migrationHook?: () => void;
}

export interface StageAdmissionInput {
  objectId: Uint8Array;
  providerPeerId?: Uint8Array | null;
  proofBytes?: Uint8Array | null;
  closureBytes?: Uint8Array | null;
  updatedAtMs?: number;
}

export interface AdmitRemoteObjectInput {
  objectId: Uint8Array;
  object: WalObjectV1;
  canonicalLength: number;
  origin?: Exclude<WalObjectOrigin, 'LOCAL'>;
  logicalKeys?: readonly Uint8Array[];
}

export interface EnqueueRetryInput {
  key: string;
  kind: string;
  payload: Uint8Array;
  priority?: number;
  maximumAttempts?: number;
  availableAtMs?: number;
}

export interface QuarantineInput {
  entryId: Uint8Array;
  providerPeerId: Uint8Array;
  reasonCode: string;
  relativePath?: string | null;
  byteLength: number;
  createdAtMs?: number;
  expiresAtMs?: number;
}

export interface QuarantineAdmissionInput extends QuarantineInput {
  /** Defaults to entryId; kept explicit for malformed bytes whose claimed ID is quarantined. */
  admissionObjectId?: Uint8Array;
  /** When a dependency is quarantined, atomically block the root that referenced it. */
  blockedRootObjectId?: Uint8Array | null;
  updatedAtMs?: number;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertRegularFile(path: string, name: string): void {
  let details;
  try {
    details = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', `${name} does not exist`);
    }
    return controlError('WAL_CONTROL_IO', `failed to inspect ${name}`, error);
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    controlError('WAL_CONTROL_PATH_UNSAFE', `${name} must be a regular file`);
  }
}

function nowValue(now: () => number): number {
  return safeInteger(now(), 'current time');
}

function assertText(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) {
    controlError('WAL_CONTROL_INVALID_CONFIGURATION', `${name} must contain 1..1024 characters`);
  }
  return value;
}

function assertRelativePath(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value.length === 0 || value.includes('\0') || isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    controlError('WAL_CONTROL_PATH_UNSAFE', 'control-state paths must be non-empty relative paths without traversal');
  }
  return value;
}

function copy(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function materializationRecord(row: MaterializationRow): MaterializationRecord {
  return {
    namespaceId: copy(row.namespace_id),
    logicalKey: copy(row.logical_key),
    desiredHeadsDigest: copy(row.desired_heads_digest),
    desiredConflictHeadsDigest: copy(row.desired_conflict_heads_digest),
    desiredStateDigest: copy(row.desired_state_digest),
    sourceVectorId: copy(row.source_vector_id),
    appliedHeadsDigest: row.applied_heads_digest === null ? null : copy(row.applied_heads_digest),
    appliedConflictHeadsDigest: row.applied_conflict_heads_digest === null
      ? null
      : copy(row.applied_conflict_heads_digest),
    appliedStateDigest: row.applied_state_digest === null ? null : copy(row.applied_state_digest),
    status: row.status,
    attempts: row.attempts,
    retryAtMs: row.retry_at_ms,
    lastError: row.last_error,
    updatedAtMs: row.updated_at_ms,
  };
}

function decodeCheckpoint(bytes: Uint8Array): ProtocolTuple<'AuthorCheckpointV1'> {
  const checkpoint = decodeProtocolTuple('AuthorCheckpointV1', bytes);
  verifySingleSignedProtocolTuple('AuthorCheckpointV1', checkpoint);
  return checkpoint;
}

function verifyObjectMetadata(
  objectId: Uint8Array,
  object: WalObjectV1,
  canonicalLength: number,
): { id: Buffer; namespace: Buffer; writer: Buffer; epoch: Buffer; sequence: Buffer; previous: Buffer | null } {
  verifySingleSignedProtocolTuple('WalObjectV1', object);
  const computed = protocolTupleId('WalObjectV1', object);
  if (!bytesEqual(computed, objectId)) controlError('WAL_CONTROL_CORRUPT', 'WalObject metadata ID does not match its tuple');
  const canonical = encodeProtocolTuple('WalObjectV1', object);
  if (safeInteger(canonicalLength, 'canonicalLength', 1) !== canonical.length) {
    controlError('WAL_CONTROL_CORRUPT', 'WalObject canonical length does not match its tuple');
  }
  return {
    id: fixedBytes(objectId, 32, 'objectId'),
    namespace: fixedBytes(object[1], 32, 'namespaceId'),
    writer: fixedBytes(object[2], 20, 'writerId'),
    epoch: u64Blob(object[3], 'writerEpoch'),
    sequence: u64Blob(object[4], 'sequence'),
    previous: object[5] === null ? null : fixedBytes(object[5], 32, 'previousObjectId'),
  };
}

export class WalControlStore {
  readonly root: string;
  readonly indexPath: string;
  readonly segmentsRoot: string;
  readonly rollbackPath: string;
  readonly segmentTargetBytes: number;
  readonly maximumObjectBytes: bigint;
  readonly maximumQueueEntries: number;
  readonly maximumQueueBytes: number;
  readonly maximumQuarantineEntriesPerPeer: number;
  readonly maximumQuarantineBytesPerPeer: number;
  readonly quarantineRetentionMs: number;
  private readonly database!: Database.Database;
  private rollbackDatabase?: Database.Database;
  private readonly mutex: ReturnType<typeof packedWriteMutexFor>;
  private readonly now: () => number;
  private readonly busyTimeoutMs: number;
  private readonly transactionHook?: WalControlStoreOptions['transactionHook'];
  private blockedReason?: string;
  private closed = false;

  constructor(options: WalControlStoreOptions) {
    if (typeof options?.root !== 'string' || options.root.trim().length === 0 || !isAbsolute(options.root)) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'WalControlStore root must be an absolute path');
    }
    this.root = resolve(options.root);
    this.indexPath = join(this.root, 'objects.sqlite');
    this.segmentsRoot = join(this.root, 'segments');
    this.rollbackPath = join(this.root, 'rollback-high-water.sqlite');
    this.segmentTargetBytes = safeInteger(
      options.segmentTargetBytes ?? PACKED_DEFAULT_SEGMENT_TARGET_BYTES,
      'segmentTargetBytes',
      128,
    );
    this.maximumObjectBytes = options.maximumObjectBytes ?? 1_073_741_824n;
    if (this.maximumObjectBytes < 1n || this.maximumObjectBytes > PACKED_HARD_MAXIMUM_OBJECT_BYTES) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'maximumObjectBytes must be within the WAL v1 hard limit');
    }
    this.maximumQueueEntries = safeInteger(
      options.maximumQueueEntries ?? DEFAULT_MAXIMUM_QUEUE_ENTRIES,
      'maximumQueueEntries',
      1,
    );
    this.maximumQueueBytes = safeInteger(
      options.maximumQueueBytes ?? DEFAULT_MAXIMUM_QUEUE_BYTES,
      'maximumQueueBytes',
      1,
    );
    this.maximumQuarantineEntriesPerPeer = safeInteger(
      options.maximumQuarantineEntriesPerPeer ?? DEFAULT_MAXIMUM_QUARANTINE_ENTRIES_PER_PEER,
      'maximumQuarantineEntriesPerPeer',
      1,
    );
    this.maximumQuarantineBytesPerPeer = safeInteger(
      options.maximumQuarantineBytesPerPeer ?? DEFAULT_MAXIMUM_QUARANTINE_BYTES_PER_PEER,
      'maximumQuarantineBytesPerPeer',
      1,
    );
    this.quarantineRetentionMs = safeInteger(
      options.quarantineRetentionMs ?? DEFAULT_QUARANTINE_RETENTION_MS,
      'quarantineRetentionMs',
      1,
    );
    const busyTimeoutMs = safeInteger(options.busyTimeoutMs ?? 30_000, 'busyTimeoutMs', 1);
    this.busyTimeoutMs = busyTimeoutMs;
    this.now = options.now ?? Date.now;
    this.transactionHook = options.transactionHook;
    this.mutex = packedWriteMutexFor(this.root);
    assertRegularFile(this.indexPath, 'packed object index');
    let opened: Database.Database | undefined;
    try {
      opened = new Database(this.indexPath);
      this.database = opened;
      this.database.pragma(`busy_timeout = ${busyTimeoutMs}`);
      this.database.pragma('foreign_keys = ON');
      this.database.pragma('journal_mode = WAL');
      this.database.pragma('synchronous = FULL');
      this.assertPackedSchema();
      this.migrate(options.migrationHook);
      this.openRollbackDatabase(busyTimeoutMs);
      this.recoverQueues(nowValue(this.now));
    } catch (error) {
      this.rollbackDatabase?.close();
      opened?.close();
      if (error instanceof WalControlStoreError) throw error;
      return controlError('WAL_CONTROL_IO', 'failed to open WalControlStore', error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rollbackDatabase?.close();
    this.database.close();
  }

  /**
   * Allocate, sign, append, index, checkpoint, and idempotently acknowledge one
   * complete local WalObjectV1 in a single SQLite transaction. Public inline
   * payload bytes are copied before the writer mutex. A private payload builder
   * may only finalize sequence-bound encryption after allocation and claim its
   * nonce in this same transaction; it performs no network, RDF-store, or
   * semantic work.
   */
  async commitLocal(input: CommitLocalWalInput): Promise<FinalizeLocalWalResult> {
    this.assertUsable();
    const namespace = fixedBytes(input.namespaceId, 32, 'namespaceId');
    const writer = fixedBytes(input.writerId, 20, 'writerId');
    const epoch = u64Blob(input.writerEpoch, 'writerEpoch');
    const hasPayloadBytes = input.payloadBytes instanceof Uint8Array;
    const hasPayloadBuilder = typeof input.buildPayloadBytes === 'function';
    if (hasPayloadBytes === hasPayloadBuilder) {
      controlError(
        'WAL_CONTROL_INVALID_CONFIGURATION',
        'exactly one of payloadBytes or buildPayloadBytes is required',
      );
    }
    // Public bytes are frozen before waiting on the author/packed lane. A
    // private envelope cannot be finalized until the lane sequence is known;
    // its callback is invoked synchronously below after allocation.
    const frozenPayloadBytes = hasPayloadBytes ? copy(input.payloadBytes!) : null;
    const requestDigest = fixedBytes(input.requestDigest, 32, 'requestDigest');
    const key = assertText(input.idempotencyKey, 'idempotencyKey');
    const policyObjectId = input.policyObjectId === undefined || input.policyObjectId === null
      ? null
      : fixedBytes(input.policyObjectId, 32, 'policyObjectId');
    const baselineInput = input.baselineSnapshotObjectId;
    const baselineIsSelf = baselineInput === 'self';
    const baseline = typeof baselineInput === 'string' || baselineInput === undefined || baselineInput === null
      ? null
      : fixedBytes(baselineInput, 32, 'baselineSnapshotObjectId');
    const compactionFloor = input.compactionFloor ?? 0n;
    u64Blob(compactionFloor, 'compactionFloor');
    const createdAtMs = input.createdAtMs === undefined
      ? nowValue(this.now)
      : safeInteger(input.createdAtMs, 'createdAtMs');
    const status = input.status ?? 'MATERIALIZATION_PENDING';
    const maximumObjectBytes = input.maximumObjectBytes ?? this.maximumObjectBytes;
    if (maximumObjectBytes < 1n || maximumObjectBytes > this.maximumObjectBytes) {
      controlError(
        'WAL_CONTROL_INVALID_CONFIGURATION',
        'maximumObjectBytes must be positive and no greater than the configured packed-store limit',
      );
    }
    const logicalKey = input.logicalKey === undefined
      ? null
      : fixedBytes(input.logicalKey, 32, 'logicalKey');
    const baseHeads = (input.baseHeads ?? [])
      .map((head, index) => Buffer.from(fixedBytes(head, 32, `baseHeads[${index}]`)))
      .sort(Buffer.compare);
    for (let index = 1; index < baseHeads.length; index += 1) {
      if (bytesEqual(baseHeads[index - 1]!, baseHeads[index]!)) {
        controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'baseHeads contains a duplicate object ID');
      }
    }
    if (logicalKey === null && baseHeads.length > 0) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'baseHeads requires a logicalKey');
    }

    return this.mutex.run(async () => {
      const readExisting = (): FinalizeLocalWalResult | null => {
        const existing = this.database.prepare(`
          SELECT i.request_digest, i.object_id, i.checkpoint_id,
                 c.object_set_root, c.object_count, w.sequence
          FROM idempotency i
          JOIN checkpoints c ON c.checkpoint_id = i.checkpoint_id
          JOIN wal_objects w ON w.object_id = i.object_id
          WHERE i.namespace_id = ? AND i.writer_id = ? AND i.idempotency_key = ?
        `).get(namespace, writer, key) as IdempotencyRow | undefined;
        if (existing === undefined) return null;
        if (!bytesEqual(existing.request_digest, requestDigest)) {
          controlError('WAL_CONTROL_IDEMPOTENCY_CONFLICT', 'idempotency key was already used with another request digest');
        }
        return {
          status: 'already-committed',
          objectId: copy(existing.object_id),
          checkpointId: copy(existing.checkpoint_id),
          objectSetRoot: copy(existing.object_set_root),
          objectCount: blobU64(existing.object_count, 'idempotency object count'),
          sequence: blobU64(existing.sequence, 'idempotency sequence'),
        };
      };

      const existing = readExisting();
      if (existing !== null) return existing;

      this.database.exec('BEGIN IMMEDIATE');
      let append: PackedObjectTransactionAppend | undefined;
      let committed = false;
      try {
        // A second process can commit between the optimistic read and BEGIN.
        const concurrent = readExisting();
        if (concurrent !== null) {
          this.database.exec('COMMIT');
          committed = true;
          return concurrent;
        }

        if (logicalKey !== null) {
          const currentHeads = this.database.prepare(`
            SELECT object_id FROM local_logical_heads
            WHERE namespace_id = ? AND logical_key = ? ORDER BY object_id
          `).all(namespace, logicalKey) as Array<{ object_id: Buffer }>;
          if (
            currentHeads.length !== baseHeads.length
            || currentHeads.some((row, index) => !bytesEqual(row.object_id, baseHeads[index]!))
          ) {
            controlError(
              'WAL_CONTROL_STALE_BASE',
              'logical-key heads changed after accepted-outcome encoding',
            );
          }
        }

        const lane = this.database.prepare(`
          SELECT next_sequence, next_checkpoint_number, previous_object_id,
                 current_checkpoint_id, current_set_root, object_count
          FROM author_lanes WHERE namespace_id = ? AND writer_id = ? AND writer_epoch = ?
        `).get(namespace, writer, epoch) as LaneRow | undefined;
        const sequence = lane === undefined ? 0n : blobU64(lane.next_sequence, 'lane next sequence');
        const checkpointNumber = lane === undefined
          ? 0n
          : blobU64(lane.next_checkpoint_number, 'lane next checkpoint number');
        if (sequence === MAX_U64 || checkpointNumber === MAX_U64) {
          controlError('WAL_CONTROL_LIMIT_EXCEEDED', 'author lane exhausted protocol u64 sequence space');
        }

        let payloadBytes: Uint8Array;
        if (frozenPayloadBytes !== null) {
          payloadBytes = frozenPayloadBytes;
        } else {
          const built = input.buildPayloadBytes!({
            namespaceId: copy(namespace),
            writerId: copy(writer),
            writerEpoch: input.writerEpoch,
            sequence,
            previousObjectId: lane?.previous_object_id == null
              ? null
              : copy(lane.previous_object_id),
          });
          if (!(built instanceof Uint8Array)) {
            controlError(
              'WAL_CONTROL_INVALID_CONFIGURATION',
              'buildPayloadBytes must synchronously return complete encoded bytes',
            );
          }
          payloadBytes = copy(built);
        }

        const authored = await createWalObjectV1([
          1n,
          namespace,
          writer,
          input.writerEpoch,
          sequence,
          lane?.previous_object_id ?? null,
          payloadBytes,
        ], input.signer);
        if (BigInt(authored.canonicalBytes.length) > maximumObjectBytes) {
          controlError('WAL_CONTROL_LIMIT_EXCEEDED', 'complete signed WalObjectV1 exceeds its byte limit');
        }
        const metadata = verifyObjectMetadata(
          authored.walObjectId,
          authored.tuple,
          authored.canonicalBytes.length,
        );
        if (baselineIsSelf && sequence !== 0n) {
          controlError(
            'WAL_CONTROL_INVALID_CONFIGURATION',
            'self snapshot baseline is valid only for sequence zero of a new author epoch',
          );
        }
        const checkpointBaseline = baselineIsSelf ? metadata.id : baseline;
        const commitment = lane === undefined
          ? new MutableSetCommitment()
          : this.restoreCommitment(namespace, writer, epoch, lane.current_set_root);
        commitment.insert(metadata.id as never);
        const root = commitment.root;
        const count = BigInt(commitment.size);

        const checkpoint = await signSingleProtocolTuple('AuthorCheckpointV1', [
          1n,
          namespace,
          writer,
          input.writerEpoch,
          checkpointNumber,
          1n,
          root,
          count,
          sequence,
          lane?.current_checkpoint_id ?? null,
          checkpointBaseline,
          compactionFloor,
        ], input.signer);
        const checkpointBytes = encodeProtocolTuple('AuthorCheckpointV1', checkpoint);
        const checkpointId = protocolTupleId('AuthorCheckpointV1', checkpoint);

        append = new PackedObjectTransactionAppend({
          database: this.database,
          segmentsRoot: this.segmentsRoot,
          id: walObjectId(authored.walObjectId),
          source: { kind: 'bytes', bytes: authored.canonicalBytes },
          segmentTargetBytes: this.segmentTargetBytes,
          forceNewSegment: baselineIsSelf,
          hook: async point => {
            await this.transactionHook?.(
              point === 'segment-file-synced' ? 'after-object-file-sync' : 'after-packed-index-insert',
            );
          },
        });
        await append.append();

        this.database.prepare(`
          INSERT INTO wal_objects(
            object_id, namespace_id, writer_id, writer_epoch, sequence,
            previous_object_id, payload_length, canonical_length, origin, admitted_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          metadata.id,
          namespace,
          writer,
          epoch,
          metadata.sequence,
          metadata.previous,
          payloadBytes.length,
          authored.canonicalBytes.length,
          baselineIsSelf ? 'SNAPSHOT' : 'LOCAL',
          createdAtMs,
        );
        await this.transactionHook?.('after-object-insert');

        this.database.prepare(`
          INSERT INTO set_commitment_nodes(
            namespace_id, writer_id, writer_epoch, root_hash, node_key,
            node_bytes, object_count, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          namespace,
          writer,
          epoch,
          Buffer.from(root),
          EMPTY_NODE_KEY,
          Buffer.from(commitment.serialize()),
          u64Blob(count, 'objectCount'),
          createdAtMs,
        );
        await this.transactionHook?.('after-set-update');

        this.database.prepare(`
          INSERT INTO checkpoints(
            checkpoint_id, canonical_bytes, namespace_id, writer_id, writer_epoch,
            checkpoint_number, object_set_root, root_node_key, object_count,
            max_sequence, compaction_floor, tip_object_id, previous_checkpoint_id,
            policy_object_id, baseline_snapshot_object_id, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          checkpointId,
          checkpointBytes,
          namespace,
          writer,
          epoch,
          u64Blob(checkpointNumber, 'checkpointNumber'),
          Buffer.from(root),
          EMPTY_NODE_KEY,
          u64Blob(count, 'objectCount'),
          u64Blob(sequence, 'maxSequence'),
          u64Blob(compactionFloor, 'compactionFloor'),
          metadata.id,
          lane?.current_checkpoint_id ?? null,
          policyObjectId,
          checkpointBaseline,
          createdAtMs,
        );
        await this.transactionHook?.('after-checkpoint-insert');

        this.database.prepare(`
          INSERT INTO author_lanes(
            namespace_id, writer_id, writer_epoch, next_sequence,
            next_checkpoint_number, previous_object_id, current_checkpoint_id,
            current_set_root, root_node_key, object_count, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(namespace_id, writer_id, writer_epoch) DO UPDATE SET
            next_sequence = excluded.next_sequence,
            next_checkpoint_number = excluded.next_checkpoint_number,
            previous_object_id = excluded.previous_object_id,
            current_checkpoint_id = excluded.current_checkpoint_id,
            current_set_root = excluded.current_set_root,
            root_node_key = excluded.root_node_key,
            object_count = excluded.object_count,
            updated_at_ms = excluded.updated_at_ms
        `).run(
          namespace,
          writer,
          epoch,
          u64Blob(sequence + 1n, 'nextSequence'),
          u64Blob(checkpointNumber + 1n, 'nextCheckpointNumber'),
          metadata.id,
          checkpointId,
          Buffer.from(root),
          EMPTY_NODE_KEY,
          u64Blob(count, 'objectCount'),
          createdAtMs,
        );
        this.database.prepare(`
          INSERT INTO idempotency(
            namespace_id, writer_id, idempotency_key, request_digest,
            object_id, checkpoint_id, status, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          namespace,
          writer,
          key,
          requestDigest,
          metadata.id,
          checkpointId,
          status,
          createdAtMs,
        );
        if (logicalKey !== null) {
          this.database.prepare(`
            INSERT INTO local_commit_work(
              object_id, namespace_id, logical_key, state, last_error, updated_at_ms
            ) VALUES (?, ?, ?, 'PENDING', NULL, ?)
          `).run(metadata.id, namespace, logicalKey, createdAtMs);
          this.database.prepare(`
            DELETE FROM local_logical_heads WHERE namespace_id = ? AND logical_key = ?
          `).run(namespace, logicalKey);
          this.database.prepare(`
            INSERT INTO local_logical_heads(namespace_id, logical_key, object_id) VALUES (?, ?, ?)
          `).run(namespace, logicalKey, metadata.id);
          await this.transactionHook?.('after-local-work-insert');
        }
        await this.transactionHook?.('before-commit');
        this.database.exec('COMMIT');
        committed = true;
        append.markCommitted();
        await this.transactionHook?.('after-commit');
        return {
          status: 'committed',
          objectId: copy(metadata.id),
          checkpointId: copy(checkpointId),
          objectSetRoot: copy(root),
          objectCount: count,
          sequence,
        };
      } catch (error) {
        if (!committed && this.database.inTransaction) this.database.exec('ROLLBACK');
        if (!committed) append?.rollback();
        if (!committed) await this.transactionHook?.('after-rollback');
        if (error instanceof WalControlStoreError) throw error;
        if (committed) throw error;
        return this.wrapIo('failed to commit complete local WAL object', error);
      }
    });
  }

  async finalizeLocal(input: FinalizeLocalWalInput): Promise<FinalizeLocalWalResult> {
    this.assertUsable();
    const metadata = verifyObjectMetadata(input.objectId, input.object, input.canonicalLength);
    const requestDigest = fixedBytes(input.requestDigest, 32, 'requestDigest');
    const key = assertText(input.idempotencyKey, 'idempotencyKey');
    const checkpointBytes = Buffer.from(input.checkpointBytes);
    const checkpoint = decodeCheckpoint(checkpointBytes);
    const computedCheckpointId = protocolTupleId('AuthorCheckpointV1', checkpoint);
    if (!bytesEqual(computedCheckpointId, input.checkpointId)) {
      controlError('WAL_CONTROL_CORRUPT', 'checkpoint ID does not match its canonical tuple');
    }
    const checkpointId = fixedBytes(input.checkpointId, 32, 'checkpointId');
    const policyObjectId = input.policyObjectId === undefined || input.policyObjectId === null
      ? null
      : fixedBytes(input.policyObjectId, 32, 'policyObjectId');
    const createdAtMs = input.createdAtMs === undefined ? nowValue(this.now) : safeInteger(input.createdAtMs, 'createdAtMs');
    const status = input.status ?? 'COMMITTED';

    return this.mutex.run(async () => {
      const existing = this.database.prepare(`
        SELECT i.request_digest, i.object_id, i.checkpoint_id,
               c.object_set_root, c.object_count, w.sequence
        FROM idempotency i
        JOIN checkpoints c ON c.checkpoint_id = i.checkpoint_id
        JOIN wal_objects w ON w.object_id = i.object_id
        WHERE i.namespace_id = ? AND i.writer_id = ? AND i.idempotency_key = ?
      `).get(metadata.namespace, metadata.writer, key) as IdempotencyRow | undefined;
      if (existing !== undefined) {
        if (!bytesEqual(existing.request_digest, requestDigest)) {
          controlError('WAL_CONTROL_IDEMPOTENCY_CONFLICT', 'idempotency key was already used with another request digest');
        }
        return {
          status: 'already-committed',
          objectId: copy(existing.object_id),
          checkpointId: copy(existing.checkpoint_id),
          objectSetRoot: copy(existing.object_set_root),
          objectCount: blobU64(existing.object_count, 'idempotency object count'),
          sequence: blobU64(existing.sequence, 'idempotency sequence'),
        };
      }

      this.database.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const physical = this.database.prepare('SELECT object_length FROM objects WHERE object_id = ?').get(metadata.id) as
          { object_length: number } | undefined;
        if (physical === undefined || physical.object_length !== input.canonicalLength) {
          controlError('WAL_CONTROL_NOT_FOUND', 'complete packed WalObject bytes are not durably present');
        }
        const lane = this.database.prepare(`
          SELECT next_sequence, next_checkpoint_number, previous_object_id,
                 current_checkpoint_id, current_set_root, object_count
          FROM author_lanes WHERE namespace_id = ? AND writer_id = ? AND writer_epoch = ?
        `).get(metadata.namespace, metadata.writer, metadata.epoch) as LaneRow | undefined;
        const expectedSequence = lane === undefined ? 0n : blobU64(lane.next_sequence, 'lane next sequence');
        const expectedCheckpointNumber = lane === undefined
          ? 0n
          : blobU64(lane.next_checkpoint_number, 'lane next checkpoint number');
        const expectedPrevious = lane?.previous_object_id ?? null;
        if (input.object[4] !== expectedSequence || !bytesEqual(input.object[5], expectedPrevious)) {
          controlError('WAL_CONTROL_LANE_CONFLICT', 'WalObject sequence or previous-object link does not match the lane');
        }
        if (expectedSequence === MAX_U64 || expectedCheckpointNumber === MAX_U64) {
          controlError('WAL_CONTROL_LIMIT_EXCEEDED', 'author lane exhausted protocol u64 sequence space');
        }
        const commitment = lane === undefined
          ? new MutableSetCommitment()
          : this.restoreCommitment(metadata.namespace, metadata.writer, metadata.epoch, lane.current_set_root);
        commitment.insert(metadata.id as never);
        const root = commitment.root;
        const count = BigInt(commitment.size);

        if (
          !bytesEqual(checkpoint[1], metadata.namespace)
          || !bytesEqual(checkpoint[2], metadata.writer)
          || checkpoint[3] !== input.object[3]
          || checkpoint[4] !== expectedCheckpointNumber
          || !bytesEqual(checkpoint[6], root)
          || checkpoint[7] !== count
          || checkpoint[8] !== expectedSequence
          || !bytesEqual(checkpoint[9], lane?.current_checkpoint_id ?? null)
        ) {
          controlError('WAL_CONTROL_LANE_CONFLICT', 'checkpoint does not finalize the exact next author-lane state');
        }

        this.database.prepare(`
          INSERT INTO wal_objects(
            object_id, namespace_id, writer_id, writer_epoch, sequence,
            previous_object_id, payload_length, canonical_length, origin, admitted_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'LOCAL', ?)
        `).run(
          metadata.id,
          metadata.namespace,
          metadata.writer,
          metadata.epoch,
          metadata.sequence,
          metadata.previous,
          input.object[6].length,
          input.canonicalLength,
          createdAtMs,
        );
        await this.transactionHook?.('after-object-insert');

        this.database.prepare(`
          INSERT INTO set_commitment_nodes(
            namespace_id, writer_id, writer_epoch, root_hash, node_key,
            node_bytes, object_count, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          metadata.namespace,
          metadata.writer,
          metadata.epoch,
          Buffer.from(root),
          EMPTY_NODE_KEY,
          Buffer.from(commitment.serialize()),
          u64Blob(count, 'objectCount'),
          createdAtMs,
        );
        await this.transactionHook?.('after-set-update');

        const baseline = checkpoint[10] === null ? null : fixedBytes(checkpoint[10], 32, 'baselineSnapshotObjectId');
        this.database.prepare(`
          INSERT INTO checkpoints(
            checkpoint_id, canonical_bytes, namespace_id, writer_id, writer_epoch,
            checkpoint_number, object_set_root, root_node_key, object_count,
            max_sequence, compaction_floor, tip_object_id, previous_checkpoint_id,
            policy_object_id, baseline_snapshot_object_id, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          checkpointId,
          checkpointBytes,
          metadata.namespace,
          metadata.writer,
          metadata.epoch,
          u64Blob(checkpoint[4], 'checkpointNumber'),
          Buffer.from(root),
          EMPTY_NODE_KEY,
          u64Blob(count, 'objectCount'),
          u64Blob(expectedSequence, 'maxSequence'),
          u64Blob(checkpoint[11], 'compactionFloor'),
          metadata.id,
          lane?.current_checkpoint_id ?? null,
          policyObjectId,
          baseline,
          createdAtMs,
        );
        await this.transactionHook?.('after-checkpoint-insert');

        this.database.prepare(`
          INSERT INTO author_lanes(
            namespace_id, writer_id, writer_epoch, next_sequence,
            next_checkpoint_number, previous_object_id, current_checkpoint_id,
            current_set_root, root_node_key, object_count, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(namespace_id, writer_id, writer_epoch) DO UPDATE SET
            next_sequence = excluded.next_sequence,
            next_checkpoint_number = excluded.next_checkpoint_number,
            previous_object_id = excluded.previous_object_id,
            current_checkpoint_id = excluded.current_checkpoint_id,
            current_set_root = excluded.current_set_root,
            root_node_key = excluded.root_node_key,
            object_count = excluded.object_count,
            updated_at_ms = excluded.updated_at_ms
        `).run(
          metadata.namespace,
          metadata.writer,
          metadata.epoch,
          u64Blob(expectedSequence + 1n, 'nextSequence'),
          u64Blob(expectedCheckpointNumber + 1n, 'nextCheckpointNumber'),
          metadata.id,
          checkpointId,
          Buffer.from(root),
          EMPTY_NODE_KEY,
          u64Blob(count, 'objectCount'),
          createdAtMs,
        );
        this.database.prepare(`
          INSERT INTO idempotency(
            namespace_id, writer_id, idempotency_key, request_digest,
            object_id, checkpoint_id, status, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          metadata.namespace,
          metadata.writer,
          key,
          requestDigest,
          metadata.id,
          checkpointId,
          status,
          createdAtMs,
        );
        await this.transactionHook?.('before-commit');
        this.database.exec('COMMIT');
        committed = true;
        await this.transactionHook?.('after-commit');
        return {
          status: 'committed',
          objectId: copy(metadata.id),
          checkpointId: copy(checkpointId),
          objectSetRoot: copy(root),
          objectCount: count,
          sequence: expectedSequence,
        };
      } catch (error) {
        if (!committed && this.database.inTransaction) this.database.exec('ROLLBACK');
        if (!committed) await this.transactionHook?.('after-rollback');
        if (error instanceof WalControlStoreError) throw error;
        if (committed) throw error;
        return this.wrapIo('failed to finalize local WAL state', error);
      }
    });
  }

  stageAdmission(input: StageAdmissionInput): void {
    this.assertUsable();
    const id = fixedBytes(input.objectId, 32, 'objectId');
    const updatedAtMs = input.updatedAtMs === undefined ? nowValue(this.now) : safeInteger(input.updatedAtMs, 'updatedAtMs');
    try {
      const result = this.database.prepare(`
        INSERT INTO admission(object_id, state, proof_bytes, closure_bytes, provider_peer_id, reason_code, updated_at_ms)
        VALUES (?, 'STAGED', ?, ?, ?, NULL, ?)
        ON CONFLICT(object_id) DO UPDATE SET
          state = 'STAGED',
          proof_bytes = excluded.proof_bytes,
          closure_bytes = excluded.closure_bytes,
          provider_peer_id = excluded.provider_peer_id,
          reason_code = NULL,
          updated_at_ms = excluded.updated_at_ms
        WHERE admission.state IN ('STAGED', 'BLOCKED')
      `).run(
        id,
        input.proofBytes === undefined || input.proofBytes === null ? null : Buffer.from(input.proofBytes),
        input.closureBytes === undefined || input.closureBytes === null ? null : Buffer.from(input.closureBytes),
        input.providerPeerId === undefined || input.providerPeerId === null ? null : Buffer.from(input.providerPeerId),
        updatedAtMs,
      );
      if (result.changes !== 1) {
        controlError('WAL_CONTROL_LANE_CONFLICT', 'admission state is no longer staged');
      }
    } catch (error) {
      return this.wrapIo('failed to stage remote admission', error);
    }
  }

  getAdmission(objectId: Uint8Array): AdmissionRecord | null {
    this.assertUsable();
    const row = this.database.prepare(`
      SELECT object_id, state, proof_bytes, closure_bytes, provider_peer_id,
             reason_code, updated_at_ms
      FROM admission WHERE object_id = ?
    `).get(fixedBytes(objectId, 32, 'objectId')) as {
      object_id: Buffer;
      state: AdmissionState;
      proof_bytes: Buffer | null;
      closure_bytes: Buffer | null;
      provider_peer_id: Buffer | null;
      reason_code: string | null;
      updated_at_ms: number;
    } | undefined;
    return row === undefined ? null : {
      objectId: copy(row.object_id),
      state: row.state,
      proofBytes: row.proof_bytes === null ? null : copy(row.proof_bytes),
      closureBytes: row.closure_bytes === null ? null : copy(row.closure_bytes),
      providerPeerId: row.provider_peer_id === null ? null : copy(row.provider_peer_id),
      reasonCode: row.reason_code,
      updatedAtMs: row.updated_at_ms,
    };
  }

  setAdmissionState(
    objectId: Uint8Array,
    state: Extract<AdmissionState, 'BLOCKED' | 'QUARANTINED'>,
    reasonCode: string,
    updatedAtMs = nowValue(this.now),
  ): void {
    this.assertUsable();
    const id = fixedBytes(objectId, 32, 'objectId');
    const reason = assertText(reasonCode, 'admission reason');
    safeInteger(updatedAtMs, 'updatedAtMs');
    const current = this.getAdmission(id);
    if (current === null) controlError('WAL_CONTROL_NOT_FOUND', 'admission record is not staged');
    if (current.state === 'QUARANTINED') {
      if (state === 'QUARANTINED' && current.reasonCode === reason) return;
      controlError('WAL_CONTROL_LANE_CONFLICT', 'quarantined admission state is immutable');
    }
    if (current.state === 'ADMITTED') controlError('WAL_CONTROL_LANE_CONFLICT', 'admitted state is immutable');
    if (this.database.prepare(`
      UPDATE admission SET state = ?, reason_code = ?, updated_at_ms = ?
      WHERE object_id = ? AND state IN ('STAGED', 'BLOCKED')
    `).run(state, reason, updatedAtMs, id).changes !== 1) {
      controlError('WAL_CONTROL_LANE_CONFLICT', 'admission state changed concurrently');
    }
  }

  getWalObjectMetadata(objectId: Uint8Array): WalObjectMetadataRecord | null {
    this.assertUsable();
    const row = this.database.prepare(`
      SELECT object_id, namespace_id, writer_id, writer_epoch, sequence,
             previous_object_id, payload_length, canonical_length, origin,
             admitted_at_ms
      FROM wal_objects WHERE object_id = ?
    `).get(fixedBytes(objectId, 32, 'objectId')) as {
      object_id: Buffer;
      namespace_id: Buffer;
      writer_id: Buffer;
      writer_epoch: Buffer;
      sequence: Buffer;
      previous_object_id: Buffer | null;
      payload_length: number;
      canonical_length: number;
      origin: WalObjectOrigin;
      admitted_at_ms: number;
    } | undefined;
    return row === undefined ? null : {
      objectId: copy(row.object_id),
      namespaceId: copy(row.namespace_id),
      writerId: copy(row.writer_id),
      writerEpoch: blobU64(row.writer_epoch, 'writerEpoch'),
      sequence: blobU64(row.sequence, 'sequence'),
      previousObjectId: row.previous_object_id === null ? null : copy(row.previous_object_id),
      payloadLength: row.payload_length,
      canonicalLength: row.canonical_length,
      origin: row.origin,
      admittedAtMs: row.admitted_at_ms,
    };
  }

  findWalObjectAtPosition(
    namespaceId: Uint8Array,
    writerId: Uint8Array,
    writerEpoch: bigint,
    sequence: bigint,
  ): WalObjectMetadataRecord | null {
    this.assertUsable();
    const row = this.database.prepare(`
      SELECT object_id FROM wal_objects
      WHERE namespace_id = ? AND writer_id = ? AND writer_epoch = ? AND sequence = ?
    `).get(
      fixedBytes(namespaceId, 32, 'namespaceId'),
      fixedBytes(writerId, 20, 'writerId'),
      u64Blob(writerEpoch, 'writerEpoch'),
      u64Blob(sequence, 'sequence'),
    ) as { object_id: Buffer } | undefined;
    return row === undefined ? null : this.getWalObjectMetadata(row.object_id);
  }

  async admitRemoteBatch(inputs: readonly AdmitRemoteObjectInput[], updatedAtMs = nowValue(this.now)): Promise<void> {
    this.assertUsable();
    safeInteger(updatedAtMs, 'updatedAtMs');
    if (inputs.length === 0) controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'remote admission batch cannot be empty');
    const verified = inputs.map(input => ({
      input,
      metadata: verifyObjectMetadata(input.objectId, input.object, input.canonicalLength),
      logicalKeys: (input.logicalKeys ?? []).map((key, index) => fixedBytes(key, 32, `logicalKeys[${index}]`)),
    }));
    const logicalKeys = new Map<string, { namespaceId: Uint8Array; logicalKey: Uint8Array }>();
    for (const item of verified) {
      const namespaceHex = Buffer.from(item.metadata.namespace).toString('hex');
      for (const key of item.logicalKeys) {
        const logicalHex = Buffer.from(key).toString('hex');
        logicalKeys.set(`${namespaceHex}:${logicalHex}`, {
          namespaceId: item.metadata.namespace,
          logicalKey: key,
        });
      }
    }
    return this.mutex.run(async () => {
      let committed = false;
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const present = this.database.prepare('SELECT object_length FROM objects WHERE object_id = ?');
        const insert = this.database.prepare(`
          INSERT OR IGNORE INTO wal_objects(
            object_id, namespace_id, writer_id, writer_epoch, sequence,
            previous_object_id, payload_length, canonical_length, origin, admitted_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const position = this.database.prepare(`
          SELECT object_id FROM wal_objects
          WHERE namespace_id = ? AND writer_id = ? AND writer_epoch = ? AND sequence = ?
        `);
        const admit = this.database.prepare(`
          UPDATE admission SET state = 'ADMITTED', reason_code = NULL, updated_at_ms = ?
          WHERE object_id = ? AND state = 'STAGED'
        `);
        for (const { input, metadata } of verified) {
          const physical = present.get(metadata.id) as { object_length: number } | undefined;
          if (physical === undefined || physical.object_length !== input.canonicalLength) {
            controlError('WAL_CONTROL_NOT_FOUND', 'remote WalObject bytes are not durably present');
          }
          const inserted = insert.run(
            metadata.id,
            metadata.namespace,
            metadata.writer,
            metadata.epoch,
            metadata.sequence,
            metadata.previous,
            input.object[6].length,
            input.canonicalLength,
            input.origin ?? 'REMOTE',
            updatedAtMs,
          );
          if (inserted.changes !== 1) {
            const occupant = position.get(
              metadata.namespace,
              metadata.writer,
              metadata.epoch,
              metadata.sequence,
            ) as { object_id: Buffer } | undefined;
            if (occupant === undefined || !bytesEqual(occupant.object_id, metadata.id)) {
              controlError('WAL_CONTROL_LANE_CONFLICT', 'remote author position is already occupied by another WalObject');
            }
          }
          await this.transactionHook?.('after-remote-object-insert');
          if (admit.run(updatedAtMs, metadata.id).changes !== 1) {
            controlError('WAL_CONTROL_LANE_CONFLICT', 'remote WalObject was not in staged admission state');
          }
          await this.transactionHook?.('after-remote-object-admit');
        }

        const existingRetry = this.database.prepare('SELECT kind, payload FROM retry_queue WHERE queue_key = ?');
        const insertRetry = this.database.prepare(`
          INSERT INTO retry_queue(
            queue_key, kind, payload, priority, attempts, maximum_attempts,
            available_at_ms, lease_until_ms, state, last_error, created_at_ms, updated_at_ms
          ) VALUES (?, 'WAL_REPLAY_LOGICAL_KEY', ?, 0, 0, 32, ?, NULL, 'READY', NULL, ?, ?)
        `);
        const totals = this.database.prepare(
          'SELECT count(*) AS count, coalesce(sum(length(payload)), 0) AS bytes FROM retry_queue',
        ).get() as CountRow;
        let addedCount = 0;
        let addedBytes = 0;
        for (const [scopedKey, work] of [...logicalKeys].sort(([left], [right]) => left.localeCompare(right))) {
          const queueKey = `wal-replay:${scopedKey}`;
          const payload = encodeCanonicalCbor([1n, work.namespaceId, work.logicalKey]);
          const current = existingRetry.get(queueKey) as { kind: string; payload: Buffer } | undefined;
          if (current !== undefined) {
            if (current.kind !== 'WAL_REPLAY_LOGICAL_KEY' || !bytesEqual(current.payload, payload)) {
              controlError('WAL_CONTROL_IDEMPOTENCY_CONFLICT', 'logical-key retry entry has another payload');
            }
            continue;
          }
          addedCount += 1;
          addedBytes += payload.length;
          if (
            totals.count + addedCount > this.maximumQueueEntries
            || totals.bytes! + addedBytes > this.maximumQueueBytes
          ) controlError('WAL_CONTROL_LIMIT_EXCEEDED', 'persistent retry queue limit exceeded');
          insertRetry.run(queueKey, Buffer.from(payload), updatedAtMs, updatedAtMs, updatedAtMs);
          await this.transactionHook?.('after-replay-enqueue');
        }
        await this.transactionHook?.('before-commit');
        this.database.exec('COMMIT');
        committed = true;
        await this.transactionHook?.('after-commit');
      } catch (error) {
        if (!committed && this.database.inTransaction) this.database.exec('ROLLBACK');
        if (!committed) await this.transactionHook?.('after-rollback');
        if (error instanceof WalControlStoreError) throw error;
        if (committed) throw error;
        return this.wrapIo('failed to admit remote WAL batch', error);
      }
    });
  }

  enqueueRetry(input: EnqueueRetryInput): void {
    this.assertUsable();
    const key = assertText(input.key, 'retry key');
    const kind = assertText(input.kind, 'retry kind');
    if (!(input.payload instanceof Uint8Array)) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'retry payload must be bytes');
    }
    const priority = safeInteger(input.priority ?? 0, 'retry priority');
    const maximumAttempts = safeInteger(input.maximumAttempts ?? 16, 'maximumAttempts', 1);
    const availableAtMs = input.availableAtMs === undefined ? nowValue(this.now) : safeInteger(input.availableAtMs, 'availableAtMs');
    const current = this.database.prepare('SELECT kind, payload FROM retry_queue WHERE queue_key = ?').get(key) as
      { kind: string; payload: Buffer } | undefined;
    if (current !== undefined) {
      if (current.kind !== kind || !bytesEqual(current.payload, input.payload)) {
        controlError('WAL_CONTROL_IDEMPOTENCY_CONFLICT', 'retry key was already used for another operation');
      }
      return;
    }
    const totals = this.database.prepare('SELECT count(*) AS count, coalesce(sum(length(payload)), 0) AS bytes FROM retry_queue')
      .get() as CountRow;
    if (totals.count >= this.maximumQueueEntries || totals.bytes! + input.payload.length > this.maximumQueueBytes) {
      controlError('WAL_CONTROL_LIMIT_EXCEEDED', 'persistent retry queue limit exceeded');
    }
    const now = nowValue(this.now);
    this.database.prepare(`
      INSERT INTO retry_queue(
        queue_key, kind, payload, priority, attempts, maximum_attempts,
        available_at_ms, lease_until_ms, state, last_error, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL, 'READY', NULL, ?, ?)
    `).run(key, kind, Buffer.from(input.payload), priority, maximumAttempts, availableAtMs, now, now);
  }

  leaseRetry(leaseMs: number, now = nowValue(this.now)): RetryQueueEntry | null {
    this.assertUsable();
    safeInteger(leaseMs, 'leaseMs', 1);
    safeInteger(now, 'now');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.recoverQueues(now);
      const row = this.database.prepare(`
        SELECT queue_key, kind, payload, priority, attempts, maximum_attempts,
               available_at_ms, lease_until_ms, state, last_error
        FROM retry_queue
        WHERE state = 'READY' AND available_at_ms <= ?
        ORDER BY priority DESC, created_at_ms, queue_key
        LIMIT 1
      `).get(now) as {
        queue_key: string;
        kind: string;
        payload: Buffer;
        priority: number;
        attempts: number;
        maximum_attempts: number;
        available_at_ms: number;
        lease_until_ms: number | null;
        state: 'READY';
        last_error: string | null;
      } | undefined;
      if (row === undefined) {
        this.database.exec('COMMIT');
        return null;
      }
      const leaseUntilMs = now + leaseMs;
      if (!Number.isSafeInteger(leaseUntilMs)) controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'retry lease deadline overflow');
      this.database.prepare(`
        UPDATE retry_queue SET state = 'LEASED', lease_until_ms = ?, updated_at_ms = ? WHERE queue_key = ?
      `).run(leaseUntilMs, now, row.queue_key);
      this.database.exec('COMMIT');
      return {
        key: row.queue_key,
        kind: row.kind,
        payload: copy(row.payload),
        priority: row.priority,
        attempts: row.attempts,
        maximumAttempts: row.maximum_attempts,
        availableAtMs: row.available_at_ms,
        leaseUntilMs,
        state: 'LEASED',
        lastError: row.last_error,
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof WalControlStoreError) throw error;
      return this.wrapIo('failed to lease retry work', error);
    }
  }

  completeRetry(key: string): void {
    this.assertUsable();
    if (this.database.prepare("DELETE FROM retry_queue WHERE queue_key = ? AND state = 'LEASED'").run(key).changes !== 1) {
      controlError('WAL_CONTROL_LEASE_CONFLICT', 'retry entry is not leased');
    }
  }

  /** Remove queued/blocked work after an exact post-read proves it completed. */
  cancelRetry(key: string): boolean {
    this.assertUsable();
    const value = assertText(key, 'retry key');
    return this.database.prepare(
      "DELETE FROM retry_queue WHERE queue_key = ? AND state IN ('READY', 'BLOCKED')",
    ).run(value).changes === 1;
  }

  failRetry(key: string, error: string, availableAtMs: number): RetryState {
    this.assertUsable();
    assertText(error, 'retry error');
    safeInteger(availableAtMs, 'availableAtMs');
    const row = this.database.prepare(`
      SELECT attempts, maximum_attempts FROM retry_queue WHERE queue_key = ? AND state = 'LEASED'
    `).get(key) as { attempts: number; maximum_attempts: number } | undefined;
    if (row === undefined) controlError('WAL_CONTROL_LEASE_CONFLICT', 'retry entry is not leased');
    const attempts = row.attempts + 1;
    const state: RetryState = attempts >= row.maximum_attempts ? 'BLOCKED' : 'READY';
    this.database.prepare(`
      UPDATE retry_queue SET attempts = ?, state = ?, available_at_ms = ?,
        lease_until_ms = NULL, last_error = ?, updated_at_ms = ? WHERE queue_key = ?
    `).run(attempts, state, availableAtMs, error, nowValue(this.now), key);
    return state;
  }

  quarantine(input: QuarantineInput): void {
    this.assertUsable();
    const entryId = fixedBytes(input.entryId, 32, 'entryId');
    const peerId = Buffer.from(input.providerPeerId);
    if (peerId.length === 0) controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'providerPeerId cannot be empty');
    const reason = assertText(input.reasonCode, 'quarantine reason');
    const byteLength = safeInteger(input.byteLength, 'byteLength');
    const path = assertRelativePath(input.relativePath);
    const createdAtMs = input.createdAtMs === undefined ? nowValue(this.now) : safeInteger(input.createdAtMs, 'createdAtMs');
    const expiresAtMs = input.expiresAtMs ?? createdAtMs + this.quarantineRetentionMs;
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= createdAtMs) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'quarantine expiry must be after creation');
    }
    this.cleanupExpired(createdAtMs);
    if (this.database.prepare('SELECT 1 FROM wal_objects WHERE object_id = ?').get(entryId) !== undefined) {
      controlError('WAL_CONTROL_LANE_CONFLICT', 'an admitted canonical WalObject cannot be quarantined');
    }
    const existing = this.database.prepare('SELECT 1 FROM quarantine WHERE entry_id = ?').get(entryId);
    if (existing !== undefined) return;
    const totals = this.database.prepare(`
      SELECT count(*) AS count, coalesce(sum(byte_length), 0) AS bytes FROM quarantine WHERE provider_peer_id = ?
    `).get(peerId) as CountRow;
    if (
      totals.count >= this.maximumQuarantineEntriesPerPeer
      || totals.bytes! + byteLength > this.maximumQuarantineBytesPerPeer
    ) {
      controlError('WAL_CONTROL_LIMIT_EXCEEDED', 'per-peer quarantine limit exceeded');
    }
    this.database.prepare(`
      INSERT INTO quarantine(
        entry_id, provider_peer_id, reason_code, relative_path,
        byte_length, created_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(entryId, peerId, reason, path, byteLength, createdAtMs, expiresAtMs);
  }

  async quarantineAdmission(input: QuarantineAdmissionInput): Promise<void> {
    this.assertUsable();
    const admissionObjectId = fixedBytes(input.admissionObjectId ?? input.entryId, 32, 'admissionObjectId');
    const blockedRootObjectId = input.blockedRootObjectId === undefined || input.blockedRootObjectId === null
      ? null
      : fixedBytes(input.blockedRootObjectId, 32, 'blockedRootObjectId');
    const updatedAtMs = input.updatedAtMs === undefined
      ? nowValue(this.now)
      : safeInteger(input.updatedAtMs, 'updatedAtMs');
    return this.mutex.run(async () => {
      let committed = false;
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.quarantine(input);
        await this.transactionHook?.('after-quarantine-insert');
        this.setAdmissionState(admissionObjectId, 'QUARANTINED', input.reasonCode, updatedAtMs);
        if (blockedRootObjectId !== null && !bytesEqual(blockedRootObjectId, admissionObjectId)) {
          this.setAdmissionState(blockedRootObjectId, 'BLOCKED', 'DEPENDENCY_INVALID', updatedAtMs);
        }
        await this.transactionHook?.('after-quarantine-state');
        await this.transactionHook?.('before-commit');
        this.database.exec('COMMIT');
        committed = true;
        await this.transactionHook?.('after-commit');
      } catch (error) {
        if (!committed && this.database.inTransaction) this.database.exec('ROLLBACK');
        if (!committed) await this.transactionHook?.('after-rollback');
        if (error instanceof WalControlStoreError) throw error;
        if (committed) throw error;
        return this.wrapIo('failed to quarantine remote WAL admission', error);
      }
    });
  }

  getQuarantine(entryId: Uint8Array): QuarantineRecord | null {
    this.assertUsable();
    const row = this.database.prepare(`
      SELECT entry_id, provider_peer_id, reason_code, relative_path,
             byte_length, created_at_ms, expires_at_ms
      FROM quarantine WHERE entry_id = ?
    `).get(fixedBytes(entryId, 32, 'entryId')) as {
      entry_id: Buffer;
      provider_peer_id: Buffer;
      reason_code: string;
      relative_path: string | null;
      byte_length: number;
      created_at_ms: number;
      expires_at_ms: number;
    } | undefined;
    return row === undefined ? null : {
      entryId: copy(row.entry_id),
      providerPeerId: copy(row.provider_peer_id),
      reasonCode: row.reason_code,
      relativePath: row.relative_path,
      byteLength: row.byte_length,
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
    };
  }

  listQuarantine(providerPeerId?: Uint8Array, limit?: number): readonly QuarantineRecord[] {
    this.assertUsable();
    const effectiveLimit = limit ?? Math.min(1_000, this.maximumQuarantineEntriesPerPeer);
    safeInteger(effectiveLimit, 'quarantine list limit', 1);
    if (effectiveLimit > this.maximumQuarantineEntriesPerPeer) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'quarantine list limit exceeds the configured per-peer bound');
    }
    let rows: Array<{
      entry_id: Buffer;
      provider_peer_id: Buffer;
      reason_code: string;
      relative_path: string | null;
      byte_length: number;
      created_at_ms: number;
      expires_at_ms: number;
    }>;
    if (providerPeerId === undefined) {
      rows = this.database.prepare(`
        SELECT entry_id, provider_peer_id, reason_code, relative_path,
               byte_length, created_at_ms, expires_at_ms
        FROM quarantine ORDER BY created_at_ms, entry_id LIMIT ?
      `).all(effectiveLimit) as typeof rows;
    } else {
      if (!(providerPeerId instanceof Uint8Array) || providerPeerId.length === 0) {
        controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'providerPeerId cannot be empty');
      }
      rows = this.database.prepare(`
        SELECT entry_id, provider_peer_id, reason_code, relative_path,
               byte_length, created_at_ms, expires_at_ms
        FROM quarantine WHERE provider_peer_id = ?
        ORDER BY created_at_ms, entry_id LIMIT ?
      `).all(Buffer.from(providerPeerId), effectiveLimit) as typeof rows;
    }
    return rows.map(row => ({
      entryId: copy(row.entry_id),
      providerPeerId: copy(row.provider_peer_id),
      reasonCode: row.reason_code,
      relativePath: row.relative_path,
      byteLength: row.byte_length,
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
    }));
  }

  cleanupExpired(now = nowValue(this.now)): { ranges: number; cache: number; quarantine: number } {
    this.assertOpen();
    safeInteger(now, 'now');
    return {
      ranges: this.database.prepare('DELETE FROM object_ranges WHERE expires_at_ms <= ?').run(now).changes,
      cache: this.database.prepare('DELETE FROM iblt_cache WHERE expires_at_ms <= ?').run(now).changes,
      quarantine: this.database.prepare('DELETE FROM quarantine WHERE expires_at_ms <= ?').run(now).changes,
    };
  }

  /**
   * Atomically records a nonce before encryption. Repeating the exact nonce
   * under the same derived object-key coordinates fails across restarts.
   */
  claimPrivatePayloadNonce(input: ClaimPrivatePayloadNonceInput): void {
    this.assertUsable();
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO private_payload_nonces(
        namespace_id, writer_id, writer_epoch, sequence, key_epoch, nonce, claimed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      fixedBytes(input.namespaceId, 32, 'namespaceId'),
      fixedBytes(input.writerId, 20, 'writerId'),
      u64Blob(input.writerEpoch, 'writerEpoch'),
      u64Blob(input.sequence, 'sequence'),
      u64Blob(input.keyEpoch, 'keyEpoch'),
      fixedBytes(input.nonce, 12, 'nonce'),
      safeInteger(input.claimedAtMs ?? nowValue(this.now), 'claimedAtMs'),
    );
    if (result.changes !== 1) {
      controlError('WAL_CONTROL_NONCE_REUSE', 'private payload nonce was already claimed for this object key');
    }
  }

  recordObjectRange(input: ObjectRangeRecord): void {
    this.assertUsable();
    const id = fixedBytes(input.objectId, 32, 'objectId');
    const offset = safeInteger(input.offset, 'range offset');
    const length = safeInteger(input.length, 'range length', 1);
    const totalLength = safeInteger(input.totalLength, 'total length', 1);
    if (offset + length > totalLength || !Number.isSafeInteger(offset + length)) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'object range exceeds its total length');
    }
    const path = assertRelativePath(input.relativePath)!;
    const receivedAtMs = safeInteger(input.receivedAtMs, 'receivedAtMs');
    const expiresAtMs = safeInteger(input.expiresAtMs, 'expiresAtMs');
    if (expiresAtMs <= receivedAtMs) controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'object range expiry must follow receipt');
    const provider = input.providerPeerId === undefined || input.providerPeerId === null
      ? null
      : Buffer.from(input.providerPeerId);
    const prior = this.database.prepare('SELECT total_length FROM object_ranges WHERE object_id = ? LIMIT 1').get(id) as
      { total_length: number } | undefined;
    if (prior !== undefined && prior.total_length !== totalLength) {
      controlError('WAL_CONTROL_IDEMPOTENCY_CONFLICT', 'one staged object cannot have two total lengths');
    }
    this.database.prepare(`
      INSERT INTO object_ranges(
        object_id, range_offset, range_length, total_length, relative_path,
        provider_peer_id, received_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(object_id, range_offset, range_length) DO UPDATE SET
        relative_path = excluded.relative_path,
        provider_peer_id = excluded.provider_peer_id,
        received_at_ms = excluded.received_at_ms,
        expires_at_ms = excluded.expires_at_ms
      WHERE object_ranges.total_length = excluded.total_length
    `).run(id, offset, length, totalLength, path, provider, receivedAtMs, expiresAtMs);
  }

  putIbltCache(input: IbltCacheRecord, maximumEntries: number, maximumBytes: number): void {
    this.assertUsable();
    const maximumEntryCount = safeInteger(maximumEntries, 'maximum IBLT cache entries', 1);
    const maximumByteCount = safeInteger(maximumBytes, 'maximum IBLT cache bytes', 1);
    const head = fixedBytes(input.headId, 32, 'headId');
    const seed = fixedBytes(input.reconciliationSeed, 32, 'reconciliationSeed');
    const first = u64Blob(input.firstSymbolIndex, 'firstSymbolIndex');
    const symbolCount = safeInteger(input.symbolCount, 'symbolCount', 1);
    const createdAtMs = safeInteger(input.createdAtMs, 'createdAtMs');
    const expiresAtMs = safeInteger(input.expiresAtMs, 'expiresAtMs');
    if (!(input.canonicalBytes instanceof Uint8Array) || input.canonicalBytes.length === 0) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'IBLT cache bytes cannot be empty');
    }
    if (input.canonicalBytes.length > maximumByteCount || expiresAtMs <= createdAtMs) {
      controlError('WAL_CONTROL_LIMIT_EXCEEDED', 'IBLT cache entry exceeds its bounds');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM iblt_cache WHERE expires_at_ms <= ?').run(createdAtMs);
      const existing = this.database.prepare(`
        SELECT length(canonical_bytes) AS bytes FROM iblt_cache
        WHERE head_id = ? AND reconciliation_seed = ? AND first_symbol_index = ?
      `).get(head, seed, first) as { bytes: number } | undefined;
      let totals = this.database.prepare(`
        SELECT count(*) AS count, coalesce(sum(length(canonical_bytes)), 0) AS bytes FROM iblt_cache
      `).get() as CountRow;
      const addedEntries = existing === undefined ? 1 : 0;
      const addedBytes = input.canonicalBytes.length - (existing?.bytes ?? 0);
      while (
        totals.count + addedEntries > maximumEntryCount
        || totals.bytes! + addedBytes > maximumByteCount
      ) {
        const oldest = this.database.prepare(`
          SELECT head_id, reconciliation_seed, first_symbol_index, length(canonical_bytes) AS bytes
          FROM iblt_cache ORDER BY created_at_ms, head_id, reconciliation_seed, first_symbol_index LIMIT 1
        `).get() as { head_id: Buffer; reconciliation_seed: Buffer; first_symbol_index: Buffer; bytes: number } | undefined;
        /* v8 ignore start -- a non-oversized entry makes the cache non-empty before bounds can be exceeded. */
        if (oldest === undefined) controlError('WAL_CONTROL_LIMIT_EXCEEDED', 'IBLT cache cannot satisfy its configured bounds');
        /* v8 ignore stop */
        this.database.prepare(`
          DELETE FROM iblt_cache WHERE head_id = ? AND reconciliation_seed = ? AND first_symbol_index = ?
        `).run(oldest.head_id, oldest.reconciliation_seed, oldest.first_symbol_index);
        totals = { count: totals.count - 1, bytes: totals.bytes! - oldest.bytes };
      }
      this.database.prepare(`
        INSERT INTO iblt_cache(
          head_id, reconciliation_seed, first_symbol_index, symbol_count,
          canonical_bytes, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(head_id, reconciliation_seed, first_symbol_index) DO UPDATE SET
          symbol_count = excluded.symbol_count,
          canonical_bytes = excluded.canonical_bytes,
          created_at_ms = excluded.created_at_ms,
          expires_at_ms = excluded.expires_at_ms
      `).run(head, seed, first, symbolCount, Buffer.from(input.canonicalBytes), createdAtMs, expiresAtMs);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      return this.wrapIo('failed to update IBLT cache', error);
    }
  }

  getIbltCache(headId: Uint8Array, seed: Uint8Array, firstSymbolIndex: bigint): Uint8Array | null {
    this.assertUsable();
    const row = this.database.prepare(`
      SELECT canonical_bytes FROM iblt_cache
      WHERE head_id = ? AND reconciliation_seed = ? AND first_symbol_index = ?
    `).get(
      fixedBytes(headId, 32, 'headId'),
      fixedBytes(seed, 32, 'reconciliationSeed'),
      u64Blob(firstSymbolIndex, 'firstSymbolIndex'),
    ) as { canonical_bytes: Buffer } | undefined;
    return row === undefined ? null : copy(row.canonical_bytes);
  }

  putVector(input: VectorRecord): void {
    this.assertUsable();
    const vectorId = fixedBytes(input.vectorId, 32, 'vectorId');
    const collectionId = fixedBytes(input.collectionId, 32, 'collectionId');
    const epoch = u64Blob(input.vectorEpoch, 'vectorEpoch');
    const number = u64Blob(input.vectorNumber, 'vectorNumber');
    const expiresAtMs = safeInteger(input.expiresAtMs, 'expiresAtMs');
    const createdAtMs = safeInteger(input.createdAtMs, 'createdAtMs');
    if (!(input.canonicalBytes instanceof Uint8Array) || input.canonicalBytes.length === 0) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'vector canonical bytes cannot be empty');
    }
    const prior = this.database.prepare('SELECT canonical_bytes, collection_id FROM vectors WHERE vector_id = ?').get(vectorId) as
      { canonical_bytes: Buffer; collection_id: Buffer } | undefined;
    if (prior !== undefined && (!bytesEqual(prior.canonical_bytes, input.canonicalBytes) || !bytesEqual(prior.collection_id, collectionId))) {
      controlError('WAL_CONTROL_IDEMPOTENCY_CONFLICT', 'vector ID was already bound to different canonical bytes');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (input.status === 'CURRENT') {
        this.database.prepare("UPDATE vectors SET status = 'VERIFIED' WHERE collection_id = ? AND status = 'CURRENT'")
          .run(collectionId);
      }
      this.database.prepare(`
        INSERT INTO vectors(
          vector_id, collection_id, vector_epoch, vector_number,
          canonical_bytes, status, expires_at_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(vector_id) DO UPDATE SET status = excluded.status, expires_at_ms = excluded.expires_at_ms
      `).run(vectorId, collectionId, epoch, number, Buffer.from(input.canonicalBytes), input.status, expiresAtMs, createdAtMs);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      return this.wrapIo('failed to persist vector', error);
    }
  }

  putMaterialization(input: MaterializationRecord): void {
    this.assertUsable();
    const error = input.lastError === undefined || input.lastError === null
      ? null
      : assertText(input.lastError, 'materialization error');
    this.database.prepare(`
      INSERT INTO materialization(
        namespace_id, logical_key, desired_heads_digest,
        desired_conflict_heads_digest, desired_state_digest, source_vector_id,
        applied_heads_digest, applied_conflict_heads_digest,
        applied_state_digest, status, attempts, retry_at_ms, last_error,
        updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace_id, logical_key) DO UPDATE SET
        desired_heads_digest = excluded.desired_heads_digest,
        desired_conflict_heads_digest = excluded.desired_conflict_heads_digest,
        desired_state_digest = excluded.desired_state_digest,
        source_vector_id = excluded.source_vector_id,
        applied_heads_digest = excluded.applied_heads_digest,
        applied_conflict_heads_digest = excluded.applied_conflict_heads_digest,
        applied_state_digest = excluded.applied_state_digest,
        status = excluded.status,
        attempts = excluded.attempts,
        retry_at_ms = excluded.retry_at_ms,
        last_error = excluded.last_error,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      fixedBytes(input.namespaceId, 32, 'namespaceId'),
      fixedBytes(input.logicalKey, 32, 'logicalKey'),
      fixedBytes(input.desiredHeadsDigest, 32, 'desiredHeadsDigest'),
      fixedBytes(input.desiredConflictHeadsDigest, 32, 'desiredConflictHeadsDigest'),
      fixedBytes(input.desiredStateDigest, 32, 'desiredStateDigest'),
      fixedBytes(input.sourceVectorId, 32, 'sourceVectorId'),
      input.appliedHeadsDigest === undefined || input.appliedHeadsDigest === null
        ? null
        : fixedBytes(input.appliedHeadsDigest, 32, 'appliedHeadsDigest'),
      input.appliedConflictHeadsDigest === undefined || input.appliedConflictHeadsDigest === null
        ? null
        : fixedBytes(input.appliedConflictHeadsDigest, 32, 'appliedConflictHeadsDigest'),
      input.appliedStateDigest === undefined || input.appliedStateDigest === null
        ? null
        : fixedBytes(input.appliedStateDigest, 32, 'appliedStateDigest'),
      input.status,
      safeInteger(input.attempts, 'materialization attempts'),
      safeInteger(input.retryAtMs, 'materialization retryAtMs'),
      error,
      safeInteger(input.updatedAtMs, 'materialization updatedAtMs'),
    );
  }

  getMaterialization(namespaceId: Uint8Array, logicalKey: Uint8Array): MaterializationRecord | null {
    this.assertUsable();
    const row = this.database.prepare(`
      SELECT namespace_id, logical_key, desired_heads_digest,
             desired_conflict_heads_digest, desired_state_digest,
             source_vector_id, applied_heads_digest,
             applied_conflict_heads_digest, applied_state_digest, status,
             attempts, retry_at_ms, last_error, updated_at_ms
      FROM materialization WHERE namespace_id = ? AND logical_key = ?
    `).get(
      fixedBytes(namespaceId, 32, 'namespaceId'),
      fixedBytes(logicalKey, 32, 'logicalKey'),
    ) as MaterializationRow | undefined;
    return row === undefined ? null : materializationRecord(row);
  }

  listMaterializations(
    statuses: readonly MaterializationRecord['status'][] = ['PENDING', 'BLOCKED'],
    limit = 1_000,
  ): readonly MaterializationRecord[] {
    this.assertUsable();
    safeInteger(limit, 'materialization limit', 1);
    if (limit > this.maximumQueueEntries) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'materialization limit exceeds the queue bound');
    }
    if (
      statuses.length === 0
      || statuses.some(status => !['PENDING', 'APPLIED', 'BLOCKED'].includes(status))
    ) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'materialization statuses are invalid');
    }
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.database.prepare(`
      SELECT namespace_id, logical_key, desired_heads_digest,
             desired_conflict_heads_digest, desired_state_digest,
             source_vector_id, applied_heads_digest,
             applied_conflict_heads_digest, applied_state_digest, status,
             attempts, retry_at_ms, last_error, updated_at_ms
      FROM materialization WHERE status IN (${placeholders})
      ORDER BY retry_at_ms, updated_at_ms, namespace_id, logical_key LIMIT ?
    `).all(...statuses, limit) as MaterializationRow[];
    return rows.map(materializationRecord);
  }

  getLocalCommitWork(objectId: Uint8Array): LocalCommitWorkRecord | null {
    this.assertUsable();
    const row = this.database.prepare(`
      SELECT object_id, namespace_id, logical_key, state, last_error, updated_at_ms
      FROM local_commit_work WHERE object_id = ?
    `).get(fixedBytes(objectId, 32, 'objectId')) as {
      object_id: Buffer;
      namespace_id: Buffer;
      logical_key: Buffer;
      state: LocalCommitWorkState;
      last_error: string | null;
      updated_at_ms: number;
    } | undefined;
    return row === undefined ? null : {
      objectId: copy(row.object_id),
      namespaceId: copy(row.namespace_id),
      logicalKey: copy(row.logical_key),
      state: row.state,
      lastError: row.last_error,
      updatedAtMs: row.updated_at_ms,
    };
  }

  /** Exact local logical-key frontier used as the encoder's compare-and-swap base. */
  getLocalLogicalHeads(namespaceId: Uint8Array, logicalKey: Uint8Array): readonly Uint8Array[] {
    this.assertUsable();
    const rows = this.database.prepare(`
      SELECT object_id FROM local_logical_heads
      WHERE namespace_id = ? AND logical_key = ? ORDER BY object_id
    `).all(
      fixedBytes(namespaceId, 32, 'namespaceId'),
      fixedBytes(logicalKey, 32, 'logicalKey'),
    ) as Array<{ object_id: Buffer }>;
    return rows.map(row => copy(row.object_id));
  }

  listLocalCommitWork(
    states: readonly LocalCommitWorkState[] = ['PENDING', 'QUEUED'],
    limit = 1_000,
  ): readonly LocalCommitWorkRecord[] {
    this.assertUsable();
    safeInteger(limit, 'local commit work limit', 1);
    if (limit > this.maximumQueueEntries) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'local commit work limit exceeds the queue bound');
    }
    if (states.length === 0 || states.some(state =>
      !['PENDING', 'QUEUED', 'MATERIALIZED', 'BLOCKED'].includes(state))) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'local commit work states are invalid');
    }
    const placeholders = states.map(() => '?').join(', ');
    const rows = this.database.prepare(`
      SELECT object_id, namespace_id, logical_key, state, last_error, updated_at_ms
      FROM local_commit_work WHERE state IN (${placeholders})
      ORDER BY updated_at_ms, object_id LIMIT ?
    `).all(...states, limit) as Array<{
      object_id: Buffer;
      namespace_id: Buffer;
      logical_key: Buffer;
      state: LocalCommitWorkState;
      last_error: string | null;
      updated_at_ms: number;
    }>;
    return rows.map(row => ({
      objectId: copy(row.object_id),
      namespaceId: copy(row.namespace_id),
      logicalKey: copy(row.logical_key),
      state: row.state,
      lastError: row.last_error,
      updatedAtMs: row.updated_at_ms,
    }));
  }

  setLocalCommitWorkState(input: {
    objectId: Uint8Array;
    expected: readonly LocalCommitWorkState[];
    state: LocalCommitWorkState;
    lastError?: string | null;
    updatedAtMs?: number;
  }): void {
    this.assertUsable();
    if (input.expected.length === 0) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'expected local work states cannot be empty');
    }
    const objectId = fixedBytes(input.objectId, 32, 'objectId');
    const error = input.lastError === undefined || input.lastError === null
      ? null
      : assertText(input.lastError, 'local commit work error');
    const updatedAtMs = safeInteger(input.updatedAtMs ?? nowValue(this.now), 'updatedAtMs');
    const placeholders = input.expected.map(() => '?').join(', ');
    const result = this.database.prepare(`
      UPDATE local_commit_work SET state = ?, last_error = ?, updated_at_ms = ?
      WHERE object_id = ? AND state IN (${placeholders})
    `).run(input.state, error, updatedAtMs, objectId, ...input.expected);
    if (result.changes !== 1) {
      controlError('WAL_CONTROL_LANE_CONFLICT', 'local commit work is absent or changed concurrently');
    }
    if (input.state === 'MATERIALIZED') {
      this.database.prepare(`
        UPDATE idempotency SET status = 'MATERIALIZED' WHERE object_id = ?
      `).run(objectId);
    }
  }

  completeLocalCommitWorkForScope(
    namespaceId: Uint8Array,
    logicalKey: Uint8Array,
    updatedAtMs = nowValue(this.now),
  ): number {
    this.assertUsable();
    const namespace = fixedBytes(namespaceId, 32, 'namespaceId');
    const logical = fixedBytes(logicalKey, 32, 'logicalKey');
    safeInteger(updatedAtMs, 'updatedAtMs');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const objectRows = this.database.prepare(`
        SELECT object_id FROM local_commit_work
        WHERE namespace_id = ? AND logical_key = ?
          AND state IN ('PENDING', 'QUEUED')
      `).all(namespace, logical) as Array<{ object_id: Buffer }>;
      const result = this.database.prepare(`
        UPDATE local_commit_work
        SET state = 'MATERIALIZED', last_error = NULL, updated_at_ms = ?
        WHERE namespace_id = ? AND logical_key = ?
          AND state IN ('PENDING', 'QUEUED')
      `).run(updatedAtMs, namespace, logical);
      const updateIdempotency = this.database.prepare(
        "UPDATE idempotency SET status = 'MATERIALIZED' WHERE object_id = ?",
      );
      for (const row of objectRows) updateIdempotency.run(row.object_id);
      this.database.exec('COMMIT');
      return result.changes;
    } catch (error) {
      this.database.exec('ROLLBACK');
      return this.wrapIo('failed to complete local materialization work', error);
    }
  }

  putPeerState(input: PeerStateRecord): void {
    this.assertUsable();
    if (!(input.peerId instanceof Uint8Array) || input.peerId.length === 0) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'peerId cannot be empty');
    }
    this.database.prepare(`
      INSERT INTO peer_state(
        peer_id, success_count, failure_count, backoff_until_ms, availability_hint, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET
        success_count = excluded.success_count,
        failure_count = excluded.failure_count,
        backoff_until_ms = excluded.backoff_until_ms,
        availability_hint = excluded.availability_hint,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      Buffer.from(input.peerId),
      safeInteger(input.successCount, 'peer successCount'),
      safeInteger(input.failureCount, 'peer failureCount'),
      safeInteger(input.backoffUntilMs, 'peer backoffUntilMs'),
      input.availabilityHint === undefined || input.availabilityHint === null ? null : Buffer.from(input.availabilityHint),
      safeInteger(input.updatedAtMs, 'peer updatedAtMs'),
    );
  }

  getPeerState(peerId: Uint8Array): PeerStateRecord | null {
    this.assertUsable();
    if (!(peerId instanceof Uint8Array) || peerId.length === 0) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'peerId cannot be empty');
    }
    const row = this.database.prepare(`
      SELECT peer_id, success_count, failure_count, backoff_until_ms,
             availability_hint, updated_at_ms
      FROM peer_state WHERE peer_id = ?
    `).get(Buffer.from(peerId)) as {
      peer_id: Buffer;
      success_count: number;
      failure_count: number;
      backoff_until_ms: number;
      availability_hint: Buffer | null;
      updated_at_ms: number;
    } | undefined;
    return row === undefined ? null : {
      peerId: copy(row.peer_id),
      successCount: row.success_count,
      failureCount: row.failure_count,
      backoffUntilMs: row.backoff_until_ms,
      availabilityHint: row.availability_hint === null ? null : copy(row.availability_hint),
      updatedAtMs: row.updated_at_ms,
    };
  }

  listPeerStates(): readonly PeerStateRecord[] {
    this.assertUsable();
    const rows = this.database.prepare(`
      SELECT peer_id, success_count, failure_count, backoff_until_ms,
             availability_hint, updated_at_ms
      FROM peer_state ORDER BY peer_id
    `).all() as Array<{
      peer_id: Buffer;
      success_count: number;
      failure_count: number;
      backoff_until_ms: number;
      availability_hint: Buffer | null;
      updated_at_ms: number;
    }>;
    return rows.map(row => ({
      peerId: copy(row.peer_id),
      successCount: row.success_count,
      failureCount: row.failure_count,
      backoffUntilMs: row.backoff_until_ms,
      availabilityHint: row.availability_hint === null ? null : copy(row.availability_hint),
      updatedAtMs: row.updated_at_ms,
    }));
  }

  enqueueGc(input: GcQueueRecord, maximumEntries: number, maximumBytes: number): void {
    this.assertUsable();
    const entryLimit = safeInteger(maximumEntries, 'maximum GC entries', 1);
    const byteLimit = safeInteger(maximumBytes, 'maximum GC bytes', 1);
    const byteLength = safeInteger(input.byteLength, 'GC byteLength');
    const totals = this.database.prepare('SELECT count(*) AS count, coalesce(sum(byte_length), 0) AS bytes FROM gc_queue')
      .get() as CountRow;
    const existing = this.database.prepare('SELECT byte_length FROM gc_queue WHERE target_id = ?').get(
      fixedBytes(input.targetId, 32, 'targetId'),
    ) as { byte_length: number } | undefined;
    if (
      totals.count + (existing === undefined ? 1 : 0) > entryLimit
      || totals.bytes! - (existing?.byte_length ?? 0) + byteLength > byteLimit
    ) {
      controlError('WAL_CONTROL_LIMIT_EXCEEDED', 'GC queue limit exceeded');
    }
    this.database.prepare(`
      INSERT INTO gc_queue(target_id, relative_path, byte_length, eligible_at_ms, state, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_id) DO UPDATE SET
        relative_path = excluded.relative_path,
        byte_length = excluded.byte_length,
        eligible_at_ms = excluded.eligible_at_ms,
        state = excluded.state
    `).run(
      fixedBytes(input.targetId, 32, 'targetId'),
      assertRelativePath(input.relativePath),
      byteLength,
      safeInteger(input.eligibleAtMs, 'GC eligibleAtMs'),
      input.state ?? 'PENDING',
      safeInteger(input.createdAtMs, 'GC createdAtMs'),
    );
  }

  /** Persist one already-verified sequence-zero author baseline atomically. */
  async installRetentionEpoch(input: InstallRetentionEpochInput): Promise<'stored' | 'replay'> {
    this.assertUsable();
    const snapshot = fixedBytes(input.snapshotObjectId, 32, 'snapshotObjectId');
    const namespace = fixedBytes(input.namespaceId, 32, 'namespaceId');
    const writer = fixedBytes(input.writerId, 20, 'writerId');
    const coveredEpoch = u64Blob(input.coveredWriterEpoch, 'coveredWriterEpoch');
    const newEpoch = u64Blob(input.newWriterEpoch, 'newWriterEpoch');
    const checkpoint = fixedBytes(input.coveredCheckpointId, 32, 'coveredCheckpointId');
    const floor = u64Blob(input.compactionFloor, 'compactionFloor');
    const graceStartedAtMs = safeInteger(input.graceStartedAtMs, 'graceStartedAtMs');
    const graceEndsAtMs = safeInteger(input.graceEndsAtMs, 'graceEndsAtMs');
    const updatedAtMs = safeInteger(input.updatedAtMs, 'updatedAtMs');
    if (input.newWriterEpoch !== input.coveredWriterEpoch + 1n || input.compactionFloor < 1n) {
      controlError(
        'WAL_CONTROL_INVALID_CONFIGURATION',
        'retention epoch must increment exactly once and carry a positive v1 compaction floor',
      );
    }
    if (graceEndsAtMs < graceStartedAtMs) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'retention grace cannot end before it starts');
    }
    return this.mutex.run(async () => {
      const existing = this.getRetentionEpoch(snapshot);
      if (existing !== null) {
        if (
          !bytesEqual(existing.namespaceId, namespace)
          || !bytesEqual(existing.writerId, writer)
          || existing.coveredWriterEpoch !== input.coveredWriterEpoch
          || existing.newWriterEpoch !== input.newWriterEpoch
          || !bytesEqual(existing.coveredCheckpointId, checkpoint)
          || existing.compactionFloor !== input.compactionFloor
          || existing.graceStartedAtMs !== graceStartedAtMs
          || existing.graceEndsAtMs !== graceEndsAtMs
        ) {
          controlError('WAL_CONTROL_IDEMPOTENCY_CONFLICT', 'snapshot retention epoch was installed with different evidence');
        }
        return 'replay';
      }
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const object = this.database.prepare(`
          SELECT namespace_id, writer_id, writer_epoch, sequence
          FROM wal_objects WHERE object_id = ?
        `).get(snapshot) as {
          namespace_id: Buffer;
          writer_id: Buffer;
          writer_epoch: Buffer;
          sequence: Buffer;
        } | undefined;
        if (
          object === undefined
          || !bytesEqual(object.namespace_id, namespace)
          || !bytesEqual(object.writer_id, writer)
          || blobU64(object.writer_epoch, 'snapshot writer epoch') !== input.newWriterEpoch
          || blobU64(object.sequence, 'snapshot sequence') !== 0n
        ) {
          controlError(
            'WAL_CONTROL_INVALID_CONFIGURATION',
            'retention baseline must be an admitted sequence-zero object at the exact new author epoch',
          );
        }
        const localCheckpoint = this.database.prepare(`
          SELECT baseline_snapshot_object_id, compaction_floor, object_count, max_sequence
          FROM checkpoints
          WHERE namespace_id = ? AND writer_id = ? AND writer_epoch = ? AND checkpoint_number = ?
        `).get(namespace, writer, newEpoch, u64Blob(0n, 'checkpointNumber')) as {
          baseline_snapshot_object_id: Buffer | null;
          compaction_floor: Buffer;
          object_count: Buffer;
          max_sequence: Buffer;
        } | undefined;
        if (
          localCheckpoint !== undefined
          && (
            localCheckpoint.baseline_snapshot_object_id === null
            || !bytesEqual(localCheckpoint.baseline_snapshot_object_id, snapshot)
            || blobU64(localCheckpoint.compaction_floor, 'checkpoint compaction floor') !== input.compactionFloor
            || blobU64(localCheckpoint.object_count, 'checkpoint object count') !== 1n
            || blobU64(localCheckpoint.max_sequence, 'checkpoint max sequence') !== 0n
          )
        ) {
          controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'new epoch checkpoint does not bind its own snapshot and floor');
        }
        this.database.prepare(`
          INSERT INTO retention_epochs(
            snapshot_object_id, namespace_id, writer_id, covered_writer_epoch,
            new_writer_epoch, covered_checkpoint_id, compaction_floor,
            grace_started_at_ms, grace_ends_at_ms, vector_id, state, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'INSTALLED', ?)
        `).run(
          snapshot,
          namespace,
          writer,
          coveredEpoch,
          newEpoch,
          checkpoint,
          floor,
          graceStartedAtMs,
          graceEndsAtMs,
          updatedAtMs,
        );
        await this.transactionHook?.('after-retention-snapshot-install');
        this.database.exec('COMMIT');
        return 'stored';
      } catch (error) {
        /* v8 ignore start -- this retention transaction cannot throw after a successful COMMIT. */
        if (this.database.inTransaction) this.database.exec('ROLLBACK');
        /* v8 ignore stop */
        throw error;
      }
    });
  }

  getRetentionEpoch(snapshotObjectId: Uint8Array): RetentionEpochRecord | null {
    this.assertUsable();
    const row = this.database.prepare(`
      SELECT snapshot_object_id, namespace_id, writer_id, covered_writer_epoch,
             new_writer_epoch, covered_checkpoint_id, compaction_floor,
             grace_started_at_ms, grace_ends_at_ms, vector_id, state, updated_at_ms
      FROM retention_epochs WHERE snapshot_object_id = ?
    `).get(fixedBytes(snapshotObjectId, 32, 'snapshotObjectId')) as RetentionEpochRow | undefined;
    return row === undefined ? null : {
      snapshotObjectId: copy(row.snapshot_object_id),
      namespaceId: copy(row.namespace_id),
      writerId: copy(row.writer_id),
      coveredWriterEpoch: blobU64(row.covered_writer_epoch, 'coveredWriterEpoch'),
      newWriterEpoch: blobU64(row.new_writer_epoch, 'newWriterEpoch'),
      coveredCheckpointId: copy(row.covered_checkpoint_id),
      compactionFloor: blobU64(row.compaction_floor, 'compactionFloor'),
      graceStartedAtMs: row.grace_started_at_ms,
      graceEndsAtMs: row.grace_ends_at_ms,
      vectorId: row.vector_id === null ? null : copy(row.vector_id),
      state: row.state,
      updatedAtMs: row.updated_at_ms,
    };
  }

  /** Verify and durably retain one signed custody receipt. */
  async recordRetentionCustodyReceipt(
    canonicalBytes: Uint8Array,
    recordedAtMs = nowValue(this.now),
  ): Promise<{ status: 'stored' | 'replay'; receiptId: Uint8Array }> {
    this.assertUsable();
    let receipt: ProtocolTuple<'SnapshotCustodyReceiptV1'>;
    try {
      receipt = decodeProtocolTuple('SnapshotCustodyReceiptV1', canonicalBytes);
      verifySingleSignedProtocolTuple('SnapshotCustodyReceiptV1', receipt);
    } catch (error) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'retention custody receipt is invalid', error);
    }
    const receiptId = protocolTupleId('SnapshotCustodyReceiptV1', receipt);
    const expiresAt = Number(receipt[6]);
    if (!Number.isSafeInteger(expiresAt) || BigInt(expiresAt) !== receipt[6]) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'custody receipt expiry exceeds durable millisecond range');
    }
    const recorded = safeInteger(recordedAtMs, 'recordedAtMs');
    return this.mutex.run(async () => {
      const replay = this.database.prepare(
        'SELECT canonical_bytes FROM retention_custody_receipts WHERE receipt_id = ?',
      ).get(receiptId) as { canonical_bytes: Buffer } | undefined;
      if (replay !== undefined) {
        if (!bytesEqual(replay.canonical_bytes, canonicalBytes)) {
          controlError('WAL_CONTROL_IDEMPOTENCY_CONFLICT', 'custody receipt ID has different canonical bytes');
        }
        return { status: 'replay', receiptId: copy(receiptId) };
      }
      this.database.exec('BEGIN IMMEDIATE');
      try {
        if (this.getRetentionEpoch(receipt[1]) === null) {
          controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'custody receipt snapshot retention epoch is not installed');
        }
        const collision = this.database.prepare(`
          SELECT 1 FROM retention_custody_receipts
          WHERE snapshot_object_id = ? AND (
            custodian_agent_address = ? OR custodian_peer_id = ?
          )
        `).get(receipt[1], receipt[2], receipt[3]);
        if (collision !== undefined) {
          controlError('WAL_CONTROL_IDEMPOTENCY_CONFLICT', 'snapshot already has a different receipt for this agent or peer');
        }
        this.database.prepare(`
          INSERT INTO retention_custody_receipts(
            receipt_id, snapshot_object_id, custodian_agent_address,
            custodian_peer_id, membership_checkpoint_id, canonical_bytes,
            expires_at_ms, recorded_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          receiptId,
          receipt[1],
          receipt[2],
          receipt[3],
          receipt[4],
          canonicalBytes,
          expiresAt,
          recorded,
        );
        await this.transactionHook?.('after-retention-receipt-persist');
        this.database.exec('COMMIT');
        return { status: 'stored', receiptId: copy(receiptId) };
      } catch (error) {
        /* v8 ignore start -- this retention transaction cannot throw after a successful COMMIT. */
        if (this.database.inTransaction) this.database.exec('ROLLBACK');
        /* v8 ignore stop */
        throw error;
      }
    });
  }

  listRetentionCustodyReceipts(snapshotObjectId: Uint8Array): readonly RetentionCustodyReceiptRecord[] {
    this.assertUsable();
    const rows = this.database.prepare(`
      SELECT receipt_id, snapshot_object_id, custodian_agent_address,
             custodian_peer_id, membership_checkpoint_id, canonical_bytes,
             expires_at_ms, recorded_at_ms
      FROM retention_custody_receipts
      WHERE snapshot_object_id = ? ORDER BY custodian_agent_address
    `).all(fixedBytes(snapshotObjectId, 32, 'snapshotObjectId')) as RetentionReceiptRow[];
    return rows.map(row => ({
      receiptId: copy(row.receipt_id),
      snapshotObjectId: copy(row.snapshot_object_id),
      custodianAgentAddress: copy(row.custodian_agent_address),
      custodianPeerId: copy(row.custodian_peer_id),
      membershipCheckpointId: copy(row.membership_checkpoint_id),
      canonicalBytes: copy(row.canonical_bytes),
      expiresAtMs: row.expires_at_ms,
      recordedAtMs: row.recorded_at_ms,
    }));
  }

  /** Bind the installed new epoch to a previously verified curator vector. */
  async bindRetentionVector(input: {
    snapshotObjectId: Uint8Array;
    vectorId: Uint8Array;
    updatedAtMs: number;
  }): Promise<'advanced' | 'unchanged'> {
    this.assertUsable();
    const snapshot = fixedBytes(input.snapshotObjectId, 32, 'snapshotObjectId');
    const vector = fixedBytes(input.vectorId, 32, 'vectorId');
    const updated = safeInteger(input.updatedAtMs, 'updatedAtMs');
    return this.mutex.run(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const epoch = this.getRetentionEpoch(snapshot);
        if (epoch === null) controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'retention epoch is not installed');
        if (epoch.vectorId !== null) {
          if (!bytesEqual(epoch.vectorId, vector)) {
            controlError('WAL_CONTROL_ROLLBACK_REJECTED', 'retention epoch cannot switch curator vectors');
          }
          this.database.exec('COMMIT');
          return 'unchanged';
        }
        const known = this.database.prepare(`
          SELECT 1 FROM collection_vectors WHERE vector_id = ?
          UNION ALL SELECT 1 FROM vectors WHERE vector_id = ? LIMIT 1
        `).get(vector, vector);
        if (known === undefined) {
          controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'retention vector must already be verified and persisted');
        }
        this.database.prepare(`
          UPDATE retention_epochs
          SET vector_id = ?, state = 'VECTOR_BOUND', updated_at_ms = ?
          WHERE snapshot_object_id = ? AND state = 'INSTALLED'
        `).run(vector, updated, snapshot);
        await this.transactionHook?.('after-retention-vector-bind');
        this.database.exec('COMMIT');
        return 'advanced';
      } catch (error) {
        /* v8 ignore start -- this retention transaction cannot throw after a successful COMMIT. */
        if (this.database.inTransaction) this.database.exec('ROLLBACK');
        /* v8 ignore stop */
        throw error;
      }
    });
  }

  /**
   * Atomically advance the serving floor after fresh custody verification.
   * The caller passes the exact receipt IDs returned by the fail-closed
   * retention verifier and every complete old-epoch WalObject ID under floor.
   */
  async markRetentionGcEligible(input: {
    snapshotObjectId: Uint8Array;
    verifiedReceiptIds: readonly Uint8Array[];
    coveredObjectIds: readonly Uint8Array[];
    evaluatedAtMs: number;
  }): Promise<'advanced' | 'unchanged'> {
    this.assertUsable();
    const snapshot = fixedBytes(input.snapshotObjectId, 32, 'snapshotObjectId');
    const evaluated = safeInteger(input.evaluatedAtMs, 'evaluatedAtMs');
    const receiptIds = input.verifiedReceiptIds.map((value, index) =>
      Buffer.from(fixedBytes(value, 32, `verifiedReceiptIds[${index}]`)));
    const objectIds = input.coveredObjectIds.map((value, index) =>
      Buffer.from(fixedBytes(value, 32, `coveredObjectIds[${index}]`)));
    if (new Set(receiptIds.map(value => value.toString('hex'))).size !== receiptIds.length || receiptIds.length < 2) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'GC floor requires at least two distinct verified receipts');
    }
    if (new Set(objectIds.map(value => value.toString('hex'))).size !== objectIds.length) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'covered GC object IDs must be unique');
    }
    return this.mutex.run(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const epoch = this.getRetentionEpoch(snapshot);
        if (epoch === null || epoch.vectorId === null) {
          controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'GC floor requires an installed vector-bound retention epoch');
        }
        if (epoch.state === 'GC_ELIGIBLE' || epoch.state === 'GC_COMPLETE') {
          this.database.exec('COMMIT');
          return 'unchanged';
        }
        if (epoch.state !== 'VECTOR_BOUND' || evaluated < epoch.graceEndsAtMs) {
          controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'GC floor cannot advance before vector binding and grace expiry');
        }
        if (BigInt(objectIds.length) !== epoch.compactionFloor) {
          controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'GC object count must equal the v1 compaction floor');
        }
        for (const receiptId of receiptIds) {
          const receipt = this.database.prepare(`
            SELECT expires_at_ms FROM retention_custody_receipts
            WHERE receipt_id = ? AND snapshot_object_id = ?
          `).get(receiptId, snapshot) as { expires_at_ms: number } | undefined;
          if (receipt === undefined || receipt.expires_at_ms < evaluated) {
            controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'verified custody receipt is missing, stale, or expired');
          }
        }
        for (const objectId of objectIds) {
          const object = this.database.prepare(`
            SELECT namespace_id, writer_id, writer_epoch, sequence
            FROM wal_objects WHERE object_id = ?
          `).get(objectId) as {
            namespace_id: Buffer;
            writer_id: Buffer;
            writer_epoch: Buffer;
            sequence: Buffer;
          } | undefined;
          if (
            object === undefined
            || !bytesEqual(object.namespace_id, epoch.namespaceId)
            || !bytesEqual(object.writer_id, epoch.writerId)
            || blobU64(object.writer_epoch, 'GC writer epoch') !== epoch.coveredWriterEpoch
            || blobU64(object.sequence, 'GC sequence') >= epoch.compactionFloor
          ) {
            controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'GC target is not an exact covered old-epoch object');
          }
          this.database.prepare(`
            INSERT INTO retention_gc_objects(snapshot_object_id, object_id, state, updated_at_ms)
            VALUES (?, ?, 'ELIGIBLE', ?)
          `).run(snapshot, objectId, evaluated);
        }
        this.database.prepare(`
          UPDATE retention_epochs SET state = 'GC_ELIGIBLE', updated_at_ms = ?
          WHERE snapshot_object_id = ? AND state = 'VECTOR_BOUND'
        `).run(evaluated, snapshot);
        await this.transactionHook?.('after-retention-floor-advance');
        this.database.exec('COMMIT');
        return 'advanced';
      } catch (error) {
        /* v8 ignore start -- this retention transaction cannot throw after a successful COMMIT. */
        if (this.database.inTransaction) this.database.exec('ROLLBACK');
        /* v8 ignore stop */
        throw error;
      }
    });
  }

  listRetentionGcObjects(snapshotObjectId: Uint8Array): readonly RetentionGcObjectRecord[] {
    this.assertUsable();
    const snapshot = fixedBytes(snapshotObjectId, 32, 'snapshotObjectId');
    const rows = this.database.prepare(`
      SELECT snapshot_object_id, object_id, state, updated_at_ms
      FROM retention_gc_objects WHERE snapshot_object_id = ? ORDER BY object_id
    `).all(snapshot) as Array<{
      snapshot_object_id: Buffer;
      object_id: Buffer;
      state: RetentionGcObjectRecord['state'];
      updated_at_ms: number;
    }>;
    return rows.map(row => ({
      snapshotObjectId: copy(row.snapshot_object_id),
      objectId: copy(row.object_id),
      state: row.state,
      updatedAtMs: row.updated_at_ms,
    }));
  }

  /** Mark complete only after PackedWalObjectStore made every target unavailable. */
  async completeRetentionGc(input: {
    snapshotObjectId: Uint8Array;
    completedAtMs: number;
  }): Promise<'advanced' | 'unchanged'> {
    this.assertUsable();
    const snapshot = fixedBytes(input.snapshotObjectId, 32, 'snapshotObjectId');
    const completed = safeInteger(input.completedAtMs, 'completedAtMs');
    return this.mutex.run(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const epoch = this.getRetentionEpoch(snapshot);
        if (epoch === null) controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'retention epoch is not installed');
        if (epoch.state === 'GC_COMPLETE') {
          this.database.exec('COMMIT');
          return 'unchanged';
        }
        if (epoch.state !== 'GC_ELIGIBLE') {
          controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'physical GC was not authorized');
        }
        const counts = this.database.prepare(`
          SELECT count(*) AS total,
                 sum(CASE WHEN t.object_id IS NULL THEN 0 ELSE 1 END) AS retired
          FROM retention_gc_objects g
          LEFT JOIN packed_gc_tombstones t ON t.object_id = g.object_id
          WHERE g.snapshot_object_id = ?
        `).get(snapshot) as { total: number; retired: number | null };
        if (BigInt(counts.total) !== epoch.compactionFloor || counts.retired !== counts.total) {
          controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'every eligible object must be durably unavailable before GC completion');
        }
        this.database.prepare(`
          UPDATE retention_gc_objects SET state = 'RETIRED', updated_at_ms = ?
          WHERE snapshot_object_id = ? AND state = 'ELIGIBLE'
        `).run(completed, snapshot);
        this.database.prepare(`
          UPDATE retention_epochs SET state = 'GC_COMPLETE', updated_at_ms = ?
          WHERE snapshot_object_id = ? AND state = 'GC_ELIGIBLE'
        `).run(completed, snapshot);
        await this.transactionHook?.('after-retention-gc-complete');
        this.database.exec('COMMIT');
        return 'advanced';
      } catch (error) {
        /* v8 ignore start -- this retention transaction cannot throw after a successful COMMIT. */
        if (this.database.inTransaction) this.database.exec('ROLLBACK');
        /* v8 ignore stop */
        throw error;
      }
    });
  }

  getRollbackHighWater(collectionId: Uint8Array): RollbackHighWater | null {
    this.assertUsable();
    const collection = fixedBytes(collectionId, 32, 'collectionId');
    const row = this.rollbackDatabase!.prepare(`
      SELECT vector_epoch, vector_number, vector_id, updated_at_ms FROM high_water WHERE collection_id = ?
    `).get(collection) as { vector_epoch: Buffer; vector_number: Buffer; vector_id: Buffer; updated_at_ms: number } | undefined;
    return row === undefined ? null : {
      collectionId: copy(collection),
      vectorEpoch: blobU64(row.vector_epoch, 'vectorEpoch'),
      vectorNumber: blobU64(row.vector_number, 'vectorNumber'),
      vectorId: copy(row.vector_id),
      updatedAtMs: row.updated_at_ms,
    };
  }

  setRollbackHighWater(input: RollbackHighWater): 'advanced' | 'unchanged' {
    this.assertUsable();
    const collection = fixedBytes(input.collectionId, 32, 'collectionId');
    const vectorId = fixedBytes(input.vectorId, 32, 'vectorId');
    const epoch = u64Blob(input.vectorEpoch, 'vectorEpoch');
    const number = u64Blob(input.vectorNumber, 'vectorNumber');
    const updatedAtMs = safeInteger(input.updatedAtMs, 'updatedAtMs');
    const current = this.getRollbackHighWater(collection);
    if (current !== null) {
      const lower = input.vectorEpoch < current.vectorEpoch
        || (input.vectorEpoch === current.vectorEpoch && input.vectorNumber < current.vectorNumber);
      if (lower) controlError('WAL_CONTROL_ROLLBACK_REJECTED', 'rollback high-water cannot decrease');
      if (input.vectorEpoch === current.vectorEpoch && input.vectorNumber === current.vectorNumber) {
        if (!bytesEqual(input.vectorId, current.vectorId)) {
          controlError('WAL_CONTROL_ROLLBACK_REJECTED', 'one vector position cannot have two vector IDs');
        }
        return 'unchanged';
      }
    }
    this.rollbackDatabase!.prepare(`
      INSERT INTO high_water(collection_id, vector_epoch, vector_number, vector_id, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(collection_id) DO UPDATE SET
        vector_epoch = excluded.vector_epoch,
        vector_number = excluded.vector_number,
        vector_id = excluded.vector_id,
        updated_at_ms = excluded.updated_at_ms
    `).run(collection, epoch, number, vectorId, updatedAtMs);
    return 'advanced';
  }

  rollbackProtectionStatus(): RollbackProtectionStatus {
    this.assertOpen();
    if (this.blockedReason !== undefined) return { state: 'blocked', reason: this.blockedReason };
    if (this.rollbackDatabase === undefined) return { state: 'blocked', reason: 'rollback-high-water-unavailable' };
    return { state: 'available' };
  }

  /**
   * Trusted WAL-007 boundary. The caller must threshold-verify the matching
   * RollbackRecoveryV1 and required-cohort minimum before invoking this method.
   */
  installVerifiedRollbackRecovery(input: RollbackHighWater): void {
    this.assertOpen();
    const collection = fixedBytes(input.collectionId, 32, 'collectionId');
    const vectorId = fixedBytes(input.vectorId, 32, 'vectorId');
    const epoch = u64Blob(input.vectorEpoch, 'vectorEpoch');
    const number = u64Blob(input.vectorNumber, 'vectorNumber');
    const updatedAtMs = safeInteger(input.updatedAtMs, 'updatedAtMs');
    if (this.blockedReason !== 'rollback-high-water-missing' || existsSync(this.rollbackPath)) {
      controlError('WAL_CONTROL_BLOCKED', 'rollback recovery is allowed only for a confirmed missing high-water file');
    }
    const guard = this.database.prepare('SELECT guard_id FROM rollback_guard WHERE singleton = 1').get() as
      GuardRow | undefined;
    if (guard === undefined) controlError('WAL_CONTROL_CORRUPT', 'control database has no rollback guard to recover');
    this.createRollbackDatabase(guard.guard_id, this.busyTimeoutMs);
    this.rollbackDatabase!.prepare(`
      INSERT INTO high_water(collection_id, vector_epoch, vector_number, vector_id, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(collection, epoch, number, vectorId, updatedAtMs);
    this.blockedReason = undefined;
  }

  integrityScan(): WalControlIntegrity {
    this.assertOpen();
    const reasons: string[] = [];
    let objects = 0;
    let checkpoints = 0;
    let queued = 0;
    let quarantinedBytes = 0;
    if (this.blockedReason !== undefined) reasons.push(this.blockedReason);
    try {
      const check = this.database.prepare('PRAGMA quick_check').get() as IntegrityRow;
      if (check.quick_check !== 'ok') reasons.push(`sqlite:${check.quick_check}`);
      const foreignKeys = this.database.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeys.length > 0) reasons.push(`foreign-keys:${foreignKeys.length}`);
      const physical = this.database.prepare(`
        SELECT count(*) AS count FROM wal_objects w
        LEFT JOIN objects o ON o.object_id = w.object_id
        WHERE o.object_id IS NULL OR o.object_length != w.canonical_length
      `).get() as CountRow;
      if (physical.count > 0) reasons.push(`physical-objects:${physical.count}`);
      const lanes = this.database.prepare(`
        SELECT namespace_id, writer_id, writer_epoch, current_set_root, object_count
        FROM author_lanes
      `).all() as Array<{
        namespace_id: Buffer;
        writer_id: Buffer;
        writer_epoch: Buffer;
        current_set_root: Buffer;
        object_count: Buffer;
      }>;
      for (const lane of lanes) {
        try {
          const commitment = this.restoreCommitment(
            lane.namespace_id,
            lane.writer_id,
            lane.writer_epoch,
            lane.current_set_root,
          );
          if (BigInt(commitment.size) !== blobU64(lane.object_count, 'lane object count')) {
            reasons.push('set-count');
          }
          const rows = this.database.prepare(`
            SELECT object_id FROM wal_objects
            WHERE namespace_id = ? AND writer_id = ? AND writer_epoch = ? ORDER BY object_id
          `).all(lane.namespace_id, lane.writer_id, lane.writer_epoch) as Array<{ object_id: Buffer }>;
          const ids = commitment.ids();
          if (rows.length !== ids.length || rows.some((row, index) => !bytesEqual(row.object_id, ids[index]!))) {
            reasons.push('set-membership');
          }
        } catch {
          reasons.push('set-snapshot');
        }
      }
      objects = (this.database.prepare('SELECT count(*) AS count FROM wal_objects').get() as CountRow).count;
      checkpoints = (this.database.prepare('SELECT count(*) AS count FROM checkpoints').get() as CountRow).count;
      queued = (this.database.prepare('SELECT count(*) AS count FROM retry_queue').get() as CountRow).count;
      quarantinedBytes = (this.database.prepare(
        'SELECT count(*) AS count, coalesce(sum(byte_length), 0) AS bytes FROM quarantine',
      ).get() as CountRow).bytes!;
    } catch (error) {
      reasons.push(`scan:${String(error instanceof Error ? error.message : error)}`);
    }
    const result: WalControlIntegrity = {
      state: reasons.length === 0 ? 'complete' : 'blocked',
      reasons,
      objects,
      checkpoints,
      queued,
      quarantinedBytes,
    };
    if (result.state === 'blocked' && this.blockedReason === undefined) this.blockedReason = 'integrity-scan-blocked';
    return result;
  }

  private assertPackedSchema(): void {
    const version = this.database.pragma('user_version', { simple: true }) as number;
    const objectTable = this.database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'objects'
    `).get();
    if (version !== 1 || objectTable === undefined) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'WalControlStore requires a version-1 PackedWalObjectStore index');
    }
    this.database.exec(PACKED_GC_SCHEMA_SQL);
  }

  private migrate(hook?: () => void): void {
    const table = this.database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wal_control_schema'
    `).get();
    if (table !== undefined) {
      const row = this.database.prepare('SELECT version FROM wal_control_schema WHERE singleton = 1').get() as
        VersionRow | undefined;
      let version = row?.version;
      if (version === undefined || version < 1 || version > WAL_CONTROL_SCHEMA_VERSION) {
        controlError('WAL_CONTROL_UNSUPPORTED_SCHEMA', `unsupported WAL control schema version ${version ?? 'missing'}`);
      }
      for (const migration of [
        { from: 1, sql: WAL_CONTROL_MIGRATION_1_TO_2_SQL },
        { from: 2, sql: WAL_CONTROL_MIGRATION_2_TO_3_SQL },
        { from: 3, sql: WAL_CONTROL_MIGRATION_3_TO_4_SQL },
        { from: 4, sql: WAL_CONTROL_MIGRATION_4_TO_5_SQL },
        { from: 5, sql: WAL_CONTROL_MIGRATION_5_TO_6_SQL },
        { from: 6, sql: WAL_CONTROL_MIGRATION_6_TO_7_SQL },
      ]) {
        if (version !== migration.from) continue;
        this.database.exec('BEGIN IMMEDIATE');
        try {
          this.database.exec(migration.sql);
          hook?.();
          this.database.exec('COMMIT');
          version += 1;
        } catch (error) {
          this.database.exec('ROLLBACK');
          throw error;
        }
      }
      return;
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(WAL_CONTROL_SCHEMA_SQL);
      hook?.();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private openRollbackDatabase(busyTimeoutMs: number): void {
    const controlGuard = this.database.prepare('SELECT guard_id FROM rollback_guard WHERE singleton = 1').get() as
      GuardRow | undefined;
    if (!existsSync(this.rollbackPath)) {
      if (controlGuard !== undefined) {
        this.blockedReason = 'rollback-high-water-missing';
        return;
      }
      const guard = randomBytes(16);
      this.createRollbackDatabase(guard, busyTimeoutMs);
      this.database.prepare('INSERT INTO rollback_guard(singleton, guard_id, created_at_ms) VALUES (1, ?, ?)')
        .run(guard, nowValue(this.now));
      return;
    }
    assertRegularFile(this.rollbackPath, 'rollback high-water database');
    const rollback = new Database(this.rollbackPath);
    this.rollbackDatabase = rollback;
    rollback.pragma(`busy_timeout = ${busyTimeoutMs}`);
    rollback.pragma('journal_mode = WAL');
    rollback.pragma('synchronous = FULL');
    const table = rollback.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rollback_schema'
    `).get();
    const version = table === undefined
      ? undefined
      : (rollback.prepare('SELECT version FROM rollback_schema WHERE singleton = 1').get() as VersionRow | undefined)?.version;
    if (version !== WAL_ROLLBACK_SCHEMA_VERSION) {
      this.blockedReason = `rollback-high-water-schema:${version ?? 'missing'}`;
      return;
    }
    const rollbackGuard = rollback.prepare('SELECT guard_id FROM guard WHERE singleton = 1').get() as GuardRow | undefined;
    if (rollbackGuard === undefined) {
      this.blockedReason = 'rollback-high-water-guard-missing';
      return;
    }
    if (controlGuard === undefined) {
      this.database.prepare('INSERT INTO rollback_guard(singleton, guard_id, created_at_ms) VALUES (1, ?, ?)')
        .run(rollbackGuard.guard_id, nowValue(this.now));
    } else if (!bytesEqual(controlGuard.guard_id, rollbackGuard.guard_id)) {
      this.blockedReason = 'rollback-high-water-guard-mismatch';
    }
  }

  private createRollbackDatabase(guard: Uint8Array, busyTimeoutMs: number): void {
    const rollback = new Database(this.rollbackPath);
    this.rollbackDatabase = rollback;
    rollback.pragma(`busy_timeout = ${busyTimeoutMs}`);
    rollback.pragma('journal_mode = WAL');
    rollback.pragma('synchronous = FULL');
    rollback.exec('BEGIN IMMEDIATE');
    try {
      rollback.exec(WAL_ROLLBACK_SCHEMA_SQL);
      rollback.prepare('INSERT INTO guard(singleton, guard_id) VALUES (1, ?)').run(Buffer.from(guard));
      rollback.exec('COMMIT');
    } catch (error) {
      /* v8 ignore start -- requires an injected SQLite/filesystem failure during first-file creation. */
      if (rollback.inTransaction) rollback.exec('ROLLBACK');
      throw error;
      /* v8 ignore stop */
    }
    chmodSync(this.rollbackPath, 0o600);
    fsyncDirectory(this.root);
  }

  private restoreCommitment(
    namespace: Uint8Array,
    writer: Uint8Array,
    epoch: Uint8Array,
    root: Uint8Array,
  ): MutableSetCommitment {
    const row = this.database.prepare(`
      SELECT node_bytes, object_count FROM set_commitment_nodes
      WHERE namespace_id = ? AND writer_id = ? AND writer_epoch = ? AND root_hash = ? AND node_key = X''
    `).get(namespace, writer, epoch, root) as RootNodeRow | undefined;
    if (row === undefined) controlError('WAL_CONTROL_CORRUPT', 'author lane references a missing set commitment root');
    const commitment = MutableSetCommitment.restore(row.node_bytes);
    if (!bytesEqual(commitment.root, root) || BigInt(commitment.size) !== blobU64(row.object_count, 'set object count')) {
      controlError('WAL_CONTROL_CORRUPT', 'stored set commitment snapshot does not match its root metadata');
    }
    return commitment;
  }

  private recoverQueues(now: number): void {
    this.database.prepare(`
      UPDATE retry_queue SET state = 'READY', lease_until_ms = NULL, updated_at_ms = ?
      WHERE state = 'LEASED' AND lease_until_ms <= ?
    `).run(now, now);
  }

  private assertOpen(): void {
    if (this.closed) controlError('WAL_CONTROL_IO', 'WalControlStore is closed');
  }

  private assertUsable(): void {
    this.assertOpen();
    if (this.blockedReason !== undefined) controlError('WAL_CONTROL_BLOCKED', this.blockedReason);
    if (this.rollbackDatabase === undefined) controlError('WAL_CONTROL_BLOCKED', 'rollback high-water unavailable');
  }

  private wrapIo(message: string, error: unknown): never {
    if (error instanceof WalControlStoreError) throw error;
    return controlError('WAL_CONTROL_IO', message, error);
  }
}
