import { SWM_CLEANUP_INTERVAL_MS } from './dkg-agent-constants.js';
import type { SwmExpiryCleanupResult } from './swm-expiry-cleanup.js';

/** Own expiry scheduling, TTL, joined calls, continuation and physical retirement. */
export class SwmExpiryCleanupWorker {
  private started = false;
  private closed = false;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<number> | undefined;
  private nextMetaGraph: string | undefined;

  constructor(
    private readonly processPass: (ttlMs: number, isClosed: () => boolean, nextMetaGraph?: string) => Promise<SwmExpiryCleanupResult>,
    private ttlMs: number,
    private readonly intervalMs = SWM_CLEANUP_INTERVAL_MS,
  ) {}

  get running(): boolean { return this.timer !== undefined; }

  start(): void {
    if (this.started) return;
    if (this.closed && this.inFlight) throw new Error('SWM expiry cleanup is still stopping');
    this.closed = false;
    this.started = true;
    if (this.ttlMs > 0) this.startTimer();
  }

  setTtl(ttlMs: number): void {
    this.ttlMs = ttlMs;
    if (ttlMs <= 0) this.clearTimer();
    else if (this.started && !this.closed && !this.timer) this.startTimer();
  }

  runNow(): Promise<number> {
    if (this.closed || this.ttlMs <= 0) return Promise.resolve(0);
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const ttl = this.ttlMs;
    const run = Promise.resolve().then((): SwmExpiryCleanupResult | Promise<SwmExpiryCleanupResult> => this.closed || this.generation !== generation
      ? { triplesDeleted: 0 } : this.processPass(
      ttl,
      () => this.closed || this.generation !== generation,
      this.nextMetaGraph,
    )).then(result => {
      if (!this.closed && this.generation === generation) this.nextMetaGraph = result.nextMetaGraph;
      return result.triplesDeleted;
    });
    this.inFlight = run;
    const retire = () => { if (this.inFlight === run) this.inFlight = undefined; };
    void run.then(retire, retire);
    return run;
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.started = false;
    this.generation++;
    this.nextMetaGraph = undefined;
    this.clearTimer();
    await this.inFlight?.catch(() => undefined);
  }

  private startTimer(): void {
    this.timer = setInterval(() => { void this.runNow().catch(() => undefined); }, this.intervalMs);
    this.timer.unref?.();
    void this.runNow().catch(() => undefined);
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
