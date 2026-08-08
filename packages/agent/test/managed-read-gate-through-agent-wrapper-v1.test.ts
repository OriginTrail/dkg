import { describe, expect, it, vi } from 'vitest';

import {
  GraphSetIndexStore,
  ManagedOxigraphBackendUnownedError,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';

/**
 * The daemon's store is wrapped by this hand-rolled forwarder, and the forwarder
 * drives an external read cache through its `invalidate()` callback — so reads
 * genuinely can be answered above it without delegating downward.
 *
 * A previous design made the managed read gate an optional method every wrapper
 * had to re-declare; this one, in a different package, did not, so the gate
 * silently vanished here and warm reads went fail-open. A source-scanning test
 * inside packages/storage could never have seen it, which is why the coverage
 * lives here.
 *
 * This asserts the PRODUCTION property — a warm read refuses once ownership is
 * lost — rather than the resolver mechanism. The resolver is storage-internal
 * and deliberately not part of the published API, so testing it from here would
 * have meant widening that API for a test.
 */
const managedAdapter = () => {
  const store = {
    // The one thing only the managed adapter declares. Stands in for the real
    // lease-snapshot check, which needs no I/O.
    assertManagedBackendReadableV1: vi.fn(),
    listGraphs: async () => ['urn:g:1'],
    listGraphsByPrefix: async () => ['urn:g:1'],
    query: async () => ({ type: 'boolean' as const, value: true }),
    insert: async () => undefined,
    delete: async () => undefined,
    deleteByPattern: async () => 0,
    deleteBySubjectPrefix: async () => 0,
    hasGraph: async () => false,
    createGraph: async () => undefined,
    dropGraph: async () => undefined,
    countQuads: async () => 0,
    close: async () => undefined,
  };
  return store as unknown as TripleStore & {
    assertManagedBackendReadableV1: ReturnType<typeof vi.fn>;
  };
};

/** The production shape: index over the agent forwarder over the managed adapter. */
const composed = (adapter: TripleStore) =>
  new GraphSetIndexStore(
    createListContextGraphsCacheInvalidatingStore(adapter, () => undefined),
  );

describe('managed read gate survives the agent store wrapper', () => {
  it('refuses a WARM listGraphs once ownership is lost', async () => {
    const adapter = managedAdapter();
    const index = composed(adapter);

    await index.listGraphs(); // warm the index

    adapter.assertManagedBackendReadableV1.mockImplementation(() => {
      throw new ManagedOxigraphBackendUnownedError('probe', true, 'port-release-unproven');
    });

    await expect(index.listGraphs()).rejects.toThrow(ManagedOxigraphBackendUnownedError);
  });

  it('refuses a WARM listGraphsByPrefix once ownership is lost', async () => {
    const adapter = managedAdapter();
    const index = composed(adapter);

    await index.listGraphs();

    adapter.assertManagedBackendReadableV1.mockImplementation(() => {
      throw new ManagedOxigraphBackendUnownedError('probe', true, 'port-release-unproven');
    });

    await expect(index.listGraphsByPrefix('urn:')).rejects.toThrow(
      ManagedOxigraphBackendUnownedError,
    );
  });

  it('still serves a warm read while ownership is live', async () => {
    // Positive control: without it, "always refuse" would satisfy both cases
    // above and the wrapper could be breaking reads rather than gating them.
    const adapter = managedAdapter();
    const index = composed(adapter);

    await index.listGraphs();
    await expect(index.listGraphs()).resolves.toEqual(['urn:g:1']);
    expect(adapter.assertManagedBackendReadableV1).toHaveBeenCalled();
  });

  it('leaves an unleased store behind the same wrapper untouched', async () => {
    // No managed backend anywhere in the chain must mean no refusal invented.
    const bare = {
      listGraphs: async () => ['urn:g:1'],
      query: async () => ({ type: 'boolean' as const, value: true }),
      close: async () => undefined,
    } as unknown as TripleStore;

    const index = composed(bare);

    await index.listGraphs();
    await expect(index.listGraphs()).resolves.toEqual(['urn:g:1']);
  });
});
