/** Shared value contract; omission and default policy belong to each caller. */
export type PublicSnapshotMode = 'core-cache' | 'rpc-only';
export function isPublicSnapshotMode(value: unknown): value is PublicSnapshotMode {
  return value === 'core-cache' || value === 'rpc-only';
}
