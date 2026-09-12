import {
  mkdir,
  readdir,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Quad } from '@origintrail-official/dkg-storage';
import { withSnapshotSource, readSnapshotSource, readSnapshotFileIdentity, sameSnapshotSource, sameSnapshotFileIdentity, snapshotPath, SnapshotSourceChangedError, type OpenedSnapshotSource, type SnapshotFileSource, type SnapshotFileIdentity, type SnapshotFileReader } from './workspace-snapshot-source.js';
import { BoundedLruCache } from '@origintrail-official/dkg-core';

export interface SharedMemoryPublicSnapshotStorageConfig {
  enabled?: boolean;
  directory?: string;
  gc?: SharedMemoryPublicSnapshotGarbageCollectionConfig;
}

export interface SharedMemoryPublicSnapshotGarbageCollectionConfig {
  /** Enabled by default. Set false to opt out of the v1 age-based policy. */
  enabled?: boolean;
  /** How often the background pressure check runs. Default: 5 minutes. */
  intervalMs?: number;
  /** Start snapshot eviction below this amount of available space. Default: 15 GiB. */
  triggerFreeBytes?: number;
  /** Continue snapshot eviction until this amount is available. Default: 25 GiB. */
  targetFreeBytes?: number;
  /** Preserve this capacity for the triple store and other node state. Default: 5 GiB. */
  hardReserveBytes?: number;
  /** Never age-evict snapshots newer than this. Default: 7 days. */
  minAgeMs?: number;
  /** Remove abandoned atomic-write files after this age. Default: 1 hour. */
  staleTempAgeMs?: number;
}

export interface SnapshotGarbageCollectionResult {
  readonly triggered: boolean;
  readonly availableBytesBefore: number;
  readonly availableBytesAfter: number;
  readonly deletedSnapshots: number;
  readonly deletedSnapshotBytes: number;
  readonly deletedTempFiles: number;
  readonly deletedTempBytes: number;
  readonly skippedActiveFiles: number;
  readonly failedDeletions: number;
}

export interface FileWorkspacePublicSnapshotStoreOptions {
  readonly gc?: SharedMemoryPublicSnapshotGarbageCollectionConfig;
  readonly log?: (message: string) => void;
  /** Test seam; production callers use statfs(2). Prefer getFilesystemSpace. */
  readonly getAvailableBytes?: (directory: string) => Promise<number>;
  /** Test seam for capacity-aware default watermarks; production callers use statfs(2). */
  readonly getFilesystemSpace?: (directory: string) => Promise<{
    readonly availableBytes: number;
    readonly totalBytes: number;
  }>;
  /** Test seam; production callers use Date.now(). */
  readonly now?: () => number;
}

export interface WorkspacePublicSnapshotStore {
  putSnapshot(input: {
    readonly digest: string;
    readonly quads: readonly Quad[];
  }): Promise<{ readonly ref: string; readonly byteLength: number }>;
  getSnapshot(ref: string): Promise<Quad[] | null>;
  /** Validate complete contents, optionally reusing unchanged file evidence. */
  validateSnapshot?(
    ref: string,
    expectedDigest: string,
    expectedCount: number,
  ): Promise<boolean>;
  /**
   * Read one immutable snapshot page without materializing the complete file.
   * Optional for compatibility with custom/legacy stores; sync responders fall
   * back to `getSnapshot().slice(...)` when it is not implemented.
   */
  getSnapshotPage?(
    ref: string,
    offset: number,
    limit: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Quad[] | null>;
}

export interface SnapshotPageIndexRecord {
  readonly snapshotDigest: string;
  readonly formatVersion: number;
  readonly stride: number;
  readonly snapshotFileSize: number;
  readonly modificationFingerprint: string;
  readonly offsetCount: number;
  readonly offsetsBlob: Uint8Array;
  readonly checksum: string;
}

export interface SnapshotPageIndexStore {
  get(snapshotDigest: string): Promise<SnapshotPageIndexRecord | null>;
  upsert(record: SnapshotPageIndexRecord): Promise<void>;
}

const SNAPSHOT_PAGE_INDEX_VERSION = 1;
const SNAPSHOT_PAGE_INDEX_STRIDE = 128;
const SNAPSHOT_PAGE_INDEX_CACHE_MAX = 64;
const GIB = 1024 ** 3;
const DEFAULT_SNAPSHOT_GC_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_SNAPSHOT_GC_TRIGGER_FREE_BYTES = 15 * GIB;
const DEFAULT_SNAPSHOT_GC_TARGET_FREE_BYTES = 25 * GIB;
const DEFAULT_SNAPSHOT_GC_HARD_RESERVE_BYTES = 5 * GIB;
const DEFAULT_SNAPSHOT_GC_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_SNAPSHOT_GC_STALE_TEMP_AGE_MS = 60 * 60 * 1_000;
const DEFAULT_SNAPSHOT_GC_REFERENCE_FILESYSTEM_BYTES = 75 * GIB;
const SNAPSHOT_FILE_PATTERN = /^([a-f0-9]{64})\.(?:nq|json)$/i;
const SNAPSHOT_TEMP_FILE_PATTERN = /^([a-f0-9]{64})\.(?:nq|json)\.\d+\.\d+\.tmp$/i;
const SNAPSHOT_FILE_STAT_CONCURRENCY = 64;

interface ResolvedSnapshotGarbageCollectionConfig {
  enabled: boolean;
  scaleDefaultWatermarksToFilesystem: boolean;
  intervalMs: number;
  triggerFreeBytes: number;
  targetFreeBytes: number;
  hardReserveBytes: number;
  minAgeMs: number;
  staleTempAgeMs: number;
}

interface SnapshotStoreFile {
  path: string;
  name: string;
  hash: string;
}

interface SnapshotStoreFileMetadata extends SnapshotStoreFile {
  size: number;
  mtimeMs: number;
}

export class SnapshotStorageCapacityError extends Error {
  readonly code = 'SNAPSHOT_STORAGE_CAPACITY';

