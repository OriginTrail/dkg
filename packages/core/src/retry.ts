export interface RetryOptions {
  /** Maximum number of attempts (default: 3). */
  maxAttempts?: number;
  /** Initial delay in ms before the first retry (default: 500). */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default: 30_000). */
  maxDelayMs?: number;
  /** Jitter factor 0–1 added to each delay to avoid thundering herd (default: 0.2). */
  jitter?: number;
  /** Optional predicate to decide if an error is retryable. Defaults to all errors. */
  isRetryable?: (err: unknown) => boolean;
  /** Called on each retry with attempt number and delay (for logging). */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  /** Optional signal to abort retries and backoff sleeps. */
  signal?: AbortSignal;
}

const DEFAULTS: Required<Omit<RetryOptions, 'isRetryable' | 'onRetry' | 'signal'>> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.2,
};

/**
 * Execute an async function with exponential backoff retry.
 *
 * delay = min(baseDelay * 2^attempt + jitter, maxDelay)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const jitterFactor = opts.jitter ?? DEFAULTS.jitter;
  const isRetryable = opts.isRetryable;
  const onRetry = opts.onRetry;
  const signal = opts.signal;

  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    throwIfAborted(signal);
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (isRetryable && !isRetryable(err)) throw err;
      if (attempt >= maxAttempts - 1) throw err;

      const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
      const jitter = exponentialDelay * jitterFactor * Math.random();
      const delay = Math.min(exponentialDelay + jitter, maxDelayMs);

      onRetry?.(attempt + 1, delay, err);
      await sleep(delay, signal);
    }
  }

  throw lastErr;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(asAbortError(signal.reason));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw asAbortError(signal.reason);
}

function asAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    reason.name = 'AbortError';
    return reason;
  }
  const err = new Error(typeof reason === 'string' ? reason : 'aborted');
  err.name = 'AbortError';
  return err;
}
