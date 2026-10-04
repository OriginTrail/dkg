/**
 * GH#2901 — an async share whose `swmCurrentAssertion` stamp fails after the
 * durable SWM commit must NOT be reported as succeeded, and must be repaired as
 * the SAME operation, including across a process restart. Real worker
 * (`runPromoteJob` + error classification), real queue, real publisher, real
 * `agent.assertion.promote`; only the pointer store call is faulted.
 *
 * Two recovery paths, both bounded by the job's own retry budget and backoff:
 *  - a storage failure proven never to have started is retried directly
 *    (`failed_retrying` + `nextRetryAt`, never a `failed` row);
 *  - any other failure fails closed as a post-commit failure and the recovery
 *    sweep requeues it.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import {
  assertionLifecycleUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import { TripleStoreAsyncPromoteQueue } from '@origintrail-official/dkg-publisher';
import { StoreOperationTimeoutError, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { createPromotionAgentForTest } from '../../agent/test/_helpers/promotion-agent.js';
import {
  SWM_POINTER_PRED,
  SwmPointerFaultStore,
  type SwmPointerFault,
} from '../../agent/test/_helpers/swm-pointer-fault-store.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';
import { createAsyncPromoteWorkerFixture } from './_helpers/async-promote-worker-fixture.js';

const CG = 'swm-pointer-recovery-cg';
const NAME = 'pointer-asset';
const AGENT = `0x${'11'.repeat(20)}`;
const OPERATION_PRED = 'http://dkg.io/ontology/shareOperationId';
const BACKOFF_MS = 60_000;

describe('async promote repairs a failed SWM pointer stamp (GH#2901)', () => {
  it.each([
    {
      label: 'proven not started (seal read, queue wait timeout)',
      fault: 'seal-read' as SwmPointerFault,
      failure: () => new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'agent.publish.swmPointerSeal', {
        storeOperation: 'query',
      }),
      path: 'direct-retry' as const,
    },
    {
      label: 'indeterminate (pointer delete, outcome unknown)',
      fault: 'pointer-delete' as SwmPointerFault,
      failure: () => new StoreOperationTimeoutError({
        backend: 'managed-oxigraph', operation: 'deleteByPattern', outcome: 'indeterminate',
      }),
      path: 'sweep' as const,
    },
  ])(
    'never succeeds on a $label failure and repairs the same operation after a restart',
    async ({ fault, failure, path }) => {
      const store = new SwmPointerFaultStore();
      const { queue, clock, logs, makeRequest } = createAsyncPromoteWorkerFixture({ maxRetries: 5, store });
      const { agent, publisher } = await createPromotionAgentForTest(store, { agentAddress: AGENT, peerId: '12D3KooWPointerRecovery' });
      await publisher.assertionCreate(CG, NAME, AGENT);
      await publisher.assertionWrite(CG, NAME, AGENT, [{
        subject: 'urn:test:pointer', predicate: 'http://schema.org/name', object: '"Pointer"',
      }]);
      const finalized = await finalizeRootlessAssertionForTest({
        publisher, store, contextGraphId: CG, name: NAME, agentAddress: AGENT,
      });
      const lifecycle = assertionLifecycleUri(CG, AGENT, NAME);
      const readLiteral = async (pred: string): Promise<string | undefined> => {
        const result = await store.query(
          `SELECT ?o WHERE { GRAPH <${contextGraphMetaUri(CG)}> { <${lifecycle}> <${pred}> ?o } } LIMIT 1`,
        );
        const raw = result.type === 'bindings' ? result.bindings[0]?.['o'] : undefined;
        return raw?.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');
      };
      const sealedRoot = (await readLiteral('http://dkg.io/ontology/wmCurrentAssertion'))!;
      expect(sealedRoot).toMatch(/^[0-9a-f]{64}$/);

      const jobId = await queue.enqueue(makeRequest({
        contextGraphId: CG, subGraphName: undefined, assertionName: NAME, agentAddress: AGENT,
      }));
      const runAttempt = async (q: typeof queue, target: typeof agent) => {
        const job = await q.claimNext('pointer-worker');
        if (!job) throw new Error('Expected a claimable promotion');
        return runPromoteJob({
          job, queue: q, workerId: 'pointer-worker', now: clock.now, heartbeatIntervalMs: 0,
          log: (message) => { logs.push(message); },
          runPromote: async (_request, markPromoteStarted) => {
            await markPromoteStarted();
            return target.assertion.promote(CG, NAME, { accessPolicy: 'public' });
          },
        });
      };

      // Attempt 1: SWM commits, then the pointer maintenance fails once.
      store.arm(fault, failure());
      const first = await runAttempt(queue, agent);
      expect(store.trips).toEqual([fault]);

      // Never "succeeded"; the share IS committed and only the pointer is missing.
      const afterFailure = (await queue.getStatus(jobId))!;
      expect(afterFailure.commitMarker?.swmInserted).toBe(false);
      expect(agent.log.warn).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Failed to stamp swmCurrentAssertion'),
      );
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
      expect(await readLiteral(SWM_POINTER_PRED)).toBeUndefined();
      const operationId = await readLiteral(OPERATION_PRED);
      expect(operationId).toBeTruthy();

      // "Restart": new queue instance + fresh agent/publisher over the durable store.
      const restartedQueue = new TripleStoreAsyncPromoteQueue(store, {
        now: clock.now, backoff: () => BACKOFF_MS, maxRetries: 5,
      });
      const restarted = await createPromotionAgentForTest(store, { agentAddress: AGENT, peerId: '12D3KooWPointerRecovery' });

      if (path === 'direct-retry') {
        // No `failed` flash: the queue's ordinary bounded retry owns it from the first write.
        expect(first).toMatchObject({
          outcome: 'failed_retrying', error: { classification: 'transient', retryable: true },
        });
        expect(afterFailure.state).toBe('failed_retrying');
        expect(afterFailure.attempt.nextRetryAt).toBe(clock.now() + BACKOFF_MS);
        expect(afterFailure.attempt.lastError?.diagnosticCode).toBeUndefined();
        expect(await restartedQueue.recoverPostCommitFailures()).toEqual([]);
      } else {
        // Fail closed as post-commit; the sweep requeues it with the same backoff.
        expect(first).toMatchObject({
          outcome: 'failed_terminal', error: { classification: 'fatal', retryable: false },
        });
        expect(afterFailure.state).toBe('failed');
        expect(afterFailure.attempt.lastError?.diagnosticCode).toBe('PROMOTE_POST_COMMIT_FAILURE');
        expect(logs.some((line) => line.includes('"errorCode":"PROMOTE_POST_COMMIT_FAILURE"'))).toBe(true);
        expect(await restartedQueue.recoverPostCommitFailures()).toEqual([{
          jobId, action: 'requeued', attempt: 1, maxAttempts: 5, nextRetryAt: clock.now() + BACKOFF_MS,
        }]);
      }

      // Backoff, not a tight loop: nothing is claimable before the retry time.
      expect(await restartedQueue.claimNext('pointer-worker')).toBeNull();
      expect(await readLiteral(SWM_POINTER_PRED)).toBeUndefined();

      clock.advance(BACKOFF_MS);
      expect(await runAttempt(restartedQueue, restarted.agent)).toMatchObject({ outcome: 'succeeded' });
      const repaired = (await restartedQueue.getStatus(jobId))!;
      expect(repaired.state).toBe('succeeded');
      expect(repaired.attempt.count).toBe(2);
      // Same operation, same exact SWM graph, and the descriptor now carries the sealed root.
      expect(await readLiteral(SWM_POINTER_PRED)).toBe(sealedRoot);
      expect(await readLiteral(OPERATION_PRED)).toBe(operationId);
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
      expect(await restartedQueue.recoverPostCommitFailures()).toEqual([]);
    },
  );
});
