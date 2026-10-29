import { activeDefaultStoreWorkPriority, isStoreWorkPriority, type QueryOptions, type StoreWorkPriority } from '@origintrail-official/dkg-storage';
import type { ContextGraphMetaRecord } from './context-graph-meta-record.js';

interface RebuildAttempt {
  generation: number;
  sequence: number;
  promise: Promise<ContextGraphMetaRecord>;
  resolve(value: ContextGraphMetaRecord): void;
  reject(error: unknown): void;
}

/** Owns one CG's cache and bounded, independently scheduled lane rebuilds. */
export class ContextGraphMetaCacheEntry {
  value?: ContextGraphMetaRecord;
  invalidationVersion = 0;
  private generation = 0;
  private cachedGeneration = -1;
  private nextSequence = 0;
  private cachedSequence = -1;
  private readonly attempts = new Map<StoreWorkPriority, RebuildAttempt>();

  get hasInflight(): boolean { return this.attempts.size > 0; }

  invalidate(): void {
    this.invalidationVersion += 1;
    this.requireFreshRead();
  }

  /** Refresh ownership is separate from authority-facts invalidation. */
  requireFreshRead(): void { this.generation += 1; }

  async get(options: QueryOptions, load: (options: QueryOptions) => Promise<ContextGraphMetaRecord>): Promise<ContextGraphMetaRecord> {
    const priority = options.priority ?? activeDefaultStoreWorkPriority() ?? 'normal';
    if (!isStoreWorkPriority(priority)) throw new TypeError('Unsupported metadata store priority');
    return this.read(priority, options, load);
  }

  private async read(priority: StoreWorkPriority, options: QueryOptions,
    load: (options: QueryOptions) => Promise<ContextGraphMetaRecord>): Promise<ContextGraphMetaRecord> {
    throwIfMetaReadAborted(options.signal);
    if (this.value && this.cachedGeneration === this.generation) return this.value;
    const existing = this.attempts.get(priority);
    if (existing) {
      // A caller arriving after invalidation waits for its lane slot, then
      // starts/joins a fresh attempt. Pre-invalidation readers keep their result.
      if (existing.generation !== this.generation) {
        await raceAgainstAbort(existing.promise, options.signal);
        return this.read(priority, options, load);
      }
      return raceAgainstAbort(existing.promise, options.signal);
    }
    let resolve!: RebuildAttempt['resolve'];
    let reject!: RebuildAttempt['reject'];
    const promise = new Promise<ContextGraphMetaRecord>((ok, fail) => { resolve = ok; reject = fail; });
    const attempt = { generation: this.generation, sequence: this.nextSequence++, promise, resolve, reject };
    // Install ownership before calling store code, which can synchronously reenter.
    this.attempts.set(priority, attempt);
    void this.rebuild(priority, attempt, load, options.source);
    return raceAgainstAbort(promise, options.signal);
  }

  private async rebuild(priority: StoreWorkPriority, attempt: RebuildAttempt,
    load: (options: QueryOptions) => Promise<ContextGraphMetaRecord>, source?: string): Promise<void> {
    try {
      // Caller cancellation is isolated to each waiter, never donated to shared reads.
      const record = await load({ priority, ...(source ? { source } : {}) });
      if (attempt.generation === this.generation && attempt.sequence >= this.cachedSequence) {
        this.value = record;
        this.cachedGeneration = attempt.generation;
        this.cachedSequence = attempt.sequence;
      }
      attempt.resolve(record);
    } catch (error) {
      // A failed old lane cannot erase a successful newer lane's cache.
      attempt.reject(error);
    } finally {
      if (this.attempts.get(priority) === attempt) this.attempts.delete(priority);
    }
  }
}

function raceAgainstAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    // Store code may synchronously abort a caller after its entry check.
    void work.catch(() => undefined);
    const reason = signal.reason;
    return Promise.reject(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Keep the projection's historical Error-shaped cancellation contract. */
export function throwIfMetaReadAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}
