// SPDX-License-Identifier: Apache-2.0
import { mapWithConcurrencyDrained } from './map-with-concurrency.js';
import { availableParallelism, freemem } from 'node:os';
import { SyncVerifyWorker } from './sync-verify-worker.js';
import { createAssetPayloadVerifier, type DecodedAssetPayload } from './sync/requester/asset-payload-verifier.js';
import { createOperationContext } from '@origintrail-official/dkg-core';

const WORKER_RESERVATION = 512 * 1024 * 1024;
const HOST_RESERVATION = 1024 * 1024 * 1024;

/** A ceiling, never an instruction to allocate all of the host's CPUs or memory. */
export function snapshotVerificationWidth(resources = {
  cpus: availableParallelism(), freeBytes: freemem(),
}): number {
  if (!Number.isFinite(resources.cpus) || !Number.isFinite(resources.freeBytes)) return 1;
  return Math.max(1, Math.min(4, Math.floor(resources.cpus),
    Math.floor((resources.freeBytes - HOST_RESERVATION) / WORKER_RESERVATION)));
}

/** Each lane owns one verifier; no unbounded worker-message queue or parsed-asset backlog. */
export async function withSnapshotVerificationPool<T>(options: {
  contextGraphId: string; signal: AbortSignal;
  run: (lane: { index: number; verify: ReturnType<typeof createAssetPayloadVerifier> }) => Promise<T>;
  /** Only lowers the resource-derived ceiling. */
  maxWorkers?: number;
}): Promise<T[]> {
  const max = options.maxWorkers ?? 4;
  if (!Number.isSafeInteger(max) || max < 1 || max > 4) throw new RangeError('Invalid snapshot verifier count');
  options.signal.throwIfAborted();
  const workers: SyncVerifyWorker[] = [];
  const failed = new AbortController();
  const signal = AbortSignal.any([options.signal, failed.signal]);
  let results: T[];
  let closed: PromiseSettledResult<void>[];
  const stop = () => { for (const worker of workers) void worker.close().catch(() => undefined); };
  try {
    for (let i = 0; i < Math.min(max, snapshotVerificationWidth()); i++) workers.push(new SyncVerifyWorker());
    signal.addEventListener('abort', stop, { once: true });
    signal.throwIfAborted();
    results = await mapWithConcurrencyDrained(workers, workers.length, async (worker, index) => {
      const verify = createAssetPayloadVerifier({
        contextGraphId: options.contextGraphId, ctx: createOperationContext('sync'),
        parseAndFilter: worker.parseAndFilter.bind(worker),
        processDurableBatchInWorker: (data, meta, _ctx, accept, mode) => worker.processDurableBatch(data, meta, accept, mode),
      });
      try {
        return await options.run({ index, verify: async (payload: DecodedAssetPayload) => {
          signal.throwIfAborted();
          const result = await verify(payload, signal);
          signal.throwIfAborted();
          return result;
        } });
      } catch (error) {
        failed.abort(error);
        throw error;
      }
    });
    signal.throwIfAborted();
  } catch (error) {
    failed.abort(error);
    throw error;
  } finally {
    signal.removeEventListener('abort', stop);
    closed = await Promise.allSettled(workers.map(worker => worker.close()));
  }
  // Only reached after successful work; cleanup cannot hide its primary failure.
  signal.throwIfAborted();
  for (const result of closed) if (result.status === 'rejected') throw result.reason;
  return results;
}
