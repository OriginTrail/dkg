import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createManagedOxigraphSparqlStoreV1,
  SparqlHttpStore,
} from '../src/adapters/sparql-http.js';
import { MANAGED_OXIGRAPH_CANCELLATION_SUFFIX } from '../src/adapters/sparql-response-policy.js';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import { createRfc64SharedProjectionTestFixture } from './helpers/rfc64-shared-projection-fixture.js';

/**
 * A caller that gives up on a dispatched managed-Oxigraph read (its own budget)
 * must not cause a supervised restart of a healthy server, because the client
 * cannot see the abandoned query finish once it has aborted the fetch. The
 * managed store therefore keeps the dispatched request running under the store
 * close and client deadline signals alone, and withdraws the retained recovery
 * when the server visibly finishes. A request that outlives the client deadline
 * is still reclaimed by a restart.
 */

const TIMEOUT_MS = 1_000;
const ASK_TRUE = JSON.stringify({ head: {}, boolean: true });
const SPARQL_JSON = { 'Content-Type': 'application/sparql-results+json' };
const originalFetch = globalThis.fetch;

interface PendingFetch {
  readonly signal: AbortSignal;
  respond(response: Response): void;
  fail(error: unknown): void;
  /** With `holdAbort`: settle the fetch the way a real one does after its abort. */
  release(): void;
}

interface HarnessOptions {
  /**
   * Record an abort but leave the fetch pending until the test calls
   * `release()`, like a transport whose cleanup after an abort takes a while.
   */
  readonly holdAbort?: boolean;
  readonly scheduler?: StorePriorityScheduler;
}

function useFakeClock() {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });
}

function harness(
  kind: 'managed' | 'unmanaged' = 'managed',
  timeout = TIMEOUT_MS,
  { holdAbort = false, scheduler }: HarnessOptions = {},
) {
  const fetches: PendingFetch[] = [];
  globalThis.fetch = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>(
    (resolve, reject) => {
      const signal = init!.signal!;
      const release = () => reject(signal.reason);
      if (!holdAbort) signal.addEventListener('abort', release, { once: true });
      fetches.push({ signal, respond: resolve, fail: reject, release });
    },
  )) as typeof fetch;
  const recovery = { recovering: false, generation: 0 };
  const recover = vi.fn();
  const options = {
    queryEndpoint: 'http://127.0.0.1:7878/query',
    timeout,
    now: () => performance.now(),
    managedRecovery: { readState: () => ({ ...recovery }), recover },
    ...(scheduler === undefined ? {} : { scheduler }),
  };
  const store = kind === 'managed'
    ? createManagedOxigraphSparqlStoreV1(options)
    : new SparqlHttpStore(options);

  /** Start a read, wait for its dispatch, and return the caller's handles. */
  async function dispatch(sparql = 'ASK { ?s ?p ?o }', queryOptions: { maxResponseBytes?: number } = {}) {
    const before = fetches.length;
    const caller = new AbortController();
    const query = store.query(sparql, { ...queryOptions, signal: caller.signal });
    const outcome = query.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await (vi.isFakeTimers()
      ? vi.advanceTimersByTimeAsync(0)
      : vi.waitFor(() => expect(fetches).toHaveLength(before + 1), { timeout: 2_000 }));
    expect(fetches).toHaveLength(before + 1);
    return { caller, outcome, fetch: fetches[before]! };
  }

  /** The caller gives up: its rejection must arrive immediately, with its reason. */
  async function abandon(read: Awaited<ReturnType<typeof dispatch>>) {
    const reason = new Error('caller budget exhausted');
    read.caller.abort(reason);
    expect(await read.outcome).toEqual({ error: reason });
    return reason;
  }

  return { store, recovery, recover, fetches, dispatch, abandon };
}

const okResponse = () => new Response(ASK_TRUE, { headers: SPARQL_JSON });

/**
 * Answer a pending fetch with a body the test feeds by hand. Like a real
 * fetch, the body stream errors if the fetch's own signal aborts.
 */
