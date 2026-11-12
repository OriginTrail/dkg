import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, readGraphIri, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { missingReadGraphMethods } from '../src/read-graph/adapter-contract.js';
import { guardReadGraphPartition } from '../src/read-graph-partition-store.js';
import { withReadGraphBackgroundSlot } from '../src/read-graph/background-slot.js';
import { ReadGraphBuilder } from '../src/read-graph/builder.js';
import { readGraphDropRequests, requestReadGraphDrops } from '../src/read-graph/drop-requests.js';
import { applyReadGraphModes, applyViewSemantics, type ReadGraphModeChange } from '../src/read-graph/live-modes.js';
import { ReadGraphWriteRefusedError, wrapReadGraphLayer } from '../src/read-graph/read-graph-store.js';
import { markReadGraphDirty, removeReadGraph } from '../src/read-graph/rebuild.js';
import { readGraphModeOf, type ReadGraphModes } from '../src/read-graph/settings.js';
import { READ_GRAPH_STATE_PREDICATES, parseReadGraphStateRows, readGraphStateRowsQuery } from '../src/read-graph/state.js';
import { readGraphDataDirectories } from '../src/read-graph/data-directories.js';
import { startReadGraphs } from '../src/read-graph/startup.js';
import { noteReadGraphStoreRestored } from '../src/read-graph/store-restored.js';
import type { Quad, QueryOptions, TripleStore, UpdateOptions } from '../src/triple-store.js';
import { matchesGraphNameTest, readGraphEnumerationRoots, readGraphMembership } from '../src/read-graph/membership.js';
import { isLayerMember, layerFixture, q, type LayerFixture } from './helpers/read-graph-layer-conformance.js';
import { PlanningOxigraphStore } from './helpers/read-graph-planning-store.js';

/** An adapter that offers only the methods it plans, and lets a test act on each update before it is sent. */
class HookedStore extends PlanningOxigraphStore {
  onUpdate: ((sparql: string, options: UpdateOptions | undefined) => Promise<void> | void) | undefined;
  constructor() {
    super();
    for (const method of missingReadGraphMethods(this, this.readGraphCapabilities)) {
      Object.defineProperty(this, method, { value: undefined, configurable: true, writable: true });
    }
  }
  override async update(sparql: string, options?: UpdateOptions): Promise<void> {
    await this.onUpdate?.(sparql, options);
    return super.update(sparql, options);
  }
  override async insert(quads: Quad[], options?: QueryOptions): Promise<void> {
    return super.insert(quads, options);
  }
}

const VM = MemoryLayer.VerifiableMemory;
const SWM = MemoryLayer.SharedWorkingMemory;

let sequence = 0;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The settings that put one context graph's layer at a mode, over a node with everything else off. */
const layerAt = (contextGraphId: string, layer: MemoryLayer, mode: 'off' | 'build' | 'serve'): ReadGraphModes =>
  ({ contextGraphs: { [contextGraphId]: { layers: { [layer]: mode } } } });

/** A node over a store with the fixture's data, started with `modes`, as a daemon starts. */
async function open(options: { readonly modes?: ReadGraphModes; readonly adapter?: HookedStore; readonly dataDir?: string; readonly fixture?: LayerFixture } = {}) {
  const adapter = options.adapter ?? new HookedStore();
  const fixture = options.fixture ?? layerFixture(`live-${sequence += 1}`);
  const layer = wrapReadGraphLayer(adapter, { backend: 'oxigraph', ...(options.modes ? { readGraphs: { modes: options.modes } } : {}) });
  const store = guardReadGraphPartition(layer);
  if (!options.adapter) {
    await adapter.insert([
      ...fixture.facts,
      ...fixture.graphs.flatMap((graph, i) => [q('urn:s:shared', '"both"', graph), q(`urn:s:${i}`, `"v${i}"`, graph)]),
    ]);
  }
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'read-graph-live-'));
  if (!options.dataDir) dirs.push(dataDir);
  await startReadGraphs(store, { dataDir });
  return { adapter, fixture, layer, store, dataDir };
}

type Node = Awaited<ReturnType<typeof open>>;

/** The node's builder, as the agent runs it: it wants the fixture's read graphs whose mode is not off, and removes the others. */
function builderOf({ store, dataDir, layer, fixture }: Node): ReadGraphBuilder {
  return new ReadGraphBuilder({
    store,
    dataDir,
    intervalMs: 3_600_000,
    batching: { pauseRatio: 0, graphsPerBatch: 2, triplesPerDrop: 2 },
    wanted: () => fixture.keys.filter((key) => readGraphModeOf(layer.runtime.modes, key) !== 'off'),
    off: (key) => readGraphModeOf(layer.runtime.modes, key) === 'off',
  });
}

async function pass(builder: ReadGraphBuilder): Promise<void> {
  builder.request();
  await builder.whenIdle();
}

