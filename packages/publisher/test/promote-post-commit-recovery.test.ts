/**
 * Post-commit recovery — end-to-end against the real publisher and queue.
 *
 * Reproduces the saturated-store signature seen on testnet share jobs: the
 * exact SWM replace is dispatched, then a later step is rejected by the
 * storage layer before it starts. Such a failure must earn a bounded queue
 * retry instead of a terminal verdict, an indeterminate failure must stay
 * terminal, and a terminal post-commit failure must be requeued by the
 * recovery sweep so the publisher's idempotent replay repairs the durable
 * tail. Backed by an in-memory store and a mock chain (no Hardhat).
 */
import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import {
  OxigraphStore,
  StoreOperationTimeoutError,
  StoreSchedulerBusyError,
  isStoreOperationTimeoutError,
} from '@origintrail-official/dkg-storage';
import {
  DKGPublisher,
  TripleStoreAsyncPromoteQueue,
  getPromoteFailureDisposition,
  type PromoteAttemptError,
} from '../src/index.js';
import { finalizeRootlessAssertionForTest } from './_helpers/rootless-lifecycle.js';

const CG_ID = 'post-commit-recovery-cg';
const AGENT = '0x1234567890abcdef1234567890abcdef12345678';
const PEER = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const ASSERTION_NAME = 'post-commit-asset';
const COMPANION_GRAPH = 'urn:test:root-companions';
const COMPANION_SUBJECT = 'urn:test:root-companion';
const MEMORY_LAYER_PREDICATE = 'http://dkg.io/ontology/memoryLayer';
const TRIPLES = [
  { subject: 'urn:test:entity:alice', predicate: 'http://schema.org/name', object: '"Alice"' },
  { subject: 'urn:test:entity:bob', predicate: 'http://schema.org/name', object: '"Bob"' },
];

const notStartedTimeout = () => new StoreOperationTimeoutError({
  backend: 'managed-oxigraph', operation: 'insert', outcome: 'not_started',
});
const indeterminateTimeout = (operation = 'insert') => new StoreOperationTimeoutError({
  backend: 'managed-oxigraph', operation, outcome: 'indeterminate',
});
const schedulerBusy = () => new StoreSchedulerBusyError(
  'queue_wait_timeout', 'normal', 'publisher.promoteWmToSwm.finalize', { storeOperation: 'insert' },
);

/**
 * The daemon worker's disposition boundary, reduced to what this suite needs:
 * a publisher marker is authoritative; otherwise only a storage-certified
 * not-started failure is retryable, everything else fails closed.
 */
function recordFailure(error: unknown, recordedAt: number): PromoteAttemptError {
  const disposition = getPromoteFailureDisposition(error);
  const retryable = disposition?.retryable
    ?? (error instanceof StoreSchedulerBusyError
      || (isStoreOperationTimeoutError(error) && error.outcome === 'not_started'));
  return {
    message: error instanceof Error ? error.message : String(error),
    retryable,
    classification: disposition?.classification ?? (retryable ? 'transient' : 'fatal'),
    recordedAt,
    ...(disposition ? { diagnosticCode: disposition.diagnostic.code } : {}),
  };
}

