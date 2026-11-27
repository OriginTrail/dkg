/**
 * OT-RFC-73 AC1/AC2, publisher side: the scripted workload the boundary oracle, the static IRI-coverage test and
 * the lane-trace equivalence test all drive.
 *
 * It runs a real `TripleStoreAsyncLiftPublisher` (journal writes on) over an in-memory store behind the recording
 * proxy of `queue-boundary-oracle.ts`, and touches every queue call site the publisher owns:
 *
 *   admission (duplicate check, job write, journal append/allocate), point reads (status, job-by-intent,
 *   journal-by-key), claim (candidate selection, wallet lock, job write), worker processing with data-plane reads
 *   inside the handler, retry (bulk list under the claim lock), terminal clear, cancel, stale-lock sweep,
 *   reconciliation, boot backfill, the unlocked full-history reads and the P1b queue-usage COUNTs.
 *
 * `stack: 'atomic'` runs on a store with the atomic subject-replace capabilities, `'fallback'` on one without them,
 * so `replaceSubjectAtomicallyOrFallback` and the job-record writer take both of their paths.
 */
import {
  GraphManager,
  OxigraphStore,
  activeDefaultStoreWorkPriority,
  withDefaultStoreWorkPriority,
  type StoreWorkPriority,
} from '@origintrail-official/dkg-storage';
import {
  AsyncLiftRunner,
  QuorumUnmetError,
  TripleStoreAsyncLiftPublisher,
  createPublisherRetention,
  type AsyncLiftPublisherConfig,
  type PublisherRetentionMode,
} from '../../src/index.js';
import { CONTROL_LIFECYCLE_KEY, DEFAULT_CONTROL_GRAPH_URI } from '../../src/async-lift-control-plane.js';
import { readLiftJournalEntryCount, readLiftQueueDepth } from '../../src/async-queue-depth.js';
import { kaVmPublishRequest, stageKnowledgeAssetShareSnapshot } from '../../../../scripts/testing/ka-vm-publish.js';
import { completeResult } from './journal-completion.js';
import { recordLiftStore, type RecordedStoreCall } from './queue-boundary-oracle.js';
import { NOW, at, createRetentionTemplates, fin, seedKeyed } from './lift-retention-fixtures.js';

export type PublisherStack = 'atomic' | 'fallback';

/** Taking these away is what a store without the atomic capabilities looks like to the writers. */
export const FALLBACK_HIDDEN: readonly string[] = ['replaceSubjectAndInsert', 'replaceSubject'];

/** The data-plane probe the worker handler makes (worker verification reads go through the same store object). */
export const WORKER_PROBE_SOURCES = ['test.worker.preflight', 'test.worker.execute'] as const;

export interface HandlerObservation {
  readonly phase: (typeof WORKER_PROBE_SOURCES)[number];
  /** The ambient lane the handler ran under. */
  readonly ambient: StoreWorkPriority | undefined;
}

export interface WorkloadRun {
  readonly stack: PublisherStack;
  readonly calls: RecordedStoreCall[];
  readonly handlerObservations: HandlerObservation[];
}

const DATA_PLANE_PROBE = 'SELECT ?s WHERE { GRAPH <did:dkg:context-graph:music-social> { ?s ?p ?o } } LIMIT 1';

/** Deterministic clock and ids; `advance` is the only way to move time other than the per-read tick. */
function clockAndIds() {
  let now = 1_000;
  let jobs = 0;
  let tokens = 0;
  return {
    config: {
      now: () => ++now,
      idGenerator: () => `job-${++jobs}`,
      claimTokenGenerator: () => `token-${++tokens}`,
    } satisfies Pick<AsyncLiftPublisherConfig, 'now' | 'idGenerator' | 'claimTokenGenerator'>,
    advance: (ms: number) => { now += ms; },
  };
}

export interface WorkerHandlerControl {
  /** Make the next `execute` fail with a retryable unmet-quorum error instead of finishing the publish. */
  failNext: boolean;
}

/**
 * A VM-publish handler whose `preflight` and `execute` each make one data-plane read through the recorded store,
 * as the daemon's handler does (worker verification reads). It records the ambient lane it runs under.
 */
export function workerHandler(
  store: { query(sparql: string, options?: { source?: string }): Promise<unknown> },
  observations: HandlerObservation[],
  control: WorkerHandlerControl = { failNext: false },
): NonNullable<AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler']> {
  return {
    preflight: async () => {
      observations.push({ phase: 'test.worker.preflight', ambient: activeDefaultStoreWorkPriority() });
      await store.query(DATA_PLANE_PROBE, { source: 'test.worker.preflight' });
      return { action: 'execute' as const };
    },
    execute: async ({ publishOptions }) => {
      observations.push({ phase: 'test.worker.execute', ambient: activeDefaultStoreWorkPriority() });
      await store.query(DATA_PLANE_PROBE, { source: 'test.worker.execute' });
      if (control.failNext) {
        control.failNext = false;
        throw new QuorumUnmetError({ collected: 2, required: 3, dialled: 2 });
      }
      await publishOptions.onBeforeBroadcast?.({ txHash: completeResult().onChainResult.txHash, operationKind: 'create' });
      await publishOptions.onBroadcastAccepted?.({ txHash: completeResult().onChainResult.txHash, operationKind: 'create' });
      return completeResult();
    },
  };
}

