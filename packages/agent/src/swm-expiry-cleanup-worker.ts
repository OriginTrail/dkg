import { setImmediate } from 'node:timers/promises';
import { SWM_CLEANUP_INTERVAL_MS } from './dkg-agent-constants.js';
import { validateSharedMemoryTtlMs, type SwmExpiryCleanupContinuation, type SwmExpiryCleanupResult } from './swm-expiry-cleanup.js';
import type { SwmExpiryRuntimeSettings } from './swm-expiry-runtime-settings.js';

type MaintenanceMode = 'manual' | 'periodic';
type CleanupRequest = { readonly kind: 'periodic' } | { readonly kind: 'manual'; readonly cutoffMs: number };
interface CleanupFlight {
  request: CleanupRequest;
  readonly completion: Promise<number>;
  continuation?: SwmExpiryCleanupContinuation;
}
type WorkerState =
  | { readonly kind: 'idle'; readonly mode: MaintenanceMode }
  | { readonly kind: 'scheduled'; readonly timer: ReturnType<typeof setTimeout>; readonly continuation?: SwmExpiryCleanupContinuation }
  | { readonly kind: 'running'; readonly mode: MaintenanceMode; readonly flight: CleanupFlight }
  | { readonly kind: 'stopping'; readonly completion: Promise<void> }
  | { readonly kind: 'stopped' };

/** Each lifecycle state owns its timer or physical flight. Settings are shared with the agent. */
export class SwmExpiryCleanupWorker {
  private state: WorkerState = { kind: 'idle', mode: 'manual' };

  constructor(
    private readonly processPass: (ttlMs: number, isClosed: () => boolean, continuation?: SwmExpiryCleanupContinuation, cutoffMs?: number) => Promise<SwmExpiryCleanupResult>,
    private readonly settings: SwmExpiryRuntimeSettings,
    private readonly intervalMs = SWM_CLEANUP_INTERVAL_MS,
  ) { validateSharedMemoryTtlMs(this.ttlMs()); }

  private ttlMs(): number {
    return this.settings.getSharedMemoryTtlMs();
  }

  private updateTtlMs(ttlMs: number): void {
    this.settings.setSharedMemoryTtlMs(ttlMs);
  }

  get running(): boolean {
    return this.ttlMs() > 0 && (this.state.kind === 'scheduled'
      || ((this.state.kind === 'idle' || this.state.kind === 'running') && this.state.mode === 'periodic'));
  }

  start(): void {
    const state = this.state;
    if (state.kind === 'stopping') throw new Error('SWM expiry cleanup is still stopping');
    if (state.kind === 'scheduled') return;
    if (state.kind === 'running') { this.state = { ...state, mode: 'periodic' }; return; }
    this.state = { kind: 'idle', mode: 'periodic' };
    this.schedule(0);
  }

  setTtl(ttlMs: number): void {
    validateSharedMemoryTtlMs(ttlMs);
    this.updateTtlMs(ttlMs);
    if (ttlMs === 0) this.cancelScheduled();
    else this.schedule(0);
  }

  /** Join one owned flight; newer manual cutoffs are drained before it resolves. */
  runNow(): Promise<number> {
    const ttlMs = this.ttlMs();
    if (this.state.kind === 'stopping' || this.state.kind === 'stopped' || ttlMs === 0) return Promise.resolve(0);
    const cutoffMs = Date.now() - ttlMs;
    if (this.state.kind === 'running') {
      const flight = this.state.flight;
      const activeCutoff = flight.request.kind === 'manual'
        ? flight.request.cutoffMs
        : Number.NEGATIVE_INFINITY;
      if (cutoffMs > activeCutoff) {
        flight.request = { kind: 'manual', cutoffMs };
        flight.continuation = undefined;
      }
      return flight.completion;
    }
    this.cancelScheduled();
    return this.launch({ kind: 'manual', cutoffMs });
  }

  stop(): Promise<void> {
    const state = this.state;
    if (state.kind === 'stopping') return state.completion;
    if (state.kind !== 'running') {
      this.cancelScheduled();
      this.state = { kind: 'stopped' };
      return Promise.resolve();
    }
    const completion = state.flight.completion.catch(() => undefined).then(() => {
      this.state = { kind: 'stopped' };
    });
    this.state = { kind: 'stopping', completion };
    return completion;
  }

  private launch(request: CleanupRequest, continuation?: SwmExpiryCleanupContinuation): Promise<number> {
    if (this.state.kind !== 'idle') throw new Error('SWM expiry cleanup requires an idle worker');
    const flight: CleanupFlight = {
      request,
      continuation,
      completion: Promise.resolve().then(() => this.execute(flight)),
    };
    this.state = { kind: 'running', mode: this.state.mode, flight };
    return flight.completion;
  }

  private owns(flight: CleanupFlight): boolean {
    return this.state.kind === 'running' && this.state.flight === flight;
  }

  private async execute(flight: CleanupFlight): Promise<number> {
    let deleted = 0;
    try {
      while (this.owns(flight) && this.ttlMs() > 0) {
        const request = flight.request;
        const continuation = flight.continuation;
        flight.continuation = undefined;
        const result = await this.processPass(
          this.ttlMs(),
          () => !this.owns(flight) || this.ttlMs() === 0,
          continuation,
          request.kind === 'manual' ? request.cutoffMs : undefined);
        deleted += result.triplesDeleted;
        if (!this.owns(flight) || this.ttlMs() === 0) break;
        if (flight.request !== request) {
          await setImmediate();
          continue;
        }
        flight.continuation = result.continuation;
        if (request.kind === 'periodic') {
          break;
        }
        if (!flight.continuation) break;
        await setImmediate();
      }
      return deleted;
    } finally {
      // Retire before resolving completion: a late manual caller cannot join a
      // finished periodic flight that can no longer honor its newer cutoff.
      if (this.state.kind === 'running' && this.state.flight === flight) {
        this.state = { kind: 'idle', mode: this.state.mode };
        this.schedule(flight.continuation ? 10 : this.intervalMs, flight.continuation);
      }
    }
  }

  private schedule(delayMs: number, continuation?: SwmExpiryCleanupContinuation): void {
    if (this.state.kind !== 'idle' || this.state.mode !== 'periodic' || this.ttlMs() === 0) return;
    const scheduled: Extract<WorkerState, { kind: 'scheduled' }> = {
      kind: 'scheduled', continuation,
      timer: setTimeout(() => {
        if (this.state !== scheduled) return;
        this.state = { kind: 'idle', mode: 'periodic' };
        void this.launch({ kind: 'periodic' }, scheduled.continuation).catch(() => undefined);
      }, delayMs),
    };
    this.state = scheduled;
    scheduled.timer.unref?.();
  }

  private cancelScheduled(): void {
    if (this.state.kind !== 'scheduled') return;
    clearTimeout(this.state.timer);
    this.state = { kind: 'idle', mode: 'periodic' };
  }
}
