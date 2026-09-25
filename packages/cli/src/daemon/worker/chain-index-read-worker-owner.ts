import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { ChainIndexReadResponse, ChainIndexReadWorkerMessage } from './chain-index-read-worker-protocol.js';

type LiveWorkerState =
  | { phase: 'starting'; worker: Worker; timer: ReturnType<typeof setTimeout> }
  | { phase: 'ready'; worker: Worker };

type WorkerState = LiveWorkerState
  | { phase: 'idle' }
  | { phase: 'retiring'; worker: Worker; completion: Promise<void>; cooldownUntil: number }
  | { phase: 'cooling'; until: number }
  | { phase: 'closed'; completion: Promise<void> };

interface WorkerOwnerOptions {
  dbPath: string;
  startupTimeoutMs: number;
  workerFactory?: () => Worker;
  onReady: () => void;
  onResponse: (worker: Worker, response: ChainIndexReadResponse) => void;
  onUnavailable: (reason: 'closed' | 'worker-unavailable') => void;
  onRetired: (worker: Worker) => void;
}

/** Owns one thread, including its physical retirement before any replacement. */
export class ChainIndexReadWorkerOwner {
  private state: WorkerState = { phase: 'idle' };

  constructor(private readonly options: WorkerOwnerOptions) {}

  acceptsReads(): boolean {
    if (this.state.phase === 'cooling' && Date.now() >= this.state.until) {
      this.state = { phase: 'idle' };
    }
    return this.state.phase === 'idle' || this.state.phase === 'starting' || this.state.phase === 'ready';
  }

  acquire(): LiveWorkerState | undefined {
    if (!this.acceptsReads()) return undefined;
    if (this.state.phase === 'starting' || this.state.phase === 'ready') return this.state;
    let worker: Worker | undefined;
    try {
      const sibling = new URL('./chain-index-read-worker-entry.js', import.meta.url);
      const entry = existsSync(sibling) ? sibling :
        new URL('../../../dist/daemon/worker/chain-index-read-worker-entry.js', import.meta.url);
      worker = this.options.workerFactory?.() ?? new Worker(entry, {
        workerData: { dbPath: this.options.dbPath },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      const created = worker;
      const timer = setTimeout(() => this.fail(created), this.options.startupTimeoutMs);
      timer.unref();
      this.state = { phase: 'starting', worker, timer };
      worker.unref();
      worker.on('message', (message: ChainIndexReadWorkerMessage) => {
        const live = this.live(created);
        if (live === undefined) return;
        if ('type' in message && message.type === 'ready') {
          if (live.phase !== 'starting') return;
          clearTimeout(live.timer);
          this.state = { phase: 'ready', worker: created };
          this.options.onReady();
        } else if (live.phase === 'ready') {
          this.options.onResponse(created, message as ChainIndexReadResponse);
        }
      });
      worker.on('error', () => this.fail(created));
      worker.on('exit', () => this.fail(created));
      return this.live(worker);
    } catch {
      if (worker !== undefined) {
        // Listener/reference setup can fail after construction. The thread
        // still belongs to us and must retire before cooling or replacement.
        if (this.live(worker) !== undefined || this.state.phase === 'idle') this.retire(worker, false);
        return undefined;
      }
      this.state = { phase: 'cooling', until: Date.now() + 1_000 };
      this.options.onUnavailable('worker-unavailable');
      return undefined;
    }
  }

  setReferenced(referenced: boolean): void {
    if (this.state.phase !== 'starting' && this.state.phase !== 'ready') return;
    if (referenced) this.state.worker.ref();
    else this.state.worker.unref();
  }

  fail(worker: Worker): void {
    if (this.live(worker) === undefined) return;
    this.retire(worker, false);
  }

  close(): Promise<void> {
    const state = this.state;
    switch (state.phase) {
      case 'closed': return state.completion;
      case 'retiring':
        this.state = { phase: 'closed', completion: state.completion };
        return state.completion;
      case 'starting':
      case 'ready': return this.retire(state.worker, true);
      case 'idle':
      case 'cooling': {
        const completion = Promise.resolve();
        this.state = { phase: 'closed', completion };
        this.options.onUnavailable('closed');
        return completion;
      }
    }
  }

  private live(worker: Worker): LiveWorkerState | undefined {
    return (this.state.phase === 'starting' || this.state.phase === 'ready')
      && this.state.worker === worker ? this.state : undefined;
  }

  private retire(worker: Worker, closing: boolean): Promise<void> {
    const live = this.live(worker);
    if (live?.phase === 'starting') clearTimeout(live.timer);
    let retired!: () => void;
    let failed!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => { retired = resolve; failed = reject; });
    // A failed termination is observed even before close() awaits it. It does
    // not prove physical retirement, so the owner stays unavailable and close
    // reports the failure instead of starting a concurrent replacement.
    void completion.catch(() => undefined);
    const retiring: WorkerState = {
      phase: 'retiring', worker, completion, cooldownUntil: Date.now() + 1_000,
    };
    this.state = closing ? { phase: 'closed', completion } : retiring;
    this.options.onUnavailable(closing ? 'closed' : 'worker-unavailable');
    const finish = () => {
      this.options.onRetired(worker);
      if (this.state === retiring) {
        this.state = { phase: 'cooling', until: retiring.cooldownUntil };
      }
      retired();
    };
    try {
      void worker.terminate().then(finish, failed);
    } catch (error) {
      failed(error);
    }
    return completion;
  }
}
