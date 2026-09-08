import { open, stat, type FileHandle } from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import { join } from 'node:path';

/** Canonical in-memory filesystem identity; persistence converts timestamps at its boundary. */
export interface SnapshotFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}
export interface SnapshotFileSource {
  readonly path: string;
  readonly format: 'nq' | 'json';
  readonly identity: SnapshotFileIdentity;
}

/** An opened source owns its descriptor; cached evidence contains only its reference. */
export type SnapshotFileReader = Readonly<Pick<FileHandle, 'read' | 'readFile'>>;
export interface OpenedSnapshotSource {
  readonly reference: SnapshotFileSource;
  readonly assertCurrent: () => Promise<void>;
  read<T>(operation: (file: SnapshotFileReader) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class SnapshotSourceChangedError extends Error {
  constructor() { super('Snapshot source changed during the read operation'); }
}

export function snapshotPath(directory: string, hash: string, format: SnapshotFileSource['format']): string {
  return join(directory, hash.slice(0, 2), hash.slice(2, 4), `${hash}.${format}`);
}

export function snapshotFileIdentity(file: BigIntStats): SnapshotFileIdentity {
  if (!file.isFile()) throw new Error('Snapshot source is not a regular file');
  return Object.freeze({
    dev: file.dev, ino: file.ino, size: Number(file.size),
    mtimeNs: file.mtimeNs, ctimeNs: file.ctimeNs,
  });
}
export async function readSnapshotFileIdentity(path: string): Promise<SnapshotFileIdentity> {
  return snapshotFileIdentity(await stat(path, { bigint: true }));
}
export function sameSnapshotFileIdentity(left: SnapshotFileIdentity, right: SnapshotFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
export function sameSnapshotSource(left: SnapshotFileSource, right: SnapshotFileSource | null): boolean {
  return right !== null && left.path === right.path && left.format === right.format
    && sameSnapshotFileIdentity(left.identity, right.identity);
}

/** N-Quads wins whenever present; only an absent file permits legacy JSON. */
async function resolveSnapshotSource(directory: string, hash: string): Promise<SnapshotFileSource | null> {
  for (const format of ['nq', 'json'] as const) {
    const path = snapshotPath(directory, hash, format);
    try { return { path, format, identity: await readSnapshotFileIdentity(path) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return null;
}

/** Select and open once. Paging, indexing and validation all use this descriptor. */
export async function openSnapshotSource(directory: string, hash: string): Promise<OpenedSnapshotSource | null> {
  for (const format of ['nq', 'json'] as const) {
    const path = snapshotPath(directory, hash, format);
    let file: FileHandle;
    // Reject a FIFO/device using fstat without waiting for another process to open it.
    try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    try {
      const identity = snapshotFileIdentity(await file.stat({ bigint: true }));
      const reference = Object.freeze({ path, format, identity });
      const assertCurrent = async () => {
        const current = snapshotFileIdentity(await file.stat({ bigint: true }));
        if (!sameSnapshotFileIdentity(identity, current)
          || !sameSnapshotSource(reference, await resolveSnapshotSource(directory, hash))) {
          throw new SnapshotSourceChangedError();
        }
      };
      return Object.freeze({
        reference,
        assertCurrent,
        async read<T>(operation: (selected: SnapshotFileReader) => Promise<T>): Promise<T> {
          await assertCurrent();
          const result = await operation(file);
          await assertCurrent();
          return result;
        },
        close: () => file.close(),
      });
    } catch (error) { await file.close(); throw error; }
  }
  return null;
}

/** Resource scope; the caller's snapshot lease encloses opening through closing. */
export async function withSnapshotSource<T>(
  directory: string,
  hash: string,
  operation: (source: OpenedSnapshotSource | null) => Promise<T>,
): Promise<T> {
  const source = await openSnapshotSource(directory, hash);
  try { return await operation(source); }
  finally { await source?.close(); }
}

export function readSnapshotSource(source: OpenedSnapshotSource): Promise<string> {
  return source.read(file => file.readFile('utf8'));
}
