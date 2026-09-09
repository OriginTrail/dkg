/** Keep every accepted duration representable by JavaScript Date. Zero disables TTL. */
export function validateSharedMemoryTtlMs(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > 8_640_000_000_000_000) {
    throw new RangeError('sharedMemoryTtlMs must be finite, non-negative and at most 8640000000000000');
  }
}