/** Writes to member graphs of every layer, one after another, until ended; a write the layer refuses fails the test. */
function writeLoad({ store, fixture }: Node) {
  const graphs = [fixture.graphs[1]!, fixture.graphs[4]!, fixture.graphs[6]!, fixture.graphs[7]!];
  let stopped = false;
  let writes = 0;
  let failure: unknown;
  const running = (async () => {
    while (!stopped) {
      const graph = graphs[writes % graphs.length]!;
      const quad = q(`urn:load:${writes}`, `"w${writes}"`, graph);
      try {
        await store.insert([quad]);
        // Every third write takes one back, so deletes are maintained too.
        if (writes % 3 === 2) await store.delete([q(`urn:load:${writes - 1}`, `"w${writes - 1}"`, graphs[(writes - 1) % graphs.length]!)]);
      } catch (error) {
        failure ??= error;
      }
      writes += 1;
      await nextTurn();
    }
  })();
  return {
    get writes() {
      return writes;
    },
    async end(): Promise<number> {
      stopped = true;
      await running;
      if (failure !== undefined) throw failure;
      return writes;
    },
  };
}

async function stored(adapter: TripleStore): Promise<Record<string, string>> {
  const result = await adapter.query(readGraphStateRowsQuery());
  const rows = parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []).rows;
  return Object.fromEntries(rows.map((row) => [row.readGraph, row.state]));
}

async function triplesOf(adapter: TripleStore, graph: string): Promise<string[]> {
  const result = await adapter.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  return (result.type === 'bindings' ? result.bindings : []).map((b) => `${b.s} ${b.p} ${b.o}`).sort();
}

/** The read graph of `key` holds exactly the union of its member graphs. */
async function expectUnion({ adapter, layer, fixture }: Pick<Node, 'adapter' | 'layer' | 'fixture'>, key: ReadGraphKey): Promise<void> {
  const result = await adapter.query(`SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${fixture.root}")) }`);
  const quads = result.type === 'bindings' ? result.bindings : [];
  const expected = [...new Set(quads.filter((b) => isLayerMember(layer, fixture, key, b.g!)).map((b) => `${b.s} ${b.p} ${b.o}`))].sort();
  expect(expected.length).toBeGreaterThan(0);
  expect(await triplesOf(adapter, readGraphIri(key))).toEqual(expected);
}

const undeclaredUpdate = (store: TripleStore, fixture: LayerFixture) =>
  store.update!(`INSERT DATA { GRAPH <${fixture.graphs[1]}> { <urn:s:undeclared> <urn:p> "x" } }`);

const outcomeOf = (changes: readonly ReadGraphModeChange[], layer: string) => changes.find((change) => change.layer === layer)?.outcome;

