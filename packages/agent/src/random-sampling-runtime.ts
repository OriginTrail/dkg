import {
  waitForRandomSamplingShutdownWithin,
  type AgentRole,
  type RandomSamplingDisabledReason,
  type RandomSamplingBindingResult,
  type RandomSamplingHandle,
  type RandomSamplingStatus,
} from './random-sampling-bind.js';
import { RANDOM_SAMPLING_BIND_RETRY_MS } from './dkg-agent-constants.js';
import { type RandomSamplingEligibility, type RandomSamplingUnavailable } from './random-sampling-eligibility.js';

type State =
  | { kind: 'stopped'; identityId: bigint }
  | { kind: 'waiting' | 'disabled'; identityId: bigint; reason: RandomSamplingDisabledReason }
  | { kind: 'binding'; identityId: bigint }
  | { kind: 'running'; identityId: bigint; handle: RandomSamplingHandle }
  | { kind: 'retiring'; identityId: bigint; handle: RandomSamplingHandle; close: Promise<void> };

export interface RandomSamplingRuntimeOptions {
  role: AgentRole;
  resolveEligibility(): Promise<RandomSamplingEligibility>;
  createHandle(identityId: bigint): Promise<RandomSamplingBindingResult>;
  log: { info(message: string): void; warn(message: string): void };
  shutdownTimeoutMs(): number;
}

/** One node lifetime owns eligibility, reconciliation, binding and physical retirement. */
export class RandomSamplingRuntime {
  private state: State = { kind: 'waiting', identityId: 0n, reason: 'not_started' };
  private readonly lifecycle = new AbortController();
  private inFlight: Promise<void> | null = null;
  private shutdownDrain: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Explicit lifecycle history: a later deployment miss is retryable after one observed deployment. */
  private deploymentObserved = false;

  constructor(private readonly options: RandomSamplingRuntimeOptions) {}

  start(): Promise<void> {
    return this.reconcile();
  }

  reconcile(): Promise<void> {
    if (this.lifecycle.signal.aborted || this.state.kind === 'disabled') return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.reconcileOnce().finally(() => {
      this.inFlight = null;
      this.updateTimer();
    });
    return this.inFlight;
  }

