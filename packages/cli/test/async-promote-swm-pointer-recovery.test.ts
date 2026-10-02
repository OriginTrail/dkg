/**
 * GH#2901 — an async share whose `swmCurrentAssertion` stamp fails after the
 * durable SWM commit must NOT be reported as succeeded; the daemon's
 * post-commit recovery sweep must repair the SAME operation, including across
 * a process restart. Real worker (`runPromoteJob` + error classification),
 * real queue, real publisher, real `agent.assertion.promote` (only the store
 * call is faulted).
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TypedEventBus,
  assertionLifecycleUri,
  contextGraphMetaUri,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { DKGPublisher, TripleStoreAsyncPromoteQueue } from '@origintrail-official/dkg-publisher';
import {
  StoreOperationTimeoutError,
  StoreSchedulerBusyError,
  type OxigraphStore,
} from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../../agent/src/dkg-agent.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';
import { createAsyncPromoteWorkerFixture } from './_helpers/async-promote-worker-fixture.js';

const CG = 'swm-pointer-recovery-cg';
const NAME = 'pointer-asset';
const AGENT = `0x${'11'.repeat(20)}`;
const SWM_PRED = 'http://dkg.io/ontology/swmCurrentAssertion';
const OPERATION_PRED = 'http://dkg.io/ontology/shareOperationId';

/** A "process": fresh agent + publisher objects over a durable store. */
async function bootAgent(store: OxigraphStore) {
  const publisher = new DKGPublisher({
    store,
    chain: new MockChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.defaultAgentAddress = AGENT;
  agent.node = { peerId: { toString: () => '12D3KooWPointerRecovery' } };
  agent.store = store;
  agent.publisher = publisher;
  agent.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  agent.prepareAtomicAssertionShare = async () => undefined;
  agent.resolveWorkspaceGossipSigningAgent = async () => undefined;
  agent.resolveWorkspaceRecipientsGated = async () => ({ requiresEncryption: false, recipients: [] });
  agent.buildCuratorAckConfirmer = async () => undefined;
  agent.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0 });
  agent.publishWorkspaceGossip = vi.fn(async () => undefined);
  // The real `afterDurableSwmPromotionV1` / `_stampSwmPointer` run; only the
  // detached RFC-64 observer is out of scope here.
  agent.scheduleRfc64SwmInventoryObserverV1 = vi.fn();
  return { agent, publisher };
}

