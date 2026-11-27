import { raceStoreWorkAgainstAbort } from '../abortable-store-work-lifecycle.js';
import { QueryWorkStoppedError, boundByWorkDeadline } from '../query-work-stop.js';
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

type Waiter = { readonly kind: 'ordinary' | 'exclusive'; readonly admit: (ticket: WorkerAdmissionTicket) => void };

export class WorkerAdmission {
  #inflight = 0;
  #owned = false;
  readonly #waiters: Waiter[] = [];

  /** Admit an operation now, or null when it must queue behind a stoppable read. */
  tryEnter(): WorkerAdmissionTicket | null {
    return this.#owned || this.#waiters.length > 0 ? null : this.#ticket();
  }

  /** Queue an operation in arrival order. Never admitted once it gives up. */
  enter(signal: AbortSignal | undefined, timeoutMs: number, timeoutError: () => Error): Promise<WorkerAdmissionTicket> {
    return this.#wait('ordinary', signal, timeoutMs, timeoutError);
  }

  /** Own the worker once everything admitted before has settled; resolves with the same idempotent lease as ordinary admission. */
  own(signal: AbortSignal | undefined, timeoutMs: number, timeoutError: () => Error): Promise<WorkerAdmissionTicket> {
    return this.#wait('exclusive', signal, timeoutMs, timeoutError);
  }

  #wait(kind: Waiter['kind'], signal: AbortSignal | undefined, timeoutMs: number, timeoutError: () => Error): Promise<WorkerAdmissionTicket> {
    if (signal?.aborted) return Promise.reject(asAbortError(signal.reason));
    let waiter!: Waiter;
    const admission = new Promise<WorkerAdmissionTicket>(resolve => {
      waiter = { kind, admit: resolve };
      this.#waiters.push(waiter);
    });
    const waiting = raceStoreWorkAgainstAbort(admission, signal, {
      timeout: { timeoutMs, timeoutError }, onLateResult: ticket => ticket.done(),
    });
    this.#pump();
    return waiting.finally(() => {
      const index = this.#waiters.indexOf(waiter);
      if (index >= 0) this.#waiters.splice(index, 1);
      this.#pump();
    });
  }

  #pump(): void {
    while (!this.#owned && this.#waiters.length > 0) {
      const head = this.#waiters[0];
      if (head.kind === 'exclusive' && this.#inflight > 0) return;
      this.#waiters.shift();
      if (head.kind === 'ordinary') {
        head.admit(this.#ticket());
        continue;
      }
      this.#owned = true;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.#owned = false;
        this.#pump();
      };
      head.admit({ done: release });
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
        if (this.#inflight === 0) this.#pump();
      },
    };
  }
}

/** What a stoppable read needs from the worker store that owns it. */
export interface StoppableReadHost {
  readonly admission: WorkerAdmission;
  /** The store's own read bound in ms (0 = none). */
  readonly operationTimeoutMs: number;
  /** Complete the durability barrier without a caller deadline interrupting it. */
  persist(): Promise<void>;
  /** End the worker to stop the read it runs; false when the store must keep it (closing). */
  replaceWorker(): Promise<boolean>;
}

const BACKEND = 'oxigraph-worker';

/** Run one read alone in the worker, and replace the worker if its limit ends it. */
export async function runStoppableRead<T>(
  host: StoppableReadHost,
  read: (timeoutMs: number, signal: AbortSignal | undefined) => Promise<T>,
  options: { readonly signal?: AbortSignal; readonly workDeadline?: number },
): Promise<T> {
  const { signal } = options;
  const operationDeadline = host.operationTimeoutMs > 0 ? performance.now() + host.operationTimeoutMs : Infinity;
  const deadline = Math.min(operationDeadline, Number.isFinite(options.workDeadline) ? options.workDeadline! : Infinity);
  const boundMs = (): number => boundByWorkDeadline(0, deadline);
  const timeoutError = () => createOxigraphWorkerTimeoutError('query', boundMs());
  const checkDeadline = () => { if (performance.now() >= deadline) throw timeoutError(); };
  let lease: WorkerAdmissionTicket;
  try {
    checkDeadline();
    lease = await host.admission.own(signal, boundMs(), timeoutError);
  } catch (cause) {
    throw new QueryWorkStoppedError(BACKEND, 'not_started', cause);
  }
  // The worker is ours until `lease.done`. A caller that leaves before the read is
  // posted is answered at once; the worker is released when the barrier ends.
  let releaseAfter = null as Promise<unknown> | null;
  try {
    let stoppable = true;
    // A write that cannot be made durable must not be lost to a stop: such a
    // read still runs, but only its wait ends at the limit.
    const barrier = host.persist().catch(() => { stoppable = false; });
    try {
      await raceStoreWorkAgainstAbort(barrier, signal, { timeout: { timeoutMs: boundMs(), timeoutError } });
      checkDeadline();
    } catch (cause) {
      releaseAfter = barrier;
      throw new QueryWorkStoppedError(BACKEND, 'not_started', cause);
    }
    try {
      return await read(boundMs(), signal);
    } catch (error) {
      const ended = signal?.aborted === true
        || (error as { code?: unknown } | null)?.code === 'OXIGRAPH_WORKER_OP_TIMEOUT';
      if (!ended || !stoppable || !await host.replaceWorker()) throw error;
      throw new QueryWorkStoppedError(BACKEND, 'stopped', signal?.aborted ? signal.reason : error);
    }
  } finally {
    if (releaseAfter) void releaseAfter.finally(lease.done);
    else lease.done();
  }
}