  constructor(
    readonly availableBytes: number,
    readonly requiredBytes: number,
    readonly hardReserveBytes: number,
  ) {
    super(
      `Insufficient shared-memory snapshot storage capacity: ${availableBytes} bytes available, `
      + `${requiredBytes} bytes required, ${hardReserveBytes} byte hard reserve`,
    );
    this.name = 'SnapshotStorageCapacityError';
  }
}

interface SnapshotPageIndexCore {
  readonly identity: SnapshotFileIdentity;
  readonly version: typeof SNAPSHOT_PAGE_INDEX_VERSION;
  readonly stride: number;
  readonly offsets: readonly number[];
}

export class FileWorkspacePublicSnapshotStore implements WorkspacePublicSnapshotStore {
  private readonly validationCache = new BoundedLruCache<string, {
    source: SnapshotFileSource; digest: string; count: number;
  }>(2048);
  private readonly pageIndexCache = new BoundedLruCache<string, Promise<SnapshotPageIndexCore>>(SNAPSHOT_PAGE_INDEX_CACHE_MAX);
  private readonly pendingWrites = new Map<
    string,
    Promise<{ readonly ref: string; readonly byteLength: number }>
  >();
  private capacityTail: Promise<void> = Promise.resolve();
  private reservedWriteBytes = 0;
  private readonly activeSnapshots = new Map<string, number>();
  private readonly gcConfig: ResolvedSnapshotGarbageCollectionConfig;
  private readonly log?: (message: string) => void;
  private readonly getFilesystemSpace: (directory: string) => Promise<{
    readonly availableBytes: number;
    readonly totalBytes: number;
  }>;
  private readonly now: () => number;
  private readonly gcTimer?: NodeJS.Timeout;
  private garbageCollectionRun?: Promise<SnapshotGarbageCollectionResult>;
  private garbageCollectionRequiredWriteBytes = 0;

  constructor(
    private readonly directory: string,
    private readonly pageIndexStore?: SnapshotPageIndexStore,
    options: FileWorkspacePublicSnapshotStoreOptions = {},
  ) {
    this.gcConfig = resolveSnapshotGarbageCollectionConfig(options.gc);
    this.log = options.log;
    const getAvailableBytes = options.getAvailableBytes;
    this.getFilesystemSpace = options.getFilesystemSpace
      ?? (getAvailableBytes
        ? async (path) => ({
          availableBytes: await getAvailableBytes(path),
          totalBytes: DEFAULT_SNAPSHOT_GC_REFERENCE_FILESYSTEM_BYTES,
        })
        : filesystemSpace);
    this.now = options.now ?? Date.now;
    if (this.gcConfig.enabled) {
      this.gcTimer = setInterval(() => {
        void this.collectGarbage().then((result) => {
          if (
            result.triggered
            || result.deletedSnapshots > 0
            || result.deletedTempFiles > 0
            || result.failedDeletions > 0
          ) {
            this.logGarbageCollection(result);
          }
        }).catch((error) => {
          this.log?.(`[SWM-SNAPSHOT-GC] periodic collection failed: ${errorMessage(error)}`);
        });
      }, this.gcConfig.intervalMs);
      this.gcTimer.unref();
    }
  }

  async putSnapshot(input: {
    readonly digest: string;
    readonly quads: readonly Quad[];
  }): Promise<{ readonly ref: string; readonly byteLength: number }> {
    const hash = snapshotHash(input.digest);
    const pending = this.pendingWrites.get(hash);
    if (pending) return pending;

    // Only capacity admission is serialized. Distinct snapshots may persist in
    // parallel, while the active lease protects each complete write from GC.
    const operation = this.withActiveSnapshot(hash, () => this.putSnapshotOnce(input, hash));
    this.pendingWrites.set(hash, operation);
    try {
      return await operation;
    } finally {
      if (this.pendingWrites.get(hash) === operation) this.pendingWrites.delete(hash);
    }
  }

