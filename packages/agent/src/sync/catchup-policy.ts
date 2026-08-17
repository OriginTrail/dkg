import { normalizeSyncAdmissionSource, type SyncAdmissionSource } from './policy.js';

export type CatchupMode = 'background' | 'foreground';

export const FOREGROUND_CATCHUP_SYNC_PRIORITY = 2_000;

/** First backoff step after a foreground plane is refused by local admission. */
export const CATCHUP_BACKPRESSURE_BASE_DELAY_MS = 250;
/** Ceiling for one backoff step; the scheduler drains in seconds, not minutes. */
export const CATCHUP_BACKPRESSURE_MAX_DELAY_MS = 5_000;
/** Fraction of a delay that jitter may add, so parallel receivers desynchronize. */
export const CATCHUP_BACKPRESSURE_JITTER_RATIO = 0.25;

/**
 * How long one foreground plane may keep waiting for local scheduler capacity.
 *
 * The previous policy was a fixed `[100, 250, 500]` ladder — 850 ms in total —
 * while an admitted `sync-global` round is bounded by `SYNC_TOTAL_TIMEOUT_MS`
 * (120 s) per plane, and issue #2006 measured queue waits of 87–109 s. A refused
 * foreground admission therefore always exhausted its budget long before the
 * head of the queue could possibly have cleared.
 *
 * The default is deliberately set ABOVE both of those numbers: the wait has to
 * outlast one full head-of-line round (120 s) plus the observed backlog, or the
 * budget still gives up in exactly the saturation case it exists to survive.
 * Waiting costs a timer and no work. It stays bounded, so a permanently
 * saturated node fails the catch-up job with a retryable status instead of
 * pinning it at `running` forever.
 */
export const DEFAULT_CATCHUP_BACKPRESSURE_MAX_WAIT_MS = 180_000;

/**
 * Parse the operator-facing retry budget.
 *
 * Exported as a pure function because the constant below is resolved once at
 * module load, which makes the env contract untestable in place — and the
 * contract has a sharp edge worth pinning: a BLANK assignment is the normal
 * docker-compose / `.env` / systemd shape for "not set", but `Number('')` is
 * `0`, which would silently disable retries entirely and land strictly worse
 * than the fixed ladder this replaced. Blank is unset; an explicit `0` still
 * means "do not retry".
 */
export function resolveCatchupBackpressureMaxWaitMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_CATCHUP_BACKPRESSURE_MAX_WAIT_MS;
  const parsed = Number(trimmed);
  // `Number.isInteger` alone accepts `1e308`, which is an integer by IEEE-754 and
  // a budget no operator meant. Require a SAFE integer so an unusable value falls
  // back to the documented default instead of becoming an unbounded wait.
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_CATCHUP_BACKPRESSURE_MAX_WAIT_MS;
}

export const CATCHUP_BACKPRESSURE_MAX_WAIT_MS: number =
  resolveCatchupBackpressureMaxWaitMs(process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS);

/**
 * Bounded admission origin recorded on node-wide scheduler diagnostics.
 *
 * DERIVED from the scheduler's own closed set rather than restating its literals.
 * The boundedness of this label space is load-bearing — it is a metric and log
 * dimension — and the scheduler owns that contract. Restating the strings meant a
 * rename in `SYNC_ADMISSION_SOURCES` would leave `catchupSourceForMode` returning a
 * stale literal that the scheduler then silently clamped to `unspecified`, with
 * nothing connecting the two declarations. `Extract` makes that a compile error:
 * a renamed member collapses this to `never` and the returns below stop building.
 */
export type CatchupAdmissionSource =
  Extract<SyncAdmissionSource, 'catchup-foreground' | 'catchup-background'>;

export interface CatchupPlaneResult {
  deferredBackpressure?: number;
}

export interface CatchupPlaneContext {
  priority?: number;
  /**
   * Widened from {@link CatchupAdmissionSource} because a caller may override
   * the mode-derived value (see {@link CatchupPlaneSourceOverride}), and
   * `vm-recovery` is not expressible in the two-member catch-up subset. Both
   * consumers already accept the full admission union, and the scheduler
   * re-clamps regardless, so the label space is unchanged.
   */
  source?: SyncAdmissionSource;
}

