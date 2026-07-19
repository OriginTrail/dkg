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
import { decodeProtocolTuple, encodeProtocolTuple } from '../protocol/codec.js';
import { protocolTupleId } from '../protocol/hashes.js';
import { verifySingleSignedProtocolTuple } from '../protocol/signatures.js';
import type { ProtocolTuple } from '../protocol/schema.js';
import type { WalObjectV1 } from '../protocol/wal-object.js';
import { MutableSetCommitment } from '../reconciliation/set-commitment.js';
import { controlError, WalControlStoreError } from './errors.js';
import { blobU64, bytesEqual, fixedBytes, MAX_U64, safeInteger, u64Blob } from './integers.js';
import {
  WAL_CONTROL_SCHEMA_SQL,
  WAL_CONTROL_SCHEMA_VERSION,
  WAL_ROLLBACK_SCHEMA_SQL,
  WAL_ROLLBACK_SCHEMA_VERSION,
} from './schema.js';
import type {
  FinalizeLocalWalInput,
  FinalizeLocalWalResult,
  GcQueueRecord,
  IbltCacheRecord,
  MaterializationRecord,
  ObjectRangeRecord,
  PeerStateRecord,
  RetryState,
  RetryQueueEntry,
  RollbackHighWater,
  VectorRecord,
  WalControlIntegrity,
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

export type WalControlTransactionPoint =
  | 'after-object-insert'
  | 'after-set-update'
  | 'after-checkpoint-insert'
  | 'before-commit'
  | 'after-commit'
  | 'after-rollback';

export interface WalControlStoreOptions {
  root: string;
  busyTimeoutMs?: number;
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

class AsyncMutex {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolvePromise => { release = resolvePromise; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const mutexes = new Map<string, AsyncMutex>();

function mutexFor(path: string): AsyncMutex {
  let mutex = mutexes.get(path);
  if (mutex === undefined) {
    mutex = new AsyncMutex();
    mutexes.set(path, mutex);
  }
  return mutex;
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
  readonly rollbackPath: string;
  readonly maximumQueueEntries: number;
  readonly maximumQueueBytes: number;
  readonly maximumQuarantineEntriesPerPeer: number;
  readonly maximumQuarantineBytesPerPeer: number;
  readonly quarantineRetentionMs: number;
  private readonly database!: Database.Database;
  private rollbackDatabase?: Database.Database;
  private readonly mutex: AsyncMutex;
  private readonly now: () => number;
  private readonly transactionHook?: WalControlStoreOptions['transactionHook'];
  private blockedReason?: string;
  private closed = false;

  constructor(options: WalControlStoreOptions) {
    if (typeof options?.root !== 'string' || options.root.trim().length === 0 || !isAbsolute(options.root)) {
      controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'WalControlStore root must be an absolute path');
    }
    this.root = resolve(options.root);
    this.indexPath = join(this.root, 'objects.sqlite');
    this.rollbackPath = join(this.root, 'rollback-high-water.sqlite');
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
    this.now = options.now ?? Date.now;
    this.transactionHook = options.transactionHook;
    this.mutex = mutexFor(this.indexPath);
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
          proof_bytes = excluded.proof_bytes,
          closure_bytes = excluded.closure_bytes,
          provider_peer_id = excluded.provider_peer_id,
          updated_at_ms = excluded.updated_at_ms
        WHERE admission.state = 'STAGED'
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

  admitRemoteBatch(inputs: readonly AdmitRemoteObjectInput[], updatedAtMs = nowValue(this.now)): void {
    this.assertUsable();
    safeInteger(updatedAtMs, 'updatedAtMs');
    if (inputs.length === 0) controlError('WAL_CONTROL_INVALID_CONFIGURATION', 'remote admission batch cannot be empty');
    const verified = inputs.map(input => ({
      input,
      metadata: verifyObjectMetadata(input.objectId, input.object, input.canonicalLength),
    }));
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const present = this.database.prepare('SELECT object_length FROM objects WHERE object_id = ?');
      const insert = this.database.prepare(`
        INSERT OR IGNORE INTO wal_objects(
          object_id, namespace_id, writer_id, writer_epoch, sequence,
          previous_object_id, payload_length, canonical_length, origin, admitted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        insert.run(
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
        if (admit.run(updatedAtMs, metadata.id).changes !== 1) {
          controlError('WAL_CONTROL_LANE_CONFLICT', 'remote WalObject was not in staged admission state');
        }
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof WalControlStoreError) throw error;
      return this.wrapIo('failed to admit remote WAL batch', error);
    }
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

  cleanupExpired(now = nowValue(this.now)): { ranges: number; cache: number; quarantine: number } {
    this.assertOpen();
    safeInteger(now, 'now');
    return {
      ranges: this.database.prepare('DELETE FROM object_ranges WHERE expires_at_ms <= ?').run(now).changes,
      cache: this.database.prepare('DELETE FROM iblt_cache WHERE expires_at_ms <= ?').run(now).changes,
      quarantine: this.database.prepare('DELETE FROM quarantine WHERE expires_at_ms <= ?').run(now).changes,
    };
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
    this.database.prepare(`
      INSERT INTO materialization(
        logical_key, desired_heads_digest, desired_state_digest,
        applied_heads_digest, applied_state_digest, status,
        attempts, retry_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(logical_key) DO UPDATE SET
        desired_heads_digest = excluded.desired_heads_digest,
        desired_state_digest = excluded.desired_state_digest,
        applied_heads_digest = excluded.applied_heads_digest,
        applied_state_digest = excluded.applied_state_digest,
        status = excluded.status,
        attempts = excluded.attempts,
        retry_at_ms = excluded.retry_at_ms,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      fixedBytes(input.logicalKey, 32, 'logicalKey'),
      fixedBytes(input.desiredHeadsDigest, 32, 'desiredHeadsDigest'),
      fixedBytes(input.desiredStateDigest, 32, 'desiredStateDigest'),
      input.appliedHeadsDigest === undefined || input.appliedHeadsDigest === null
        ? null
        : fixedBytes(input.appliedHeadsDigest, 32, 'appliedHeadsDigest'),
      input.appliedStateDigest === undefined || input.appliedStateDigest === null
        ? null
        : fixedBytes(input.appliedStateDigest, 32, 'appliedStateDigest'),
      input.status,
      safeInteger(input.attempts, 'materialization attempts'),
      safeInteger(input.retryAtMs, 'materialization retryAtMs'),
      safeInteger(input.updatedAtMs, 'materialization updatedAtMs'),
    );
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
  }

  private migrate(hook?: () => void): void {
    const table = this.database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wal_control_schema'
    `).get();
    if (table !== undefined) {
      const row = this.database.prepare('SELECT version FROM wal_control_schema WHERE singleton = 1').get() as
        VersionRow | undefined;
      if (row?.version !== WAL_CONTROL_SCHEMA_VERSION) {
        controlError('WAL_CONTROL_UNSUPPORTED_SCHEMA', `unsupported WAL control schema version ${row?.version ?? 'missing'}`);
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
