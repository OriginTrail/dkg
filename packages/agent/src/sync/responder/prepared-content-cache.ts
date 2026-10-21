import { constants } from 'node:fs';
import { mkdir, lstat, open, readdir, rename, unlink, utimes, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES, EXACT_SYNC_GZIP_MAX_INFLATED_BYTES } from '../wire-compression.js';

/** Optional local performance copies. This directory must belong to one daemon/store. */
export interface PreparedContentCacheConfig {
  enabled: boolean;
  directory?: string;
  /** Physical bytes, including manifests and bounded write headroom. Default 1 GiB; maximum 16 GiB. */
  maxBytes?: number;
  /** Default 8,192 immutable assertions; maximum 65,536. */
  maxEntries?: number;
  /** Absolute retention age, not extended by reads. Default/maximum six hours. */
  ttlMs?: number;
}
export interface PreparedContent {
  readonly body: Uint8Array;
  readonly plainBytes: number;
}
export interface PreparedContentCache {
  /** Each hit transfers ownership of fresh bytes; callers may mutate the returned body. */
  get(key: string): Promise<PreparedContent | null>;
  /** Borrows value and its body without copying until the promise settles.
   * Keep both unchanged and retain the response-memory reservation while awaiting
   * publication; ownership is not transferred to the cache. */
  put(key: string, value: PreparedContent): Promise<void>;
}
const HEADER_LIMIT = 16 * 1024;
const SUFFIX = '.prepared';
const FILE_PATTERN = /^[a-f0-9]{64}\.prepared$/;
const TEMP_PATTERN = /^[a-f0-9]{64}\.prepared\.[a-f0-9-]{36}\.tmp$/;
const TTL = 6 * 60 * 60 * 1_000;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const positive = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;

interface ManifestV1 {
  version: 1; key: string; createdAt: number; plainBytes: number; encodedBytes: number; sha256: string;
}
function encodeManifest(manifest: ManifestV1): Buffer {
  return Buffer.from(JSON.stringify(manifest));
}
function decodeManifest(header: string, key: string | undefined, encodedBytes: number, now: number, ttlMs: number): ManifestV1 | null {
  const value: unknown = JSON.parse(header);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  if (m.version !== 1 || typeof m.key !== 'string' || (key !== undefined && m.key !== key)
    || typeof m.createdAt !== 'number' || !Number.isSafeInteger(m.createdAt)
    || m.createdAt > now || now - m.createdAt >= ttlMs
    || !positive(m.plainBytes, EXACT_SYNC_GZIP_MAX_INFLATED_BYTES)
    || !positive(m.encodedBytes, EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES) || m.encodedBytes !== encodedBytes
    || typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256)) return null;
  return { version: 1, key: m.key, createdAt: m.createdAt, plainBytes: m.plainBytes,
    encodedBytes: m.encodedBytes, sha256: m.sha256 };
}

export function resolvePreparedContentCacheConfig(
  config: PreparedContentCacheConfig | undefined, dataDir?: string,
) {
  if (config === undefined) return undefined;
  if (!config || typeof config !== 'object' || typeof config.enabled !== 'boolean') {
    throw new TypeError('preparedContentCache.enabled must be boolean');
  }
  if (!config.enabled) return undefined;
  const directory = config.directory ?? (dataDir ? resolve(dataDir, 'prepared-content-v1') : undefined);
  if (typeof directory !== 'string' || !isAbsolute(directory)) {
    throw new TypeError('preparedContentCache requires an absolute directory or dataDir');
  }
  const maxBytes = config.maxBytes ?? 1024 ** 3, maxEntries = config.maxEntries ?? 8192, ttlMs = config.ttlMs ?? TTL;
  if (!positive(maxBytes, 16 * 1024 ** 3) || !positive(maxEntries, 65536) || !positive(ttlMs, TTL)) {
    throw new TypeError('preparedContentCache limits must be positive bounded safe integers');
  }
  return { directory, maxBytes, maxEntries, ttlMs };
}

