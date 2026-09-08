import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface SnapshotFileSource {
  readonly path: string;
  readonly format: 'nq' | 'json';
  readonly fingerprint: string;
}

export function snapshotPath(directory: string, hash: string, format: SnapshotFileSource['format']): string {
  return join(directory, hash.slice(0, 2), hash.slice(2, 4), `${hash}.${format}`);
}

/** N-Quads wins whenever present; only an absent file permits legacy JSON. */
export async function resolveSnapshotSource(directory: string, hash: string): Promise<SnapshotFileSource | null> {
  for (const format of ['nq', 'json'] as const) {
    const path = snapshotPath(directory, hash, format);
    try {
      const file = await stat(path, { bigint: true });
      if (!file.isFile()) throw new Error(`Snapshot source is not a regular file: ${path}`);
      return {
        path,
        format,
        fingerprint: `${path}\0${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

export function readSnapshotSource(source: SnapshotFileSource): Promise<string> {
  return readFile(source.path, 'utf8');
}