export interface CatchupPlaneSourceOverride {
  /**
   * Replace the source this catch-up would otherwise be attributed to.
   *
   * Kept separate from `mode` on purpose: `mode` decides scheduling (priority
   * and whether refusals are retried) while this decides only attribution. VM
   * recovery runs as ordinary background catch-up — it should keep background's
   * scheduling — but reporting it as `catchup-background` merges recovery
   * traffic into the background lane and undercounts it.
   *
   * Metadata only. It reaches no key, no wire envelope and no scheduling
   * decision, and is clamped to the closed source set before use.
   */
  sourceOverride?: SyncAdmissionSource;
}

/**
 * The single point of truth for "what source does this catch-up admit under".
 *
 * Shared by the admission seam and by the single-flight join site, because
 * those two must agree: if the join recorded a mode-derived label while the
 * admission recorded an overridden one, I6's owner/joiner families and I4's
 * source would describe the same work differently.
 */
export function catchupAdmissionSource(
  mode: CatchupMode,
  sourceOverride?: SyncAdmissionSource,
): SyncAdmissionSource {
  return sourceOverride === undefined
    ? catchupSourceForMode(mode)
    : normalizeSyncAdmissionSource(sourceOverride);
}

export interface CatchupBackpressureRetryPolicy {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  /** Total wall-clock budget for one plane's admission retries. */
  maxWaitMs?: number;
}

