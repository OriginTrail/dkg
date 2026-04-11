/**
 * Content-addressed file store for uploaded files.
 *
 * Files are stored on disk keyed by their sha256 hash. Two-level sharded
 * directory layout (`ab/cdef...`) keeps any single directory at a reasonable
 * size even after many uploads.
 *
 * Used by the import-file route handler to persist originals and Markdown
 * intermediates produced by converters. File identity is the content hash
 * returned by `put()`, which callers surface as `fileHash` and
 * `mdIntermediateHash` in the import-file response.
 *
 * Spec: 05_PROTOCOL_EXTENSIONS.md §6.5
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ethers } from 'ethers';

export interface FileStoreEntry {
  /**
   * sha256 hash of the file contents, formatted as `sha256:<hex>`.
   * Used as the on-disk storage key for historical compatibility.
   */
  hash: string;
  /**
   * keccak256 hash of the file contents, formatted as `keccak256:<hex>`.
   * Used on the wire and in the data/meta graph triples per
   * `05_PROTOCOL_EXTENSIONS.md §6.3` and `19_MARKDOWN_CONTENT_TYPE.md §10`.
   */
  keccak256: string;
  /** Absolute path to the stored file on disk. */
  path: string;
  /** Size of the file in bytes. */
  size: number;
  /** MIME content type recorded at put() time. */
  contentType: string;
}

export class FileStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  /**
   * Persist `bytes` to the store and return the resulting entry. Idempotent:
   * re-putting the same bytes returns the same hashes without rewriting the
   * existing blob. The `contentType` metadata is attached to the return
   * value but not persisted to disk — callers that need durable
   * content-type metadata should store it separately (e.g. in an `_meta`
   * triple keyed by hash).
   *
   * Content is stored under the sha256 shard layout. A small pointer file
   * under `keccak256/<hex>` is also written so the same blob is resolvable
   * by keccak256, which is the hash used on the wire and in graph triples.
   */
  async put(bytes: Buffer, contentType: string): Promise<FileStoreEntry> {
    const sha256Hex = createHash('sha256').update(bytes).digest('hex');
    const keccakHex = ethers.keccak256(bytes).replace(/^0x/, '');
    const hash = `sha256:${sha256Hex}`;
    const keccak256 = `keccak256:${keccakHex}`;
    const path = this.resolvePath(sha256Hex);
    await mkdir(join(this.rootDir, sha256Hex.slice(0, 2)), { recursive: true });
    if (!existsSync(path)) {
      const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try {
        await writeFile(tempPath, bytes, { flag: 'wx' });
        try {
          await rename(tempPath, path);
        } catch (err: any) {
          if (!existsSync(path)) {
            throw err;
          }
        }
      } finally {
        if (existsSync(tempPath)) {
          await unlink(tempPath).catch(() => {});
        }
      }
    }
    const pointerPath = this.resolveKeccakPointerPath(keccakHex);
    if (!existsSync(pointerPath)) {
      await mkdir(join(this.rootDir, 'keccak256', keccakHex.slice(0, 2)), { recursive: true });
      const tempPointer = `${pointerPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try {
        await writeFile(tempPointer, sha256Hex, { flag: 'wx' });
        try {
          await rename(tempPointer, pointerPath);
        } catch (err: any) {
          if (!existsSync(pointerPath)) {
            throw err;
          }
        }
      } finally {
        if (existsSync(tempPointer)) {
          await unlink(tempPointer).catch(() => {});
        }
      }
    }
    return { hash, keccak256, path, size: bytes.length, contentType };
  }

  /**
   * Retrieve the raw bytes for a previously-stored hash, or null if absent.
   * Accepts either the `sha256:<hex>` or `keccak256:<hex>` form. For
   * keccak256 inputs the pointer file written at put() time is dereferenced
   * to the underlying sha256 blob.
   */
  async get(hash: string): Promise<Buffer | null> {
    const path = await this.hashToPath(hash);
    if (!path) return null;
    if (!existsSync(path)) return null;
    return readFile(path);
  }

  /** Check whether a hash is present in the store. */
  async has(hash: string): Promise<boolean> {
    const path = await this.hashToPath(hash);
    if (!path) return false;
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a hash to the underlying blob's on-disk path. Always returns
   * the CONTENT path regardless of which hash algorithm the caller
   * supplied:
   *
   * - `sha256:<hex>` or bare hex → the sharded blob path directly
   * - `keccak256:<hex>` → read the pointer file written at `put()` time,
   *   deref it to the sha256 hex, return the sharded blob path for that
   *
   * Returns null for malformed hashes, for keccak256 inputs whose
   * pointer file does not exist, and for pointer files that contain
   * unexpected content.
   *
   * This is async because the keccak256 path requires a disk read. If
   * you specifically want the on-disk location of the keccak pointer
   * file (e.g. for integrity checks, debugging, or cleanup), use
   * `hashToPointerPath(keccakHash)` instead — that's synchronous and
   * returns null for non-keccak inputs.
   */
  async hashToPath(hash: string): Promise<string | null> {
    const parsed = parseHash(hash);
    if (!parsed) return null;
    if (parsed.algo === 'sha256') return this.resolvePath(parsed.hex);
    const pointerPath = this.resolveKeccakPointerPath(parsed.hex);
    if (!existsSync(pointerPath)) return null;
    const sha256Hex = (await readFile(pointerPath, 'utf-8')).trim();
    if (!/^[0-9a-f]{64}$/i.test(sha256Hex)) return null;
    return this.resolvePath(sha256Hex.toLowerCase());
  }

  /**
   * Resolve a `keccak256:<hex>` hash to its pointer-file path
   * synchronously, without dereferencing. Returns null for malformed
   * keccak256 hashes and for any other algorithm (use `hashToPath` to
   * get the content path for sha256). Intended for callers that want
   * to inspect or manipulate the keccak → sha256 indirection directly.
   */
  hashToPointerPath(hash: string): string | null {
    const parsed = parseHash(hash);
    if (!parsed) return null;
    if (parsed.algo !== 'keccak256') return null;
    return this.resolveKeccakPointerPath(parsed.hex);
  }

  private resolveKeccakPointerPath(hex: string): string {
    return join(this.rootDir, 'keccak256', hex.slice(0, 2), hex.slice(2));
  }

  /** Root directory the store writes into. */
  get directory(): string {
    return this.rootDir;
  }

  private resolvePath(hex: string): string {
    return join(this.rootDir, hex.slice(0, 2), hex.slice(2));
  }
}

/**
 * Parse a hash string and return its algorithm + 64-char hex form. Accepts
 * `sha256:<hex>`, `keccak256:<hex>`, or bare `<hex>` (treated as sha256 for
 * backwards compatibility). Returns null for anything that isn't a valid
 * 64-char hex under a supported algorithm.
 */
function parseHash(hash: string): { algo: 'sha256' | 'keccak256'; hex: string } | null {
  if (typeof hash !== 'string') return null;
  let algo: 'sha256' | 'keccak256' = 'sha256';
  let hex = hash;
  if (hash.startsWith('sha256:')) {
    hex = hash.slice('sha256:'.length);
  } else if (hash.startsWith('keccak256:')) {
    algo = 'keccak256';
    hex = hash.slice('keccak256:'.length);
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return { algo, hex: hex.toLowerCase() };
}
