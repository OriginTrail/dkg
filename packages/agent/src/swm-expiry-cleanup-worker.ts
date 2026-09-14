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

/** SWM-specific request/result adapter over the canonical recurring-task owner. */
export class SwmExpiryCleanupWorker {
  private task: CoalescingRecurringTask;
  private periodicEnabled = false;
  private available = true;
  private retentionGeneration = 0;
  private continuation?: SwmExpiryCleanupContinuation;
  private manualFlight?: ManualFlight;
  private activeMode?: 'manual' | 'periodic';
  private activePeriodicJoin?: ManualFlight;
  private stopping?: Promise<void>;
  private ttlChangeTail = Promise.resolve();

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
      && this.available
      && this.getSharedMemoryTtlMs() > 0
      && (this.task.running || this.task.scheduled);
  }

  start(): void {
    if (this.stopping) throw new Error('SWM expiry cleanup is still stopping');
    if (!this.available) {
      this.task = this.createTask();
      this.available = true;
    }
    this.periodicEnabled = true;
    if (this.getSharedMemoryTtlMs() > 0) this.task.schedule(0);
  }

  /** Fence the old policy and do not return until its physical mutation retires. */
  onTtlChanged(): Promise<void> {
    const generation = ++this.retentionGeneration;
    const ttlMs = this.getSharedMemoryTtlMs();
    this.continuation = undefined;
    if (this.manualFlight && ttlMs > 0) {
      this.manualFlight.cutoffMs = Date.now() - ttlMs;
    }
    const previous = this.ttlChangeTail;
    const change = previous.catch(() => undefined).then(async () => {
      if (!this.available) return;
      await this.task.cancelAndDrain('SWM retention policy changed');
      if (!this.available || generation !== this.retentionGeneration) return;
      if (ttlMs === 0) {
        this.resolveManualFlight();
        return;
      }
      if (this.manualFlight) this.task.requestNow();
      else if (this.periodicEnabled) this.task.schedule(0);
    });
    this.ttlChangeTail = change;
    return change;
  }

  /** Join one owned manual drain; newer calls refresh its cutoff. */
  runNow(): Promise<number> {
    const ttlMs = this.getSharedMemoryTtlMs();
    if (!this.available || this.stopping || ttlMs === 0) return Promise.resolve(0);
    const cutoffMs = Date.now() - ttlMs;
    if (this.manualFlight) {
      if (cutoffMs !== this.manualFlight.cutoffMs) {
        this.manualFlight.cutoffMs = cutoffMs;
        this.continuation = undefined;
        this.task.requestNow();
      }
      return this.manualFlight.completion;
    }
    let resolve!: (deleted: number) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
    const flight: ManualFlight = { cutoffMs, triplesDeleted: 0, completion, resolve, reject };
    this.manualFlight = flight;
    this.continuation = undefined;
    if (this.task.running && this.activeMode === 'periodic') this.activePeriodicJoin = flight;
    this.task.requestNow();
    return completion;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.periodicEnabled = false;
    this.available = false;
    this.retentionGeneration++;
    this.continuation = undefined;
    const stopping = this.task.close().then(() => {
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
    // Preserve a cancellable admission boundary: runNow() followed immediately
    // by stop() must retire before any storage request is dispatched.
    await Promise.resolve();
    if (!this.available || this.getSharedMemoryTtlMs() === 0) return 'idle' as const;
    const generation = this.retentionGeneration;
    const manual = this.manualFlight;
    const mode = manual ? 'manual' : 'periodic';
    this.activeMode = mode;
    try {
      if (manual) {
        await this.runManualPasses(manual, signal, generation);
      } else {
        await this.runPeriodicPass(signal, generation);
      }
    } catch (error) {
      if (manual && this.manualFlight === manual && this.task.owns(signal)) {
        this.manualFlight = undefined;
        manual.reject(error);
      }
      throw error;
    } finally {
      if (this.activeMode === mode) this.activeMode = undefined;
      if (mode === 'periodic') this.activePeriodicJoin = undefined;
    }
    if (!this.available || this.getSharedMemoryTtlMs() === 0 || signal.aborted) {
      return 'idle' as const;
    }
    if (this.manualFlight) return 'idle' as const;
    if (!this.periodicEnabled) return 'idle' as const;
    return { rearmAfterMs: this.continuation ? 10 : this.intervalMs };
  }

  private async runManualPasses(
    flight: ManualFlight,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    while (this.owns(signal, generation) && this.manualFlight === flight) {
      const cutoffMs = flight.cutoffMs;
      const continuation = this.continuation;
      this.continuation = undefined;
      const result = await this.processPass(
        { cutoffMs, continuation },
        () => !this.owns(signal, generation),
      );
      flight.triplesDeleted += result.triplesDeleted;
      if (!this.owns(signal, generation) || this.manualFlight !== flight) return;
      if (flight.cutoffMs !== cutoffMs) continue;
      this.continuation = result.continuation;
      if (!this.continuation) {
        this.resolveManualFlight(flight);
        return;
      }
      await setImmediate();
    }
  }

  private async runPeriodicPass(signal: AbortSignal, generation: number): Promise<void> {
    const continuation = this.continuation;
    this.continuation = undefined;
    const result = await this.processPass(
      { cutoffMs: Date.now() - this.getSharedMemoryTtlMs(), continuation },
      () => !this.owns(signal, generation),
    );
    const joined = this.activePeriodicJoin;
    if (joined && this.manualFlight === joined) joined.triplesDeleted += result.triplesDeleted;
    if (this.owns(signal, generation)) this.continuation = result.continuation;
  }

  private owns(signal: AbortSignal, generation: number): boolean {
    return this.available
      && this.getSharedMemoryTtlMs() > 0
      && generation === this.retentionGeneration
      && this.task.owns(signal);
  }

  private resolveManualFlight(expected = this.manualFlight): void {
    if (!expected || this.manualFlight !== expected) return;
    this.manualFlight = undefined;
    expected.resolve(expected.triplesDeleted);
  }
}
