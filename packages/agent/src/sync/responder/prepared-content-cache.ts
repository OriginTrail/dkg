import { constants } from 'node:fs';
import { mkdir, lstat, open, readdir, rename, unlink, utimes } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES, EXACT_SYNC_GZIP_MAX_INFLATED_BYTES } from '../wire-compression.js';

/** Optional local performance copies. This directory must belong to one daemon/store. */
export interface PreparedContentCacheConfig {
  enabled: boolean;
  directory?: string;
  /** Physical bytes, including manifests. Default 1 GiB; maximum 16 GiB. */
  maxBytes?: number;
  /** Default 8,192 immutable assertions; maximum 65,536. */
  maxEntries?: number;
  /** Absolute retention age, not extended by reads. Default/maximum six hours. */
  ttlMs?: number;
}
/** Local responder retention policy; neither setting changes request authority. */
export interface SyncResponderCacheConfig {
  /** Daemon-local retained responder snapshot row/estimated-byte policy. */
  syncResponderSnapshotLimits?: import('../policy.js').SyncResponderSnapshotLimitsConfig;
  /** Opt-in persistent verified public assertion bytes, never cached authority. */
  preparedContentCache?: PreparedContentCacheConfig;
}
export interface PreparedContent {
  readonly body: Uint8Array;
  readonly plainBytes: number;
}
export interface PreparedContentCache {
  get(key: string): Promise<PreparedContent | null>;
  put(key: string, value: PreparedContent): Promise<void>;
}
const HEADER_LIMIT = 16 * 1024;
const SUFFIX = '.prepared';
const FILE_PATTERN = /^[a-f0-9]{64}\.prepared$/;
const TEMP_PATTERN = /^[a-f0-9]{64}\.prepared\.[a-f0-9-]{36}\.tmp$/;
const TTL = 6 * 60 * 60 * 1_000;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const positive = (value: number, max: number) => Number.isSafeInteger(value) && value > 0 && value <= max;

export function resolvePreparedContentCacheConfig(config: PreparedContentCacheConfig | undefined, dataDir?: string) {
  if (config === undefined) return undefined;
  if (!config || typeof config !== 'object' || typeof config.enabled !== 'boolean') {
    throw new TypeError('preparedContentCache.enabled must be boolean');
  }
  if (!config.enabled) return undefined;
  const directory = config.directory ?? (dataDir ? join(dataDir, 'prepared-content-v1') : undefined);
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
  onError: () => void = () => {},
): PreparedContentCache {
  const { directory, maxBytes, maxEntries, ttlMs } = options;
  const entries = new Map<string, { size: number; used: number }>();
  let initialized = false, total = 0;
  let tail: Promise<unknown> = Promise.resolve();
  // Reads and writes serialize within the bounded responder admission. No
  // background writer survives a response or shutdown and no whole graph is held.
  const run = <T>(fallback: T, work: () => Promise<T>): Promise<T> => {
    const next = tail.then(async () => {
      try { await initialize(); return await work(); }
      catch { try { onError(); } catch { /* diagnostics cannot deny a valid response */ } return fallback; }
    });
    tail = next.then(() => undefined);
    return next;
  };
  const remove = async (name: string) => {
    await unlink(join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const old = entries.get(name); if (old) total -= old.size;
    entries.delete(name);
  };
  const evict = async (incomingBytes = 0, incomingEntries = 0) => {
    for (const [name] of [...entries].sort((a, b) => a[1].used - b[1].used)) {
      if (total + incomingBytes <= maxBytes && entries.size + incomingEntries <= maxEntries) break;
      await remove(name);
    }
  };
  async function initialize() {
    if (initialized) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error('Prepared cache directory is not a directory');
    entries.clear(); total = 0;
    // Ignore unrelated files. Never follow links or recursively clean a directory.
    const dir = await readdir(directory, { withFileTypes: true });
    for (const file of dir) {
      // Exclusive directory ownership makes these abandoned atomic writes.
      if (file.isFile() && TEMP_PATTERN.test(file.name)) { await unlink(join(directory, file.name)); continue; }
      if (!FILE_PATTERN.test(file.name) || !file.isFile()) continue;
      const stat = await lstat(join(directory, file.name));
      if (!stat.isFile()) continue;
      if (stat.size > HEADER_LIMIT + 4 + EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES) { await remove(file.name); continue; }
      entries.set(file.name, { size: stat.size, used: stat.mtimeMs }); total += stat.size;
    }
    await evict(); initialized = true;
  }
  return {
    get(key) {
      return run<PreparedContent | null>(null, async () => {
        const name = digest(key) + SUFFIX;
        if (!entries.has(name)) return null;
        const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let result: PreparedContent | null = null;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size < 5 || stat.size > HEADER_LIMIT + 4 + EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES) return null;
          const prefix = Buffer.alloc(4); await handle.read(prefix, 0, 4, 0);
          const length = prefix.readUInt32BE();
          if (length < 1 || length > HEADER_LIMIT || stat.size <= 4 + length) return null;
          const header = Buffer.alloc(length);
          if ((await handle.read(header, 0, length, 4)).bytesRead !== length) return null;
          const manifest = JSON.parse(header.toString('utf8'));
          if (manifest.version !== 1 || manifest.key !== key || !Number.isSafeInteger(manifest.createdAt)
            || manifest.createdAt > Date.now() || Date.now() - manifest.createdAt >= ttlMs
            || !positive(manifest.plainBytes, EXACT_SYNC_GZIP_MAX_INFLATED_BYTES)
            || !positive(manifest.encodedBytes, EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES)
            || manifest.encodedBytes !== stat.size - 4 - length) return null;
          const body = Buffer.alloc(manifest.encodedBytes);
          if ((await handle.read(body, 0, body.length, 4 + length)).bytesRead !== body.length
            || digest(body) !== manifest.sha256) return null;
          result = { body: new Uint8Array(body), plainBytes: manifest.plainBytes };
          return result;
        } finally {
          await handle.close();
          if (!result) await remove(name);
          else {
            const entry = entries.get(name)!; entry.used = Date.now();
            await utimes(join(directory, name), new Date(), new Date()).catch(() => {});
          }
        }
      });
    },
    put(key, value) {
      // Called while the response budget still owns these bytes. Awaited IO
      // prevents unbounded background work or retained buffers after release.
      return run<void>(undefined, async () => {
        if (!positive(value.body.byteLength, EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES)
          || !positive(value.plainBytes, EXACT_SYNC_GZIP_MAX_INFLATED_BYTES)) return;
        const header = Buffer.from(JSON.stringify({ version: 1, key, createdAt: Date.now(),
          plainBytes: value.plainBytes, encodedBytes: value.body.byteLength, sha256: digest(value.body) }));
        const size = 4 + header.byteLength + value.body.byteLength;
        if (header.byteLength > HEADER_LIMIT || size > maxBytes) return;
        const name = digest(key) + SUFFIX;
        // A new valid assertion can replace an expired/corrupt copy atomically.
        await evict(size, 1);
        const temp = join(directory, `${name}.${randomUUID()}.tmp`);
        const handle = await open(temp, 'wx', 0o600);
        try {
          const prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.byteLength);
          await handle.writeFile(prefix); await handle.writeFile(header); await handle.writeFile(value.body);
          await handle.sync(); await handle.close();
          await rename(temp, join(directory, name));
          const old = entries.get(name); if (old) total -= old.size;
          entries.set(name, { size, used: Date.now() }); total += size;
        } finally {
          await handle.close().catch(() => {});
          await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      });
    },
  };
}
