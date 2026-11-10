import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { OxigraphWorkerStore, type Quad } from '../src/index.js';
import { WorkerAdmission } from '../src/adapters/oxigraph-worker-admission.js';

// A time-limited read on the embedded worker store must stop the WORK, not only
// the caller's wait: the engine cannot interrupt a query, so the store replaces
// the worker thread. These tests use the real worker (the compiled
// `dist/adapters/oxigraph-worker-impl.js`, as the respawn suite does) and a real
// query that would run for minutes.

const GRAPH = 'urn:read-stop:graph';
// A three-way cross join: with 1,000 triples it would run for many minutes.
const HEAVY = `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${GRAPH}> { ?a <urn:p> ?b . ?c <urn:p> ?d . ?e <urn:p> ?f } }`;

function rows(n: number, prefix = 's'): Quad[] {
  return Array.from({ length: n }, (_, i) => ({ subject: `urn:${prefix}${i}`, predicate: 'urn:p', object: `urn:o${i}`, graph: GRAPH }));
}

function internals(store: OxigraphWorkerStore): { worker: Worker; lifecycle: string } {
  return store as unknown as { worker: Worker; lifecycle: string };
}

const limit = (ms: number) => performance.now() + ms;

async function askMarker(store: OxigraphWorkerStore, subject: string): Promise<boolean> {
  const result = await store.query(`ASK { GRAPH <${GRAPH}> { <${subject}> <urn:p> ?o } }`);
  return result.type === 'boolean' && result.value;
}

