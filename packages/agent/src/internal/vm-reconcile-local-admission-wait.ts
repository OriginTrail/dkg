/**
 * Graphs waiting for node-local sync admission, served in turn.
 *
 * A reconcile pass that the node's own sync admission refused has nothing to
 * gain from running again while that capacity is still in use: every repeat
 * costs the pass's chain reads and is refused the same way, and every waiting
 * graph pays them at once. This component owns the wait instead. A refused
 * graph is kept in arrival order and nudged once the admission can take its
 * fetch, one graph at a time.
 *
 * A pass that could not start its work at all, because the source it had to
 * ask did not answer, waits here too (see {@link VmReconcileLocalAdmissionWait.defer}).
 *
 * It owns no sync lease and no VM worker. A nudge re-enters the ordinary
 * bounded dispatcher, and the periodic sweep still visits a waiting graph.
 */

/** A refused nudge's hold, and how often the queue re-reads capacity. */
const RETRY_MS = 2_500;
/**
 * How long a nudged pass holds the next waiter back when it has not settled:
 * long enough to reach its own admission, after which the capacity read
 * accounts for it. Without the bound a long fetch on a node with several sync
 * slots would keep its free ones idle.
 */
const TURN_MAX_MS = 15_000;

export interface LocalAdmissionWaitOptions {
  signal?: AbortSignal;
  isCurrent: () => boolean;
  /** Whether the node's sync admission would take this graph's fetch right now. */
  canAdmit: () => boolean;
}

interface Waiter extends LocalAdmissionWaitOptions {
  /** Parked by `defer`: its last pass ended as a failed one. */
  deferred: boolean;
  onAbort: () => void;
}

/** One pass of a graph, from the moment it started. */
export interface LocalAdmissionPass {
  readonly key: string;
  /** The graph's place in the wait when the pass started, if it had one. */
  readonly waiting: object | undefined;
}

export interface VmReconcileLocalAdmissionWaitDeps {
  /**
   * Nudge one graph and return its pass's completion. Undefined when the
   * nudge was not admitted (held after a failed pass, or no queue room).
   * `deferred` says the graph was parked by `defer`, so the hold a failed
   * pass leaves is its own and this nudge is the retry.
   */
  readonly nudge: (key: string, deferred: boolean) => Promise<unknown> | undefined;
  /** Bound on retained waiters. */
  readonly maxWaiters: number;
}

/** A capacity read that cannot answer falls back to the plain bounded retry. */
function admissionAvailable(waiter: Waiter): boolean {
  try {
    return waiter.canAdmit();
  } catch {
    return true;
  }
}

