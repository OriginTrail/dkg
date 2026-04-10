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

export interface FileStoreEntry {
  /** sha256 hash of the file contents, formatted as `sha256:<hex>`. */
  hash: string;
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
   * re-putting the same bytes returns the same hash without rewriting the
   * existing blob. The `contentType` metadata is
   * attached to the return value but not persisted to disk — callers that
   * need durable content-type metadata should store it separately (e.g. in
   * an `_meta` triple keyed by hash).
   */
  async put(bytes: Buffer, contentType: string): Promise<FileStoreEntry> {
    const hex = createHash('sha256').update(bytes).digest('hex');
    const hash = `sha256:${hex}`;
    const path = this.resolvePath(hex);
    await mkdir(join(this.rootDir, hex.slice(0, 2)), { recursive: true });
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
    return { hash, path, size: bytes.length, contentType };
  }

  /** Retrieve the raw bytes for a previously-stored hash, or null if absent. */
  async get(hash: string): Promise<Buffer | null> {
    const path = this.hashToPath(hash);
    if (!path) return null;
    if (!existsSync(path)) return null;
    return readFile(path);
  }

  /** Check whether a hash is present in the store. */
  async has(hash: string): Promise<boolean> {
    const path = this.hashToPath(hash);
    if (!path) return false;
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Resolve a hash to its on-disk path, or null for malformed hashes. */
  hashToPath(hash: string): string | null {
    const hex = normalizeHash(hash);
    if (!hex) return null;
    return this.resolvePath(hex);
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
 * Normalize a hash string to its 64-char hex form. Accepts either the
 * prefixed (`sha256:abcd...`) or bare (`abcd...`) variants. Returns null for
 * anything that isn't a valid sha256 hex.
 */
function normalizeHash(hash: string): string | null {
  if (typeof hash !== 'string') return null;
  const hex = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash;
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return hex.toLowerCase();
}