/** Deterministic seams for tests; never operator configuration. */
export interface CatchupPlanePolicyClock {
  /**
   * Removed with the fixed `[100, 250, 500]` ladder it configured.
   *
   * Declared as `never` rather than deleted outright so a caller that still
   * sets it FAILS TO COMPILE instead of having it silently ignored — an
   * ignored `retryDelaysMs: [10]` would turn an intended 10 ms schedule into a
   * wait of up to `CATCHUP_BACKPRESSURE_MAX_WAIT_MS`, which is a much worse way
   * to learn about the change than a type error.
   *
   * Operators: use `DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS`. Tests: use `retry`
   * with `now` / `wait` / `random`.
   *
   * @deprecated
   */
  retryDelaysMs?: never;
  retry?: CatchupBackpressureRetryPolicy;
  wait?: (delayMs: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface CatchupPlanePolicyOptions<
  TDurable extends CatchupPlaneResult,
  TShared extends CatchupPlaneResult,
> extends CatchupPlanePolicyClock, CatchupPlaneSourceOverride {
  mode: CatchupMode;
  includeSharedMemory: boolean;
  syncDurable: (context: CatchupPlaneContext) => Promise<TDurable>;
  syncSharedMemory: (context: CatchupPlaneContext) => Promise<TShared>;
}

export interface CatchupPlanePolicyResult<
  TDurable extends CatchupPlaneResult,
  TShared extends CatchupPlaneResult,
> {
  durable: TDurable;
  shared: TShared | null;
}

export function catchupPriorityForMode(mode: CatchupMode): number | undefined {
  return mode === 'foreground' ? FOREGROUND_CATCHUP_SYNC_PRIORITY : undefined;
}

export function catchupSourceForMode(mode: CatchupMode): CatchupAdmissionSource {
  return mode === 'foreground' ? 'catchup-foreground' : 'catchup-background';
}

/**
 * Elapsed-time source for the retry deadline.
 *
 * `performance.now()` is monotonic; `Date.now()` is not, and the budget here is a
 * duration rather than a point in time, so it must not follow a wall-clock
 * correction. Falls back to `Date.now` only if `performance` is unavailable.
 */
export const monotonicNow: () => number = typeof performance?.now === 'function'
  ? () => performance.now()
  : Date.now;

/** A pending backoff must never keep the process alive past `agent.stop()`. */
function defaultWait(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Exponential backoff with additive jitter, clamped so a sleep never runs past
 * the plane's retry deadline. Returns `undefined` once no useful wait remains.
 */
export function nextCatchupBackpressureDelayMs(input: {
  attempt: number;
  remainingMs: number;
  policy?: CatchupBackpressureRetryPolicy;
  random?: () => number;
}): number | undefined {
  if (input.remainingMs <= 0) return undefined;
  const baseDelayMs = input.policy?.baseDelayMs ?? CATCHUP_BACKPRESSURE_BASE_DELAY_MS;
  const maxDelayMs = input.policy?.maxDelayMs ?? CATCHUP_BACKPRESSURE_MAX_DELAY_MS;
  const jitterRatio = input.policy?.jitterRatio ?? CATCHUP_BACKPRESSURE_JITTER_RATIO;
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, input.attempt));
  const jittered = exponential * (1 + jitterRatio * (input.random?.() ?? Math.random()));
  return Math.max(1, Math.min(Math.round(jittered), input.remainingMs));
}

/**
 * Run one catch-up plane, retrying only while LOCAL admission backpressure kept
 * refusing it, until a bounded wall-clock deadline.
 *
 * Cancellation needs no extra plumbing: an aborted admission raises an
 * `AbortError`, not a `SyncBackpressureBusyError`, so it never sets
 * `deferredBackpressure` and the loop's own guard exits on the next iteration.
 *
 * SCOPE. The budget bounds how long this plane keeps ASKING. It does not
 * preempt a round the scheduler has already ACCEPTED: once admitted, the plane
 * is doing (or waiting to do) real work, and the only cancellation seam reaching
 * it — `operationSignal` — aborts the whole sync, so firing it at the deadline
 * would kill productive catch-up under exactly the load this exists to survive.
 * An accepted round is separately bounded by `SYNC_TOTAL_TIMEOUT_MS`, and the
 * queue it waits in is depth-bounded, so the wait is finite either way. Refusal
 * is the only signal that means "no capacity, come back later", and refusal is
 * what this retries.
 */
export async function runCatchupPlaneWithPolicy<T extends CatchupPlaneResult>(
  mode: CatchupMode,
  run: (context: CatchupPlaneContext) => Promise<T>,
  options: CatchupPlanePolicyClock & CatchupPlaneSourceOverride = {},
): Promise<T> {
  // `retryDelaysMs` configured the fixed [100, 250, 500] ladder that #2006 replaced
  // with a wall-clock budget. Retaining it as `?: never` makes a TypeScript caller
  // fail to compile — but a JS caller compiled against the old shape still passes it
  // and would have it IGNORED, silently turning an intended 10 ms schedule into a wait
  // of up to CATCHUP_BACKPRESSURE_MAX_WAIT_MS. Checked before the mode branch so a
  // background caller is not exempt.
  if ((options as { retryDelaysMs?: unknown }).retryDelaysMs !== undefined) {
    throw new TypeError(
      'retryDelaysMs was removed in issue #2006; catch-up retries are now bounded by '
      + 'an absolute wall-clock budget. Use `retry.maxWaitMs` (operators: '
      + 'DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS). It is rejected rather than ignored '
      + 'because ignoring it would silently extend the wait to the full budget.',
    );
  }

  // Priority still follows `mode` alone — the override is attribution, not
  // scheduling, so an overridden plane queues exactly as it did before.
  const context: CatchupPlaneContext = {
    priority: catchupPriorityForMode(mode),
    source: catchupAdmissionSource(mode, options.sourceOverride),
  };
  if (mode !== 'foreground') return run(context);

  // `wait` and `now` are ONE seam, not two independent ones.
  //
  // Before #2006 the loop was bounded by the fixed `retryDelaysMs` ladder, so an
  // injected `wait` could return immediately and the loop still ended after three
  // steps. #2006 deleted the ladder and moved the terminator onto a wall-clock
  // deadline read through `now` — so a caller that injects only `wait` no longer
  // has a bound: `wait` resolves instantly while `now` is the real clock, and the
  // loop spins as fast as the microtask queue allows for the WHOLE budget.
  // Measured against the built module: 6,873,671 attempts in a 2 s budget, with
  // the macrotask queue starved throughout — roughly 700 million at the shipped
  // 180 s default. A frozen `now` never terminates at all.
  //
  // This is not only a stale-caller hazard: `{ wait }` alone is what a NEW caller
  // naturally writes to keep a test fast, and it type-checks today. Rejected here
  // rather than defaulted, because silently pairing it with the real clock is the
  // hang, and silently pairing it with a fake one would invent a timeline the
  // caller never asked for.
  //
  // Placed after the background early-return on purpose: background mode never
  // enters the retry loop, so injecting `wait` alone there is harmless and one
  // test legitimately does it to assert the loop is not entered.
  if (options.wait !== undefined && options.now === undefined) {
    throw new TypeError(
      'runCatchupPlaneWithPolicy: `wait` and `now` must be injected together. '
      + 'Since issue #2006 the retry loop is bounded by a wall-clock deadline read '
      + 'through `now`, so an injected `wait` without a matching `now` spins for the '
      + 'entire budget instead of stepping a schedule.',
    );
  }

  // `retry.maxWaitMs` reaches the loop without passing the env parser, so a
  // `NaN` or unsafe value here would make every computed delay `NaN` — which the
  // default timer treats as "as soon as possible", turning a bounded backoff into
  // a spin under persistent refusal.
  const configuredMaxWait = options.retry?.maxWaitMs;
  if (configuredMaxWait !== undefined
    && !(Number.isSafeInteger(configuredMaxWait) && configuredMaxWait >= 0)) {
    throw new TypeError(
      `runCatchupPlaneWithPolicy: retry.maxWaitMs must be a non-negative safe integer, got ${String(configuredMaxWait)}.`,
    );
  }

  // Monotonic by default. `Date.now()` moves with the wall clock, so an NTP step
  // BACKWARDS during a catch-up silently extends the advertised budget — the one
  // direction a bound must not move. Tests still inject `now`, and the paired
  // seam is enforced above.
  const now = options.now ?? monotonicNow;
  const wait = options.wait ?? defaultWait;
  const maxWaitMs = options.retry?.maxWaitMs ?? CATCHUP_BACKPRESSURE_MAX_WAIT_MS;
  // Absolute deadline fixed once per plane, taken BEFORE the first admission
  // attempt. The attempts themselves are what consume the wall clock — a round
  // that sits in the scheduler queue and then gets refused can take seconds —
  // so starting the clock after the first one would make the budget "however
  // long the first attempt took, PLUS maxWaitMs" instead of a per-plane bound.
  const retryUntil = now() + maxWaitMs;
  let result = await run(context);
  for (let attempt = 0; ; attempt += 1) {
    if ((result.deferredBackpressure ?? 0) === 0) return result;
    const delayMs = nextCatchupBackpressureDelayMs({
      attempt,
      remainingMs: retryUntil - now(),
      policy: options.retry,
      random: options.random,
    });
    if (delayMs === undefined) return result;
    await wait(delayMs);
    // Re-check the deadline AFTER sleeping. `nextCatchupBackpressureDelayMs`
    // sized the delay against the budget that remained before the sleep, but a
    // timer is a lower bound: under event-loop pressure the wake-up can land
    // well past `retryUntil`, and starting a fresh admission there would spend
    // scheduler capacity outside the budget this plane advertised.
    //
    // This declines to START an attempt; an attempt already in flight is never
    // interrupted. The deliberate collateral is that capacity clearing exactly
    // at or just after the deadline no longer gets one extra try.
    if (now() >= retryUntil) return result;
    result = await run(context);
  }
}

/**
 * Canonical foreground/background catch-up policy shared by the in-agent and
 * worker-backed runners. Durable metadata must settle before SWM starts; when
 * only SWM is deferred, retries never refetch the already-completed durable
 * plane.
 */
export async function runCatchupPlanesWithPolicy<
  TDurable extends CatchupPlaneResult,
  TShared extends CatchupPlaneResult,
>(
  options: CatchupPlanePolicyOptions<TDurable, TShared>,
): Promise<CatchupPlanePolicyResult<TDurable, TShared>> {
  const durable = await runCatchupPlaneWithPolicy(options.mode, options.syncDurable, options);
  if (!options.includeSharedMemory || (durable.deferredBackpressure ?? 0) > 0) {
    return { durable, shared: null };
  }

  const shared = await runCatchupPlaneWithPolicy(options.mode, options.syncSharedMemory, options);
  return { durable, shared };
}
