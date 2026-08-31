import {
  composeAbortSignals,
  raceStoreWorkAgainstAbort,
} from './abortable-store-work-lifecycle.js';

export interface LazyAbortableStreamOptions<T> {
  /** Absolute monotonic deadline shared by open, reads, and cleanup. */
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
  readonly timeoutMessage: string;
  readonly open: (signal: AbortSignal | undefined) => Promise<AsyncIterable<T>>;
  readonly invalidSource: () => never;
}

/**
 * Open and consume one backend stream under a single lazy cancellation scope.
 *
 * The helper owns the generic resource lifecycle: no backend is opened before
 * first iteration, non-cooperative open/read promises are raced against the
 * deadline, a source arriving after cancellation is closed, early consumer
 * return closes the acquired iterator, and signal listeners are always
 * released. Protocol-specific validation remains with the caller.
 */
export function openLazyAbortableStream<T>(
  options: LazyAbortableStreamOptions<T>,
): AsyncIterable<T> {
  return run();

  async function* run(): AsyncGenerator<T, void, undefined> {
    const remainingMs = options.deadlineAt - performance.now();
    if (remainingMs <= 0) throw timeout(options.timeoutMessage);
    const deadlineSignal = AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs)));
    const signalScope = composeAbortSignals(options.signal, deadlineSignal);
    try {
      assertActive(signalScope.signal, options.deadlineAt, options.timeoutMessage);
      const pendingSource = options.open(signalScope.signal);
      let source: AsyncIterable<T>;
      try {
        source = await raceStoreWorkAgainstAbort(
          pendingSource,
          signalScope.signal,
          async (lateSource) => {
            if (isAsyncIterable(lateSource)) await closeAsyncIterable(lateSource);
          },
        );
      } catch (cause) {
        assertActive(signalScope.signal, options.deadlineAt, options.timeoutMessage);
        throw cause;
      }
      assertActive(signalScope.signal, options.deadlineAt, options.timeoutMessage);
      if (!isAsyncIterable<T>(source)) options.invalidSource();

      const iterator = source[Symbol.asyncIterator]();
      let complete = false;
      try {
        while (true) {
          assertActive(signalScope.signal, options.deadlineAt, options.timeoutMessage);
          let next: IteratorResult<T>;
          try {
            next = await raceStoreWorkAgainstAbort(
              Promise.resolve(iterator.next()),
              signalScope.signal,
            );
          } catch (cause) {
            assertActive(signalScope.signal, options.deadlineAt, options.timeoutMessage);
            throw cause;
          }
          assertActive(signalScope.signal, options.deadlineAt, options.timeoutMessage);
          if (next.done) {
            complete = true;
            break;
          }
          yield next.value;
        }
      } finally {
        if (!complete) {
          await raceStoreWorkAgainstAbort(
            Promise.resolve().then(() => iterator.return?.()),
            signalScope.signal,
          ).catch(() => undefined);
        }
      }
      assertActive(signalScope.signal, options.deadlineAt, options.timeoutMessage);
    } finally {
      signalScope.dispose();
    }
  }
}

async function closeAsyncIterable(source: AsyncIterable<unknown>): Promise<void> {
  const iterator = source[Symbol.asyncIterator]();
  await iterator.return?.();
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]
      === 'function';
}

function assertActive(
  signal: AbortSignal | undefined,
  deadlineAt: number,
  timeoutMessage: string,
): void {
  signal?.throwIfAborted();
  if (performance.now() >= deadlineAt) throw timeout(timeoutMessage);
}

function timeout(message: string): DOMException {
  return new DOMException(message, 'TimeoutError');
}