async function createFixture(settle: (committed: boolean | undefined) => void) {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain: new MockChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    resolveDurableRootPromotionAtomicCompanion: () => ({
      graphUri: COMPANION_GRAPH,
      subject: COMPANION_SUBJECT,
      quads: [{
        graph: COMPANION_GRAPH, subject: COMPANION_SUBJECT,
        predicate: 'urn:test:state', object: '"committed"',
      }],
      settle,
    }),
  });
  await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
  await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
  const finalized = await finalizeRootlessAssertionForTest({
    publisher, store, contextGraphId: CG_ID, name: ASSERTION_NAME, agentAddress: AGENT,
  });
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const queue = new TripleStoreAsyncPromoteQueue(store, {
    now: clock.now, backoff: () => 1_000, maxRetries: 5,
  });
  const jobId = await queue.enqueue({
    contextGraphId: CG_ID, assertionName: ASSERTION_NAME, agentAddress: AGENT, entities: 'all',
  });

  /** One worker attempt: claim, promote, and record the outcome the queue contract expects. */
  const attempt = async (): Promise<{ failure?: unknown; recorded?: PromoteAttemptError }> => {
    const job = await queue.claimNext('worker');
    if (!job?.lease) throw new Error('expected a claimable promotion');
    const token = job.lease.claimToken;
    await queue.recordCommitMarker(jobId, token, 'promoteStarted');
    try {
      const result = await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
        publisherPeerId: PEER,
      });
      await queue.recordCommitMarker(jobId, token, 'swmInserted');
      await queue.succeed(jobId, token, { promotedCount: result.promotedCount, succeededAt: now });
      return {};
    } catch (failure: unknown) {
      const recorded = recordFailure(failure, now);
      await queue.fail(jobId, token, recorded);
      return { failure, recorded };
    }
  };

  const expectExactSwmGraph = async (): Promise<void> => {
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(TRIPLES.length);
    for (const quad of TRIPLES) {
      await expect(store.query(
        `ASK { GRAPH <${finalized.sharedGraphUri}> { <${quad.subject}> <${quad.predicate}> ${quad.object} } }`,
      )).resolves.toEqual({ type: 'boolean', value: true });
    }
  };

  /** Run the real compound replace, then report an indeterminate outcome for it. */
  const dispatchIndeterminately = (): { restore: () => void } => {
    const atomicReplace = store.replaceGraphAndSubject!.bind(store);
    const spy = vi.spyOn(store, 'replaceGraphAndSubject').mockImplementation(async (...args) => {
      await atomicReplace(...args);
      throw indeterminateTimeout('replaceGraphAndSubject');
    });
    return { restore: () => spy.mockRestore() };
  };

  /** Reject the first durable-tail write (the SWM memory-layer stamp) with `failure`. */
  const failDurableTailOnce = (failure: unknown): { restore: () => void; fired: () => boolean } => {
    const insert = store.insert.bind(store);
    let fired = false;
    const spy = vi.spyOn(store, 'insert').mockImplementation(async (quads) => {
      const stampsSwmLayer = quads.some(
        (quad) => quad.predicate === MEMORY_LAYER_PREDICATE && quad.object === '"SWM"',
      );
      if (!fired && stampsSwmLayer) {
        fired = true;
        // The exact graph and its companion are already committed at this point.
        expect(await store.countQuads(finalized.sharedGraphUri)).toBe(TRIPLES.length);
        expect(await store.hasGraph(COMPANION_GRAPH)).toBe(true);
        throw failure;
      }
      return insert(quads);
    });
    return { restore: () => spy.mockRestore(), fired: () => fired };
  };

  return {
    store, publisher, queue, jobId, clock, finalized, attempt, expectExactSwmGraph,
    dispatchIndeterminately, failDurableTailOnce,
    hasCompletionMarker: () => publisher.hasSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT),
    workingMemoryCount: async () => (await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT)).length,
  };
}

