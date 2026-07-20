import { afterEach, describe, expect, it } from 'vitest';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
} from '@origintrail-official/dkg-core';
import {
  BlazegraphStore,
  SparqlHttpStore,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  startOxigraphSparqlEndpoint,
  type OxigraphSparqlEndpoint,
} from '../../storage/test/helpers/oxigraph-sparql-endpoint.js';
import {
  buildAuthoritativePublicMetaAskQuery,
  buildAuthoritativePublicMetaQuads,
} from '../src/context-graph-public-meta-proof.js';
import { repairLocallyCreatedPublicMetaProjections } from '../src/context-graph-public-meta-repair.js';

const BACKENDS = [
  ['SPARQL HTTP / oxigraph-server', (target: OxigraphSparqlEndpoint) => new SparqlHttpStore({
    queryEndpoint: target.queryEndpoint,
    updateEndpoint: target.updateEndpoint,
  })],
  ['Blazegraph', (target: OxigraphSparqlEndpoint) => new BlazegraphStore(target.queryEndpoint)],
] satisfies Array<[string, (target: OxigraphSparqlEndpoint) => TripleStore]>;

describe('authoritative public metadata proof over SPARQL HTTP', () => {
  let endpoint: OxigraphSparqlEndpoint | undefined;

  afterEach(async () => {
    await endpoint?.close();
    endpoint = undefined;
  });

  it.each(BACKENDS)('%s uses the portable TripleStore query/insert contract', async (_name, createStore) => {
    endpoint = await startOxigraphSparqlEndpoint();
    const store = createStore(endpoint);
    const contextGraphId = 'public-meta-proof-sparql-http';
    try {
      await store.insert(buildAuthoritativePublicMetaQuads(contextGraphId));
      const proof = await store.query(buildAuthoritativePublicMetaAskQuery(contextGraphId));

      expect(proof).toEqual({ type: 'boolean', value: true });
    } finally {
      await store.close();
    }
  });

  it.each(BACKENDS)('%s performs trusted legacy repair with a batched portable query', async (_name, createStore) => {
    endpoint = await startOxigraphSparqlEndpoint();
    const store = createStore(endpoint);
    const contextGraphId = 'trusted-public-meta-repair-sparql-http';
    const subject = contextGraphDataGraphUri(contextGraphId);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    try {
      await store.insert([
        {
          subject,
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
          graph: ontologyGraph,
        },
        {
          subject,
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"public"',
          graph: ontologyGraph,
        },
      ]);

      const repaired = await repairLocallyCreatedPublicMetaProjections(store, [contextGraphId]);
      const proof = await store.query(buildAuthoritativePublicMetaAskQuery(contextGraphId));

      expect(repaired).toMatchObject({ repairedGraphs: 1, insertedTriples: 2 });
      expect(proof).toEqual({ type: 'boolean', value: true });
    } finally {
      await store.close();
    }
  });
});
