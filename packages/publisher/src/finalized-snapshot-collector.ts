import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { snapshotHash, type DirectorySnapshotLifecycleGate } from './workspace-snapshot-lifecycle.js';

export const SNAPSHOT_RETIREMENT_PATTERN = /^([a-f0-9]{64})\.retired$/i;
const FINALIZED_COLLECTION_BATCH = 32;
interface RetirementCandidate { readonly name: string; readonly path: string; readonly hash: string }
interface FinalizedSnapshotCollectorOptions {
  readonly enabled: boolean;
  readonly retentionMs: number;
  readonly isSnapshotReferenced?: (ref: string) => Promise<boolean>;
  readonly removePayloads: (hash: string, removed: (bytes: number) => void) => Promise<void>;
  readonly removeDerivedState: (hash: string) => Promise<void>;
  readonly log?: (message: string) => void;
}

/** Owns durable retirement records, scheduling and fail-closed reference checks. */
export class FinalizedSnapshotCollector {
  private retirementCursor = '';
  constructor(
    private readonly directory: string,
    private readonly lifecycleGate: DirectorySnapshotLifecycleGate,
    private readonly now: () => number,
    private readonly options: FinalizedSnapshotCollectorOptions,
  ) {}
  async markPublishedSnapshots(refs: readonly string[]): Promise<void> {
    if (!this.options.enabled) return;
    // Enqueue every digest before awaiting I/O so a later reuse of a later
    // digest cannot be overtaken by this older multi-digest request.
    await Promise.all([...new Set(refs.map(snapshotHash))].map(hash =>
      this.lifecycleGate.mutate(hash, async () => {
        const path = this.path(hash);
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ version: 1, retiredAt: this.now() }), 'utf8');
          await rename(temporary, path);
        } finally {
          await unlink(temporary).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          });
        }
      }),
    ));
  }

  path(hash: string): string {
    return join(this.directory, hash.slice(0, 2), hash.slice(2, 4), `${hash}.retired`);
  }

  cancel(hash: string): Promise<void> {
    return this.lifecycleGate.mutate(hash, () => this.removeMarker(hash));
  }

  /** Caller already owns the exclusive GC lease; do not re-enter the gate. */
  private async removeMarker(hash: string): Promise<void> {
    await unlink(this.path(hash)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  async collect(files: readonly RetirementCandidate[]): Promise<{
    deleted: number; bytes: number; referenced: number; failed: number;
  }> {
    const result = { deleted: 0, bytes: 0, referenced: 0, failed: 0 };
    if (!this.options.enabled || !this.options.isSnapshotReferenced) return result;
    const candidates = files.filter(file => SNAPSHOT_RETIREMENT_PATTERN.test(file.name))
      .sort((a, b) => a.hash.localeCompare(b.hash));
    // Rotate past retained/error candidates so one busy hash cannot starve the queue.
    const ordered = [...candidates.filter(f => f.hash > this.retirementCursor),
      ...candidates.filter(f => f.hash <= this.retirementCursor)].slice(0, FINALIZED_COLLECTION_BATCH);
    const deadline = Date.now() + 5_000;
    for (const candidate of ordered) {
      if (Date.now() >= deadline) break;
      this.retirementCursor = candidate.hash;
      try {
        await this.lifecycleGate.tryCollect(candidate.hash, async () => {
          let record: { version?: unknown; retiredAt?: unknown };
          try { record = JSON.parse(await readFile(candidate.path, 'utf8')); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
          if (record.version !== 1 || typeof record.retiredAt !== 'number'
            || !Number.isSafeInteger(record.retiredAt) || record.retiredAt < 0) {
            throw new Error('Invalid snapshot retirement record');
          }
          if (this.now() - record.retiredAt < this.options.retentionMs) return;
          if (await this.checkSnapshotReferenceWithDeadline(`sha256:${candidate.hash}`)) {
            result.referenced += 1;
            return;
          }
          await this.options.removePayloads(candidate.hash, bytes => {
            result.deleted += 1;
            result.bytes += bytes;
          });
          // Keep the marker on an index failure so a later pass can retry.
          await this.options.removeDerivedState(candidate.hash);
          await this.removeMarker(candidate.hash);
        });
      } catch (error) {
        result.failed += 1;
        this.options.log?.(`[SWM-SNAPSHOT-GC] finalized collection failed for ${candidate.hash}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  private async checkSnapshotReferenceWithDeadline(ref: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.options.isSnapshotReferenced!(ref),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Snapshot reference check timed out')), 2_000);
          timer.unref();
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

}
