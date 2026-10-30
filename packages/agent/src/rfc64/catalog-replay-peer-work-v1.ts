import { RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 } from './catalog-peers-v1.js';
// SPDX-License-Identifier: Apache-2.0
import type { Rfc64CatalogReplayExecutionOwnerV1, Rfc64CatalogReplayPeerDemandV1, Rfc64CatalogReplayRecoveryResultV1 as Result } from './catalog-replay-types-v1.js';

type Outcome = Readonly<{ result: Readonly<Result> }> | Readonly<{ error: unknown }>;
/** One generation owns its execution phase and all of its completion subscribers. */
export class CatalogReplayPeerWorkV1 implements Rfc64CatalogReplayPeerDemandV1 {
  #phase: 'queued' | 'running' | Outcome = 'queued';
  readonly #subscribers = new Set<(outcome: Outcome) => void>();
  // Reserved custody waits for connection execution. Generic admitted recovery
  // borrows the next run; execution custody carries its own connection signal.
  #custody: Readonly<{ kind: 'retained' | 'reserved' | 'admitted' }> | Readonly<{ kind: 'execution'; owner: Rfc64CatalogReplayExecutionOwnerV1 }>;
  constructor(readonly peerId: string, readonly generation: number, reserved = false) {
    this.#custody = { kind: reserved ? 'reserved' : 'retained' };
  }
  get reserved(): boolean { return this.#custody.kind === 'reserved'; }
  get owned(): boolean { return this.reserved || this.#custody.kind === 'admitted' || (this.#custody.kind === 'execution' && !this.#custody.owner.signal?.aborted); }
  get continuation(): Rfc64CatalogReplayExecutionOwnerV1 | null {
    return this.#custody.kind === 'execution' && !this.#custody.owner.signal?.aborted ? this.#custody.owner : null;
  }
  retainRecovery(): void { if (this.#custody.kind === 'admitted') this.#custody = { kind: 'retained' }; }
  admitRecovery(): void { this.#custody = { kind: 'admitted' }; }
  admitExecution(owner: Rfc64CatalogReplayExecutionOwnerV1): void {
    if (this.#custody.kind !== 'execution') this.#custody = { kind: 'execution', owner };
  }
  runnable(owner: Rfc64CatalogReplayExecutionOwnerV1): boolean {
    return this.#custody.kind === 'retained' || this.#custody.kind === 'admitted' || (this.#custody.kind === 'execution' && this.#custody.owner === owner);
  }
  start(): void { this.#phase = 'running'; }
  settle(outcome: Outcome): void {
    if (typeof this.#phase !== 'string') return;
    this.#phase = outcome;
    for (const notify of this.#subscribers) notify(outcome);
    this.#subscribers.clear();
  }
  subscribe(signal?: AbortSignal): Promise<Readonly<Result>> {
    return new Promise((resolve, reject) => {
      const finish = (outcome: Outcome) => {
        this.#subscribers.delete(finish); signal?.removeEventListener('abort', abort);
        if (signal?.aborted) reject(signal.reason);
        else if ('error' in outcome) reject(outcome.error); else resolve(outcome.result);
      };
      // A running generation retains subscribers until its own chunk drains;
      // it never follows a mutable graph-level completion across continuations.
      const abort = () => { if (this.#phase !== 'running') finish({ error: signal?.reason }); };
      if (typeof this.#phase !== 'string') { finish(this.#phase); return; }
      this.#subscribers.add(finish);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}

/** A stable demand owns identity and successive execution completions. */
export class CatalogReplayPeerDemandHandleV1 {
  execution: CatalogReplayPeerWorkV1;
  constructor(readonly peerId: string, readonly generation: number, reserved = false) {
    this.execution = new CatalogReplayPeerWorkV1(peerId, generation, reserved);
  }
  retainForRetry(): void { this.execution = new CatalogReplayPeerWorkV1(this.peerId, this.generation); }
}

/** Explicit ownership of records consumed by one finite execution chunk. */
export class CatalogReplayChunkV1 {
  readonly records = new Set<CatalogReplayPeerWorkV1>();
  get remaining(): number { return RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 - this.records.size; }
  take(record: CatalogReplayPeerWorkV1): void { record.start(); this.records.add(record); }
  settle(outcome: Outcome): void { for (const record of this.records) record.settle(outcome); }
}

// Private authorization reads local registration and metadata before the dial.
// One per-agent gate bounds graph-by-peer fan-out before it reaches the store.
const MAX_CONCURRENT_REPLAY_PEER_REQUESTS_V1 = 4;

export class Rfc64CatalogReplayPeerAdmissionV1 {
  readonly #waiters = new Set<() => void>();
  #inflight = 0;

  /** FIFO admission covers only the provider attempt, never receiver/parity waits. */
  async run<Value>(
    signal: AbortSignal | undefined,
    work: () => Promise<Value>,
  ): Promise<Value> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const admit = () => {
        signal?.removeEventListener('abort', abort);
        this.#inflight += 1;
        resolve();
      };
      const abort = () => {
        this.#waiters.delete(admit);
        reject(signal?.reason);
      };
      if (this.#inflight < MAX_CONCURRENT_REPLAY_PEER_REQUESTS_V1) {
        admit();
      } else {
        this.#waiters.add(admit);
        signal?.addEventListener('abort', abort, { once: true });
      }
    });
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      // Cancellation cannot free an active permit while its provider still
      // runs. clear/reset also leave these counters with their physical owner.
      this.#inflight -= 1;
      const next = this.#waiters.values().next().value;
      if (next !== undefined) {
        this.#waiters.delete(next);
        next();
      }
    }
  }

}
