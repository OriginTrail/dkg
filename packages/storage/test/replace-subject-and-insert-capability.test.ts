import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHANGELOG_GRAPH, ChangelogStore, GraphSetIndexStore, OxigraphStore,
  UnsupportedTripleStoreCapabilityError, asChangelogReader, createTripleStore,
  tryReplaceSubjectAndInsertAtomically,
  type Quad, type QueryOptions, type TripleStore, type TripleStoreDecorator,
} from '../src/index.js';
import { SharedMemoryLiteralBlobStore, SHARED_MEMORY_GRAPH_SUFFIX } from '../src/shared-memory-literal-blob-store.js';
import { StoreOperationTimeoutError } from '../src/store-operation-timeout.js';
import { GraphWriteGenTracker } from '../src/graph-write-gen.js';
import { runTrackedStoreWrite } from '../src/tracked-store-write.js';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { OxigraphWorkerStore } from '../src/adapters/oxigraph-worker.js';
import { StorePriorityScheduler, withDefaultStoreWorkPriority } from '../src/store-priority-scheduler.js';

const GRAPH = `urn:test:primary${SHARED_MEMORY_GRAPH_SUFFIX}`;
const JOB = 'urn:test:job';
const REQUEST = 'urn:test:request';
const quad = (subject: string, object: string, graph = GRAPH): Quad =>
  ({ subject, predicate: 'urn:test:value', object, graph });

