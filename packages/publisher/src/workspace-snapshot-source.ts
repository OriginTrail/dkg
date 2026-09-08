import { open, stat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { join } from 'node:path';

/** One filesystem observation shared by source validation and page-index checks. */
export interface SnapshotFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}
export interface SnapshotFileSource {
  readonly path: string;
  readonly format: 'nq' | 'json';
  readonly identity: SnapshotFileIdentity;
}

export function snapshotPath(directory: string, hash: string, format: SnapshotFileSource['format']): string {
  return join(directory, hash.slice(0, 2), hash.slice(2, 4), `${hash}.${format}`);
}

export function snapshotFileIdentity(file: BigIntStats): SnapshotFileIdentity {
  if (!file.isFile()) throw new Error('Snapshot source is not a regular file');
  return {
    dev: file.dev, ino: file.ino, size: Number(file.size),
    mtimeNs: file.mtimeNs, ctimeNs: file.ctimeNs,
    mtimeMs: Number(file.mtimeNs) / 1_000_000, ctimeMs: Number(file.ctimeNs) / 1_000_000,
  };
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
export async function resolveSnapshotSource(directory: string, hash: string): Promise<SnapshotFileSource | null> {
  for (const format of ['nq', 'json'] as const) {
    const path = snapshotPath(directory, hash, format);
    try { return { path, format, identity: await readSnapshotFileIdentity(path) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return null;
}

/** Bind the bytes to one descriptor, checking it before and after the read. */
export async function readSnapshotSource(source: SnapshotFileSource): Promise<string> {
  const file = await open(source.path, 'r');
  try {
    const before = snapshotFileIdentity(await file.stat({ bigint: true }));
    if (!sameSnapshotFileIdentity(source.identity, before)) throw new Error('Snapshot source changed before reading');
    const raw = await file.readFile('utf8');
    const after = snapshotFileIdentity(await file.stat({ bigint: true }));
    if (!sameSnapshotFileIdentity(before, after)) throw new Error('Snapshot source changed while reading');
    return raw;
  } finally { await file.close(); }
}
