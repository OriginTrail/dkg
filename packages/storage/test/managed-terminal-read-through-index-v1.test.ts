import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { ManagedOxigraphBackendUnownedError } from '../src/managed-oxigraph-ownership-v1-internal.js';
import { CACHED_READ_GATE_V1 } from '../src/cached-read-gate-v1.js';
import type { Quad, QueryOptions, QueryResult, TripleStore } from '../src/triple-store.js';

/**
 * The terminal read refusal must survive the DECORATOR, not just the adapter.
 *
 * `GraphSetIndexStore.refreshIndex()` deliberately tolerates transient store
 * failures: once the index is warm, a failed periodic revalidation returns the
 * last known graph set rather than making every reader repeat an expensive scan.
 *
 * Measured before this was fixed: with a warm index, a terminal lease made the
 * adapter refuse correctly and that handler returned the stale set as a
 * SUCCESS — so `listGraphs()` and `listGraphsByPrefix()` kept answering forever
 * while the guarantee was gone. A fail-closed guard one layer down was silently
 * fail-open here.
 *
 * That is why these tests exist at this layer and are written against a WARM
 * index specifically: the equivalent assertions on a cold index, or against the
 * adapter alone, PASS on the broken code.
 */
class FakeInnerStore implements Partial<TripleStore> {
  graphs: string[] = ['urn:g:1', 'urn:g:2'];
  failWith: Error | null = null;
  listGraphCalls = 0;

  /** Ownership, independent of `failWith`, so the warm path can be driven alone. */
  unowned: ManagedOxigraphBackendUnownedError | null = null;
  readableChecks = 0;

  [CACHED_READ_GATE_V1](_operation: string): void {
    this.readableChecks += 1;
    if (this.unowned) throw this.unowned;
  }

  async listGraphs(): Promise<string[]> {
    this.listGraphCalls += 1;
    if (this.failWith) throw this.failWith;
    return [...this.graphs];
  }

  // The real adapter refuses every delegated read once the lease is lost, so
  // the fake must too — otherwise a test could "pass" through a path that
  // production would have refused anyway.
  async hasGraph(): Promise<boolean> {
    if (this.unowned) throw this.unowned;
    if (this.failWith) throw this.failWith;
    return true;
  }

  async query(): Promise<QueryResult> {
    if (this.unowned) throw this.unowned;
    if (this.failWith) throw this.failWith;
    return { type: 'boolean', value: true };
  }

  async insert(_quads: Quad[], _options?: QueryOptions): Promise<void> {}
  async close(): Promise<void> {}
}

const unowned = () =>
  new ManagedOxigraphBackendUnownedError('sparql-http.query', true, 'port-release-unproven');

describe('terminal read refusal through the graph-set index', () => {
  let inner: FakeInnerStore;
  let store: GraphSetIndexStore;

  beforeEach(async () => {
    inner = new FakeInnerStore();
    store = new GraphSetIndexStore(inner as unknown as TripleStore, {
      // Long enough that nothing revalidates on its own; each test drives it.
      revalidateMs: 50,
    });
    // WARM the index. Everything below depends on this: a cold index already
    // propagates, so a test that skipped this step would pass on broken code.
    await store.listGraphs();
    expect(inner.listGraphCalls).toBeGreaterThan(0);
  });

  afterEach(async () => {
    await store.close().catch(() => undefined);
  });

  it('propagates the refusal from listGraphs instead of serving the stale set', async () => {
    inner.failWith = unowned();
    await new Promise((r) => setTimeout(r, 60)); // let the revalidation window open

    await expect(store.listGraphs()).rejects.toThrow(ManagedOxigraphBackendUnownedError);
  });

  it('propagates the refusal from listGraphsByPrefix', async () => {
    inner.failWith = unowned();
    await new Promise((r) => setTimeout(r, 60));

    await expect(store.listGraphsByPrefix('urn:g:')).rejects.toThrow(
      ManagedOxigraphBackendUnownedError,
    );
  });

  it('refuses from the WARM cache, before the revalidation window opens', async () => {
    // The gap the three tests above cannot see. Each of them first waits out
    // `revalidateMs`, so they only ever exercise the REFRESH path. Inside the
    // window `ensureGraphSet()` returns `this.graphs` without touching the
    // inner store at all, so ownership is never consulted and a lost lease
    // keeps serving enumeration for up to the revalidation interval (30s in
    // production).
    //
    // No `setTimeout` here on purpose: the read happens while the cache is
    // still fresh. `unowned` rather than `failWith`, so ONLY the ownership
    // predicate can produce the refusal — if the cache were silently expiring
    // and refreshing, the inner `listGraphs()` would succeed and this would not
    // reject at all.
    inner.unowned = unowned();
    const listCallsBefore = inner.listGraphCalls;

    await expect(store.listGraphs()).rejects.toThrow(ManagedOxigraphBackendUnownedError);

    // The refusal came from consulting ownership on the warm path, not from a
    // refresh: the inner store was never re-scanned.
    expect(inner.readableChecks).toBeGreaterThan(0);
    expect(inner.listGraphCalls).toBe(listCallsBefore);
  });

  it('consults ownership on the warm path for listGraphsByPrefix too', async () => {
    // The other entry point through `ensureGraphSet`. Without this, a fix
    // applied to `listGraphs` alone would look complete.
    //
    // `hasGraph` is deliberately absent: on the enabled path it always
    // delegates to the inner store, so it is not a warm-serving path and the
    // adapter's own read check already covers it.
    inner.unowned = unowned();
    const listCallsBefore = inner.listGraphCalls;

    await expect(store.listGraphsByPrefix('urn:g:')).rejects.toThrow(
      ManagedOxigraphBackendUnownedError,
    );
    expect(inner.listGraphCalls).toBe(listCallsBefore);
  });

  it('does not refuse a warm read while ownership is still live', async () => {
    // The positive control. Without it, "always throw on the warm path" would
    // pass every assertion above.
    const callsBefore = inner.listGraphCalls;

    await expect(store.listGraphs()).resolves.toEqual(['urn:g:1', 'urn:g:2']);

    expect(inner.readableChecks).toBeGreaterThan(0);
    expect(inner.listGraphCalls).toBe(callsBefore);
  });

  it('STILL tolerates an ordinary transient failure on a warm index', async () => {
    // The negative control, and the reason the guard is a type check rather
    // than "rethrow everything": the tolerance this decorator exists for must
    // survive. Without this, the fix above could be "delete the catch" and
    // every test would still pass.
    inner.failWith = new Error('ECONNRESET');
    await new Promise((r) => setTimeout(r, 60));

    await expect(store.listGraphs()).resolves.toEqual(['urn:g:1', 'urn:g:2']);
  });
});
