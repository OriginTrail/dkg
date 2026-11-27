import { describe, expect, it, vi } from 'vitest';
import {
  OxigraphStore,
  UnsupportedTripleStoreCapabilityError,
  type QueryOptions,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { createProjectionMutationObserver } from '../src/internal/projection-mutation-observer.js';
import { commitInput as input } from './_helpers/rfc64-commit-input.js';
import { recordingObserver } from './_helpers/store-mutation-recorder.js';

function overrideStore(base: TripleStore, overrides: Partial<TripleStore>): TripleStore {
  return new Proxy(base, {
    get(target, prop) {
      if (prop in overrides) return (overrides as Record<string | symbol, unknown>)[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TripleStore;
}

describe('RFC-64 CAS through the agent cache wrapper', () => {
  it('forwards the capability and applies outcome-aware cache invalidation', async () => {
    const options: QueryOptions = { source: 'agent-wrapper-test' };
    const cas = vi.fn()
      .mockResolvedValueOnce('committed')
      .mockResolvedValueOnce('conflict')
      .mockRejectedValueOnce(new Error('response lost after commit'))
      .mockRejectedValueOnce(new UnsupportedTripleStoreCapabilityError(
        'rfc64AuthorCommitCasV1',
        'fake-inner',
      ));
    const inner = overrideStore(new OxigraphStore(), { rfc64AuthorCommitCasV1: cas });
    const invalidate = vi.fn();
    const { observer, began, committed, unchanged } = recordingObserver();
    const store = createListContextGraphsCacheInvalidatingStore(
      inner,
      invalidate,
      observer,
    );
    const manifest = input();

    await expect(store.rfc64AuthorCommitCasV1!(manifest, options)).resolves.toBe('committed');
    expect(cas).toHaveBeenLastCalledWith(manifest, options);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(committed).toHaveLength(1);
    // The commit names every graph and subject it replaces and every quad it
    // inserts, from the canonical plan.
    expect(committed[0].removals).toHaveLength(6);
    expect(committed[0].removals![0]).toEqual({ graph: manifest.sharedProjectionGraph });
    expect(committed[0].removals!.every((removal) => removal.graph !== undefined)).toBe(true);
    expect(committed[0].quads).toEqual(expect.arrayContaining(manifest.sharedProjectionQuads as never[]));
    expect(committed[0].quads).toHaveLength(6);

    await expect(store.rfc64AuthorCommitCasV1!(manifest, options)).resolves.toBe('conflict');
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(committed).toHaveLength(1);
    expect(unchanged).toHaveLength(1);

    await expect(store.rfc64AuthorCommitCasV1!(manifest, options))
      .rejects.toThrow('response lost after commit');
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(committed).toHaveLength(2);

    await expect(store.rfc64AuthorCommitCasV1!(manifest, options))
      .rejects.toBeInstanceOf(UnsupportedTripleStoreCapabilityError);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(committed).toHaveLength(2);
    expect(unchanged).toHaveLength(2);
    expect(began).toHaveLength(4);
  });

  it('keeps an unrelated private proof current after an exact author commit', async () => {
    const inner = overrideStore(new OxigraphStore(), {
      rfc64AuthorCommitCasV1: async () => 'committed',
    });
    const projection = new ContextGraphMetaProjection(inner);
    const store = createListContextGraphsCacheInvalidatingStore(
      inner,
      vi.fn(),
      createProjectionMutationObserver(() => projection),
    );
    const before = projection.readContextGraphAuthorityFactsRevision('unrelated-private-cg');

    await expect(store.rfc64AuthorCommitCasV1!(input())).resolves.toBe('committed');

    expect(projection.readContextGraphAuthorityFactsRevision('unrelated-private-cg'))
      .toBe(before);
  });

  it('does not advertise a capability absent from the inner store', () => {
    const inner = overrideStore(new OxigraphStore(), { rfc64AuthorCommitCasV1: undefined });
    const store = createListContextGraphsCacheInvalidatingStore(inner, vi.fn(), recordingObserver().observer);
    expect(store.rfc64AuthorCommitCasV1).toBeUndefined();
  });
});
