import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, UnsupportedTripleStoreCapabilityError, controlStoreOptions, type Quad, type QueryOptions, type TripleStore } from '@origintrail-official/dkg-storage';
import { persistLiftJobRecord } from '../src/job-record-atomic-write.js';
import { TripleStoreAsyncLiftPublisher } from '../src/async-lift-publisher-impl.js';
import {
  DEFAULT_CONTROL_GRAPH_URI,
  DEFAULT_JOURNAL_GRAPH_URI,
  jobSubject,
  requestSubject,
  serializeJobRecord,
} from '../src/async-lift-control-plane.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';

// Local structural contract lets the first-red run exercise the current publisher without
// importing an unimplemented storage export or depending on rebuilt package declarations.
type CompoundCall = {
  graph: string; subject: string; replacement: Quad[]; inserts: Quad[]; options?: QueryOptions;
};
type Hooks = {
  beforePrimary?: () => Promise<void>;
  beforeJournalRead?: () => Promise<void>;
  beforeJournalInsert?: () => Promise<void>;
};
const stores: OxigraphStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  return { release, reached, wait: async () => { entered(); await held; } };
}

function fixture(hooks: Hooks = {}) {
  const inner = new OxigraphStore();
  stores.push(inner);
  const compoundCalls: CompoundCall[] = [];
  const separateRequestInserts: Quad[][] = [];
  let now = 1_000;
  let ids = 0;
  let store!: TripleStore;
  store = new Proxy(inner, {
    get(target, property) {
      if (property === 'replaceSubjectAndInsert') {
        return async function (
          this: unknown, graph: string, subject: string, replacement: Quad[],
          inserts: Quad[], options?: QueryOptions,
        ) {
          expect(this).toBe(store);
          compoundCalls.push({ graph, subject, replacement, inserts, options });
          await hooks.beforePrimary?.();
          // A recording adapter over the real RDF store proves publisher orchestration only.
          // Backend atomic visibility is deliberately left to the separate storage/live tests.
          await target.insert(inserts, options);
          await target.replaceSubject(graph, subject, replacement, options);
        };
      }
      if (property === 'replaceSubject') {
        return async (graph: string, subject: string, quads: Quad[], options?: QueryOptions) => {
          if (graph === DEFAULT_CONTROL_GRAPH_URI) await hooks.beforePrimary?.();
          await target.replaceSubject(graph, subject, quads, options);
        };
      }
      if (property === 'insert') {
        return async (quads: Quad[], options?: QueryOptions) => {
          if (quads.some((q) => q.graph === DEFAULT_CONTROL_GRAPH_URI
            && q.subject.startsWith(requestSubject('')))) separateRequestInserts.push(quads);
          if (quads.some((q) => q.graph === DEFAULT_JOURNAL_GRAPH_URI)) {
            await hooks.beforeJournalInsert?.();
          }
          await target.insert(quads, options);
        };
      }
      if (property === 'query') {
        return async (query: string, options?: QueryOptions) => {
          if (options?.source === 'publisher.asyncLift.allocateJournalSeq') {
            await hooks.beforeJournalRead?.();
          }
          return target.query(query, options);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const publisher = new TripleStoreAsyncLiftPublisher(store, {
    now: () => ++now, idGenerator: () => `job-${++ids}`, journalWrites: true,
  });
  const work = vi.fn();
  publisher.reconciliationScheduling.attachScheduler({
    onReconciliationDemand() {}, onWalletRelease() {}, onWorkAvailable: work,
  });
  return { inner, publisher, compoundCalls, separateRequestInserts, work };
}

async function subjectRows(store: TripleStore, graph: string, subject: string) {
  const result = await store.query(`SELECT ?p ?o WHERE { GRAPH <${graph}> { <${subject}> ?p ?o } }`);
  if (result.type !== 'bindings') throw new Error('Expected RDF bindings');
  return result.bindings.map((row) => JSON.stringify([row['p'], row['o']])).sort();
}

async function graphRows(store: TripleStore, graph: string) {
  const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  if (result.type !== 'bindings') throw new Error('Expected RDF bindings');
  return result.bindings.map((row) => JSON.stringify([row['s'], row['p'], row['o']])).sort();
}

describe('async-lift primary request/job persistence', () => {
  it.each(['admission', 'claimed-to-validated'] as const)(
    'uses one receiver-bound compound primary call for %s, with no separate request insert',
    async (stage) => {
      const { publisher, compoundCalls, separateRequestInserts } = fixture();
      let jobId: string;
      if (stage === 'admission') {
        jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      } else {
        jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
        await publisher.claimNext('wallet-1');
        compoundCalls.length = 0;
        separateRequestInserts.length = 0;
        await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      }
      const job = await publisher.getStatus(jobId);
      expect(job?.status).toBe(stage === 'admission' ? 'accepted' : 'validated');
      const record = serializeJobRecord(job!, DEFAULT_CONTROL_GRAPH_URI);
      expect(compoundCalls).toHaveLength(1);
      expect(compoundCalls[0]).toEqual({
        graph: DEFAULT_CONTROL_GRAPH_URI, subject: record.jobRef,
        replacement: record.jobQuads, inserts: record.requestQuads,
        options: controlStoreOptions('publisher', 'publisher.asyncLift.writeJob'),
      });
      expect(separateRequestInserts).toEqual([]);
    },
  );

  it.each(['missing', 'partial'] as const)(
    'repairs %s request rows while retaining extra request rows and unrelated RDF',
    async (damage) => {
      const { inner, publisher } = fixture();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      await publisher.claimNext('wallet-1');
      const siblingId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'other' }));
      const extra: Quad = {
        subject: requestSubject(jobId), predicate: 'urn:test:extra-request-fact',
        object: '"retained"', graph: DEFAULT_CONTROL_GRAPH_URI,
      };
      const unrelated: Quad = { ...extra, subject: 'urn:test:other', graph: 'urn:test:other-graph' };
      await inner.insert([extra, unrelated]);
      const expectedRequest = await subjectRows(inner, DEFAULT_CONTROL_GRAPH_URI, requestSubject(jobId));
      const siblingBefore = await subjectRows(inner, DEFAULT_CONTROL_GRAPH_URI, jobSubject(siblingId));
      const otherBefore = await graphRows(inner, unrelated.graph);
      if (damage === 'missing') {
        await inner.deleteByPattern({ graph: DEFAULT_CONTROL_GRAPH_URI, subject: requestSubject(jobId) });
        await inner.insert([extra]);
      } else {
        const current = await publisher.getStatus(jobId);
        const canonicalRequest = serializeJobRecord(current!, DEFAULT_CONTROL_GRAPH_URI).requestQuads;
        const removed = await inner.deleteByPattern({
          graph: DEFAULT_CONTROL_GRAPH_URI, subject: requestSubject(jobId),
          predicate: canonicalRequest[0]!.predicate,
        });
        expect(removed).toBe(1);
      }
      const damagedRequest = await subjectRows(inner, DEFAULT_CONTROL_GRAPH_URI, requestSubject(jobId));
      expect(damagedRequest).not.toEqual(expectedRequest);
      expect(damagedRequest).toHaveLength(damage === 'missing' ? 1 : expectedRequest.length - 1);
      expect(damagedRequest.some((row) => row.includes(extra.predicate))).toBe(true);
      await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      expect(await subjectRows(inner, DEFAULT_CONTROL_GRAPH_URI, requestSubject(jobId))).toEqual(expectedRequest);
      expect(await subjectRows(inner, DEFAULT_CONTROL_GRAPH_URI, jobSubject(siblingId))).toEqual(siblingBefore);
      expect(await graphRows(inner, unrelated.graph)).toEqual(otherBefore);
      expect(await publisher.getStatus(jobId)).toMatchObject({ status: 'validated', validation: KA_VM_VALIDATION });
      expect((await publisher.lookupKnowledgeAssetVmPublishJobByIntent({ contextGraphId: 'music-social', name: 'albums' })).kind).toBe('active');
    },
  );

  it('keeps API settlement and work notification behind primary commit and journal completion', async () => {
    const primary = gate();
    const journal = gate();
    const events: string[] = [];
    const { publisher, work } = fixture({
      beforePrimary: async () => { events.push('primary'); await primary.wait(); },
      beforeJournalInsert: async () => { events.push('journal'); await journal.wait(); },
    });
    let settled = false;
    const admission = publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    void admission.then(() => { settled = true; }, () => { settled = true; });
    try {
      await primary.reached;
      expect(await publisher.getStatus('job-1')).toBeNull();
      expect(events).toEqual(['primary']);
      expect(settled).toBe(false);
      expect(work).not.toHaveBeenCalled();
      primary.release();
      await journal.reached;
      expect((await publisher.getStatus('job-1'))?.status).toBe('accepted');
      expect(events).toEqual(['primary', 'journal']);
      expect(settled).toBe(false);
      expect(work).not.toHaveBeenCalled();
      journal.release();
      await expect(admission).resolves.toBe('job-1');
      expect(work).toHaveBeenCalledOnce();
    } finally {
      primary.release(); journal.release();
      await admission.catch(() => {});
    }
  });

  it('propagates primary failure without a journal attempt or success notification', async () => {
    const failure = new Error('primary rejected');
    const journalRead = vi.fn(async () => {});
    const journalInsert = vi.fn(async () => {});
    const { publisher, work } = fixture({
      beforePrimary: async () => { throw failure; },
      beforeJournalRead: journalRead, beforeJournalInsert: journalInsert,
    });
    await expect(publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest())).rejects.toBe(failure);
    expect(await publisher.getStatus('job-1')).toBeNull();
    expect(journalRead).not.toHaveBeenCalled();
    expect(journalInsert).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it.each(['read', 'insert'] as const)('contains auxiliary journal %s failure after primary success', async (phase) => {
    const journal = gate();
    const failingAttempt = async () => { await journal.wait(); throw new Error('auxiliary journal rejected'); };
    const { publisher, work } = fixture(phase === 'read'
      ? { beforeJournalRead: failingAttempt }
      : { beforeJournalInsert: failingAttempt });
    let settled = false;
    const admission = publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    void admission.then(() => { settled = true; }, () => { settled = true; });
    try {
      await journal.reached;
      expect((await publisher.getStatus('job-1'))?.status).toBe('accepted');
      expect(settled).toBe(false);
      expect(work).not.toHaveBeenCalled();
      journal.release();
      await expect(admission).resolves.toBe('job-1');
      expect(work).toHaveBeenCalledOnce();
      expect((await publisher.readJournalByJob('job-1')).entries).toEqual([]);
    } finally {
      journal.release();
      await admission.catch(() => {});
    }
  });
  it.each(['absent', 'refused', 'absent-without-subject-replace'] as const)(
    'uses the original request-first fallback only for %s capability', async (mode) => {
      const { inner, publisher } = fixture();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const job = (await publisher.getStatus(jobId))!;
      const events: string[] = [];
      const fallback = new Proxy(inner, {
        get(target, property) {
          if (property === 'replaceSubjectAndInsert') {
            if (mode !== 'refused') return undefined;
            return async () => { events.push('refused'); throw new UnsupportedTripleStoreCapabilityError('replaceSubjectAndInsert', 'test'); };
          }
          if (property === 'replaceSubject' && mode === 'absent-without-subject-replace') return undefined;
          if (property === 'insert') return async (...args: Parameters<TripleStore['insert']>) => {
            events.push(args[0][0]?.subject === requestSubject(jobId) ? 'request' : 'job');
            return target.insert(...args);
          };
          if (property === 'replaceSubject') return async (...args: Parameters<OxigraphStore['replaceSubject']>) => {
            events.push('replace'); return target.replaceSubject(...args);
          };
          if (property === 'deleteByPatternWithoutCount') return async (...args: Parameters<OxigraphStore['deleteByPatternWithoutCount']>) => {
            events.push('delete'); return target.deleteByPatternWithoutCount(...args);
          };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const before = await graphRows(inner, DEFAULT_CONTROL_GRAPH_URI);
      await persistLiftJobRecord(fallback, DEFAULT_CONTROL_GRAPH_URI, job);
      expect(events).toEqual(mode === 'refused' ? ['refused', 'request', 'replace']
        : mode === 'absent' ? ['request', 'replace'] : ['request', 'delete', 'job']);
      expect(await graphRows(inner, DEFAULT_CONTROL_GRAPH_URI)).toEqual(before);
    },
  );

  it.each(['ordinary', 'wrong-capability', 'indeterminate', 'committed-then-rejected'] as const)(
    'never replays primary persistence after %s execution failure', async (mode) => {
      const { inner, publisher } = fixture();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const job = (await publisher.getStatus(jobId))!;
      const failure = mode === 'wrong-capability'
        ? new UnsupportedTripleStoreCapabilityError('replaceSubject', 'test')
        : new Error(mode);
      const held = gate();
      let calls = 0;
      const replay = vi.fn();
      const rejecting = new Proxy(inner, {
        get(target, property) {
          if (property === 'replaceSubjectAndInsert') return async (
            graph: string, subject: string, replacement: Quad[], inserts: Quad[], options?: QueryOptions,
          ) => {
            calls++;
            if (mode === 'indeterminate') await held.wait();
            if (mode === 'committed-then-rejected') {
              await target.replaceSubjectAndInsert(graph, subject, replacement, inserts, options);
            }
            throw failure;
          };
          if (property === 'insert' || property === 'replaceSubject' || property === 'deleteByPatternWithoutCount') {
            return async () => { replay(); throw new Error('unexpected fallback replay'); };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const writing = persistLiftJobRecord(rejecting, DEFAULT_CONTROL_GRAPH_URI, job);
      const rejected = expect(writing).rejects.toBe(failure);
      try {
        if (mode === 'indeterminate') { await held.reached; expect(replay).not.toHaveBeenCalled(); }
      } finally { held.release(); }
      await rejected;
      expect(calls).toBe(1);
      expect(replay).not.toHaveBeenCalled();
      expect(await publisher.getStatus(jobId)).toEqual(job);
    },
  );

  it('validates both groups before choosing an unsupported fallback', async () => {
    const { inner, publisher } = fixture();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const job = (await publisher.getStatus(jobId))!;
    const mutation = vi.fn();
    const unsupported = new Proxy(inner, {
      get(target, property) {
        if (property === 'replaceSubjectAndInsert') return undefined;
        if (property === 'insert' || property === 'replaceSubject') return mutation;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(persistLiftJobRecord(unsupported, 'urn:invalid>graph', job)).rejects.toThrow();
    expect(mutation).not.toHaveBeenCalled();
  });

});
