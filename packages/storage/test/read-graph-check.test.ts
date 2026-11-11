import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { checkReadGraph } from '../src/read-graph/check.js';
import { ReadGraphCheckSchedule, startReadGraphChecks } from '../src/read-graph/check-schedule.js';
import type { QueryOptions, QueryResult, TripleStore } from '../src/triple-store.js';
import { captureMetrics, readGraphCheckConformance } from './helpers/read-graph-check-conformance.js';
import { layerFixture, layeredStore, q } from './helpers/read-graph-layer-conformance.js';
import { PlanningOxigraphStore } from './helpers/read-graph-planning-store.js';

readGraphCheckConformance('oxigraph');

/** An adapter that runs `before` ahead of each query whose text `matches`. */
class HookedStore extends PlanningOxigraphStore {
  hook: { matches: (sparql: string) => boolean; before: () => Promise<void> } | undefined;

  override async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    if (this.hook?.matches(sparql)) await this.hook.before();
    return super.query(sparql, options);
  }
}

let sequence = 0;
async function hooked() {
  const adapter = new HookedStore();
  const fixture = layerFixture(`check-unit-${sequence += 1}`);
  const { layer, store } = await layeredStore(adapter, { backend: 'oxigraph' }, fixture);
  return { adapter, fixture, layer, store };
}

const isSizeQuery = (sparql: string) => sparql.startsWith('SELECT (COUNT(*) AS ?n) WHERE { GRAPH <');
const isMissingProbe = (sparql: string) => sparql.startsWith('ASK {') && sparql.includes('FILTER NOT EXISTS { GRAPH <');

