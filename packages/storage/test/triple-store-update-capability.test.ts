import { describe, expect, it } from 'vitest';
import {
  UnsupportedTripleStoreCapabilityError,
  tryUpdateWithTouchedGraphs,
  type TripleStore,
} from '../src/index.js';

describe('tryUpdateWithTouchedGraphs', () => {
  it('returns false for a typed unsupported-update signal from a decorator', async () => {
    const store = {
      update: async () => {
        throw new UnsupportedTripleStoreCapabilityError('update', 'TestDecorator');
      },
    } as unknown as TripleStore;

    await expect(
      tryUpdateWithTouchedGraphs(store, 'DELETE WHERE { ?s ?p ?o }', ['urn:test:graph']),
    ).resolves.toBe(false);
  });

  it('does not mask a genuine update execution failure', async () => {
    const failure = new Error('store is closed');
    const store = {
      update: async () => {
        throw failure;
      },
    } as unknown as TripleStore;

    await expect(
      tryUpdateWithTouchedGraphs(store, 'DELETE WHERE { ?s ?p ?o }', ['urn:test:graph']),
    ).rejects.toBe(failure);
  });
});
