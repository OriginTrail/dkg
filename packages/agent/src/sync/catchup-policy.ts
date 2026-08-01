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
  return Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_CATCHUP_BACKPRESSURE_MAX_WAIT_MS;
}

export const CATCHUP_BACKPRESSURE_MAX_WAIT_MS: number =
  resolveCatchupBackpressureMaxWaitMs(process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS);

/** Bounded admission origin recorded on node-wide scheduler diagnostics. */
export type CatchupAdmissionSource = 'catchup-foreground' | 'catchup-background';

export interface CatchupPlaneResult {
  deferredBackpressure?: number;
}

export interface CatchupPlaneContext {
  priority?: number;
  source?: CatchupAdmissionSource;
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
  retry?: CatchupBackpressureRetryPolicy;
  wait?: (delayMs: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface CatchupPlanePolicyOptions<
  TDurable extends CatchupPlaneResult,
  TShared extends CatchupPlaneResult,
> extends CatchupPlanePolicyClock {
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
 */
export async function runCatchupPlaneWithPolicy<T extends CatchupPlaneResult>(
  mode: CatchupMode,
  run: (context: CatchupPlaneContext) => Promise<T>,
  options: CatchupPlanePolicyClock = {},
): Promise<T> {
  const context: CatchupPlaneContext = {
    priority: catchupPriorityForMode(mode),
    source: catchupSourceForMode(mode),
  };
  let result = await run(context);
  if (mode !== 'foreground') return result;

  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultWait;
  const maxWaitMs = options.retry?.maxWaitMs ?? CATCHUP_BACKPRESSURE_MAX_WAIT_MS;
  // Absolute deadline fixed once per plane, so retries cannot compound with the
  // time the refused rounds themselves consumed.
  const retryUntil = now() + maxWaitMs;
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
