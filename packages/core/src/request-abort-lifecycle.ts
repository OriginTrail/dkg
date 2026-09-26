/**
 * Cancellation for one outbound request: a deadline plus the longer-lived
 * signals it must follow (the caller's signal and the node's stop signal),
 * combined without `AbortSignal.any` or `AbortSignal.timeout` (#2812).
 *
 * Node keeps a signal made by `AbortSignal.any` that has an
 * `AbortSignal.timeout` input strongly reachable, and listed as a dependant
 * of each source, until an abort listener is added and removed or every
 * source is collected. Made per request against the node's stop signal,
 * which lives as long as the process, those composites piled up, and Node's
 * cleanup walks the source's whole dependant set for each one it collects,
 * on the main thread. Here the only listeners on a longer-lived signal are
 * the ones this lifecycle adds, and `release()` removes them.
 */

/** Largest delay `setTimeout` honours; longer ones fire after 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface RequestAbortLifecycle {
  /**
   * Aborts when the deadline passes, or when a linked signal aborts before
   * `release()`, with that signal's reason.
   */
  readonly signal: AbortSignal;
  /** Aborts only when the deadline passes, with a `TimeoutError`. */
  readonly deadline: AbortSignal;
  /**
   * Stops following the linked signals and removes this lifecycle's
   * listeners from them. The deadline keeps its timing and still aborts
   * `signal`, as `AbortSignal.timeout` did. Idempotent.
   */
  release(): void;
}

/**
 * Starts the deadline now. `linked` signals are followed in order, so when
 * several are already aborted the first one's reason wins.
 */
export function startRequestAbortLifecycle(
  timeoutMs: number,
  linked: ReadonlyArray<AbortSignal | undefined>,
): RequestAbortLifecycle {
  const deadlineController = new AbortController();
  const controller = new AbortController();
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  deadlineController.signal.addEventListener(
    'abort',
    () => abort(deadlineController.signal.reason),
    { once: true },
  );
  const timer = setTimeout(() => {
    deadlineController.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  }, Math.min(Math.max(0, timeoutMs), MAX_TIMER_DELAY_MS));
  timer.unref?.();

  const detachers: Array<() => void> = [];
  for (const source of linked) {
    if (!source || controller.signal.aborted) continue;
    if (source.aborted) {
      abort(source.reason);
      continue;
    }
    const onAbort = (): void => abort(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    detachers.push(() => source.removeEventListener('abort', onAbort));
  }

  return {
    signal: controller.signal,
    deadline: deadlineController.signal,
    release: () => {
      for (const detach of detachers.splice(0)) detach();
    },
  };
}
