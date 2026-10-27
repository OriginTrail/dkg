/**
 * The scripted retention workload of the OT-RFC-73 P10a boundary checks: a seeded control graph (deletable jobs of every class, jobs that must be kept) and one
 * pass of the sweep over a recording store. The seed goes in through the inner store, so only the sweep's own calls are recorded.
 */
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { createShareRetention, type ShareRetentionMode } from '../../src/async-promote-retention.js';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI } from '../../src/async-promote-queue-utils.js';
import { NOW, W, captureLogger, mk, put, retired, standInForTheQueue } from './share-retention-fixtures.js';
import type { ShareStoreRecorder } from './share-control-recorder.js';

export interface RetentionWorkloadOptions {
  mode: Exclude<ShareRetentionMode, 'off'>;
  graphUri?: string;
}

export async function driveRetentionWorkload(recorder: ShareStoreRecorder, inner: TripleStore, options: RetentionWorkloadOptions): Promise<{ deleted: number; wouldDelete: number }> {
  if (options.graphUri !== undefined && options.graphUri !== DEFAULT_PROMOTE_CONTROL_GRAPH_URI) throw new Error('the seed fixtures write the default control graph');
  await put(inner, mk('s1', 'succeeded', {}, 10 * W), mk('s2', 'succeeded', {}, 11 * W), mk('s3', 'succeeded', {}, 12 * W),
    mk('c1', 'failed', { reason: 'cancelled' }, 10 * W), retired('r1', 10 * W),
    mk('fatal', 'failed', {}, 20 * W), mk('queued', 'queued', {}, 10 * W), mk('young', 'succeeded', {}, 1000));
  standInForTheQueue(recorder.store, options.graphUri);                                // no queue is built here: make the coordinator its constructor would
  const retention = createShareRetention({
    store: recorder.store, mode: options.mode, intervalMs: 60_000, succeededMaxAgeMs: W, benignFailedMaxAgeMs: W, batchSize: 4, sliceSize: 2,
    now: () => NOW, monotonicNow: () => 0, logger: captureLogger(),
  });
  let deleted = 0, wouldDelete = 0;
  await recorder.mark('retention', async () => {
    for (let i = 0; i < 6; i++) {
      const res = await retention.runBatch();
      deleted += res.deleted; wouldDelete += res.wouldDelete;
      if (!res.hasMore && res.scanned === 0) break;
    }
  });
  return { deleted, wouldDelete };
}
