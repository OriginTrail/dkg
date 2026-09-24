import type { Worker } from 'node:worker_threads';
import { chainEventLogStateReadRefusal } from '@origintrail-official/dkg-chain';
import type {
  ChainEventLogStore,
  ContextGraphForKaAnswer,
  ContextGraphKaList,
  KnowledgeAssetReadModel,
  KnowledgeAssetReadModelFactoryOptions,
  KnowledgeAssetReadOptions,
} from '@origintrail-official/dkg-chain';
import type {
  ChainIndexReadMethod,
  ChainIndexReadRequest,
  ChainIndexReadResponse,
  ChainIndexReadResult,
} from './chain-index-read-worker-protocol.js';
import { ChainIndexReadWorkerOwner } from './chain-index-read-worker-owner.js';

export interface ChainIndexReadDiagnostic {
  method: ChainIndexReadMethod;
  durationMs: number;
  queueMs: number;
  rowsRead: number;
  readMs: number;
  decodeMs: number;
  reason: string;
}

interface ReadWaiter {
  resolve: (value: ChainIndexReadResult | undefined) => void;
  reject: (error: unknown) => void;
  detach: () => void;
}

type ReadPhase =
  | { phase: 'queued' }
  | { phase: 'dispatched'; worker: Worker; dispatchedAt: number }
  | { phase: 'detached'; worker: Worker; dispatchedAt: number }
  | { phase: 'completed'; dispatchedAt?: number };

/** Retained until the physical read replies or its worker actually retires. */
interface PhysicalRead {
  key: string;
  request: ChainIndexReadRequest;
  createdAt: number;
  state: ReadPhase;
  timer: ReturnType<typeof setTimeout>;
  waiters: Set<ReadWaiter>;
}

export interface ChainIndexReadWorkerOptions {
  timeoutMs?: number;
  startupTimeoutMs?: number;
  maxPending?: number;
  maxInFlight?: number;
  onDiagnostic?: (event: ChainIndexReadDiagnostic) => void;
  /** Tests can substitute an entry with controlled failure/response timing. */
  workerFactory?: () => Worker;
}

/** One process-owned reader. The writer remains the daemon's existing store. */
export class ChainIndexReadWorker {
  private readonly owner: ChainIndexReadWorkerOwner;
  private nextId = 0;
  private nextModelId = 0;
  private readonly reads = new Map<number, PhysicalRead>();
  private readonly equivalent = new Map<string, PhysicalRead>();
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly maxInFlight: number;

  constructor(
    dbPath: string,
    private readonly store: Pick<ChainEventLogStore, 'load'>,
    private readonly options: ChainIndexReadWorkerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 1_500;
    const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.maxPending = options.maxPending ?? 64;
    this.maxInFlight = options.maxInFlight ?? 4;
    for (const value of [this.timeoutMs, startupTimeoutMs, this.maxPending, this.maxInFlight]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid chain-index worker limits');
    }
    this.owner = new ChainIndexReadWorkerOwner({
      dbPath, startupTimeoutMs, workerFactory: options.workerFactory,
      onReady: () => this.dispatch(),
      onResponse: (worker, response) => { void this.receive(worker, response); },
      onUnavailable: (reason) => this.unavailable(reason),
      onRetired: (worker) => this.retired(worker),
    });
  }

  createReadModel = (model: KnowledgeAssetReadModelFactoryOptions): KnowledgeAssetReadModel => {
    // A new binding never coalesces with work from a retired adapter generation.
    const generation = ++this.nextModelId;
    const binding = { ...model };
    const request = (method: ChainIndexReadMethod, key: bigint, readOptions: KnowledgeAssetReadOptions = {}, index?: bigint) =>
      this.read(generation, binding, method, key, readOptions, index);
    return {
      readContextGraphForKa: (id, options) => request('binding', id, options) as Promise<ContextGraphForKaAnswer | undefined>,
      readContextGraphKaAt: (id, index, options) => request('ordinal', id, options, index) as
        Promise<Readonly<{ kaId: bigint; asOfBlockNumber: number }> | undefined>,
      readContextGraphKaList: (id, options) => request('list', id, options) as Promise<ContextGraphKaList | undefined>,
    };
  };

