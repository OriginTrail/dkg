import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { WalObjectId } from '../reconciliation/ids.js';
import { WalObjectStoreError, storeError } from './errors.js';
import type { WalObjectStore } from './types.js';

const DEFAULT_MAXIMUM_OBJECT_BYTES = 1_073_741_824n;
const HARD_MAXIMUM_OBJECT_BYTES = 8_589_934_592n;
const DEFAULT_MAXIMUM_RANGE_BYTES = 1_048_576;
const DEFAULT_MAXIMUM_STAGED_BYTES = 17_179_869_184n;
const DEFAULT_MAXIMUM_PARTS = 65_536;
const DEFAULT_MAXIMUM_CONCURRENT_OBJECTS = 16;
const DEFAULT_STAGING_LIFETIME_MS = 86_400_000;
const DEFAULT_ASSEMBLY_BUFFER_BYTES = 65_536;

/** Local restart state only. This JSON is never a WAL or wire representation. */
interface StagingMetadata {
  version: 1;
  walObjectId: string;
  totalObjectLength: string;
  createdAtMs: number;
  updatedAtMs: number;
}

interface StagedPart {
  path: string;
  offset: bigint;
  length: number;
  end: bigint;
}

export interface WalObjectRangeInput {
  walObjectId: WalObjectId;
  totalObjectLength: bigint;
  offset: bigint;
  bytes: Uint8Array;
}

export interface MissingWalObjectRange {
  offset: bigint;
  maximumLength: number;
}

export type WalObjectRangeAcceptResult = 'stored' | 'duplicate' | 'complete';

export type RangeReceiverDurabilityPoint =
  | 'metadata-file-synced'
  | 'metadata-renamed'
  | 'metadata-directory-synced'
  | 'range-file-synced'
  | 'range-renamed'
  | 'range-directory-synced'
  | 'progress-metadata-committed'
  | 'assembly-file-synced'
  | 'object-promoted'
  | 'staging-directory-removed';

