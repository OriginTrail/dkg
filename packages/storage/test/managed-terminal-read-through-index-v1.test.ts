import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { ManagedOxigraphBackendUnownedError } from '../src/managed-oxigraph-ownership-v1-internal.js';
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

  async listGraphs(): Promise<string[]> {
    this.listGraphCalls += 1;
    if (this.failWith) throw this.failWith;
    return [...this.graphs];
  }

  async hasGraph(): Promise<boolean> {
    if (this.failWith) throw this.failWith;
    return true;
  }

  async query(): Promise<QueryResult> {
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
