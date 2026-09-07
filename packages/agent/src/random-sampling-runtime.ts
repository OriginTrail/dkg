import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import {
  waitForRandomSamplingShutdownWithin,
  type AgentRole,
  type RandomSamplingDisabledReason,
  type RandomSamplingHandle,
  type RandomSamplingStatus,
} from './random-sampling-bind.js';
import { RANDOM_SAMPLING_BIND_RETRY_MS } from './dkg-agent-constants.js';
import type { RandomSamplingStartResult } from './dkg-agent-types.js';

type Eligibility =
  | { kind: 'eligible'; identityId: bigint }
  | { kind: 'unavailable'; identityId: bigint; reason: RandomSamplingDisabledReason; retryable: boolean }
  | { kind: 'transient'; reason: RandomSamplingDisabledReason; identityId?: bigint };
type State =
  | { kind: 'stopped'; identityId: bigint }
  | { kind: 'waiting'; identityId: bigint; reason: RandomSamplingDisabledReason }
  | { kind: 'binding'; identityId: bigint }
  | { kind: 'running'; identityId: bigint; handle: RandomSamplingHandle }
  | { kind: 'retiring'; identityId: bigint; handle: RandomSamplingHandle; close: Promise<void> };

export interface RandomSamplingRuntimeOptions {
  role: AgentRole;
  chain: Pick<ChainAdapter, 'chainId' | 'getIdentityId' | 'isRandomSamplingReady' | 'isShardingTableMember'>;
  createHandle(identityId: bigint): Promise<RandomSamplingHandle>;
  log: { info(message: string): void; warn(message: string): void };
  shutdownTimeoutMs(): number;
}

