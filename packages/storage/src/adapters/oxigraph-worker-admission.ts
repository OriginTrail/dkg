import { raceStoreWorkAgainstAbort } from '../abortable-store-work-lifecycle.js';
import { QueryWorkStoppedError, remainingWorkMs } from '../query-work-stop.js';
import { asAbortError, createOxigraphWorkerTimeoutError } from './oxigraph-worker-timeout.js';

/**
 * Admission to one embedded-store worker, so that a read with a time limit can
 * be stopped.
 *
 * The embedded Oxigraph engine runs a query to its end: the only way to stop
 * one is to end the worker thread and load the persisted file in a new one.
 * That is safe only while the read is alone in the worker and every write the
 * worker acknowledged is on disk. So a stoppable read takes the worker for
 * itself, in arrival order:
 *   1. operations that arrive after it wait here, in the parent;
 *   2. the operations admitted before it finish;
 *   3. the worker writes any unflushed write to disk (nothing when clean);
 *   4. the read is posted, and if its limit ends while it runs, the worker is
 *      replaced. The operations that waited never reached the old worker; they
 *      go to its replacement.
 * While no stoppable read waits or runs, operations pass straight through.
 */
export interface WorkerAdmissionTicket {
  /** The admitted operation has settled. Idempotent. */
  done(): void;
}

type Waiter =
  | { readonly kind: 'ordinary'; readonly admit: (ticket: WorkerAdmissionTicket) => void }
  | { readonly kind: 'exclusive'; readonly admit: (release: () => void) => void; readonly owned: () => void };

export class WorkerAdmission {
  #inflight = 0;
  #owned = false;
  #drained: (() => void) | null = null;
  readonly #waiters: Waiter[] = [];

  /** Admit an operation now, or null when it must queue behind a stoppable read. */
  tryEnter(): WorkerAdmissionTicket | null {
    return this.#owned || this.#waiters.length > 0 ? null : this.#ticket();
  }

  /** Queue an operation in arrival order. Never admitted once it gives up. */
  enter(signal: AbortSignal | undefined, timeoutMs: number, timeoutError: () => Error): Promise<WorkerAdmissionTicket> {
    return this.#wait<WorkerAdmissionTicket>('ordinary', signal, timeoutMs, timeoutError);
  }

  /** Own the worker once everything admitted before has settled; resolves with `release`. */
  own(signal: AbortSignal | undefined, timeoutMs: number, timeoutError: () => Error): Promise<() => void> {
    return this.#wait<() => void>('exclusive', signal, timeoutMs, timeoutError);
  }

  #wait<T>(kind: Waiter['kind'], signal: AbortSignal | undefined, timeoutMs: number, timeoutError: () => Error): Promise<T> {
    if (signal?.aborted) return Promise.reject(asAbortError(signal.reason));
    return new Promise<T>((resolve, reject) => {
      let state: 'queued' | 'draining' | 'settled' = 'queued';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        state = 'settled';
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const admit = (value: unknown) => { settle(); resolve(value as T); };
      const waiter: Waiter = kind === 'ordinary'
        ? { kind, admit }
        : { kind, admit, owned: () => { state = 'draining'; } };
      const giveUp = (error: Error) => {
        if (state === 'settled') return;
        if (state === 'queued') this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        else { this.#owned = false; this.#drained = null; }
        settle();
        reject(error);
        this.#pump();
      };
      const onAbort = () => giveUp(asAbortError(signal?.reason));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => giveUp(timeoutError()), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
      this.#waiters.push(waiter);
      this.#pump();
    });
  }

  #pump(): void {
    while (!this.#owned && this.#waiters.length > 0) {
      const head = this.#waiters.shift()!;
      if (head.kind === 'ordinary') {
        head.admit(this.#ticket());
        continue;
      }
      this.#owned = true;
      head.owned();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.#owned = false;
        this.#pump();
      };
      const grant = () => { this.#drained = null; head.admit(release); };
      if (this.#inflight === 0) grant();
      else this.#drained = grant;
    }
  }

  #ticket(): WorkerAdmissionTicket {
    this.#inflight += 1;
    let open = true;
    return {
      done: () => {
        if (!open) return;
        open = false;
        this.#inflight -= 1;
        if (this.#inflight === 0) this.#drained?.();
      },
    };
  }
}

/** What a stoppable read needs from the worker store that owns it. */
export interface StoppableReadHost {
  readonly admission: WorkerAdmission;
  /** The store's own read bound in ms (0 = none). */
  readonly operationTimeoutMs: number;
  /** Post without admission, after any crash replacement in progress: only the owner calls it. */
  post<T>(method: string, args: unknown[], timeoutMs: number, signal: AbortSignal | undefined): Promise<T>;
  /** End the worker to stop the read it runs; false when the store must keep it (closing). */
  replaceWorker(): Promise<boolean>;
}

const BACKEND = 'oxigraph-worker';

/** Run one read alone in the worker, and replace the worker if its limit ends it. */
export async function runStoppableRead<T>(
  host: StoppableReadHost,
  method: string,
  args: unknown[],
  options: { readonly signal?: AbortSignal; readonly workDeadline?: number },
): Promise<T> {
  const { signal } = options;
  const boundMs = (): number => {
    const remaining = remainingWorkMs(options.workDeadline) ?? 0;
    if (host.operationTimeoutMs <= 0) return remaining;
    return remaining > 0 ? Math.min(remaining, host.operationTimeoutMs) : host.operationTimeoutMs;
  };
  const timeoutError = () => createOxigraphWorkerTimeoutError(method, boundMs());
  let release: () => void;
  try {
    release = await host.admission.own(signal, boundMs(), timeoutError);
  } catch (cause) {
    throw new QueryWorkStoppedError(BACKEND, 'not_started', cause);
  }
  // The worker is ours until `release`. A caller that leaves before the read is
  // posted is answered at once; the worker is released when the barrier ends.
  let releaseAfter = null as Promise<unknown> | null;
  try {
    let stoppable = true;
    // A write that cannot be made durable must not be lost to a stop: such a
    // read still runs, but only its wait ends at the limit.
    const barrier = host.post<void>('persistBarrier', [], 0, undefined).catch(() => { stoppable = false; });
    try {
      await raceStoreWorkAgainstAbort(barrier, signal, { timeout: { timeoutMs: boundMs(), timeoutError } });
    } catch (cause) {
      releaseAfter = barrier;
      throw new QueryWorkStoppedError(BACKEND, 'not_started', cause);
    }
    try {
      return await host.post<T>(method, args, boundMs(), signal);
    } catch (error) {
      const ended = signal?.aborted === true
        || (error as { code?: unknown } | null)?.code === 'OXIGRAPH_WORKER_OP_TIMEOUT';
      if (!ended || !stoppable || !await host.replaceWorker()) throw error;
      throw new QueryWorkStoppedError(BACKEND, 'stopped', signal?.aborted ? signal.reason : error);
    }
  } finally {
    if (releaseAfter) void releaseAfter.finally(release);
    else release();
  }
}
