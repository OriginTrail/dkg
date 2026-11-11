import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint } from '../src/blazegraph-namespace-manager.js';
import { KILL_POINTS, expectReadGraphEqualsMembers, killWriterAt, type KilledWrite } from '../test/helpers/read-graph-kill-at-commit.js';

describe('a writer killed while a maintained write commits (blazegraph)', () => {
  let manager: BlazegraphNamespaceManager;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> = [];
  let adapter: BlazegraphStore;
  let url: string;
  const run = randomUUID().slice(0, 8);
  const outcomes: Array<KilledWrite & { readonly triples: number }> = [];

  beforeAll(async () => {
    if (!process.env.BLAZEGRAPH_TEST_URL) throw new Error('The live Blazegraph lane requires BLAZEGRAPH_TEST_URL');
    manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(process.env.BLAZEGRAPH_TEST_URL) });
    handles = await manager.acquireMany([`read-graph-kill-${randomUUID()}`]);
    url = handles[0]!.sparqlUrl;
    adapter = new BlazegraphStore(url, { timeout: 120_000 });
  }, 60_000);
  afterAll(async () => {
    console.log(`kill-at-commit outcomes (blazegraph): ${JSON.stringify(outcomes)}`);
    await adapter?.close();
    if (handles.length) await manager.disposeAll(handles);
  }, 60_000);

  it.each(KILL_POINTS)('leaves the read graph equal to its members after a kill at write $write, $delayMs ms in', async ({ write, delayMs }) => {
    const contextGraphId = `kill-${run}-${write}`;
    const killed = await killWriterAt({ DKG_KILL_BACKEND: 'blazegraph', DKG_KILL_URL: url, DKG_KILL_CG: contextGraphId }, write, delayMs);
    // The store finishes or drops the interrupted request as a whole: no read graph is left between.
    const triples = await expectReadGraphEqualsMembers(adapter, contextGraphId, `a kill at write ${write}`);
    outcomes.push({ ...killed, triples });
  }, 180_000);
});