  private async putSnapshotOnce(
    input: { readonly digest: string; readonly quads: readonly Quad[] },
    hash: string,
  ): Promise<{ readonly ref: string; readonly byteLength: number }> {
    const filePath = snapshotPath(this.directory, hash, 'nq');
    const existingByteLength = await existingFileSize(filePath);
    if (existingByteLength !== null) {
      return { ref: input.digest, byteLength: existingByteLength };
    }

    const { payload, offsets, fileBytes } = serializeWorkspacePublicSnapshotWithIndex(input.quads);

    await mkdir(dirname(filePath), { recursive: true });
    const releaseCapacity = await this.reserveWriteCapacity(fileBytes);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      try {
        await writeFile(tempPath, payload, 'utf8');
        await rename(tempPath, filePath).catch(async (err: NodeJS.ErrnoException) => {
          if (err.code === 'EEXIST') return;
          throw err;
        });
      } finally {
        await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') {
            this.log?.(`[SWM-SNAPSHOT-GC] failed to remove write temp file ${tempPath}: ${error.message}`);
          }
        });
      }
    } finally {
      // Once the file is published (or the temporary write is cleaned up), a
      // fresh filesystem reading accounts for its bytes. Index work remains
      // protected by the active lease but does not retain a byte reservation.
      releaseCapacity();
    }

    const fingerprint = await readSnapshotFileIdentity(filePath);
    const index: SnapshotPageIndexCore = {
      version: SNAPSHOT_PAGE_INDEX_VERSION,
      identity: fingerprint,
      stride: SNAPSHOT_PAGE_INDEX_STRIDE,
      offsets,
    };
    await this.persistSnapshotPageIndexBestEffort(input.digest, index);
    this.pageIndexCache.set(hash, Promise.resolve(index));

    return {
      ref: input.digest,
      byteLength: fileBytes,
    };
  }

  async getSnapshot(ref: string): Promise<Quad[] | null> {
    const hash = snapshotHash(ref);
    return this.withActiveSnapshotSource(hash, async source =>
      source === null ? null : this.readSnapshot(source, ref));
  }

  /** Lease-free primitive over the source already opened by the owning operation. */
  private async readSnapshot(source: OpenedSnapshotSource, ref: string): Promise<Quad[] | null> {
    const raw = await readSnapshotSource(source);
    return source.reference.format === 'nq'
      ? parseWorkspacePublicSnapshotNQuads(raw, ref)
      : parseLegacyJsonSnapshot(raw, ref);
  }

  async validateSnapshot(ref: string, expectedDigest: string, expectedCount: number): Promise<boolean> {
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) return false;
    let hash: string;
    try { hash = snapshotHash(ref); } catch { return false; }
    try {
      return await this.withActiveSnapshotSource(hash, async source => {
        if (source === null) { this.validationCache.delete(hash); return false; }
        const cached = this.validationCache.get(hash);
        if (cached && sameSnapshotSource(cached.source, source.reference)) {
          await source.assertCurrent();
          return cached.digest === expectedDigest && cached.count === expectedCount;
        }
        this.validationCache.delete(hash);
        const quads = await this.readSnapshot(source, ref);
        if (quads === null) return false;
        const observed = { count: quads.length, digest: workspacePublicQuadsDigest(quads) };
        await source.assertCurrent();
        this.validationCache.set(hash, { source: source.reference, ...observed });
        return observed.digest === expectedDigest && observed.count === expectedCount;
      });
    } catch {
      this.validationCache.delete(hash);
      // Missing/unreadable/corrupt or changed sources remain recovery candidates.
      return false;
    }
  }

  async getSnapshotPage(
    ref: string,
    offset: number,
    limit: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Quad[] | null> {
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(0, Math.floor(limit));
    if (safeLimit === 0) return [];
    const hash = snapshotHash(ref);
    return this.withActiveSnapshotSource(hash, async source => {
      if (source === null) return null;
      if (source.reference.format === 'json') {
        const legacy = await this.readSnapshot(source, ref);
        return legacy?.slice(safeOffset, safeOffset + safeLimit) ?? null;
      }
      return source.read(async file => {
        let startRow = 0;
        let startByte = 0;
        try {
          const index = await this.getPageIndex(hash, source);
          const checkpoint = Math.min(Math.floor(safeOffset / index.stride), Math.max(0, index.offsets.length - 1));
          startRow = checkpoint * index.stride;
          startByte = index.offsets[checkpoint] ?? 0;
        } catch (error) {
          if (error instanceof SnapshotSourceChangedError) throw error;
          // Derived index failures can fall back to this same opened source.
          // The source boundary still rejects any concurrent file change.
        }
        const page: Quad[] = [];
        let row = startRow;
        for await (const rawLine of readSnapshotLines(file, startByte, options?.signal)) {
          const line = rawLine.trim();
          if (!line) continue;
          if (row >= safeOffset) {
            page.push(parseNQuadLine(line, ref, row));
            if (page.length >= safeLimit) break;
          }
          row += 1;
        }
        return page;
      });
    });
  }

  stopGarbageCollection(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
  }

  async collectGarbage(
    options: { readonly requiredWriteBytes?: number } = {},
  ): Promise<SnapshotGarbageCollectionResult> {
    if (!this.gcConfig.enabled) return emptyGarbageCollectionResult();
    const requiredWriteBytes = Math.max(0, options.requiredWriteBytes ?? 0);
    if (this.garbageCollectionRun) {
      const runningRequiredWriteBytes = this.garbageCollectionRequiredWriteBytes;
      const result = await this.garbageCollectionRun;
      return requiredWriteBytes > runningRequiredWriteBytes
        ? this.collectGarbage({ requiredWriteBytes })
        : result;
    }

    const run = this.collectGarbageOnce(requiredWriteBytes);
    this.garbageCollectionRequiredWriteBytes = requiredWriteBytes;
    this.garbageCollectionRun = run;
    try {
      return await run;
    } finally {
      if (this.garbageCollectionRun === run) {
        this.garbageCollectionRun = undefined;
        this.garbageCollectionRequiredWriteBytes = 0;
      }
    }
  }

  private async collectGarbageOnce(
    requiredWriteBytes: number,
  ): Promise<SnapshotGarbageCollectionResult> {
    await mkdir(this.directory, { recursive: true });
    const filesystem = await this.getFilesystemSpace(this.directory);
    const availableBytesBefore = filesystem.availableBytes;
    const watermarks = snapshotGarbageCollectionWatermarks(
      this.gcConfig,
      filesystem.totalBytes,
    );
    let availableBytesAfter = availableBytesBefore;
    let deletedSnapshots = 0;
    let deletedSnapshotBytes = 0;
    let deletedTempFiles = 0;
    let deletedTempBytes = 0;
    let skippedActiveFiles = 0;
    let failedDeletions = 0;
    const now = this.now();
    const files = await listSnapshotStoreFiles(this.directory);
    const tempFiles = files.filter((file) => SNAPSHOT_TEMP_FILE_PATTERN.test(file.name));
    const staleTempFiles = await statSnapshotStoreFiles(
      tempFiles,
      now - this.gcConfig.staleTempAgeMs,
    );

    for (const file of staleTempFiles) {
      if (this.isSnapshotActive(file.hash)) {
        skippedActiveFiles += 1;
        continue;
      }
      try {
        await unlink(file.path);
        deletedTempFiles += 1;
        deletedTempBytes += file.size;
        availableBytesAfter += file.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failedDeletions += 1;
      }
    }

    const triggered = availableBytesBefore < watermarks.triggerFreeBytes
      || availableBytesBefore - requiredWriteBytes < watermarks.hardReserveBytes;
    if (triggered) {
      const targetAvailableBytes = Math.max(
        watermarks.targetFreeBytes,
        watermarks.hardReserveBytes + requiredWriteBytes,
      );
      const snapshotFiles = files.filter((file) => SNAPSHOT_FILE_PATTERN.test(file.name));
      const candidates = await statSnapshotStoreFiles(
        snapshotFiles,
        now - this.gcConfig.minAgeMs,
      );
      candidates.sort(
        (left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path),
      );

      for (const file of candidates) {
        if (availableBytesAfter >= targetAvailableBytes) break;
        if (this.isSnapshotActive(file.hash)) {
          skippedActiveFiles += 1;
          continue;
        }
        try {
          await unlink(file.path);
          deletedSnapshots += 1;
          deletedSnapshotBytes += file.size;
          availableBytesAfter += file.size;
          this.pageIndexCache.delete(file.hash);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failedDeletions += 1;
        }
      }
    }

    return {
      triggered,
      availableBytesBefore,
      availableBytesAfter,
      deletedSnapshots,
      deletedSnapshotBytes,
      deletedTempFiles,
      deletedTempBytes,
      skippedActiveFiles,
      failedDeletions,
    };
  }

  private reserveWriteCapacity(requiredWriteBytes: number): Promise<() => void> {
    const admission = this.capacityTail.then(async () => {
      await this.ensureWriteCapacity(requiredWriteBytes);
      this.reservedWriteBytes += requiredWriteBytes;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.reservedWriteBytes -= requiredWriteBytes;
      };
    });
    this.capacityTail = admission.then(() => {}, () => {});
    return admission;
  }

  private async readWriteCapacity(): Promise<{ availableBytes: number; totalBytes: number }> {
    for (;;) {
      const reservedBytes = this.reservedWriteBytes;
      const filesystem = await this.getFilesystemSpace(this.directory);
      // Admission is serialized, so reservations can only retire during this
      // read. Retry if one retires: the reading may predate its physical write,
      // and subtracting the new, smaller reservation would overstate capacity.
      if (reservedBytes !== this.reservedWriteBytes) continue;
      return {
        ...filesystem,
        availableBytes: Math.max(0, filesystem.availableBytes - reservedBytes),
      };
    }
  }

  private async ensureWriteCapacity(requiredWriteBytes: number): Promise<void> {
    if (!this.gcConfig.enabled) return;
    const filesystem = await this.readWriteCapacity();
    const availableBytes = filesystem.availableBytes;
    const watermarks = snapshotGarbageCollectionWatermarks(
      this.gcConfig,
      filesystem.totalBytes,
    );
    const needsCollection = availableBytes < watermarks.triggerFreeBytes
      || availableBytes - requiredWriteBytes < watermarks.hardReserveBytes;
    const result = needsCollection
      ? await this.collectGarbage({ requiredWriteBytes: requiredWriteBytes + this.reservedWriteBytes })
      : undefined;
    // Admission is based on a fresh filesystem reading, not projected file
    // sizes: an unlinked file held open by another process may not have
    // released its blocks yet.
    const filesystemAfterCollection = result
      ? await this.readWriteCapacity()
      : filesystem;
    const availableAfterCollection = filesystemAfterCollection.availableBytes;
    if (availableAfterCollection - requiredWriteBytes < watermarks.hardReserveBytes) {
      throw new SnapshotStorageCapacityError(
        availableAfterCollection,
        requiredWriteBytes,
        watermarks.hardReserveBytes,
      );
    }
    if (
      result
      && (
        result.triggered
        || result.deletedSnapshots > 0
        || result.deletedTempFiles > 0
        || result.failedDeletions > 0
      )
    ) {
      this.logGarbageCollection(result);
    }
  }

  /** Keep the GC lease from source selection through descriptor retirement. */
  private withActiveSnapshotSource<T>(
    hash: string,
    operation: (source: OpenedSnapshotSource | null) => Promise<T>,
  ): Promise<T> {
    return this.withActiveSnapshot(hash, () => withSnapshotSource(this.directory, hash, operation));
  }

  private async withActiveSnapshot<T>(hash: string, operation: () => Promise<T>): Promise<T> {
    this.activeSnapshots.set(hash, (this.activeSnapshots.get(hash) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = (this.activeSnapshots.get(hash) ?? 1) - 1;
      if (remaining > 0) this.activeSnapshots.set(hash, remaining);
      else this.activeSnapshots.delete(hash);
    }
  }

  private isSnapshotActive(hash: string): boolean {
    return (this.activeSnapshots.get(hash) ?? 0) > 0;
  }

  private logGarbageCollection(result: SnapshotGarbageCollectionResult): void {
    this.log?.(
      `[SWM-SNAPSHOT-GC] triggered=${result.triggered} snapshots=${result.deletedSnapshots} `
      + `snapshotBytes=${result.deletedSnapshotBytes} tempFiles=${result.deletedTempFiles} `
      + `tempBytes=${result.deletedTempBytes} availableBefore=${result.availableBytesBefore} `
      + `availableAfter=${result.availableBytesAfter} activeSkipped=${result.skippedActiveFiles} `
      + `failed=${result.failedDeletions}`,
    );
  }

  private async getPageIndex(hash: string, source: OpenedSnapshotSource): Promise<SnapshotPageIndexCore> {
    const existing = this.pageIndexCache.get(hash);
    if (existing) {
      const index = await existing;
      if (sameSnapshotFileIdentity(index.identity, source.reference.identity)) return index;
      if (this.pageIndexCache.get(hash) === existing) this.pageIndexCache.delete(hash);
    }
    const load = this.loadOrBuildPageIndex(hash, source).catch(error => {
      if (this.pageIndexCache.get(hash) === load) this.pageIndexCache.delete(hash);
      throw error;
    });
    this.pageIndexCache.set(hash, load);
    return load;
  }

  private async loadOrBuildPageIndex(hash: string, source: OpenedSnapshotSource): Promise<SnapshotPageIndexCore> {
    if (this.pageIndexStore) {
      try {
        const record = await this.pageIndexStore.get(canonicalSnapshotDigest(hash));
        const index = decodeSnapshotPageIndexRecord(record, source.reference.identity, hash);
        if (index) return index;
      } catch {
        // The index is derived data; a failed SQLite read must not block paging.
      }
    }
    const index = await buildSnapshotPageIndex(source);
    await this.persistSnapshotPageIndexBestEffort(hash, index);
    return index;
  }

  private async persistSnapshotPageIndexBestEffort(
    ref: string,
    index: SnapshotPageIndexCore,
  ): Promise<void> {
    if (!this.pageIndexStore) return;
    try {
      const offsetsBlob = encodeSnapshotPageIndexOffsets(index.offsets);
      const recordCore = {
        snapshotDigest: canonicalSnapshotDigest(ref),
        formatVersion: index.version,
        stride: index.stride,
        snapshotFileSize: index.identity.size,
        modificationFingerprint: snapshotModificationFingerprint(index.identity),
        offsetCount: index.offsets.length,
        offsetsBlob,
      };
      await this.pageIndexStore.upsert({
        ...recordCore,
        checksum: snapshotPageIndexRecordChecksum(recordCore),
      });
    } catch {
      // The index is derived data; snapshot writes and reads remain usable.
    }
  }

}