/** One recorded run of the whole scripted workload on `stack`. */
export async function runPublisherWorkload(
  stack: PublisherStack,
  options: { ambient?: StoreWorkPriority } = {},
): Promise<WorkloadRun> {
  const inner = new OxigraphStore();
  try {
    const { store, calls } = recordLiftStore(inner, stack === 'fallback' ? FALLBACK_HIDDEN : []);
    const handlerObservations: HandlerObservation[] = [];
    const control: WorkerHandlerControl = { failNext: false };
    const clock = clockAndIds();
    const handler = workerHandler(store, handlerObservations, control);
    // Two instances over one store, as the daemon has them. One selects its claim candidate with the combined
    // retry-aware read, the other (retry off) with the plain accepted read.
    const retrying = new TripleStoreAsyncLiftPublisher(store, {
      ...clock.config, journalWrites: true, autoRetryEnabled: true, knowledgeAssetVmPublishHandler: handler,
    });
    const plain = new TripleStoreAsyncLiftPublisher(store, {
      ...clock.config, journalWrites: true, autoRetryEnabled: false, knowledgeAssetVmPublishHandler: handler,
    });
    const scope = <T>(work: () => Promise<T>): Promise<T> =>
      options.ambient === undefined ? work() : withDefaultStoreWorkPriority(options.ambient, work);
    const request = (name: string) => kaVmPublishRequest({ name });
    await stageKnowledgeAssetShareSnapshot({ store: inner, graphManager: new GraphManager(inner) });

    await scope(async () => {
      // Admission: duplicate check, job write, journal allocate + append. Then the point reads.
      const first = await plain.enqueueKnowledgeAssetVmPublish(request('albums'));
      await plain.getStatus(first);
      await plain.lookupKnowledgeAssetVmPublishJobByIntent({ contextGraphId: 'music-social', name: 'albums' });
      await plain.readJournalByJob(first);
      await plain.readJournalByIntent({ contextGraphId: 'music-social', name: 'albums' });

      // Cancel of an accepted job (job and request deletes).
      const cancelled = await plain.enqueueKnowledgeAssetVmPublish(request('cancelled'));
      await plain.cancel(cancelled);

      // Claim and worker processing, selecting the candidate with the plain accepted read.
      await plain.processNext('wallet-1');

      // A retryable failure, the bulk retry (its list runs under the claim lock) and a second run of the job,
      // selecting the candidate with the combined read.
      await retrying.enqueueKnowledgeAssetVmPublish(request('albums-retry'));
      control.failNext = true;
      await retrying.processNext('wallet-2');
      await retrying.retry();
      await retrying.processNext('wallet-3');

      // A claim left behind, then the stale-lock sweep and reconciliation of recovery.
      const abandoned = await retrying.enqueueKnowledgeAssetVmPublish(request('albums-abandoned'));
      await retrying.claimNext('wallet-4');
      clock.advance(6 * 60 * 1000);
      await retrying.recover();
      await retrying.reconcileTransactions();
      await retrying.getStatus(abandoned);

      // The unlocked full-history reads and the boot backfill (one job loses its index row first).
      await retrying.list();
      await retrying.getStats();
      await inner.deleteByPattern({ predicate: CONTROL_LIFECYCLE_KEY, graph: DEFAULT_CONTROL_GRAPH_URI });
      await retrying.ensureVmPublishIntentIndex();

      // Terminal clear (its list is unlocked; the per-job removal is not).
      await retrying.clear('finalized');

      // The P1b monitoring COUNTs go through the same store object.
      await readLiftQueueDepth(store);
      await readLiftJournalEntryCount(store);
    });
    await plain.drainDetachedExecutions();
    await retrying.drainDetachedExecutions();
    return { stack, calls, handlerObservations };
  } finally {
    await inner.close();
  }
}

/**
 * OT-RFC-73 P9a: the bounded reads a client drives, on the same recorded store. Kept out of `runPublisherWorkload`
 * because the AC2 lane trace compares that workload, call for call, with the base SHA, which has no page read.
 *
 * Three jobs are admitted (the control calls), then a walk of the listing in pages of two, a graph-scoped page, a
 * status page and the stats COUNT. The page and stats calls must resolve to the caller's lane and carry no control tag.
 */