describe('promote post-commit recovery', () => {
  it.each([
    ['a not-started store timeout', notStartedTimeout],
    ['a scheduler admission rejection', schedulerBusy],
  ])('retries a settlement failure of %s after an indeterminate dispatch and completes on replay', async (_label, failure) => {
    const settle = vi.fn<(committed: boolean | undefined) => void>();
    settle.mockImplementationOnce(() => { throw failure(); });
    const fixture = await createFixture(settle);

    const dispatch = fixture.dispatchIndeterminately();
    let first: Awaited<ReturnType<typeof fixture.attempt>>;
    try {
      first = await fixture.attempt();
    } finally {
      dispatch.restore();
    }
    expect(settle).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(first.failure).toMatchObject({
      name: 'PromoteRetryableFailureError',
      code: 'PROMOTE_RETRYABLE_FAILURE',
      cause: expect.objectContaining({ outcome: 'not_started' }),
    });
    expect(first.recorded).toMatchObject({
      retryable: true, classification: 'transient', diagnosticCode: 'PROMOTE_RETRYABLE_FAILURE',
    });
    const retrying = (await fixture.queue.getStatus(fixture.jobId))!;
    expect(retrying.state).toBe('failed_retrying');
    expect(retrying.attempt).toMatchObject({ count: 1, maxRetries: 5, nextRetryAt: fixture.clock.now() + 1_000 });
    // The compound commit landed; the tail never ran, so the share is not yet complete.
    await fixture.expectExactSwmGraph();
    expect(await fixture.store.hasGraph(COMPANION_GRAPH)).toBe(true);
    expect(await fixture.hasCompletionMarker()).toBe(false);

    fixture.clock.advance(1_000);
    expect(await fixture.attempt()).toEqual({});
    expect(settle).toHaveBeenLastCalledWith(true);
    const succeeded = (await fixture.queue.getStatus(fixture.jobId))!;
    expect(succeeded.state).toBe('succeeded');
    expect(succeeded.attempt.count).toBe(2);
    await fixture.expectExactSwmGraph();
    expect(await fixture.hasCompletionMarker()).toBe(true);
    expect(await fixture.workingMemoryCount()).toBe(0);
  });

  it.each([
    ['an indeterminate settlement failure after an indeterminate dispatch', indeterminateTimeout, 'indeterminate'],
    ['an untyped settlement failure after an indeterminate dispatch', () => new Error('settlement failed'), 'indeterminate'],
    ['a not-started settlement failure after a known commit', notStartedTimeout, 'committed'],
  ] as const)('keeps %s terminal', async (_label, failure, dispatch) => {
    const settle = vi.fn<(committed: boolean | undefined) => void>(() => { throw failure(); });
    const fixture = await createFixture(settle);

    const indeterminate = dispatch === 'indeterminate' ? fixture.dispatchIndeterminately() : undefined;
    let first: Awaited<ReturnType<typeof fixture.attempt>>;
    try {
      first = await fixture.attempt();
    } finally {
      indeterminate?.restore();
    }
    expect(settle).toHaveBeenCalledExactlyOnceWith(dispatch === 'indeterminate' ? undefined : true);
    expect(first.failure).toMatchObject({
      name: 'PromotePostCommitFailureError', code: 'PROMOTE_POST_COMMIT_FAILURE',
    });
    expect(first.recorded).toMatchObject({
      retryable: false, classification: 'fatal', diagnosticCode: 'PROMOTE_POST_COMMIT_FAILURE',
    });
    expect((await fixture.queue.getStatus(fixture.jobId))?.state).toBe('failed');
    await fixture.expectExactSwmGraph();
  });

  it('lets a scheduler admission rejection in the durable tail retry and repairs the tail on replay', async () => {
    const fixture = await createFixture(() => {});
    const injected = fixture.failDurableTailOnce(schedulerBusy());
    let first: Awaited<ReturnType<typeof fixture.attempt>>;
    try {
      first = await fixture.attempt();
    } finally {
      injected.restore();
    }
    expect(injected.fired()).toBe(true);
    // The raw storage error keeps its contract: not wrapped as post-commit, retryable by outcome.
    expect(first.failure).toBeInstanceOf(StoreSchedulerBusyError);
    expect(first.recorded).toMatchObject({ retryable: true, classification: 'transient' });
    expect(first.recorded?.diagnosticCode).toBeUndefined();
    expect((await fixture.queue.getStatus(fixture.jobId))?.state).toBe('failed_retrying');
    expect(await fixture.hasCompletionMarker()).toBe(false);
    expect(await fixture.workingMemoryCount()).toBe(TRIPLES.length);

    fixture.clock.advance(1_000);
    expect(await fixture.attempt()).toEqual({});
    expect((await fixture.queue.getStatus(fixture.jobId))?.state).toBe('succeeded');
    await fixture.expectExactSwmGraph();
    expect(await fixture.hasCompletionMarker()).toBe(true);
    expect(await fixture.workingMemoryCount()).toBe(0);
  });

  it('requeues a terminal post-commit failure through the recovery sweep and completes it on replay', async () => {
    const fixture = await createFixture(() => {});
    const injected = fixture.failDurableTailOnce(indeterminateTimeout());
    let first: Awaited<ReturnType<typeof fixture.attempt>>;
    try {
      first = await fixture.attempt();
    } finally {
      injected.restore();
    }
    expect(injected.fired()).toBe(true);
    expect(first.recorded).toMatchObject({
      retryable: false, classification: 'fatal', diagnosticCode: 'PROMOTE_POST_COMMIT_FAILURE',
    });
    expect((await fixture.queue.getStatus(fixture.jobId))?.state).toBe('failed');

    // The automatic sweep applies the same recovery the manual route performs,
    // within the job's own retry budget.
    expect(await fixture.queue.recoverPostCommitFailures()).toEqual([{
      jobId: fixture.jobId, action: 'requeued', attempt: 1, maxAttempts: 5,
      nextRetryAt: fixture.clock.now() + 1_000,
    }]);
    expect((await fixture.queue.getStatus(fixture.jobId))?.state).toBe('failed_retrying');
    expect(await fixture.queue.claimNext('worker')).toBeNull();

    fixture.clock.advance(1_000);
    expect(await fixture.attempt()).toEqual({});
    const succeeded = (await fixture.queue.getStatus(fixture.jobId))!;
    expect(succeeded.state).toBe('succeeded');
    expect(succeeded.attempt.count).toBe(2);
    await fixture.expectExactSwmGraph();
    expect(await fixture.hasCompletionMarker()).toBe(true);
    expect(await fixture.workingMemoryCount()).toBe(0);
    expect(await fixture.queue.recoverPostCommitFailures()).toEqual([]);
  });
});