  private read(
    generation: number,
    model: KnowledgeAssetReadModelFactoryOptions,
    method: ChainIndexReadMethod,
    key: bigint,
    options: KnowledgeAssetReadOptions,
    index?: bigint,
  ): Promise<ChainIndexReadResult | undefined> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('Chain-index read aborted'));
    if (!this.owner.acceptsReads()) return Promise.resolve(undefined);
    // Bound callers as well as distinct jobs: a stalled shared read must not
    // accumulate unlimited promise callbacks and AbortSignal listeners.
    let callers = 0;
    for (const read of this.reads.values()) callers += read.waiters.size;
    if (callers >= this.maxPending) return Promise.resolve(undefined);
    const jobKey = JSON.stringify([generation, method, key.toString(), index?.toString(),
      options.view ?? 'finalized', options.ownWrite?.blockNumber, options.ownWrite?.blockHash]);
    let read = this.equivalent.get(jobKey);
    if (read === undefined) {
      if (this.reads.size >= this.maxPending) return Promise.resolve(undefined);
      const id = ++this.nextId;
      const createdAt = Date.now();
      read = {
        key: jobKey,
        createdAt,
        state: { phase: 'queued' },
        request: {
          type: 'read', id, model, method, key, index,
          options: { view: options.view, ownWrite: options.ownWrite && { ...options.ownWrite } },
          deadlineAt: createdAt + this.timeoutMs,
        },
        timer: setTimeout(() => this.expire(id), this.timeoutMs),
        waiters: new Set(),
      };
      read.timer.unref();
      this.reads.set(id, read);
      this.equivalent.set(jobKey, read);
    }
    const pending = read;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        pending.waiters.delete(waiter);
        waiter.detach();
        reject(options.signal?.reason ?? new Error('Chain-index read aborted'));
        if (pending.waiters.size === 0) this.settleObservers(pending, undefined, 'cancelled');
      };
      const waiter: ReadWaiter = {
        resolve, reject,
        detach: () => options.signal?.removeEventListener('abort', onAbort),
      };
      pending.waiters.add(waiter);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.dispatch();
    });
  }

  private dispatch(): void {
    const queued = [...this.reads.values()].filter((read) => read.state.phase === 'queued')
      .sort((a, b) => Number(b.request.method === 'binding') - Number(a.request.method === 'binding'));
    if (queued.length === 0) {
      this.updateReference();
      return;
    }
    const live = this.owner.acquire();
    if (live === undefined) {
      for (const read of queued) this.settleObservers(read, undefined, 'worker-unavailable');
      return;
    }
    if (live.phase === 'starting') {
      this.updateReference();
      return;
    }
    let active = [...this.reads.values()].filter((read) =>
      (read.state.phase === 'dispatched' || read.state.phase === 'detached')
      && read.state.worker === live.worker).length;
    for (const read of queued) {
      if (active >= this.maxInFlight) break;
      // A synchronous ready notification can already have dispatched this read.
      if (read.state.phase !== 'queued') continue;
      read.state = { phase: 'dispatched', worker: live.worker, dispatchedAt: Date.now() };
      try {
        this.owner.setReferenced(true);
        live.worker.postMessage(read.request);
        active++;
      } catch {
        this.owner.fail(live.worker);
        return;
      }
    }
  }

  private expire(id: number): void {
    const read = this.reads.get(id);
    if (read === undefined) return;
    const state = read.state;
    this.settleObservers(read, undefined, 'timeout');
    if (state.phase === 'dispatched' || state.phase === 'detached') {
      // Cancellation cannot interrupt synchronous SQLite. The physical read's
      // own deadline survives its observers and forces retirement if necessary.
      this.owner.fail(state.worker);
    }
  }

  private async receive(worker: Worker, response: ChainIndexReadResponse): Promise<void> {
    const read = this.reads.get(response.id);
    if (read === undefined) return;
    const previous = read.state;
    if ((previous.phase !== 'dispatched' && previous.phase !== 'detached')
      || previous.worker !== worker) return;
    read.state = { phase: 'completed', dispatchedAt: previous.dispatchedAt };
    queueMicrotask(() => this.dispatch());
    if (previous.phase === 'detached') {
      this.release(read);
      return;
    }
    // Physical work is finished, but the observer deadline remains in force
    // through the asynchronous validation of the committed cursor.
    if (Date.now() >= read.request.deadlineAt) {
      this.settleObservers(read, undefined, 'timeout', response);
      return;
    }
    if (response.result !== undefined) {
      try {
        const state = await this.store.load(read.request.model.scope);
        const nowMs = Date.now();
        if (nowMs >= read.request.deadlineAt) {
          this.settleObservers(read, undefined, 'timeout', response);
          return;
        }
        const fence = response.fence;
        if (state === undefined || fence === undefined
          || state.cursor.revision !== fence.revision
          || state.cursor.lineage !== fence.lineage
          || state.cursor.topicSetVersion !== fence.topicSetVersion
          || chainEventLogStateReadRefusal(state, {
            nowMs, maxHeadAgeMs: read.request.model.maxHeadAgeMs,
          }) !== undefined) {
          this.settleObservers(read, undefined, 'retired-revision', response);
          return;
        }
      } catch {
        this.settleObservers(read, undefined, 'store-unavailable', response);
        return;
      }
    }
    this.settleObservers(read, response.result, response.reason ?? 'served', response);
  }

  private settleObservers(
    read: PhysicalRead,
    result: ChainIndexReadResult | undefined,
    reason: string,
    response?: ChainIndexReadResponse,
  ): void {
    if (this.reads.get(read.request.id) !== read || read.state.phase === 'detached') return;
    const previous = read.state;
    const dispatchedAt = previous.phase === 'queued' ? undefined : previous.dispatchedAt;
    if (this.equivalent.get(read.key) === read) this.equivalent.delete(read.key);
    if (previous.phase === 'dispatched') {
      // Losing the final observer does not finish the physical task. Keep its
      // record and deadline until its reply or its worker's retirement arrives.
      read.state = { ...previous, phase: 'detached' };
      try { previous.worker.postMessage({ type: 'cancel', id: read.request.id }); } catch { /* exiting worker */ }
    } else {
      this.release(read);
    }
    for (const waiter of read.waiters) {
      waiter.detach();
      waiter.resolve(result);
    }
    read.waiters.clear();
    try {
      this.options.onDiagnostic?.({
        method: read.request.method,
        durationMs: Date.now() - read.createdAt,
        queueMs: (dispatchedAt ?? Date.now()) - read.createdAt,
        rowsRead: response?.rowsRead ?? 0,
        readMs: response?.readMs ?? 0,
        decodeMs: response?.decodeMs ?? 0,
        reason,
      });
    } catch { /* Observability cannot change read correctness. */ }
    this.updateReference();
    queueMicrotask(() => this.dispatch());
  }

  private release(read: PhysicalRead): void {
    const dispatchedAt = read.state.phase === 'queued' ? undefined : read.state.dispatchedAt;
    read.state = { phase: 'completed', dispatchedAt };
    clearTimeout(read.timer);
    this.reads.delete(read.request.id);
    if (this.equivalent.get(read.key) === read) this.equivalent.delete(read.key);
  }

  private unavailable(reason: 'closed' | 'worker-unavailable'): void {
    for (const read of this.reads.values()) {
      // Retirement owns physical completion now; no independent watchdog can
      // create another worker or discard its outstanding physical records.
      clearTimeout(read.timer);
      this.settleObservers(read, undefined, reason);
    }
  }

  private retired(worker: Worker): void {
    for (const read of this.reads.values()) {
      if ((read.state.phase === 'dispatched' || read.state.phase === 'detached')
        && read.state.worker === worker) this.release(read);
    }
  }

  private updateReference(): void {
    this.owner.setReferenced([...this.reads.values()].some((read) => read.waiters.size > 0));
  }

  close(): Promise<void> {
    return this.owner.close();
  }
}