function parseLegacyJsonSnapshot(raw: string, ref: string): Quad[] | null {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return null;
  return parsed.map((entry) => {
    if (!Array.isArray(entry) || entry.length < 3) {
      throw new Error(`Invalid shared-memory public snapshot blob ${ref}`);
    }
    return {
      subject: String(entry[0]),
      predicate: String(entry[1]),
      object: String(entry[2]),
      graph: '',
    };
  });
}

function snapshotHash(ref: string): string {
  const trimmed = ref.trim();
  const hash = trimmed.startsWith('sha256:') ? trimmed.slice('sha256:'.length) : trimmed;
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error(`Invalid shared-memory public snapshot ref ${ref}`);
  }
  return hash.toLowerCase();
}

function canonicalSnapshotDigest(ref: string): string {
  return `sha256:${snapshotHash(ref)}`;
}

function resolveSnapshotGarbageCollectionConfig(
  config: SharedMemoryPublicSnapshotGarbageCollectionConfig | undefined,
): ResolvedSnapshotGarbageCollectionConfig {
  const enabled = config?.enabled ?? true;
  if (typeof enabled !== 'boolean') {
    throw new Error('sharedMemoryPublicSnapshotStorage.gc.enabled must be a boolean');
  }
  const resolved = {
    enabled,
    scaleDefaultWatermarksToFilesystem: config?.triggerFreeBytes === undefined
      && config?.targetFreeBytes === undefined
      && config?.hardReserveBytes === undefined,
    intervalMs: snapshotGcInteger(
      config?.intervalMs,
      DEFAULT_SNAPSHOT_GC_INTERVAL_MS,
      'intervalMs',
      1,
    ),
    triggerFreeBytes: snapshotGcInteger(
      config?.triggerFreeBytes,
      DEFAULT_SNAPSHOT_GC_TRIGGER_FREE_BYTES,
      'triggerFreeBytes',
      0,
    ),
    targetFreeBytes: snapshotGcInteger(
      config?.targetFreeBytes,
      DEFAULT_SNAPSHOT_GC_TARGET_FREE_BYTES,
      'targetFreeBytes',
      0,
    ),
    hardReserveBytes: snapshotGcInteger(
      config?.hardReserveBytes,
      DEFAULT_SNAPSHOT_GC_HARD_RESERVE_BYTES,
      'hardReserveBytes',
      0,
    ),
    minAgeMs: snapshotGcInteger(
      config?.minAgeMs,
      DEFAULT_SNAPSHOT_GC_MIN_AGE_MS,
      'minAgeMs',
      0,
    ),
    staleTempAgeMs: snapshotGcInteger(
      config?.staleTempAgeMs,
      DEFAULT_SNAPSHOT_GC_STALE_TEMP_AGE_MS,
      'staleTempAgeMs',
      0,
    ),
  };
  if (resolved.targetFreeBytes < resolved.triggerFreeBytes) {
    throw new Error(
      'sharedMemoryPublicSnapshotStorage.gc.targetFreeBytes must be greater than or equal to triggerFreeBytes',
    );
  }
  if (resolved.hardReserveBytes >= resolved.triggerFreeBytes) {
    throw new Error(
      'sharedMemoryPublicSnapshotStorage.gc.hardReserveBytes must be less than triggerFreeBytes',
    );
  }
  return resolved;
}

