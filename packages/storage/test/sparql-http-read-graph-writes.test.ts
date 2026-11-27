import { SparqlHttpStore } from '../src/adapters/sparql-http.js';
import { readGraphWriteSuite, sentOverFetch } from './_helpers/read-graph-write-suite.js';
import { startOxigraphSparqlEndpoint, type OxigraphSparqlEndpoint } from './helpers/oxigraph-sparql-endpoint.js';

/**
 * SparqlHttpStore sends a write's read-graph operations in the same request as
 * its data change. Runs on every CI run against the in-process endpoint over
 * embedded Oxigraph (the engine oxigraph-server runs), and against a real
 * oxigraph-server when OXIGRAPH_SERVER_URL points at an empty one.
 */
let endpoint: OxigraphSparqlEndpoint | undefined;
readGraphWriteSuite({
  name: 'SparqlHttpStore over embedded Oxigraph',
  adapter: 'sparql-http',
  open: async () => {
    endpoint = await startOxigraphSparqlEndpoint();
    return new SparqlHttpStore({
      queryEndpoint: endpoint.queryEndpoint,
      updateEndpoint: endpoint.updateEndpoint,
      consistencyProfile: 'atomic-readback',
    });
  },
  close: async (store) => {
    await store.close();
    await endpoint?.close();
  },
  requests: sentOverFetch(),
});

const server = process.env.OXIGRAPH_SERVER_URL;
if (server) {
  readGraphWriteSuite({
    name: 'SparqlHttpStore on oxigraph-server (live server)',
    adapter: 'sparql-http',
    open: async () => new SparqlHttpStore({
      queryEndpoint: `${server}/query`,
      updateEndpoint: `${server}/update`,
      consistencyProfile: 'atomic-readback',
      timeout: 30_000,
    }),
    requests: sentOverFetch(),
  });
}
