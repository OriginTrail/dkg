import { describe, expect, it } from 'vitest';
import {
  BlazegraphStore,
  ChangelogStore,
  GraphSetIndexStore,
  OxigraphStore,
  OxigraphWorkerStore,
  SparqlHttpStore,
  sparqlEngineOf,
  storeDefaultGraphIsGraphUnion,
  storeRestrictsQueryDataset,
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
    expect(sparqlEngineOf({ sparqlEngine: 'other-engine' })).toBeNull();
    expect(sparqlEngineOf({ sparqlEngine: '' })).toBeNull();
  });
});

describe('storeRestrictsQueryDataset', () => {
  it('is true for the embedded and worker Oxigraph stores, also through decorators', async () => {
    const embedded = new OxigraphStore();
    const worker = new OxigraphWorkerStore();
    try {
      expect(storeRestrictsQueryDataset(embedded)).toBe(true);
      expect(storeRestrictsQueryDataset(worker)).toBe(true);
      expect(storeRestrictsQueryDataset(new ChangelogStore(new GraphSetIndexStore(embedded)))).toBe(true);
    } finally {
      await embedded.close();
      await worker.close();
    }
  });

  it('is false for Blazegraph, every SPARQL HTTP store, and anything that does not say', () => {
    expect(storeRestrictsQueryDataset(new BlazegraphStore(endpoint))).toBe(false);
    expect(storeRestrictsQueryDataset(new SparqlHttpStore({ queryEndpoint: endpoint }))).toBe(false);
    expect(storeRestrictsQueryDataset(createManagedOxigraphSparqlStoreV1({ queryEndpoint: endpoint }))).toBe(false);
    expect(storeRestrictsQueryDataset(new ChangelogStore(new SparqlHttpStore({ queryEndpoint: endpoint })))).toBe(false);
    expect(storeRestrictsQueryDataset({ restrictsQueryDataset: 'yes' })).toBe(false);
    expect(storeRestrictsQueryDataset(null)).toBe(false);
  });
});

describe('storeDefaultGraphIsGraphUnion', () => {
  it('is true for Blazegraph, also through decorators', () => {
    expect(storeDefaultGraphIsGraphUnion(new BlazegraphStore(endpoint))).toBe(true);
    expect(storeDefaultGraphIsGraphUnion(new ChangelogStore(new BlazegraphStore(endpoint)))).toBe(true);
  });

  it('is false for Oxigraph, every SPARQL HTTP store, and anything that does not say', async () => {
    const embedded = new OxigraphStore();
    try {
      expect(storeDefaultGraphIsGraphUnion(embedded)).toBe(false);
    } finally {
      await embedded.close();
    }
    expect(storeDefaultGraphIsGraphUnion(new SparqlHttpStore({ queryEndpoint: endpoint }))).toBe(false);
    expect(storeDefaultGraphIsGraphUnion(createManagedOxigraphSparqlStoreV1({ queryEndpoint: endpoint }))).toBe(false);
    expect(storeDefaultGraphIsGraphUnion({ defaultGraphIsGraphUnion: 'yes' })).toBe(false);
    expect(storeDefaultGraphIsGraphUnion(null)).toBe(false);
  });
});