/**
 * A manifest and encoded assertion are published as one atomic file. No graph
 * authority or mutable metadata is served from disk. Callers must first read
 * current metadata, bind the key to its complete identity, and fence each serve.
 * Cache IO failures are misses; malformed entries never become wire responses.
 */
export function createPreparedContentCache(
  options: NonNullable<ReturnType<typeof resolvePreparedContentCacheConfig>>,
  onError: (error: unknown, operation: 'initialize' | 'read' | 'publish') => void = () => {},
): PreparedContentCache & { closeAndDrain(): Promise<void> } {
  const { maxBytes, maxEntries, ttlMs } = options;
  // Retain room for one bounded atomic write without evicting valid entries
  // before preparation succeeds. Small configured caches split their budget.
  const stagingBytes = Math.min(HEADER_LIMIT + 4 + EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES, Math.floor(maxBytes / 2));
  const retainedLimit = maxBytes - stagingBytes;
  // lstat follows a final symlink spelled with a trailing separator on POSIX.
  const directory = resolve(options.directory);
  // Iteration order is oldest first; successful reads/writes move to the end.
  const entries = new Map<string, { size: number; expiresAt: number }>();
  const ownedTemps = new Set<string>();
  let initialized = false, closed = false, total = 0;
  let tail: Promise<unknown> = Promise.resolve();
  // Close admission synchronously, then drain every admitted filesystem task.
  // Transport cancellation cannot detach physical writes from agent shutdown.
  const run = <T>(operation: 'read' | 'publish', fallback: T, work: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.resolve(fallback);
    const next = tail.then(async () => {
      let phase: 'initialize' | 'read' | 'publish' = 'initialize';
      try { await initialize(); phase = operation; await reclaimTemps(); await reclaimExpired(); await evict(); return await work(); }
      catch (error) { try { onError(error, phase); } catch { /* diagnostics cannot deny a valid response */ } return fallback; }
    });
    tail = next.then(() => undefined);
    return next;
  };
  const removeTemp = async (path: string) => {
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    ownedTemps.delete(path);
  };
  const reclaimTemps = async () => {
    // A failed unlink still owns physical staging bytes. No further admission
    // may spend that allowance until cleanup succeeds, including after failed publication.
    for (const path of ownedTemps) await removeTemp(path);
  };
  const remove = async (name: string) => {
    await unlink(join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const old = entries.get(name); if (old) total -= old.size;
    entries.delete(name);
  };
  const evict = async (incomingBytes = 0, incomingEntries = 0) => {
    while (entries.size > 0 && (
      total + incomingBytes > retainedLimit || entries.size + incomingEntries > maxEntries
    )) await remove(entries.keys().next().value!);
  };
  const reclaimExpired = async () => {
    const now = Date.now();
    for (const [name, entry] of entries) if (entry.expiresAt <= now) await remove(name);
  };
  async function readHeader(handle: FileHandle, key?: string) {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 5 || stat.size > HEADER_LIMIT + 4 + EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES) return null;
    const prefix = Buffer.alloc(4);
    if ((await handle.read(prefix, 0, 4, 0)).bytesRead !== 4) return null;
    const length = prefix.readUInt32BE();
    if (length < 1 || length > HEADER_LIMIT || stat.size <= 4 + length) return null;
    const header = Buffer.alloc(length);
    if ((await handle.read(header, 0, length, 4)).bytesRead !== length) return null;
    let manifest: ManifestV1 | null;
    try { manifest = decodeManifest(header.toString('utf8'), key, stat.size - 4 - length, Date.now(), ttlMs); }
    catch { return null; }
    return manifest ? { manifest, length, size: stat.size } : null;
  }
  async function initialize() {
    if (initialized) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error('Prepared cache directory is not a directory');
    entries.clear(); total = 0;
    // Ignore unrelated files. Never follow links or recursively clean a directory.
    const dir = await readdir(directory, { withFileTypes: true });
    const discovered: Array<{ name: string; size: number; mtimeMs: number; expiresAt: number }> = [];
    for (const file of dir) {
      // Exclusive directory ownership makes these abandoned atomic writes.
      if (file.isFile() && TEMP_PATTERN.test(file.name)) { await unlink(join(directory, file.name)); continue; }
      if (!FILE_PATTERN.test(file.name) || !file.isFile()) continue;
      const stat = await lstat(join(directory, file.name));
      if (!stat.isFile()) continue;
      const handle = await open(join(directory, file.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let header;
      try { header = await readHeader(handle); } finally { await handle.close(); }
      if (!header || digest(header.manifest.key) + SUFFIX !== file.name) { await remove(file.name); continue; }
      discovered.push({ name: file.name, size: header.size, mtimeMs: stat.mtimeMs, expiresAt: header.manifest.createdAt + ttlMs });
    }
    for (const file of discovered.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      entries.set(file.name, { size: file.size, expiresAt: file.expiresAt }); total += file.size;
    }
    await evict(); initialized = true;
  }
  return {
    closeAndDrain() { closed = true; return tail.then(() => undefined); },
    get(key) {
      return run<PreparedContent | null>('read', null, async () => {
        const name = digest(key) + SUFFIX;
        if (!entries.has(name)) return null;
        const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let result: PreparedContent | null = null;
        try {
          const header = await readHeader(handle, key);
          if (!header) return null;
          const { manifest, length } = header;
          const body = Buffer.alloc(manifest.encodedBytes);
          if ((await handle.read(body, 0, body.length, 4 + length)).bytesRead !== body.length
            || digest(body) !== manifest.sha256) return null;
          result = { body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), plainBytes: manifest.plainBytes };
          return result;
        } finally {
          await handle.close();
          if (!result) await remove(name);
          else {
            const entry = entries.get(name)!; entries.delete(name); entries.set(name, entry);
            await utimes(join(directory, name), new Date(), new Date()).catch(() => {});
          }
        }
      });
    },
    put(key, value) {
      // Called while the response budget still owns these bytes. Awaited IO
      // prevents unbounded background work or retained buffers after release.
      return run<void>('publish', undefined, async () => {
        if (!positive(value.body.byteLength, EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES)
          || !positive(value.plainBytes, EXACT_SYNC_GZIP_MAX_INFLATED_BYTES)) return;
        const createdAt = Date.now();
        const header = encodeManifest({ version: 1, key, createdAt,
          plainBytes: value.plainBytes, encodedBytes: value.body.byteLength, sha256: digest(value.body) });
        const size = 4 + header.byteLength + value.body.byteLength;
        if (header.byteLength > HEADER_LIMIT || size > stagingBytes) return;
        const name = digest(key) + SUFFIX;
        // Staging headroom permits the commit before any destructive eviction.
        // If prior cleanup failed, run() must restore retention before admission.
        const old = entries.get(name);
        if (total + size > maxBytes) return;
        const temp = join(directory, `${name}.${randomUUID()}.tmp`);
        const handle = await open(temp, 'wx', 0o600);
        ownedTemps.add(temp);
        try {
          const prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.byteLength);
          await handle.writeFile(prefix); await handle.writeFile(header); await handle.writeFile(value.body);
          await handle.sync(); await handle.close();
          // Rename is the publication point. A failed rename preserves every
          // retained entry. Post-commit cleanup is retried before the next IO.
          await rename(temp, join(directory, name));
          ownedTemps.delete(temp);
          if (old) total -= old.size;
          entries.delete(name); entries.set(name, { size, expiresAt: createdAt + ttlMs }); total += size;
          await evict();
        } finally {
          await handle.close().catch(() => {});
          await removeTemp(temp);
        }
      });
    },
  };
}

/** Bounded diagnostic labels never include local paths or content. */
export function preparedCacheFailureCause(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && /^[A-Z_0-9]{1,48}$/.test(code)) return code;
  return error instanceof Error && /^[A-Za-z]{1,48}$/.test(error.name) ? error.name : 'UnknownError';
}
