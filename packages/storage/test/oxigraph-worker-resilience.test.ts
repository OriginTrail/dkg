import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphWorkerStore, createTripleStore, type Quad } from '../src/index.js';

// These exercise the embedded worker adapter's resilience guards added to stop
// a single slow/wedged store op from hanging every other store-backed request
// behind it (issues #997 / #999 / #1002 / #1005 / #1008). They need the
// compiled worker artifact (`dist/adapters/oxigraph-worker-impl.js`); if it's
// missing we fail loudly with the remediation hint rather than silently skip,
// matching `storage.test.ts`'s convention.
//
// Design note: the per-op timeout is applied to READ-ONLY ops only. A read is
// side-effect-free, so rejecting it after the bound is a clean, determinate
// failure that surfaces a wedged worker on the exact paths that hang in prod.
// Mutations are left unbounded — timing one out would only drop the caller's
// promise while the write is still in flight, which the rest of the codebase
// would mis-read as a clean failure. So the timeout tests provoke a timeout by
// queuing a READ behind a busy worker, not by bounding a write.
function makeStore(opts?: { operationTimeoutMs?: number }, persistPath?: string): OxigraphWorkerStore {
  try {
    return new OxigraphWorkerStore(persistPath, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/oxigraph-worker-impl/.test(msg)) {
      throw new Error(
        `oxigraph-worker adapter is not runnable — run ` +
          `\`pnpm --filter @origintrail-official/dkg-storage build\` first. Underlying: ${msg}`,
      );
    }
    throw err;
  }
}

// For the timeout tests the worker is left mid-operation; close() forcibly
// terminates the thread, but the graceful close reply may itself time out, so
// swallow any error during teardown.
async function closeQuietly(store: OxigraphWorkerStore): Promise<void> {
  await store.close().catch(() => {});
}

function quads(n: number): Quad[] {
  const out: Quad[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = {
      subject: `urn:test:s:${i}`,
      predicate: 'http://schema.org/name',
      object: `"v${i}"`,
      graph: 'urn:test:g',
    };
  }
  return out;
}

function abortDuringListenerRegistration(message: string): AbortSignal {
  let aborted = false;
  let reason: Error | undefined;
  return {
    get aborted() {
      return aborted;
    },
    get reason() {
      return reason;
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type !== 'abort') return;
      aborted = true;
      reason = new Error(message);
      if (typeof listener === 'function') listener(new Event('abort'));
      else listener.handleEvent(new Event('abort'));
    },
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    onabort: null,
  } as unknown as AbortSignal;
}

// Occupy the single worker thread with a large UNBOUNDED insert (mutations are
// not bounded by the timeout), so a read posted right after it queues behind a
// busy worker — the production "wedged worker" signature in miniature.
const BUSY_QUERY = 'ASK { GRAPH <urn:test:g> { ?s ?p ?o } }';

