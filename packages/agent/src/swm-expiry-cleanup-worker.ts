import { setImmediate } from 'node:timers/promises';
import { CoalescingRecurringTask } from '@origintrail-official/dkg-core';
import { SWM_CLEANUP_INTERVAL_MS } from './dkg-agent-constants.js';
import type {
  SwmExpiryCleanupContinuation,
  SwmExpiryCleanupRequest,
  SwmExpiryCleanupResult,
} from './swm-expiry-cleanup.js';

interface ManualCompletion {
  readonly promise: Promise<number>;
  readonly resolve: (deleted: number) => void;
  readonly reject: (error: unknown) => void;
}

interface CleanupJob {
  cutoffMs: number;
  continuation?: SwmExpiryCleanupContinuation;
  triplesDeleted: number;
  inPass: boolean;
  manual?: ManualCompletion;
}

/** SWM cutoff, continuation, and result policy over one task-owned cleanup job. */
export class SwmExpiryCleanupWorker {
  private task: CoalescingRecurringTask<CleanupJob>;
  private periodicEnabled = false;
  private stopping?: Promise<void>;

  constructor(
    private readonly processPass: (
      request: SwmExpiryCleanupRequest,
      isClosed: () => boolean,
    ) => Promise<SwmExpiryCleanupResult>,
    private readonly getSharedMemoryTtlMs: () => number,
    private readonly intervalMs = SWM_CLEANUP_INTERVAL_MS,
  ) {
    this.task = this.createTask();
  }

  get running(): boolean {
    return this.periodicEnabled
      && this.getSharedMemoryTtlMs() > 0
      && (this.task.running || this.task.scheduled);
  }

  start(): void {
    if (this.stopping) throw new Error('SWM expiry cleanup is still stopping');
    if (this.task.closed) this.task = this.createTask();
    this.periodicEnabled = true;
    if (this.getSharedMemoryTtlMs() > 0) this.task.schedule(0);
  }

  /** Fence the old policy and wait until its physical mutation retires. */
  async onTtlChanged(): Promise<void> {
    const task = this.task;
    if (task.closed || this.stopping) return;
    const ttlMs = this.getSharedMemoryTtlMs();
    task.updateJob((job) => {
      if (!job) return undefined;
      job.continuation = undefined;
      if (ttlMs > 0) job.cutoffMs = Date.now() - ttlMs;
      return job;
    });
    await task.cancelAndDrain('SWM retention policy changed');
    if (task !== this.task || task.closed || this.stopping) return;

    const currentTtlMs = this.getSharedMemoryTtlMs();
    const job = task.currentJob;
    if (currentTtlMs === 0) {
      if (job) this.resolveJob(job);
    } else if (job) {
      if (!task.running) task.requestNow();
    } else if (this.periodicEnabled) {
      task.schedule(0);
    }
  }

  /** Upgrade or join the single cleanup job with the current public cutoff. */
  runNow(): Promise<number> {
    const ttlMs = this.getSharedMemoryTtlMs();
    if (this.task.closed || this.stopping || ttlMs === 0) return Promise.resolve(0);
    const cutoffMs = Date.now() - ttlMs;
    let completion: ManualCompletion | undefined;
    let created = false;
    const job = this.task.updateJob((current) => {
      created = current === undefined;
      const owned = current ?? { cutoffMs, triplesDeleted: 0, inPass: false };
      if (owned.cutoffMs !== cutoffMs) {
        owned.cutoffMs = cutoffMs;
        owned.continuation = undefined;
      }
      if (!owned.manual) {
        // A queued continuation becomes a fresh public sweep. A physical pass
        // already in progress is joined and its mutations count toward the
        // manual result.
        if (!owned.inPass) {
          owned.continuation = undefined;
          owned.triplesDeleted = 0;
        }
        owned.manual = this.createManualCompletion();
      }
      completion = owned.manual;
      return owned;
    });
    if (!job || !completion) return Promise.resolve(0);
    if (created || !this.task.running) this.task.requestNow();
    return completion.promise;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.periodicEnabled = false;
    const task = this.task;
    const stopping = task.close().then(() => {
      const job = task.currentJob;
      if (job) this.resolveJob(job, task);
      if (this.stopping === stopping) this.stopping = undefined;
    });
    this.stopping = stopping;
    return stopping;
  }

  private createTask(): CoalescingRecurringTask<CleanupJob> {
    let task!: CoalescingRecurringTask<CleanupJob>;
    task = new CoalescingRecurringTask<CleanupJob>({
      retryIntervalMs: this.intervalMs,
      runPass: (signal, job) => this.runPass(task, signal, job),
      onError: () => undefined,
      beforePeriodicPass: () => this.preparePeriodicJob(task),
      closingMessage: 'SWM expiry cleanup is stopping',
    });
    return task;
  }

  private preparePeriodicJob(task: CoalescingRecurringTask<CleanupJob>): void {
    const ttlMs = this.getSharedMemoryTtlMs();
    if (ttlMs <= 0) return;
    const cutoffMs = Date.now() - ttlMs;
    task.updateJob((current) => {
      const job = current ?? { cutoffMs, triplesDeleted: 0, inPass: false };
      job.cutoffMs = cutoffMs;
      return job;
    });
  }

  private async runPass(
    task: CoalescingRecurringTask<CleanupJob>,
    signal: AbortSignal,
    job: CleanupJob | undefined,
  ) {
    // Keep admission cancellable when runNow() is immediately followed by stop().
    await Promise.resolve();
    if (!job || !this.owns(task, signal, job)) return 'idle' as const;
    const cutoffMs = job.cutoffMs;
    const continuation = job.continuation;
    job.continuation = undefined;
    let result: SwmExpiryCleanupResult;
    job.inPass = true;
    try {
      result = await this.processPass(
        { cutoffMs, continuation },
        () => !this.owns(task, signal, job),
      );
    } catch (error) {
      if (!this.owns(task, signal, job)) return 'idle' as const;
      task.retireJob(job);
      job.manual?.reject(error);
      throw error;
    } finally {
      job.inPass = false;
    }
    job.triplesDeleted += result.triplesDeleted;
    if (!this.owns(task, signal, job)) return 'idle' as const;

    const cutoffUnchanged = job.cutoffMs === cutoffMs;
    if (cutoffUnchanged) job.continuation = result.continuation;
    if (job.manual) {
      if (cutoffUnchanged && !job.continuation) {
        this.resolveJob(job, task);
        return this.periodicEnabled ? { rearmAfterMs: this.intervalMs } : 'idle' as const;
      }
      await setImmediate();
      if (this.owns(task, signal, job)) task.request();
      return 'idle' as const;
    }

    if (job.continuation) return { rearmAfterMs: 10 };
    task.retireJob(job);
    return this.periodicEnabled ? { rearmAfterMs: this.intervalMs } : 'idle' as const;
  }

  private owns(
    task: CoalescingRecurringTask<CleanupJob>,
    signal: AbortSignal,
    job: CleanupJob,
  ): boolean {
    return this.getSharedMemoryTtlMs() > 0
      && task.owns(signal)
      && task.currentJob === job;
  }

  private createManualCompletion(): ManualCompletion {
    let resolve!: (deleted: number) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  private resolveJob(
    job: CleanupJob,
    task: CoalescingRecurringTask<CleanupJob> = this.task,
  ): void {
    if (!task.retireJob(job)) return;
    job.manual?.resolve(job.triplesDeleted);
  }
}