export interface FileWalObjectRangeReceiverOptions {
  stagingRoot: string;
  store: WalObjectStore;
  maximumObjectBytes?: bigint;
  maximumRangeBytes?: number;
  maximumStagedBytes?: bigint;
  maximumPartsPerObject?: number;
  maximumConcurrentObjects?: number;
  stagingLifetimeMs?: number;
  assemblyBufferBytes?: number;
  now?: () => number;
  durabilityHook?: (point: RangeReceiverDurabilityPoint) => void | Promise<void>;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function assertObjectId(id: Uint8Array): asserts id is WalObjectId {
  if (!(id instanceof Uint8Array) || id.length !== 32) {
    storeError('WAL_STORE_INVALID_OBJECT_ID', 'WalObjectId must be exactly 32 bytes');
  }
}

function parsePart(directory: string, name: string): StagedPart | null {
  const match = /^(0|[1-9]\d*)-([1-9]\d*)\.part$/.exec(name);
  if (!match) return null;
  const offset = BigInt(match[1]);
  const lengthValue = BigInt(match[2]);
  if (lengthValue > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const length = Number(lengthValue);
  return { path: join(directory, name), offset, length, end: offset + lengthValue };
}

function mergeIntervals(parts: readonly StagedPart[]): Array<{ start: bigint; end: bigint }> {
  const sorted = [...parts].sort((left, right) => Number(
    left.offset - right.offset || left.end - right.end,
  ));
  const merged: Array<{ start: bigint; end: bigint }> = [];
  for (const part of sorted) {
    const last = merged.at(-1);
    if (!last || part.offset > last.end) merged.push({ start: part.offset, end: part.end });
    else if (part.end > last.end) last.end = part.end;
  }
  return merged;
}

function isFullyCovered(parts: readonly StagedPart[], start: bigint, end: bigint): boolean {
  return mergeIntervals(parts).some(interval => interval.start <= start && interval.end >= end);
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    /* v8 ignore start -- Node's FileHandle contract cannot return zero for a non-empty regular-file write. */
    if (bytesWritten < 1) return storeError('WAL_STORE_IO', 'staged range write made no progress');
    /* v8 ignore stop */
    offset += bytesWritten;
  }
}

async function readPartSlice(part: StagedPart, absoluteOffset: bigint, length: number): Promise<Uint8Array> {
  const relative = absoluteOffset - part.offset;
  const handle = await open(part.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const output = new Uint8Array(length);
    const { bytesRead } = await handle.read(output, 0, length, Number(relative));
    if (bytesRead !== length) return storeError('WAL_STAGE_METADATA_INVALID', 'staged range file is truncated');
    return output;
  } finally {
    await handle.close();
  }
}

async function* fileChunks(path: string, chunkBytes: number): AsyncIterable<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    let position = 0;
    while (true) {
      const bytes = new Uint8Array(chunkBytes);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
      if (bytesRead === 0) return;
      yield bytes.slice(0, bytesRead);
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolveRelease => { release = resolveRelease; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class FileWalObjectRangeReceiver {
  readonly stagingRoot: string;
  readonly maximumObjectBytes: bigint;
  readonly maximumRangeBytes: number;
  readonly maximumStagedBytes: bigint;
  readonly maximumPartsPerObject: number;
  readonly maximumConcurrentObjects: number;
  readonly stagingLifetimeMs: number;
  readonly assemblyBufferBytes: number;
  private readonly store: WalObjectStore;
  private readonly now: () => number;
  private readonly durabilityHook?: FileWalObjectRangeReceiverOptions['durabilityHook'];
  private readonly globalLock = new AsyncLock();
  private readonly objectLocks = new Map<string, { lock: AsyncLock; users: number }>();

  constructor(options: FileWalObjectRangeReceiverOptions) {
    if (typeof options?.stagingRoot !== 'string' || !isAbsolute(options.stagingRoot)) {
      storeError('WAL_STORE_INVALID_CONFIGURATION', 'range staging root must be an absolute path');
    }
    if (!options.store || typeof options.store.put !== 'function') {
      storeError('WAL_STORE_INVALID_CONFIGURATION', 'range receiver requires a WalObjectStore');
    }
    this.stagingRoot = resolve(options.stagingRoot);
    this.store = options.store;
    this.maximumObjectBytes = options.maximumObjectBytes ?? DEFAULT_MAXIMUM_OBJECT_BYTES;
    this.maximumRangeBytes = options.maximumRangeBytes ?? DEFAULT_MAXIMUM_RANGE_BYTES;
    this.maximumStagedBytes = options.maximumStagedBytes ?? DEFAULT_MAXIMUM_STAGED_BYTES;
    this.maximumPartsPerObject = options.maximumPartsPerObject ?? DEFAULT_MAXIMUM_PARTS;
    this.maximumConcurrentObjects = options.maximumConcurrentObjects ?? DEFAULT_MAXIMUM_CONCURRENT_OBJECTS;
    this.stagingLifetimeMs = options.stagingLifetimeMs ?? DEFAULT_STAGING_LIFETIME_MS;
    this.assemblyBufferBytes = options.assemblyBufferBytes ?? DEFAULT_ASSEMBLY_BUFFER_BYTES;
    this.now = options.now ?? Date.now;
    this.durabilityHook = options.durabilityHook;
    if (this.maximumObjectBytes < 1n || this.maximumObjectBytes > HARD_MAXIMUM_OBJECT_BYTES) {
      storeError('WAL_STORE_INVALID_CONFIGURATION', 'range maximumObjectBytes exceeds the WAL v1 hard limit');
    }
    if (this.maximumStagedBytes < 1n) {
      storeError('WAL_STORE_INVALID_CONFIGURATION', 'maximumStagedBytes must be positive');
    }
    for (const [name, value, maximum] of [
      ['maximumRangeBytes', this.maximumRangeBytes, DEFAULT_MAXIMUM_RANGE_BYTES],
      ['maximumPartsPerObject', this.maximumPartsPerObject, DEFAULT_MAXIMUM_PARTS],
      ['maximumConcurrentObjects', this.maximumConcurrentObjects, DEFAULT_MAXIMUM_CONCURRENT_OBJECTS],
      ['assemblyBufferBytes', this.assemblyBufferBytes, DEFAULT_MAXIMUM_RANGE_BYTES],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        storeError('WAL_STORE_INVALID_CONFIGURATION', `${name} is outside the WAL v1 limit`);
      }
    }
    if (!Number.isSafeInteger(this.stagingLifetimeMs) || this.stagingLifetimeMs < 1) {
      storeError('WAL_STORE_INVALID_CONFIGURATION', 'stagingLifetimeMs must be a positive safe integer');
    }
  }

  async accept(
    frame: WalObjectRangeInput,
    signal?: AbortSignal,
  ): Promise<WalObjectRangeAcceptResult> {
    this.assertNotCancelled(signal);
    this.validateFrame(frame);
    const key = bytesToHex(frame.walObjectId);
    return this.withObjectLock(key, async () => {
      if (await this.store.has(frame.walObjectId)) {
        await this.removeObjectDirectory(key);
        return 'complete';
      }
      if (frame.bytes.length === 0) {
        const directory = this.objectDirectory(key);
        const metadata = await this.readMetadata(directory);
        if (!metadata) return 'duplicate';
        this.assertMetadata(metadata, key, frame.totalObjectLength);
        if (await this.isCompleteDirectory(directory, frame.totalObjectLength)) {
          await this.finalizeLocked(frame.walObjectId, frame.totalObjectLength, directory, signal);
          return 'complete';
        }
        return 'duplicate';
      }
      const directory = await this.globalLock.run(async () => this.ensureMetadata(frame));
      const partsDirectory = join(directory, 'parts');
      const bytes = new Uint8Array(frame.bytes);
      let result: 'stored' | 'duplicate';
      result = await this.globalLock.run(async () => this.storePart(
        frame.walObjectId,
        frame.totalObjectLength,
        frame.offset,
        bytes,
        directory,
        partsDirectory,
        signal,
      ));
      this.assertNotCancelled(signal);
      if (await this.isCompleteDirectory(directory, frame.totalObjectLength)) {
        await this.finalizeLocked(frame.walObjectId, frame.totalObjectLength, directory, signal);
        return 'complete';
      }
      return result;
    });
  }

  async missing(
    id: WalObjectId,
    totalObjectLength: bigint,
    maximumLength = this.maximumRangeBytes,
  ): Promise<MissingWalObjectRange[]> {
    assertObjectId(id);
    this.validateTotalLength(totalObjectLength);
    if (!Number.isSafeInteger(maximumLength) || maximumLength < 1 || maximumLength > this.maximumRangeBytes) {
      return storeError('WAL_STAGE_INVALID_RANGE', 'missing-range page size is outside the negotiated range limit');
    }
    if (await this.store.has(id)) return [];
    const key = bytesToHex(id);
    return this.withObjectLock(key, async () => {
      const directory = this.objectDirectory(key);
      const metadata = await this.readMetadata(directory);
      if (!metadata) return this.gapsForIntervals([], totalObjectLength, maximumLength);
      this.assertMetadata(metadata, key, totalObjectLength);
      const intervals = mergeIntervals(await this.parts(join(directory, 'parts')));
      return this.gapsForIntervals(intervals, totalObjectLength, maximumLength);
    });
  }

  async finalize(id: WalObjectId, totalObjectLength: bigint): Promise<void> {
    assertObjectId(id);
    this.validateTotalLength(totalObjectLength);
    const key = bytesToHex(id);
    await this.withObjectLock(key, async () => {
      if (await this.store.has(id)) {
        await this.removeObjectDirectory(key);
        return;
      }
      const directory = this.objectDirectory(key);
      const metadata = await this.readMetadata(directory);
      if (!metadata) return storeError('WAL_STAGE_INCOMPLETE', 'no staged ranges exist for WalObject');
      this.assertMetadata(metadata, key, totalObjectLength);
      await this.finalizeLocked(id, totalObjectLength, directory);
    });
  }

  async cancel(id: WalObjectId): Promise<void> {
    assertObjectId(id);
    const key = bytesToHex(id);
    await this.withObjectLock(key, async () => this.removeObjectDirectory(key));
  }

  async cleanupExpired(): Promise<number> {
    await this.ensureSafeRoot();
    const cutoff = this.now() - this.stagingLifetimeMs;
    let removed = 0;
    const entries = await readdir(this.stagingRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!/^[0-9a-f]{64}$/.test(entry.name)) continue;
      if (!entry.isDirectory()) {
        return storeError('WAL_STORE_PATH_UNSAFE', 'range staging entry must be a real directory');
      }
      await this.withObjectLock(entry.name, async () => {
        const directory = this.objectDirectory(entry.name);
        const metadata = await this.readMetadata(directory);
        if (!metadata || metadata.updatedAtMs < cutoff) {
          await this.globalLock.run(async () => rm(directory, { recursive: true, force: true }));
          removed += 1;
        }
      });
    }
    if (removed > 0) await fsyncDirectory(this.stagingRoot);
    return removed;
  }

  private validateFrame(frame: WalObjectRangeInput): void {
    assertObjectId(frame.walObjectId);
    this.validateTotalLength(frame.totalObjectLength);
    if (!(frame.bytes instanceof Uint8Array)) {
      storeError('WAL_STAGE_INVALID_RANGE', 'range bytes must be a Uint8Array');
    }
    if (typeof frame.offset !== 'bigint' || frame.offset < 0n || frame.offset > frame.totalObjectLength) {
      storeError('WAL_STAGE_INVALID_RANGE', 'range offset is outside the complete WalObject');
    }
    if (frame.bytes.length > this.maximumRangeBytes) {
      storeError('WAL_STAGE_INVALID_RANGE', 'range exceeds the negotiated maximum length');
    }
    if (frame.bytes.length === 0 && frame.offset !== frame.totalObjectLength) {
      storeError('WAL_STAGE_INVALID_RANGE', 'empty range is valid only as the EOF sentinel');
    }
    const end = frame.offset + BigInt(frame.bytes.length);
    if (end > frame.totalObjectLength) {
      storeError('WAL_STAGE_INVALID_RANGE', 'range extends beyond the advertised total length');
    }
  }

  private assertNotCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) storeError('WAL_STAGE_CANCELLED', 'range acceptance was cancelled');
  }

