import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ChangelogStore, asChangelogReader } from '../src/changelog-store.js';
import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { asGraphWriteGenSource } from '../src/graph-write-gen.js';
import { ManagedOxigraphBackendUnownedError } from '../src/managed-oxigraph-backend-unowned-error.js';
import {
  CACHED_READ_GATE_V1,
  asCachedReadGateV1,
} from '../src/cached-read-gate-v1.js';
import { SharedMemoryLiteralBlobStore } from '../src/shared-memory-literal-blob-store.js';
import { StoreChainCycleError } from '../src/store-chain-capability.js';
import {
  createTripleStore,
  registerTripleStoreAdapter,
  type TripleStore,
} from '../src/triple-store.js';

/**
 * The read gate is RESOLVED through the chain, not forwarded by each wrapper.
 *
 * The forwarding shape this replaced required every present and future
 * decorator — in every package — to re-declare an optional method it did not
 * otherwise care about, and optional chaining meant any wrapper that forgot
 * silently turned a fail-closed read into a fail-open one. Policing that needed
 * a source-scanning test, which is itself a sign the abstraction was wrong: it
 * could only see `packages/storage/src`, so the agent's hand-rolled forwarder
 * was invisible to it.
 *
 * Resolution removes the obligation entirely. A wrapper only has to expose its
 * inner store — which it already must, for `asChangelogReader` and
 * `asGraphWriteGenSource` to work.
 */
const BLOB_OPTIONS = {
  blobDir: join(process.cwd(), 'test', '.tmp-unused'),
  thresholdBytes: 1_000_000,
};

/** Stands in for the managed adapter: the only thing that declares the gate. */
const managedAdapter = () => {
  const store = {
    [CACHED_READ_GATE_V1]: vi.fn(),
    listGraphs: async () => [],
    query: async () => ({ type: 'boolean' as const, value: true }),
    insert: async () => undefined,
    delete: async () => undefined,
    close: async () => undefined,
  };
  return store as unknown as TripleStore & {
    [CACHED_READ_GATE_V1]: ReturnType<typeof vi.fn>;
  };
};

/**
 * A hand-rolled forwarder that exposes `innerStore` but declares nothing else —
 * the exact shape of `createListContextGraphsCacheInvalidatingStore` in
 * packages/agent. Reproduced structurally here rather than imported, because
 * storage must not depend on agent; the agent-side behaviour is covered by its
 * own suite.
 */
const opaqueForwarder = (innerStore: TripleStore): TripleStore =>
  ({
    innerStore,
    listGraphs: () => innerStore.listGraphs(),
    query: (...args: Parameters<TripleStore['query']>) => innerStore.query(...args),
    insert: (...args: Parameters<TripleStore['insert']>) => innerStore.insert(...args),
    delete: (...args: Parameters<TripleStore['delete']>) => innerStore.delete(...args),
    close: () => innerStore.close(),
  }) as unknown as TripleStore;