  private updateTimer(): void {
    if (this.lifecycle.signal.aborted || this.state.kind === 'disabled' || this.state.kind === 'stopped') {
      this.clearTimer();
    } else if (!this.timer) {
      this.timer = setInterval(() => {
        void this.reconcile().catch((error: unknown) => this.options.log.warn(
          `V10 Random Sampling reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }, RANDOM_SAMPLING_BIND_RETRY_MS);
      this.timer.unref?.();
    }
  }

  /** Fence synchronously before the agent starts awaiting other shutdown work. */
  cancel(): void {
    this.lifecycle.abort();
    this.clearTimer();
  }

  stop(): Promise<void> {
    this.cancel();
    this.shutdownDrain ??= this.drain();
    return waitForRandomSamplingShutdownWithin(this.shutdownDrain, this.options.shutdownTimeoutMs());
  }

  getStatus(): RandomSamplingStatus {
    const state = this.state;
    if (state.kind === 'running' && !this.lifecycle.signal.aborted) return state.handle.getStatus();
    const retiring = state.kind === 'retiring' || (state.kind === 'running' && this.lifecycle.signal.aborted);
    return {
      enabled: false, role: this.options.role, identityId: state.identityId.toString(),
      disabledReason: retiring ? 'retiring' : (state.kind === 'waiting' || state.kind === 'disabled') ? state.reason : 'not_started',
      loop: retiring ? state.handle.getStatus().loop : null,
    };
  }

  getLifecycleSnapshot() {
    return {
      phase: this.state.kind,
      reconciliationScheduled: this.timer !== null,
      reconciliationInFlight: this.inFlight !== null,
      deploymentObserved: this.deploymentObserved,
    };
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private beginRetirement(handle: RandomSamplingHandle, identityId: bigint): Extract<State, { kind: 'retiring' }> {
    const state: Extract<State, { kind: 'retiring' }> = {
      kind: 'retiring', identityId, handle,
      close: Promise.resolve().then(() => handle.stop()).catch((error: unknown) => {
        // A settled rejection has no outstanding physical work. Log the failed
        // cleanup and release ownership; a timeout still retains this promise
        // until it settles and therefore cannot release dependencies early.
        this.options.log.warn(`V10 Random Sampling cleanup failed: ${String(error)}`);
      }),
    };
    this.state = state;
    return state;
  }

  private async finishRetirement(bounded: boolean): Promise<void> {
    if (this.state.kind === 'running') this.beginRetirement(this.state.handle, this.state.identityId);
    if (this.state.kind !== 'retiring') return;
    const retiring = this.state;
    if (bounded) await waitForRandomSamplingShutdownWithin(retiring.close, this.options.shutdownTimeoutMs());
    else await retiring.close;
    this.state = { kind: 'waiting', identityId: retiring.identityId, reason: 'not_started' };
  }

  private async drain(): Promise<void> {
    // A bind may own a WAL before it has returned a handle. Joining the task
    // also joins cleanup of any unused handle it creates after cancellation.
    await this.inFlight;
    await this.finishRetirement(false);
    this.state = { kind: 'stopped', identityId: this.state.identityId };
  }

  private recordUnavailable(eligibility: RandomSamplingUnavailable): void {
    if (eligibility.reason === 'awaiting_sharding_table') this.deploymentObserved = true;
    const terminal = eligibility.reason === 'edge_node'
      || eligibility.reason === 'unsupported_chain'
      || (eligibility.reason === 'contracts_not_deployed' && !this.deploymentObserved);
    this.state = { kind: terminal ? 'disabled' : 'waiting', identityId: eligibility.identityId, reason: eligibility.reason };
  }

  private async reconcileOnce(): Promise<void> {
    const { signal } = this.lifecycle;
    try {
      // A retired handle cannot be reused even if admission has since returned.
      if (this.state.kind === 'retiring') await this.finishRetirement(true);
      if (signal.aborted) return;
      const eligibility = await this.options.resolveEligibility();
      if (signal.aborted) return;
      if (eligibility.kind === 'indeterminate') {
        if (this.state.kind === 'running') return;
        this.state = { kind: 'waiting', identityId: eligibility.identityId ?? this.state.identityId, reason: eligibility.reason };
        return;
      }
      if (this.state.kind === 'running') {
        if (eligibility.kind === 'eligible' && eligibility.identityId === this.state.identityId) return;
        await this.finishRetirement(true);
        if (signal.aborted) return;
      }
      if (eligibility.kind !== 'eligible') {
        this.recordUnavailable(eligibility);
        return;
      }
      const { identityId } = eligibility;
      this.deploymentObserved = true;
      this.state = { kind: 'binding', identityId };
      const binding = await this.options.createHandle(identityId);
      if (binding.kind === 'unavailable') {
        if (binding.handleToClose) {
          this.beginRetirement(binding.handleToClose, identityId);
          await this.finishRetirement(false);
        }
        if (!signal.aborted) this.state = {
          kind: binding.retry === 'poll' ? 'waiting' : 'disabled',
          identityId,
          reason: binding.reason,
        };
        return;
      }
      const { handle } = binding;
      if (signal.aborted) {
        this.beginRetirement(handle, identityId);
        await this.finishRetirement(false);
        return;
      }
      this.state = { kind: 'running', identityId, handle };
      try { handle.start(); }
      catch (error) {
        this.beginRetirement(handle, identityId);
        await this.finishRetirement(true);
        throw error;
      }
      this.options.log.info(`V10 Random Sampling prover started (identityId=${identityId})`);
      return;
    } catch (error) {
      if (signal.aborted && this.state.kind === 'binding') {
        // Failed construction returned no handle; there is no acquired resource to retire.
        this.state = { kind: 'stopped', identityId: this.state.identityId };
        return;
      }
      // Shutdown drains the retained physical close even when this bounded
      // reconciliation wait expires after cancellation.
      if (signal.aborted) return;
      this.options.log.warn(`V10 Random Sampling reconciliation will retry: ${String(error)}`);
      if (this.state.kind === 'binding' || this.state.kind === 'waiting') this.state = {
        kind: 'waiting', identityId: this.state.identityId, reason: 'bind_failed',
      };
      return;
    }
  }
}