describe('switching read graphs live', () => {
  it('off to build: rows and maintenance at once, the undeclared-update refusal with them, and a backfill under write load', async () => {
    const node = await open();
    const { adapter, fixture, layer, store } = node;
    const [wholeVm, , codeVm] = fixture.keys as [ReadGraphKey, ReadGraphKey, ReadGraphKey];
    // Off: nothing is maintained, and an update that declares no graphs is sent.
    await undeclaredUpdate(store, fixture);
    const load = writeLoad(node);
    const changes = await applyReadGraphModes(store, layerAt(fixture.contextGraphId, VM, 'build'), {
      dataDir: node.dataDir,
      wanted: () => fixture.keys.filter((key) => key.layer === VM),
    });
    expect(changes).toEqual([
      { contextGraphId: fixture.contextGraphId, layer: 'working-memory', from: 'off', to: 'off', outcome: 'unchanged' },
      { contextGraphId: fixture.contextGraphId, layer: 'shared-working-memory', from: 'off', to: 'off', outcome: 'unchanged' },
      { contextGraphId: fixture.contextGraphId, layer: 'verifiable-memory', from: 'off', to: 'build', outcome: 'applied' },
    ]);
    // The rows exist, dirty, in the store and the mirror, so writes are maintained and an undeclared update is refused.
    expect(await stored(adapter)).toEqual({ [readGraphIri(wholeVm)]: 'dirty', [readGraphIri(codeVm)]: 'dirty' });
    expect(layer.runtime.mirror.get(readGraphIri(wholeVm))?.state).toBe('dirty');
    await expect(undeclaredUpdate(store, fixture)).rejects.toBeInstanceOf(ReadGraphWriteRefusedError);
    // The registry was read and installed with the rows.
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code']);

    const builder = builderOf(node);
    await pass(builder);
    expect(load.writes).toBeGreaterThan(0);
    await load.end();
    await pass(builder);
    await builder.close();
    expect(await stored(adapter)).toEqual({ [readGraphIri(wholeVm)]: 'ready', [readGraphIri(codeVm)]: 'ready' });
    await expectUnion(node, wholeVm);
    await expectUnion(node, codeVm);
  });

  it('build to serve and back: serving follows the mode, and the rows and their maintenance stay as they are under write load', async () => {
    const node = await open({ modes: layerAt(`live-${sequence + 1}`, VM, 'build') });
    const { adapter, fixture, layer, store } = node;
    const [wholeVm] = fixture.keys as [ReadGraphKey];
    const builder = builderOf(node);
    await pass(builder);
    const before = layer.runtime.mirror.get(readGraphIri(wholeVm));
    expect(before?.state).toBe('ready');
    const load = writeLoad(node);
    const toServe = await applyReadGraphModes(store, layerAt(fixture.contextGraphId, VM, 'serve'));
    expect(outcomeOf(toServe, 'verifiable-memory')).toBe('applied');
    expect(readGraphModeOf(layer.runtime.modes, wholeVm)).toBe('serve');
    expect(layer.runtime.mirror.get(readGraphIri(wholeVm))).toEqual(before);
    const toBuild = await applyReadGraphModes(store, layerAt(fixture.contextGraphId, VM, 'build'));
    expect(toBuild.find((change) => change.layer === 'verifiable-memory')).toMatchObject({ from: 'serve', to: 'build', outcome: 'applied' });
    expect(readGraphModeOf(layer.runtime.modes, wholeVm)).toBe('build');
    await load.end();
    await pass(builder);
    await builder.close();
    // No switch between build and serve touched a row: the writes kept the read graph exact.
    expect(layer.runtime.mirror.get(readGraphIri(wholeVm))).toEqual(before);
    expect((await stored(adapter))[readGraphIri(wholeVm)]).toBe('ready');
    await expectUnion(node, wholeVm);
  });

  it('build to off: out of service and unmaintained at once, then dropped by the builder in the background, under write load', async () => {
    const node = await open({ modes: { layers: { [VM]: 'build', [SWM]: 'build' } } });
    const { adapter, fixture, layer, store } = node;
    const [wholeVm, wholeSwm, codeVm] = fixture.keys as [ReadGraphKey, ReadGraphKey, ReadGraphKey];
    const builder = builderOf(node);
    await pass(builder);
    expect(await stored(adapter)).toMatchObject({ [readGraphIri(wholeVm)]: 'ready', [readGraphIri(wholeSwm)]: 'ready' });
    const load = writeLoad(node);
    const sent: string[] = [];
    adapter.onUpdate = (sparql) => {
      sent.push(sparql);
    };
    const changes = await applyReadGraphModes(store, { layers: { [SWM]: 'build' }, contextGraphs: { [fixture.contextGraphId]: { layers: { [VM]: 'off' } } } });
    expect(outcomeOf(changes, 'verifiable-memory')).toBe('applied');
    expect(outcomeOf(changes, 'shared-working-memory')).toBe('unchanged');
    // Out of the mirror and dirty in the store, with their drops asked for; the shared-memory read graph is untouched.
    for (const readGraph of [readGraphIri(wholeVm), readGraphIri(codeVm)]) {
      expect(layer.runtime.mirror.get(readGraph)).toBeUndefined();
      expect((await stored(adapter))[readGraph]).toBe('dirty');
    }
    expect([...readGraphDropRequests(layer.runtime)].sort()).toEqual([readGraphIri(codeVm), readGraphIri(wholeVm)].sort());
    expect(layer.runtime.mirror.get(readGraphIri(wholeSwm))?.state).toBe('ready');
    // A write after the switch no longer maintains them.
    await store.insert([q('urn:s:after-off', '"x"', fixture.graphs[1]!)]);
    await store.delete([q('urn:s:0', '"v0"', fixture.graphs[0]!)]);
    adapter.onUpdate = undefined;
    expect(await triplesOf(adapter, readGraphIri(wholeVm))).not.toContain('urn:s:after-off urn:test:p "x"');
    expect(await triplesOf(adapter, readGraphIri(wholeVm))).toContain('urn:s:0 urn:test:p "v0"');
    expect(sent.filter((sparql) => sparql.includes('<urn:s:0>')).some((sparql) => sparql.includes(readGraphIri(wholeVm)))).toBe(false);

    expect(builder.atLastBuild(readGraphIri(wholeVm))?.triples).toBeGreaterThan(0);
    await pass(builder);
    await load.end();
    await pass(builder);
    await builder.close();
    // A removed read graph has no size.
    expect(builder.atLastBuild(readGraphIri(wholeVm))).toBeUndefined();
    expect(await stored(adapter)).toEqual({ [readGraphIri(wholeSwm)]: 'ready' });
    expect(await triplesOf(adapter, readGraphIri(wholeVm))).toEqual([]);
    expect(await triplesOf(adapter, readGraphIri(codeVm))).toEqual([]);
    expect(readGraphDropRequests(layer.runtime)).toEqual([]);
    await expectUnion(node, wholeSwm);
  });

  it('repeats an apply as a no-op, runs concurrent applies one at a time, and a later one wins', async () => {
    const node = await open();
    const { adapter, fixture, layer, store } = node;
    const on = layerAt(fixture.contextGraphId, VM, 'build');
    const wanted = () => fixture.keys.filter((key) => readGraphModeOf(layer.runtime.modes, key) !== 'off');
    expect(outcomeOf(await applyReadGraphModes(store, on, { wanted }), 'verifiable-memory')).toBe('applied');
    const rows = await stored(adapter);
    const mirrored = layer.runtime.mirror.rows();
    const again = await applyReadGraphModes(store, on, { wanted });
    expect(again.map((change) => change.outcome)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(await stored(adapter)).toEqual(rows);
    expect(layer.runtime.mirror.rows()).toEqual(mirrored);

    // Two applies asked together run in order; each one's changes are measured from the one before.
    const [first, second] = await Promise.all([
      applyReadGraphModes(store, layerAt(fixture.contextGraphId, VM, 'serve'), { wanted }),
      applyReadGraphModes(store, layerAt(fixture.contextGraphId, VM, 'off'), { wanted }),
    ]);
    expect(first.find((change) => change.layer === 'verifiable-memory')).toMatchObject({ from: 'build', to: 'serve', outcome: 'applied' });
    expect(second.find((change) => change.layer === 'verifiable-memory')).toMatchObject({ from: 'serve', to: 'off', outcome: 'applied' });
    expect(readGraphModeOf(layer.runtime.modes, fixture.keys[0]!)).toBe('off');
    expect(layer.runtime.mirror.size).toBe(0);
    const third = await applyReadGraphModes(store, layerAt(fixture.contextGraphId, VM, 'off'), { wanted });
    expect(third.map((change) => change.outcome)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  it('refuses every change when one is refused, and changes nothing before it would', async () => {
    const node = await open();
    const { fixture, layer, store } = node;
    const before = layer.runtime.modes;
    // A context graph ID that cannot have read graphs refuses the apply, and the other switch with it.
    const refused = await applyReadGraphModes(store, {
      contextGraphs: { [fixture.contextGraphId]: { layers: { [VM]: 'build' } }, 'not eligible/_x': { default: 'build' } },
    });
    expect(refused.find((change) => change.contextGraphId === 'not eligible/_x' && change.layer === 'verifiable-memory')?.outcome)
      .toEqual({ refused: 'this context graph ID cannot have read graphs' });
    expect(refused.find((change) => change.contextGraphId === fixture.contextGraphId && change.layer === 'verifiable-memory')?.outcome)
      .toEqual({ refused: 'not applied: another change in the same apply was refused' });
    expect(layer.runtime.modes).toBe(before);
    expect(layer.runtime.mirror.size).toBe(0);
    // An aborted apply throws and changes nothing.
    await expect(applyReadGraphModes(store, layerAt(fixture.contextGraphId, VM, 'build'), { signal: AbortSignal.abort(new Error('gone')) }))
      .rejects.toThrow('gone');
    expect(layer.runtime.modes).toBe(before);
    // So does a mode that is not one.
    await expect(applyReadGraphModes(store, { default: 'on' as never })).rejects.toThrow(TypeError);
    // A store whose adapter cannot maintain read graphs refuses every switch on, and keeps every switch off.
    const plain = new OxigraphStore();
    const unsupported = guardReadGraphPartition(wrapReadGraphLayer(new Proxy(plain, {
      get(target, property) {
        if (property === 'readGraphCapabilities') return undefined;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }), { backend: 'oxigraph' }));
    const outcome = outcomeOf(await applyReadGraphModes(unsupported, layerAt(fixture.contextGraphId, VM, 'serve')), 'verifiable-memory');
    expect(outcome).toEqual({ refused: expect.stringContaining('cannot maintain read graphs') });
    // A store without the read-graph layer has nothing to switch on.
    expect(outcomeOf(await applyReadGraphModes(new OxigraphStore(), layerAt(fixture.contextGraphId, VM, 'build')), 'verifiable-memory'))
      .toEqual({ refused: 'this store has no read-graph layer' });
  });

  it('keeps the modes and view semantics applied live when another store object over the backend is made from the configuration', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'read-graph-live-shared-'));
    dirs.push(dataDir);
    const config = {
      backend: 'oxigraph-persistent' as const, options: { path: join(dataDir, 'store') },
      readGraphs: { modes: {}, viewSemantics: { default: 'per-asset' as const } },
    };
    const first = wrapReadGraphLayer(new HookedStore(), config);
    const applied = layerAt('live-shared', VM, 'build');
    await applyReadGraphModes(first, applied);
    applyViewSemantics(first, { contextGraphs: { 'live-shared': 'merged' } });
    const second = wrapReadGraphLayer(new HookedStore(), config);
    expect(second.runtime).toBe(first.runtime);
    expect(second.runtime.modes).toEqual(applied);
    expect(second.runtime.viewSemantics).toEqual({ contextGraphs: { 'live-shared': 'merged' } });
    // A value that is not one is refused, and changes nothing; a store without the layer has nothing to set.
    expect(() => applyViewSemantics(first, { default: 'joined' as never })).toThrow(TypeError);
    expect(second.runtime.viewSemantics).toEqual({ contextGraphs: { 'live-shared': 'merged' } });
    expect(() => applyViewSemantics(new OxigraphStore(), { default: 'merged' })).not.toThrow();
  });

  it('sets the view semantics given with the modes when they commit, and neither when the apply is refused', async () => {
    const node = await open();
    const { fixture, layer, store } = node;
    const merged = { contextGraphs: { [fixture.contextGraphId]: 'merged' as const } };
    // Only the semantics change: every layer is unchanged, and the semantics are set.
    const same = await applyReadGraphModes(store, { contextGraphs: { [fixture.contextGraphId]: {} } }, { viewSemantics: merged });
    expect(same.map((change) => change.outcome)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(layer.runtime.viewSemantics).toEqual(merged);
    // A refused apply sets neither.
    const refused = await applyReadGraphModes(store, { contextGraphs: { 'not eligible/_x': { default: 'build' } } }, { viewSemantics: { default: 'merged' } });
    expect(refused.every((change) => change.outcome === 'unchanged' || typeof change.outcome === 'object')).toBe(true);
    expect(layer.runtime.viewSemantics).toEqual(merged);
    // Semantics that are not ones throw before anything changes.
    await expect(applyReadGraphModes(store, layerAt(fixture.contextGraphId, VM, 'build'), { viewSemantics: { default: 'joined' as never } }))
      .rejects.toThrow(TypeError);
    expect(readGraphModeOf(layer.runtime.modes, fixture.keys[0]!)).toBe('off');
    expect(layer.runtime.viewSemantics).toEqual(merged);
  });

  it('reports how much of the read graph in progress it has copied, and nothing once the build ends', async () => {
    const node = await open({ modes: layerAt(`live-${sequence + 1}`, VM, 'build') });
    const { adapter, fixture, store, dataDir, layer } = node;
    const wholeVm = readGraphIri(fixture.keys[0]!);
    const builder = new ReadGraphBuilder({
      store, dataDir, intervalMs: 3_600_000, batching: { pauseRatio: 0, graphsPerBatch: 1, maxGraphsPerBatch: 1 },
      wanted: () => fixture.keys.filter((key) => readGraphModeOf(layer.runtime.modes, key) !== 'off'),
    });
    const seen: Array<number | undefined> = [];
    adapter.onUpdate = (sparql) => {
      if (sparql.startsWith('INSERT') && sparql.includes(`GRAPH <${wholeVm}>`)) seen.push(builder.status().progress);
    };
    await pass(builder);
    adapter.onUpdate = undefined;
    // One batch per member graph: none copied when the first is sent, and one more each time after.
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.map((progress) => Math.round(progress! * seen.length))).toEqual(seen.map((_, i) => i));
    expect(seen.every((progress) => progress! < 1)).toBe(true);
    expect(builder.status().progress).toBeUndefined();
    // The size of each read graph it built, as it was when the build ended: its triples, and its member graphs
    // found by listing, every batch but those of the membership's fixed names.
    const held = (await triplesOf(adapter, wholeVm)).length;
    expect(held).toBeGreaterThan(0);
    const membership = readGraphMembership(fixture.keys[0]!, fixture.registry, layer.runtime.workingMemoryIdentity);
    const fixed = readGraphEnumerationRoots(membership)!.iris.filter((iri) => matchesGraphNameTest(membership, iri)).length;
    expect(fixed).toBeGreaterThan(0);
    expect(builder.atLastBuild(wholeVm)).toEqual({ triples: held, members: seen.length - fixed });
    expect(builder.atLastBuild(readGraphIri(fixture.keys[1]!))).toBeUndefined();
    await builder.close();
  });

  it('drops a read graph switched off whose removal a restart cut short, once the next start finds its row', async () => {
    const fixture = layerFixture(`live-${sequence += 1}`);
    const kept = layerFixture(`live-${sequence += 1}`);
    const modes: ReadGraphModes = { contextGraphs: { [fixture.contextGraphId]: { layers: { [VM]: 'build' } }, [kept.contextGraphId]: { layers: { [VM]: 'build' } } } };
    const node = await open({ modes, fixture });
    await node.adapter.insert(kept.graphs.map((graph, i) => q(`urn:k:${i}`, '"k"', graph)));
    const builder = new ReadGraphBuilder({
      store: node.store, dataDir: node.dataDir, intervalMs: 3_600_000, batching: { pauseRatio: 0, triplesPerDrop: 1 },
      wanted: () => [fixture.keys[0]!, kept.keys[0]!].filter((key) => readGraphModeOf(node.layer.runtime.modes, key) !== 'off'),
      off: (key) => readGraphModeOf(node.layer.runtime.modes, key) === 'off',
    });
    await pass(builder);
    const switchedOff = readGraphIri(fixture.keys[0]!);
    const next: ReadGraphModes = { contextGraphs: { [fixture.contextGraphId]: { layers: { [VM]: 'off' } }, [kept.contextGraphId]: { layers: { [VM]: 'build' } } } };
    const load = writeLoad(node);
    await applyReadGraphModes(node.store, next);
    // The process ends during the drop: at its second batch, the builder stops.
    let drops = 0;
    let stopping: Promise<void> | undefined;
    node.adapter.onUpdate = (sparql) => {
      if (sparql.startsWith('DELETE') && sparql.includes(`GRAPH <${switchedOff}>`) && (drops += 1) === 2) stopping = builder.close();
    };
    await pass(builder);
    await stopping;
    expect(drops).toBe(2);
    await load.end();
    node.adapter.onUpdate = undefined;
    expect((await stored(node.adapter))[switchedOff]).toBe('dirty');
    expect((await triplesOf(node.adapter, switchedOff)).length).toBeGreaterThan(0);

    // The next process starts with the settings the switch left, and its builder ends the drop.
    const restarted = await open({ modes: next, adapter: node.adapter, dataDir: node.dataDir, fixture });
    expect(readGraphDropRequests(restarted.layer.runtime)).toEqual([switchedOff]);
    const after = new ReadGraphBuilder({
      store: restarted.store, dataDir: restarted.dataDir, intervalMs: 3_600_000, batching: { pauseRatio: 0 },
      wanted: () => [kept.keys[0]!],
      off: (key) => readGraphModeOf(restarted.layer.runtime.modes, key) === 'off',
    });
    await pass(after);
    await after.close();
    expect(await stored(node.adapter)).toEqual({ [readGraphIri(kept.keys[0]!)]: 'ready' });
    expect(await triplesOf(node.adapter, switchedOff)).toEqual([]);
  });

  it('rebuilds a read graph switched on whose backfill a restart cut short, and one whose backend restored during it', async () => {
    const node = await open();
    const { adapter, fixture, store, dataDir } = node;
    const [wholeVm] = fixture.keys as [ReadGraphKey];
    const next = layerAt(fixture.contextGraphId, VM, 'build');
    const load = writeLoad(node);
    await applyReadGraphModes(store, next, { dataDir, wanted: () => [wholeVm] });
    // A restore the backend reports while the backfill copies ends the job; the next pass builds the read graph again.
    let copies = 0;
    adapter.onUpdate = (sparql) => {
      if (sparql.includes(`GRAPH <${readGraphIri(wholeVm)}>`) && sparql.startsWith('INSERT') && (copies += 1) === 1) noteReadGraphStoreRestored(store);
    };
    const builder = new ReadGraphBuilder({
      store, dataDir, intervalMs: 3_600_000, batching: { pauseRatio: 0, graphsPerBatch: 1 }, wanted: () => [wholeVm], off: () => false,
    });
    await pass(builder);
    expect(builder.status().lastJob).toMatchObject({ readGraph: readGraphIri(wholeVm), outcome: 'lost' });
    adapter.onUpdate = undefined;
    // The process ends before the build that follows: the next one starts with the settings the switch left.
    await builder.close();
    await load.end();
    expect((await stored(adapter))[readGraphIri(wholeVm)]).not.toBe('ready');
    const restarted = await open({ modes: next, adapter, dataDir, fixture });
    expect(restarted.layer.runtime.mirror.get(readGraphIri(wholeVm))?.state).toBe('dirty');
    const after = new ReadGraphBuilder({
      store: restarted.store, dataDir, intervalMs: 3_600_000, batching: { pauseRatio: 0 }, wanted: () => [wholeVm], off: () => false,
    });
    await pass(after);
    await after.close();
    expect((await stored(adapter))[readGraphIri(wholeVm)]).toBe('ready');
    await expectUnion(restarted, wholeVm);
  });

  it('leaves a builder without an off rule to remove nothing, and forgets a drop asked for a read graph that is on again', async () => {
    const node = await open({ modes: layerAt(`live-${sequence + 1}`, VM, 'build') });
    const { adapter, fixture, layer, store, dataDir } = node;
    const [wholeVm] = fixture.keys as [ReadGraphKey];
    const plain = new ReadGraphBuilder({ store, dataDir, intervalMs: 3_600_000, batching: { pauseRatio: 0 }, wanted: () => [wholeVm] });
    await pass(plain);
    requestReadGraphDrops(layer.runtime, [readGraphIri(wholeVm)]);
    await pass(plain);
    await plain.close();
    expect((await stored(adapter))[readGraphIri(wholeVm)]).toBe('ready');
    // A builder with the rule forgets the drop: the read graph's mode is build.
    const builder = builderOf(node);
    await pass(builder);
    await builder.close();
    expect(readGraphDropRequests(layer.runtime)).toEqual([]);
    expect((await stored(adapter))[readGraphIri(wholeVm)]).toBe('ready');
  });

  it('ends a removal at its next batch once the read graph is switched on again while it drops', async () => {
    const node = await open({ modes: layerAt(`live-${sequence + 1}`, VM, 'build') });
    const { adapter, fixture, layer, store, dataDir } = node;
    const [wholeVm] = fixture.keys as [ReadGraphKey];
    const readGraph = readGraphIri(wholeVm);
    const builder = builderOf(node);
    await pass(builder);
    let drops = 0;
    let admitted: Promise<unknown> | undefined;
    adapter.onUpdate = (sparql) => {
      if (!sparql.startsWith('DELETE') || !sparql.includes(`GRAPH <${readGraph}>`)) return;
      drops += 1;
      // Switched on again during the first batch: the admission waits for the batch's lock, then marks the row.
      admitted ??= markReadGraphDirty({ store, dataDir }, readGraph, { create: true });
    };
    const removal = await removeReadGraph({ store, dataDir, batching: { pauseRatio: 0, triplesPerDrop: 1 } }, readGraph);
    await admitted;
    adapter.onUpdate = undefined;
    expect(removal.outcome).toBe('lost');
    // No batch after the admission: a fenced drop under the old row would change nothing.
    expect(drops).toBe(1);
    expect(layer.runtime.mirror.get(readGraph)?.state).toBe('dirty');
    expect((await stored(adapter))[readGraph]).toBe('dirty');
    await pass(builder);
    await builder.close();
    await expectUnion(node, wholeVm);
  });

  it('ends a build that waited for the background slot once its layer is switched off, without taking it back into the mirror', async () => {
    const node = await open({ modes: layerAt(`live-${sequence + 1}`, VM, 'build') });
    const { adapter, fixture, layer, store, dataDir } = node;
    const [wholeVm, , codeVm] = fixture.keys.map((key) => readGraphIri(key)) as [string, string, string];
    const builder = builderOf(node);
    await pass(builder);
    await markReadGraphDirty({ store, dataDir }, wholeVm);
    // Another job holds the backend's background slot, so the build of the dirty read graph waits for it.
    let release!: () => void;
    const holding = withReadGraphBackgroundSlot(layer.runtime, () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    builder.request();
    await vi.waitFor(() => expect(builder.status().building).toBe(wholeVm));
    await applyReadGraphModes(store, layerAt(fixture.contextGraphId, VM, 'off'));
    expect(layer.runtime.mirror.get(wholeVm)).toBeUndefined();
    // From the switch on, nothing takes the read graph back into the mirror, so no write maintains it again.
    const held: boolean[] = [];
    adapter.onUpdate = () => {
      held.push(layer.runtime.mirror.get(wholeVm) !== undefined);
    };
    release();
    await holding;
    await builder.whenIdle();
    adapter.onUpdate = undefined;
    await builder.close();
    expect(held.length).toBeGreaterThan(0);
    expect(held).not.toContain(true);
    // The pass that ended the build removed both read graphs of the layer.
    expect(await stored(adapter)).toEqual({});
    expect(await triplesOf(adapter, wholeVm)).toEqual([]);
    expect(await triplesOf(adapter, codeVm)).toEqual([]);
  });

  it('asks at a start with every mode off for the drop of each row it finds, so a drop that a restart cut short ends', async () => {
    const node = await open({ modes: layerAt(`live-${sequence + 1}`, VM, 'build') });
    const { adapter, fixture, dataDir } = node;
    const [wholeVm, , codeVm] = fixture.keys.map((key) => readGraphIri(key)) as [string, string, string];
    const builder = builderOf(node);
    await pass(builder);
    await builder.close();
    // The node's only layer is switched off, and the process ends before its builder drops anything.
    await applyReadGraphModes(node.store, layerAt(fixture.contextGraphId, VM, 'off'));
    expect(await stored(adapter)).toEqual({ [wholeVm]: 'dirty', [codeVm]: 'dirty' });
    expect((await triplesOf(adapter, wholeVm)).length).toBeGreaterThan(0);

    // The next process starts with every mode off: nothing is maintained, and the rows found are to drop.
    const restarted = await open({ adapter, dataDir, fixture });
    expect(restarted.layer.runtime.mirror.size).toBe(0);
    expect([...readGraphDropRequests(restarted.layer.runtime)].sort()).toEqual([codeVm, wholeVm].sort());
    const after = builderOf(restarted);
    await pass(after);
    await after.close();
    expect(await stored(adapter)).toEqual({});
    expect(await triplesOf(adapter, wholeVm)).toEqual([]);
    expect(await triplesOf(adapter, codeVm)).toEqual([]);
  });

  it('ends a removal that waited for the background slot once its layer is switched back on, and keeps the read graph', async () => {
    const node = await open({ modes: layerAt(`live-${sequence + 1}`, VM, 'build') });
    const { adapter, fixture, layer, store, dataDir } = node;
    const [wholeVm, , codeVm] = fixture.keys.map((key) => readGraphIri(key)) as [string, string, string];
    const builder = builderOf(node);
    await pass(builder);
    await applyReadGraphModes(store, layerAt(fixture.contextGraphId, VM, 'off'));
    // Another job holds the backend's background slot, so the removals wait for it.
    let release!: () => void;
    const holding = withReadGraphBackgroundSlot(layer.runtime, () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    builder.request();
    await vi.waitFor(() => expect(builder.status().removing).toBe(2));
    // Switched back on: the stored rows are taken back into the mirror.
    await applyReadGraphModes(store, layerAt(fixture.contextGraphId, VM, 'serve'), { dataDir, wanted: () => fixture.keys.filter((key) => key.layer === VM) });
    expect(layer.runtime.mirror.get(wholeVm)?.state).toBe('dirty');
    release();
    await holding;
    await builder.whenIdle();
    // Neither removal took them out of service, and the drops are no longer asked for.
    expect(layer.runtime.mirror.get(wholeVm)?.state).toBe('dirty');
    expect(layer.runtime.mirror.get(codeVm)?.state).toBe('dirty');
    expect(await stored(adapter)).toEqual({ [wholeVm]: 'dirty', [codeVm]: 'dirty' });
    expect(readGraphDropRequests(layer.runtime)).toEqual([]);
    await pass(builder);
    await builder.close();
    expect(await stored(adapter)).toEqual({ [wholeVm]: 'ready', [codeVm]: 'ready' });
    await expectUnion(node, fixture.keys[0]!);
    await expectUnion(node, fixture.keys[2]!);
  });

  it('readies the runtime when a node default is switched on with no context graph to list, so a later start-up shares the mirror', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'read-graph-live-default-'));
    const other = mkdtempSync(join(tmpdir(), 'read-graph-live-default-other-'));
    dirs.push(dataDir, other);
    const fixture = layerFixture(`live-${sequence += 1}`);
    const adapter = new HookedStore();
    const config = { backend: 'oxigraph-persistent' as const, options: { path: join(dataDir, 'store') } };
    const first = wrapReadGraphLayer(adapter, config);
    const store = guardReadGraphPartition(first);
    await adapter.insert([...fixture.facts, ...fixture.graphs.flatMap((graph, i) => [q('urn:s:shared', '"both"', graph), q(`urn:s:${i}`, `"v${i}"`, graph)])]);
    await startReadGraphs(store, { dataDir });
    expect(await applyReadGraphModes(store, { layers: { [VM]: 'serve' } }, { dataDir })).toEqual([]);
    // The marks the store refuses from now on are journaled in the data directory.
    expect(readGraphDataDirectories(first.runtime)).toContain(dataDir);
    // The first subscription comes, and its read graph is built.
    const builder = new ReadGraphBuilder({
      store, dataDir, intervalMs: 3_600_000, batching: { pauseRatio: 0 }, wanted: () => [fixture.keys[0]!],
      off: (key) => readGraphModeOf(first.runtime.modes, key) === 'off',
    });
    await pass(builder);
    await builder.close();
    const ready = first.runtime.mirror.get(readGraphIri(fixture.keys[0]!));
    expect(ready?.state).toBe('ready');
    // Another store object over the same backend starts: it shares the mirror the layer maintains writes by.
    const cleared = vi.spyOn(first.runtime.mirror, 'remove');
    const second = guardReadGraphPartition(wrapReadGraphLayer(adapter, config));
    expect(await startReadGraphs(second, { dataDir: other })).toEqual({ marked: 0, maintained: 1 });
    expect(cleared).not.toHaveBeenCalled();
    expect(first.runtime.mirror.get(readGraphIri(fixture.keys[0]!))).toEqual(ready);
  });

  it('applies a switch on whose admission the store refuses, and the builder builds the read graph once the store answers', async () => {
    const node = await open();
    const { adapter, fixture, layer, store, dataDir } = node;
    const wholeVm = readGraphIri(fixture.keys[0]!);
    let refused = 0;
    adapter.onUpdate = (sparql) => {
      if (refused === 0 && sparql.includes(`<${wholeVm}> <${READ_GRAPH_STATE_PREDICATES.state}>`)) {
        refused += 1;
        throw new Error('the store is unavailable');
      }
    };
    const changes = await applyReadGraphModes(store, layerAt(fixture.contextGraphId, VM, 'serve'), {
      dataDir, wanted: () => fixture.keys.filter((key) => key.layer === VM),
    });
    adapter.onUpdate = undefined;
    expect(refused).toBe(1);
    expect(outcomeOf(changes, 'verifiable-memory')).toBe('applied');
    // Maintained but not served: the mirror holds it dirty, and no stored row says otherwise.
    expect(layer.runtime.mirror.get(wholeVm)?.state).toBe('dirty');
    expect((await stored(adapter))[wholeVm]).toBeUndefined();
    const builder = builderOf(node);
    await pass(builder);
    await builder.close();
    expect((await stored(adapter))[wholeVm]).toBe('ready');
    await expectUnion(node, fixture.keys[0]!);
  });

  it('applies a switch off whose dirty mark the store refuses, and the builder removes the read graph once the store answers', async () => {
    const node = await open({ modes: layerAt(`live-${sequence + 1}`, VM, 'build') });
    const { adapter, fixture, layer, store } = node;
    const wholeVm = readGraphIri(fixture.keys[0]!);
    const builder = builderOf(node);
    await pass(builder);
    let refused = 0;
    adapter.onUpdate = (sparql) => {
      if (refused === 0 && sparql.includes(`<${wholeVm}> <${READ_GRAPH_STATE_PREDICATES.state}> "dirty"`)) {
        refused += 1;
        throw new Error('the store is unavailable');
      }
    };
    const changes = await applyReadGraphModes(store, layerAt(fixture.contextGraphId, VM, 'off'));
    adapter.onUpdate = undefined;
    expect(refused).toBe(1);
    expect(outcomeOf(changes, 'verifiable-memory')).toBe('applied');
    // Out of service in the mirror, whatever the store still says, and its drop asked for.
    expect(layer.runtime.mirror.get(wholeVm)?.state).toBe('dirty');
    expect((await stored(adapter))[wholeVm]).toBe('ready');
    expect(readGraphDropRequests(layer.runtime)).toContain(wholeVm);
    await pass(builder);
    await builder.close();
    expect(await stored(adapter)).toEqual({});
    expect(await triplesOf(adapter, wholeVm)).toEqual([]);
    expect(layer.runtime.mirror.size).toBe(0);
  });
});
