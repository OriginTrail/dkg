const MAX_VALIDATIONS = 2048;
export type SnapshotValidationKey = readonly [hash: string, expectedDigest: string, expectedCount: number];

/** Bounded positive evidence only; the store owns all filesystem I/O and leases. */
export class SnapshotValidationCache {
  private readonly entries = new Map<string, string>();

  lookup(key: SnapshotValidationKey, fingerprint: string): boolean {
    const cached = this.entries.get(JSON.stringify(key));
    this.invalidate(key);
    if (cached !== fingerprint) return false;
    this.remember(key, fingerprint);
    return true;
  }

  invalidate(key: SnapshotValidationKey): void {
    this.entries.delete(JSON.stringify(key));
  }

  remember(key: SnapshotValidationKey, fingerprint: string): void {
    this.invalidate(key);
    this.entries.set(JSON.stringify(key), fingerprint);
    if (this.entries.size > MAX_VALIDATIONS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
