/**
 * A peer's publish or KA update carrying an RDF term the grammar does not
 * allow is refused, the term never reaches the store, and nothing is written,
 * on each store adapter. The HTTP stores talk to an in-process endpoint that
 * runs the Oxigraph engine. The same scenarios run against a real Blazegraph
 * in `test-live/peer-write-term-validation.blazegraph.test.ts`, and against
 * the pinned oxigraph-server in the cli package.
 */
import { afterAll, beforeAll } from 'vitest';
import {
  BlazegraphStore,
  OxigraphStore,
  createManagedOxigraphSparqlStoreV1,
} from '@origintrail-official/dkg-storage';
import {
  startOxigraphSparqlEndpoint,
  type OxigraphSparqlEndpoint,
} from '../../storage/test/helpers/oxigraph-sparql-endpoint.js';
import * as publisher from '../src/index.js';
import { describePeerWriteTermValidation } from './_helpers/peer-write-terms.js';

let endpoint: OxigraphSparqlEndpoint;
beforeAll(async () => { endpoint = await startOxigraphSparqlEndpoint(); });
afterAll(async () => { await endpoint?.close(); });

describePeerWriteTermValidation({
  name: 'embedded Oxigraph',
  async open() {
    const store = new OxigraphStore();
    return { store, dispose: () => store.close() };
  },
}, publisher);

describePeerWriteTermValidation({
  name: 'the managed Oxigraph SPARQL HTTP adapter',
  async open() {
    const store = createManagedOxigraphSparqlStoreV1({
      queryEndpoint: endpoint.queryEndpoint,
      updateEndpoint: endpoint.updateEndpoint,
    });
    return { store, dispose: () => store.close() };
  },
}, publisher);

describePeerWriteTermValidation({
  name: 'the Blazegraph adapter',
  async open() {
    const store = new BlazegraphStore(endpoint.queryEndpoint);
    return { store, dispose: () => store.close() };
  },
}, publisher);
