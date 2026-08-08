import { describe, expect, it, vi } from 'vitest';

import {
  asManagedReadGateV1,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';

/**
 * The daemon's store is wrapped by this hand-rolled forwarder, and the forwarder
 * drives an external read cache through its `invalidate()` callback — so reads
 * genuinely can be answered above it without delegating downward.
 *
 * Under the previous design the managed read gate was an optional method every
 * wrapper had to re-declare, and this one (in a different package) did not. A
 * cache-owning layer above it would have called `assertManagedBackendReadableV1?.()`,
 * found nothing, and treated the absence as permission — the exact fail-open
 * shape the gate exists to prevent. A source-scanning test in packages/storage
 * could never have seen it.
 *
 * Resolution walks `.innerStore`, which this wrapper already exposes, so it is
 * transparent without knowing the capability exists.
 */
const managedAdapter = () => {
  const store = {
    assertManagedBackendReadableV1: vi.fn(),
    listGraphs: async () => [],
    listGraphsByPrefix: async () => [],
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

describe('managed read gate resolves through the agent store wrapper', () => {
  it('is transparent: the gate resolves to the adapter beneath it', () => {
    const adapter = managedAdapter();
    const wrapped = createListContextGraphsCacheInvalidatingStore(adapter, () => undefined);

    expect(asManagedReadGateV1(wrapped)).toBe(adapter);
  });

  it('a resolved gate on the wrapper refuses exactly when the adapter refuses', () => {
    const adapter = managedAdapter();
    const wrapped = createListContextGraphsCacheInvalidatingStore(adapter, () => undefined);
    const gate = asManagedReadGateV1(wrapped);

    // Live: no refusal.
    expect(() => gate?.assertManagedBackendReadableV1('probe')).not.toThrow();

    adapter.assertManagedBackendReadableV1.mockImplementation(() => {
      throw new Error('managed backend is not the proven ready listener');
    });
    expect(() => gate?.assertManagedBackendReadableV1('probe')).toThrow(
      /not the proven ready listener/,
    );
  });

  it('stays null for an unleased store behind the same wrapper', () => {
    // Forwarding must not invent a gate where there is no managed backend.
    const bare = {
      listGraphs: async () => [],
      close: async () => undefined,
    } as unknown as TripleStore;

    expect(
      asManagedReadGateV1(createListContextGraphsCacheInvalidatingStore(bare, () => undefined)),
    ).toBeNull();
  });
});
