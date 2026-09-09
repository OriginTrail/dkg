/** One live TTL setting shared by cleanup scheduling and sync serving. */
export interface SwmExpiryRuntimeSettings {
  getSharedMemoryTtlMs(): number;
  setSharedMemoryTtlMs(ttlMs: number): void;
}
