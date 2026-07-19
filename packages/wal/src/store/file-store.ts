import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { walObjectId, type WalObjectId } from '../reconciliation/ids.js';
import { WalObjectStoreError, storeError } from './errors.js';
import { verifyWalObjectFile } from './streaming-verifier.js';
import { WalObjectStore } from './types.js';

const DEFAULT_MAXIMUM_OBJECT_BYTES = 1_073_741_824n;
const HARD_MAXIMUM_OBJECT_BYTES = 8_589_934_592n;
const DEFAULT_BUFFER_BYTES = 65_536;

export type FileWalObjectStoreDurabilityPoint =
  | 'object-file-synced'
  | 'object-renamed'
  | 'object-directory-synced';

export interface FileWalObjectStoreOptions {
  root: string;
  maximumObjectBytes?: bigint;
  readBufferBytes?: number;
  verificationBufferBytes?: number;
  durabilityHook?: (point: FileWalObjectStoreDurabilityPoint) => void | Promise<void>;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!, byte => Number.parseInt(byte, 16));
}

function assertId(id: Uint8Array): asserts id is WalObjectId {
  if (!(id instanceof Uint8Array) || id.length !== 32) {
    storeError('WAL_STORE_INVALID_OBJECT_ID', 'WalObjectId must be exactly 32 bytes');
  }
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
    if (bytesWritten < 1) return storeError('WAL_STORE_IO', 'WalObject write made no progress');
    /* v8 ignore stop */
    offset += bytesWritten;
  }
}

async function pathKind(path: string): Promise<'missing' | 'file' | 'directory' | 'unsafe'> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink()) return 'unsafe';
    if (details.isFile()) return 'file';
    /* v8 ignore next -- final paths cannot be another filesystem kind in the supported layout. */
    if (!details.isDirectory()) return 'unsafe';
    return 'directory';
  } catch (error) {
    /* v8 ignore next -- retained to propagate unexpected kernel/filesystem lookup failures. */
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return 'missing';
  }
}

export class FileWalObjectStore extends WalObjectStore {
  readonly root: string;
  readonly maximumObjectBytes: bigint;
  readonly readBufferBytes: number;
  readonly verificationBufferBytes: number;
  private readonly durabilityHook?: FileWalObjectStoreOptions['durabilityHook'];

