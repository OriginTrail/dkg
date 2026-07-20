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
  writeSync,
} from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { walObjectId, type WalObjectId } from '../reconciliation/ids.js';
import { WalObjectStoreError, storeError } from './errors.js';
import { verifyWalObjectFile } from './streaming-verifier.js';
import { WalObjectStore } from './types.js';

const SCHEMA_VERSION = 1;
const SEGMENT_HEADER_BYTES = 32;
const RECORD_HEADER_BYTES = 48;
const SEGMENT_MAGIC = Buffer.from('DKGWSEG1');
const RECORD_MAGIC = Buffer.from('DKGWREC1');
const DEFAULT_SEGMENT_TARGET_BYTES = 1_073_741_824;
const DEFAULT_MAXIMUM_OBJECT_BYTES = 1_073_741_824n;
const HARD_MAXIMUM_OBJECT_BYTES = 8_589_934_592n;
const DEFAULT_BUFFER_BYTES = 65_536;

interface SegmentRow {
  segment_id: number;
  committed_end: number;
  record_count: number;
  sealed: number;
}

interface ObjectRow {
  object_id: Buffer;
  segment_id: number;
  object_offset: number;
  object_length: number;
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

const rootMutexes = new Map<string, AsyncMutex>();

function mutexFor(root: string): AsyncMutex {
  let mutex = rootMutexes.get(root);
  if (mutex === undefined) {
    mutex = new AsyncMutex();
    rootMutexes.set(root, mutex);
  }
  return mutex;
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

function writeAllSync(descriptor: number, bytes: Uint8Array, position: number): void {
  let written = 0;
  while (written < bytes.length) {
    const count = writeSync(descriptor, bytes, written, bytes.length - written, position + written);
    /* v8 ignore start -- regular-file writes cannot make zero progress for non-empty input. */
    if (count < 1) storeError('WAL_STORE_IO', 'packed segment write made no progress');
    /* v8 ignore stop */
    written += count;
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, position + written);
    /* v8 ignore start -- regular-file writes cannot make zero progress for non-empty input. */
    if (result.bytesWritten < 1) storeError('WAL_STORE_IO', 'packed segment write made no progress');
    /* v8 ignore stop */
    written += result.bytesWritten;
  }
}

function segmentName(id: number): string {
  return `${id.toString(16).padStart(16, '0')}.pack`;
}

function segmentHeader(id: number): Uint8Array {
  const header = new Uint8Array(SEGMENT_HEADER_BYTES);
  header.set(SEGMENT_MAGIC);
  const view = new DataView(header.buffer);
  view.setUint32(8, SCHEMA_VERSION, false);
  view.setBigUint64(16, BigInt(id), false);
  return header;
}

function recordHeader(id: WalObjectId, length: number): Uint8Array {
  const header = new Uint8Array(RECORD_HEADER_BYTES);
  header.set(RECORD_MAGIC);
  header.set(id, 8);
  new DataView(header.buffer).setBigUint64(40, BigInt(length), false);
  return header;
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
  private readonly mutex: AsyncMutex;
  private readonly durabilityHook?: PackedWalObjectStoreOptions['durabilityHook'];
  private closed = false;

  constructor(options: PackedWalObjectStoreOptions) {
    super();
    if (typeof options?.root !== 'string' || options.root.trim().length === 0 || !isAbsolute(options.root)) {
      storeError('WAL_STORE_INVALID_CONFIGURATION', 'packed WalObjectStore root must be an absolute path');
    }
    const maximumObjectBytes = options.maximumObjectBytes ?? DEFAULT_MAXIMUM_OBJECT_BYTES;
    if (maximumObjectBytes < 1n || maximumObjectBytes > HARD_MAXIMUM_OBJECT_BYTES) {
      storeError('WAL_STORE_INVALID_CONFIGURATION', 'maximumObjectBytes must be within the WAL v1 hard limit');
    }
    const segmentTargetBytes = options.segmentTargetBytes ?? DEFAULT_SEGMENT_TARGET_BYTES;
    const readBufferBytes = options.readBufferBytes ?? DEFAULT_BUFFER_BYTES;
    const verificationBufferBytes = options.verificationBufferBytes ?? DEFAULT_BUFFER_BYTES;
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
    this.mutex = mutexFor(this.root);

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
      return this.database.prepare('SELECT 1 FROM objects WHERE object_id = ?').get(idBuffer(id)) !== undefined;
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
        'SELECT object_id, segment_id, object_offset, object_length FROM objects WHERE object_id = ?',
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
      const header = new Uint8Array(RECORD_HEADER_BYTES);
      const headerRead = await handle.read(header, 0, header.length, row.object_offset - RECORD_HEADER_BYTES);
      if (
        headerRead.bytesRead !== header.length
        || !equalBytes(header.subarray(0, 8), RECORD_MAGIC)
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
        await writeAll(candidate, chunk, Number(total) - chunk.length);
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
      const rows = this.database.prepare('SELECT object_id FROM objects ORDER BY object_id').iterate() as Iterable<{
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

  private assertOpen(): void {
    if (this.closed) storeError('WAL_STORE_IO', 'packed WalObjectStore is closed');
  }

  private initializeSchema(): void {
    const version = this.database.pragma('user_version', { simple: true }) as number;
    if (version !== 0 && version !== SCHEMA_VERSION) {
      storeError('WAL_STORE_INVALID_CONFIGURATION', `unsupported packed store schema version ${version}`);
    }
    if (version === SCHEMA_VERSION) return;
    this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE segments (
        segment_id INTEGER PRIMARY KEY,
        committed_end INTEGER NOT NULL CHECK (committed_end >= ${SEGMENT_HEADER_BYTES}),
        record_count INTEGER NOT NULL CHECK (record_count >= 0),
        sealed INTEGER NOT NULL CHECK (sealed IN (0, 1))
      );
      CREATE UNIQUE INDEX one_active_segment ON segments((1)) WHERE sealed = 0;
      CREATE TABLE objects (
        object_id BLOB PRIMARY KEY CHECK (length(object_id) = 32),
        segment_id INTEGER NOT NULL REFERENCES segments(segment_id),
        object_offset INTEGER NOT NULL CHECK (object_offset >= ${SEGMENT_HEADER_BYTES + RECORD_HEADER_BYTES}),
        object_length INTEGER NOT NULL CHECK (object_length >= 1)
      ) WITHOUT ROWID;
      CREATE INDEX objects_by_segment_offset ON objects(segment_id, object_offset);
      PRAGMA user_version = ${SCHEMA_VERSION};
      COMMIT;
    `);
  }

  private recover(): void {
    const invalid = this.database.prepare(`
      SELECT 1 FROM objects AS o LEFT JOIN segments AS s ON s.segment_id = o.segment_id
      WHERE s.segment_id IS NULL
         OR o.object_offset + o.object_length > s.committed_end
         OR o.object_offset - ${RECORD_HEADER_BYTES} < ${SEGMENT_HEADER_BYTES}
      LIMIT 1
    `).get();
    if (invalid !== undefined) storeError('WAL_STORE_CORRUPT', 'packed index points outside committed segments');

    const rows = this.database.prepare(
      'SELECT segment_id, committed_end, record_count, sealed FROM segments ORDER BY segment_id',
    ).all() as SegmentRow[];
    const referenced = new Set(rows.map(row => segmentName(row.segment_id)));
    for (const row of rows) this.recoverSegment(row);
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

  private recoverSegment(row: SegmentRow): void {
    const path = this.segmentPath(row.segment_id);
    if (kind(path) !== 'file') storeError('WAL_STORE_CORRUPT', 'packed index references a missing segment');
    const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const details = fstatSync(descriptor);
      if (!details.isFile() || details.size < row.committed_end) {
        storeError('WAL_STORE_CORRUPT', 'packed segment is shorter than its committed boundary');
      }
      const header = new Uint8Array(SEGMENT_HEADER_BYTES);
      if (
        readSync(descriptor, header, 0, header.length, 0) !== header.length
        || !equalBytes(header.subarray(0, 8), SEGMENT_MAGIC)
        || new DataView(header.buffer).getUint32(8, false) !== SCHEMA_VERSION
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
      ).run(segmentId, SEGMENT_HEADER_BYTES);
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
    const descriptor = openSync(this.segmentPath(segmentId), 'wx', 0o600);
    try {
      writeAllSync(descriptor, segmentHeader(segmentId), 0);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    fsyncDirectory(this.segmentsRoot);
  }

  private async appendVerified(id: WalObjectId, candidatePath: string, objectLength: number): Promise<void> {
    this.database.exec('BEGIN IMMEDIATE');
    let segment: SegmentRow | undefined;
    let originalEnd = 0;
    let createdSegmentId: number | undefined;
    let committed = false;
    try {
      segment = this.database.prepare(
        'SELECT segment_id, committed_end, record_count, sealed FROM segments WHERE sealed = 0',
      ).get() as SegmentRow | undefined;
      /* v8 ignore start -- startup recovery creates exactly one active segment before append. */
      if (segment === undefined) storeError('WAL_STORE_CORRUPT', 'packed index has no active segment');
      /* v8 ignore stop */
      const recordBytes = RECORD_HEADER_BYTES + objectLength;
      if (segment.record_count > 0 && segment.committed_end + recordBytes > this.segmentTargetBytes) {
        const nextId = segment.segment_id + 1;
        this.createSegmentFile(nextId);
        createdSegmentId = nextId;
        this.database.prepare('UPDATE segments SET sealed = 1 WHERE segment_id = ?').run(segment.segment_id);
        this.database.prepare(
          'INSERT INTO segments(segment_id, committed_end, record_count, sealed) VALUES (?, ?, 0, 0)',
        ).run(nextId, SEGMENT_HEADER_BYTES);
        segment = { segment_id: nextId, committed_end: SEGMENT_HEADER_BYTES, record_count: 0, sealed: 0 };
      }
      originalEnd = segment.committed_end;
      const objectOffset = originalEnd + RECORD_HEADER_BYTES;
      const newEnd = objectOffset + objectLength;
      const segmentHandle = await open(this.segmentPath(segment.segment_id), constants.O_RDWR | constants.O_NOFOLLOW);
      const candidateHandle = await open(candidatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const details = await segmentHandle.stat();
        if (!details.isFile() || details.size !== originalEnd) {
          return storeError('WAL_STORE_CORRUPT', 'active segment does not match its committed boundary');
        }
        await writeAll(segmentHandle, recordHeader(id, objectLength), originalEnd);
        let copied = 0;
        while (copied < objectLength) {
          const chunk = new Uint8Array(Math.min(this.readBufferBytes, objectLength - copied));
          const read = await candidateHandle.read(chunk, 0, chunk.length, copied);
          /* v8 ignore start -- the candidate was closed and verified immediately before locking. */
          if (read.bytesRead !== chunk.length) return storeError('WAL_STORE_IO', 'verified candidate changed before append');
          /* v8 ignore stop */
          await writeAll(segmentHandle, chunk, objectOffset + copied);
          copied += chunk.length;
        }
        await segmentHandle.sync();
        await this.durabilityHook?.('segment-file-synced');
      } finally {
        await candidateHandle.close();
        await segmentHandle.close();
      }
      this.database.prepare(
        'INSERT INTO objects(object_id, segment_id, object_offset, object_length) VALUES (?, ?, ?, ?)',
      ).run(idBuffer(id), segment.segment_id, objectOffset, objectLength);
      this.database.prepare(
        'UPDATE segments SET committed_end = ?, record_count = record_count + 1 WHERE segment_id = ?',
      ).run(newEnd, segment.segment_id);
      await this.durabilityHook?.('before-index-commit');
      this.database.exec('COMMIT');
      committed = true;
      await this.durabilityHook?.('index-committed');
    } catch (error) {
      if (this.database.inTransaction) this.database.exec('ROLLBACK');
      if (!committed && segment !== undefined) {
        if (createdSegmentId !== undefined) {
          rmSync(this.segmentPath(createdSegmentId), { force: true });
          fsyncDirectory(this.segmentsRoot);
        } else {
          const descriptor = openSync(this.segmentPath(segment.segment_id), constants.O_RDWR | constants.O_NOFOLLOW);
          try {
            ftruncateSync(descriptor, originalEnd);
            fsyncSync(descriptor);
          } finally {
            closeSync(descriptor);
          }
        }
      }
      throw error;
    }
  }

  private segmentPath(segmentId: number): string {
    if (!Number.isSafeInteger(segmentId) || segmentId < 0) {
      storeError('WAL_STORE_CORRUPT', 'packed segment identifier is outside the safe range');
    }
    return join(this.segmentsRoot, segmentName(segmentId));
  }
}
