import {
  mkdir,
  open,
  readFile,
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
import { createInterface } from 'node:readline';
import type { Quad } from '@origintrail-official/dkg-storage';

export interface SharedMemoryPublicSnapshotStorageConfig {
  enabled?: boolean;
  directory?: string;
  gc?: SharedMemoryPublicSnapshotGarbageCollectionConfig;
}

export interface SharedMemoryPublicSnapshotGarbageCollectionConfig {
  /** Disabled by default so operators opt in to the v1 age-based policy. */
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
  /** Test seam; production callers use statfs(2). */
  readonly getAvailableBytes?: (directory: string) => Promise<number>;
  /** Test seam; production callers use Date.now(). */
  readonly now?: () => number;
}

export interface WorkspacePublicSnapshotStore {
  putSnapshot(input: {
    readonly digest: string;
    readonly quads: readonly Quad[];
  }): Promise<{ readonly ref: string; readonly byteLength: number }>;
  getSnapshot(ref: string): Promise<Quad[] | null>;
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
const SNAPSHOT_FILE_PATTERN = /^([a-f0-9]{64})\.(?:nq|json)$/i;
const SNAPSHOT_TEMP_FILE_PATTERN = /^([a-f0-9]{64})\.(?:nq|json)\.\d+\.\d+\.tmp$/i;
const SNAPSHOT_FILE_STAT_CONCURRENCY = 64;

interface ResolvedSnapshotGarbageCollectionConfig {
  enabled: boolean;
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
  version: typeof SNAPSHOT_PAGE_INDEX_VERSION;
  stride: number;
  offsets: number[];
  fileBytes: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface SnapshotFileFingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export class FileWorkspacePublicSnapshotStore implements WorkspacePublicSnapshotStore {
  private readonly pageIndexCache = new Map<string, Promise<SnapshotPageIndexCore>>();
  private readonly pendingWrites = new Map<
    string,
    Promise<{ readonly ref: string; readonly byteLength: number }>
  >();
  private readonly activeSnapshots = new Map<string, number>();
  private readonly gcConfig: ResolvedSnapshotGarbageCollectionConfig;
  private readonly log?: (message: string) => void;
  private readonly getAvailableBytes: (directory: string) => Promise<number>;
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
    this.getAvailableBytes = options.getAvailableBytes ?? filesystemAvailableBytes;
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
    await this.ensureWriteCapacity(fileBytes);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
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

    const fingerprint = await stat(filePath);
    const index: SnapshotPageIndexCore = {
      version: SNAPSHOT_PAGE_INDEX_VERSION,
      stride: SNAPSHOT_PAGE_INDEX_STRIDE,
      offsets,
      fileBytes,
      mtimeMs: fingerprint.mtimeMs,
      ctimeMs: fingerprint.ctimeMs,
    };
    await this.persistSnapshotPageIndexBestEffort(input.digest, index);
    this.rememberPageIndex(input.digest, Promise.resolve(index));

    return {
      ref: input.digest,
      byteLength: fileBytes,
    };
  }

  async getSnapshot(ref: string): Promise<Quad[] | null> {
    const hash = snapshotHash(ref);
    return this.withActiveSnapshot(hash, async () => {
      const nquadsPath = snapshotPath(this.directory, hash, 'nq');
      let raw: string;
      try {
        raw = await readFile(nquadsPath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        return this.getLegacyJsonSnapshot(ref, hash);
      }

      return parseWorkspacePublicSnapshotNQuads(raw, ref);
    });
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
    return this.withActiveSnapshot(hash, async () => {
      const nquadsPath = snapshotPath(this.directory, hash, 'nq');
      let file: Awaited<ReturnType<typeof open>>;
      try {
        file = await open(nquadsPath, 'r');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const legacy = await this.getLegacyJsonSnapshot(ref, hash);
        return legacy?.slice(safeOffset, safeOffset + safeLimit) ?? null;
      }

      let startRow = 0;
      let startByte = 0;
      try {
        const index = await this.getPageIndex(ref, nquadsPath);
        const checkpoint = Math.min(
          Math.floor(safeOffset / index.stride),
          Math.max(0, index.offsets.length - 1),
        );
        startRow = checkpoint * index.stride;
        startByte = index.offsets[checkpoint] ?? 0;
      } catch {
        // Page indexes are derived data. The already-open snapshot remains the
        // source of truth, so index failures fall back to scanning from row zero.
      }

      const input = file.createReadStream({
        encoding: 'utf8',
        autoClose: false,
        start: startByte,
        signal: options?.signal,
      });
      const lines = createInterface({ input, crlfDelay: Infinity });
      const page: Quad[] = [];
      let row = startRow;
      try {
        for await (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (row >= safeOffset) {
            page.push(parseNQuadLine(line, ref, row));
            if (page.length >= safeLimit) break;
          }
          row += 1;
        }
        return page;
      } finally {
        lines.close();
        input.destroy();
        await file.close().catch(() => {});
      }
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
    const availableBytesBefore = await this.getAvailableBytes(this.directory);
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

    const triggered = availableBytesBefore < this.gcConfig.triggerFreeBytes
      || availableBytesBefore - requiredWriteBytes < this.gcConfig.hardReserveBytes;
    if (triggered) {
      const targetAvailableBytes = Math.max(
        this.gcConfig.targetFreeBytes,
        this.gcConfig.hardReserveBytes + requiredWriteBytes,
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
          this.forgetPageIndex(file.hash);
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

  private async ensureWriteCapacity(requiredWriteBytes: number): Promise<void> {
    if (!this.gcConfig.enabled) return;
    const availableBytes = await this.getAvailableBytes(this.directory);
    const needsCollection = availableBytes < this.gcConfig.triggerFreeBytes
      || availableBytes - requiredWriteBytes < this.gcConfig.hardReserveBytes;
    const result = needsCollection
      ? await this.collectGarbage({ requiredWriteBytes })
      : undefined;
    // Admission is based on a fresh filesystem reading, not projected file
    // sizes: an unlinked file held open by another process may not have
    // released its blocks yet.
    const availableAfterCollection = result
      ? await this.getAvailableBytes(this.directory)
      : availableBytes;
    if (availableAfterCollection - requiredWriteBytes < this.gcConfig.hardReserveBytes) {
      throw new SnapshotStorageCapacityError(
        availableAfterCollection,
        requiredWriteBytes,
        this.gcConfig.hardReserveBytes,
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

  private forgetPageIndex(hash: string): void {
    for (const ref of this.pageIndexCache.keys()) {
      if (snapshotHash(ref) === hash) this.pageIndexCache.delete(ref);
    }
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

  private getPageIndex(ref: string, nquadsPath: string): Promise<SnapshotPageIndexCore> {
    const existing = this.pageIndexCache.get(ref);
    if (existing) {
      this.rememberPageIndex(ref, existing);
      return existing;
    }
    const load = this.loadOrBuildPageIndex(ref, nquadsPath).catch((error) => {
      if (this.pageIndexCache.get(ref) === load) this.pageIndexCache.delete(ref);
      throw error;
    });
    this.rememberPageIndex(ref, load);
    return load;
  }

  private async loadOrBuildPageIndex(
    ref: string,
    nquadsPath: string,
  ): Promise<SnapshotPageIndexCore> {
    const fingerprint = await stat(nquadsPath);
    if (this.pageIndexStore) {
      try {
        const record = await this.pageIndexStore.get(canonicalSnapshotDigest(ref));
        const index = decodeSnapshotPageIndexRecord(record, fingerprint, ref);
        if (index) return index;
      } catch {
        // The index is derived data; a failed SQLite read must not block paging.
      }
    }

    const index = await buildSnapshotPageIndex(nquadsPath);
    await this.persistSnapshotPageIndexBestEffort(ref, index);
    return index;
  }

  private rememberPageIndex(ref: string, index: Promise<SnapshotPageIndexCore>): void {
    this.pageIndexCache.delete(ref);
    this.pageIndexCache.set(ref, index);
    while (this.pageIndexCache.size > SNAPSHOT_PAGE_INDEX_CACHE_MAX) {
      const oldest = this.pageIndexCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.pageIndexCache.delete(oldest);
    }
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
        snapshotFileSize: index.fileBytes,
        modificationFingerprint: snapshotModificationFingerprint(index),
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

  private async getLegacyJsonSnapshot(ref: string, hash: string): Promise<Quad[] | null> {
    const jsonPath = snapshotPath(this.directory, hash, 'json');
    let raw: string;
    try {
      raw = await readFile(jsonPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

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

function snapshotPath(directory: string, hash: string, extension: 'json' | 'nq'): string {
  return join(directory, hash.slice(0, 2), hash.slice(2, 4), `${hash}.${extension}`);
}

function resolveSnapshotGarbageCollectionConfig(
  config: SharedMemoryPublicSnapshotGarbageCollectionConfig | undefined,
): ResolvedSnapshotGarbageCollectionConfig {
  const enabled = config?.enabled ?? false;
  if (typeof enabled !== 'boolean') {
    throw new Error('sharedMemoryPublicSnapshotStorage.gc.enabled must be a boolean');
  }
  const resolved = {
    enabled,
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

async function filesystemAvailableBytes(directory: string): Promise<number> {
  const filesystem = await statfs(directory);
  return filesystem.bavail * filesystem.bsize;
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

async function buildSnapshotPageIndex(nquadsPath: string): Promise<SnapshotPageIndexCore> {
  const file = await open(nquadsPath, 'r');
  const offsets = [0];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let absoluteOffset = 0;
  let rows = 0;
  try {
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, absoluteOffset);
      if (bytesRead === 0) break;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        rows += 1;
        if (isSnapshotPageIndexCheckpoint(rows)) {
          offsets.push(absoluteOffset + index + 1);
        }
      }
      absoluteOffset += bytesRead;
    }
  } finally {
    await file.close();
  }
  const fingerprint = await stat(nquadsPath);
  return {
    version: SNAPSHOT_PAGE_INDEX_VERSION,
    stride: SNAPSHOT_PAGE_INDEX_STRIDE,
    offsets,
    fileBytes: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs,
    ctimeMs: fingerprint.ctimeMs,
  };
}

function isSnapshotPageIndexCheckpoint(row: number): boolean {
  return row > 0 && row % SNAPSHOT_PAGE_INDEX_STRIDE === 0;
}

function snapshotModificationFingerprint(
  index: Pick<SnapshotPageIndexCore, 'mtimeMs' | 'ctimeMs'>,
): string {
  return `${index.mtimeMs}:${index.ctimeMs}`;
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
  fingerprint: SnapshotFileFingerprint,
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
    stride: SNAPSHOT_PAGE_INDEX_STRIDE,
    offsets,
    fileBytes: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs,
    ctimeMs: fingerprint.ctimeMs,
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
