// SPDX-License-Identifier: Apache-2.0
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import { recoverPublicSnapshotExact, type PublicSnapshotExactRecoveryOptions } from './public-snapshot-exact.js';
import { PublicSnapshotRecoveryPacing } from './public-snapshot-exact-pacing.js';

/** Two disjoint lanes overlap network waits and atomic storage. Each still
 * enters ordinary admission, per-peer serialization and the fixed wire window.
 * A single supplier or saturated node can therefore serialize them as before. */
export async function recoverPublicSnapshotParallelExact(host: DurableRecoveryHost, options: PublicSnapshotExactRecoveryOptions) {
  if (options.uals.length <= 10) return recoverPublicSnapshotExact(host, options);
  options.signal.throwIfAborted(); options.assertCurrent();
  if (Date.now() >= options.deadline) throw new Error('Snapshot recovery incomplete: job time limit reached');
  const discovery = options.peerBatches()[Symbol.asyncIterator]();
  let first: IteratorResult<readonly string[]>;
  try { first = await discovery.next(); } finally { await discovery.return?.(); }
  // One supplier gains nothing from competing lanes. Preserve its original
  // admission, retry cadence and whole-job progress reporting.
  if (first.done || first.value.length < 2) return recoverPublicSnapshotExact(host, options);
  const partitions: string[][] = [[], []];
  for (let offset = 0; offset < options.uals.length; offset += 10)
    partitions[(offset / 10) % 2]!.push(...options.uals.slice(offset, offset + 10));
  const failure = new AbortController();
  const signal = AbortSignal.any([options.signal, failure.signal]);
  const assertCurrent = () => { signal.throwIfAborted(); options.assertCurrent(); };
  const tails = new Map<string, Promise<unknown>>();
  const coordination = {
    pacing: new PublicSnapshotRecoveryPacing({ ...options, signal, assertCurrent }),
    committed: new Set<string>(), total: options.uals.length,
    async serializePeer<T>(peer: string, run: () => Promise<T>): Promise<T> {
      const previous = tails.get(peer) ?? Promise.resolve();
      const work = previous.catch(() => {}).then(() => { assertCurrent(); return run(); });
      tails.set(peer, work);
      try { return await work; } finally { if (tails.get(peer) === work) tails.delete(peer); }
    },
  };
  let firstFailure: unknown;
  const results = await Promise.allSettled(partitions.map(async (uals, lane) => {
    try {
      return await recoverPublicSnapshotExact(host, { ...options, uals, signal, coordination, assertCurrent,
        peerBatches: async function* () {
          for await (const peers of options.peerBatches()) {
            // Prefer separate admitted suppliers; none is removed from fallback.
            const offset = lane % Math.max(1, peers.length);
            yield [...peers.slice(offset), ...peers.slice(0, offset)];
          }
        },
      });
    } catch (error) {
      if (!failure.signal.aborted) { firstFailure = error; failure.abort(error); }
      throw error;
    }
  }));
  // Cancellation never abandons an in-flight atomic callback or its locks.
  if (failure.signal.aborted) throw firstFailure;
  const committed = new Set<string>(); let alreadyPresent = 0;
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
    result.value.committed.forEach(ual => committed.add(ual));
    alreadyPresent += result.value.alreadyPresent ?? 0;
  }
  return { committed, alreadyPresent };
}
