import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint } from '../src/blazegraph-namespace-manager.js';
import { KILL_POINTS, expectKillOutcome, expectSomeWriteInterrupted, killWriterAt, type KillOutcome } from '../test/helpers/read-graph-kill-at-commit.js';

describe('a writer killed while a maintained write commits (blazegraph)', () => {
  let manager: BlazegraphNamespaceManager;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> = [];
  let adapter: BlazegraphStore;
  let url: string;
  const run = randomUUID().slice(0, 8);
  const outcomes: KillOutcome[] = [];

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

  it.each(KILL_POINTS)('leaves the store just before or just after write $write, killed $delayMs ms after its $after', async (point) => {
    const contextGraphId = `kill-${run}-${point.write}-${point.after}`;
    const killed = await killWriterAt({ DKG_KILL_BACKEND: 'blazegraph', DKG_KILL_URL: url, DKG_KILL_CG: contextGraphId }, point);
    // The store applies or drops the interrupted request as a whole.
    outcomes.push(await expectKillOutcome(adapter, contextGraphId, killed, 2_000));
  }, 180_000);

  it('kills at least one write before the writer sees it return', ({ skip }) => expectSomeWriteInterrupted(outcomes, skip));
});
