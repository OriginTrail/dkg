import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { snapshotHash, withClientDeadline, type DirectorySnapshotLifecycleGate } from './workspace-snapshot-lifecycle.js';

export const SNAPSHOT_RETIREMENT_PATTERN = /^([a-f0-9]{64})\.retired$/i;
/** Candidates a pass examines at least; a pass keeps going past this only while candidates keep clearing. */
const FINALIZED_COLLECTION_BATCH = 32;
const COLLECTION_TIME_BUDGET_MS = 5_000;
const REFERENCE_CHECK_TIMEOUT_MS = 2_000;
/** Resume position, kept beside the shard directories (which are the only entries the scan enters). */
const RESUME_KEY_FILE = 'finalized-collection-cursor.json';
const RESUME_KEY_PATTERN = /^[a-f0-9]{64}$/;
interface RetirementCandidate { readonly name: string; readonly path: string; readonly hash: string }
interface FinalizedSnapshotCollectorOptions {
  readonly enabled: boolean;
  readonly retentionMs: number;
  readonly isSnapshotReferenced?: (ref: string) => Promise<boolean>;
  readonly removePayloads: (hash: string, removed: (bytes: number) => void) => Promise<void>;
  readonly removeDerivedState: (hash: string) => Promise<void>;
  readonly log?: (message: string) => void;
}

export interface FinalizedCollectionOptions {
  /**
   * Hard capacity pressure: retirement candidates become eligible before their grace period
   * ends, until this many bytes are reclaimed. The reference check still applies unchanged.
   */
  readonly pressure?: { readonly bytesNeeded: number };
}

