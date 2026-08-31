/**
 * Compose caller cancellation with a store lifecycle signal.
 *
 * Kept here instead of in an HTTP adapter so every scheduled operation in one
 * lifecycle generation observes the same close boundary.
 */
export interface AbortSignalScope {
  readonly signal: AbortSignal | undefined;
  dispose(): void;
}

export interface StoreWorkTimeoutRace {
  readonly timeoutMs: number;
  readonly timeoutError: () => Error;
}

const NOOP_DISPOSE = () => {};

/** Race store work against cancellation while preserving the abort reason. */
export function raceStoreWorkAgainstAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  timeout?: StoreWorkTimeoutRace,
): Promise<T> {
  if (!signal && (!timeout || timeout.timeoutMs <= 0)) return work;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(normalizeAbortReason(signal?.reason)));
    signal?.addEventListener('abort', onAbort, { once: true });
    // Attach both handlers before observing pre-abort so every started promise
    // remains consumed even when cancellation wins the race immediately.
    work.then(
      (value) => finish(() => resolve(value)),
      (cause) => finish(() => reject(cause)),
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (timeout && timeout.timeoutMs > 0) {
      timer = setTimeout(
        () => finish(() => reject(timeout.timeoutError())),
        timeout.timeoutMs,
      );
      if (typeof timer.unref === 'function') timer.unref();
    }
  });
}

function normalizeAbortReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

export function composeAbortSignals(
  primary: AbortSignal | undefined,
  secondary: AbortSignal | undefined,
): AbortSignalScope {
  if (!primary) return { signal: secondary, dispose: NOOP_DISPOSE };
  if (!secondary) return { signal: primary, dispose: NOOP_DISPOSE };

  const combined = new AbortController();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    primary.removeEventListener('abort', forwardPrimary);
    secondary.removeEventListener('abort', forwardSecondary);
  };
  const forwardPrimary = () => {
    if (disposed || combined.signal.aborted) return;
    combined.abort(primary.reason);
    dispose();
  };
  const forwardSecondary = () => {
    if (disposed || combined.signal.aborted) return;
    combined.abort(secondary.reason);
    dispose();
  };

  if (primary.aborted) combined.abort(primary.reason);
  else if (secondary.aborted) combined.abort(secondary.reason);
  else {
    primary.addEventListener('abort', forwardPrimary, { once: true });
    secondary.addEventListener('abort', forwardSecondary, { once: true });
  }
  return { signal: combined.signal, dispose };
}

interface StoreWorkGeneration {
  readonly controller: AbortController;
  readonly inFlight: Set<Promise<unknown>>;
  closing: boolean;
}

function createGeneration(): StoreWorkGeneration {
  return {
    controller: new AbortController(),
    inFlight: new Set(),
    closing: false,
  };
}

/**
 * Owns admission, cancellation, and draining for reusable store adapters.
 *
 * `close()` atomically closes one generation: work admitted before the close
 * is aborted and drained, while work attempted during the close is rejected
 * without reaching the scheduler/backend. Once draining completes a fresh
 * generation is installed, preserving SparqlHttpStore's historical reusable
 * close contract without allowing work to escape the closing snapshot.
 */
export class AbortableStoreWorkLifecycle {
  private generation = createGeneration();
  private closePromise: Promise<void> | null = null;

  run<T>(
    callerSignal: AbortSignal | undefined,
    start: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    const generation = this.generation;
    if (generation.closing) {
      const reason = generation.controller.signal.reason;
      return Promise.reject(
        reason instanceof Error ? reason : new Error(String(reason ?? 'Store lifecycle closed')),
      );
    }

    const signalScope = composeAbortSignals(callerSignal, generation.controller.signal);
    let task: Promise<T>;
    try {
      task = start(signalScope.signal);
    } catch (error) {
      signalScope.dispose();
      throw error;
    }
    generation.inFlight.add(task);
    void task.finally(() => {
      generation.inFlight.delete(task);
      signalScope.dispose();
    }).catch(() => undefined);
    return task;
  }

  close(reason: Error): Promise<void> {
    if (this.closePromise) return this.closePromise;

    const generation = this.generation;
    generation.closing = true;
    generation.controller.abort(reason);
    const draining = [...generation.inFlight];
    const task = (async () => {
      await Promise.allSettled(draining);
      if (this.generation === generation) {
        this.generation = createGeneration();
      }
    })();
    this.closePromise = task;
    void task.finally(() => {
      if (this.closePromise === task) this.closePromise = null;
    }).catch(() => undefined);
    return task;
  }
}
