import type { DkgConfig, SharedMemoryPublicSnapshotStorageConfig } from '../src/config.js';

export const snapshotCleanup = {
  enabled: true,
  gc: { enabled: false, finalizedCleanupEnabled: true, finalizedRetentionMs: 86_400_000 },
} satisfies SharedMemoryPublicSnapshotStorageConfig;

export const nodeConfig = {
  sharedMemoryPublicSnapshotStorage: snapshotCleanup,
} satisfies Pick<DkgConfig, 'sharedMemoryPublicSnapshotStorage'>;
