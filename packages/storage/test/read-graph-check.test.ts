import { describe, expect, it, vi } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { nonEmptyNamedGraphEnumerationPattern } from '../src/adapters/graph-enumeration-query.js';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { checkReadGraph, memberGraphListingQuery } from '../src/read-graph/check.js';
import { ReadGraphCheckSchedule, startReadGraphChecks } from '../src/read-graph/check-schedule.js';
import { withReadGraphBackgroundSlot } from '../src/read-graph/background-slot.js';
import { readGraphStateCompareAndSet } from '../src/read-graph/state.js';
import type { QueryOptions, QueryResult } from '../src/triple-store.js';
import { captureMetrics, readGraphCheckConformance } from './helpers/read-graph-check-conformance.js';
import { AGENT, layerFixture, layeredStore, q, readyRow } from './helpers/read-graph-layer-conformance.js';
import { PlanningOxigraphStore } from './helpers/read-graph-planning-store.js';

readGraphCheckConformance('oxigraph');

/**
 * An adapter that runs `before` ahead of each query whose text `matches`,
 * and can answer `listGraphs` from a list it cached earlier.
 */
class HookedStore extends PlanningOxigraphStore {
  hook: { matches: (sparql: string) => boolean; before: () => Promise<void> } | undefined;
  cachedGraphs: string[] | undefined;

