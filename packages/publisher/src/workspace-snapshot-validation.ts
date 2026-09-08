import { resolveSnapshotSource } from './workspace-snapshot-source.js';

const MAX_VALIDATIONS = 2048;

/** Positive evidence only. The caller holds the snapshot's GC lease throughout. */
export class SnapshotValidationCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly directory: string) {}

  async validate(
    hash: string,
    expectedDigest: string,
    expectedCount: number,
    validateContents: () => Promise<boolean>,
  ): Promise<boolean> {
    const key = JSON.stringify([hash, expectedDigest, expectedCount]);
    try {
      const before = await resolveSnapshotSource(this.directory, hash);
      // No asynchronous gap may expose a temporarily missing warm entry.
      const cached = this.entries.get(key);
      this.entries.delete(key);
      if (before === null) return false;
      if (cached === before.fingerprint) {
        this.remember(key, before.fingerprint);
        return true;
      }
      if (!await validateContents()) return false;
      // Reject replacement, concurrent writes and JSON-to-N-Quads migration.
      const after = await resolveSnapshotSource(this.directory, hash);
      if (after?.fingerprint !== before.fingerprint) return false;
      this.remember(key, before.fingerprint);
      return true;
    } catch {
      this.entries.delete(key);
      return false;
    }
  }

  private remember(key: string, fingerprint: string): void {
    this.entries.delete(key);
    this.entries.set(key, fingerprint);
    if (this.entries.size > MAX_VALIDATIONS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
