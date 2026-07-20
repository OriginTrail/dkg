import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
} from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { walObjectId, type WalObjectId } from '../reconciliation/ids.js';
import { WalObjectStoreError, storeError } from './errors.js';
import {
  PACKED_DEFAULT_BUFFER_BYTES,
  PACKED_DEFAULT_MAXIMUM_OBJECT_BYTES,
  PACKED_DEFAULT_SEGMENT_TARGET_BYTES,
  PACKED_HARD_MAXIMUM_OBJECT_BYTES,
  PACKED_RECORD_HEADER_BYTES,
  PACKED_SEGMENT_HEADER_BYTES,
  PACKED_STORE_SCHEMA_VERSION,
  PACKED_GC_SCHEMA_SQL,
  PackedObjectTransactionAppend,
  createPackedSegmentFile,
  packedRecordMagicMatches,
  packedSegmentMagicMatches,
  packedSegmentName,
  writePackedBytes,
  packedWriteMutexFor,
  type PackedSegmentRow,
} from './packed-transaction.js';
import { verifyWalObjectFile } from './streaming-verifier.js';
import { WalObjectStore } from './types.js';

interface ObjectRow {
  object_id: Buffer;
  segment_id: number;
  object_offset: number;
  object_length: number;
}

export type PackedWalObjectStoreGcPoint =
  | 'tombstones-written'
  | 'gc-index-committed'
  | 'gc-segment-files-removed';

export interface PackedWalObjectStoreGcResult {
  readonly newlyRetiredObjects: number;
  readonly alreadyRetiredObjects: number;
  readonly physicallyRemovedSegmentIds: readonly number[];
  readonly deferredSegmentIds: readonly number[];
}

export type PackedWalObjectStoreDurabilityPoint =
  | 'candidate-file-synced'
  | 'segment-file-synced'
  | 'before-index-commit'
  | 'index-committed';

export interface PackedWalObjectStoreOptions {
  root: string;
  maximumObjectBytes?: bigint;
  segmentTargetBytes?: number;
  readBufferBytes?: number;
  verificationBufferBytes?: number;
  busyTimeoutMs?: number;
  durabilityHook?: (point: PackedWalObjectStoreDurabilityPoint) => void | Promise<void>;
}

function assertId(id: Uint8Array): asserts id is WalObjectId {
  if (!(id instanceof Uint8Array) || id.length !== 32) {
    storeError('WAL_STORE_INVALID_OBJECT_ID', 'WalObjectId must be exactly 32 bytes');
  }
}

