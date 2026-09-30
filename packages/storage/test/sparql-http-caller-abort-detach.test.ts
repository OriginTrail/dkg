import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ABANDONED_READ_DRAIN_BUDGET_BYTES,
  createManagedOxigraphSparqlStoreV1,
  SparqlHttpStore,
} from '../src/adapters/sparql-http.js';
import { MANAGED_OXIGRAPH_CANCELLATION_SUFFIX } from '../src/adapters/sparql-response-policy.js';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import { createRfc64SharedProjectionTestFixture } from './helpers/rfc64-shared-projection-fixture.js';

/**
 * A caller that gives up on a dispatched managed-Oxigraph read (its own budget)
 * must not cause a supervised restart of a healthy server, but must not leave
 * the client reading a runaway answer either.
 *
 * What the server does once its client has gone depends on the answer. A
 * streamed SELECT/CONSTRUCT stops when it next writes to the closed socket; a
 * blocking evaluation (an aggregate, an ORDER BY) sends nothing until it is done
 * and keeps evaluating, and once the fetch is aborted the client can no longer
 * see it finish. So the managed store leaves a dispatched request running, under
 * the store close and client deadline signals alone, and withdraws the retained
 * recovery when the server visibly finishes. From the first byte of the answer
 * on, though, nothing is buffered for a caller who left: what remains of the
 * answer (or all of it, when it starts after the caller left) is read and
 * discarded up to ABANDONED_READ_DRAIN_BUDGET_BYTES. A short answer ends inside
 * that budget and shows the server finished; a longer one is streaming, so it is
 * cancelled. A cancelled or failed answer shows nothing, so its recovery stays
 * retained; one that outlives the client deadline is still reclaimed by a
 * restart.
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

const KIB = 1024;
const CHUNK_BYTES = 16 * KIB;
/** Far more than any drain budget: a client that reads all of it reads a runaway answer. */
const RUNAWAY_BYTES = 4 * 1024 * KIB;

/**
 * Answer a pending fetch with a FINITE body that the server "produces" only as
 * fast as the client reads it. `highWaterMark: 0` makes every `pull` a real read
 * by the client, so `pulled()` is the number of bytes the client has read, not
 * what the transport happened to buffer. Like a real fetch, the body errors when
 * the fetch's own signal aborts; cancelling the body is recorded.
 *
 * `stallAfterBytes` makes the server stall between writes once the client has
 * read that many bytes, until `resume()`.
 */