  override async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    if (this.hook?.matches(sparql)) await this.hook.before();
    return super.query(sparql, options);
  }

  override async listGraphs(options?: QueryOptions): Promise<string[]> {
    return this.cachedGraphs ? [...this.cachedGraphs] : super.listGraphs(options);
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
const isMemberEnumeration = (sparql: string) => sparql.startsWith('SELECT ?g WHERE { GRAPH ?g {}');

describe('read-graph checks under concurrent writes', () => {
  it('lists member graphs in the form the adapter lists its graphs with, so the store narrows the list', () => {
    const root = 'did:dkg:context-graph:listing';
    const under = `FILTER(?g = <${root}> || STRSTARTS(STR(?g), "${root}/"))`;
    expect(memberGraphListingQuery(new PlanningOxigraphStore(), root)).toBe(`SELECT ?g WHERE { ${nonEmptyNamedGraphEnumerationPattern('g')} ${under} }`);
    const blazegraph = new BlazegraphStore('http://fixture.invalid/sparql');
    expect(memberGraphListingQuery(blazegraph, root)).toBe(`SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } ${under} }`);
    // Through a decorator, as below the read-graph layer.
    expect(memberGraphListingQuery({ innerStore: blazegraph } as unknown as OxigraphStore, root)).toBe(memberGraphListingQuery(blazegraph, root));
  });

  it('lists member graphs from the store itself, past a graph list an adapter cached', async () => {
    const { adapter, fixture, store } = await hooked();
    const { wholeVm } = fixture.readGraphs;
    // The adapter keeps answering listGraphs from before the write, as a cached list would.
    adapter.cachedGraphs = await adapter.listGraphs();
    // A maintained write: the new member and the read graph change together.
    await store.insert([q('urn:s:late', '"late"', `${fixture.root}/_verifiable_memory/${AGENT}/9`)]);
    expect(await checkReadGraph(store, wholeVm, 'full')).toEqual({ readGraph: wholeVm, mode: 'full', outcome: 'consistent' });
    await adapter.close();
  });

  it('leaves a read graph alone when a newer generation is published while a full check runs', async () => {
    const { adapter, fixture, layer, store } = await hooked();
    const { wholeVm } = fixture.readGraphs;
    let probes = 0;
    adapter.hook = {
      matches: isMissingProbe,
      // During the first probe a rebuild publishes generation 3 under the lock, holding a triple no member holds.
      before: async () => {
        if (++probes !== 1) return;
        await layer.runtime.locks.withLocks([wholeVm], async () => {
          layer.runtime.mirror.set(readyRow(wholeVm, 3));
          await adapter.insert([q('urn:s:stray', '"stray"', wholeVm)]);
        });
      },
    };
    const alerts: string[] = [];
    expect(await checkReadGraph(store, wholeVm, 'full', { alert: (message) => alerts.push(message) }))
      .toEqual({ readGraph: wholeVm, mode: 'full', outcome: 'skipped' });
    expect(probes).toBeGreaterThan(0);
    expect(layer.runtime.mirror.get(wholeVm)).toMatchObject({ state: 'ready', generation: 3 });
    expect(alerts).toEqual([]);
    // The check that starts at generation 3 finds the triple.
    expect(await checkReadGraph(store, wholeVm, 'full', { alert: (message) => alerts.push(message) }))
      .toEqual({ readGraph: wholeVm, mode: 'full', outcome: 'mismatch', direction: 'unheld' });
    await adapter.close();
  });

  it('probes a member graph that appears between the probes and the count', async () => {
    const { adapter, fixture, layer, store } = await hooked();
    const { wholeVm } = fixture.readGraphs;
    let listings = 0;
    adapter.hook = {
      matches: isMemberEnumeration,
      // Before the count lists the members: equal-sized corruption below every decorator.
      before: async () => {
        if (++listings !== 2) return;
        await adapter.delete([q('urn:s:1', '"v1"', fixture.graphs[1]!)]);
        await adapter.insert([q('urn:s:new', '"new"', `${fixture.root}/_verifiable_memory/${AGENT}/9`)]);
      },
    };
    expect(await checkReadGraph(store, wholeVm, 'full')).toEqual({ readGraph: wholeVm, mode: 'full', outcome: 'mismatch', direction: 'missing' });
    expect(listings).toBe(2);
    expect(layer.runtime.mirror.get(wholeVm)).toMatchObject({ state: 'dirty', generation: 2 });
    await adapter.close();
  });

  it('finds equal-sized corruption beside a member graph that a warm catalog does not know', async () => {
    const { adapter, fixture, layer, store } = await hooked();
    const { wholeVm } = fixture.readGraphs;
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(wholeVm)));
    const indexed = new GraphSetIndexStore(store);
    // Warm the catalog, then change the store below every decorator.
    await indexed.listGraphsByPrefix(`${fixture.root}/`);
    const newMember = `${fixture.root}/_verifiable_memory/${AGENT}/9`;
    // The read graph keeps a triple no member holds any more, and lacks one of a new member: its size is unchanged.
    await adapter.delete([q('urn:s:1', '"v1"', fixture.graphs[1]!)]);
    await adapter.insert([q('urn:s:new', '"new"', newMember)]);
    expect(await indexed.listGraphsByPrefix(`${fixture.root}/`)).not.toContain(newMember);
    expect(await checkReadGraph(indexed, wholeVm, 'full')).toEqual({ readGraph: wholeVm, mode: 'full', outcome: 'mismatch', direction: 'missing' });
    expect(layer.runtime.mirror.get(wholeVm)).toMatchObject({ state: 'dirty', generation: 2 });
    await adapter.close();
  });

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

  it('holds sampled passes back while a full pass runs, so they cannot interrupt it', async () => {
    const { adapter, fixture, store } = await hooked();
    const { wholeVm } = fixture.readGraphs;
    const schedule = new ReadGraphCheckSchedule(store, { sampledIntervalMs: 3_600_000, fullIntervalMs: 3_600_000 });
    let requests = 0;
    adapter.hook = {
      // While the full check counts, a sampled pass is asked for; one that ran would take the read graph's lock.
      matches: (sparql) => isSizeQuery(sparql) && sparql.includes(wholeVm),
      before: async () => {
        if (schedule.requestSampledCheck()) requests += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    };
    const { recorded } = await captureMetrics(async () => {
      expect(schedule.requestFullCheck()).toBe(true);
      await schedule.whenIdle();
    });
    const checks = recorded.filter((entry) => entry.metric === 'dkg.store.read_graph_checks_total').map((entry) => entry.attributes);
    expect(requests).toBeGreaterThan(0);
    expect(checks.filter((attributes) => attributes.mode === 'sampled')).toEqual([]);
    expect(checks).toHaveLength(4);
    expect(checks.every((attributes) => attributes.outcome === 'consistent')).toBe(true);
    await schedule.close();
    await adapter.close();
  });

  it('runs each check in the backend background slot, so no check runs beside a build', async () => {
    const { adapter, layer, store } = await hooked();
    const schedule = new ReadGraphCheckSchedule(store, { sampledIntervalMs: 3_600_000, fullIntervalMs: 3_600_000 });
    let counts = 0;
    adapter.hook = { matches: isSizeQuery, before: async () => { counts += 1; } };
    let release: (() => void) | undefined;
    const { recorded } = await captureMetrics(async () => {
      // A build holds the slot until it is released.
      const build = withReadGraphBackgroundSlot(layer.runtime, () => new Promise<void>((resolve) => { release = resolve; }));
      expect(schedule.requestFullCheck()).toBe(true);
      let idle = false;
      const ended = schedule.whenIdle().then(() => { idle = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(counts).toBe(0);
      expect(idle).toBe(false);
      release!();
      await build;
      await ended;
    });
    const checks = recorded.filter((entry) => entry.metric === 'dkg.store.read_graph_checks_total').map((entry) => entry.attributes);
    expect(counts).toBeGreaterThan(0);
    expect(checks).toHaveLength(4);
    expect(checks.every((attributes) => attributes.mode === 'full' && attributes.outcome === 'consistent')).toBe(true);
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

  it('runs both passes on its own once started, with no request', async () => {
    const { adapter, store } = await hooked();
    const passes = new Set<string>();
    // A full pass counts each read graph's size; a sampled pass takes subjects from member graphs.
    adapter.hook = {
      matches: (sparql) => {
        if (isSizeQuery(sparql)) passes.add('full');
        if (sparql.startsWith('SELECT DISTINCT ?s WHERE { GRAPH <')) passes.add('sampled');
        return false;
      },
      before: async () => {},
    };
    const schedule = startReadGraphChecks(store, { sampledIntervalMs: 20, fullIntervalMs: 40 });
    try {
      await vi.waitFor(() => expect([...passes].sort()).toEqual(['full', 'sampled']), { timeout: 10_000, interval: 20 });
    } finally {
      await schedule.close();
      await adapter.close();
    }
  });
});