function snapshotGarbageCollectionWatermarks(
  config: ResolvedSnapshotGarbageCollectionConfig,
  totalBytes: number,
): Pick<
  ResolvedSnapshotGarbageCollectionConfig,
  'triggerFreeBytes' | 'targetFreeBytes' | 'hardReserveBytes'
> {
  if (!config.scaleDefaultWatermarksToFilesystem) return config;
  const safeTotalBytes = Math.max(1, Math.floor(totalBytes));
  const triggerFreeBytes = Math.max(
    1,
    Math.min(config.triggerFreeBytes, Math.floor(safeTotalBytes / 5)),
  );
  const targetFreeBytes = Math.max(
    triggerFreeBytes,
    Math.min(config.targetFreeBytes, Math.floor(safeTotalBytes / 3)),
  );
  const hardReserveBytes = Math.min(
    triggerFreeBytes - 1,
    config.hardReserveBytes,
    Math.floor(safeTotalBytes / 15),
  );
  return { triggerFreeBytes, targetFreeBytes, hardReserveBytes };
}

function snapshotGcInteger(
  value: number | undefined,
  defaultValue: number,
  field: string,
  minimum: number,
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new Error(
      `sharedMemoryPublicSnapshotStorage.gc.${field} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
  return resolved;
}

async function filesystemSpace(directory: string): Promise<{
  readonly availableBytes: number;
  readonly totalBytes: number;
}> {
  const filesystem = await statfs(directory);
  return {
    availableBytes: filesystem.bavail * filesystem.bsize,
    totalBytes: filesystem.blocks * filesystem.bsize,
  };
}

async function existingFileSize(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function listSnapshotStoreFiles(directory: string): Promise<SnapshotStoreFile[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: SnapshotStoreFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(SNAPSHOT_FILE_PATTERN)
      ?? entry.name.match(SNAPSHOT_TEMP_FILE_PATTERN);
    if (!match?.[1]) continue;
    files.push({
      path: join(entry.parentPath, entry.name),
      name: entry.name,
      hash: match[1].toLowerCase(),
    });
  }
  return files;
}

async function statSnapshotStoreFiles(
  files: readonly SnapshotStoreFile[],
  latestMtimeMs: number,
): Promise<SnapshotStoreFileMetadata[]> {
  const result: SnapshotStoreFileMetadata[] = [];
  for (let offset = 0; offset < files.length; offset += SNAPSHOT_FILE_STAT_CONCURRENCY) {
    const batch = files.slice(offset, offset + SNAPSHOT_FILE_STAT_CONCURRENCY);
    const metadata = await Promise.all(batch.map(async (file) => {
      try {
        const fileStat = await stat(file.path);
        if (!fileStat.isFile() || fileStat.mtimeMs > latestMtimeMs) return null;
        return { ...file, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }));
    result.push(...metadata.filter((value): value is SnapshotStoreFileMetadata => value !== null));
  }
  return result;
}

function emptyGarbageCollectionResult(): SnapshotGarbageCollectionResult {
  return {
    triggered: false,
    availableBytesBefore: 0,
    availableBytesAfter: 0,
    deletedSnapshots: 0,
    deletedSnapshotBytes: 0,
    deletedTempFiles: 0,
    deletedTempBytes: 0,
    skippedActiveFiles: 0,
    failedDeletions: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serializeWorkspacePublicSnapshotWithIndex(quads: readonly Quad[]): {
  payload: string;
  offsets: number[];
  fileBytes: number;
} {
  if (quads.length === 0) return { payload: '', offsets: [0], fileBytes: 0 };
  const lines = quads.map(quadToNQuad);
  const offsets = [0];
  let fileBytes = 0;
  for (let row = 0; row < lines.length; row += 1) {
    fileBytes += Buffer.byteLength(lines[row]!, 'utf8') + 1;
    if (isSnapshotPageIndexCheckpoint(row + 1)) offsets.push(fileBytes);
  }
  return { payload: `${lines.join('\n')}\n`, offsets, fileBytes };
}

/** No prefetch or stream-owned close: each physical read finishes inside the source lease. */
async function* readSnapshotLines(file: SnapshotFileReader, start: number, signal?: AbortSignal): AsyncGenerator<string> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let position = start;
  let pending = '';
  while (true) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    signal?.throwIfAborted();
    if (bytesRead === 0) break;
    position += bytesRead;
    pending += decoder.write(buffer.subarray(0, bytesRead));
    let lineStart = 0;
    let newline: number;
    while ((newline = pending.indexOf('\n', lineStart)) !== -1) {
      signal?.throwIfAborted();
      yield pending.slice(lineStart, newline);
      lineStart = newline + 1;
    }
    pending = pending.slice(lineStart);
  }
  pending += decoder.end();
  if (pending) yield pending;
}

async function buildSnapshotPageIndex(source: OpenedSnapshotSource): Promise<SnapshotPageIndexCore> {
  return source.read(async file => {
    const offsets = [0];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let absoluteOffset = 0;
    let rows = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, absoluteOffset);
      if (bytesRead === 0) break;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        rows += 1;
        if (isSnapshotPageIndexCheckpoint(rows)) offsets.push(absoluteOffset + index + 1);
      }
      absoluteOffset += bytesRead;
    }
    return { version: SNAPSHOT_PAGE_INDEX_VERSION, identity: source.reference.identity, stride: SNAPSHOT_PAGE_INDEX_STRIDE, offsets };
  });
}

function isSnapshotPageIndexCheckpoint(row: number): boolean {
  return row > 0 && row % SNAPSHOT_PAGE_INDEX_STRIDE === 0;
}

function snapshotModificationFingerprint(
  identity: SnapshotFileIdentity,
): string {
  return `${Number(identity.mtimeNs) / 1_000_000}:${Number(identity.ctimeNs) / 1_000_000}`;
}

function encodeSnapshotPageIndexOffsets(offsets: readonly number[]): Uint8Array {
  const blob = Buffer.allocUnsafe(offsets.length * 8);
  offsets.forEach((offset, position) => {
    blob.writeBigUInt64BE(BigInt(offset), position * 8);
  });
  return blob;
}

function snapshotPageIndexRecordChecksum(
  record: Omit<SnapshotPageIndexRecord, 'checksum'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      record.snapshotDigest,
      record.formatVersion,
      record.stride,
      record.snapshotFileSize,
      record.modificationFingerprint,
      record.offsetCount,
    ]))
    .update(record.offsetsBlob)
    .digest('hex');
}

function decodeSnapshotPageIndexRecord(
  value: SnapshotPageIndexRecord | null,
  fingerprint: SnapshotFileIdentity,
  ref: string,
): SnapshotPageIndexCore | null {
  if (!value || typeof value !== 'object') return null;
  if (
    value.snapshotDigest !== canonicalSnapshotDigest(ref)
    || value.formatVersion !== SNAPSHOT_PAGE_INDEX_VERSION
    || value.stride !== SNAPSHOT_PAGE_INDEX_STRIDE
    || value.snapshotFileSize !== fingerprint.size
    || value.modificationFingerprint !== snapshotModificationFingerprint(fingerprint)
    || !Number.isSafeInteger(value.offsetCount)
    || value.offsetCount <= 0
    || !(value.offsetsBlob instanceof Uint8Array)
    || value.offsetsBlob.byteLength !== value.offsetCount * 8
    || typeof value.checksum !== 'string'
    || value.checksum !== snapshotPageIndexRecordChecksum(value)
  ) return null;

  const blob = Buffer.from(value.offsetsBlob);
  const offsets: number[] = [];
  let previous = -1;
  for (let position = 0; position < value.offsetCount; position += 1) {
    const offsetBigInt = blob.readBigUInt64BE(position * 8);
    if (offsetBigInt > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const offset = Number(offsetBigInt);
    if (offset < previous || offset > fingerprint.size) return null;
    offsets.push(offset);
    previous = offset;
  }
  if (offsets[0] !== 0) return null;

  return {
    version: SNAPSHOT_PAGE_INDEX_VERSION,
    identity: fingerprint,
    stride: SNAPSHOT_PAGE_INDEX_STRIDE,
    offsets,
  };
}

export function serializeWorkspacePublicSnapshotQuads(quads: readonly Quad[]): string {
  return serializeWorkspacePublicSnapshotWithIndex(quads).payload;
}

export function workspacePublicQuadsDigest(quads: readonly Quad[]): string {
  const canonical = quads
    .map((quad) => JSON.stringify([quad.subject, quad.predicate, quad.object, '']))
    .sort((a, b) => a.localeCompare(b));
  const hash = createHash('sha256');
  hash.update('[');
  canonical.forEach((row, index) => {
    if (index > 0) hash.update(',');
    hash.update(row);
  });
  hash.update(']');
  return `sha256:${hash.digest('hex')}`;
}

function quadToNQuad(quad: Quad): string {
  return `${formatNodeTerm(quad.subject)} <${escapeIri(quad.predicate)}> ${formatObjectTerm(quad.object)} .`;
}

function formatNodeTerm(term: string): string {
  if (term.startsWith('_:')) return term;
  if (term.startsWith('<') && term.endsWith('>')) return term;
  return `<${escapeIri(term)}>`;
}

function formatObjectTerm(term: string): string {
  if (term.startsWith('"')) {
    const bareDatatype = term.match(/^("(?:[^"\\]|\\.)*")\^\^(?!<)(.+)$/);
    return bareDatatype ? `${bareDatatype[1]}^^<${escapeIri(bareDatatype[2])}>` : term;
  }
  return formatNodeTerm(term);
}

function escapeIri(iri: string): string {
  return iri.replace(/[<>"{}|\\^`]/g, '');
}