/** Digests are lower-case hex: order and resume by code unit, never by locale collation. */
function compareHashes(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** What examining one candidate did, whatever the pass then decides to do next. */
interface CandidateEffects { readonly deleted: number; readonly bytes: number }
type CandidateOutcome = CandidateEffects & (
  /** Removed (or already gone): the record is finished. */
  | { readonly kind: 'cleared' }
  /** Kept: still inside its grace period, or another graph references it. */
  | { readonly kind: 'retained'; readonly referenced: boolean }
  /** Skipped: a reader or writer holds the digest right now. */
  | { readonly kind: 'busy' }
  /** Left in place for a later pass; effects of any partial removal are kept. */
  | { readonly kind: 'failed'; readonly error: unknown }
);

/**
 * The pass policy: whether another candidate may be examined. It is bounded by time and by the
 * reclaim target under pressure, and past the minimum batch it continues only while the candidate
 * just examined cleared, so the first retained, busy or failed one ends a long pass.
 */
function mayExamineNext(pass: {
  readonly examined: number;
  readonly previous: CandidateOutcome | undefined;
  readonly timeLeft: boolean;
  readonly bytesReclaimed: number;
  readonly pressure: FinalizedCollectionOptions['pressure'];
}): boolean {
  if (!pass.timeLeft) return false;
  if (pass.examined >= FINALIZED_COLLECTION_BATCH && pass.previous?.kind !== 'cleared') return false;
  return !pass.pressure || pass.bytesReclaimed < pass.pressure.bytesNeeded;
}

/** Owns durable retirement records, scheduling and fail-closed reference checks. */
export class FinalizedSnapshotCollector {
  private retirementCursor = '';
  private persistedCursor = '';
  private cursorLoad?: Promise<void>;
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

  async collect(files: readonly RetirementCandidate[], options: FinalizedCollectionOptions = {}): Promise<{
    deleted: number; bytes: number; referenced: number; failed: number;
  }> {
    const result = { deleted: 0, bytes: 0, referenced: 0, failed: 0 };
    if (!this.options.enabled || !this.options.isSnapshotReferenced) return result;
    const candidates = files.filter(file => SNAPSHOT_RETIREMENT_PATTERN.test(file.name))
      .sort((a, b) => compareHashes(a.hash, b.hash));
    await (this.cursorLoad ??= this.loadResumeKey());
    // Rotate past retained/error candidates so one busy hash cannot starve the queue.
    const ordered = [...candidates.filter(f => compareHashes(f.hash, this.retirementCursor) > 0),
      ...candidates.filter(f => compareHashes(f.hash, this.retirementCursor) <= 0)];
    const deadline = Date.now() + COLLECTION_TIME_BUDGET_MS;
    let examined = 0;
    let previous: CandidateOutcome | undefined;
    for (const candidate of ordered) {
      if (!mayExamineNext({
        examined, previous, timeLeft: Date.now() < deadline, bytesReclaimed: result.bytes, pressure: options.pressure,
      })) break;
      examined += 1;
      this.retirementCursor = candidate.hash;
      previous = await this.collectCandidate(candidate, options);
      result.deleted += previous.deleted;
      result.bytes += previous.bytes;
      if (previous.kind === 'retained' && previous.referenced) result.referenced += 1;
      if (previous.kind === 'failed') {
        result.failed += 1;
        this.options.log?.(`[SWM-SNAPSHOT-GC] finalized collection failed for ${candidate.hash}: ${previous.error instanceof Error ? previous.error.message : String(previous.error)}`);
      }
    }
    await this.saveResumeKey();
    return result;
  }

  /** Examine one candidate under its exclusive lease; it never throws, it reports what happened. */
  private async collectCandidate(candidate: RetirementCandidate, options: FinalizedCollectionOptions): Promise<CandidateOutcome> {
    let deleted = 0;
    let bytes = 0;
    try {
      const outcome = await this.lifecycleGate.tryCollect(candidate.hash, async () => {
        let record: { version?: unknown; retiredAt?: unknown };
        try { record = JSON.parse(await readFile(candidate.path, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'cleared' as const; throw error; }
        if (record.version !== 1 || typeof record.retiredAt !== 'number'
          || !Number.isSafeInteger(record.retiredAt) || record.retiredAt < 0) {
          throw new Error('Invalid snapshot retirement record');
        }
        if (!options.pressure && this.now() - record.retiredAt < this.options.retentionMs) return 'waiting' as const;
        if (await this.checkSnapshotReferenceWithDeadline(`sha256:${candidate.hash}`)) return 'referenced' as const;
        await this.options.removePayloads(candidate.hash, removed => {
          deleted += 1;
          bytes += removed;
        });
        // Keep the marker on an index failure so a later pass can retry.
        await this.options.removeDerivedState(candidate.hash);
        await this.removeMarker(candidate.hash);
        return 'cleared' as const;
      });
      if (outcome === undefined) return { kind: 'busy', deleted, bytes };
      if (outcome === 'cleared') return { kind: 'cleared', deleted, bytes };
      return { kind: 'retained', referenced: outcome === 'referenced', deleted, bytes };
    } catch (error) {
      // Bytes already removed before the failure still count toward the pass.
      return { kind: 'failed', error, deleted, bytes };
    }
  }

  private async loadResumeKey(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(join(this.directory, RESUME_KEY_FILE), 'utf8')) as { version?: unknown; cursor?: unknown };
      if (saved.version === 1 && typeof saved.cursor === 'string' && RESUME_KEY_PATTERN.test(saved.cursor)) {
        this.retirementCursor = this.persistedCursor = saved.cursor;
      }
    } catch { /* Absent or unreadable: resume from the start of the key space. */ }
  }

  /** Best effort: losing the position only costs a re-scan from the start. */
  private async saveResumeKey(): Promise<void> {
    if (this.retirementCursor === this.persistedCursor) return;
    const cursor = this.retirementCursor;
    const path = join(this.directory, RESUME_KEY_FILE);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, cursor }), 'utf8');
      await rename(temporary, path);
      this.persistedCursor = cursor;
    } catch (error) {
      this.options.log?.(`[SWM-SNAPSHOT-GC] could not save the finalized collection position: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private checkSnapshotReferenceWithDeadline(ref: string): Promise<boolean> {
    return withClientDeadline(this.options.isSnapshotReferenced!(ref), REFERENCE_CHECK_TIMEOUT_MS,
      'Snapshot reference check timed out');
  }

}
