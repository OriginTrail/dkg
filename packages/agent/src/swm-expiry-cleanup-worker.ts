import { setImmediate } from 'node:timers/promises';
import { CoalescingRecurringTask } from '@origintrail-official/dkg-core';
import { SWM_CLEANUP_INTERVAL_MS } from './dkg-agent-constants.js';
import type {
  SwmExpiryCleanupContinuation,
  SwmExpiryCleanupRequest,
  SwmExpiryCleanupResult,
} from './swm-expiry-cleanup.js';

interface ManualFlight {
  cutoffMs: number;
  triplesDeleted: number;
  readonly completion: Promise<number>;
  readonly resolve: (deleted: number) => void;
  readonly reject: (error: unknown) => void;
}

interface ActivePeriodicPass {
  readonly cutoffMs: number;
  joined?: ManualFlight;
}

/** SWM cutoff, continuation, and result policy over the canonical task owner. */
export class SwmExpiryCleanupWorker {
  private task: CoalescingRecurringTask;
  private periodicEnabled = false;
  private continuation?: SwmExpiryCleanupContinuation;
  private manualFlight?: ManualFlight;
  private activePeriodic?: ActivePeriodicPass;
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
    this.continuation = undefined;
    const ttlMs = this.getSharedMemoryTtlMs();
    if (this.manualFlight && ttlMs > 0) this.manualFlight.cutoffMs = Date.now() - ttlMs;
    await task.cancelAndDrain('SWM retention policy changed');
    if (task !== this.task || task.closed || this.stopping) return;

    const currentTtlMs = this.getSharedMemoryTtlMs();
    if (currentTtlMs === 0) {
      this.resolveManualFlight();
    } else if (this.manualFlight) {
      if (!task.running) task.requestNow();
    } else if (this.periodicEnabled) {
      task.schedule(0);
    }
  }

  /** Join one owned manual drain; newer calls refresh its cutoff. */
  runNow(): Promise<number> {
    const ttlMs = this.getSharedMemoryTtlMs();
    if (this.task.closed || this.stopping || ttlMs === 0) return Promise.resolve(0);
    const cutoffMs = Date.now() - ttlMs;
    if (this.manualFlight) {
      if (cutoffMs !== this.manualFlight.cutoffMs) {
        this.manualFlight.cutoffMs = cutoffMs;
        this.continuation = undefined;
      }
      if (!this.task.running) this.task.requestNow();
      return this.manualFlight.completion;
    }

    let resolve!: (deleted: number) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
    const flight: ManualFlight = { cutoffMs, triplesDeleted: 0, completion, resolve, reject };
    this.manualFlight = flight;
    this.continuation = undefined;
    if (this.activePeriodic) this.activePeriodic.joined = flight;
    else this.task.requestNow();
    return completion;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.periodicEnabled = false;
    this.continuation = undefined;
    const task = this.task;
    const stopping = task.close().then(() => {
      this.resolveManualFlight();
      if (this.stopping === stopping) this.stopping = undefined;
    });
    this.stopping = stopping;
    return stopping;
  }

  private createTask(): CoalescingRecurringTask {
    return new CoalescingRecurringTask({
      retryIntervalMs: this.intervalMs,
      runPass: signal => this.runPass(signal),
      onError: () => undefined,
      closingMessage: 'SWM expiry cleanup is stopping',
    });
  }

  private async runPass(signal: AbortSignal) {
    // Keep admission cancellable when runNow() is immediately followed by stop().
    await Promise.resolve();
    if (!this.owns(signal)) return 'idle' as const;
    const manual = this.manualFlight;
    try {
      if (manual) await this.runManualPasses(manual, signal);
      else await this.runPeriodicPass(signal);
    } catch (error) {
      if (!this.task.owns(signal)) return 'idle' as const;
      if (manual && this.manualFlight === manual) {
        this.manualFlight = undefined;
        manual.reject(error);
      }
      throw error;
    }
    if (!this.owns(signal) || this.manualFlight || !this.periodicEnabled) return 'idle' as const;
    return { rearmAfterMs: this.continuation ? 10 : this.intervalMs };
  }

  private async runManualPasses(flight: ManualFlight, signal: AbortSignal): Promise<void> {
    while (this.owns(signal) && this.manualFlight === flight) {
      const cutoffMs = flight.cutoffMs;
      const continuation = this.continuation;
      this.continuation = undefined;
      const result = await this.processPass(
        { cutoffMs, continuation },
        () => !this.owns(signal),
      );
      flight.triplesDeleted += result.triplesDeleted;
      if (!this.owns(signal) || this.manualFlight !== flight) return;
      if (flight.cutoffMs !== cutoffMs) continue;
      this.continuation = result.continuation;
      if (!this.continuation) {
        this.resolveManualFlight(flight);
        return;
      }
      await setImmediate();
    }
  }

  private async runPeriodicPass(signal: AbortSignal): Promise<void> {
    const cutoffMs = Date.now() - this.getSharedMemoryTtlMs();
    const active: ActivePeriodicPass = { cutoffMs };
    this.activePeriodic = active;
    const continuation = this.continuation;
    this.continuation = undefined;
    try {
      const result = await this.processPass(
        { cutoffMs, continuation },
        () => !this.owns(signal),
      );
      const joined = active.joined;
      if (joined && this.manualFlight === joined) joined.triplesDeleted += result.triplesDeleted;
      if (!this.owns(signal)) return;
      this.continuation = result.continuation;
      if (joined && this.manualFlight === joined) {
        if (joined.cutoffMs !== cutoffMs) this.continuation = undefined;
        if (!this.continuation && joined.cutoffMs === cutoffMs) {
          this.resolveManualFlight(joined);
        } else {
          // The joined pass did not satisfy the manual request. Admit exactly
          // one follow-up through the scheduler's ordinary request boundary.
          this.task.requestNow();
        }
      }
    } finally {
      if (this.activePeriodic === active) this.activePeriodic = undefined;
    }
  }

  private owns(signal: AbortSignal): boolean {
    return this.getSharedMemoryTtlMs() > 0 && this.task.owns(signal);
  }

  private resolveManualFlight(expected = this.manualFlight): void {
    if (!expected || this.manualFlight !== expected) return;
    this.manualFlight = undefined;
    expected.resolve(expected.triplesDeleted);
  }
}