function respondStreaming(fetch: PendingFetch, init: ResponseInit = { headers: SPARQL_JSON }) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      fetch.signal.addEventListener('abort', () => c.error(fetch.signal.reason));
    },
  });
  fetch.respond(new Response(stream, init));
  return {
    /** Send the rest of the body and end the stream cleanly. */
    finish(text: string) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  };
}

describe('managed read whose caller aborts after dispatch', () => {
  useFakeClock();

  it('does not restart a healthy store when the dispatched read then completes', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch();
      await vi.advanceTimersByTimeAsync(100);
      await abandon(read);
      // The caller has its AbortError, but the request itself is left running.
      expect(read.fetch.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(1);

      read.fetch.respond(okResponse());
      await vi.advanceTimersByTimeAsync(0);
      // The retained recovery timer is withdrawn as soon as the server finished.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('does not restart a healthy store when the abort lands while the body is streaming', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch();
      let body!: ReadableStreamDefaultController<Uint8Array>;
      // A real fetch errors the body stream when its signal aborts.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
          read.fetch.signal.addEventListener('abort', () => controller.error(read.fetch.signal.reason));
        },
      });
      read.fetch.respond(new Response(stream, { headers: SPARQL_JSON }));
      await vi.advanceTimersByTimeAsync(10);
      await abandon(read);
      expect(read.fetch.signal.aborted).toBe(false);

      body.enqueue(new TextEncoder().encode(ASK_TRUE));
      body.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('treats a server error answer as a finished read, not a runaway one', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch();
      await abandon(read);
      read.fetch.respond(new Response('parse error', { status: 400 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('treats an error answer read after the caller left mid-body as a finished read', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch();
      let body!: ReadableStreamDefaultController<Uint8Array>;
      read.fetch.respond(new Response(new ReadableStream<Uint8Array>({
        start(controller) { body = controller; },
      }), { status: 500 }));
      await vi.advanceTimersByTimeAsync(10);
      await abandon(read);
      expect(vi.getTimerCount()).toBe(1);

      body.enqueue(new TextEncoder().encode('internal error'));
      body.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('treats an answer without a body as a finished read', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch();
      await abandon(read);
      read.fetch.respond(new Response(null, { status: 204 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('still restarts when the abandoned read answered but its body never finishes', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch();
      await abandon(read);
      read.fetch.respond(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          read.fetch.signal.addEventListener('abort', () => controller.error(read.fetch.signal.reason));
        },
      }), { headers: SPARQL_JSON }));
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledExactlyOnceWith('query');
    } finally { await store.close(); }
  });

  // The server finished with these requests even though the answer could not be
  // used: the body was read to its end and only then rejected. Withdrawing the
  // retained recovery is what keeps a healthy server from being restarted at
  // the client deadline. Each one answers (headers) BEFORE the caller leaves, so
  // the body is consumed and decoded rather than just drained.
  it.each([
    ['a SELECT the server cancelled natively', 'SELECT ?s WHERE { ?s ?p ?o }', 200, `{"head":{"vars":["s"]},"results":{"bindings":[{"s":`, MANAGED_OXIGRAPH_CANCELLATION_SUFFIX],
    ['a CONSTRUCT the server cancelled natively', 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', 200, '<urn:a> <urn:p> "x" <urn:g> .\n', MANAGED_OXIGRAPH_CANCELLATION_SUFFIX],
    ['an error answer that reports the native cancellation', 'SELECT ?s WHERE { ?s ?p ?o }', 500, '', MANAGED_OXIGRAPH_CANCELLATION_SUFFIX],
    ['an answer that is not valid SPARQL JSON', 'SELECT ?s WHERE { ?s ?p ?o }', 200, '', 'this is not json'],
  ] as const)('treats %s as a finished read', async (_name, sparql, status, first, last) => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch(sparql);
      const answer = respondStreaming(read.fetch, { status, headers: SPARQL_JSON });
      await vi.advanceTimersByTimeAsync(10);
      await abandon(read);
      expect(vi.getTimerCount()).toBe(1);

      answer.finish(first + last);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('reports an answer without a body to a caller that is still waiting for it', async () => {
    const { store, recover, dispatch } = harness();
    try {
      const read = await dispatch();
      read.fetch.respond(new Response(null, { status: 204 }));
      // Nothing to decode: the caller gets the decode error, and there is no
      // abandonment, so nothing is retained or restarted.
      expect(await read.outcome).toHaveProperty('error');
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('still restarts when the abandoned read answered but its body was cut off by the size limit', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch('SELECT ?s WHERE { ?s ?p ?o }', { maxResponseBytes: 8 });
      let body!: ReadableStreamDefaultController<Uint8Array>;
      let cancelled = false;
      read.fetch.respond(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
          controller.enqueue(new TextEncoder().encode('abc'));
        },
        cancel() { cancelled = true; },
      }), { headers: SPARQL_JSON }));
      await vi.advanceTimersByTimeAsync(10);
      await abandon(read);

      body.enqueue(new TextEncoder().encode('a tail that takes the body over the limit'));
      await vi.advanceTimersByTimeAsync(0);
      // The consumer gave up on the body; the server was never seen to finish.
      expect(cancelled).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect(recover).toHaveBeenCalledExactlyOnceWith('query');
    } finally { await store.close(); }
  });

  it.each([
    ['SELECT ?s WHERE { ?s ?p ?o }', 'query'],
    ['CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', 'construct'],
  ] as const)('still restarts once the client deadline elapses with the %s pending', async (sparql, operation) => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch(sparql);
      await vi.advanceTimersByTimeAsync(100);
      await abandon(read);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 100 - 1);
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledExactlyOnceWith(operation);
    } finally { await store.close(); }
  });

  it('keeps the retained recovery when the abandoned request fails on the transport', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch();
      await abandon(read);
      read.fetch.fail(new TypeError('fetch failed'));
      await vi.advanceTimersByTimeAsync(0);
      // A dropped connection says nothing about the server having finished.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect(recover).toHaveBeenCalledExactlyOnceWith('query');
    } finally { await store.close(); }
  });

  it('keeps recovery owed to a still-running read when another abandoned read completes', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const first = await dispatch();
      await vi.advanceTimersByTimeAsync(300);
      const second = await dispatch();
      await abandon(first);
      await abandon(second);
      expect(vi.getTimerCount()).toBe(1);

      // The earlier read (deadline 1000) finishes; the later one (1300) runs on.
      first.fetch.respond(okResponse());
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      // Past the finished read's deadline (t=1000), then up to the running one's.
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledExactlyOnceWith('query');
    } finally { await store.close(); }
  });

  it('keeps the earlier deadline when the later abandoned read is the one that completes', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const first = await dispatch();
      await vi.advanceTimersByTimeAsync(300);
      const second = await dispatch();
      await abandon(first);
      await abandon(second);

      second.fetch.respond(okResponse());
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 300 - 1);
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(301);
      expect(recover).toHaveBeenCalledExactlyOnceWith('query');
    } finally { await store.close(); }
  });

  it('stops the detached request and schedules nothing when the store closes', async () => {
    const { store, recover, dispatch, abandon } = harness();
    const read = await dispatch();
    await abandon(read);
    expect(read.fetch.signal.aborted).toBe(false);

    await store.close();
    expect(read.fetch.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
    expect(recover).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps close pending until the detached request has really settled', async () => {
    // A transport whose cleanup after an abort takes a while: the fetch records
    // that it was aborted but only settles when the test lets it.
    const { store, recover, dispatch, abandon } = harness('managed', TIMEOUT_MS, { holdAbort: true });
    const read = await dispatch();
    await abandon(read);
    // The caller was answered at once, and its request runs on.
    expect(read.fetch.signal.aborted).toBe(false);

    let closed = false;
    const closing = store.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(0);
    // Close aborts the detached transport...
    expect(read.fetch.signal.aborted).toBe(true);
    // ...but does not report the store closed while that request is unsettled.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
    expect(closed).toBe(false);

    read.fetch.release();
    await closing;
    expect(closed).toBe(true);
    // Nothing is left to restart: close withdrew the retained recovery.
    expect(recover).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('frees the scheduler slot when the caller leaves, as it did before detaching', async () => {
    // Characterization, not endorsement: this pins the admission behaviour the
    // change inherits, so altering it is a deliberate decision. Aborting the
    // fetch used to settle the scheduled operation at once, releasing its slot
    // while a managed Oxigraph 0.5 kept evaluating; the detached request
    // settles the operation at the same point, and the second read starts
    // although the first request has not finished.
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 1,
      ackReservedSlots: 0,
      healthReservedSlots: 0,
      normalReservedSlots: 0,
      backgroundReservedSlots: 0,
      queueWaitTimeoutMs: TIMEOUT_MS * 100,
    });
    const { store, fetches, dispatch, abandon } = harness('managed', TIMEOUT_MS, { scheduler });
    try {
      const first = await dispatch();
      const secondCaller = new AbortController();
      const second = store.query('ASK { ?s ?p ?o }', { signal: secondCaller.signal });
      await vi.advanceTimersByTimeAsync(0);
      // One slot: the second read waits behind the first.
      expect(fetches).toHaveLength(1);
      expect(scheduler.snapshot).toMatchObject({ normalInflight: 1, normalQueued: 1 });

      await abandon(first);
      await vi.advanceTimersByTimeAsync(0);
      expect(first.fetch.signal.aborted).toBe(false);
      expect(fetches).toHaveLength(2);
      expect(scheduler.snapshot).toMatchObject({ normalInflight: 1, normalQueued: 0 });

      fetches[1]!.respond(okResponse());
      await expect(second).resolves.toEqual({ type: 'boolean', value: true });
    } finally { await store.close(); }
  });

  it('still cancels a read that is queued behind a busy slot without ever dispatching it', async () => {
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 1,
      ackReservedSlots: 0,
      healthReservedSlots: 0,
      normalReservedSlots: 0,
      backgroundReservedSlots: 0,
      queueWaitTimeoutMs: TIMEOUT_MS * 100,
    });
    const { store, recover, fetches, dispatch } = harness('managed', TIMEOUT_MS, { scheduler });
    try {
      const running = await dispatch();
      const queuedCaller = new AbortController();
      const reason = new Error('queued caller left');
      const queued = store.query('ASK { ?s ?p ?o }', { signal: queuedCaller.signal })
        .then(() => undefined, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.snapshot).toMatchObject({ normalInflight: 1, normalQueued: 1 });

      queuedCaller.abort(reason);
      expect(await queued).toBe(reason);
      // Nothing was sent for it, nothing is owed a restart, and the queue is empty again.
      expect(fetches).toHaveLength(1);
      expect(scheduler.snapshot).toMatchObject({ normalInflight: 1, normalQueued: 0 });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(recover).not.toHaveBeenCalled();

      running.fetch.respond(okResponse());
      expect(await running.outcome).toEqual({ value: { type: 'boolean', value: true } });
    } finally { await store.close(); }
  });

  it('runs a read without any caller signal on the plain path and stops it at close', async () => {
    const { store, recover, fetches } = harness();
    const outcome = store.query('ASK { ?s ?p ?o }').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toHaveLength(1);
    await store.close();
    expect(await outcome).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
    expect(recover).not.toHaveBeenCalled();
  });

  it('answers a caller that aborted before dispatch without sending anything', async () => {
    const { store, recover, fetches } = harness();
    try {
      const caller = new AbortController();
      const reason = new Error('already cancelled');
      caller.abort(reason);
      await expect(store.query('ASK {}', { signal: caller.signal })).rejects.toBe(reason);
      expect(fetches).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('never withdraws recovery for a read that keeps running after its caller left twice over', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch();
      await abandon(read);
      // A second, unrelated read that finishes normally must not disturb it.
      const other = await dispatch();
      other.fetch.respond(okResponse());
      expect(await other.outcome).toEqual({ value: { type: 'boolean', value: true } });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect(recover).toHaveBeenCalledExactlyOnceWith('query');
    } finally { await store.close(); }
  });
});

