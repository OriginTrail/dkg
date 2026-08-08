import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ChangelogStore } from '../src/changelog-store.js';
import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { SharedMemoryLiteralBlobStore } from '../src/shared-memory-literal-blob-store.js';
import { CACHED_READ_GATE_V1, asCachedReadGateV1 } from '../src/cached-read-gate-v1.js';
import {
  createTripleStore,
  registerTripleStoreAdapter,
  type TripleStore,
} from '../src/triple-store.js';

/**
 * Every first-party storage decorator passes capability discovery through.
 *
 * The failure this guards: a decorator holds an inner store, satisfies
 * `TripleStore`, compiles, and never calls `linkStoreChainV1`. Discovery through
 * it then resolves to `null`, which callers read as "no constraint" — fail-open,
 * silently, because `null` is also the honest answer for an unmanaged store.
 *
 * ## What this is, and is not
 *
 * It is a PROOF for the decorators that exist: each is constructed over a probe
 * carrying the cached-read gate, and discovery must reach the probe through it.
 * A regression in any of them fails here.
 *
 * It is NOT enforcement for decorators that do not exist yet. An earlier
 * revision tried to be, by discovering exported classes reflectively and
 * demanding each be classified — but that selector was a heuristic (uppercase
 * export name plus four prototype methods), so a decorator written with
 * instance-field methods, or returned from a factory, would have slipped past
 * it while the suite reported enforcement. A guard that overstates its reach is
 * the same defect it was written to prevent, one level up.
 *
 * Enforcing participation for future decorators needs a mechanism the type
 * system or tooling can carry, and this repository currently has neither an
 * ESLint configuration nor a lint script for this package. That remains open as
 * #2168.
 */
/** Registered per-run so the composed chain terminates in an observable probe. */
const PROBE_BACKEND = 'store-chain-participation-probe';

const BLOB_OPTIONS = {
  blobDir: join(process.cwd(), 'test', '.tmp-unused'),
  thresholdBytes: 1_000_000,
};

/** Carries the cached-read gate, so traversal through a wrapper is observable. */
const probeStore = () => {
  const store = {
    [CACHED_READ_GATE_V1]: vi.fn(),
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
    flush: async () => undefined,
    close: async () => undefined,
  };
  return store as unknown as TripleStore;
};

/** Every first-party decorator, with the arguments needed to construct one. */
const DECORATORS: ReadonlyArray<{
  readonly name: string;
  readonly wrap: (inner: TripleStore) => TripleStore;
}> = [
  { name: 'ChangelogStore', wrap: (inner) => new ChangelogStore(inner, { enabled: true }) },
  { name: 'GraphSetIndexStore', wrap: (inner) => new GraphSetIndexStore(inner) },
  {
    name: 'SharedMemoryLiteralBlobStore',
    wrap: (inner) => new SharedMemoryLiteralBlobStore(inner, BLOB_OPTIONS),
  },
];

describe('first-party decorators pass capability discovery through', () => {
  for (const { name, wrap } of DECORATORS) {
    it(`${name} is traversable`, () => {
      const probe = probeStore();
      expect(asCachedReadGateV1(wrap(probe))).toBe(probe);
    });
  }

  it('a decorator that does not participate resolves to null', () => {
    // The negative control. Without it, the assertions above could pass because
    // resolution reaches the probe some other way rather than through the
    // decorator's registration.
    const probe = probeStore();
    const unregistered = {
      privateInnerNotExposed: probe,
      listGraphs: async () => [],
      query: async () => ({ type: 'boolean' as const, value: true }),
      insert: async () => undefined,
      delete: async () => undefined,
      close: async () => undefined,
    } as unknown as TripleStore;

    expect(asCachedReadGateV1(unregistered)).toBeNull();
  });

  it('the PRODUCTION resolver reaches the backend through the whole factory chain', async () => {
    // End-to-end, and deliberately NOT a reimplementation of traversal.
    //
    // An earlier version walked `.innerStore ?? .inner` itself to enumerate the
    // chain — reaching through private field names, in a suite whose subject is
    // the abstraction that exists so nobody has to do that. It also only worked
    // because today's decorators happen to keep a runtime-visible `inner`.
    //
    // This instead registers a backend that IS the probe, builds the real
    // composition with every decorator enabled, and asks the production
    // resolver. Any wrapper anywhere in that chain that fails to participate
    // breaks resolution, whatever it names its fields.
    const probe = probeStore();
    registerTripleStoreAdapter(PROBE_BACKEND, async () => probe);

    const store = await createTripleStore({
      backend: PROBE_BACKEND,
      changelog: { enabled: true },
      graphSetIndex: true,
      largeLiteralStorage: { enabled: true, directory: BLOB_OPTIONS.blobDir },
    });

    expect(asCachedReadGateV1(store)).toBe(probe);

    await store.close().catch(() => undefined);
  });
});