function streamingAnswer(
  fetch: PendingFetch,
  options: {
    readonly totalBytes: number;
    readonly chunkBytes?: number;
    readonly stallAfterBytes?: number;
    readonly init?: ResponseInit;
    /** A transport whose body does not react to the fetch's abort (its cleanup takes a while). */
    readonly ignoreAbort?: boolean;
  },
) {
  const { totalBytes, chunkBytes = CHUNK_BYTES, stallAfterBytes = Number.POSITIVE_INFINITY } = options;
  let pulled = 0;
  let cancelled = false;
  let over = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (options.ignoreAbort !== true) {
        fetch.signal.addEventListener('abort', () => {
          over = true;
          c.error(fetch.signal.reason);
        }, { once: true });
      }
    },
    async pull(c) {
      if (pulled >= stallAfterBytes) await gate;
      if (over) return;
      if (pulled >= totalBytes) {
        c.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - pulled);
      pulled += size;
      c.enqueue(new Uint8Array(size).fill(0x20));
    },
    cancel() {
      over = true;
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  fetch.respond(new Response(stream, options.init ?? { headers: SPARQL_JSON }));
  return {
    /** Bytes the client has read so far. */
    pulled: () => pulled,
    /** The client cancelled the body (it stopped reading and let go). */
    cancelled: () => cancelled,
    /** The server writes on after its stall. */
    resume,
    /** The connection is reset under the body. */
    reset: () => controller.error(new TypeError('terminated')),
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

  // A caller that leaves while its answer is being read must not leave the client
  // reading on: a streamed answer keeps the server producing, and the client
  // buffering, for the whole client deadline. What remains of the answer is read
  // and discarded up to the drain budget, then cancelled; a cancelled answer does
  // not show the server stopped (it may be stalled between writes), so its
  // recovery stays retained, as it always did.
  it.each([
    ['SELECT ?s WHERE { ?s ?p ?o }', 'query'],
    ['CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', 'construct'],
  ] as const)('reads at most the drain budget of a long %s answer once its caller left it mid-body, then cancels it', async (sparql, operation) => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch(sparql);
      // The server stalls between writes after the client has read 4 chunks.
      const answer = streamingAnswer(read.fetch, { totalBytes: RUNAWAY_BYTES, stallAfterBytes: 4 * CHUNK_BYTES });
      await vi.advanceTimersByTimeAsync(10);
      expect(answer.pulled()).toBe(4 * CHUNK_BYTES);

      await abandon(read);
      // The caller was answered at once; the request itself is left running.
      expect(read.fetch.signal.aborted).toBe(false);

      // The server writes on: a bounded part is read, and none of it is kept.
      answer.resume();
      await vi.advanceTimersByTimeAsync(0);
      const readAfterLeaving = answer.pulled() - 4 * CHUNK_BYTES;
      expect(answer.cancelled()).toBe(true);
      expect(readAfterLeaving).toBeGreaterThan(ABANDONED_READ_DRAIN_BUDGET_BYTES);
      expect(readAfterLeaving).toBeLessThanOrEqual(ABANDONED_READ_DRAIN_BUDGET_BYTES + CHUNK_BYTES);

      // Not seen to finish: still owed a restart at the client deadline
      // (dispatch + TIMEOUT_MS, 10 ms of which have passed).
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 10 - 1);
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledExactlyOnceWith(operation);
    } finally { await store.close(); }
  });

  it('withdraws the recovery of a read whose caller left mid-body when the rest of the answer is short', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch();
      const answer = streamingAnswer(read.fetch, {
        totalBytes: ABANDONED_READ_DRAIN_BUDGET_BYTES,
        stallAfterBytes: 4 * CHUNK_BYTES,
      });
      await vi.advanceTimersByTimeAsync(10);
      await abandon(read);
      expect(vi.getTimerCount()).toBe(1);

      answer.resume();
      await vi.advanceTimersByTimeAsync(0);
      // Read out to its clean end: the server finished, whatever the body said.
      expect(answer.cancelled()).toBe(false);
      expect(answer.pulled()).toBe(ABANDONED_READ_DRAIN_BUDGET_BYTES);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('still restarts when the caller left mid-body and the rest of the answer never comes', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch();
      streamingAnswer(read.fetch, { totalBytes: RUNAWAY_BYTES, stallAfterBytes: 4 * CHUNK_BYTES });
      await vi.advanceTimersByTimeAsync(10);
      await abandon(read);
      // The discard is left waiting on the stalled body until the client deadline.
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 10 - 1);
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledExactlyOnceWith('query');
    } finally { await store.close(); }
  });

  it('leaves nothing behind for a caller that stays, and ignores a later abort', async () => {
    const { store, recover, dispatch } = harness();
    try {
      const read = await dispatch();
      read.fetch.respond(okResponse());
      expect(await read.outcome).toEqual({ value: { type: 'boolean', value: true } });
      // A finished read leaves nothing listening on a caller's (long-lived) signal.
      expect(getEventListeners(read.caller.signal, 'abort')).toHaveLength(0);

      // The caller's later abort finds nothing to cancel and nothing to retain.
      read.caller.abort(new Error('too late'));
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(read.fetch.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  // The store-lifetime close signal is shared by every read: a read that leaves a listener on it
  // leaks one per query for as long as the store lives. Listeners are counted per signal, by
  // wrapping add/removeEventListener, because the store's own signals are not exposed.
  it('leaves no abort listener on any signal after successful reads with a caller signal', async () => {
    const { store, dispatch } = harness('managed', TIMEOUT_MS, { holdAbort: true });
    const live = new Map<EventTarget, number>();
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const bump = (target: EventTarget, by: number) => live.set(target, (live.get(target) ?? 0) + by);
    const spies = [
      vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (this: EventTarget, type, listener, options) {
        if (type === 'abort') bump(this, 1);
        return add.call(this, type, listener, options);
      }),
      vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (this: EventTarget, type, listener, options) {
        if (type === 'abort') bump(this, -1);
        return remove.call(this, type, listener, options);
      }),
    ];
    try {
      for (let index = 0; index < 40; index += 1) {
        const read = await dispatch();
        read.fetch.respond(okResponse());
        expect(await read.outcome).toEqual({ value: { type: 'boolean', value: true } });
      }
      expect(Math.max(0, ...live.values())).toBe(0);
    } finally {
      for (const spy of spies) spy.mockRestore();
      await store.close();
    }
  });

  it('still enforces maxResponseBytes for a caller that waits, through the relay', async () => {
    const { store, recover, dispatch } = harness();
    try {
      const read = await dispatch('SELECT ?s WHERE { ?s ?p ?o }', { maxResponseBytes: 5_000 });
      const answer = streamingAnswer(read.fetch, { totalBytes: RUNAWAY_BYTES });
      expect(await read.outcome).toMatchObject({ error: { code: 'STORE_RESPONSE_TOO_LARGE' } });
      // The client stopped reading at the limit instead of taking the whole runaway answer.
      expect(answer.cancelled()).toBe(true);
      expect(answer.pulled()).toBeLessThan(RUNAWAY_BYTES);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('withdraws the recovery of a read whose caller left just after its answer was completely read', async () => {
    // The last moment a caller can leave without failing the read: the body has
    // been read to its end, and the read is about to be decoded and returned.
    const { store, recover, dispatch } = harness();
    const readText = Response.prototype.text;
    const read = await dispatch();
    let leftJustAfterReading!: Promise<void>;
    const spy = vi.spyOn(Response.prototype, 'text').mockImplementation(async function (this: Response) {
      const text = await readText.call(this);
      read.caller.abort(new Error('caller budget exhausted'));
      leftJustAfterReading = Promise.resolve();
      return text;
    });
    try {
      read.fetch.respond(okResponse());
      await vi.advanceTimersByTimeAsync(0);
      await leftJustAfterReading;
      expect(spy).toHaveBeenCalledOnce();
      expect(await read.outcome).toEqual({ error: new Error('caller budget exhausted') });
      // The read still ran to its end: the server is done, nothing is owed a restart.
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(recover).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await store.close();
    }
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

  // An error status is an answer, but the server is only seen to finish when
  // its diagnostic body has been read out. The read tolerates a body that fails
  // (the status is still reported), so a failed body must not be taken for a
  // finished server, and a diagnostic body that is read out must be.
  it('keeps the recovery of an error answer whose body is reset after the caller left mid-body', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch();
      const answer = streamingAnswer(read.fetch, {
        totalBytes: RUNAWAY_BYTES,
        stallAfterBytes: CHUNK_BYTES,
        init: { status: 500 },
      });
      await vi.advanceTimersByTimeAsync(10);
      await abandon(read);
      answer.reset();
      answer.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect(recover).toHaveBeenCalledExactlyOnceWith('query');
    } finally { await store.close(); }
  });

  it('treats an error answer read out after the caller left mid-body as a finished read', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch();
      const answer = streamingAnswer(read.fetch, {
        totalBytes: 4 * CHUNK_BYTES,
        stallAfterBytes: CHUNK_BYTES,
        init: { status: 500 },
      });
      await vi.advanceTimersByTimeAsync(10);
      await abandon(read);
      expect(vi.getTimerCount()).toBe(1);

      answer.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('treats an answer without a body that arrives after the caller left as a finished read', async () => {
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
  // used: the body was read to its end and only then would have been rejected.
  // Withdrawing the retained recovery is what keeps a healthy server from being
  // restarted at the client deadline. The caller leaves either while the answer
  // is being read (headers in, body pending) or before it began; either way the
  // rest is read out and discarded (within the drain budget), not decoded.
  const FINISHED_BUT_UNUSABLE = [
    ['a SELECT the server cancelled natively', 'SELECT ?s WHERE { ?s ?p ?o }', 200, `{"head":{"vars":["s"]},"results":{"bindings":[{"s":`, MANAGED_OXIGRAPH_CANCELLATION_SUFFIX],
    ['a CONSTRUCT the server cancelled natively', 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', 200, '<urn:a> <urn:p> "x" <urn:g> .\n', MANAGED_OXIGRAPH_CANCELLATION_SUFFIX],
    ['an error answer that reports the native cancellation', 'SELECT ?s WHERE { ?s ?p ?o }', 500, '', MANAGED_OXIGRAPH_CANCELLATION_SUFFIX],
    ['an answer that is not valid SPARQL JSON', 'SELECT ?s WHERE { ?s ?p ?o }', 200, '', 'this is not json'],
  ] as const;

  it.each(FINISHED_BUT_UNUSABLE)('treats %s whose caller left it mid-body as a finished read', async (_name, sparql, status, first, last) => {
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

  it.each(FINISHED_BUT_UNUSABLE)('treats %s that arrives after the caller left as a finished read', async (_name, sparql, status, first, last) => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch(sparql);
      await abandon(read);
      const answer = respondStreaming(read.fetch, { status, headers: SPARQL_JSON });
      await vi.advanceTimersByTimeAsync(10);
      expect(vi.getTimerCount()).toBe(1);

      answer.finish(first + last);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  // What an answer that starts after its caller left may cost: at most the drain
  // budget (plus the chunk that crosses it) is read, and nothing is kept. A
  // longer answer is streaming, so it is cancelled, and since that shows nothing
  // about the server, its recovery stays retained. This replaces a test that
  // cut off an abandoned read at `maxResponseBytes`: what an abandoned read may
  // read is now this budget, whatever the caller's size limit.
  it.each([
    ['SELECT ?s WHERE { ?s ?p ?o }', 'query'],
    ['CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', 'construct'],
  ] as const)('reads a bounded part of a long %s answer that starts after the caller left, then cancels it', async (sparql, operation) => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch(sparql);
      await abandon(read);
      const answer = streamingAnswer(read.fetch, { totalBytes: RUNAWAY_BYTES });
      await vi.advanceTimersByTimeAsync(0);

      expect(answer.cancelled()).toBe(true);
      expect(answer.pulled()).toBeGreaterThan(ABANDONED_READ_DRAIN_BUDGET_BYTES);
      expect(answer.pulled()).toBeLessThanOrEqual(ABANDONED_READ_DRAIN_BUDGET_BYTES + CHUNK_BYTES);
      // Not seen to finish: recovery is still owed at the client deadline.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledExactlyOnceWith(operation);
    } finally { await store.close(); }
  });

  it('counts an answer that ends exactly at the drain budget as finished, and one a byte over as not', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const exact = await dispatch();
      await abandon(exact);
      const atBudget = streamingAnswer(exact.fetch, { totalBytes: ABANDONED_READ_DRAIN_BUDGET_BYTES });
      await vi.advanceTimersByTimeAsync(0);
      expect(atBudget.pulled()).toBe(ABANDONED_READ_DRAIN_BUDGET_BYTES);
      expect(atBudget.cancelled()).toBe(false);
      // Read to its clean end: nothing is owed a restart.
      expect(vi.getTimerCount()).toBe(0);

      const over = await dispatch();
      await abandon(over);
      const overBudget = streamingAnswer(over.fetch, { totalBytes: ABANDONED_READ_DRAIN_BUDGET_BYTES + 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(overBudget.pulled()).toBe(ABANDONED_READ_DRAIN_BUDGET_BYTES + 1);
      expect(overBudget.cancelled()).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect(recover).toHaveBeenCalledExactlyOnceWith('query');
    } finally { await store.close(); }
  });

  it('keeps the recovery of an error answer that starts after the caller left when its body is reset', async () => {
    const { store, recover, dispatch, abandon } = harness();
    try {
      const read = await dispatch();
      await abandon(read);
      const answer = streamingAnswer(read.fetch, {
        totalBytes: RUNAWAY_BYTES,
        stallAfterBytes: CHUNK_BYTES,
        init: { status: 500 },
      });
      await vi.advanceTimersByTimeAsync(0);
      answer.reset();
      answer.resume();
      await vi.advanceTimersByTimeAsync(0);
      // A reset body shows nothing about the server having finished.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect(recover).toHaveBeenCalledExactlyOnceWith('query');
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

  // Discarding what remains of an abandoned answer is lifecycle work too, not a
  // background task that outlives close(). (Preservation: the discard was
  // already inside the lifecycle before it was bounded.)
  it.each([
    ['before the answer began', false],
    ['while the answer was being read', true],
  ] as const)('keeps close pending while an answer whose caller left %s is being discarded, and stops the read', async (_when, midBody) => {
    const { store, recover, dispatch, abandon } = harness('managed', TIMEOUT_MS, { holdAbort: true });
    const read = await dispatch();
    let answer!: ReturnType<typeof streamingAnswer>;
    if (midBody) {
      answer = streamingAnswer(read.fetch, { totalBytes: RUNAWAY_BYTES, stallAfterBytes: CHUNK_BYTES });
      await vi.advanceTimersByTimeAsync(0);
      await abandon(read);
    } else {
      await abandon(read);
      answer = streamingAnswer(read.fetch, { totalBytes: RUNAWAY_BYTES, stallAfterBytes: CHUNK_BYTES });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(answer.pulled()).toBe(CHUNK_BYTES);

    let closed = false;
    const closing = store.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(0);
    // Close aborts the transport, which errors the body under the reader.
    expect(read.fetch.signal.aborted).toBe(true);
    await closing;
    expect(closed).toBe(true);
    expect(answer.pulled()).toBe(CHUNK_BYTES);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
    expect(recover).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['before the answer began', false],
    ['while the answer was being read', true],
  ] as const)('keeps close pending until the discard of an answer whose caller left %s has really settled', async (_when, midBody) => {
    // A transport whose body does not react to the abort: the discard's read
    // stays pending, and close() must not report the store closed meanwhile.
    const { store, recover, dispatch, abandon } = harness();
    const read = await dispatch();
    let answer!: ReturnType<typeof streamingAnswer>;
    const start = () => streamingAnswer(read.fetch, {
      totalBytes: 4 * CHUNK_BYTES,
      stallAfterBytes: CHUNK_BYTES,
      ignoreAbort: true,
    });
    if (midBody) {
      answer = start();
      await vi.advanceTimersByTimeAsync(0);
      await abandon(read);
    } else {
      await abandon(read);
      answer = start();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(answer.pulled()).toBe(CHUNK_BYTES);

    let closed = false;
    const closing = store.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
    expect(read.fetch.signal.aborted).toBe(true);
    // The discard is still waiting on the body.
    expect(closed).toBe(false);

    answer.resume();
    await closing;
    expect(closed).toBe(true);
    expect(recover).not.toHaveBeenCalled();
  });

  it('frees the scheduler slot when the caller leaves, as it did before detaching', async () => {
    // Characterization, not endorsement: this pins the admission behaviour the
    // change inherits, so altering it is a deliberate decision. Aborting the
    // fetch used to settle the scheduled operation at once, releasing its slot;
    // the detached request settles the operation at the same point, and the
    // second read starts although the first request has not finished. What the
    // server does meanwhile depends on the answer (a streamed evaluation stops
    // at its next write to a closed socket, a blocking one keeps evaluating), on
    // the base as here.
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
