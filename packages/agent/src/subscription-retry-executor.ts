import { runBoundedOperation, isBoundedOperationTimeoutError } from './bounded-operation.js';
import { contextGraphReadAuthorityDependencyOf, unavailableContextGraphReadAuthorityDecision,
  type ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';

export interface SubscriptionRetryRow<T> {
  readonly id: string;
  readonly value: T;
  dueAt: number;
  expiresAt: number;
  checking: boolean;
  readonly order: number;
}
export interface SubscriptionRetryLease {
  isCurrent(): boolean;
  check(work: (signal: AbortSignal) => Promise<ContextGraphReadAuthorityDecision | undefined>):
    Promise<ContextGraphReadAuthorityDecision | undefined>;
}
interface SubscriptionRetryPolicy<T> {
  signal: AbortSignal;
  isCurrent(): boolean;
  eligible(row: Readonly<SubscriptionRetryRow<T>>): boolean;
  attempt(row: Readonly<SubscriptionRetryRow<T>>, lease: SubscriptionRetryLease): Promise<number | undefined>;
  retired(row: Readonly<SubscriptionRetryRow<T>>, expired: boolean): void;
  failed(row: Readonly<SubscriptionRetryRow<T>>, error: unknown): void;
  track(run: Promise<unknown>): void;
  now(): number;
  maxRows: number;
  maxConcurrent: number;
  checkTimeoutMs: number;
}

/** One bounded keyed queue, one scheduling timer, and explicit due/expiry times.
 * Policy owners retain their own backoff, wake-up and idle-window rules. */
export class SubscriptionRetryExecutor<T> {
  readonly #rows = new Map<string, SubscriptionRetryRow<T>>();
  readonly #idle = new Set<() => void>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #checking = 0;
  #order = 0;
  constructor(private readonly policy: SubscriptionRetryPolicy<T>) {
    policy.signal.addEventListener('abort', () => this.#pump(), { once: true });
  }

  take(id: string, value: T, expiresAt: number): boolean {
    if (!this.current() || this.#rows.has(id) || this.#rows.size >= this.policy.maxRows) return false;
    this.#rows.set(id, { id, value, expiresAt, dueAt: this.policy.now(), checking: false, order: this.#order++ });
    this.#pump();
    return true;
  }
  has(id: string): boolean { return this.#rows.has(id); }
  get size(): number { return this.#rows.size; }
  get(id: string): Readonly<SubscriptionRetryRow<T>> | undefined { return this.#rows.get(id); }
  /** Scheduling changes and timer rearming are one operation owned by this queue. */
  reschedule(update: (row: Readonly<SubscriptionRetryRow<T>>) =>
    Readonly<Partial<Pick<SubscriptionRetryRow<T>, 'dueAt' | 'expiresAt'>>> | undefined): void {
    for (const row of this.#rows.values()) {
      const next = update(row);
      if (next?.dueAt !== undefined) row.dueAt = next.dueAt;
      if (next?.expiresAt !== undefined) row.expiresAt = next.expiresAt;
    }
    this.#pump();
  }
  current(): boolean { return !this.policy.signal.aborted && this.policy.isCurrent(); }
  whenIdle(): Promise<void> {
    return this.#rows.size === 0 && this.#checking === 0 ? Promise.resolve()
      : new Promise(resolve => { this.#idle.add(resolve); });
  }
  #retire(row: SubscriptionRetryRow<T>): void {
    if (this.#rows.get(row.id) !== row) return;
    this.#rows.delete(row.id);
    this.policy.retired(row, this.policy.now() >= row.expiresAt);
  }
  #valid(row: SubscriptionRetryRow<T>): boolean {
    return this.current() && this.#rows.get(row.id) === row
      && this.policy.now() < row.expiresAt && this.policy.eligible(row);
  }

  #pump(): void {
    clearTimeout(this.#timer); this.#timer = undefined;
    for (const row of this.#rows.values()) if (!row.checking && !this.#valid(row)) this.#retire(row);
    const due = [...this.#rows.values()].filter(row => !row.checking && row.dueAt <= this.policy.now())
      .sort((a, b) => a.dueAt - b.dueAt || a.order - b.order);
    for (const row of due) {
      if (this.#checking >= this.policy.maxConcurrent) break;
      row.checking = true; this.#checking += 1;
      const lease: SubscriptionRetryLease = {
        isCurrent: () => this.#valid(row),
        check: async work => {
          const timeoutMs = Math.min(this.policy.checkTimeoutMs, row.expiresAt - this.policy.now());
          if (!this.#valid(row) || timeoutMs <= 0) return undefined;
          try {
            return await runBoundedOperation(work, { timeoutMs, signal: this.policy.signal,
              label: 'Persisted subscription authority' });
          } catch (error) {
            if (this.policy.signal.aborted || isBoundedOperationTimeoutError(error)) return undefined;
            return unavailableContextGraphReadAuthorityDecision('legacy-local', 'unexpected-authority-error',
              contextGraphReadAuthorityDependencyOf(error));
          }
        },
      };
      const run = Promise.resolve().then(() => this.#valid(row) ? this.policy.attempt(row, lease) : undefined)
        .then(next => { if (next === undefined) this.#retire(row); else row.dueAt = next; })
        .catch(error => { this.policy.failed(row, error); this.#retire(row); })
        .finally(() => { row.checking = false; this.#checking -= 1; this.#pump(); });
      this.policy.track(run);
    }
    if (this.#rows.size === 0 && this.#checking === 0) {
      for (const resolve of this.#idle) resolve();
      this.#idle.clear();
      return;
    }
    let next = Infinity;
    const now = this.policy.now();
    for (const row of this.#rows.values()) {
      if (row.expiresAt > now) next = Math.min(next, row.expiresAt);
      if (!row.checking && this.#checking < this.policy.maxConcurrent) next = Math.min(next, row.dueAt);
    }
    if (Number.isFinite(next)) {
      this.#timer = setTimeout(() => this.#pump(), Math.max(0, next - now));
      this.#timer.unref?.();
    }
  }
}
