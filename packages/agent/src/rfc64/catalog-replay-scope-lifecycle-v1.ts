// SPDX-License-Identifier: Apache-2.0
import type { Rfc64CatalogConnectionReplayResultV1 } from './catalog-replay-types-v1.js';

/** Adapter-owned custody; lifecycle scheduling is independent of receiving/serving policy. */
export interface Rfc64CatalogConnectionCustodyV1 {
  isCurrent(): boolean;
  release(): void;
  replay(signal: AbortSignal): Promise<Rfc64CatalogConnectionReplayResultV1>;
}
type FenceV1 = Rfc64CatalogConnectionCustodyV1;
type PhaseV1 =
  | Readonly<{ state: 'awaiting-admission'; lease: FenceV1 | null; deferred?: Readonly<{ release(): void }> }>
  | Readonly<{ state: 'waiting-for-fence'; deferred?: Readonly<{ release(): void }> }>
  | Readonly<{ state: 'queued' | 'executing'; lease: FenceV1 }>
  | Readonly<{ state: 'retired' }>;
interface DemandV1 { readonly connectionGeneration: number; readonly selectionGeneration: number; phase: PhaseV1 }
export interface Rfc64CatalogReplayScopeAdmissionV1 { admit(): void; reject(): void }
declare const executionBrand: unique symbol;
export interface Rfc64CatalogReplayScopeExecutionV1 { readonly [executionBrand]: true }

/** Owns demand, admission and cooldown independently of fence availability. */
export class Rfc64CatalogReplayScopeLifecycleV1 {
  #selection: Readonly<{ state: 'selected' | 'retired'; generation: number }> = { state: 'selected', generation: 0 };
  #current: DemandV1 | null = null;
  #successor: DemandV1 | null = null;
  #execution: Rfc64CatalogReplayScopeExecutionV1 | null = null;
  #failures = 0;
  #eligibleAt = 0;
  constructor(readonly contextGraphId: string, readonly peerId: string, readonly debounceMs: number) {}

