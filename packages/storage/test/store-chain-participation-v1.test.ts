import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import * as storage from '../src/index.js';
import { ChangelogStore } from '../src/changelog-store.js';
import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { SharedMemoryLiteralBlobStore } from '../src/shared-memory-literal-blob-store.js';
import { CACHED_READ_GATE_V1, asCachedReadGateV1 } from '../src/cached-read-gate-v1.js';
import type { TripleStore } from '../src/triple-store.js';

/**
 * Every exported store-shaped class is accounted for, and every DECORATOR is
 * proven to pass capability discovery through.
 *
 * The failure this exists to catch, in the reviewer's words: a new decorator
 * can hold `private readonly inner`, satisfy `TripleStore`, compile, and never
 * call `linkStoreChainV1`. Discovery through it then resolves to `null`, which
 * callers read as "no constraint" — fail-open, silently.
 *
 * The enforcement is the CLASSIFICATION table below. It is not a list this
 * suite consults politely: an exported store-shaped class that is absent from
 * it fails the first test. Adding a decorator therefore cannot be completed
 * without deciding, in this file, whether it participates in discovery — and if
 * it does, the second test proves it actually does rather than taking the
 * classification's word for it.
 *
 * ## What this does NOT cover, stated plainly
 *
 * - Decorators that are not exported from the package barrel.
 * - Wrappers that are object literals rather than classes — the agent's
 *   `createListContextGraphsCacheInvalidatingStore` is one, and it is covered
 *   by its own suite in packages/agent.
 *
 * Both are real gaps. This closes the case the review named — a new first-party
 * decorator class — and does not claim more than that.
 */

/** A store that owns a backend rather than wrapping one: nothing to traverse. */
const BACKEND = Symbol('backend');

type Classification =
  | typeof BACKEND
  | { readonly decorator: (inner: TripleStore) => TripleStore };

const CLASSIFICATION: Readonly<Record<string, Classification>> = {
  BlazegraphStore: BACKEND,
  OxigraphStore: BACKEND,
  OxigraphWorkerStore: BACKEND,
  SparqlHttpStore: BACKEND,

  ChangelogStore: { decorator: (inner) => new ChangelogStore(inner, { enabled: true }) },
  GraphSetIndexStore: { decorator: (inner) => new GraphSetIndexStore(inner) },
  SharedMemoryLiteralBlobStore: {
    decorator: (inner) =>
      new SharedMemoryLiteralBlobStore(inner, {
        blobDir: join(process.cwd(), 'test', '.tmp-unused'),
        thresholdBytes: 1_000_000,
      }),
  },
};

/** Discovered at runtime, so a new export cannot slip past by not being listed. */
const exportedStoreShapedClasses = (): string[] =>
  Object.entries(storage as Record<string, unknown>)
    .filter(([name, value]) => {
      if (typeof value !== 'function' || !/^[A-Z]/.test(name)) return false;
      const proto = (value as { prototype?: Record<string, unknown> }).prototype;
      if (!proto) return false;
      return ['insert', 'delete', 'query', 'listGraphs'].every(
        (method) => typeof proto[method] === 'function',
      );
    })
    .map(([name]) => name);

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

describe('decorator-chain participation is accounted for, not assumed', () => {
  it('every exported store-shaped class is classified', () => {
    // The enforcement point. A new decorator cannot be added without this
    // failing first, which is what turns participation from a convention
    // someone must remember into a step they cannot skip silently.
    const unclassified = exportedStoreShapedClasses().filter(
      (name) => !(name in CLASSIFICATION),
    );

    expect(unclassified).toEqual([]);
  });

  it('the discovery finds the classes (it is not vacuously empty)', () => {
    // A selector that silently matched nothing would make the test above pass
    // forever, which is the purest form of a check that cannot fail.
    expect(exportedStoreShapedClasses()).toEqual(
      expect.arrayContaining(['ChangelogStore', 'GraphSetIndexStore', 'SparqlHttpStore']),
    );
  });

  it('every classified DECORATOR passes capability discovery through', () => {
    // Classification is a claim; this is the proof. A decorator listed as
    // participating but not calling linkStoreChainV1 fails here.
    const probe = probeStore();
    const failures: string[] = [];

    for (const [name, classification] of Object.entries(CLASSIFICATION)) {
      if (classification === BACKEND) continue;
      const wrapped = classification.decorator(probe);
      if (asCachedReadGateV1(wrapped) !== probe) failures.push(name);
    }

    expect(failures).toEqual([]);
  });

  it('a decorator that does not participate is REJECTED by the check above', () => {
    // Proves the previous test can fail. Without this, "no failures" might mean
    // the loop never resolved anything in the first place.
    const probe = probeStore();
    const unregistered = {
      innerStoreButPrivate: probe,
      listGraphs: async () => [],
      query: async () => ({ type: 'boolean' as const, value: true }),
      insert: async () => undefined,
      delete: async () => undefined,
      close: async () => undefined,
    } as unknown as TripleStore;

    expect(asCachedReadGateV1(unregistered)).toBeNull();
  });
});
