/**
 * Compose caller cancellation with a store lifecycle signal.
 *
 * Kept here instead of in an HTTP adapter so every scheduled operation in one
 * lifecycle generation observes the same close boundary.
 */
export function composeAbortSignals(
  primary: AbortSignal | undefined,
  secondary: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const AnyImpl = (AbortSignal as unknown as {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (AnyImpl) return AnyImpl([primary, secondary]);

  const combined = new AbortController();
  let settled = false;
  const cleanup = () => {
    primary.removeEventListener('abort', forwardPrimary);
    secondary.removeEventListener('abort', forwardSecondary);
  };
  const forwardPrimary = () => {
    if (settled) return;
    settled = true;
    cleanup();
    combined.abort(primary.reason);
  };
  const forwardSecondary = () => {
    if (settled) return;
    settled = true;
    cleanup();
    combined.abort(secondary.reason);
  };

  if (primary.aborted) combined.abort(primary.reason);
  else if (secondary.aborted) combined.abort(secondary.reason);
  else {
    primary.addEventListener('abort', forwardPrimary, { once: true });
    secondary.addEventListener('abort', forwardSecondary, { once: true });
  }
  return combined.signal;
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

    const signal = composeAbortSignals(callerSignal, generation.controller.signal);
    const task = start(signal);
    generation.inFlight.add(task);
    void task.finally(() => {
      generation.inFlight.delete(task);
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