  constructor(options: FileWalObjectStoreOptions) {
    super();
    if (typeof options?.root !== 'string' || options.root.trim().length === 0 || !isAbsolute(options.root)) {
      storeError('WAL_STORE_INVALID_CONFIGURATION', 'WalObjectStore root must be an absolute path');
    }
    const maximumObjectBytes = options.maximumObjectBytes ?? DEFAULT_MAXIMUM_OBJECT_BYTES;
    const readBufferBytes = options.readBufferBytes ?? DEFAULT_BUFFER_BYTES;
    const verificationBufferBytes = options.verificationBufferBytes ?? DEFAULT_BUFFER_BYTES;
    if (maximumObjectBytes < 1n || maximumObjectBytes > HARD_MAXIMUM_OBJECT_BYTES) {
      storeError('WAL_STORE_INVALID_CONFIGURATION', 'maximumObjectBytes must be within the WAL v1 hard limit');
    }
    for (const [name, value] of Object.entries({ readBufferBytes, verificationBufferBytes })) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 1_048_576) {
        storeError('WAL_STORE_INVALID_CONFIGURATION', `${name} must be in 1..1048576`);
      }
    }
    this.root = resolve(options.root);
    this.maximumObjectBytes = maximumObjectBytes;
    this.readBufferBytes = readBufferBytes;
    this.verificationBufferBytes = verificationBufferBytes;
    this.durabilityHook = options.durabilityHook;
  }

  pathFor(id: WalObjectId): string {
    assertId(id);
    const hex = bytesToHex(id);
    return join(this.root, hex.slice(0, 2), `${hex.slice(2)}.wal`);
  }

  async has(id: WalObjectId): Promise<boolean> {
    const path = this.pathFor(id);
    await this.assertSafeExistingAncestors(dirname(path));
    const kind = await pathKind(path);
    if (kind === 'unsafe' || kind === 'directory') {
      return storeError('WAL_STORE_PATH_UNSAFE', 'WalObject final path is not a regular file');
    }
    return kind === 'file';
  }

  async *read(id: WalObjectId, offset = 0n, length?: number): AsyncIterable<Uint8Array> {
    assertId(id);
    if (typeof offset !== 'bigint' || offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) {
      return storeError('WAL_STORE_INVALID_READ_RANGE', 'WalObject read offset is outside the supported range');
    }
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
      return storeError('WAL_STORE_INVALID_READ_RANGE', 'WalObject read length must be a non-negative safe integer');
    }
    const path = this.pathFor(id);
    await this.assertSafeExistingAncestors(dirname(path));
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return storeError('WAL_STORE_OBJECT_NOT_FOUND', 'WalObject is not present');
      }
      /* v8 ignore next -- validated paths can otherwise fail only through non-portable filesystem errors. */
      if ((error as NodeJS.ErrnoException).code !== 'ELOOP') {
        return storeError('WAL_STORE_IO', 'failed to open WalObject', error);
      }
      return storeError('WAL_STORE_PATH_UNSAFE', 'WalObject final path must not be a symbolic link');
    }
    try {
      const details = await handle.stat({ bigint: true });
      if (!details.isFile()) return storeError('WAL_STORE_PATH_UNSAFE', 'WalObject path must be a regular file');
      if (offset > details.size) {
        return storeError('WAL_STORE_INVALID_READ_RANGE', 'WalObject read offset exceeds object length');
      }
      const requestedEnd = length === undefined ? details.size : offset + BigInt(length);
      const end = requestedEnd > details.size ? details.size : requestedEnd;
      let position = offset;
      while (position < end) {
        const remaining = end - position;
        const chunkLength = Number(remaining > BigInt(this.readBufferBytes)
          ? BigInt(this.readBufferBytes)
          : remaining);
        const chunk = new Uint8Array(chunkLength);
        const { bytesRead } = await handle.read(chunk, 0, chunkLength, Number(position));
        if (bytesRead !== chunkLength) {
          return storeError('WAL_STORE_IO', 'WalObject was truncated during read');
        }
        yield chunk;
        position += BigInt(bytesRead);
      }
    } finally {
      await handle.close();
    }
  }

  async put(expectedId: WalObjectId, bytes: AsyncIterable<Uint8Array>): Promise<void> {
    assertId(expectedId);
    if (await this.has(expectedId)) return;
    const finalPath = this.pathFor(expectedId);
    const directory = dirname(finalPath);
    await this.ensureSafeDirectory(directory);
    const temporary = join(directory, `.${bytesToHex(expectedId)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
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
        await writeAll(handle, chunk);
      }
      await handle.sync();
      await this.durabilityHook?.('object-file-synced');
      await handle.close();
      handle = undefined;
      await verifyWalObjectFile(temporary, expectedId, {
        maximumObjectBytes: this.maximumObjectBytes,
        readBufferBytes: this.verificationBufferBytes,
      });
      await rename(temporary, finalPath);
      await this.durabilityHook?.('object-renamed');
      await fsyncDirectory(directory);
      await this.durabilityHook?.('object-directory-synced');
    } catch (error) {
      if (error instanceof WalObjectStoreError) throw error;
      return storeError(
        'WAL_STORE_IO',
        `failed to admit WalObject: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }

  async *ids(): AsyncIterable<WalObjectId> {
    await this.ensureSafeDirectory(this.root);
    const shards = (await readdir(this.root, { withFileTypes: true }))
      .filter(entry => /^[0-9a-f]{2}$/.test(entry.name))
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const shard of shards) {
      if (!shard.isDirectory()) {
        return storeError('WAL_STORE_PATH_UNSAFE', 'WalObject shard must be a real directory');
      }
      const shardPath = join(this.root, shard.name);
      const entries = (await readdir(shardPath, { withFileTypes: true }))
        .filter(entry => /^[0-9a-f]{62}\.wal$/.test(entry.name))
        .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
      for (const entry of entries) {
        if (!entry.isFile()) {
          return storeError('WAL_STORE_PATH_UNSAFE', 'WalObject entry must be a real file');
        }
        yield walObjectId(hexToBytes(`${shard.name}${entry.name.slice(0, -4)}`));
      }
    }
  }

  async cleanupOrphans(beforeMs: number): Promise<number> {
    if (!Number.isFinite(beforeMs)) {
      return storeError('WAL_STORE_INVALID_CONFIGURATION', 'orphan cutoff must be finite');
    }
    await this.ensureSafeDirectory(this.root);
    let removed = 0;
    for (const shard of await readdir(this.root, { withFileTypes: true })) {
      if (!/^[0-9a-f]{2}$/.test(shard.name) || !shard.isDirectory()) continue;
      const shardPath = join(this.root, shard.name);
      for (const entry of await readdir(shardPath, { withFileTypes: true })) {
        if (!/^\.[0-9a-f]{64}\.[0-9a-f-]+\.tmp$/.test(entry.name)) continue;
        const path = join(shardPath, entry.name);
        const details = await lstat(path);
        if (!details.isFile()) {
          return storeError('WAL_STORE_PATH_UNSAFE', 'WalObject temporary entry must be a real file');
        }
        if (details.mtimeMs < beforeMs) {
          await rm(path);
          removed += 1;
        }
      }
    }
    return removed;
  }

  private async ensureSafeDirectory(path: string): Promise<void> {
    const child = relative(this.root, path);
    if (path !== this.root && (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))) {
      return storeError('WAL_STORE_PATH_UNSAFE', 'WalObject path escapes the configured root');
    }
    const rootKind = await pathKind(this.root);
    if (rootKind === 'unsafe' || rootKind === 'file') {
      return storeError('WAL_STORE_PATH_UNSAFE', 'WalObjectStore root must be a real directory');
    }
    if (rootKind === 'missing') await mkdir(this.root, { recursive: true });
    if (path !== this.root) {
      const kind = await pathKind(path);
      if (kind === 'unsafe' || kind === 'file') {
        return storeError('WAL_STORE_PATH_UNSAFE', 'WalObject shard must be a real directory');
      }
      if (kind === 'missing') await mkdir(path);
    }
  }

  private async assertSafeExistingAncestors(directory: string): Promise<void> {
    const child = relative(this.root, directory);
    if (directory !== this.root && (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))) {
      return storeError('WAL_STORE_PATH_UNSAFE', 'WalObject path escapes the configured root');
    }
    const rootKind = await pathKind(this.root);
    if (rootKind === 'unsafe' || rootKind === 'file') {
      return storeError('WAL_STORE_PATH_UNSAFE', 'WalObjectStore root must be a real directory');
    }
    if (rootKind === 'missing' || directory === this.root) return;
    const directoryKind = await pathKind(directory);
    if (directoryKind === 'unsafe' || directoryKind === 'file') {
      return storeError('WAL_STORE_PATH_UNSAFE', 'WalObject shard must be a real directory');
    }
  }
}