describe('async promote repairs a failed SWM pointer stamp (GH#2901)', () => {
  it.each([
    [
      'seal read (queue wait timeout)',
      'query',
      () => new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'agent.publish.swmPointerSeal', {
        storeOperation: 'query',
      }),
    ],
    [
      'pointer delete (resume-path shape)',
      'deleteByPattern',
      () => new StoreOperationTimeoutError({
        backend: 'managed-oxigraph', operation: 'deleteByPattern', outcome: 'not_started',
      }),
    ],
  ] as const)(
    'fails the job instead of succeeding on a failed %s, and the sweep repairs it after a restart',
    async (_label, faultedMethod, makeFailure) => {
      const { store, queue, clock, logs, makeRequest } = createAsyncPromoteWorkerFixture({ maxRetries: 5 });
      const { agent, publisher } = await bootAgent(store);
      await publisher.assertionCreate(CG, NAME, AGENT);
      await publisher.assertionWrite(CG, NAME, AGENT, [{
        subject: 'urn:test:pointer', predicate: 'http://schema.org/name', object: '"Pointer"',
      }]);
      const finalized = await finalizeRootlessAssertionForTest({
        publisher, store, contextGraphId: CG, name: NAME, agentAddress: AGENT,
      });
      const metaGraph = contextGraphMetaUri(CG);
      const lifecycle = assertionLifecycleUri(CG, AGENT, NAME);
      const readLiteral = async (pred: string): Promise<string | undefined> => {
        const result = await store.query(
          `SELECT ?o WHERE { GRAPH <${metaGraph}> { <${lifecycle}> <${pred}> ?o } } LIMIT 1`,
        );
        const raw = result.type === 'bindings' ? result.bindings[0]?.['o'] : undefined;
        return raw?.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');
      };
      const sealedRoot = (await readLiteral('http://dkg.io/ontology/wmCurrentAssertion'))!;
      expect(sealedRoot).toMatch(/^[0-9a-f]{64}$/);

      const jobId = await queue.enqueue(makeRequest({
        contextGraphId: CG, subGraphName: undefined, assertionName: NAME, agentAddress: AGENT,
      }));
      const runAttempt = async (q: TripleStoreAsyncPromoteQueue | typeof queue, target: typeof agent) => {
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
      const failure = makeFailure();
      let injected = false;
      const real = (store as any)[faultedMethod].bind(store);
      const spy = vi.spyOn(store as any, faultedMethod).mockImplementation(async (...args: unknown[]) => {
        const first = args[0] as { predicate?: string } | string;
        const hitsPointer = faultedMethod === 'query'
          ? (args[1] as { source?: string } | undefined)?.source === 'agent.publish.swmPointerSeal'
          : typeof first === 'object' && first.predicate === SWM_PRED;
        if (!injected && hitsPointer) {
          injected = true;
          throw failure;
        }
        return real(...args);
      });
      let first: Awaited<ReturnType<typeof runAttempt>>;
      try {
        first = await runAttempt(queue, agent);
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);

      // Never "succeeded": a terminal post-commit failure of the existing job.
      expect(first).toMatchObject({
        outcome: 'failed_terminal',
        error: { classification: 'fatal', retryable: false },
      });
      const failed = (await queue.getStatus(jobId))!;
      expect(failed.state).toBe('failed');
      expect(failed.commitMarker?.swmInserted).toBe(false);
      expect(failed.attempt.lastError?.diagnosticCode).toBe('PROMOTE_POST_COMMIT_FAILURE');
      expect(logs.some((line) => line.includes('"errorCode":"PROMOTE_POST_COMMIT_FAILURE"'))).toBe(true);
      // The root-cause text is only in the stamp's own warn log.
      expect(agent.log.warn).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Failed to stamp swmCurrentAssertion'),
      );
      // The share IS committed; only the pointer is missing.
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
      expect(await readLiteral(SWM_PRED)).toBeUndefined();
      const operationId = await readLiteral(OPERATION_PRED);
      expect(operationId).toBeTruthy();

      // "Restart": new queue instance + fresh agent/publisher over the durable store.
      const restartedQueue = new TripleStoreAsyncPromoteQueue(store, {
        now: clock.now, backoff: () => 60_000, maxRetries: 5,
      });
      const restarted = await bootAgent(store);
      expect(await restartedQueue.recoverPostCommitFailures()).toEqual([{
        jobId, action: 'requeued', attempt: 1, maxAttempts: 5, nextRetryAt: clock.now() + 60_000,
      }]);
      // Backoff, not a tight loop: nothing is claimable before the retry time.
      expect(await restartedQueue.claimNext('pointer-worker')).toBeNull();
      expect(await readLiteral(SWM_PRED)).toBeUndefined();

      clock.advance(60_000);
      expect(await runAttempt(restartedQueue, restarted.agent)).toMatchObject({ outcome: 'succeeded' });
      const repaired = (await restartedQueue.getStatus(jobId))!;
      expect(repaired.state).toBe('succeeded');
      expect(repaired.attempt.count).toBe(2);
      // Same operation, same exact SWM graph, and the descriptor now carries the sealed root.
      expect(await readLiteral(SWM_PRED)).toBe(sealedRoot);
      expect(await readLiteral(OPERATION_PRED)).toBe(operationId);
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
      expect(await restartedQueue.recoverPostCommitFailures()).toEqual([]);
    },
  );
});
