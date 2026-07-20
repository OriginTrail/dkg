import type Database from 'better-sqlite3';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { WalObjectId } from '../reconciliation/ids.js';
import { storeError } from './errors.js';

export const PACKED_STORE_SCHEMA_VERSION = 1;
export const PACKED_SEGMENT_HEADER_BYTES = 32;
export const PACKED_RECORD_HEADER_BYTES = 48;
export const PACKED_DEFAULT_SEGMENT_TARGET_BYTES = 1_073_741_824;
export const PACKED_DEFAULT_MAXIMUM_OBJECT_BYTES = 1_073_741_824n;
export const PACKED_HARD_MAXIMUM_OBJECT_BYTES = 8_589_934_592n;
export const PACKED_DEFAULT_BUFFER_BYTES = 65_536;

const SEGMENT_MAGIC = Buffer.from('DKGWSEG1');
const RECORD_MAGIC = Buffer.from('DKGWREC1');

export interface PackedSegmentRow {
  segment_id: number;
  committed_end: number;
  record_count: number;
  sealed: number;
}

export class PackedWriteMutex {
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

const rootMutexes = new Map<string, PackedWriteMutex>();

/**
 * One in-process writer lane for every packed-store root. The packed object
 * store and control/local-commit connections share this mutex so neither can
 * append to the active segment while the other owns its SQLite transaction.
 */
export function packedWriteMutexFor(root: string): PackedWriteMutex {
  let mutex = rootMutexes.get(root);
  if (mutex === undefined) {
    mutex = new PackedWriteMutex();
    rootMutexes.set(root, mutex);
  }
  return mutex;
}

export function packedSegmentName(id: number): string {
  return `${id.toString(16).padStart(16, '0')}.pack`;
}

export function packedSegmentHeader(id: number): Uint8Array {
  const header = new Uint8Array(PACKED_SEGMENT_HEADER_BYTES);
  header.set(SEGMENT_MAGIC);
  const view = new DataView(header.buffer);
  view.setUint32(8, PACKED_STORE_SCHEMA_VERSION, false);
  view.setBigUint64(16, BigInt(id), false);
  return header;
}

export function packedRecordHeader(id: WalObjectId, length: number): Uint8Array {
  const header = new Uint8Array(PACKED_RECORD_HEADER_BYTES);
  header.set(RECORD_MAGIC);
  header.set(id, 8);
  new DataView(header.buffer).setBigUint64(40, BigInt(length), false);
  return header;
}

export function packedSegmentMagicMatches(header: Uint8Array): boolean {
  return equalBytes(header.subarray(0, 8), SEGMENT_MAGIC);
}

export function packedRecordMagicMatches(header: Uint8Array): boolean {
  return equalBytes(header.subarray(0, 8), RECORD_MAGIC);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function writeAllSync(
  descriptor: number,
  bytes: Uint8Array,
  position: number,
  writer: typeof writeSync = writeSync,
): void {
  let written = 0;
  while (written < bytes.length) {
    const count = writer(descriptor, bytes, written, bytes.length - written, position + written);
    if (count < 1) storeError('WAL_STORE_IO', 'packed segment write made no progress');
    written += count;
  }
}

export async function writePackedBytes(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, position + written);
    if (result.bytesWritten < 1) storeError('WAL_STORE_IO', 'packed segment write made no progress');
    written += result.bytesWritten;
  }
}

export function createPackedSegmentFile(segmentsRoot: string, segmentId: number): void {
  if (!Number.isSafeInteger(segmentId) || segmentId < 0) {
    storeError('WAL_STORE_CORRUPT', 'packed segment identifier is outside the safe range');
  }
  const descriptor = openSync(join(segmentsRoot, packedSegmentName(segmentId)), 'wx', 0o600);
  try {
    writeAllSync(descriptor, packedSegmentHeader(segmentId), 0);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(segmentsRoot);
}

export type PackedAppendSource =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'file'; readonly path: string; readonly length: number };

export type PackedTransactionAppendPoint = 'segment-file-synced' | 'packed-index-written';

export interface PackedObjectTransactionAppendOptions {
  database: Database.Database;
  segmentsRoot: string;
  id: WalObjectId;
  source: PackedAppendSource;
  segmentTargetBytes: number;
  bufferBytes?: number;
  hook?: (point: PackedTransactionAppendPoint) => void | Promise<void>;
}

/**
 * Append one complete, already-verified WalObjectV1 while the caller owns an
 * open SQLite write transaction. This class never begins or commits SQLite.
 * Its rollback method repairs the segment after the caller rolls SQLite back.
 */
export class PackedObjectTransactionAppend {
  private segment?: PackedSegmentRow;
  private originalEnd = 0;
  private createdSegmentId?: number;
  private touchedFile = false;
  private committed = false;

  constructor(private readonly options: PackedObjectTransactionAppendOptions) {}

