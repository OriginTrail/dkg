import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { computeCanonicalGraphScopedAuthorSealDigestV1 } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../../publisher/src/async-promote-queue-impl.js';
import { createPromoteOperationIntent } from '../../publisher/src/promote-operation-intent.js';
import { jobSubject } from '../../publisher/src/async-promote-queue-utils.js';
import { shareEvidence } from '../../publisher/test/_helpers/share-completion-evidence.js';
import { runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';
import { deferred } from './_helpers/async-promote-worker-fixture.js';

function proofFor(name: string) {
  return { ...shareEvidence(), assertionName: name, shareOperationId: `op-${name}` };
}

function requestFor(name: string) {
  const proof = proofFor(name);
  return { contextGraphId: proof.contextGraphId, assertionName: name, agentAddress: proof.agentAddress, entities: 'all' as const,
    recoveryBinding: { version: 1 as const, inventoryRequired: false, sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(proof.seal),
      intent: createPromoteOperationIntent({ operationId: proof.shareOperationId, timestampMs: 1, publisherPeerId: 'peer',
        confirmationRequired: false, accessPolicy: 'public' }) } };
}

const stores: OxigraphStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map(store => store.close()));
});

it('two completing workers on one graph each write once, and a queued admission waits only for the current completion', async () => {
  const store = new OxigraphStore();
  stores.push(store);
  async function startWorker(name: string) {
    const queue = new TripleStoreAsyncPromoteQueue(store);
    const job = await queue.enqueueAndClaim(requestFor(name), name);
    const executing = deferred(), finish = deferred();
    const run = runPromoteJob({ queue, job, workerId: name, now: Date.now, heartbeatIntervalMs: 0, log: () => {},
      runPromote: async () => {
        executing.resolve();
        await finish.promise;
        return { promotedCount: 1, shareEvidence: proofFor(name) };
      } });
    await executing.promise;
    return { job, queue, run, finish, writing: deferred(), release: deferred() };
  }
  const workers = await Promise.all([startWorker('first'), startWorker('second')]);

  // Park each worker's first post-promote store write so the other worker and
  // the admission enter the real control-graph mutex in a reproducible order.
  const replace = store.replaceSubject.bind(store);
  const writes: string[] = [];
  vi.spyOn(store, 'replaceSubject').mockImplementation(async (...args) => {
    const worker = workers.find(w => jobSubject(w.job.jobId) === args[1]);
    const label = worker?.job.request.assertionName ?? 'admission';
    const firstWrite = !writes.includes(label);
    writes.push(label);
    if (worker && firstWrite) {
      worker.writing.resolve();
      await worker.release.promise;
    }
    return replace(...args);
  });
  const [first, second] = workers;
  try {
    first.finish.resolve();
    await first.writing.promise;
    second.finish.resolve();
    await setImmediate();
    first.release.resolve();
    await second.writing.promise;
    await setImmediate();
    const admission = second.queue.enqueue(requestFor('third'));
    second.release.resolve();
    await admission;
  } finally {
    for (const worker of workers) {
      worker.finish.resolve();
      worker.release.resolve();
    }
  }
  for (const worker of workers) {
    expect((await worker.run).outcome).toBe('succeeded');
    expect(await worker.queue.getStatus(worker.job.jobId)).toMatchObject({
      state: 'succeeded', commitMarker: { swmInserted: true }, result: { shareEvidence: proofFor(worker.job.request.assertionName) },
    });
  }
  expect(writes).toEqual(['first', 'second', 'admission']);
});