  get outstanding(): number { return Number(this.#current !== null) + Number(this.#successor !== null); }
  get executing(): boolean { return this.#current?.phase.state === 'executing'; }
  get eligibleAt(): number { return this.#eligibleAt; }
  get queued(): boolean { return this.#current?.phase.state === 'queued'; }
  ready(now: number): boolean { return this.queued && this.#eligibleAt <= now; }
  awaitingFence(): boolean {
    return this.#current?.phase.state === 'waiting-for-fence';
  }
  reserve(connectionGeneration: number, reserveFence: () => FenceV1 | null,
    reserveDeferred: () => Readonly<{ release(): void }> | null): Rfc64CatalogReplayScopeAdmissionV1 | null {
    const current = this.#current;
    if (current !== null && ((current.connectionGeneration === connectionGeneration
      && current.selectionGeneration === this.#selection.generation) || this.#successor !== null
      || current.phase.state === 'queued' || current.phase.state === 'waiting-for-fence')) return null;
    // Transfer an unsampled fence to a fresh stable token. Old admission callbacks
    // cannot release or admit the replacement, even when there was no fence yet.
    const previous = current?.phase.state === 'awaiting-admission' ? current.phase.lease : null;
    // A successor must not replace the executing peer's staged reservation.
    // Deferred completeness custody bridges its admission and cooldown instead.
    const deferred = current?.phase.state === 'executing' ? reserveDeferred()
      : current?.phase.state === 'awaiting-admission' ? current.phase.deferred : undefined;
    const lease = current?.phase.state === 'executing' ? null
      : previous !== null && previous.isCurrent() ? previous : reserveFence();
    if (previous !== null && previous !== lease) previous.release();
    if (lease !== null) deferred?.release();
    this.#selection = { state: 'selected', generation: this.#selection.generation };
    const demand: DemandV1 = { connectionGeneration, selectionGeneration: this.#selection.generation,
      phase: { state: 'awaiting-admission', lease, ...(lease === null && deferred ? { deferred } : {}) } };
    if (current?.phase.state === 'awaiting-admission') { current.phase = { state: 'retired' }; this.#current = demand; }
    else if (current === null) this.#current = demand;
    else this.#successor = demand;
    let settled = false;
    return Object.freeze({
      admit: () => {
        if (settled) return; settled = true;
        if (!this.#owns(demand) || demand.phase.state !== 'awaiting-admission') return;
        demand.phase = demand.phase.lease === null ? { state: 'waiting-for-fence', deferred: demand.phase.deferred }
          : { state: 'queued', lease: demand.phase.lease };
      },
      reject: () => { if (!settled) { settled = true; this.#release(demand); } },
    });
  }

  retryFence(reserveFence: () => FenceV1 | null): void {
    for (const demand of [this.#current]) {
      if (demand?.phase.state !== 'waiting-for-fence') continue;
      const lease = reserveFence();
      if (lease !== null) {
        const deferred = demand.phase.deferred;
        demand.phase = { state: 'queued', lease };
        deferred?.release();
      }
    }
  }

  begin(now: number): Rfc64CatalogReplayScopeExecutionV1 | null {
    const demand = this.#current;
    if (demand?.phase.state !== 'queued' || !this.ready(now)) return null;
    const execution = Object.freeze({}) as Rfc64CatalogReplayScopeExecutionV1;
    demand.phase = { state: 'executing', lease: demand.phase.lease };
    this.#execution = execution;
    return execution;
  }

  /** Refresh current-policy custody before each asynchronous execution phase. */
  refreshExecution(execution: Rfc64CatalogReplayScopeExecutionV1, reserveFence: () => FenceV1 | null,
    reserveDeferred: () => Readonly<{ release(): void }> | null): FenceV1 | null {
    const demand = this.#current;
    if (execution !== this.#execution || demand?.phase.state !== 'executing') return null;
    const previous = demand.phase.lease;
    if (previous.isCurrent()) return previous;
    // Acquire replacement custody before releasing the retired reservation.
    // Capacity pressure leaves the same demand pending, without resetting cooldown.
    const lease = reserveFence();
    if (lease === null) {
      const deferred = reserveDeferred();
      demand.phase = { state: 'waiting-for-fence', ...(deferred ? { deferred } : {}) };
      this.#execution = null;
    } else demand.phase = { state: 'executing', lease };
    if (previous !== lease) previous.release();
    return lease;
  }

  finish(execution: Rfc64CatalogReplayScopeExecutionV1, failed: boolean, now: number): void {
    const demand = this.#current;
    if (execution !== this.#execution || demand?.phase.state !== 'executing') return;
    this.#execution = null;
    this.#failures = failed ? this.#failures + 1 : 0;
    this.#eligibleAt = now + (failed ? this.#retryDelay() : this.debounceMs);
    this.#release(demand);
  }

  /** Selection removal retires queued custody, retaining an executing lease until physical drain. */
  retireSelection(): void {
    if (this.#selection.state === 'selected') {
      this.#selection = { state: 'retired', generation: this.#selection.generation + 1 };
    }
    if (this.#successor !== null) this.#release(this.#successor);
    if (this.#current !== null && !this.executing) this.#release(this.#current);
  }

  /** The runtime calls this only after its stream owners physically drain. */
  releaseAll(): void {
    if (this.#successor !== null) this.#release(this.#successor);
    if (this.#current !== null) this.#release(this.#current);
  }

  #owns(demand: DemandV1): boolean { return demand === this.#current || demand === this.#successor; }
  #release(demand: DemandV1): void {
    if (!this.#owns(demand)) return;
    if ('deferred' in demand.phase) demand.phase.deferred?.release();
    if ('lease' in demand.phase) demand.phase.lease?.release();
    demand.phase = { state: 'retired' };
    if (demand === this.#successor) this.#successor = null;
    else { this.#execution = null; this.#current = this.#successor; this.#successor = null; }
  }
  #retryDelay(): number {
    let hash = 0;
    for (const character of `${this.peerId}\0${this.contextGraphId}`) {
      hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
    }
    const base = Math.min(600_000, this.debounceMs * 2 ** Math.min(this.#failures - 1, 8));
    return Math.min(600_000, base + Math.floor(base * ((hash % 251) / 1000)));
  }
}
