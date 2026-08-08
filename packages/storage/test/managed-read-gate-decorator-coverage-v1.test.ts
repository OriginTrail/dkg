import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ChangelogStore } from '../src/changelog-store.js';
import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import {
  asManagedReadGateV1,
  ManagedOxigraphBackendUnownedError,
} from '../src/managed-oxigraph-ownership-v1-internal.js';
import { SharedMemoryLiteralBlobStore } from '../src/shared-memory-literal-blob-store.js';
import type { TripleStore } from '../src/triple-store.js';

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
    assertManagedBackendReadableV1: vi.fn(),
    listGraphs: async () => [],
    query: async () => ({ type: 'boolean' as const, value: true }),
    insert: async () => undefined,
    delete: async () => undefined,
    close: async () => undefined,
  };
  return store as unknown as TripleStore & {
    assertManagedBackendReadableV1: ReturnType<typeof vi.fn>;
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

describe('managed read gate resolves through any wrapper chain', () => {
  it('finds the gate on the adapter itself', () => {
    const adapter = managedAdapter();
    expect(asManagedReadGateV1(adapter)).toBe(adapter);
  });

  it('returns null for a store with no managed backend anywhere', () => {
    // Unleased stores are always readable; resolution must not invent a gate.
    const bare = { listGraphs: async () => [] } as unknown as TripleStore;
    expect(asManagedReadGateV1(bare)).toBeNull();
  });

  it('resolves through every storage decorator, including private inner fields', () => {
    // `inner` is TypeScript-private on these two but present at runtime, which
    // is exactly what lets resolution work without them opting in.
    const adapter = managedAdapter();
    const chain = new ChangelogStore(
      new GraphSetIndexStore(new SharedMemoryLiteralBlobStore(adapter, BLOB_OPTIONS)),
      { enabled: true },
    );

    expect(asManagedReadGateV1(chain)).toBe(adapter);
  });

  it('resolves through a wrapper that declares NOTHING but innerStore', () => {
    // The finding this replaced the source-sweep for: the agent's forwarder
    // sits on a real store, drives its own read cache, and never knew about
    // this capability. Under the old shape the call evaporated here.
    const adapter = managedAdapter();

    expect(asManagedReadGateV1(opaqueForwarder(adapter))).toBe(adapter);
    expect(
      asManagedReadGateV1(opaqueForwarder(new SharedMemoryLiteralBlobStore(adapter, BLOB_OPTIONS))),
    ).toBe(adapter);
  });

  it('terminates on a cyclic chain instead of hanging', () => {
    const cyclic: { innerStore?: unknown } = {};
    cyclic.innerStore = cyclic;
    expect(asManagedReadGateV1(cyclic)).toBeNull();
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

    adapter.assertManagedBackendReadableV1.mockImplementation(() => {
      throw new ManagedOxigraphBackendUnownedError('probe', true, 'port-release-unproven');
    });

    await expect(index.listGraphs()).rejects.toThrow(ManagedOxigraphBackendUnownedError);
  });
});