export class VmReconcileLocalAdmissionWait {
  /** Waiting graphs, in the order they are served. */
  private readonly waiters = new Map<string, Waiter>();
  /** The waiter nudged last, until its pass settles. */
  private turn: { key: string; startedAt: number } | undefined;
  /** No waiter is nudged before this time: a nudged pass was refused all the same. */
  private holdUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly deps: VmReconcileLocalAdmissionWaitDeps) {}

  /**
   * The node's sync admission refused this graph's fetch. `canAdmit` reads the
   * admission the fetch will ask. Every waiter uses this readiness contract.
   */
  retry(key: string, options: LocalAdmissionWaitOptions): void {
    if (this.closed || options.signal?.aborted || !options.isCurrent()) return;
    const refusedTurn = this.turn?.key === key;
    // The nudged graph was refused all the same, so the capacity read was
    // wrong or capacity went elsewhere first. It keeps its place at the head,
    // and nothing is nudged for one delay so a wrong read cannot spin passes.
    if (this.park(key, options, refusedTurn ? 'front' : 'keep') && refusedTurn) {
      this.holdUntil = Date.now() + RETRY_MS;
    }
    this.armTimer();
  }

  /**
   * A graph that just used the node's sync admission and has more to fetch
   * goes behind the graphs already waiting for it. Returns false, and parks
   * nothing, when no other graph is waiting.
   */
  yieldTurn(key: string, options: LocalAdmissionWaitOptions): boolean {
    if (this.closed || options.signal?.aborted || !options.isCurrent()) return false;
    let othersWaiting = false;
    for (const waiting of this.waiters.keys()) {
      if (waiting !== key) { othersWaiting = true; break; }
    }
    if (!othersWaiting) return false;
    const parked = this.park(key, options, 'back');
    this.armTimer();
    return parked;
  }

  /**
   * A pass ended before its work started: the source it had to ask gave no
   * answer. Nothing here can read when it will, so the graph goes behind the
   * others and no waiter is nudged for one delay. A graph that keeps getting
   * no answer then costs one short pass per delay, in turn with the rest.
   * `canAdmit` is the same readiness contract as for a refused fetch: the
   * graph is not asked again while its fetch could not start anyway.
   *
   * Returns `again` when the pass was this wait's own nudge, `parked` when it
   * came from elsewhere, and undefined when the graph was not taken.
   */
  defer(key: string, options: LocalAdmissionWaitOptions): 'parked' | 'again' | undefined {
    if (this.closed || options.signal?.aborted || !options.isCurrent()) return undefined;
    const nudged = this.turn?.key === key;
    if (!this.park(key, options, 'back', true)) return undefined;
    this.holdUntil = Date.now() + RETRY_MS;
    this.armTimer();
    return nudged ? 'again' : 'parked';
  }

  /** A pass of this graph is starting. Hand the result to {@link passEnded}. */
  passStarted(key: string): LocalAdmissionPass {
    return { key, waiting: this.waiters.get(key) };
  }

  /**
   * The pass ended. A graph whose place in the wait is still the one it had
   * when the pass started was not refused again, so it is no longer waiting.
   * Whatever the pass used is free now, so this is also when the next waiter
   * can go.
   */
  passEnded(pass: LocalAdmissionPass): void {
    if (pass.waiting !== undefined && this.waiters.get(pass.key) === pass.waiting) {
      this.remove(pass.key);
    }
    this.wake();
  }

  close(): void {
    this.closed = true;
    for (const key of this.waiters.keys()) this.remove(key);
    this.armTimer();
    this.turn = undefined;
  }

  private park(
    key: string,
    options: LocalAdmissionWaitOptions,
    position: 'front' | 'back' | 'keep',
    deferred = false,
  ): boolean {
    const existing = this.waiters.get(key);
    if (!existing && this.waiters.size >= this.deps.maxWaiters) return false;
    const waiter: Waiter = {
      deferred,
      canAdmit: options.canAdmit,
      isCurrent: options.isCurrent,
      ...(options.signal ? { signal: options.signal } : {}),
      onAbort: () => {
        if (this.waiters.get(key) !== waiter) return;
        this.remove(key);
        this.armTimer();
      },
    };
    existing?.signal?.removeEventListener('abort', existing.onAbort);
    if (position === 'front') {
      const behind = [...this.waiters].filter(([waiting]) => waiting !== key);
      this.waiters.clear();
      this.waiters.set(key, waiter);
      for (const [waiting, entry] of behind) this.waiters.set(waiting, entry);
    } else {
      // Setting an existing key keeps its place; `back` gives it up first.
      if (position === 'back') this.waiters.delete(key);
      this.waiters.set(key, waiter);
    }
    options.signal?.addEventListener('abort', waiter.onAbort, { once: true });
    return true;
  }

  private remove(key: string): void {
    const waiter = this.waiters.get(key);
    if (!waiter) return;
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    this.waiters.delete(key);
  }

  /**
   * Nudge the longest waiter the node's sync admission can take, unless a
   * nudged pass is still out. Waiters are read in arrival order and one that
   * cannot be admitted yet is passed over, so a graph with capacity of its own
   * is not held behind one without.
   */
  private wake(): void {
    if (this.closed) return;
    const now = Date.now();
    const turnIsOut = this.turn !== undefined && now - this.turn.startedAt < TURN_MAX_MS;
    if (!turnIsOut && now >= this.holdUntil) {
      // Removing the entry being visited is safe on a Map.
      for (const [key, waiter] of this.waiters) {
        if (waiter.signal?.aborted || !waiter.isCurrent()) {
          this.remove(key);
          continue;
        }
        if (!admissionAvailable(waiter)) continue;
        this.remove(key);
        const completion = this.deps.nudge(key, waiter.deferred);
        // Not admitted: the periodic sweep owns the graph.
        if (!completion) continue;
        const started = { key, startedAt: now };
        this.turn = started;
        const settle = () => {
          if (this.turn === started) this.turn = undefined;
          this.wake();
        };
        completion.then(settle, settle);
        break;
      }
    }
    this.armTimer();
  }

  /** One timer for the whole wait: the next delay to run out, else a capacity re-read per interval. */
  private armTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.waiters.size === 0) return;
    const now = Date.now();
    let delay = RETRY_MS;
    if (this.holdUntil > now) {
      delay = this.holdUntil - now;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.wake();
    }, delay);
    this.timer.unref?.();
  }
}
