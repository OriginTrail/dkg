import { setImmediate } from 'node:timers/promises';
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

interface IdleState {
  readonly kind: 'idle';
}

interface ScheduledState {
  readonly kind: 'scheduled';
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RunningState {
  readonly kind: 'running';
  readonly mode: 'manual' | 'periodic';
  readonly generation: number;
  readonly cutoffMs: number;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly resolve: () => void;
  joinedManual?: ManualFlight;
}

interface StoppingState {
  readonly kind: 'stopping';
  readonly completion: Promise<void>;
}

interface StoppedState {
  readonly kind: 'stopped';
}

type WorkerState = IdleState | ScheduledState | RunningState | StoppingState | StoppedState;
type RunAction = 'none' | 'manual' | 'periodic-continuation' | 'periodic-interval';

/** One explicit owner for SWM cleanup admission, cancellation, and rearming. */
export class SwmExpiryCleanupWorker {
  private state: WorkerState = { kind: 'idle' };
  private periodicEnabled = false;
  private retentionGeneration = 0;
  private continuation?: SwmExpiryCleanupContinuation;
  private manualFlight?: ManualFlight;

  constructor(
    private readonly processPass: (
      request: SwmExpiryCleanupRequest,
      isClosed: () => boolean,
    ) => Promise<SwmExpiryCleanupResult>,
    private readonly getSharedMemoryTtlMs: () => number,
    private readonly intervalMs = SWM_CLEANUP_INTERVAL_MS,
  ) {}

  get running(): boolean {
    return this.periodicEnabled
      && this.getSharedMemoryTtlMs() > 0
      && (this.state.kind === 'running' || this.state.kind === 'scheduled');
  }

  start(): void {
    if (this.state.kind === 'stopping') {
      throw new Error('SWM expiry cleanup is still stopping');
    }
    if (this.state.kind === 'stopped') this.state = { kind: 'idle' };
    this.periodicEnabled = true;
    if (this.getSharedMemoryTtlMs() > 0 && this.state.kind === 'idle') {
      this.schedulePeriodic(0);
    }
  }

  /** Fence the old policy and do not return until its physical mutation retires. */
  async onTtlChanged(): Promise<void> {
    if (this.state.kind === 'stopped' || this.state.kind === 'stopping') return;
    const generation = ++this.retentionGeneration;
    const ttlMs = this.getSharedMemoryTtlMs();
    this.continuation = undefined;
    if (this.manualFlight && ttlMs > 0) {
      this.manualFlight.cutoffMs = Date.now() - ttlMs;
    }

    let active: RunningState | undefined;
    if (this.state.kind === 'scheduled') {
      clearTimeout(this.state.timer);
      this.state = { kind: 'idle' };
    } else if (this.state.kind === 'running') {
      active = this.state;
      active.controller.abort(this.abortError('SWM retention policy changed'));
    }
    await active?.completion;

    if (
      generation !== this.retentionGeneration
      || !this.isAvailable()
    ) return;
    if (ttlMs === 0) {
      this.resolveManualFlight();
      return;
    }
    if (this.manualFlight) this.launchManual();
    else if (this.periodicEnabled) this.schedulePeriodic(0);
  }

  /** Join one owned manual drain; newer calls refresh its cutoff. */
  runNow(): Promise<number> {
    const ttlMs = this.getSharedMemoryTtlMs();
    if (this.state.kind === 'stopped' || this.state.kind === 'stopping' || ttlMs === 0) {
      return Promise.resolve(0);
    }
    const cutoffMs = Date.now() - ttlMs;
    if (this.manualFlight) {
      if (cutoffMs !== this.manualFlight.cutoffMs) {
        this.manualFlight.cutoffMs = cutoffMs;
        this.continuation = undefined;
      }
      return this.manualFlight.completion;
    }

    let resolve!: (deleted: number) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
    const flight: ManualFlight = { cutoffMs, triplesDeleted: 0, completion, resolve, reject };
    this.manualFlight = flight;
    this.continuation = undefined;

    if (this.state.kind === 'scheduled') {
      clearTimeout(this.state.timer);
      this.state = { kind: 'idle' };
      this.launchManual();
    } else if (this.state.kind === 'running') {
      if (this.state.mode === 'periodic') this.state.joinedManual = flight;
    } else {
      this.launchManual();
    }
    return completion;
  }

  stop(): Promise<void> {
    if (this.state.kind === 'stopping') return this.state.completion;
    if (this.state.kind === 'stopped') return Promise.resolve();

    this.periodicEnabled = false;
    this.retentionGeneration++;
    this.continuation = undefined;
    let active: RunningState | undefined;
    if (this.state.kind === 'scheduled') {
      clearTimeout(this.state.timer);
    } else if (this.state.kind === 'running') {
      active = this.state;
      active.controller.abort(this.abortError('SWM expiry cleanup is stopping'));
    }

    let resolve!: () => void;
    const completion = new Promise<void>(yes => { resolve = yes; });
    const stopping: StoppingState = { kind: 'stopping', completion };
    this.state = stopping;
    void (async () => {
      await active?.completion;
      this.resolveManualFlight();
      if (this.state === stopping) this.state = { kind: 'stopped' };
      resolve();
    })();
    return completion;
  }