describe('replaceSubjectAndInsert capability and decorators', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  async function temporaryDirectory() {
    const dir = await mkdtemp(join(tmpdir(), 'primary-commit-'));
    dirs.push(dir);
    return dir;
  }

  it('preserves receiver, groups and exact options on the capability boundary', async () => {
    const options: QueryOptions = { source: 'publisher.asyncLift.writeJob', priority: 'background', signal: new AbortController().signal };
    const replacement = [quad(JOB, '"new"')];
    const inserts = [quad(REQUEST, '"request"')];
    const method = vi.fn(async function (this: TripleStore, ...args: unknown[]) {
      expect(this).toBe(store);
      expect(args).toEqual([GRAPH, JOB, replacement, inserts, options]);
      expect(args[4]).toBe(options);
    });
    const store = { replaceSubjectAndInsert: method } as unknown as TripleStore;
    expect(await tryReplaceSubjectAndInsertAtomically(store, GRAPH, JOB, replacement, inserts, options)).toBe(true);
    expect(method).toHaveBeenCalledTimes(1);
  });

  it('returns false only for absence or a matching typed preflight refusal', async () => {
    expect(await tryReplaceSubjectAndInsertAtomically({} as TripleStore, GRAPH, JOB, [], [])).toBe(false);
    for (const failure of [
      new UnsupportedTripleStoreCapabilityError('replaceSubjectAndInsert', 'test'),
      new UnsupportedTripleStoreCapabilityError('replaceSubject', 'test'),
      new Error('replaceSubjectAndInsert unsupported'),
      new StoreOperationTimeoutError({ backend: 'test', operation: 'replaceSubjectAndInsert', outcome: 'indeterminate' }),
    ]) {
      const mutate = vi.fn(async () => { throw failure; });
      const store = { replaceSubjectAndInsert: mutate } as unknown as TripleStore;
      const result = tryReplaceSubjectAndInsertAtomically(store, GRAPH, JOB, [], []);
      if (failure instanceof UnsupportedTripleStoreCapabilityError && failure.capability === 'replaceSubjectAndInsert') {
        await expect(result).resolves.toBe(false);
      } else {
        await expect(result).rejects.toBe(failure);
      }
      expect(mutate).toHaveBeenCalledTimes(1);
    }
  });

  it('uses the complete factory stack, externalizes both groups and preserves graph/changelog membership', async () => {
    const dir = await temporaryDirectory();
    const store = await createTripleStore({
      backend: 'oxigraph-worker', changelog: true, graphSetIndex: true,
      largeLiteralStorage: { enabled: true, directory: dir, thresholdBytes: 64 },
    });
    try {
      const chain: TripleStore[] = [store];
      while ('innerStore' in chain.at(-1)!) chain.push((chain.at(-1)! as TripleStoreDecorator).innerStore);
      expect(chain.map(item => item.constructor.name)).toEqual([
        'ChangelogStore', 'GraphSetIndexStore', 'SharedMemoryLiteralBlobStore', 'OxigraphWorkerStore',
      ]);
      const backend = chain.at(-1)!;
      const mutate = vi.spyOn(backend, 'replaceSubjectAndInsert');
      expect(await store.listGraphs()).not.toContain(GRAPH);
      const jobPayload = JSON.stringify('job '.repeat(100));
      const requestPayload = JSON.stringify('request '.repeat(100));
      await expect(tryReplaceSubjectAndInsertAtomically(store, GRAPH, JOB,
        [quad(JOB, jobPayload)], [quad(REQUEST, requestPayload)],
      )).resolves.toBe(true);
      expect(mutate).toHaveBeenCalledTimes(1);
      const call = mutate.mock.calls[0];
      expect(call[2][0].object).toContain('sha256:');
      expect(call[3][0].object).toContain('sha256:');
      expect(await store.listGraphs()).toContain(GRAPH);
      const result = await store.query(`SELECT ?s ?o WHERE { GRAPH <${GRAPH}> { ?s <urn:test:value> ?o } } ORDER BY ?s`);
      expect(result.type === 'bindings' ? result.bindings : []).toEqual([
        { s: JOB, o: jobPayload }, { s: REQUEST, o: requestPayload },
      ]);
      const log = asChangelogReader(store)!;
      expect((await log.readChanges(0, 100)).some(change => change.graph === GRAPH && change.op === 'upsert')).toBe(true);
      await store.deleteByPattern({ graph: GRAPH, subject: REQUEST });
      await store.replaceSubjectAndInsert!(GRAPH, JOB, [], []);
      expect(await store.listGraphs()).not.toContain(GRAPH);
      expect((await log.readChanges(0, 100)).some(change => change.graph === GRAPH && change.op === 'drop')).toBe(true);
    } finally { await store.close(); }
  });

  it('validates both groups before creating any external literal blobs', async () => {
    const dir = await temporaryDirectory();
    const inner = new OxigraphStore();
    const store = new SharedMemoryLiteralBlobStore(inner, { blobDir: dir, thresholdBytes: 1 });
    try {
      await expect(store.replaceSubjectAndInsert(GRAPH, JOB,
        [quad(JOB, JSON.stringify('large '.repeat(50)))], [quad(REQUEST, '"unterminated')],
      )).rejects.toThrow();
      expect(await readdir(dir)).toEqual([]);
      expect(await inner.countQuads()).toBe(0);
    } finally { await store.close(); }
  });

  it('allows reserved references but rejects reserved targets before mutation', async () => {
    const inner = new OxigraphStore();
    const store = new ChangelogStore(inner);
    const mutate = vi.spyOn(inner, 'replaceSubjectAndInsert');
    try {
      await store.replaceSubjectAndInsert(GRAPH, JOB,
        [quad(JOB, `<${CHANGELOG_GRAPH}>`)], [quad(REQUEST, JSON.stringify(`<${CHANGELOG_GRAPH}>`))],
      );
      expect(mutate).toHaveBeenCalledTimes(1);
      await expect(store.replaceSubjectAndInsert(CHANGELOG_GRAPH, JOB,
        [quad(JOB, '"bad"', CHANGELOG_GRAPH)], [],
      )).rejects.toThrow(/reserved changelog plane/);
      expect(mutate).toHaveBeenCalledTimes(1);
    } finally { await store.close(); }
  });

  it('forwards clean refusal through every decorator without marking changelog dirty', async () => {
    const dir = await temporaryDirectory();
    const inner = new OxigraphStore();
    const refusing = vi.spyOn(inner, 'replaceSubjectAndInsert').mockRejectedValue(
      new UnsupportedTripleStoreCapabilityError('replaceSubjectAndInsert', 'inner'),
    );
    const store = new ChangelogStore(new GraphSetIndexStore(
      new SharedMemoryLiteralBlobStore(inner, { blobDir: dir, thresholdBytes: 1000 }),
    ));
    try {
      await store.listGraphs();
      expect(await tryReplaceSubjectAndInsertAtomically(store, GRAPH, JOB, [quad(JOB, '"new"')], [])).toBe(false);
      expect(store.needsReconcile).toBe(false);
      expect(refusing).toHaveBeenCalledTimes(1);
      expect(await inner.countQuads()).toBe(0);
    } finally { await store.close(); }
  });

  it('marks an indeterminate inner commit dirty and never repeats it', async () => {
    const inner = new OxigraphStore();
    const original = inner.replaceSubjectAndInsert.bind(inner);
    const failure = new Error('connection lost after commit');
    const mutate = vi.spyOn(inner, 'replaceSubjectAndInsert').mockImplementation(async (...args) => {
      await original(...args);
      throw failure;
    });
    const store = new ChangelogStore(new GraphSetIndexStore(inner));
    try {
      await store.listGraphs();
      await expect(tryReplaceSubjectAndInsertAtomically(store, GRAPH, JOB, [quad(JOB, '"new"')], []))
        .rejects.toBe(failure);
      expect(store.needsReconcile).toBe(true);
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(await store.listGraphs()).toContain(GRAPH);
      expect(await inner.countQuads(GRAPH)).toBe(1);
    } finally { await store.close(); }
  });

  it('preserves postcommit marker failure as failure rather than capability absence', async () => {
    const inner = new OxigraphStore();
    const store = new ChangelogStore(inner);
    const mutate = vi.spyOn(inner, 'replaceSubjectAndInsert');
    const failure = new StoreOperationTimeoutError({ backend: 'test', operation: 'hasGraph', outcome: 'not_started' });
    const probe = vi.spyOn(inner, 'hasGraph').mockRejectedValue(failure);
    try {
      await expect(tryReplaceSubjectAndInsertAtomically(store, GRAPH, JOB, [quad(JOB, '"new"')], []))
        .rejects.toBe(failure);
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(store.needsReconcile).toBe(true);
      expect(await inner.countQuads(GRAPH)).toBe(1);
    } finally { await store.close(); }
  });

  it('tracks worker write scope until settlement on success and rejection', async () => {
    const tracker = new GraphWriteGenTracker();
    for (const reject of [false, true]) {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const failure = new Error('settled worker failure');
      const operation = runTrackedStoreWrite(tracker, { kind: 'graphs', graphs: [GRAPH] }, async () => {
        await gate;
        if (reject) throw failure;
        return 'done';
      });
      expect(tracker.getWriteRevision(GRAPH).stable).toBe(false);
      expect(tracker.getWriteRevision('urn:unrelated').stable).toBe(true);
      release();
      if (reject) await expect(operation).rejects.toBe(failure);
      else await expect(operation).resolves.toBe('done');
      expect(tracker.getWriteRevision(GRAPH).stable).toBe(true);
    }
  });

  it.each([undefined, 'normal'] as const)('keeps ambient/explicit priority and cancellation through the real decorators (%s)', async priority => {
    const dir = await temporaryDirectory();
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 1, ackReservedSlots: 0, healthReservedSlots: 0 });
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    let release!: () => void;
    const blocker = scheduler.run('normal', 'test.blocker', () => new Promise<void>(resolve => { release = resolve; }));
    const backend = new BlazegraphStore('http://primary.test/sparql', { scheduler });
    const store = new ChangelogStore(new GraphSetIndexStore(
      new SharedMemoryLiteralBlobStore(backend, { blobDir: dir, thresholdBytes: 1000 }),
    ));
    const controller = new AbortController();
    const reason = new Error('cancel queued primary write');
    const work = withDefaultStoreWorkPriority('background', () => store.replaceSubjectAndInsert(
      GRAPH, JOB, [quad(JOB, '"new"')], [quad(REQUEST, '"request"')],
      { priority, signal: controller.signal, source: 'publisher.asyncLift.writeJob' },
    ));
    // Observe rejection immediately so an assertion failure cannot orphan it.
    const outcome = work.then(() => undefined, error => error);
    try {
      await vi.waitFor(() => expect(scheduler.snapshot).toMatchObject({
        backgroundQueued: priority === undefined ? 1 : 0,
        normalQueued: priority === 'normal' ? 1 : 0,
      }));
      expect(fetch).not.toHaveBeenCalled();
      controller.abort(reason);
      expect(await outcome).toMatchObject({ message: reason.message });
      expect(scheduler.snapshot).toMatchObject({ backgroundQueued: 0, normalQueued: 0 });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      controller.abort(reason);
      release();
      await blocker;
      await outcome;
      await store.close();
    }
  });

  it('settles an actual worker mutation before close and reopens both committed groups', async () => {
    const dir = await temporaryDirectory();
    const file = join(dir, 'store.nq');
    const worker = new OxigraphWorkerStore(file);
    try {
      await worker.countQuads();
      const write = worker.replaceSubjectAndInsert(GRAPH, JOB,
        [quad(JOB, '"new"')], [quad(REQUEST, '"request"')],
      );
      await Promise.all([write, worker.close()]);
    } finally { await worker.close(); }
    const reopened = new OxigraphWorkerStore(file);
    try {
      expect(await reopened.countQuads(GRAPH)).toBe(2);
      const result = await reopened.query(`SELECT ?s ?o WHERE { GRAPH <${GRAPH}> { ?s <urn:test:value> ?o } } ORDER BY ?s`);
      expect(result.type === 'bindings' ? result.bindings : []).toEqual([
        { s: JOB, o: '"new"' }, { s: REQUEST, o: '"request"' },
      ]);
      const controller = new AbortController();
      const reason = new Error('already cancelled');
      controller.abort(reason);
      await expect(reopened.replaceSubjectAndInsert(GRAPH, JOB, [], [], { signal: controller.signal })).rejects.toBe(reason);
      expect(await reopened.countQuads(GRAPH)).toBe(2);
    } finally { await reopened.close(); }
  });
});