describe('oxigraph-worker: a read past its time limit is stopped', () => {
  let dir: string;
  let path: string;
  let store: OxigraphWorkerStore | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oxigraph-read-stop-'));
    path = join(dir, 'store.nq');
  });

  afterEach(async () => {
    await store?.close().catch(() => undefined);
    store = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces the worker at the limit, so the store answers at once afterwards', async () => {
    store = new OxigraphWorkerStore(path);
    await store.insert(rows(1_000));
    const running = internals(store).worker;
    const exited = new Promise<number>((resolve) => running.once('exit', resolve));

    const startedAt = performance.now();
    await expect(store.query(HEAVY, { workDeadline: limit(1_000) }))
      .rejects.toMatchObject({ code: 'QUERY_WORK_STOPPED', outcome: 'stopped', backend: 'oxigraph-worker' });
    const stoppedAfter = performance.now() - startedAt;
    expect(stoppedAfter).toBeGreaterThanOrEqual(990);
    expect(stoppedAfter).toBeLessThan(10_000);

    // The thread that ran the query is gone: nothing keeps evaluating it.
    await exited;
    expect(internals(store).worker).not.toBe(running);

    // The replacement serves a cheap read promptly; a busy worker would hold it
    // behind the heavy query for minutes.
    const cheapStartedAt = performance.now();
    await expect(askMarker(store, 'urn:s7')).resolves.toBe(true);
    expect(performance.now() - cheapStartedAt).toBeLessThan(5_000);
    expect(internals(store).lifecycle).toBe('live');
  }, 30_000);

  it('keeps a write acknowledged just before the stopped read, across the replacement and a cold reopen', async () => {
    store = new OxigraphWorkerStore(path);
    await store.insert(rows(1_000));
    // Acknowledged, and still inside the 50 ms flush debounce when the read starts.
    await store.insert([{ subject: 'urn:just-written', predicate: 'urn:p', object: 'urn:o', graph: GRAPH }]);
    await expect(store.query(HEAVY, { workDeadline: limit(1_000) }))
      .rejects.toMatchObject({ code: 'QUERY_WORK_STOPPED', outcome: 'stopped' });

    await expect(askMarker(store, 'urn:just-written')).resolves.toBe(true);
    await store.close();
    store = new OxigraphWorkerStore(path);
    await expect(askMarker(store, 'urn:just-written')).resolves.toBe(true);
  }, 30_000);

  it('holds operations that arrive while the read runs, and runs them on the replacement', async () => {
    store = new OxigraphWorkerStore(path);
    await store.insert(rows(1_000));
    const stopped = store.query(HEAVY, { workDeadline: limit(400) });
    const stoppedOutcome = stopped.then(() => 'answered', (error: { code?: string }) => error.code);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const write = store.insert([{ subject: 'urn:held-write', predicate: 'urn:p', object: 'urn:o', graph: GRAPH }]);
    const read = askMarker(store, 'urn:s3');

    await expect(stoppedOutcome).resolves.toBe('QUERY_WORK_STOPPED');
    await expect(write).resolves.toBeUndefined();
    await expect(read).resolves.toBe(true);
    await expect(askMarker(store, 'urn:held-write')).resolves.toBe(true);
    await store.close();
    store = new OxigraphWorkerStore(path);
    await expect(askMarker(store, 'urn:held-write')).resolves.toBe(true);
  }, 30_000);

  it('stays live after more stops in a row than the crash-loop respawn bound', async () => {
    store = new OxigraphWorkerStore(path);
    await store.insert(rows(1_000));
    // Each limit leaves room for the previous replacement to load, so every
    // round really runs and is stopped; nothing else answers in between.
    for (let round = 0; round < 7; round += 1) {
      await expect(store.query(HEAVY, { workDeadline: limit(1_500) }))
        .rejects.toMatchObject({ code: 'QUERY_WORK_STOPPED', outcome: 'stopped' });
    }
    expect(internals(store).lifecycle).toBe('live');
    await expect(askMarker(store, 'urn:s1')).resolves.toBe(true);
  }, 90_000);

  it('never starts a read whose limit ends while it waits, and stops the one that ran', async () => {
    store = new OxigraphWorkerStore(path);
    await store.insert(rows(1_000));
    const first = internals(store).worker;
    const settled: string[] = [];
    const running = store.query(HEAVY, { workDeadline: limit(3_000) });
    const runningOutcome = running.then(() => 'answered', (error: { outcome?: string }) => error.outcome)
      .finally(() => settled.push('running'));
    await new Promise((resolve) => setTimeout(resolve, 100));

    await expect(store.query(HEAVY, { workDeadline: limit(200) }).finally(() => settled.push('waiting')))
      .rejects.toMatchObject({ code: 'QUERY_WORK_STOPPED', outcome: 'not_started' });
    // The waiting read gave up while the first still ran, on the first's worker.
    expect(settled).toEqual(['waiting']);
    expect(internals(store).worker).toBe(first);

    await expect(runningOutcome).resolves.toBe('stopped');
    const second = internals(store).worker;
    expect(second).not.toBe(first);
    await expect(askMarker(store, 'urn:s2')).resolves.toBe(true);
    // Only the read that ran cost a replacement.
    expect(internals(store).worker).toBe(second);
  }, 30_000);

  it('does not start a read whose caller has already left', async () => {
    store = new OxigraphWorkerStore(path);
    await store.insert(rows(10));
    const worker = internals(store).worker;
    const controller = new AbortController();
    const reason = new Error('caller left');
    controller.abort(reason);
    await expect(store.query(HEAVY, { workDeadline: limit(1_000), signal: controller.signal }))
      .rejects.toMatchObject({ code: 'QUERY_WORK_STOPPED', outcome: 'not_started', cause: reason });
    expect(internals(store).worker).toBe(worker);
  });

  it('stops the read when its caller disconnects before the limit', async () => {
    store = new OxigraphWorkerStore(path);
    await store.insert(rows(1_000));
    const running = internals(store).worker;
    const controller = new AbortController();
    const reason = new Error('caller disconnected');
    const pending = store.query(HEAVY, { workDeadline: limit(60_000), signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort(reason);
    await expect(pending).rejects.toMatchObject({ code: 'QUERY_WORK_STOPPED', outcome: 'stopped', cause: reason });
    expect(internals(store).worker).not.toBe(running);
    await expect(askMarker(store, 'urn:s5')).resolves.toBe(true);
  }, 30_000);

  it('answers a read that finishes within its limit as usual', async () => {
    store = new OxigraphWorkerStore(path);
    await store.insert(rows(20));
    const worker = internals(store).worker;
    const result = await store.query(
      `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${GRAPH}> { ?s <urn:p> ?o } }`,
      { workDeadline: limit(10_000) },
    );
    expect(result).toMatchObject({ type: 'bindings', bindings: [{ n: '"20"^^<http://www.w3.org/2001/XMLSchema#integer>' }] });
    expect(internals(store).worker).toBe(worker);
  });

  it('does not replace a worker whose unflushed write cannot reach the disk', async () => {
    const nested = join(dir, 'nested');
    store = new OxigraphWorkerStore(join(nested, 'store.nq'));
    // 2,400 triples: a two-way join that takes a second or more, so the read ends by itself.
    await store.insert(rows(2_400));
    await store.flush();
    // The store's directory becomes a file: no flush can land from here on.
    rmSync(nested, { recursive: true, force: true });
    writeFileSync(nested, 'not a directory');
    await store.insert([{ subject: 'urn:unflushable', predicate: 'urn:p', object: 'urn:o', graph: GRAPH }]);
    const worker = internals(store).worker;
    const twoWay = `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${GRAPH}> { ?a <urn:p> ?b . ?c <urn:p> ?d } }`;

    const error = await store.query(twoWay, { workDeadline: limit(400) }).then(() => null, (cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'OXIGRAPH_WORKER_OP_TIMEOUT' });
    expect(internals(store).worker).toBe(worker);
    // The write is still served from the live worker's memory.
    await expect(askMarker(store, 'urn:unflushable')).resolves.toBe(true);
    // Close cannot persist it either; only the in-memory copy is checked here.
    await store.close().catch(() => undefined);
    store = undefined;
  }, 60_000);
});