export async function runPublisherPagingScenario(
  stack: PublisherStack,
  options: { ambient?: StoreWorkPriority } = {},
): Promise<WorkloadRun> {
  const inner = new OxigraphStore();
  try {
    const { store, calls } = recordLiftStore(inner, stack === 'fallback' ? FALLBACK_HIDDEN : []);
    const publisher = new TripleStoreAsyncLiftPublisher(store, { ...clockAndIds().config, journalWrites: true });
    const scope = <T>(work: () => Promise<T>): Promise<T> =>
      options.ambient === undefined ? work() : withDefaultStoreWorkPriority(options.ambient, work);
    await scope(async () => {
      for (const name of ['albums', 'songs', 'artists']) {
        await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name }));
      }
      const first = await publisher.listPage({ limit: 2 });
      await publisher.listPage({ limit: 2, cursor: first.nextCursor! });
      await publisher.listPage({ contextGraphId: 'music-social', status: 'accepted' });
      await publisher.getStats();
    });
    return { stack, calls, handlerObservations: [] };
  } finally {
    await inner.close();
  }
}

/**
 * The publisher's wake path (AC1 check 1, the wake-path scenario): a real `AsyncLiftRunner` is started outside any
 * lane, then a job is admitted from a caller running in `enqueueAmbient`. The enqueue's journal settlement pokes the
 * runner (`notifyWorkAvailable`), the wallet loop wakes and runs `processNext`: claim, then `processClaim`, whose
 * handler makes data-plane reads. The handler must not inherit the enqueue caller's lane, and no data-plane call may
 * carry a control tag.
 */
export async function runPublisherWakeScenario(
  stack: PublisherStack,
  enqueueAmbient: StoreWorkPriority | undefined,
): Promise<WorkloadRun> {
  const inner = new OxigraphStore();
  try {
    const { store, calls } = recordLiftStore(inner, stack === 'fallback' ? FALLBACK_HIDDEN : []);
    const handlerObservations: HandlerObservation[] = [];
    const clock = clockAndIds();
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      ...clock.config, journalWrites: true, knowledgeAssetVmPublishHandler: workerHandler(store, handlerObservations),
    });
    await stageKnowledgeAssetShareSnapshot({ store: inner, graphManager: new GraphManager(inner) });
    // A poll interval far beyond the test: only the wake can start the claim in time.
    const runner = new AsyncLiftRunner({ publisher, walletIds: ['wallet-1'], pollIntervalMs: 120_000, recoveryIntervalMs: 120_000 });
    await runner.start();
    try {
      const admit = () => publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const jobId = await (enqueueAmbient === undefined ? admit() : withDefaultStoreWorkPriority(enqueueAmbient, admit));
      const deadline = Date.now() + 10_000;
      while ((await publisher.getStatus(jobId))?.status !== 'finalized') {
        if (Date.now() > deadline) throw new Error('the woken wallet loop did not finish the job');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await runner.stop();
    }
    return { stack, calls, handlerObservations };
  } finally {
    await inner.close();
  }
}

/**
 * OT-RFC-73 P11: one retention pass on the same recorded store. Kept out of `runPublisherWorkload` for the same reason as the paging scenario: the base SHA has no
 * retention. The population (seeded through the inner store, so only the sweep's own calls are recorded) has a key whose records all go, a key an older failed job
 * keeps, a key with a live successor and a young record; the pass runs to the end of the scan, in slices of two.
 */
export async function runPublisherRetentionScenario(
  stack: PublisherStack,
  options: { mode: Exclude<PublisherRetentionMode, 'off'>; ambient?: StoreWorkPriority },
): Promise<WorkloadRun & { readonly deleted: number; readonly wouldDelete: number }> {
  const inner = new OxigraphStore();
  try {
    const { store, calls } = recordLiftStore(inner, stack === 'fallback' ? FALLBACK_HIDDEN : []);
    await seedKeyed(inner, await createRetentionTemplates(), [
      fin('a1', 'a', 10), fin('a2', 'a', 20), fin('a3', 'a', 30),
      at('x', 'b', 'retryable', 10), fin('b1', 'b', 20),
      fin('c1', 'c', 10), at('c2', 'c', 'accepted', 50),
      fin('young', 'd', 99.99),
    ]);
    const publisher = new TripleStoreAsyncLiftPublisher(store, { ...clockAndIds().config, journalWrites: true });
    const retention = createPublisherRetention({
      access: publisher.retentionAccess(), mode: options.mode, intervalMs: 60_000, batchSize: 4, sliceSize: 2,
      now: () => NOW, monotonicNow: () => 0, logger: { info: () => undefined, warn: () => undefined },
    });
    let deleted = 0, wouldDelete = 0;
    const scope = <T>(work: () => Promise<T>): Promise<T> =>
      options.ambient === undefined ? work() : withDefaultStoreWorkPriority(options.ambient, work);
    await scope(async () => {
      for (let i = 0; i < 6; i++) {
        const result = await retention.runBatch();
        deleted += result.deleted; wouldDelete += result.wouldDelete;
        if (!result.hasMore && result.scanned === 0) break;
      }
    });
    return { stack, calls, handlerObservations: [], deleted, wouldDelete };
  } finally {
    await inner.close();
  }
}