export function parseWorkspacePublicSnapshotNQuads(raw: string, ref: string): Quad[] {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => parseNQuadLine(line, ref, index));
}

function parseNQuadLine(line: string, ref: string, index: number): Quad {
  const parsedSubject = readTerm(line, 0);
  if (!parsedSubject) throw invalidSnapshotBlob(ref, index);

  const parsedPredicate = readTerm(line, parsedSubject.end);
  if (!parsedPredicate || !isIriTerm(parsedPredicate.term)) throw invalidSnapshotBlob(ref, index);

  const parsedObject = readTerm(line, parsedPredicate.end);
  if (!parsedObject) throw invalidSnapshotBlob(ref, index);

  const rest = line.slice(parsedObject.end).trim();
  if (rest !== '.') throw invalidSnapshotBlob(ref, index);

  return {
    subject: normalizeParsedResourceTerm(parsedSubject.term),
    predicate: normalizeParsedResourceTerm(parsedPredicate.term),
    object: normalizeParsedObjectTerm(parsedObject.term),
    graph: '',
  };
}

function readTerm(input: string, start: number): { term: string; end: number } | null {
  let cursor = skipWhitespace(input, start);
  if (cursor >= input.length) return null;

  if (input[cursor] === '<') {
    const end = input.indexOf('>', cursor + 1);
    if (end < 0) return null;
    return { term: input.slice(cursor, end + 1), end: end + 1 };
  }

  if (input.startsWith('_:', cursor)) {
    const end = readUntilWhitespace(input, cursor);
    return { term: input.slice(cursor, end), end };
  }

  if (input[cursor] === '"') {
    return readLiteralTerm(input, cursor);
  }

  return null;
}

