/**
 * RFC-73 P1b: every queue-graph mutation and the pre-queue reads the publisher owns carry a
 * unique `source` label, so a store-scheduler rejection (P1a) names the operation that issued
 * it. The static check (`query-source-coverage.test.ts`) proves a label is PRESENT at each call
 * site; this file proves the exact label reaches the store at RUNTIME, per site, through a
 * recording proxy. Behavior is otherwise unchanged.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher, TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import {
  CONTROL_LIFECYCLE_KEY,
  DEFAULT_CONTROL_GRAPH_URI,
  DEFAULT_JOURNAL_GRAPH_URI,
  DEFAULT_WALLET_LOCK_GRAPH_URI,
  jobSubject,
  requestSubject,
  walletLockSubject,
} from '../src/async-lift-control-plane.js';
import { jobSubject as promoteJobSubject } from '../src/async-promote-queue-utils.js';
import { AsyncLiftWalletPersistence } from '../src/async-lift-wallet-persistence.js';
import { persistLiftJobRecord } from '../src/job-record-atomic-write.js';
import { resolveKnowledgeAssetWorkspaceHead } from '../src/workspace-resolution.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';

interface RecordedCall {
  method: string;
  /** `options.source` of the call, or undefined when the call carried none. */
  source: string | undefined;
  options: unknown;
  /** The first argument (a pattern, a quad list, a SPARQL string, a graph URI). */
  first: unknown;
}

/** Index of the `QueryOptions` argument for each recorded store method. */
const OPTIONS_INDEX: Readonly<Record<string, number>> = {
  query: 1,
  insert: 1,
  delete: 1,
  deleteByPattern: 1,
  deleteByPatternWithoutCount: 1,
  replaceSubject: 3,
  replaceSubjectAndInsert: 4,
};

function recordingStore(inner: OxigraphStore, hidden: readonly string[] = []) {
  const calls: RecordedCall[] = [];
  const store = new Proxy(inner, {
    get(target, prop) {
      if (typeof prop === 'string' && hidden.includes(prop)) return undefined;
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const optionsIndex = typeof prop === 'string' ? OPTIONS_INDEX[prop] : undefined;
      if (optionsIndex === undefined) return value.bind(target);
      return (...args: unknown[]) => {
        const options = args[optionsIndex];
        calls.push({
          method: prop as string,
          source: (options as { source?: string } | undefined)?.source,
          options,
          first: args[0],
        });
        return value.apply(target, args);
      };
    },
  }) as unknown as TripleStore;
  return { store, calls };
}

/** The label(s) recorded for mutations targeting one subject. */
function sourcesForSubject(calls: RecordedCall[], subject: string): Array<string | undefined> {
  return calls
    .filter((c) => (c.first as { subject?: string } | undefined)?.subject === subject)
    .map((c) => c.source);
}

