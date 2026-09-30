import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createManagedOxigraphSparqlStoreV1,
  SparqlHttpStore,
} from '../src/adapters/sparql-http.js';

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
}

function useFakeClock() {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });
}

function harness(kind: 'managed' | 'unmanaged' = 'managed', timeout = TIMEOUT_MS) {
  const fetches: PendingFetch[] = [];
  globalThis.fetch = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>(
    (resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      fetches.push({ signal, respond: resolve, fail: reject });
    },
  )) as typeof fetch;
  const recovery = { recovering: false, generation: 0 };
  const recover = vi.fn();
  const options = {
    queryEndpoint: 'http://127.0.0.1:7878/query',
    timeout,
    now: () => performance.now(),
    managedRecovery: { readState: () => ({ ...recovery }), recover },
  };
  const store = kind === 'managed'
    ? createManagedOxigraphSparqlStoreV1(options)
    : new SparqlHttpStore(options);

  /** Start a read, wait for its dispatch, and return the caller's handles. */
  async function dispatch(sparql = 'ASK { ?s ?p ?o }') {
    const before = fetches.length;
    const caller = new AbortController();
    const query = store.query(sparql, { signal: caller.signal });
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
