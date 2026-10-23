/** Private worker protocol: it carries data, never caller-provided SQL or persistence hooks. */
export type BlobRequest =
  | { id: number; operation: 'write'; hash: string; term: string }
  | { id: number; operation: 'read'; hash: string; maxBytes?: number }
  | { id: number; operation: 'close' };
export interface BlobFailure {
  message: string;
  code?: string;
  maxBytes?: number;
  actualBytes?: number;
}
export type BlobResponse = { ready: true } | {
  id: number; value?: string; error?: BlobFailure;
};
export const SQLITE_BLOB_APPLICATION_ID = 0x444b4742;
export const SQLITE_BLOB_VERSION = 1;
export const SQLITE_BLOB_FILENAME = 'literal-blobs-v1.sqlite';

/** Require the upstream WAL-reset fix, including its supported backports. */
export function assertSqliteBlobRuntime(version = process.versions.sqlite): void {
  const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const [major, minor, patch] = parts ?? [0, 0, 0];
  if (major! > 3 || (major === 3 && (minor! > 51 || (minor === 51 && patch! >= 3)
    || (minor === 50 && patch! >= 7) || (minor === 44 && patch! >= 6)))) return;
  throw new Error(`Literal blob group commit requires a Node runtime with SQLite 3.51.3+ (or 3.50.7/3.44.6 backport); found ${version ?? 'unavailable'}`);
}
