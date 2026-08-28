import { afterEach, describe, expect, it } from 'vitest';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
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
import { buildAuthoritativePublicMetaAskQuery } from '../src/context-graph-public-meta-proof.js';
import {
  repairChainAttestedPublicMetaProjection,
  repairCreatorPublicMetaProjections,
} from '../src/context-graph-public-meta-repair.js';

describe('creator-owned public metadata repair over SPARQL HTTP', () => {
  let endpoint: OxigraphSparqlEndpoint | undefined;

  afterEach(async () => {
    await endpoint?.close();
    endpoint = undefined;
  });

  it.each([
    ['SPARQL HTTP / oxigraph-server', (target: OxigraphSparqlEndpoint) => new SparqlHttpStore({
      queryEndpoint: target.queryEndpoint,
      updateEndpoint: target.updateEndpoint,
    })],
    ['Blazegraph', (target: OxigraphSparqlEndpoint) => new BlazegraphStore(target.queryEndpoint)],
  ] satisfies Array<[string, (target: OxigraphSparqlEndpoint) => TripleStore]>)('%s uses only the portable TripleStore query/insert contract', async (_name, createStore) => {
    endpoint = await startOxigraphSparqlEndpoint();
    const store = createStore(endpoint);
    const contextGraphId = 'legacy-public-sparql-http';
    const peerId = '12D3KooWSparqlHttpPublicMetaRepair111111111111111111111';
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
          predicate: DKG_ONTOLOGY.DKG_CREATOR,
          object: `did:dkg:agent:${peerId}`,
          graph: ontologyGraph,
        },
        {
          subject,
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"public"',
          graph: ontologyGraph,
        },
      ]);

      const repaired = await repairCreatorPublicMetaProjections(store, peerId);
      const proof = await store.query(buildAuthoritativePublicMetaAskQuery(contextGraphId));

      expect(repaired.repairedGraphs).toBe(1);
      expect(repaired.insertedTriples).toBe(2);
      expect(proof).toEqual({ type: 'boolean', value: true });
    } finally {
      await store.close();
    }
  });

  it('SPARQL HTTP / oxigraph-server applies the chain-attested repair as a conditional update', async () => {
    endpoint = await startOxigraphSparqlEndpoint();
    const store = new SparqlHttpStore({
      queryEndpoint: endpoint.queryEndpoint,
      updateEndpoint: endpoint.updateEndpoint,
    });
    const contextGraphId = 'legacy-chain-attested-sparql-http';
    try {
      const repaired = await repairChainAttestedPublicMetaProjection(
        store,
        contextGraphId,
        async () => ({ state: 'public' }),
      );
      const proof = await store.query(buildAuthoritativePublicMetaAskQuery(contextGraphId));

      expect(repaired).toEqual({
        outcome: 'projection-complete',
      });
      expect(proof).toEqual({ type: 'boolean', value: true });
    } finally {
      await store.close();
    }
  });

  it('SPARQL HTTP / oxigraph-server leaves a conflicting private policy untouched', async () => {
    endpoint = await startOxigraphSparqlEndpoint();
    const store = new SparqlHttpStore({
      queryEndpoint: endpoint.queryEndpoint,
      updateEndpoint: endpoint.updateEndpoint,
    });
    const contextGraphId = 'chain-attested-http-private-conflict';
    const subject = contextGraphDataGraphUri(contextGraphId);
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    try {
      await store.insert([{
        subject,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"private"',
        graph: metaGraph,
      }]);

      const repaired = await repairChainAttestedPublicMetaProjection(
        store,
        contextGraphId,
        async () => ({ state: 'public' }),
      );
      const facts = await store.query(`
        SELECT ?predicate ?object WHERE {
          GRAPH <${metaGraph}> {
            <${subject}> ?predicate ?object .
          }
        }
      `);

      expect(repaired).toEqual({
        outcome: 'conflicting-policy',
      });
      expect(facts).toEqual({
        type: 'bindings',
        bindings: [{
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"private"',
        }],
      });
    } finally {
      await store.close();
    }
  });
});