// Every read path states what a caller abort does to its request (the required
// `SparqlHttpReadPolicy` of postQuery). Ordinary reads detach on a managed store
// (the tests above); an unmanaged store, a read without a caller signal, and the
// RFC-64 streaming construct below cancel.
describe('RFC-64 shared-projection stream whose caller aborts after dispatch', () => {
  useFakeClock();

  it('cancels the request, unlike an ordinary managed read, and keeps the recovery retained', async () => {
    // The stream's consumer owns the live body (it spools it) and stops reading
    // when the caller leaves, so nothing could drain a detached request.
    const { store, recover, fetches } = harness();
    const { operation } = createRfc64SharedProjectionTestFixture();
    const caller = new AbortController();
    try {
      const outcome = store.rfc64SharedProjectionStreamV1!(operation, {
        byteCeiling: 4096,
        signal: caller.signal,
      }).then((value) => ({ value }), (error: unknown) => ({ error }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetches).toHaveLength(1);
      expect(fetches[0]!.signal.aborted).toBe(false);

      const reason = new Error('projection caller left');
      caller.abort(reason);
      expect(await outcome).toEqual({ error: reason });
      expect(fetches[0]!.signal.aborted).toBe(true);

      // Aborting the connection tells the client nothing about Oxigraph having
      // finished, so the read stays owed a restart at the client deadline.
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledExactlyOnceWith('construct');
    } finally { await store.close(); }
  });
});

describe('unmanaged SPARQL HTTP store whose caller aborts after dispatch', () => {
  useFakeClock();

  it('still cancels the request itself, as before', async () => {
    const { store, recover, dispatch, abandon } = harness('unmanaged');
    try {
      const read = await dispatch();
      await abandon(read);
      expect(read.fetch.signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });
});

describe('managed read with a real client deadline', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('reclaims an abandoned runaway read exactly once when the deadline really elapses', async () => {
    // Real timers: the request's own AbortSignal.timeout and the coordinator
    // timer both fire at the deadline, and recovery must still happen once.
    const { store, recover, dispatch, abandon } = harness('managed', 300);
    try {
      const read = await dispatch('SELECT ?s WHERE { ?s ?p ?o }');
      await abandon(read);
      expect(read.fetch.signal.aborted).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(read.fetch.signal.aborted).toBe(true);
      expect((read.fetch.signal.reason as Error).name).toBe('TimeoutError');
      expect(recover).toHaveBeenCalledExactlyOnceWith('query');
    } finally { await store.close(); }
  });

  it('reports a caller abort that races the deadline as the timeout it is', async () => {
    // The caller's abort lands in the same tick as the client deadline, before
    // the fetch rejection is delivered: the timeout wins, recovery is notified
    // once, and nothing is retained on top of it.
    const recover = vi.fn();
    const caller = new AbortController();
    globalThis.fetch = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener('abort', () => {
          caller.abort(new Error('caller gave up at the deadline'));
          reject(signal.reason);
        }, { once: true });
      },
    )) as typeof fetch;
    const store = createManagedOxigraphSparqlStoreV1({
      queryEndpoint: 'http://127.0.0.1:7878/query',
      timeout: 200,
      managedRecovery: { readState: () => ({ recovering: false, generation: 0 }), recover },
    });
    try {
      await expect(store.query('SELECT ?s WHERE { ?s ?p ?o }', { signal: caller.signal }))
        .rejects.toMatchObject({
          code: 'STORE_OPERATION_TIMEOUT',
          backend: 'oxigraph-server',
          operation: 'query',
        });
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(recover).toHaveBeenCalledExactlyOnceWith('query');
    } finally { await store.close(); }
  });
});
