import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
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
  ChainIndexReadWorkerMessage,
} from './chain-index-read-worker-protocol.js';

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

interface ReadJob {
  key: string;
  request: ChainIndexReadRequest;
  createdAt: number;
  dispatchedAt?: number;
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
  private worker?: Worker;
  private workerReady = false;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private cooldownUntil = 0;
  private nextId = 0;
  private nextModelId = 0;
  private readonly jobs = new Map<number, ReadJob>();
  private readonly activeIds = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly retirements = new Set<Promise<void>>();
  private readonly equivalent = new Map<string, ReadJob>();
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly maxPending: number;
  private readonly maxInFlight: number;

  constructor(
    private readonly dbPath: string,
    private readonly store: Pick<ChainEventLogStore, 'load'>,
    private readonly options: ChainIndexReadWorkerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 1_500;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.maxPending = options.maxPending ?? 64;
    this.maxInFlight = options.maxInFlight ?? 4;
    for (const value of [this.timeoutMs, this.startupTimeoutMs, this.maxPending, this.maxInFlight]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid chain-index worker limits');
    }
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
    if (this.closed || Date.now() < this.cooldownUntil) return Promise.resolve(undefined);
    // Bound callers as well as distinct jobs: a stalled shared read must not
    // accumulate unlimited promise callbacks and AbortSignal listeners.
    let callers = 0;
    for (const job of this.jobs.values()) callers += job.waiters.size;
    if (callers >= this.maxPending) return Promise.resolve(undefined);
    const jobKey = JSON.stringify([generation, method, key.toString(), index?.toString(),
      options.view ?? 'finalized', options.ownWrite?.blockNumber, options.ownWrite?.blockHash]);
    let job = this.equivalent.get(jobKey);
    if (job === undefined) {
      if (this.jobs.size >= this.maxPending) return Promise.resolve(undefined);
      const id = ++this.nextId;
      const createdAt = Date.now();
      job = {
        key: jobKey,
        createdAt,
        request: {
          type: 'read', id, model, method, key, index,
          options: { view: options.view, ownWrite: options.ownWrite && { ...options.ownWrite } },
          deadlineAt: createdAt + this.timeoutMs,
        },
        timer: setTimeout(() => {
          const worker = this.activeIds.has(id) ? this.worker : undefined;
          this.finish(id, undefined, 'timeout');
          // A stuck SQL call cannot observe cancellation. Recycle the reader
          // rather than queueing more work behind a wedged worker indefinitely.
          if (worker !== undefined) this.failed(worker);
        }, this.timeoutMs),
        waiters: new Set(),
      };
      job.timer.unref();
      this.jobs.set(id, job);
      this.equivalent.set(jobKey, job);
    }
    const pending = job;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        pending.waiters.delete(waiter);
        waiter.detach();
        reject(options.signal?.reason ?? new Error('Chain-index read aborted'));
        if (pending.waiters.size === 0) this.finish(pending.request.id, undefined, 'cancelled');
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

  private ensureWorker(): Worker | undefined {
    if (this.worker !== undefined) return this.worker;
    if (this.closed || this.retirements.size > 0 || Date.now() < this.cooldownUntil) return undefined;
    try {
      const sibling = new URL('./chain-index-read-worker-entry.js', import.meta.url);
      const entry = existsSync(sibling) ? sibling :
        new URL('../../../dist/daemon/worker/chain-index-read-worker-entry.js', import.meta.url);
      const worker = this.options.workerFactory?.() ?? new Worker(entry, {
        workerData: { dbPath: this.dbPath },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      this.worker = worker;
      this.workerReady = false;
      this.startupTimer = setTimeout(() => this.failed(worker), this.startupTimeoutMs);
      this.startupTimer.unref();
      worker.on('message', (response: ChainIndexReadWorkerMessage) => {
        if (this.worker !== worker) return;
        if ('type' in response && response.type === 'ready') {
          this.workerReady = true;
          clearTimeout(this.startupTimer);
          this.startupTimer = undefined;
          this.dispatch();
        } else {
          void this.receive(response as ChainIndexReadResponse);
        }
      });
      worker.on('error', () => this.failed(worker));
      worker.on('exit', () => this.failed(worker));
      worker.unref();
      return worker;
    } catch {
      this.cooldownUntil = Date.now() + 1_000;
      return undefined;
    }
  }

  private dispatch(): void {
    if (this.closed || this.jobs.size === 0) return;
    const worker = this.ensureWorker();
    if (worker === undefined) {
      for (const id of this.jobs.keys()) this.finish(id, undefined, 'worker-unavailable');
      return;
    }
    // Imports and opening SQLite get a separate bounded startup budget. Read
    // callers can fall back promptly without repeatedly killing a cold worker.
    if (!this.workerReady) {
      worker.ref();
      return;
    }
    let active = this.activeIds.size;
    const queued = [...this.jobs.values()].filter((job) => job.dispatchedAt === undefined)
      .sort((a, b) => Number(b.request.method === 'binding') - Number(a.request.method === 'binding'));
    for (const job of queued) {
      if (active >= this.maxInFlight) break;
      job.dispatchedAt = Date.now();
      try {
        worker.ref();
        this.activeIds.set(job.request.id, job.timer);
        worker.postMessage(job.request);
        active++;
      } catch {
        this.failed(worker);
        return;
      }
    }
  }

  private async receive(response: ChainIndexReadResponse): Promise<void> {
    const job = this.jobs.get(response.id);
    if (job === undefined) clearTimeout(this.activeIds.get(response.id));
    this.activeIds.delete(response.id);
    queueMicrotask(() => this.dispatch());
    if (job === undefined) return;
    if (Date.now() >= job.request.deadlineAt) {
      this.finish(response.id, undefined, 'timeout', response);
      return;
    }
    if (response.result !== undefined) {
      try {
        // Tiny cursor/coverage reads only. No historical rows cross this port.
        const state = await this.store.load(job.request.model.scope);
        const nowMs = Date.now();
        if (nowMs >= job.request.deadlineAt) {
          this.finish(response.id, undefined, 'timeout', response);
          return;
        }
        const fence = response.fence;
        if (state === undefined || fence === undefined
          || state.cursor.revision !== fence.revision
          || state.cursor.lineage !== fence.lineage
          || state.cursor.topicSetVersion !== fence.topicSetVersion
          || chainEventLogStateReadRefusal(state, {
            nowMs, maxHeadAgeMs: job.request.model.maxHeadAgeMs,
          }) !== undefined) {
          this.finish(response.id, undefined, 'retired-revision', response);
          return;
        }
      } catch {
        this.finish(response.id, undefined, 'store-unavailable', response);
        return;
      }
    }
    this.finish(response.id, response.result, response.reason ?? 'served', response);
  }

  private finish(id: number, result: ChainIndexReadResult | undefined, reason: string, response?: ChainIndexReadResponse): void {
    const job = this.jobs.get(id);
    if (job === undefined) return;
    this.jobs.delete(id);
    this.equivalent.delete(job.key);
    // A cancelled caller does not prove the physical task stopped. Retain its
    // deadline until the reply arrives, even when nobody is awaiting it.
    if (!this.activeIds.has(id)) clearTimeout(job.timer);
    if (response === undefined && job.dispatchedAt !== undefined) {
      try { this.worker?.postMessage({ type: 'cancel', id }); } catch { /* exiting worker */ }
    }
    for (const waiter of job.waiters) {
      waiter.detach();
      waiter.resolve(result);
    }
    try {
      this.options.onDiagnostic?.({
        method: job.request.method,
        durationMs: Date.now() - job.createdAt,
        queueMs: (job.dispatchedAt ?? Date.now()) - job.createdAt,
        rowsRead: response?.rowsRead ?? 0,
        readMs: response?.readMs ?? 0,
        decodeMs: response?.decodeMs ?? 0,
        reason,
      });
    } catch { /* Observability cannot change read correctness. */ }
    if (this.jobs.size === 0) this.worker?.unref();
    // Defer to avoid recursion while draining a failed/closed worker's queue.
    queueMicrotask(() => this.dispatch());
  }

  private failed(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.workerReady = false;
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    for (const timer of this.activeIds.values()) clearTimeout(timer);
    this.activeIds.clear();
    this.cooldownUntil = Date.now() + 1_000;
    for (const id of this.jobs.keys()) this.finish(id, undefined, 'worker-unavailable');
    this.retire(worker);
  }

  private retire(worker: Worker): void {
    const retirement = worker.terminate().then(() => undefined, () => undefined);
    this.retirements.add(retirement);
    void retirement.then(() => this.retirements.delete(retirement));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const id of this.jobs.keys()) this.finish(id, undefined, 'closed');
    const worker = this.worker;
    this.worker = undefined;
    this.workerReady = false;
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    for (const timer of this.activeIds.values()) clearTimeout(timer);
    this.activeIds.clear();
    if (worker !== undefined) this.retire(worker);
    await Promise.all(this.retirements);
  }
}
