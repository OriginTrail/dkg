import type { AgentWorkLifetime } from './agent-work-lifetime.js';
// SPDX-License-Identifier: Apache-2.0
import type { PublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { startRequestAbortLifecycle } from '@origintrail-official/dkg-core';
import { PublicSnapshotAdmission } from './public-snapshot-admission.js';

/** Agent-owned serving: cache, physical build admission and one disposable node-bound deadline.
 * The node drains the tracked physical promise on shutdown, even when a reader ignores abort.
 * Failures never replace the last good snapshot or extend its age. */
export class PublicSnapshotServingRuntime {
  private readonly entries = new Map<string, { snapshot: PublicGraphSnapshot; sequence: number }>();
  private readonly pending = new Map<string, { promise: Promise<PublicGraphSnapshot>; sequence: number }>();
  constructor(
    private readonly read: (
      id: string,
      onChainId: string,
      signal: AbortSignal,
    ) => Promise<PublicGraphSnapshot>,
    private readonly lifetime: AgentWorkLifetime,
    private readonly clock: () => number = Date.now,
  ) { this.admission = new PublicSnapshotAdmission(clock); this.signal = lifetime.signal; }
  private readonly signal: AbortSignal;
  private readonly admission: PublicSnapshotAdmission;
  private sequence = 0;
  async get(peer: string, id: string, onChainId: string, refresh = false): Promise<PublicGraphSnapshot> {
    const key = JSON.stringify([id, onChainId]);
    // A forced observation must begin after THIS request, in the supplier's
    // own ordering domain. Never compare clocks belonging to different nodes.
    const minimum = refresh ? this.sequence + 1 : 0;
    for (;;) {
      this.signal.throwIfAborted();
      const cached = this.entries.get(key);
      if (cached && cached.sequence >= minimum
        && this.clock() - cached.snapshot.observedAt < 30_000 && this.clock() < cached.snapshot.expiresAt) return cached.snapshot;
      const current = this.pending.get(key);
      if (current) {
        const result = await current.promise;
        if (current.sequence >= minimum) return result;
        continue;
      }
      if (this.pending.size >= 2) throw new Error("Snapshot builder busy");
      const release = this.admission.acquire(peer);
      const lifecycle = startRequestAbortLifecycle(110_000, [this.signal]);
      const sequence = ++this.sequence;
      let read: Promise<PublicGraphSnapshot>;
      try { read = this.read(id, onChainId, lifecycle.signal); }
      catch (error) { lifecycle.release(); release(); throw error; }
      const operation = read.then(snapshot => {
        lifecycle.signal.throwIfAborted();
        if (this.entries.size >= 8) {
          const oldest = this.entries.keys().next().value!;
          this.entries.delete(oldest);
        }
        this.entries.set(key, { snapshot, sequence });
        return snapshot;
      }).finally(() => {
        this.pending.delete(key);
        lifecycle.release(); release();
      });
      this.lifetime.track(operation);
      this.pending.set(key, { promise: operation, sequence });
      return operation;
    }
  }
}
