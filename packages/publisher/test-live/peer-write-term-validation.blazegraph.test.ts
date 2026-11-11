/**
 * The peer write term scenarios of `test/peer-write-term-validation.test.ts`
 * on a real Blazegraph: a term the RDF grammar does not allow is refused
 * before it reaches the store, and nothing is written. Each run uses its own
 * namespace, so the whole-store counts are this suite's alone. It needs a
 * live endpoint and fails loudly without one:
 *   BLAZEGRAPH_TEST_URL=http://127.0.0.1:<port>/bigdata/namespace/kb/sparql \
 *     pnpm --filter @origintrail-official/dkg-publisher exec vitest run \
 *     --config vitest.blazegraph.config.ts test-live/peer-write-term-validation.blazegraph.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import {
  BlazegraphNamespaceManager,
  BlazegraphStore,
  blazegraphNamespaceApiUrlFromSparqlEndpoint,
} from '@origintrail-official/dkg-storage';
import * as publisher from '../src/index.js';
import { describePeerWriteTermValidation } from '../test/_helpers/peer-write-terms.js';

let manager: BlazegraphNamespaceManager;
let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> = [];

beforeAll(async () => {
  const endpoint = process.env.BLAZEGRAPH_TEST_URL;
  if (!endpoint) throw new Error('BLAZEGRAPH_TEST_URL is required for the live Blazegraph suite');
  manager = new BlazegraphNamespaceManager({
    namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint),
    requestTimeoutMs: 30_000,
  });
  handles = await manager.acquireMany([`peer-write-terms-${randomUUID()}`]);
}, 60_000);

afterAll(async () => {
  if (handles.length > 0) await manager.disposeAll(handles);
}, 60_000);

describePeerWriteTermValidation({
  name: 'a live Blazegraph',
  async open() {
    const store = new BlazegraphStore(handles[0]!.sparqlUrl, { timeout: 30_000 });
    return { store, dispose: () => store.close() };
  },
}, publisher);
