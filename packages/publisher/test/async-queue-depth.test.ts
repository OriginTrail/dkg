import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type QueryOptions, type TripleStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import {
  readLiftJournalEntryCount,
  readLiftQueueDepth,
  readShareQueueDepth,
} from '../src/async-queue-depth.js';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI, PROMOTE_STATE, jobSubject, literal } from '../src/async-promote-queue-utils.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';

function queryRecorder(inner: OxigraphStore) {
  const calls: Array<{ sparql: string; options: QueryOptions | undefined }> = [];
  const store: Pick<TripleStore, 'query'> = {
    query: vi.fn(async (sparql: string, options?: QueryOptions) => {
      calls.push({ sparql, options });
      return inner.query(sparql, options);
    }),
  };
  return { store, calls };
}

describe('async queue depth readers', () => {
  let inner: OxigraphStore;

  beforeEach(() => {
    inner = new OxigraphStore();
  });

  describe('share queue', () => {
    function queue(): TripleStoreAsyncPromoteQueue {
      let id = 0;
      return new TripleStoreAsyncPromoteQueue(inner, { now: () => 1_000, idGenerator: () => `job-${++id}` });
    }
    const request = (name: string) => ({ contextGraphId: 'cg', subGraphName: 'code', assertionName: name, entities: 'all' as const });

    it('counts jobs per state and fills the states with none', async () => {
      const q = queue();
      await q.enqueue(request('a'));
      await q.enqueue(request('b'));
      await q.enqueue(request('c'));
      await q.claimNext('worker-1');

      expect(await readShareQueueDepth(inner)).toEqual({
        queued: 2, running: 1, failed_retrying: 0, succeeded: 0, failed: 0,
      });
    });

    it('reads zeros from a queue that was never used', async () => {
      expect(await readShareQueueDepth(new OxigraphStore())).toEqual({
        queued: 0, running: 0, failed_retrying: 0, succeeded: 0, failed: 0,
      });
    });

    it('ignores a state this build does not know, including names that collide with object keys', async () => {
      await queue().enqueue(request('a'));
      await inner.insert([
        { subject: jobSubject('alien-1'), predicate: PROMOTE_STATE, object: literal('from_the_future'), graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI },
        { subject: jobSubject('alien-2'), predicate: PROMOTE_STATE, object: literal('constructor'), graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI },
        { subject: jobSubject('bare'), predicate: PROMOTE_STATE, object: literal('queued'), graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI },
      ]);

      const depth = await readShareQueueDepth(inner);
      expect(depth.queued).toBe(2);
      expect(Object.keys(depth).sort()).toEqual(['failed', 'failed_retrying', 'queued', 'running', 'succeeded']);
    });

    it('reads in the background lane under its own source, with a deadline signal, from the given graph', async () => {
      const { store, calls } = queryRecorder(inner);
      const signal = new AbortController().signal;

      await readShareQueueDepth(store, { signal, graphUri: 'urn:test:share-graph' });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.options).toEqual({ source: 'publisher.queueUsage.share', priority: 'background', signal });
      expect(calls[0]!.sparql).toContain('GRAPH <urn:test:share-graph>');
      expect(calls[0]!.sparql).toMatch(/GROUP BY \?state$/);
      expect(calls[0]!.sparql).not.toMatch(/OFFSET/i);
    });

    it('omits the signal when there is none', async () => {
      const { store, calls } = queryRecorder(inner);
      await readShareQueueDepth(store);
      expect(calls[0]!.options).toEqual({ source: 'publisher.queueUsage.share', priority: 'background' });
      expect(calls[0]!.sparql).toContain(`GRAPH <${DEFAULT_PROMOTE_CONTROL_GRAPH_URI}>`);
    });

    it('accepts a state the backend returns without its quotes, and ignores one that is not a string', async () => {
      const store: Pick<TripleStore, 'query'> = {
        query: async () => ({
          type: 'bindings',
          bindings: [
            { state: 'queued', n: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' },
            { state: '"running"', n: '"1"' },
            { state: '42', n: '"9"' },
          ],
        }),
      };
      expect(await readShareQueueDepth(store)).toEqual({
        queued: 2, running: 1, failed_retrying: 0, succeeded: 0, failed: 0,
      });
    });

    it('rejects when the store answers something other than bindings', async () => {
      const store: Pick<TripleStore, 'query'> = { query: async () => ({ type: 'boolean', value: true }) };
      await expect(readShareQueueDepth(store)).rejects.toThrow(/bindings/);
    });
  });

  describe('publisher queue', () => {
    function publisher(journalWrites = false): TripleStoreAsyncLiftPublisher {
      let now = 1_000;
      let id = 0;
      return new TripleStoreAsyncLiftPublisher(inner, {
        now: () => ++now,
        idGenerator: () => `job-${++id}`,
        journalWrites,
      });
    }
    const vmPublish = (n: number) => kaVmPublishRequest({
      name: `asset-${n}`,
      shareOperationId: `share-op-${n}`,
      intentKey: `sha256:${String(n).repeat(64)}`,
    });

    it('counts jobs per state, with the unclaimed backlog under accepted, and fills the states with none', async () => {
      const p = publisher();
      await p.enqueueKnowledgeAssetVmPublish(vmPublish(1));
      await p.enqueueKnowledgeAssetVmPublish(vmPublish(2));
      await p.enqueueKnowledgeAssetVmPublish(vmPublish(3));
      await p.claimNext('wallet-1');

      expect(await readLiftQueueDepth(inner)).toEqual({
        accepted: 2, claimed: 1, validated: 0, broadcast: 0, included: 0, finalized: 0, failed: 0,
      });
    });

    it('reads in the background lane under its own source and ignores unknown states', async () => {
      const { store, calls } = queryRecorder(inner);
      const signal = new AbortController().signal;

      expect((await readLiftQueueDepth(store, { signal })).accepted).toBe(0);

      expect(calls[0]!.options).toEqual({ source: 'publisher.queueUsage.lift', priority: 'background', signal });
      expect(calls[0]!.sparql).toContain('GROUP BY ?state');
    });

    it('counts journal entries in the journal graph, in the background lane under its own source', async () => {
      const p = publisher(true);
      await p.enqueueKnowledgeAssetVmPublish(vmPublish(1));
      await p.enqueueKnowledgeAssetVmPublish(vmPublish(2));
      await p.claimNext('wallet-1');
      const { store, calls } = queryRecorder(inner);
      const signal = new AbortController().signal;

      // Two admissions and one claim, in an append-only journal.
      expect(await readLiftJournalEntryCount(store, { signal })).toBe(3);
      expect(calls[0]!.options).toEqual({ source: 'publisher.queueUsage.liftJournal', priority: 'background', signal });
    });

    it('reports zero journal entries for an empty journal and rejects a malformed count', async () => {
      expect(await readLiftJournalEntryCount(inner)).toBe(0);
      const none: Pick<TripleStore, 'query'> = { query: async () => ({ type: 'bindings', bindings: [] }) };
      expect(await readLiftJournalEntryCount(none)).toBe(0);
      const bad: Pick<TripleStore, 'query'> = { query: async () => ({ type: 'bindings', bindings: [{ n: 'many' }] }) };
      await expect(readLiftJournalEntryCount(bad)).rejects.toThrow(/integer/);
    });
  });
});
