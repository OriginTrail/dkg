// SPDX-License-Identifier: Apache-2.0
import { startRequestAbortLifecycle } from '@origintrail-official/dkg-core';
import { mapWithConcurrencyDrained } from './map-with-concurrency.js';

/** Lazily probe at most sixteen ordered hints, four at a time. Each connection
 * and authentication shares one deadline; all admitted work physically drains
 * before a batch is yielded or parent cancellation is reported. */
export async function* probeSnapshotPeerBatches(ports: {
  candidates: readonly string[];
  connect(peer: string, signal: AbortSignal): Promise<void>;
  authenticate(peer: string, signal: AbortSignal): Promise<boolean>;
}, signal: AbortSignal): AsyncGenerator<readonly string[]> {
  const candidates = ports.candidates.slice(0, 16);
  for (let offset = 0; offset < candidates.length; offset += 4) {
    signal.throwIfAborted();
    const proven = await mapWithConcurrencyDrained(candidates.slice(offset, offset + 4), 4, async peer => {
      const lifetime = startRequestAbortLifecycle(10_000, [signal]);
      try {
        await ports.connect(peer, lifetime.signal);
        lifetime.signal.throwIfAborted();
        const valid = await ports.authenticate(peer, lifetime.signal);
        lifetime.signal.throwIfAborted();
        return valid ? peer : null;
      } catch {
        signal.throwIfAborted();
        return null;
      } finally { lifetime.release(); }
    });
    signal.throwIfAborted();
    const accepted = proven.filter((peer): peer is string => peer !== null);
    if (accepted.length) yield accepted;
  }
}
