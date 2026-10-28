// SPDX-License-Identifier: Apache-2.0
import type { Rfc64CatalogReplayPeerDemandV1, Rfc64CatalogReplayRecoveryResultV1 as Result } from './catalog-replay-recovery-runtime-v1.js';

type Outcome = Readonly<{ result: Readonly<Result> }> | Readonly<{ error: unknown }>;
/** One generation owns its execution phase and all of its completion subscribers. */
export class CatalogReplayPeerWorkV1 implements Rfc64CatalogReplayPeerDemandV1 {
  #phase: 'queued' | 'running' | Outcome = 'queued';
  readonly #subscribers = new Set<(outcome: Outcome) => void>();
  continuation: Readonly<{ signal?: AbortSignal }> | null = null;
  constructor(readonly peerId: string, readonly generation: number) {}
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

/** Explicit ownership of records consumed by one finite execution chunk. */
export class CatalogReplayChunkV1 {
  readonly records = new Set<CatalogReplayPeerWorkV1>();
  take(record: CatalogReplayPeerWorkV1): void { record.start(); this.records.add(record); }
  settle(outcome: Outcome): void { for (const record of this.records) record.settle(outcome); }
}
