import { setImmediate } from 'node:timers/promises';
import { SWM_CLEANUP_INTERVAL_MS } from './dkg-agent-constants.js';
import { validateSharedMemoryTtlMs, type SwmExpiryCleanupResult } from './swm-expiry-cleanup.js';

/** One lifecycle timer, single-flight physical passes, and an awaited public drain. */
export class SwmExpiryCleanupWorker {
  private started = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<SwmExpiryCleanupResult> | undefined;
  private manualDrain: Promise<number> | undefined;
  private nextMetaGraph: string | undefined;

  constructor(
    private readonly processPass: (ttlMs: number, isClosed: () => boolean, nextMetaGraph?: string, cutoffMs?: number) => Promise<SwmExpiryCleanupResult>,
    private ttlMs: number,
    private readonly intervalMs = SWM_CLEANUP_INTERVAL_MS,
  ) { validateSharedMemoryTtlMs(ttlMs); }

  get running(): boolean { return this.started && !this.closed && this.ttlMs > 0; }

  start(): void {
    if (this.started) return;
    if (this.closed && (this.inFlight || this.manualDrain)) throw new Error('SWM expiry cleanup is still stopping');
    this.closed = false;
    this.started = true;
    this.schedule(0);
  }

  setTtl(ttlMs: number): void {
    validateSharedMemoryTtlMs(ttlMs);
    this.ttlMs = ttlMs;
    if (ttlMs === 0) this.clearTimer();
    else this.schedule(0);
  }

  /** Drain the requested backlog, yielding between bounded physical passes. */
  runNow(): Promise<number> {
    if (this.closed || this.ttlMs === 0) return Promise.resolve(0);
    if (this.manualDrain) return this.manualDrain;
    this.clearTimer();
    const cutoffMs = Date.now() - this.ttlMs;
    const run = this.drain(cutoffMs);
    this.manualDrain = run;
    const retire = () => {
      if (this.manualDrain === run) this.manualDrain = undefined;
      this.schedule(this.intervalMs);
    };
    void run.then(retire, retire);
    return run;
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.started = false;
    this.nextMetaGraph = undefined;
    this.clearTimer();
    await (this.manualDrain ?? this.inFlight)?.catch(() => undefined);
  }

  private async drain(cutoffMs: number): Promise<number> {
    let deleted = 0;
    let joinedEarlierPass = this.inFlight !== undefined;
    while (!this.closed && this.ttlMs > 0) {
      const result = await this.runPass(cutoffMs);
      deleted += result.triplesDeleted;
      // A joined periodic pass may have an older cutoff than this public call.
      if (!result.budgetExhausted && !joinedEarlierPass) break;
      joinedEarlierPass = false;
      // No detached continuation: stop joins this yield and every admitted pass.
      await setImmediate();
    }
    return deleted;
  }

  private runPass(cutoffMs?: number): Promise<SwmExpiryCleanupResult> {
    if (this.inFlight) return this.inFlight;
    const run = Promise.resolve().then((): SwmExpiryCleanupResult | Promise<SwmExpiryCleanupResult> => this.closed || this.ttlMs === 0
      ? { triplesDeleted: 0, budgetExhausted: false }
      : this.processPass(this.ttlMs, () => this.closed, this.nextMetaGraph, cutoffMs)
    ).then(result => {
      if (!this.closed) this.nextMetaGraph = result.nextMetaGraph;
      return result;
    });
    this.inFlight = run;
    const retire = () => { if (this.inFlight === run) this.inFlight = undefined; };
    void run.then(retire, retire);
    return run;
  }

  private schedule(delayMs: number): void {
    if (!this.running || this.timer || this.inFlight || this.manualDrain) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.running || this.manualDrain) return;
      void this.runPass().then(
        result => this.schedule(result.budgetExhausted ? 10 : this.intervalMs),
        () => this.schedule(this.intervalMs),
      );
    }, delayMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
