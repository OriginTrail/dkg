import { describe, expect, it, vi } from 'vitest';
import {
  OxigraphStore,
  UnsupportedTripleStoreCapabilityError,
  type QueryOptions,
  type Rfc64AuthorCommitCasInputV1,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';

function input(): Rfc64AuthorCommitCasInputV1 {
  const graph = 'did:dkg:context-graph:rfc64/_shared_memory';
  const stateGraph = 'urn:test:rfc64:state';
  const transition = (subject: string, predicate: string, oldValue: string, nextValue: string) => ({
    graphUri: stateGraph,
    subject,
    predicate,
    expectedObject: oldValue,
    expectedQuads: [{ subject, predicate, object: oldValue, graph: stateGraph }],
    quads: [{ subject, predicate, object: nextValue, graph: stateGraph }],
  });
  return {
    sharedProjectionGraph: graph,
    sharedProjectionQuads: [{ subject: 'urn:ka', predicate: 'urn:p', object: '"v"', graph }],
    authorSealGraph: 'urn:seals',
    authorSealSubject: 'urn:seal',
    authorSealQuads: [{ subject: 'urn:seal', predicate: 'urn:p', object: '"seal"', graph: 'urn:seals' }],
    currentHead: {
      graphUri: 'urn:heads',
      subject: 'urn:author',
      predicate: 'urn:head',
      expectedObject: 'urn:old',
      expectedQuads: [{ subject: 'urn:author', predicate: 'urn:head', object: 'urn:old', graph: 'urn:heads' }],
      quads: [{ subject: 'urn:author', predicate: 'urn:head', object: 'urn:new', graph: 'urn:heads' }],
    },
    subgraphMutationGeneration: transition('urn:subgraph-mutation', 'urn:generation', '"1"', '"2"'),
    contextGraphMutationGeneration: transition('urn:cg-mutation', 'urn:generation', '"10"', '"11"'),
    appliedSet: transition('urn:applied-set', 'urn:root', 'urn:old-root', 'urn:new-root'),
  };
}

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
    const markProjectionDirty = vi.fn();
    const store = createListContextGraphsCacheInvalidatingStore(
      inner,
      invalidate,
      markProjectionDirty,
    );
    const manifest = input();

    await expect(store.rfc64AuthorCommitCasV1!(manifest, options)).resolves.toBe('committed');
    expect(cas).toHaveBeenLastCalledWith(manifest, options);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(markProjectionDirty).toHaveBeenCalledTimes(1);

    await expect(store.rfc64AuthorCommitCasV1!(manifest, options)).resolves.toBe('conflict');
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(markProjectionDirty).toHaveBeenCalledTimes(1);

    await expect(store.rfc64AuthorCommitCasV1!(manifest, options))
      .rejects.toThrow('response lost after commit');
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(markProjectionDirty).toHaveBeenCalledTimes(2);

    await expect(store.rfc64AuthorCommitCasV1!(manifest, options))
      .rejects.toBeInstanceOf(UnsupportedTripleStoreCapabilityError);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(markProjectionDirty).toHaveBeenCalledTimes(2);
  });

  it('does not advertise a capability absent from the inner store', () => {
    const inner = overrideStore(new OxigraphStore(), { rfc64AuthorCommitCasV1: undefined });
    const store = createListContextGraphsCacheInvalidatingStore(inner, vi.fn(), vi.fn());
    expect(store.rfc64AuthorCommitCasV1).toBeUndefined();
  });
});
