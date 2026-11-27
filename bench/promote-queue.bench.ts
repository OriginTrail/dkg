import assert from 'node:assert/strict';
import { defineSuite } from 'esbench';
import { OxigraphStore } from '../packages/storage/dist/index.js';
import { TripleStoreAsyncPromoteQueue } from '../packages/publisher/src/async-promote-queue-impl.ts';
import { serializeJob, DEFAULT_PROMOTE_CONTROL_GRAPH_URI } from '../packages/publisher/src/async-promote-queue-utils.ts';
import type { PromoteJob } from '../packages/publisher/src/async-promote-queue-types.ts';
import { benchAsyncWithHooks } from './support/esbench-case-hooks.ts';

// Source imports make this runnable through the standard `pnpm bench` setup,
// which builds the only generated dependency used here: the storage package.
// Compare separately built checkouts through ESBENCH_RESULT and ESBENCH_DIFF.
// Setup/reset runs outside the measured claim. This uses local in-memory Oxigraph.
export default defineSuite({
  params: { terminalJobs: [1_000, 10_000, 100_000] },
  timing: { iterations: 1, samples: 5, warmup: 2, unrollFactor: 1, evaluateOverhead: false },
  async setup(scene) {
    const historySize = scene.params.terminalJobs as number;
    const store = new OxigraphStore();
    scene.teardown(() => store.close());
    const graph = DEFAULT_PROMOTE_CONTROL_GRAPH_URI;
    await store.createGraph(graph);
    const job = (jobId: string, state: PromoteJob['state']): PromoteJob => ({
      jobId, state, enqueuedAt: 1, updatedAt: 1, formatVersion: 1,
      request: { contextGraphId: 'benchmark', subGraphName: 'code', assertionName: jobId, entities: 'all' },
      attempt: { count: 0, maxRetries: 5 },
    });
    for (let start = 0; start < historySize; start += 1_000) {
      await store.insert(Array.from({ length: Math.min(1_000, historySize - start) }, (_, i) =>
        serializeJob(job(`history-${start + i}`, i % 2 ? 'failed' : 'succeeded'), graph)).flat());
    }
    const queued = Array.from({ length: 3 }, (_, i) => serializeJob(job(`active-${i}`, 'queued'), graph));
    let queue: TripleStoreAsyncPromoteQueue;
    benchAsyncWithHooks(scene, 'claim with three active jobs', async () => {
      assert.equal((await queue.claimNext('benchmark-worker'))?.jobId, 'active-0');
    }, {
      beforeIteration: async () => {
        for (const quads of queued) {
          await store.deleteByPattern({ graph, subject: quads[0].subject });
          await store.insert(quads);
        }
        queue = new TripleStoreAsyncPromoteQueue(store, { now: () => 1_000, claimTokenGenerator: () => 'benchmark-token' });
      },
    });
  },
});