describe('cached-read gate resolves through any wrapper chain', () => {
  it('finds the gate on the adapter itself', () => {
    const adapter = managedAdapter();
    expect(asCachedReadGateV1(adapter)).toBe(adapter);
  });

  it('returns null for a store with no managed backend anywhere', () => {
    // Unleased stores are always readable; resolution must not invent a gate.
    const bare = { listGraphs: async () => [] } as unknown as TripleStore;
    expect(asCachedReadGateV1(bare)).toBeNull();
  });

  it('resolves through every storage decorator', () => {
    // Three different opt-in shapes in one chain: `ChangelogStore` and
    // `GraphSetIndexStore` expose the symbol accessor (traversable without
    // publishing their wrapped store), `SharedMemoryLiteralBlobStore` has a
    // pre-existing public `innerStore`.
    const adapter = managedAdapter();
    const chain = new ChangelogStore(
      new GraphSetIndexStore(new SharedMemoryLiteralBlobStore(adapter, BLOB_OPTIONS)),
      { enabled: true },
    );

    expect(asCachedReadGateV1(chain)).toBe(adapter);
  });

  it('resolves through a wrapper that declares NOTHING but innerStore', () => {
    // The finding this replaced the source-sweep for: the agent's forwarder
    // sits on a real store, drives its own read cache, and never knew about
    // this capability. Under the old shape the call evaporated here.
    const adapter = managedAdapter();

    expect(asCachedReadGateV1(opaqueForwarder(adapter))).toBe(adapter);
    expect(
      asCachedReadGateV1(opaqueForwarder(new SharedMemoryLiteralBlobStore(adapter, BLOB_OPTIONS))),
    ).toBe(adapter);
  });

  it('all THREE capabilities resolve through the same wrapper chain', () => {
    // The consolidation check. These walkers used to be three separate copies
    // and had already diverged — `asChangelogReader` followed only
    // `.innerStore` while the other two also followed `.inner`. A traversal gap
    // surfaces as `null`, which every caller reads as "this store does not have
    // the capability", so divergence is silent by construction. Asserting all
    // three against ONE composition is what makes a future drift visible.
    const adapter = managedAdapter();
    const chain = new ChangelogStore(
      new GraphSetIndexStore(new SharedMemoryLiteralBlobStore(adapter, BLOB_OPTIONS)),
      { enabled: true },
    );
    const wrapped = opaqueForwarder(chain);

    // Read gate lives on the innermost adapter.
    expect(asCachedReadGateV1(wrapped)).toBe(adapter);
    // Changelog reader lives on the OUTERMOST decorator — opposite direction,
    // so this also proves the walk starts where it should.
    expect(asChangelogReader(wrapped)).toBe(chain);
    // Write-gen source is absent here; `null` must mean absent, not "gave up".
    expect(asGraphWriteGenSource(wrapped)).toBeNull();
  });

  it('finds a write-gen source through the same chain when one exists', () => {
    // The positive half of the assertion above: prove `null` was a real absence
    // rather than a traversal that stops early.
    const adapter = managedAdapter() as unknown as Record<string, unknown>;
    adapter.getWriteGen = () => 1;
    const chain = opaqueForwarder(
      new GraphSetIndexStore(
        new SharedMemoryLiteralBlobStore(adapter as unknown as TripleStore, BLOB_OPTIONS),
      ),
    );

    expect(asGraphWriteGenSource(chain)).toBe(adapter);
  });

  it('every first-party storage wrapper is traversable by REGISTRATION alone', () => {
    // The claim that makes registration "the" contract rather than one of
    // several. `.innerStore` is still honoured as a pre-existing public
    // convention, so a wrapper relying only on that would still resolve and the
    // ordinary tests could not tell the difference. Resolving with a walker that
    // consults ONLY the registry is what proves first-party code no longer
    // depends on any public handle.
    //
    // Note there is deliberately no way to READ the registry from outside the
    // module — so this walks by asking each wrapper to resolve a capability
    // through the real resolver on a chain whose public handles are stripped.
    const adapter = managedAdapter();
    const chain = new ChangelogStore(
      new GraphSetIndexStore(new SharedMemoryLiteralBlobStore(adapter, BLOB_OPTIONS)),
      { enabled: true },
    );

    // Strip every public traversal handle the chain exposes. Only the
    // module-private registration links survive.
    for (let node: unknown = chain; node; ) {
      const current = node as { innerStore?: unknown; inner?: unknown };
      const next = current.innerStore ?? current.inner;
      Object.defineProperty(current, 'innerStore', { value: undefined, configurable: true });
      Object.defineProperty(current, 'inner', { value: undefined, configurable: true });
      node = next;
    }

    expect(asCachedReadGateV1(chain)).toBe(adapter);
  });

  it('THROWS on a cyclic chain rather than reporting absence', () => {
    // A cycle is a broken object graph, not "this store has no gate". Reporting
    // it as `null` would read as an unleased store — fail-OPEN, the exact
    // failure this whole change exists to prevent. Termination is by object
    // identity, so there is no depth cap to silently convert a legitimately
    // deep chain into a false absence either.
    const cyclic: { innerStore?: unknown } = {};
    cyclic.innerStore = cyclic;

    expect(() => asCachedReadGateV1(cyclic)).toThrow(StoreChainCycleError);
  });

  it('resolves through a chain far deeper than any previous depth cap', () => {
    // The old implementation capped at 8 and returned `null` beyond it. Twenty
    // transparent forwarders must still resolve.
    const adapter = managedAdapter();
    let chain: TripleStore = adapter;
    for (let i = 0; i < 20; i++) chain = opaqueForwarder(chain);

    expect(asCachedReadGateV1(chain)).toBe(adapter);
  });

  it('refuses a WARM read through an opaque forwarder — the end-to-end property', async () => {
    // Resolution is only worth anything if the CONSUMER fails closed through
    // the same chain. `GraphSetIndexStore` resolves at construction, so the
    // forwarder in between cannot erase the refusal.
    const adapter = managedAdapter();
    const index = new GraphSetIndexStore(opaqueForwarder(adapter));

    // Warm first: a COLD index goes to refresh, which is the path that was
    // already fail-closed. The warm branch is the one under test.
    await index.listGraphs();

    adapter[CACHED_READ_GATE_V1].mockImplementation(() => {
      throw new ManagedOxigraphBackendUnownedError('probe', true, 'port-release-unproven');
    });

    await expect(index.listGraphs()).rejects.toThrow(ManagedOxigraphBackendUnownedError);
  });

  it('the PRODUCTION resolver reaches the backend through the whole FACTORY chain', async () => {
    // The composition callers actually get, asserted with the production
    // resolver rather than a hand-rolled walk. Every case above builds its
    // chain by hand; this one lets `createTripleStore` build it, so a wrapper
    // added to the factory that does not participate breaks resolution here
    // regardless of what it names its fields.
    const probe = managedAdapter();
    const backend = 'store-chain-participation-probe';
    registerTripleStoreAdapter(backend, async () => probe);

    const store = await createTripleStore({
      backend,
      changelog: { enabled: true },
      graphSetIndex: true,
      largeLiteralStorage: {
        enabled: true,
        directory: join(process.cwd(), 'test', '.tmp-unused'),
      },
    });

    expect(asCachedReadGateV1(store)).toBe(probe);

    await store.close().catch(() => undefined);
  });
});