/** One node lifetime owns eligibility, reconciliation, binding and physical retirement. */
export class RandomSamplingRuntime {
  private state: State = { kind: 'waiting', identityId: 0n, reason: 'not_started' };
  private readonly lifecycle = new AbortController();
  private inFlight: Promise<RandomSamplingStartResult> | null = null;
  private shutdownDrain: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: RandomSamplingRuntimeOptions) {}

  async start(): Promise<RandomSamplingStartResult> {
    const result = await this.reconcile();
    if (result !== 'disabled' && !this.lifecycle.signal.aborted && !this.timer) {
      this.timer = setInterval(() => {
        void this.reconcile().catch((error: unknown) => this.options.log.warn(
          `V10 Random Sampling reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }, RANDOM_SAMPLING_BIND_RETRY_MS);
      this.timer.unref?.();
    }
    return result;
  }

  reconcile(): Promise<RandomSamplingStartResult> {
    if (this.lifecycle.signal.aborted) return Promise.resolve('disabled');
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.reconcileOnce().then((result) => {
      if (result === 'disabled') this.clearTimer();
      return result;
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
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
      disabledReason: retiring ? 'retiring' : state.kind === 'waiting' ? state.reason : 'not_started',
      loop: retiring ? state.handle.getStatus().loop : null,
    };
  }

  getLifecycleSnapshot() {
    return { phase: this.state.kind, reconciliationScheduled: this.timer !== null, reconciliationInFlight: this.inFlight !== null };
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private beginRetirement(handle: RandomSamplingHandle, identityId: bigint): Extract<State, { kind: 'retiring' }> {
    const state: Extract<State, { kind: 'retiring' }> = {
      kind: 'retiring', identityId, handle, close: Promise.resolve().then(() => handle.stop()),
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

  private async resolveEligibility(): Promise<Eligibility> {
    const { role, chain, log } = this.options;
    const unavailable = (identityId: bigint, reason: RandomSamplingDisabledReason, retryable: boolean): Eligibility =>
      ({ kind: 'unavailable', identityId, reason, retryable });
    if (role !== 'core') return unavailable(0n, 'edge_node', false);
    if (chain.chainId === 'none') return unavailable(0n, 'unsupported_chain', false);
    let identityId: bigint;
    try { identityId = await chain.getIdentityId(); }
    catch (error) {
      log.warn(`V10 Random Sampling identity lookup failed; will retry: ${String(error)}`);
      return { kind: 'transient', reason: 'identity_lookup_failed' };
    }
    if (this.lifecycle.signal.aborted) return unavailable(identityId, 'not_started', false);
    if (identityId === 0n) return unavailable(identityId, 'no_identity', true);
    try {
      if (chain.isRandomSamplingReady && !chain.isRandomSamplingReady()) {
        return unavailable(identityId, 'contracts_not_deployed', false);
      }
    } catch (error) {
      log.warn(`V10 Random Sampling readiness probe failed; will retry: ${String(error)}`);
      return { kind: 'transient', reason: 'bind_failed', identityId };
    }
    if (!chain.isShardingTableMember) return unavailable(identityId, 'unsupported_chain', false);
    try {
      return await chain.isShardingTableMember(identityId)
        ? { kind: 'eligible', identityId }
        : unavailable(identityId, 'awaiting_sharding_table', true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`V10 Random Sampling eligibility lookup failed; will retry: ${message}`);
      if (this.state.kind !== 'running' && message.includes('ShardingTableStorage')
        && (message.includes('not found in Hub') || message.includes('not resolvable'))) {
        return unavailable(identityId, 'contracts_not_deployed', false);
      }
      return { kind: 'transient', reason: 'eligibility_lookup_failed', identityId };
    }
  }

  private async reconcileOnce(): Promise<RandomSamplingStartResult> {
    const { signal } = this.lifecycle;
    try {
      // A retired handle cannot be reused even if admission has since returned.
      if (this.state.kind === 'retiring') await this.finishRetirement(true);
      if (signal.aborted) return 'disabled';
      const eligibility = await this.resolveEligibility();
      if (signal.aborted) return 'disabled';
      if (eligibility.kind === 'transient') {
        if (this.state.kind === 'running') return 'started';
        this.state = { kind: 'waiting', identityId: eligibility.identityId ?? this.state.identityId, reason: eligibility.reason };
        return 'retryable';
      }
      if (this.state.kind === 'running') {
        if (eligibility.kind === 'eligible' && eligibility.identityId === this.state.identityId) return 'started';
        await this.finishRetirement(true);
        if (signal.aborted) return 'disabled';
      }
      if (eligibility.kind === 'unavailable') {
        this.state = { kind: 'waiting', identityId: eligibility.identityId, reason: eligibility.reason };
        return eligibility.retryable ? 'retryable' : 'disabled';
      }
      const { identityId } = eligibility;
      this.state = { kind: 'binding', identityId };
      const handle = await this.options.createHandle(identityId);
      if (signal.aborted || !handle.enabled) {
        this.beginRetirement(handle, identityId);
        await this.finishRetirement(false);
        if (!signal.aborted) this.state = {
          kind: 'waiting', identityId, reason: handle.getStatus().disabledReason ?? 'bind_failed',
        };
        return 'disabled';
      }
      this.state = { kind: 'running', identityId, handle };
      try { handle.start(); }
      catch (error) {
        this.beginRetirement(handle, identityId);
        await this.finishRetirement(true);
        throw error;
      }
      this.options.log.info(`V10 Random Sampling prover started (identityId=${identityId})`);
      return 'started';
    } catch (error) {
      if (signal.aborted && this.state.kind === 'binding') {
        // Failed construction returned no handle; there is no acquired resource to retire.
        this.state = { kind: 'stopped', identityId: this.state.identityId };
        return 'disabled';
      }
      if (signal.aborted) throw error;
      this.options.log.warn(`V10 Random Sampling reconciliation will retry: ${String(error)}`);
      if (this.state.kind === 'binding' || this.state.kind === 'waiting') this.state = {
        kind: 'waiting', identityId: this.state.identityId, reason: 'bind_failed',
      };
      return 'retryable';
    }
  }
}