function idBuffer(id: WalObjectId): Buffer {
  return Buffer.from(id.buffer, id.byteOffset, id.byteLength);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  /* v8 ignore start -- every call compares fixed-width protocol or local-format fields. */
  if (left.length !== right.length) return false;
  /* v8 ignore stop */
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function kind(path: string): 'missing' | 'file' | 'directory' | 'unsafe' {
  try {
    const details = lstatSync(path);
    if (details.isSymbolicLink()) return 'unsafe';
    if (details.isFile()) return 'file';
    if (!details.isDirectory()) return 'unsafe';
    return 'directory';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return 'missing';
  }
}

function ensureDirectory(path: string): void {
  const current = kind(path);
  if (current === 'file' || current === 'unsafe') {
    storeError('WAL_STORE_PATH_UNSAFE', 'packed WalObjectStore paths must be real directories');
  }
  if (current === 'missing') mkdirSync(path, { recursive: true, mode: 0o700 });
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function validateInteger(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    storeError('WAL_STORE_INVALID_CONFIGURATION', `${name} must be an integer in ${minimum}..${maximum}`);
  }
}

/**
 * Local packed storage. Segment IDs, record headers, offsets, and SQLite rows
 * are implementation details; WalObjectV1 remains the sole synchronization and
 * content-addressed atom.
 */
export class PackedWalObjectStore extends WalObjectStore {
  readonly root: string;
  readonly segmentsRoot: string;
  readonly stagingRoot: string;
  readonly indexPath: string;
  readonly maximumObjectBytes: bigint;
  readonly segmentTargetBytes: number;
  readonly readBufferBytes: number;
  readonly verificationBufferBytes: number;
  private readonly database!: Database.Database;
  private readonly mutex: ReturnType<typeof packedWriteMutexFor>;
  private readonly durabilityHook?: PackedWalObjectStoreOptions['durabilityHook'];
  private closed = false;

  constructor(options: PackedWalObjectStoreOptions) {
    super();
    if (typeof options?.root !== 'string' || options.root.trim().length === 0 || !isAbsolute(options.root)) {
      storeError('WAL_STORE_INVALID_CONFIGURATION', 'packed WalObjectStore root must be an absolute path');
    }
    const maximumObjectBytes = options.maximumObjectBytes ?? PACKED_DEFAULT_MAXIMUM_OBJECT_BYTES;
    if (maximumObjectBytes < 1n || maximumObjectBytes > PACKED_HARD_MAXIMUM_OBJECT_BYTES) {
      storeError('WAL_STORE_INVALID_CONFIGURATION', 'maximumObjectBytes must be within the WAL v1 hard limit');
    }
    const segmentTargetBytes = options.segmentTargetBytes ?? PACKED_DEFAULT_SEGMENT_TARGET_BYTES;
    const readBufferBytes = options.readBufferBytes ?? PACKED_DEFAULT_BUFFER_BYTES;
    const verificationBufferBytes = options.verificationBufferBytes ?? PACKED_DEFAULT_BUFFER_BYTES;
    const busyTimeoutMs = options.busyTimeoutMs ?? 30_000;
    validateInteger('segmentTargetBytes', segmentTargetBytes, 128, 8_590_000_128);
    validateInteger('readBufferBytes', readBufferBytes, 1, 1_048_576);
    validateInteger('verificationBufferBytes', verificationBufferBytes, 1, 1_048_576);
    validateInteger('busyTimeoutMs', busyTimeoutMs, 1, 300_000);

    this.root = resolve(options.root);
    this.segmentsRoot = join(this.root, 'segments');
    this.stagingRoot = join(this.root, 'staging');
    this.indexPath = join(this.root, 'objects.sqlite');
    this.maximumObjectBytes = maximumObjectBytes;
    this.segmentTargetBytes = segmentTargetBytes;
    this.readBufferBytes = readBufferBytes;
    this.verificationBufferBytes = verificationBufferBytes;
    this.durabilityHook = options.durabilityHook;
    this.mutex = packedWriteMutexFor(this.root);

    let opened: Database.Database | undefined;
    try {
      ensureDirectory(this.root);
      ensureDirectory(this.segmentsRoot);
      ensureDirectory(this.stagingRoot);
      const indexKind = kind(this.indexPath);
      if (indexKind === 'directory' || indexKind === 'unsafe') {
        storeError('WAL_STORE_PATH_UNSAFE', 'packed WalObjectStore index must be a regular file');
      }
      opened = new Database(this.indexPath);
      this.database = opened;
      this.database.pragma(`busy_timeout = ${busyTimeoutMs}`);
      this.database.pragma('foreign_keys = ON');
      this.database.pragma('journal_mode = WAL');
      this.database.pragma('synchronous = FULL');
      this.initializeSchema();
      this.recover();
    } catch (error) {
      opened?.close();
      if (error instanceof WalObjectStoreError) throw error;
      return storeError('WAL_STORE_IO', 'failed to open packed WalObjectStore', error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  async has(id: WalObjectId): Promise<boolean> {
    assertId(id);
    this.assertOpen();
    try {
      return this.database.prepare(`
        SELECT 1 FROM objects o
        LEFT JOIN packed_gc_tombstones g ON g.object_id = o.object_id
        WHERE o.object_id = ? AND g.object_id IS NULL
      `).get(idBuffer(id)) !== undefined;
    } catch (error) {
      return storeError('WAL_STORE_IO', 'failed to query packed WalObjectStore', error);
    }
  }

  async *read(id: WalObjectId, offset = 0n, length?: number): AsyncIterable<Uint8Array> {
    assertId(id);
    this.assertOpen();
    if (typeof offset !== 'bigint' || offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) {
      return storeError('WAL_STORE_INVALID_READ_RANGE', 'WalObject read offset is outside the supported range');
    }
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
      return storeError('WAL_STORE_INVALID_READ_RANGE', 'WalObject read length must be a non-negative safe integer');
    }
    let row: ObjectRow | undefined;
    try {
      row = this.database.prepare(
        `SELECT o.object_id, o.segment_id, o.object_offset, o.object_length
         FROM objects o LEFT JOIN packed_gc_tombstones g ON g.object_id = o.object_id
         WHERE o.object_id = ? AND g.object_id IS NULL`,
      ).get(idBuffer(id)) as ObjectRow | undefined;
    } catch (error) {
      return storeError('WAL_STORE_IO', 'failed to query packed WalObjectStore', error);
    }
    if (row === undefined) return storeError('WAL_STORE_OBJECT_NOT_FOUND', 'WalObject is not present');
    if (offset > BigInt(row.object_length)) {
      return storeError('WAL_STORE_INVALID_READ_RANGE', 'WalObject read offset exceeds object length');
    }
    const end = Math.min(length === undefined ? row.object_length : Number(offset) + length, row.object_length);
    let handle;
    try {
      handle = await open(this.segmentPath(row.segment_id), constants.O_RDONLY | constants.O_NOFOLLOW);
      const details = await handle.stat();
      if (!details.isFile() || details.size < row.object_offset + row.object_length) {
        return storeError('WAL_STORE_CORRUPT', 'packed segment is truncated or not a regular file');
      }
      const header = new Uint8Array(PACKED_RECORD_HEADER_BYTES);
      const headerRead = await handle.read(header, 0, header.length, row.object_offset - PACKED_RECORD_HEADER_BYTES);
      if (
        headerRead.bytesRead !== header.length
        || !packedRecordMagicMatches(header)
        || !equalBytes(header.subarray(8, 40), id)
        || new DataView(header.buffer).getBigUint64(40, false) !== BigInt(row.object_length)
      ) {
        return storeError('WAL_STORE_CORRUPT', 'packed segment record header does not match the object index');
      }
      let position = Number(offset);
      while (position < end) {
        const chunkLength = Math.min(this.readBufferBytes, end - position);
        const chunk = new Uint8Array(chunkLength);
        const result = await handle.read(chunk, 0, chunk.length, row.object_offset + position);
        /* v8 ignore start -- size and record header were validated immediately above. */
        if (result.bytesRead !== chunk.length) return storeError('WAL_STORE_CORRUPT', 'packed object changed during read');
        /* v8 ignore stop */
        yield chunk;
        position += chunk.length;
      }
    } catch (error) {
      if (error instanceof WalObjectStoreError) throw error;
      return storeError('WAL_STORE_IO', 'failed to read packed WalObject', error);
    } finally {
      await handle?.close();
    }
  }

  async put(expectedId: WalObjectId, bytes: AsyncIterable<Uint8Array>): Promise<void> {
    assertId(expectedId);
    this.assertOpen();
    if (await this.has(expectedId)) return;
    if (this.database.prepare('SELECT 1 FROM objects WHERE object_id = ?').get(idBuffer(expectedId)) !== undefined) {
      storeError('WAL_STORE_INVALID_OBJECT', 'WalObject was retired below an authenticated compaction floor');
    }
    const temporary = join(this.stagingRoot, `.${idBuffer(expectedId).toString('hex')}.${randomUUID()}.tmp`);
    let candidate;
    try {
      candidate = await open(temporary, 'wx', 0o600);
      let total = 0n;
      for await (const chunk of bytes) {
        if (!(chunk instanceof Uint8Array)) {
          return storeError('WAL_STORE_INVALID_OBJECT', 'WalObject source must yield Uint8Array chunks');
        }
        if (chunk.length === 0) continue;
        total += BigInt(chunk.length);
        if (total > this.maximumObjectBytes) {
          return storeError('WAL_STORE_OBJECT_TOO_LARGE', 'WalObject source exceeds the configured object limit');
        }
        await writePackedBytes(candidate, chunk, Number(total) - chunk.length);
      }
      await candidate.sync();
      await this.durabilityHook?.('candidate-file-synced');
      await candidate.close();
      candidate = undefined;
      const verified = await verifyWalObjectFile(temporary, expectedId, {
        maximumObjectBytes: this.maximumObjectBytes,
        readBufferBytes: this.verificationBufferBytes,
      });
      await this.mutex.run(async () => {
        if (await this.has(expectedId)) return;
        await this.appendVerified(expectedId, temporary, Number(verified.byteLength));
      });
    } catch (error) {
      if (error instanceof WalObjectStoreError) throw error;
      return storeError(
        'WAL_STORE_IO',
        `failed to admit packed WalObject: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      await candidate?.close();
      await rm(temporary, { force: true });
    }
  }

  async *ids(): AsyncIterable<WalObjectId> {
    this.assertOpen();
    try {
      const rows = this.database.prepare(`
        SELECT o.object_id FROM objects o
        LEFT JOIN packed_gc_tombstones g ON g.object_id = o.object_id
        WHERE g.object_id IS NULL ORDER BY o.object_id
      `).iterate() as Iterable<{
        object_id: Buffer;
      }>;
      for (const row of rows) {
        if (!(row.object_id instanceof Uint8Array) || row.object_id.length !== 32) {
          return storeError('WAL_STORE_CORRUPT', 'packed index contains an invalid WalObjectId');
        }
        yield walObjectId(new Uint8Array(row.object_id));
      }
    } catch (error) {
      if (error instanceof WalObjectStoreError) throw error;
      return storeError('WAL_STORE_IO', 'failed to enumerate packed WalObject IDs', error);
    }
  }

  /**
   * Stop serving exact complete WalObject IDs and physically remove only
   * fully-retired sealed segments. The retention/custody coordinator must
   * prove eligibility before calling this storage-only operation.
   */
  async collectGarbage(
    objectIds: readonly WalObjectId[],
    retiredAtMs: number,
    hook?: (point: PackedWalObjectStoreGcPoint) => void | Promise<void>,
  ): Promise<PackedWalObjectStoreGcResult> {
    this.assertOpen();
    if (!Number.isSafeInteger(retiredAtMs) || retiredAtMs < 0) {
      storeError('WAL_STORE_INVALID_CONFIGURATION', 'retiredAtMs must be a non-negative safe integer');
    }
    const ids = objectIds.map(value => {
      assertId(value);
      return Buffer.from(value);
    });
    const unique = new Map(ids.map(value => [value.toString('hex'), value]));
    if (unique.size !== ids.length) {
      storeError('WAL_STORE_INVALID_CONFIGURATION', 'physical GC object IDs must be unique');
    }
    return this.mutex.run(async () => {
      let committed = false;
      let newlyRetiredObjects = 0;
      let alreadyRetiredObjects = 0;
      const removable: number[] = [];
      const deferred: number[] = [];
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const segments = new Set<number>();
        for (const id of unique.values()) {
          const row = this.database.prepare(`
            SELECT o.segment_id,
                   CASE WHEN g.object_id IS NULL THEN 0 ELSE 1 END AS retired
            FROM objects o LEFT JOIN packed_gc_tombstones g ON g.object_id = o.object_id
            WHERE o.object_id = ?
          `).get(id) as { segment_id: number; retired: number } | undefined;
          if (row === undefined) {
            storeError('WAL_STORE_OBJECT_NOT_FOUND', 'physical GC target is not stored');
          }
          segments.add(row.segment_id);
          if (row.retired === 1) {
            alreadyRetiredObjects += 1;
          } else {
            this.database.prepare(
              'INSERT INTO packed_gc_tombstones(object_id, retired_at_ms) VALUES (?, ?)',
            ).run(id, retiredAtMs);
            newlyRetiredObjects += 1;
          }
        }
        await hook?.('tombstones-written');
        for (const segmentId of [...segments].sort((left, right) => left - right)) {
          const segment = this.database.prepare(
            'SELECT sealed FROM segments WHERE segment_id = ?',
          ).get(segmentId) as { sealed: number } | undefined;
          /* v8 ignore start -- objects.segment_id has a foreign key. */
          if (segment === undefined) storeError('WAL_STORE_CORRUPT', 'GC target references a missing segment');
          /* v8 ignore stop */
          const live = this.database.prepare(`
            SELECT 1 FROM objects o
            LEFT JOIN packed_gc_tombstones g ON g.object_id = o.object_id
            WHERE o.segment_id = ? AND g.object_id IS NULL LIMIT 1
          `).get(segmentId);
          if (segment.sealed === 1 && live === undefined) {
            this.database.prepare(`
              INSERT INTO packed_gc_segments(segment_id, retired_at_ms) VALUES (?, ?)
              ON CONFLICT(segment_id) DO NOTHING
            `).run(segmentId, retiredAtMs);
            removable.push(segmentId);
          } else deferred.push(segmentId);
        }
        this.database.exec('COMMIT');
        committed = true;
        await hook?.('gc-index-committed');
      } catch (error) {
        if (this.database.inTransaction) this.database.exec('ROLLBACK');
        throw error;
      }
      /* v8 ignore start -- the branch documents the post-COMMIT boundary. */
      if (!committed) storeError('WAL_STORE_IO', 'physical GC transaction did not commit');
      /* v8 ignore stop */
      let removed = false;
      for (const segmentId of removable) {
        rmSync(this.segmentPath(segmentId), { force: true });
        removed = true;
      }
      if (removed) fsyncDirectory(this.segmentsRoot);
      await hook?.('gc-segment-files-removed');
      return {
        newlyRetiredObjects,
        alreadyRetiredObjects,
        physicallyRemovedSegmentIds: removable,
        deferredSegmentIds: deferred,
      };
    });
  }

  private assertOpen(): void {
    if (this.closed) storeError('WAL_STORE_IO', 'packed WalObjectStore is closed');
  }

  private initializeSchema(): void {
    const version = this.database.pragma('user_version', { simple: true }) as number;
    if (version !== 0 && version !== PACKED_STORE_SCHEMA_VERSION) {
      storeError('WAL_STORE_INVALID_CONFIGURATION', `unsupported packed store schema version ${version}`);
    }
    if (version === PACKED_STORE_SCHEMA_VERSION) {
      this.database.exec(PACKED_GC_SCHEMA_SQL);
      return;
    }
    this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE segments (
        segment_id INTEGER PRIMARY KEY,
        committed_end INTEGER NOT NULL CHECK (committed_end >= ${PACKED_SEGMENT_HEADER_BYTES}),
        record_count INTEGER NOT NULL CHECK (record_count >= 0),
        sealed INTEGER NOT NULL CHECK (sealed IN (0, 1))
      );
      CREATE UNIQUE INDEX one_active_segment ON segments((1)) WHERE sealed = 0;
      CREATE TABLE objects (
        object_id BLOB PRIMARY KEY CHECK (length(object_id) = 32),
        segment_id INTEGER NOT NULL REFERENCES segments(segment_id),
        object_offset INTEGER NOT NULL CHECK (object_offset >= ${PACKED_SEGMENT_HEADER_BYTES + PACKED_RECORD_HEADER_BYTES}),
        object_length INTEGER NOT NULL CHECK (object_length >= 1)
      ) WITHOUT ROWID;
      CREATE INDEX objects_by_segment_offset ON objects(segment_id, object_offset);
      PRAGMA user_version = ${PACKED_STORE_SCHEMA_VERSION};
      COMMIT;
    `);
    this.database.exec(PACKED_GC_SCHEMA_SQL);
  }

  private recover(): void {
    const invalid = this.database.prepare(`
      SELECT 1 FROM objects AS o LEFT JOIN segments AS s ON s.segment_id = o.segment_id
      WHERE s.segment_id IS NULL
         OR o.object_offset + o.object_length > s.committed_end
         OR o.object_offset - ${PACKED_RECORD_HEADER_BYTES} < ${PACKED_SEGMENT_HEADER_BYTES}
      LIMIT 1
    `).get();
    if (invalid !== undefined) storeError('WAL_STORE_CORRUPT', 'packed index points outside committed segments');

    const retiredSegments = new Set((this.database.prepare(
      'SELECT segment_id FROM packed_gc_segments ORDER BY segment_id',
    ).all() as Array<{ segment_id: number }>).map(row => row.segment_id));
    const invalidRetired = this.database.prepare(`
      SELECT 1 FROM objects o
      JOIN packed_gc_segments s ON s.segment_id = o.segment_id
      LEFT JOIN packed_gc_tombstones g ON g.object_id = o.object_id
      WHERE g.object_id IS NULL LIMIT 1
    `).get();
    if (invalidRetired !== undefined) {
      storeError('WAL_STORE_CORRUPT', 'physically retired segment still contains a served WalObject');
    }
    const rows = this.database.prepare(
      'SELECT segment_id, committed_end, record_count, sealed FROM segments ORDER BY segment_id',
    ).all() as PackedSegmentRow[];
    const referenced = new Set(rows.map(row => packedSegmentName(row.segment_id)));
    let retiredRemoved = false;
    for (const row of rows) {
      if (retiredSegments.has(row.segment_id)) {
        if (row.sealed !== 1) storeError('WAL_STORE_CORRUPT', 'active packed segment cannot be physically retired');
        if (kind(this.segmentPath(row.segment_id)) === 'file') {
          rmSync(this.segmentPath(row.segment_id), { force: true });
          retiredRemoved = true;
        }
        continue;
      }
      this.recoverSegment(row);
    }
    if (retiredRemoved) fsyncDirectory(this.segmentsRoot);
    let removed = false;
    for (const entry of readdirSync(this.segmentsRoot, { withFileTypes: true })) {
      if (!/^[0-9a-f]{16}\.pack$/.test(entry.name) || referenced.has(entry.name)) continue;
      if (!entry.isFile()) storeError('WAL_STORE_PATH_UNSAFE', 'packed segment orphan must be a regular file');
      rmSync(join(this.segmentsRoot, entry.name));
      removed = true;
    }
    if (removed) fsyncDirectory(this.segmentsRoot);
    for (const entry of readdirSync(this.stagingRoot, { withFileTypes: true })) {
      if (!/^\.[0-9a-f]{64}\.[0-9a-f-]+\.tmp$/.test(entry.name)) continue;
      if (!entry.isFile()) storeError('WAL_STORE_PATH_UNSAFE', 'packed staging orphan must be a regular file');
      rmSync(join(this.stagingRoot, entry.name));
    }
    const active = rows.filter(row => row.sealed === 0);
    if (active.length > 1) storeError('WAL_STORE_CORRUPT', 'packed index has multiple active segments');
    if (active.length === 0) this.createInitialSegment((rows.at(-1)?.segment_id ?? -1) + 1);
  }

  private recoverSegment(row: PackedSegmentRow): void {
    const path = this.segmentPath(row.segment_id);
    if (kind(path) !== 'file') storeError('WAL_STORE_CORRUPT', 'packed index references a missing segment');
    const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const details = fstatSync(descriptor);
      if (!details.isFile() || details.size < row.committed_end) {
        storeError('WAL_STORE_CORRUPT', 'packed segment is shorter than its committed boundary');
      }
      const header = new Uint8Array(PACKED_SEGMENT_HEADER_BYTES);
      if (
        readSync(descriptor, header, 0, header.length, 0) !== header.length
        || !packedSegmentMagicMatches(header)
        || new DataView(header.buffer).getUint32(8, false) !== PACKED_STORE_SCHEMA_VERSION
        || new DataView(header.buffer).getBigUint64(16, false) !== BigInt(row.segment_id)
      ) {
        storeError('WAL_STORE_CORRUPT', 'packed segment header is invalid');
      }
      if (details.size > row.committed_end) {
        ftruncateSync(descriptor, row.committed_end);
        fsyncSync(descriptor);
      }
    } finally {
      closeSync(descriptor);
    }
  }

  private createInitialSegment(segmentId: number): void {
    this.createSegmentFile(segmentId);
    try {
      this.database.prepare(
        'INSERT INTO segments(segment_id, committed_end, record_count, sealed) VALUES (?, ?, 0, 0)',
      ).run(segmentId, PACKED_SEGMENT_HEADER_BYTES);
    } catch (error) {
      rmSync(this.segmentPath(segmentId), { force: true });
      fsyncDirectory(this.segmentsRoot);
      throw error;
    }
  }

  private createSegmentFile(segmentId: number): void {
    if (!Number.isSafeInteger(segmentId) || segmentId < 0) {
      storeError('WAL_STORE_CORRUPT', 'packed segment identifier is outside the safe range');
    }
    createPackedSegmentFile(this.segmentsRoot, segmentId);
  }

  private async appendVerified(id: WalObjectId, candidatePath: string, objectLength: number): Promise<void> {
    this.database.exec('BEGIN IMMEDIATE');
    const append = new PackedObjectTransactionAppend({
      database: this.database,
      segmentsRoot: this.segmentsRoot,
      id,
      source: { kind: 'file', path: candidatePath, length: objectLength },
      segmentTargetBytes: this.segmentTargetBytes,
      bufferBytes: this.readBufferBytes,
      hook: async point => {
        if (point === 'segment-file-synced') await this.durabilityHook?.('segment-file-synced');
      },
    });
    let committed = false;
    try {
      await append.append();
      await this.durabilityHook?.('before-index-commit');
      this.database.exec('COMMIT');
      committed = true;
      append.markCommitted();
      await this.durabilityHook?.('index-committed');
    } catch (error) {
      if (this.database.inTransaction) this.database.exec('ROLLBACK');
      if (!committed) append.rollback();
      throw error;
    }
  }

  private segmentPath(segmentId: number): string {
    if (!Number.isSafeInteger(segmentId) || segmentId < 0) {
      storeError('WAL_STORE_CORRUPT', 'packed segment identifier is outside the safe range');
    }
    return join(this.segmentsRoot, packedSegmentName(segmentId));
  }
}
