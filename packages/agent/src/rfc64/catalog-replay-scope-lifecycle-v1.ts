// SPDX-License-Identifier: Apache-2.0
import type { Rfc64CatalogReplayPeerReservationV1 } from './catalog-replay-recovery-runtime-v1.js';

type FenceV1 = Rfc64CatalogReplayPeerReservationV1;
type PhaseV1 =
  | Readonly<{ state: 'awaiting-admission'; lease: FenceV1 | null }>
  | Readonly<{ state: 'waiting-for-fence' }>
  | Readonly<{ state: 'queued' | 'executing'; lease: FenceV1 }>
  | Readonly<{ state: 'retired' }>;
interface DemandV1 { readonly connectionGeneration: number; readonly selectionGeneration: number; phase: PhaseV1 }
export interface Rfc64CatalogReplayScopeAdmissionV1 { admit(): void; reject(): void }
export interface Rfc64CatalogReplayScopeExecutionV1 { readonly lease: FenceV1 }

/** Owns demand independently of executable-table placement or fence availability. */
export class Rfc64CatalogReplayScopeLifecycleV1 {
  #selection: Readonly<{ state: 'selected' | 'retired'; generation: number }> = { state: 'selected', generation: 0 };
  #current: DemandV1 | null = null;
  #successor: DemandV1 | null = null;
  readonly #executions = new WeakMap<Rfc64CatalogReplayScopeExecutionV1, DemandV1>();
  #failures = 0;
  #eligibleAt = 0;
  constructor(readonly contextGraphId: string, readonly peerId: string, readonly debounceMs: number) {}

  get outstanding(): number { return Number(this.#current !== null) + Number(this.#successor !== null); }
  get executing(): boolean { return this.#current?.phase.state === 'executing'; }
  get eligibleAt(): number { return this.#eligibleAt; }
  get queued(): boolean { return this.#current?.phase.state === 'queued'; }
  ready(now: number): boolean { return this.queued && this.#eligibleAt <= now; }
  awaitingFence(): boolean {
    return [this.#current, this.#successor].some(demand => demand?.phase.state === 'waiting-for-fence');
  }
  canEvict(now: number): boolean { return this.outstanding === 0 && this.#eligibleAt <= now; }
  /** A completed cooldown may yield placement without retiring its queued fence. */
  canDefer(now: number): boolean { return this.#eligibleAt !== 0 && this.ready(now); }

  reserve(connectionGeneration: number, reserveFence: () => FenceV1 | null): Rfc64CatalogReplayScopeAdmissionV1 | null {
    const current = this.#current;
    if (current !== null && ((current.connectionGeneration === connectionGeneration
      && current.selectionGeneration === this.#selection.generation) || this.#successor !== null
      || current.phase.state === 'queued' || current.phase.state === 'waiting-for-fence')) return null;
    // Transfer an unsampled fence to a fresh stable token. Old admission callbacks
    // cannot release or admit the replacement, even when there was no fence yet.
    const lease = current?.phase.state === 'awaiting-admission' ? current.phase.lease : reserveFence();
    this.#selection = { state: 'selected', generation: this.#selection.generation };
    const demand: DemandV1 = { connectionGeneration, selectionGeneration: this.#selection.generation,
      phase: { state: 'awaiting-admission', lease } };
    if (current?.phase.state === 'awaiting-admission') { current.phase = { state: 'retired' }; this.#current = demand; }
    else if (current === null) this.#current = demand;
    else this.#successor = demand;
    let settled = false;
    return Object.freeze({
      admit: () => {
        if (settled) return; settled = true;
        if (!this.#owns(demand) || demand.phase.state !== 'awaiting-admission') return;
        demand.phase = demand.phase.lease === null ? { state: 'waiting-for-fence' }
          : { state: 'queued', lease: demand.phase.lease };
      },
      reject: () => { if (!settled) { settled = true; this.#release(demand); } },
    });
  }

  retryFence(reserveFence: () => FenceV1 | null): void {
    for (const demand of [this.#current, this.#successor]) {
      if (demand?.phase.state !== 'waiting-for-fence') continue;
      const lease = reserveFence();
      if (lease !== null) demand.phase = { state: 'queued', lease };
    }
  }

  begin(now: number): Rfc64CatalogReplayScopeExecutionV1 | null {
    const demand = this.#current;
    if (demand?.phase.state !== 'queued' || !this.ready(now)) return null;
    const execution = Object.freeze({ lease: demand.phase.lease });
    demand.phase = { state: 'executing', lease: demand.phase.lease };
    this.#executions.set(execution, demand);
    return execution;
  }

  finish(execution: Rfc64CatalogReplayScopeExecutionV1, failed: boolean, now: number): void {
    const demand = this.#executions.get(execution);
    if (demand === undefined || demand !== this.#current || demand.phase.state !== 'executing') return;
    this.#executions.delete(execution);
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
    if ('lease' in demand.phase) demand.phase.lease?.release();
    demand.phase = { state: 'retired' };
    if (demand === this.#successor) this.#successor = null;
    else { this.#current = this.#successor; this.#successor = null; }
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