function readLiteralTerm(input: string, start: number): { term: string; end: number } | null {
  const quoteEnd = findClosingLiteralQuote(input, start);
  if (quoteEnd < 0) return null;

  let end = quoteEnd + 1;
  if (input[end] === '@') {
    end += 1;
    while (end < input.length && /[A-Za-z0-9-]/.test(input[end])) end += 1;
  } else if (input.slice(end, end + 2) === '^^') {
    end += 2;
    if (input[end] === '<') {
      const datatypeEnd = input.indexOf('>', end + 1);
      if (datatypeEnd < 0) return null;
      end = datatypeEnd + 1;
    } else {
      end = readUntilWhitespace(input, end);
    }
  }

  return { term: input.slice(start, end), end };
}

function findClosingLiteralQuote(input: string, start: number): number {
  for (let i = start + 1; i < input.length; i += 1) {
    if (input[i] !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= start && input[j] === '\\'; j -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

function skipWhitespace(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length && /\s/.test(input[cursor])) cursor += 1;
  return cursor;
}

function readUntilWhitespace(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length && !/\s/.test(input[cursor])) cursor += 1;
  return cursor;
}

function isIriTerm(term: string): boolean {
  return term.startsWith('<') && term.endsWith('>');
}

function normalizeParsedResourceTerm(term: string): string {
  if (isIriTerm(term)) return term.slice(1, -1);
  return term;
}

function normalizeParsedObjectTerm(term: string): string {
  return isIriTerm(term) ? term.slice(1, -1) : term;
}

function invalidSnapshotBlob(ref: string, index: number): Error {
  return new Error(`Invalid shared-memory public snapshot blob ${ref} at line ${index + 1}`);
}
