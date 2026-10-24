// Small isolated fixtures still exercise capacity checks and real disk I/O.
// They should not require a production node's 5 GiB reserve on a developer host.
export const TEST_SNAPSHOT_STORAGE = {
  gc: {
    triggerFreeBytes: 64 * 1024 * 1024,
    targetFreeBytes: 128 * 1024 * 1024,
    hardReserveBytes: 16 * 1024 * 1024,
  },
};
export const TEST_SNAPSHOT_CONFIG = { sharedMemoryPublicSnapshotStorage: TEST_SNAPSHOT_STORAGE };
