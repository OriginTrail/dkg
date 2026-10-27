import { afterEach, expect, it, vi } from 'vitest';
import { classifyDurableProgress } from '../src/sync/durable-progress.js';
import { getSyncCheckpointKey } from '../src/sync/checkpoint/state.js';
import { continueContextGraphSubscriptionLine } from '../src/context-graph-subscription-policy.js';
import { CG, PEER, createHeldProductionHarness, stopHeldProductionAgents } from './_helpers/durable-held-production.js';

afterEach(async () => { await stopHeldProductionAgents(); vi.restoreAllMocks(); });

it.each([false, true])('persists the discovered binding before held readiness (save fails: %s)', async failBindingSave => {
  const h = await createHeldProductionHarness({ unbound: true, failBindingSave });
  h.fetchMissingData();
  const recovered = await h.run();
  expect(h.dataRequests()).toBeGreaterThan(0);
  expect(recovered.result.verifiedHeldAssets ?? 0).toBe(0);
  expect(h.persist).toHaveBeenCalledWith(CG, expect.objectContaining({ onChainId: CG }), 'on-chain id binding', expect.any(Function));
  expect(recovered.outcome === 'terminal').toBe(!failBindingSave);
  expect(h.savedBindings).toEqual(failBindingSave ? [] : [CG]);
  expect(h.internal.subscribedContextGraphs.get(CG).onChainId).toBe(failBindingSave ? undefined : CG);
  expect(h.internal.syncCheckpoints.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.terminal === true).toBe(!failBindingSave);
}, 15_000);

it('fetches and repairs corrupt preexisting content before readiness', async () => {
  const h = await createHeldProductionHarness();
  await h.internal.store.delete(h.data);
  await h.internal.store.insert([{ ...h.data[0]!, object: '"tampered"' }]);
  h.fetchMissingData();
  const recovered = await h.run();
  expect(h.dataRequests()).toBeGreaterThan(0);
  expect(recovered.result.verifiedHeldAssets ?? 0).toBe(0);
  expect(recovered.outcome).toBe('terminal');
  const rows = await h.internal.store.query(`SELECT ?object WHERE { GRAPH <${h.graph}> { ?subject ?predicate ?object } }`);
  expect(rows.bindings).toEqual([{ object: '"held"' }]);
}, 15_000);

it('retries failed SWM twin cleanup on the next held recovery', async () => {
  const h = await createHeldProductionHarness();
  await h.seedSwmTwin('1');
  h.retire.mockRejectedValueOnce(new Error('temporary cleanup failure'));
  const recovered = await h.run();
  expect(recovered.outcome).toBe('terminal');
  expect(recovered.result.verifiedHeldAssets).toBe(1);
  expect(h.retire).toHaveBeenCalledTimes(1);
  expect(await h.internal.store.countQuads(h.swmGraph)).toBe(1);
  const replay = await h.run();
  expect(replay.outcome).toBe('terminal');
  expect(replay.result.verifiedHeldAssets).toBe(1);
  expect(h.retire).toHaveBeenCalledTimes(2);
  expect(await h.internal.store.countQuads(h.swmGraph)).toBe(0);
  expect(h.dataRequests()).toBe(0);
}, 15_000);

it('retains newer SWM content during held recovery', async () => {
  const h = await createHeldProductionHarness();
  await h.seedSwmTwin('2');
  const recovered = await h.run();
  expect(recovered.outcome).toBe('terminal');
  expect(recovered.result.verifiedHeldAssets).toBe(1);
  expect(await h.internal.store.countQuads(h.swmGraph)).toBe(1);
  expect(h.retire).not.toHaveBeenCalled();
  const rows = await h.internal.store.query(`SELECT ?object WHERE { GRAPH <${h.swmGraph}> { ?subject ?predicate ?object } }`);
  expect(rows.bindings).toEqual([{ object: '"newer"' }]);
  expect(h.dataRequests()).toBe(0);
}, 15_000);

it.each(['chain', 'worker', 'reconcile'].flatMap(phase =>
  ['clean', 'deactivate', 'recreate', 'equivalent', 'drop-graph', 'remove-subgraph'].map(change => [phase, change] as const)))(
  'fences held readiness through paused %s verification: %s', async (phase, change) => {
    const h = await createHeldProductionHarness();
    const { internal, subscription, entered, release, graph, agent } = h;
    if (phase === 'reconcile') await h.seedSwmTwin('1');
    h.pause(phase as 'chain' | 'worker' | 'reconcile');
    const run = h.run();
    try {
      await Promise.race([entered.promise, run.then(result => { throw new Error('Recovery ended before the paused verification: ' + JSON.stringify(result)); })]);
      if (change === 'deactivate') {
        const next = { ...subscription, subscribed: false }; continueContextGraphSubscriptionLine(subscription, next);
        internal.subscribedContextGraphs.set(CG, next);
      } else if (change === 'recreate') {
        internal.subscribedContextGraphs.delete(CG); internal.subscribedContextGraphs.set(CG, { ...subscription });
      } else if (change === 'equivalent') {
        const next = { ...subscription, name: 'renamed' }; continueContextGraphSubscriptionLine(subscription, next);
        internal.subscribedContextGraphs.set(CG, next);
      } else if (change === 'drop-graph') await internal.store.dropGraph(graph);
      else if (change === 'remove-subgraph') await agent.removeSubGraph(CG, 'reports');
    } finally { release.resolve(); }
    const recovered = await run;
    const valid = change === 'clean' || change === 'equivalent';
    expect(recovered.outcome === 'terminal').toBe(valid);
    expect(recovered.result.verifiedHeldAssets ?? 0).toBe(valid ? 1 : 0);
    expect(classifyDurableProgress(recovered.result, { complete: recovered.result.complete }).completedReadinessCleanly).toBe(valid);
    expect(internal.syncCheckpoints.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.terminal === true).toBe(valid);
    expect(h.dataRequests()).toBe(0);
    if (change === 'drop-graph' || change === 'remove-subgraph') expect(await internal.store.countQuads(graph)).toBe(0);
  }, 15_000,
);

it('settles held VM recovery on the first run with finalized snapshot cleanup enabled', async () => {
  const h = await createHeldProductionHarness({ finalizedCleanup: true });
  await h.seedSwmTwin('1');
  const recovered = await h.run();
  expect(recovered.outcome).toBe('terminal');
  expect(recovered.result.verifiedHeldAssets).toBe(1);
  expect(h.dataRequests()).toBe(0);
  expect(h.retire).toHaveBeenCalledOnce();
  expect(await h.internal.store.countQuads(h.swmGraph)).toBe(0);
  expect(h.markPublished).toHaveBeenCalled();
  expect(h.internal.syncCheckpoints.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.terminal).toBe(true);
}, 15_000);