describe('oxigraph-worker: an in-memory store is never replaced', () => {
  it('releases the caller at its limit and keeps the worker and its data', async () => {
    const store = new OxigraphWorkerStore(undefined);
    try {
      await store.insert(rows(1_800));
      const worker = internals(store).worker;
      const twoWay = `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${GRAPH}> { ?a <urn:p> ?b . ?c <urn:p> ?d } }`;
      const error = await store.query(twoWay, { workDeadline: limit(50), signal: AbortSignal.timeout(50) })
        .then(() => null, (cause: unknown) => cause);
      expect(error).not.toMatchObject({ code: 'QUERY_WORK_STOPPED' });
      expect(internals(store).worker).toBe(worker);
      await expect(askMarker(store, 'urn:s9')).resolves.toBe(true);
      expect(internals(store).lifecycle).toBe('live');
    } finally {
      await store.close();
    }
  }, 60_000);
});

describe('WorkerAdmission', () => {
  const noTimeout = () => new Error('unexpected timeout');

  it('admits operations at once while no stoppable read waits or runs', () => {
    const admission = new WorkerAdmission();
    const ticket = admission.tryEnter();
    expect(ticket).not.toBeNull();
    ticket?.done();
  });

  it('gives a stoppable read the worker only after earlier operations settle, then admits later ones in order', async () => {
    const admission = new WorkerAdmission();
    const order: string[] = [];
    const earlier = admission.tryEnter()!;
    const owned = admission.own(undefined, 0, noTimeout).then((release) => { order.push('owner'); return release; });
    expect(admission.tryEnter()).toBeNull();
    const later = admission.enter(undefined, 0, noTimeout).then((ticket) => { order.push('later'); return ticket; });

    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([]);
    earlier.done();
    const release = await owned;
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['owner']);
    release();
    (await later).done();
    expect(order).toEqual(['owner', 'later']);
    expect(admission.tryEnter()).not.toBeNull();
  });

  it('keeps arrival order: an operation queued before a second stoppable read runs before it', async () => {
    const admission = new WorkerAdmission();
    const order: string[] = [];
    const releaseFirst = await admission.own(undefined, 0, noTimeout);
    const queued = admission.enter(undefined, 0, noTimeout).then((ticket) => { order.push('queued'); return ticket; });
    const second = admission.own(undefined, 0, noTimeout).then((release) => { order.push('second'); return release; });
    releaseFirst();
    const ticket = await queued;
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['queued']);
    ticket.done();
    (await second)();
    expect(order).toEqual(['queued', 'second']);
  });

  it('drops a waiter that gives up, so the next one is admitted', async () => {
    const admission = new WorkerAdmission();
    const releaseFirst = await admission.own(undefined, 0, noTimeout);
    const controller = new AbortController();
    const reason = new Error('gave up');
    const leaving = admission.own(controller.signal, 0, noTimeout);
    const timedOut = admission.enter(undefined, 20, () => new Error('waited too long'));
    const staying = admission.enter(undefined, 0, noTimeout);
    controller.abort(reason);
    await expect(leaving).rejects.toBe(reason);
    await expect(timedOut).rejects.toThrow('waited too long');
    releaseFirst();
    (await staying).done();
    expect(admission.tryEnter()).not.toBeNull();
  });

  it('lets later operations in when a stoppable read gives up while earlier work drains', async () => {
    const admission = new WorkerAdmission();
    const earlier = admission.tryEnter()!;
    const owner = admission.own(undefined, 20, () => new Error('limit while draining'));
    const later = admission.enter(undefined, 0, noTimeout);
    await expect(owner).rejects.toThrow('limit while draining');
    const ticket = await later;
    earlier.done();
    ticket.done();
    expect(admission.tryEnter()).not.toBeNull();
  });
});