describe('RFC-73 P1b queue-graph source labels', () => {
  let inner: OxigraphStore;

  beforeEach(() => {
    inner = new OxigraphStore();
  });

  function liftPublisher(store: TripleStore, journalWrites = false): TripleStoreAsyncLiftPublisher {
    let ids = 0;
    let now = 1_000;
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
      journalWrites,
    });
  }

  it('labels the share queue job delete (clearTerminalJob)', async () => {
    const { store, calls } = recordingStore(inner);
    let id = 0;
    const queue = new TripleStoreAsyncPromoteQueue(store, {
      now: () => 1_000_000,
      idGenerator: () => `job-${++id}`,
    });
    const jobId = await queue.enqueue({
      contextGraphId: 'graphify', subGraphName: 'code', assertionName: 'shard-1', entities: 'all',
    });
    const claimed = await queue.claimNext('worker-1');
    await queue.fail(jobId, claimed!.lease!.claimToken, {
      message: 'permanent', retryable: false, classification: 'permanent', recordedAt: 1_000_000,
    });
    calls.length = 0;

    expect(await queue.clearTerminalJob(jobId)).toEqual({ outcome: 'cleared' });

    expect(sourcesForSubject(calls, promoteJobSubject(jobId))).toEqual(['publisher.asyncPromote.deleteJob']);
  });

  it('labels the lift job and request deletes (cancel of an accepted job)', async () => {
    const { store, calls } = recordingStore(inner);
    const publisher = liftPublisher(store);
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    calls.length = 0;

    await publisher.cancel(jobId);

    expect(sourcesForSubject(calls, jobSubject(jobId))).toEqual(['publisher.asyncLift.deleteJob']);
    expect(sourcesForSubject(calls, requestSubject(jobId))).toEqual(['publisher.asyncLift.deleteJobRequest']);
  });

  it('labels the VM publish intent index backfill insert', async () => {
    const { store, calls } = recordingStore(inner);
    const publisher = liftPublisher(store);
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    // Simulate a pre-index job by stripping the lifecycle index triple.
    await inner.deleteByPattern({ predicate: CONTROL_LIFECYCLE_KEY, graph: DEFAULT_CONTROL_GRAPH_URI });
    calls.length = 0;

    expect(await publisher.ensureVmPublishIntentIndex()).toBe(1);

    const inserts = calls.filter((c) => c.method === 'insert');
    expect(inserts.map((c) => c.source)).toEqual(['publisher.asyncLift.writeVmPublishIntentIndex']);
  });

  it('labels the wallet lock delete', async () => {
    const { store, calls } = recordingStore(inner);
    const persistence = new AsyncLiftWalletPersistence(
      store, DEFAULT_CONTROL_GRAPH_URI, DEFAULT_WALLET_LOCK_GRAPH_URI,
    );

    await persistence.delete('wallet-1');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      first: { subject: walletLockSubject('wallet-1'), graph: DEFAULT_WALLET_LOCK_GRAPH_URI },
      source: 'publisher.asyncLift.walletLock.delete',
    });
  });

  it('labels the request insert and the fallback delete and insert of a job record write', async () => {
    const seed = liftPublisher(inner);
    const jobId = await seed.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const job = (await seed.getStatus(jobId))!;

    // Neither atomic capability: the request-first insert, then delete + insert of the job row.
    const { store, calls } = recordingStore(inner, ['replaceSubjectAndInsert', 'replaceSubject']);
    await persistLiftJobRecord(store, DEFAULT_CONTROL_GRAPH_URI, job);

    const mutations = calls.filter((c) => c.method !== 'query');
    expect(mutations.map((c) => [c.method, c.source])).toEqual([
      ['insert', 'publisher.asyncLift.writeJobRequest'],
      ['deleteByPatternWithoutCount', 'publisher.asyncLift.writeJob'],
      ['insert', 'publisher.asyncLift.writeJob'],
    ]);
    expect((mutations[1]!.first as { subject: string }).subject).toBe(jobSubject(jobId));
  });

  it('labels the admission journal entry insert', async () => {
    const { store, calls } = recordingStore(inner);
    const publisher = liftPublisher(store, true);

    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    const journalInserts = calls.filter(
      (c) => c.method === 'insert'
        && (c.first as Array<{ graph: string }>).some((q) => q.graph === DEFAULT_JOURNAL_GRAPH_URI),
    );
    expect(journalInserts.map((c) => c.source)).toEqual(['publisher.asyncLift.appendJournalEntry']);
  });

  it('labels the SWM share-complete ASK', async () => {
    const { store, calls } = recordingStore(inner);
    const publisher = new DKGPublisher({
      store,
      chain: new MockChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    calls.length = 0;

    expect(
      await publisher.hasSwmShareComplete('cg-label', 'asset', '0x1234567890abcdef1234567890abcdef12345678'),
    ).toBe(false);

    const asks = calls.filter((c) => c.method === 'query' && String(c.first).startsWith('ASK'));
    expect(asks.map((c) => c.source)).toEqual(['publisher.hasSwmShareComplete']);
  });

  describe('workspace head read', () => {
    const UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';

    it('defaults to publisher.workspaceHead.acquire', async () => {
      const { store, calls } = recordingStore(inner);

      await resolveKnowledgeAssetWorkspaceHead({
        store, graphManager: new GraphManager(inner), contextGraphId: 'cg-head', kaUal: UAL,
      });

      expect(calls.map((c) => c.source)).toEqual(['publisher.workspaceHead.acquire']);
    });

    it('passes a caller-supplied QueryOptions through unchanged', async () => {
      const { store, calls } = recordingStore(inner);
      const queryOptions = { source: 'caller.source', priority: 'background' as const };

      await resolveKnowledgeAssetWorkspaceHead({
        store, graphManager: new GraphManager(inner), contextGraphId: 'cg-head', kaUal: UAL, queryOptions,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.options).toBe(queryOptions);
    });
  });
});
