import { describe, it, expect } from 'vitest';
import { OxigraphWorkerStore, type Quad } from '../src/index.js';

// These exercise the embedded worker adapter's resilience guards added to stop
// a single slow/wedged store op from hanging every other store-backed request
// behind it (issues #997 / #999 / #1002 / #1005 / #1008). They need the
// compiled worker artifact (`dist/adapters/oxigraph-worker-impl.js`); if it's
// missing we fail loudly with the remediation hint rather than silently skip,
// matching `storage.test.ts`'s convention.
function makeStore(opts?: { operationTimeoutMs?: number; insertChunkSize?: number }): OxigraphWorkerStore {
  try {
    return new OxigraphWorkerStore(undefined, opts);
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

describe('OxigraphWorkerStore resilience', () => {
  it('rejects a slow operation after operationTimeoutMs instead of hanging forever', async () => {
    // 50k inserts take hundreds of ms; a 5ms bound must reject well before that.
    const store = makeStore({ operationTimeoutMs: 5, insertChunkSize: 0 });
    try {
      await expect(store.insert(quads(50_000))).rejects.toThrow(/timed out after 5ms/);
    } finally {
      await closeQuietly(store);
    }
  });

  it('bounds each chunk of a large insert by the timeout', async () => {
    const store = makeStore({ operationTimeoutMs: 5, insertChunkSize: 25_000 });
    try {
      await expect(store.insert(quads(50_000))).rejects.toThrow(/timed out/);
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
      const r = await store.query('ASK { GRAPH <urn:test:g> { ?s ?p ?o } }');
      expect(r.type).toBe('boolean');
      if (r.type === 'boolean') expect(r.value).toBe(true);
    } finally {
      await closeQuietly(store);
    }
  });

  it('operationTimeoutMs: 0 disables the timeout (a large op still completes)', async () => {
    const store = makeStore({ operationTimeoutMs: 0, insertChunkSize: 0 });
    try {
      await store.insert(quads(50_000));
      expect(await store.countQuads('urn:test:g')).toBe(50_000);
    } finally {
      await closeQuietly(store);
    }
  });

  it('chunked insert writes every quad across chunk boundaries', async () => {
    const store = makeStore({ operationTimeoutMs: 60_000, insertChunkSize: 1_000 });
    try {
      await store.insert(quads(5_000));
      expect(await store.countQuads('urn:test:g')).toBe(5_000);
    } finally {
      await closeQuietly(store);
    }
  });

  it('chunking is OFF by default — a large insert is one atomic op (opt-in only)', async () => {
    // Codex review: chunking weakens the all-or-nothing insert contract, so it
    // must be opt-in. With defaults (insertChunkSize 0) a >25k insert still goes
    // as a single message and commits atomically.
    const store = makeStore({ operationTimeoutMs: 60_000 });
    try {
      await store.insert(quads(30_000));
      expect(await store.countQuads('urn:test:g')).toBe(30_000);
    } finally {
      await closeQuietly(store);
    }
  });

  it('close() is exempt from the per-op timeout so the final flush is never cut short', async () => {
    // Codex review: close runs the worker's final flush; bounding it by the
    // per-op timeout could terminate() the thread mid-flush and lose writes.
    // With a tiny operationTimeoutMs and the worker still busy on a large
    // insert, close() must WAIT for the worker to drain rather than reject.
    const store = makeStore({ operationTimeoutMs: 10, insertChunkSize: 0 });
    // Caller times out at 10ms, but the worker keeps running the insert.
    await expect(store.insert(quads(50_000))).rejects.toThrow(/timed out/);
    // close() must resolve cleanly (not reject with a 10ms timeout): it waits
    // for the in-flight op to drain, then flushes + terminates.
    await expect(store.close()).resolves.toBeUndefined();
  });
});