  private launchManual(): void {
    const flight = this.manualFlight;
    if (!flight || this.state.kind !== 'idle') return;
    this.launch('manual', flight.cutoffMs);
  }

  private launchPeriodic(): void {
    if (
      this.state.kind !== 'idle'
      || !this.periodicEnabled
      || this.getSharedMemoryTtlMs() === 0
    ) return;
    this.launch('periodic', Date.now() - this.getSharedMemoryTtlMs());
  }

  private launch(mode: RunningState['mode'], cutoffMs: number): void {
    let resolve!: () => void;
    const completion = new Promise<void>(yes => { resolve = yes; });
    const running: RunningState = {
      kind: 'running',
      mode,
      generation: this.retentionGeneration,
      cutoffMs,
      controller: new AbortController(),
      completion,
      resolve,
    };
    this.state = running;
    void this.execute(running);
  }

  private async execute(running: RunningState): Promise<void> {
    let action: RunAction = 'none';
    try {
      // Preserve a cancellable admission boundary: runNow() followed immediately
      // by stop() must retire before any storage request is dispatched.
      await Promise.resolve();
      if (!this.owns(running)) return;
      action = running.mode === 'manual'
        ? await this.runManualPasses(running)
        : await this.runPeriodicPass(running);
    } catch (error) {
      if (this.owns(running)) {
        if (running.mode === 'manual') {
          const flight = this.manualFlight;
          if (flight) {
            this.manualFlight = undefined;
            flight.reject(error);
          }
        } else if (running.joinedManual) {
          this.continuation = undefined;
          action = 'manual';
        }
        if (action === 'none' && this.periodicEnabled) action = 'periodic-interval';
      }
    } finally {
      if (this.state === running) {
        this.state = { kind: 'idle' };
        this.applyAction(action, running.generation);
      }
      running.resolve();
    }
  }

  private async runManualPasses(running: RunningState): Promise<RunAction> {
    const flight = this.manualFlight;
    if (!flight) return this.periodicEnabled ? 'periodic-interval' : 'none';
    while (this.owns(running) && this.manualFlight === flight) {
      const cutoffMs = flight.cutoffMs;
      const continuation = this.continuation;
      this.continuation = undefined;
      const result = await this.processPass(
        { cutoffMs, continuation },
        () => !this.owns(running),
      );
      flight.triplesDeleted += result.triplesDeleted;
      if (!this.owns(running) || this.manualFlight !== flight) return 'none';
      if (flight.cutoffMs !== cutoffMs) continue;
      this.continuation = result.continuation;
      if (!this.continuation) {
        this.resolveManualFlight(flight);
        return this.periodicEnabled ? 'periodic-interval' : 'none';
      }
      await setImmediate();
    }
    return 'none';
  }

  private async runPeriodicPass(running: RunningState): Promise<RunAction> {
    const continuation = this.continuation;
    this.continuation = undefined;
    const result = await this.processPass(
      { cutoffMs: running.cutoffMs, continuation },
      () => !this.owns(running),
    );
    const joined = running.joinedManual;
    if (joined && this.manualFlight === joined) joined.triplesDeleted += result.triplesDeleted;
    if (!this.owns(running)) return 'none';
    this.continuation = result.continuation;
    if (joined && this.manualFlight === joined) {
      if (joined.cutoffMs !== running.cutoffMs) this.continuation = undefined;
      if (this.continuation || joined.cutoffMs !== running.cutoffMs) return 'manual';
      this.resolveManualFlight(joined);
      return this.periodicEnabled ? 'periodic-interval' : 'none';
    }
    if (!this.periodicEnabled) return 'none';
    return this.continuation ? 'periodic-continuation' : 'periodic-interval';
  }

  private applyAction(action: RunAction, generation: number): void {
    if (
      generation !== this.retentionGeneration
      || this.state.kind !== 'idle'
      || this.getSharedMemoryTtlMs() === 0
    ) return;
    if (action === 'manual' && this.manualFlight) {
      this.launchManual();
    } else if (action === 'periodic-continuation' && this.periodicEnabled) {
      this.schedulePeriodic(10);
    } else if (action === 'periodic-interval' && this.periodicEnabled) {
      this.schedulePeriodic(this.intervalMs);
    }
  }

  private schedulePeriodic(delayMs: number): void {
    if (
      this.state.kind !== 'idle'
      || !this.periodicEnabled
      || this.getSharedMemoryTtlMs() === 0
    ) return;
    const timer = setTimeout(() => {
      if (this.state.kind !== 'scheduled' || this.state.timer !== timer) return;
      this.state = { kind: 'idle' };
      if (this.manualFlight) this.launchManual();
      else this.launchPeriodic();
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.state = { kind: 'scheduled', timer };
  }

  private owns(running: RunningState): boolean {
    return this.state === running
      && running.generation === this.retentionGeneration
      && !running.controller.signal.aborted
      && this.getSharedMemoryTtlMs() > 0;
  }

  private resolveManualFlight(expected = this.manualFlight): void {
    if (!expected || this.manualFlight !== expected) return;
    this.manualFlight = undefined;
    expected.resolve(expected.triplesDeleted);
  }

  private abortError(message: string): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }

  private isAvailable(): boolean {
    return this.state.kind !== 'stopped' && this.state.kind !== 'stopping';
  }
}