  async append(): Promise<{ segmentId: number; objectOffset: number; objectLength: number }> {
    const { database, segmentsRoot, id, source, segmentTargetBytes } = this.options;
    if (!database.inTransaction) {
      storeError('WAL_STORE_IO', 'packed object append requires an open SQLite transaction');
    }
    const objectLength = source.kind === 'bytes' ? source.bytes.length : source.length;
    if (!Number.isSafeInteger(objectLength) || objectLength < 1) {
      storeError('WAL_STORE_INVALID_OBJECT', 'packed object append requires non-empty safe-length bytes');
    }
    if (database.prepare('SELECT 1 FROM objects WHERE object_id = ?').get(Buffer.from(id)) !== undefined) {
      storeError('WAL_STORE_INVALID_OBJECT', 'packed object ID is already present');
    }

    this.segment = database.prepare(
      'SELECT segment_id, committed_end, record_count, sealed FROM segments WHERE sealed = 0',
    ).get() as PackedSegmentRow | undefined;
    if (this.segment === undefined) storeError('WAL_STORE_CORRUPT', 'packed index has no active segment');

    const recordBytes = PACKED_RECORD_HEADER_BYTES + objectLength;
    if (this.segment.record_count > 0 && this.segment.committed_end + recordBytes > segmentTargetBytes) {
      const nextId = this.segment.segment_id + 1;
      createPackedSegmentFile(segmentsRoot, nextId);
      this.createdSegmentId = nextId;
      database.prepare('UPDATE segments SET sealed = 1 WHERE segment_id = ?').run(this.segment.segment_id);
      database.prepare(
        'INSERT INTO segments(segment_id, committed_end, record_count, sealed) VALUES (?, ?, 0, 0)',
      ).run(nextId, PACKED_SEGMENT_HEADER_BYTES);
      this.segment = {
        segment_id: nextId,
        committed_end: PACKED_SEGMENT_HEADER_BYTES,
        record_count: 0,
        sealed: 0,
      };
    }

    this.originalEnd = this.segment.committed_end;
    const objectOffset = this.originalEnd + PACKED_RECORD_HEADER_BYTES;
    const newEnd = objectOffset + objectLength;
    const segmentPath = join(segmentsRoot, packedSegmentName(this.segment.segment_id));
    const segmentHandle = await open(segmentPath, constants.O_RDWR | constants.O_NOFOLLOW);
    let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const details = await segmentHandle.stat();
      if (!details.isFile() || details.size !== this.originalEnd) {
        storeError('WAL_STORE_CORRUPT', 'active segment does not match its committed boundary');
      }
      await writePackedBytes(segmentHandle, packedRecordHeader(id, objectLength), this.originalEnd);
      this.touchedFile = true;
      if (source.kind === 'bytes') {
        await writePackedBytes(segmentHandle, source.bytes, objectOffset);
      } else {
        sourceHandle = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let copied = 0;
        const bufferBytes = this.options.bufferBytes ?? PACKED_DEFAULT_BUFFER_BYTES;
        while (copied < objectLength) {
          const chunk = new Uint8Array(Math.min(bufferBytes, objectLength - copied));
          const read = await sourceHandle.read(chunk, 0, chunk.length, copied);
          if (read.bytesRead !== chunk.length) {
            storeError('WAL_STORE_IO', 'verified candidate changed before append');
          }
          await writePackedBytes(segmentHandle, chunk, objectOffset + copied);
          copied += chunk.length;
        }
      }
      await segmentHandle.sync();
      await this.options.hook?.('segment-file-synced');
    } finally {
      await sourceHandle?.close();
      await segmentHandle.close();
    }

    database.prepare(
      'INSERT INTO objects(object_id, segment_id, object_offset, object_length) VALUES (?, ?, ?, ?)',
    ).run(Buffer.from(id), this.segment.segment_id, objectOffset, objectLength);
    database.prepare(
      'UPDATE segments SET committed_end = ?, record_count = record_count + 1 WHERE segment_id = ?',
    ).run(newEnd, this.segment.segment_id);
    await this.options.hook?.('packed-index-written');
    return { segmentId: this.segment.segment_id, objectOffset, objectLength };
  }

  markCommitted(): void {
    this.committed = true;
  }

  /** Invoke only after SQLite has rolled back. Safe when append failed midway. */
  rollback(): void {
    if (this.committed || this.segment === undefined) return;
    if (this.createdSegmentId !== undefined) {
      rmSync(join(this.options.segmentsRoot, packedSegmentName(this.createdSegmentId)), { force: true });
      fsyncDirectory(this.options.segmentsRoot);
      return;
    }
    const path = join(this.options.segmentsRoot, packedSegmentName(this.segment.segment_id));
    const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const details = fstatSync(descriptor);
      if (details.size > this.originalEnd) {
        ftruncateSync(descriptor, this.originalEnd);
        fsyncSync(descriptor);
      }
    } finally {
      closeSync(descriptor);
    }
  }
}

export function readPackedHeaderSync(
  descriptor: number,
  bytes: Uint8Array,
  position: number,
): boolean {
  return readSync(descriptor, bytes, 0, bytes.length, position) === bytes.length;
}