describe('OxigraphWorkerStore resilience', () => {
  const GRAPH_A = 'urn:test:tracked:a';
  const GRAPH_B = 'urn:test:tracked:b';
  const GRAPH_C = 'urn:test:tracked:c';
  const quadFor = (graph: string): Quad => ({
    subject: `urn:test:subject:${graph}`,
    predicate: 'urn:test:predicate',
    object: '"value"',
    graph,
  });
  const mutationCases: Array<{
    name: string;
    affected: string[];
    invoke: (store: OxigraphWorkerStore) => Promise<unknown>;
  }> = [
    {
      name: 'multi-graph insert',
      affected: [GRAPH_A, GRAPH_B],
      invoke: (store) => store.insert([quadFor(GRAPH_A), quadFor(GRAPH_B)]),
    },
    {
      name: 'multi-graph delete',
      affected: [GRAPH_A, GRAPH_B],
      invoke: (store) => store.delete([quadFor(GRAPH_A), quadFor(GRAPH_B)]),
    },
    {
      name: 'scoped pattern delete',
      affected: [GRAPH_A],
      invoke: (store) => store.deleteByPattern({ graph: GRAPH_A }),
    },
    {
      name: 'unscoped pattern delete',
      affected: [GRAPH_A, GRAPH_B, GRAPH_C],
      invoke: (store) => store.deleteByPattern({ predicate: 'urn:test:predicate' }),
    },
    {
      name: 'one-graph replace',
      affected: [GRAPH_A],
      invoke: (store) => store.replaceGraph(GRAPH_A, []),
    },
    {
      name: 'two-graph atomic replace',
      affected: [GRAPH_A, GRAPH_B],
      invoke: (store) => store.replaceGraphAndSubject(
        GRAPH_A,
        [],
        GRAPH_B,
        'urn:test:metadata-subject',
        [],
      ),
    },
    {
      name: 'subject replace',
      affected: [GRAPH_A],
      invoke: (store) => store.replaceSubject(GRAPH_A, 'urn:test:subject', []),
    },
    {
      name: 'multi-subject replace',
      affected: [GRAPH_A],
      invoke: (store) => store.replaceSubjects(GRAPH_A, [
        { subject: 'urn:test:subject:a', quads: [] },
        { subject: 'urn:test:subject:b', quads: [] },
      ]),
    },
    {
      name: 'graph drop',
      affected: [GRAPH_A],
      invoke: (store) => store.dropGraph(GRAPH_A),
    },
    {
      name: 'subject-prefix delete',
      affected: [GRAPH_A],
      invoke: (store) => store.deleteBySubjectPrefix(GRAPH_A, 'urn:test:subject:'),
    },
    {
      name: 'unscoped raw update',
      affected: [GRAPH_A, GRAPH_B, GRAPH_C],
      invoke: (store) => store.update('CLEAR ALL'),
    },
  ];

  it('enforces the caller response budget on materialized worker results', async () => {
    const store = makeStore();
    try {
      await store.insert([quadFor(GRAPH_A)]);
      await expect(store.query(
        'SELECT ?s ?p ?o WHERE { GRAPH <urn:test:tracked:a> { ?s ?p ?o } }',
        { maxResponseBytes: 8 },
      )).rejects.toMatchObject({
        code: 'STORE_RESPONSE_TOO_LARGE',
        maxBytes: 8,
      });
    } finally {
      await closeQuietly(store);
    }
  });

  it.each(mutationCases.flatMap((mutation) => [
    { ...mutation, outcome: 'resolve' as const },
    { ...mutation, outcome: 'reject' as const },
  ]))('tracks $name through a worker $outcome', async ({ affected, invoke, outcome }) => {
    const store = makeStore({ operationTimeoutMs: 60_000 });
    const internals = store as unknown as {
      call(method: string, ...args: unknown[]): Promise<unknown>;
    };
    const originalCall = internals.call;
    let resolveCall!: () => void;
    let rejectCall!: (error: Error) => void;
    const pendingCall = new Promise<void>((resolve, reject) => {
      resolveCall = resolve;
      rejectCall = reject;
    });
    internals.call = () => pendingCall;
    try {
      const prefixes = [GRAPH_A, GRAPH_B, GRAPH_C];
      const before = new Map(prefixes.map((prefix) => [
        prefix,
        store.getWriteRevision(prefix),
      ]));
      const mutation = invoke(store);

      for (const prefix of prefixes) {
        const pending = store.getWriteRevision(prefix);
        const previous = before.get(prefix)!;
        if (affected.includes(prefix)) {
          expect(pending.generation).toBeGreaterThan(previous.generation);
          expect(pending.stable).toBe(false);
        } else {
          expect(pending).toEqual(previous);
        }
      }

      if (outcome === 'resolve') {
        resolveCall();
        await expect(mutation).resolves.toBeUndefined();
      } else {
        rejectCall(new Error('worker mutation rejected'));
        await expect(mutation).rejects.toThrow('worker mutation rejected');
      }

      for (const prefix of prefixes) {
        const settled = store.getWriteRevision(prefix);
        const previous = before.get(prefix)!;
        if (affected.includes(prefix)) {
          expect(settled.generation).toBeGreaterThan(previous.generation);
        } else {
          expect(settled.generation).toBe(previous.generation);
        }
        // A returned worker error is determinate: the atomic message settled,
        // so rejection must release the active scope rather than poisoning the
        // cache revision indefinitely.
        expect(settled.stable).toBe(true);
      }
    } finally {
      internals.call = originalCall;
      await closeQuietly(store);
    }
  });

  it('rejects a READ queued behind a busy worker after operationTimeoutMs', async () => {
    // 50k inserts take hundreds of ms; a 5ms bound on the queued read must
    // reject well before the worker frees up.
    const store = makeStore({ operationTimeoutMs: 5 });
    try {
      const busy = store.insert(quads(50_000)); // occupies the worker (unbounded)
      await expect(store.query(BUSY_QUERY)).rejects.toThrow(/timed out after 5ms/);
      await busy.catch(() => {});
    } finally {
      await closeQuietly(store);
    }
  });

  it('surfaces the timeout as a typed OXIGRAPH_WORKER_OP_TIMEOUT error', async () => {
    const store = makeStore({ operationTimeoutMs: 5 });
    try {
      const busy = store.insert(quads(50_000));
      const err: any = await store.query(BUSY_QUERY).then(() => null, (e) => e);
      expect(err).toBeTruthy();
      expect(err.code).toBe('OXIGRAPH_WORKER_OP_TIMEOUT');
      expect(err.method).toBe('query');
      expect(err.timeoutMs).toBe(5);
      await busy.catch(() => {});
    } finally {
      await closeQuietly(store);
    }
  });

  it('rejects a queued READ promptly when the caller aborts', async () => {
    const store = makeStore({ operationTimeoutMs: 60_000 });
    try {
      const busy = store.insert(quads(50_000));
      const controller = new AbortController();
      const read = store.query(BUSY_QUERY, { signal: controller.signal });
      controller.abort(new Error('caller aborted queued read'));
      await expect(read).rejects.toThrow(/caller aborted queued read/);
      await busy.catch(() => {});
    } finally {
      await closeQuietly(store);
    }
  });

  it('rejects when the caller aborts while registering the abort listener', async () => {
    const store = makeStore({ operationTimeoutMs: 60_000 });
    try {
      await expect(
        store.query(BUSY_QUERY, { signal: abortDuringListenerRegistration('listener registration aborted') }),
      ).rejects.toThrow(/listener registration aborted/);
    } finally {
      await closeQuietly(store);
    }
  });

  it('does NOT bound mutations — a large insert under a tiny timeout still completes', async () => {
    // The whole point of read-only scoping: a write is never reported as a clean
    // failure while it's still in flight. With a 5ms bound a 50k insert (>>5ms)
    // would reject if it were bounded; it must resolve instead.
    const store = makeStore({ operationTimeoutMs: 5 });
    try {
      await expect(store.insert(quads(50_000))).resolves.toBeUndefined();
    } finally {
      await closeQuietly(store);
    }
  });

  it('completes normally within a generous timeout', async () => {
    const store = makeStore({ operationTimeoutMs: 60_000 });
    try {
      await store.insert(quads(10));
      expect(await store.countQuads('urn:test:g')).toBe(10);
      // The data lives in a NAMED graph, so the ASK must scope to it (a bare
      // `ASK { ?s ?p ?o }` only matches the default graph).
      const r = await store.query(BUSY_QUERY);
      expect(r.type).toBe('boolean');
      if (r.type === 'boolean') expect(r.value).toBe(true);
    } finally {
      await closeQuietly(store);
    }
  });

  it('operationTimeoutMs: 0 disables the timeout (a queued read still completes)', async () => {
    const store = makeStore({ operationTimeoutMs: 0 });
    try {
      const busy = store.insert(quads(50_000));
      // With the bound disabled, the read WAITS for the worker instead of
      // rejecting, then returns true once the import lands.
      const r = await store.query(BUSY_QUERY);
      expect(r.type).toBe('boolean');
      if (r.type === 'boolean') expect(r.value).toBe(true);
      await busy;
      expect(await store.countQuads('urn:test:g')).toBe(50_000);
    } finally {
      await closeQuietly(store);
    }
  });

  it('a fractional operationTimeoutMs is floored to an integer', async () => {
    // normalizeNonNegativeInt floors the ms bound: 5.9 behaves like 5, so the
    // surfaced error reports "after 5ms" (no fractional noise).
    const store = makeStore({ operationTimeoutMs: 5.9 });
    try {
      const busy = store.insert(quads(50_000));
      await expect(store.query(BUSY_QUERY)).rejects.toThrow(/timed out after 5ms/);
      await busy.catch(() => {});
    } finally {
      await closeQuietly(store);
    }
  });

  it('close() is exempt from the per-op timeout so the final flush is never cut short', async () => {
    // Codex review: close runs the worker's final flush; bounding it by the
    // per-op timeout could terminate() the thread mid-flush and lose writes.
    // With a tiny operationTimeoutMs and the worker still busy on a large
    // insert, close() must WAIT for the worker to drain rather than reject —
    // AND the in-flight write must actually land, not get killed mid-flush.
    // We prove durability end-to-end on a persistent path: the regression this
    // guards (close-after-debounced-flush race) was a SILENT data loss, so the
    // test must assert the quads survive a reopen, not just that close resolves.
    const dir = mkdtempSync(join(tmpdir(), 'oxigraph-worker-close-'));
    const path = join(dir, 'store.nq');
    try {
      const store = makeStore({ operationTimeoutMs: 10 }, path);
      const busy = store.insert(quads(50_000)); // occupies the worker
      // A read queued behind it times out at 10ms — proves the worker is busy.
      await expect(store.query(BUSY_QUERY)).rejects.toThrow(/timed out/);
      // close() must resolve cleanly (not reject with a 10ms timeout): it waits
      // for the in-flight op to drain, then flushes + terminates.
      await expect(store.close()).resolves.toBeUndefined();
      // The in-flight insert must have COMPLETED (drained), not been terminated
      // mid-flight — otherwise close() silently cut it short.
      await expect(busy).resolves.toBeUndefined();
      // And the write must be durable: a fresh worker on the same path hydrates
      // all 50k quads, proving close() flushed before terminating.
      const reopened = makeStore({ operationTimeoutMs: 60_000 }, path);
      try {
        expect(await reopened.countQuads('urn:test:g')).toBe(50_000);
      } finally {
        await closeQuietly(reopened);
      }
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('concurrent and repeated close() calls all resolve without hanging', async () => {
    // Codex review: close() goes through an UNBOUNDED worker RPC, so a second
    // close racing the first was orphaned when terminate() killed the worker and
    // never settled. close() is now memoized + the worker 'exit' handler rejects
    // anything still pending, so concurrent/repeat closes all settle.
    const store = makeStore({ operationTimeoutMs: 60_000 });
    await store.insert(quads(5));
    const results = await Promise.all([store.close(), store.close(), store.close()]);
    expect(results).toEqual([undefined, undefined, undefined]);
    // Ops issued after close fail fast (store closed) instead of hanging.
    await new Promise((r) => setImmediate(r));
    await expect(store.insert(quads(1))).rejects.toThrow(/closed/i);
  });

  it('store.options reach the adapter through createTripleStore (factory path)', async () => {
    // Codex review: the user-facing path is createTripleStore({ backend, options }),
    // not the constructor — assert the option forwarding in the adapter factory
    // actually takes effect so a typo there can't silently drop the knob.
    // operationTimeoutMs forwarded: a 5ms bound rejects a read queued behind a
    // busy worker.
    const store = await createTripleStore({
      backend: 'oxigraph-worker',
      options: { operationTimeoutMs: 5 },
    });
    try {
      const busy = store.insert(quads(50_000));
      await expect(store.query(BUSY_QUERY)).rejects.toThrow(/timed out after 5ms/);
      await busy.catch(() => {});
    } finally {
      await store.close().catch(() => {});
    }
  });
});
