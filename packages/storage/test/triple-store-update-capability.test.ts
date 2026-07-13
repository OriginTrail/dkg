import { describe, expect, it } from 'vitest';
import {
  UnsupportedTripleStoreCapabilityError,
  tryConditionalReplaceSubject,
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

describe('tryConditionalReplaceSubject', () => {
  it('keeps conditional RDF replacement and verification behind one typed helper', async () => {
    let updateText = '';
    let touchedGraphs: readonly string[] | undefined;
    const store = {
      update: async (sparql: string, options?: { touchedGraphs?: readonly string[] }) => {
        updateText = sparql;
        touchedGraphs = options?.touchedGraphs;
      },
      query: async () => ({ type: 'boolean' as const, value: true }),
    } as unknown as TripleStore;

    await expect(tryConditionalReplaceSubject(store, {
      graph: 'urn:test:graph',
      subject: 'urn:test:job',
      expected: [{ predicate: 'urn:test:status', object: '"validated"' }],
      replacement: [{
        graph: 'urn:test:graph',
        subject: 'urn:test:job',
        predicate: 'urn:test:status',
        object: '"broadcast"',
      }],
      verify: { predicate: 'urn:test:status', object: '"broadcast"' },
    })).resolves.toBe('replaced');

    expect(updateText).toContain('<urn:test:status> "validated"');
    expect(updateText).toContain('<urn:test:status> "broadcast"');
    expect(touchedGraphs).toEqual(['urn:test:graph']);
  });

  it('reports unsupported stores without issuing the verification query', async () => {
    let queried = false;
    const store = {
      query: async () => {
        queried = true;
        return { type: 'boolean' as const, value: false };
      },
    } as unknown as TripleStore;

    await expect(tryConditionalReplaceSubject(store, {
      graph: 'urn:test:graph',
      subject: 'urn:test:job',
      expected: [],
      replacement: [],
      verify: { predicate: 'urn:test:status', object: '"broadcast"' },
    })).resolves.toBe('unsupported');
    expect(queried).toBe(false);
  });
});
