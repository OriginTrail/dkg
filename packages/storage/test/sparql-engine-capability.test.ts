import { describe, expect, it } from 'vitest';
import {
  BlazegraphStore,
  ChangelogStore,
  GraphSetIndexStore,
  OxigraphStore,
  OxigraphWorkerStore,
  SparqlHttpStore,
  sparqlEngineOf,
} from '../src/index.js';
import { createManagedOxigraphSparqlStoreV1 } from '../src/adapters/sparql-http.js';

const endpoint = 'http://127.0.0.1:1/sparql';

describe('sparqlEngineOf', () => {
  it('names Oxigraph for the embedded and worker stores', async () => {
    const embedded = new OxigraphStore();
    const worker = new OxigraphWorkerStore();
    try {
      expect(sparqlEngineOf(embedded)).toBe('oxigraph');
      expect(sparqlEngineOf(worker)).toBe('oxigraph');
    } finally {
      await embedded.close();
      await worker.close();
    }
  });

  it('names Oxigraph for the managed runtime', () => {
    expect(sparqlEngineOf(createManagedOxigraphSparqlStoreV1({ queryEndpoint: endpoint }))).toBe('oxigraph');
  });

  it('finds the engine through decorators', async () => {
    const inner = new OxigraphStore();
    try {
      expect(sparqlEngineOf(new ChangelogStore(new GraphSetIndexStore(inner)))).toBe('oxigraph');
    } finally {
      await inner.close();
    }
  });

  it('names no engine for Blazegraph or an arbitrary SPARQL URL', () => {
    expect(sparqlEngineOf(new BlazegraphStore(endpoint))).toBeNull();
    expect(sparqlEngineOf(new SparqlHttpStore({ queryEndpoint: endpoint }))).toBeNull();
    expect(sparqlEngineOf(new ChangelogStore(new SparqlHttpStore({ queryEndpoint: endpoint })))).toBeNull();
  });

  it('names no engine for a store that does not say, or for a value that is not a store', () => {
    expect(sparqlEngineOf({ query: async () => ({ type: 'bindings', bindings: [] }) })).toBeNull();
    expect(sparqlEngineOf(null)).toBeNull();
    expect(sparqlEngineOf(undefined)).toBeNull();
  });
});