describe('read-graph checks under concurrent writes', () => {
  it('runs the count again when a write lands while it runs, so the write is no mismatch', async () => {
    const { adapter, fixture, store } = await hooked();
    const { wholeVm } = fixture.readGraphs;
    let writes = 0;
    adapter.hook = {
      matches: isSizeQuery,
      // A maintained write between counting the members and counting the read graph.
      before: async () => { if (writes++ === 0) await store.insert([q('urn:s:late', '"late"', fixture.graphs[1]!)]); },
    };
    expect(await checkReadGraph(store, wholeVm, 'full')).toEqual({ readGraph: wholeVm, mode: 'full', outcome: 'consistent' });
    expect(writes).toBe(2);
    await adapter.close();
  });

  it('stops as interrupted when writes keep overlapping its chunks, and marks nothing', async () => {
    const { adapter, fixture, layer, store } = await hooked();
    const { wholeVm } = fixture.readGraphs;
    adapter.hook = { matches: isMissingProbe, before: () => layer.runtime.locks.withLocks([wholeVm], async () => undefined) };
    const { value, recorded } = await captureMetrics(() => checkReadGraph(store, wholeVm, 'full', { attempts: 2 }));
    expect(value.outcome).toBe('interrupted');
    expect(layer.runtime.mirror.get(wholeVm)?.state).toBe('ready');
    expect(recorded.find((entry) => entry.metric === 'dkg.store.read_graph_checks_total')?.attributes)
      .toEqual({ mode: 'full', outcome: 'interrupted', layer: 'vm' });
    await adapter.close();
  });

  it('holds the lock of the read graph for a sampled check, so a write waits for it', async () => {
    const { adapter, fixture, store } = await hooked();
    const { wholeSwm } = fixture.readGraphs;
    let write: Promise<void> | undefined;
    let written = false;
    const seen: boolean[] = [];
    adapter.hook = {
      matches: isMissingProbe,
      before: async () => {
        seen.push(written);
        write ??= store.insert([q('urn:s:waits', '"waits"', fixture.graphs[6]!)]).then(() => { written = true; });
        // Give the write every chance to run before the next probe.
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    };
    expect((await checkReadGraph(store, wholeSwm, 'sampled')).outcome).toBe('consistent');
    // Both member graphs were probed, and the write had not landed at either probe.
    expect(seen).toEqual([false, false]);
    await write;
    expect(written).toBe(true);
    adapter.hook = undefined;
    expect((await checkReadGraph(store, wholeSwm, 'full')).outcome).toBe('consistent');
    await adapter.close();
  });

  it('skips a store without the read-graph layer and a read graph that is not ready, and counts a failed check', async () => {
    const { adapter, fixture, layer, store } = await hooked();
    const { wholeVm, codeVm } = fixture.readGraphs;
    const plain = new OxigraphStore();
    expect((await checkReadGraph(plain, wholeVm, 'full')).outcome).toBe('skipped');
    await plain.close();
    layer.runtime.mirror.set({ ...layer.runtime.mirror.get(wholeVm)!, state: 'building' });
    expect((await checkReadGraph(store, wholeVm, 'sampled')).outcome).toBe('skipped');
    adapter.hook = { matches: isMissingProbe, before: async () => { throw new Error('store went away'); } };
    const { value, recorded } = await captureMetrics(() => checkReadGraph(store, codeVm, 'full').catch((error: Error) => error));
    expect(value).toMatchObject({ message: 'store went away' });
    expect(recorded.find((entry) => entry.metric === 'dkg.store.read_graph_checks_total')?.attributes)
      .toEqual({ mode: 'full', outcome: 'error', layer: 'vm' });
    await adapter.close();
  });
});

describe('the read-graph check schedule', () => {
  it('runs a full pass on request over every ready read graph, and records read graphs by state', async () => {
    const { adapter, fixture, layer, store } = await hooked();
    layer.runtime.mirror.set({ ...layer.runtime.mirror.get(fixture.readGraphs.agentWm)!, state: 'dirty' });
    const schedule = new ReadGraphCheckSchedule(store, { sampledIntervalMs: 3_600_000, fullIntervalMs: 3_600_000 });
    const { recorded } = await captureMetrics(async () => {
      expect(schedule.requestFullCheck()).toBe(true);
      await schedule.whenIdle();
    });
    const checks = recorded.filter((entry) => entry.metric === 'dkg.store.read_graph_checks_total');
    // In code-point order: …/_~read/cg/_shared_memory, …/cg/_verifiable_memory, …/sub/code/_verifiable_memory.
    expect(checks.map((entry) => entry.attributes)).toEqual([
      { mode: 'full', outcome: 'consistent', layer: 'swm' },
      { mode: 'full', outcome: 'consistent', layer: 'vm' },
      { mode: 'full', outcome: 'consistent', layer: 'vm' },
    ]);
    const states = Object.fromEntries(recorded.filter((entry) => entry.metric === 'dkg.store.read_graphs')
      .map((entry) => [entry.attributes.state, entry.value]));
    expect(states).toEqual({ building: 0, ready: 3, dirty: 1, repairing: 0, rebuilding: 0 });
    await schedule.close();
    await adapter.close();
  });

  it('samples a few ready read graphs in turn, and goes on past a check that fails', async () => {
    const { adapter, fixture, store } = await hooked();
    const failing = fixture.readGraphs.wholeSwm;
    adapter.hook = { matches: (sparql) => isMissingProbe(sparql) && sparql.includes(failing), before: async () => { throw new Error('probe failed'); } };
    const errors: Array<string | undefined> = [];
    let schedule: ReadGraphCheckSchedule | undefined;
    const { recorded } = await captureMetrics(async () => {
      // Armed, but nothing runs before its interval.
      schedule = startReadGraphChecks(store, {
        sampledIntervalMs: 3_600_000, sampledPerPass: 2, fullIntervalMs: 3_600_000,
        onError: (_error, readGraph) => { errors.push(readGraph); },
      });
      await schedule.whenIdle();
      expect(schedule.requestSampledCheck()).toBe(true);
      await schedule.whenIdle();
      expect(schedule.requestSampledCheck()).toBe(true);
      await schedule.whenIdle();
    });
    // Two passes of two read graphs: all four, each once.
    const checked = recorded.filter((entry) => entry.metric === 'dkg.store.read_graph_checks_total');
    expect(checked.map((entry) => entry.attributes.layer).sort()).toEqual(['swm', 'vm', 'vm', 'wm']);
    expect(checked.filter((entry) => entry.attributes.outcome === 'error')).toHaveLength(1);
    expect(errors).toEqual([failing]);
    await schedule!.close();
    // A closed schedule starts nothing again.
    expect(schedule!.requestSampledCheck()).toBe(false);
    expect(schedule!.requestFullCheck()).toBe(false);
    await adapter.close();
  });
});