  private validateTotalLength(totalObjectLength: bigint): void {
    if (typeof totalObjectLength !== 'bigint' || totalObjectLength < 1n || totalObjectLength > this.maximumObjectBytes) {
      storeError('WAL_STORE_OBJECT_TOO_LARGE', 'advertised WalObject length is outside the configured limit');
    }
  }

  private objectDirectory(key: string): string {
    return join(this.stagingRoot, key);
  }

  private async withObjectLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    let entry = this.objectLocks.get(key);
    if (!entry) {
      entry = { lock: new AsyncLock(), users: 0 };
      this.objectLocks.set(key, entry);
    }
    entry.users += 1;
    try {
      return await entry.lock.run(operation);
    } finally {
      entry.users -= 1;
      if (entry.users === 0 && this.objectLocks.get(key) === entry) this.objectLocks.delete(key);
    }
  }

  private gapsForIntervals(
    intervals: readonly { start: bigint; end: bigint }[],
    totalObjectLength: bigint,
    maximumLength: number,
  ): MissingWalObjectRange[] {
    const missing: MissingWalObjectRange[] = [];
    let position = 0n;
    for (const interval of intervals) {
      while (position < interval.start) {
        const length = Number(interval.start - position > BigInt(maximumLength)
          ? BigInt(maximumLength)
          : interval.start - position);
        missing.push({ offset: position, maximumLength: length });
        position += BigInt(length);
      }
      position = interval.end;
    }
    while (position < totalObjectLength) {
      const length = Number(totalObjectLength - position > BigInt(maximumLength)
        ? BigInt(maximumLength)
        : totalObjectLength - position);
      missing.push({ offset: position, maximumLength: length });
      position += BigInt(length);
    }
    return missing;
  }

  private async ensureSafeRoot(): Promise<void> {
    try {
      const details = await lstat(this.stagingRoot);
      if (!details.isDirectory()) {
        return storeError('WAL_STORE_PATH_UNSAFE', 'range staging root must be a real directory');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(this.stagingRoot, { recursive: true });
    }
  }

  private async ensureMetadata(frame: WalObjectRangeInput): Promise<string> {
    await this.ensureSafeRoot();
    const key = bytesToHex(frame.walObjectId);
    const directory = this.objectDirectory(key);
    const existing = await this.readMetadata(directory);
    if (existing) {
      this.assertMetadata(existing, key, frame.totalObjectLength);
      return directory;
    }
    const active = [];
    for (const entry of await readdir(this.stagingRoot, { withFileTypes: true })) {
      if (!/^[0-9a-f]{64}$/.test(entry.name)) continue;
      if (!entry.isDirectory()) {
        return storeError('WAL_STORE_PATH_UNSAFE', 'range staging object must be a real directory');
      }
      active.push(entry);
    }
    const directoryExists = active.some(entry => entry.name === key);
    if (!directoryExists && active.length >= this.maximumConcurrentObjects) {
      return storeError('WAL_STAGE_CONCURRENCY_LIMIT', 'concurrent staged-object limit reached');
    }
    await mkdir(join(directory, 'parts'), { recursive: true });
    const now = this.now();
    const metadata: StagingMetadata = {
      version: 1,
      walObjectId: key,
      totalObjectLength: frame.totalObjectLength.toString(),
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.writeMetadata(directory, metadata, true);
    return directory;
  }

  private async readMetadata(directory: string): Promise<StagingMetadata | null> {
    try {
      const directoryDetails = await lstat(directory);
      if (!directoryDetails.isDirectory()) {
        return storeError('WAL_STORE_PATH_UNSAFE', 'range staging object path must be a real directory');
      }
      const path = join(directory, 'metadata.json');
      const details = await lstat(path);
      if (!details.isFile()) {
        return storeError('WAL_STORE_PATH_UNSAFE', 'range metadata must be a real file');
      }
      const value = JSON.parse(await readFile(path, 'utf8')) as Partial<StagingMetadata>;
      if (
        value.version !== 1
        || typeof value.walObjectId !== 'string'
        || !/^[0-9a-f]{64}$/.test(value.walObjectId)
        || typeof value.totalObjectLength !== 'string'
        || !/^[1-9]\d*$/.test(value.totalObjectLength)
        || !Number.isSafeInteger(value.createdAtMs)
        || !Number.isSafeInteger(value.updatedAtMs)
      ) {
        return storeError('WAL_STAGE_METADATA_INVALID', 'range metadata is malformed');
      }
      return value as StagingMetadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof WalObjectStoreError) throw error;
      return storeError('WAL_STAGE_METADATA_INVALID', 'range metadata cannot be decoded', error);
    }
  }

  private assertMetadata(metadata: StagingMetadata, key: string, totalObjectLength: bigint): void {
    if (metadata.walObjectId !== key) {
      storeError('WAL_STAGE_METADATA_INVALID', 'range metadata is bound to another WalObjectId');
    }
    if (BigInt(metadata.totalObjectLength) !== totalObjectLength) {
      storeError('WAL_STAGE_TOTAL_LENGTH_MISMATCH', 'staged WalObject cannot resume with another total length');
    }
  }

  private async writeMetadata(
    directory: string,
    metadata: StagingMetadata,
    initial: boolean,
  ): Promise<void> {
    const path = join(directory, 'metadata.json');
    const temporary = join(directory, `.metadata.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await writeAll(handle, new TextEncoder().encode(`${JSON.stringify(metadata)}\n`));
      await handle.sync();
      if (initial) await this.durabilityHook?.('metadata-file-synced');
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    if (initial) await this.durabilityHook?.('metadata-renamed');
    await fsyncDirectory(directory);
    if (initial) await this.durabilityHook?.('metadata-directory-synced');
    else await this.durabilityHook?.('progress-metadata-committed');
  }

  private async parts(partsDirectory: string): Promise<StagedPart[]> {
    try {
      const details = await lstat(partsDirectory);
      if (!details.isDirectory()) {
        return storeError('WAL_STORE_PATH_UNSAFE', 'range parts path must be a real directory');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      /* v8 ignore next -- retained to propagate unexpected kernel/filesystem lookup failures. */
      throw error;
    }
    const output: StagedPart[] = [];
    for (const entry of await readdir(partsDirectory, { withFileTypes: true })) {
      const part = parsePart(partsDirectory, entry.name);
      if (!part) continue;
      if (!entry.isFile()) {
        return storeError('WAL_STORE_PATH_UNSAFE', 'staged range part must be a real file');
      }
      const details = await lstat(part.path);
      if (details.size !== part.length) {
        return storeError('WAL_STAGE_METADATA_INVALID', 'staged range part length does not match its durable name');
      }
      output.push(part);
    }
    return output.sort((left, right) => Number(
      left.offset - right.offset || BigInt(left.length - right.length),
    ));
  }

  private async storePart(
    id: WalObjectId,
    totalObjectLength: bigint,
    offset: bigint,
    bytes: Uint8Array,
    directory: string,
    partsDirectory: string,
    signal?: AbortSignal,
  ): Promise<'stored' | 'duplicate'> {
    this.assertNotCancelled(signal);
    const parts = await this.parts(partsDirectory);
    await this.assertOverlapsAgree(parts, offset, bytes);
    const end = offset + BigInt(bytes.length);
    if (isFullyCovered(parts, offset, end)) return 'duplicate';
    if (parts.length >= this.maximumPartsPerObject) {
      return storeError('WAL_STAGE_PART_LIMIT', 'staged range-part limit reached');
    }
    const physicalBytes = await this.stagedPhysicalBytes();
    if (physicalBytes + BigInt(bytes.length) > this.maximumStagedBytes) {
      return storeError('WAL_STAGE_QUOTA_EXCEEDED', 'temporary range staging quota exceeded');
    }
    const finalPath = join(partsDirectory, `${offset}-${bytes.length}.part`);
    const temporary = join(partsDirectory, `.${offset}-${bytes.length}.${randomUUID()}.incoming`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await writeAll(handle, bytes);
      this.assertNotCancelled(signal);
      await handle.sync();
      await this.durabilityHook?.('range-file-synced');
      await handle.close();
      handle = undefined;
      await rename(temporary, finalPath);
      await this.durabilityHook?.('range-renamed');
      await fsyncDirectory(partsDirectory);
      await this.durabilityHook?.('range-directory-synced');
      const metadata = await this.readMetadata(directory);
      if (!metadata) return storeError('WAL_STAGE_METADATA_INVALID', 'range metadata disappeared during write');
      this.assertMetadata(metadata, bytesToHex(id), totalObjectLength);
      await this.writeMetadata(directory, { ...metadata, updatedAtMs: this.now() }, false);
      return 'stored';
    } catch (error) {
      if (error instanceof WalObjectStoreError) throw error;
      return storeError('WAL_STORE_IO', 'failed to durably write staged range', error);
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }

  private async assertOverlapsAgree(
    parts: readonly StagedPart[],
    offset: bigint,
    bytes: Uint8Array,
  ): Promise<void> {
    const end = offset + BigInt(bytes.length);
    for (const part of parts) {
      const overlapStart = part.offset > offset ? part.offset : offset;
      const overlapEnd = part.end < end ? part.end : end;
      if (overlapStart >= overlapEnd) continue;
      let position = overlapStart;
      while (position < overlapEnd) {
        const remaining = overlapEnd - position;
        const length = Number(remaining > BigInt(this.assemblyBufferBytes)
          ? BigInt(this.assemblyBufferBytes)
          : remaining);
        const existing = await readPartSlice(part, position, length);
        const incomingOffset = Number(position - offset);
        if (!equalBytes(existing, bytes.subarray(incomingOffset, incomingOffset + length))) {
          return storeError('WAL_STAGE_RANGE_CONFLICT', 'overlapping range bytes disagree');
        }
        position += BigInt(length);
      }
    }
  }

  private async stagedPhysicalBytes(): Promise<bigint> {
    await this.ensureSafeRoot();
    let total = 0n;
    for (const object of await readdir(this.stagingRoot, { withFileTypes: true })) {
      if (!/^[0-9a-f]{64}$/.test(object.name)) continue;
      if (!object.isDirectory()) {
        return storeError('WAL_STORE_PATH_UNSAFE', 'range staging object must be a real directory');
      }
      const partsDirectory = join(this.stagingRoot, object.name, 'parts');
      try {
        for (const entry of await readdir(partsDirectory, { withFileTypes: true })) {
          if (!entry.name.endsWith('.part') && !entry.name.endsWith('.incoming')) continue;
          if (!entry.isFile()) {
            return storeError('WAL_STORE_PATH_UNSAFE', 'staging quota entry must be a real file');
          }
          total += BigInt((await lstat(join(partsDirectory, entry.name))).size);
        }
      } catch (error) {
        /* v8 ignore next -- only a concurrently removed parts directory is an expected lookup failure. */
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return total;
  }

  private async isCompleteDirectory(directory: string, totalObjectLength: bigint): Promise<boolean> {
    const parts = await this.parts(join(directory, 'parts'));
    const intervals = mergeIntervals(parts);
    return intervals.length === 1 && intervals[0].start === 0n && intervals[0].end === totalObjectLength;
  }

  private async finalizeLocked(
    id: WalObjectId,
    totalObjectLength: bigint,
    directory: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const parts = await this.parts(join(directory, 'parts'));
    const intervals = mergeIntervals(parts);
    if (intervals.length !== 1 || intervals[0].start !== 0n || intervals[0].end !== totalObjectLength) {
      return storeError('WAL_STAGE_INCOMPLETE', 'staged ranges do not cover the complete WalObject');
    }
    const assembling = join(directory, `.complete.${randomUUID()}.assembling`);
    let output;
    try {
      output = await open(assembling, 'wx', 0o600);
      let position = 0n;
      while (position < totalObjectLength) {
        this.assertNotCancelled(signal);
        const covering = parts
          .filter(part => part.offset <= position && part.end > position)
          .sort((left, right) => Number(right.end - left.end));
        const selected = covering[0]!;
        const remaining = selected.end - position;
        const length = Number(remaining > BigInt(this.assemblyBufferBytes)
          ? BigInt(this.assemblyBufferBytes)
          : remaining);
        await writeAll(output, await readPartSlice(selected, position, length));
        position += BigInt(length);
      }
      await output.sync();
      await this.durabilityHook?.('assembly-file-synced');
      await output.close();
      output = undefined;
      await this.store.put(id, fileChunks(assembling, this.assemblyBufferBytes));
      await this.durabilityHook?.('object-promoted');
      await rm(directory, { recursive: true });
      await fsyncDirectory(this.stagingRoot);
      await this.durabilityHook?.('staging-directory-removed');
    } catch (error) {
      const poisoned = error instanceof WalObjectStoreError && new Set([
        'WAL_STORE_INVALID_OBJECT',
        'WAL_STORE_OBJECT_ID_MISMATCH',
        'WAL_STORE_OBJECT_TOO_LARGE',
      ]).has(error.code);
      if (poisoned) {
        await rm(directory, { recursive: true, force: true });
        await fsyncDirectory(this.stagingRoot);
      }
      throw error;
    } finally {
      await output?.close();
      await rm(assembling, { force: true });
    }
  }

  private async removeObjectDirectory(key: string): Promise<void> {
    await this.ensureSafeRoot();
    await rm(this.objectDirectory(key), { recursive: true, force: true });
    await fsyncDirectory(this.stagingRoot);
  }
}
