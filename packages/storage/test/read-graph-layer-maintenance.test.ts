import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { ReadGraphWriteRefusedError } from '../src/read-graph/read-graph-store.js';
import { parseReadGraphStateRows, readGraphStateCompareAndSet, readGraphStateRowsQuery } from '../src/read-graph/state.js';
import type { TripleStore } from '../src/triple-store.js';
import {
  expectLayerUnions,
  layerFixture,
  layeredStore,
  q,
  readGraphLayerConformance,
  readyRow,
  P,
} from './helpers/read-graph-layer-conformance.js';
import { PlanningOxigraphStore } from './helpers/read-graph-planning-store.js';

readGraphLayerConformance('oxigraph');

/**
 * An embedded store that declares no read-graph capabilities, whatever its
 * class declares: only the declaration is hidden, every method is the store's.
 */
function undeclared(store: OxigraphStore): OxigraphStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'readGraphCapabilities') return undefined;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

let sequence = 0;
async function layered(adapter: TripleStore = new PlanningOxigraphStore()) {
  const fixture = layerFixture(`layer-unit-${sequence += 1}`);
  return { adapter, fixture, ...(await layeredStore(adapter, { backend: 'oxigraph' }, fixture)) };
}

describe('read-graph layer on embedded Oxigraph', () => {
  it('refuses, while read graphs exist, every write it cannot maintain, and nothing once none exist', async () => {
    const { fixture, layer, store } = await layered();
    const member = fixture.graphs[1]!;
    const text = `INSERT DATA { GRAPH <${member}> { <urn:s:x> <${P}> "x" } }`;
    await expect(store.update!(text)).rejects.toBeInstanceOf(ReadGraphWriteRefusedError);
    await expect(store.update!(text, { touchedGraphs: [member] })).rejects.toThrow(/writtenGraphs/);
    await expect(store.query(text)).rejects.toBeInstanceOf(ReadGraphWriteRefusedError);
    await expect(store.deleteByPattern({ subject: 'urn:s:1' })).rejects.toThrow(/must name its graph/);
    // An adapter writes a name with IRI-breaking characters under the name without them.
    const rewritten = /writes as given/;
    await expect(store.insert([q('urn:s:x', '"x"', `<${member}>`)])).rejects.toThrow(rewritten);
    await expect(store.dropGraph(`<${member}>`)).rejects.toThrow(rewritten);
    await expect(store.dropGraph(`${member}^`)).rejects.toThrow(rewritten);
    await expect(store.deleteByPattern({ graph: `${member}|`, subject: 'urn:s:1' })).rejects.toThrow(rewritten);
    await expect(store.update!(text, { writtenGraphs: [`<${member}>`] })).rejects.toThrow(rewritten);
    const stray = fixture.readGraphs.wholeVm.replace('_~read', '_~re^ad');
    await expect(store.dropGraph(stray)).rejects.toThrow();
    expect(await layer.innerStore.countQuads(fixture.readGraphs.wholeVm)).toBeGreaterThan(0);
    const refused = await store.update!(text).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'READ_GRAPH_WRITE_REFUSED', outcome: 'not_started', storeOperation: 'update' });

    // An adapter that cannot send read-graph operations keeps inserts, and writes outside every read graph.
    const plain = await layered(undeclared(new OxigraphStore()));
    await expect(plain.store.delete([q('urn:s:1', '"v1"', plain.fixture.graphs[1]!)])).rejects.toThrow(/its adapter cannot send/);
    await plain.store.insert([q('urn:s:z', '"z"', plain.fixture.graphs[1]!)]);
    await plain.store.delete([q('urn:s:9', '"v9"', plain.fixture.graphs[9]!)]);
    await expectLayerUnions(plain.adapter, plain.layer, plain.fixture, 'an insert on an adapter without plans');

    for (const readGraph of Object.values(fixture.readGraphs)) layer.runtime.mirror.remove(readGraph);
    await store.update!(text);
    await store.deleteByPattern({ subject: 'urn:s:x' });
  });

  it('refuses, while read graphs exist, a write with a term its read-graph operations cannot name, before anything is sent', async () => {
    const { adapter, fixture, layer, store } = await layered();
    const planning = adapter as PlanningOxigraphStore;
    planning.requests.length = 0;
    const refused = await store.delete([q('urn:s:1', '"a"b"', fixture.graphs[1]!)]).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'READ_GRAPH_WRITE_REFUSED', outcome: 'not_started', storeOperation: 'delete' });
    expect(planning.requests).toEqual([]);
    expect(await layer.innerStore.countQuads(fixture.graphs[1]!)).toBeGreaterThan(0);
  });

  it('marks the read graphs of a write with an unknown outcome dirty, on an engine that may run it beside later requests', async () => {
    class Unsure extends PlanningOxigraphStore {
      override readonly readGraphCapabilities = { ...new PlanningOxigraphStore().readGraphCapabilities, serialUpdates: false };
      override async delete(): Promise<void> {
        throw new Error('connection reset');
      }
    }
    const { adapter, fixture, layer, store } = await layered(new Unsure());
    const { wholeVm, codeVm, wholeSwm, agentWm } = fixture.readGraphs;
    // The stored rows match the mirror's, so a stored transition shows.
    for (const readGraph of Object.values(fixture.readGraphs)) await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(readGraph)));
    const stored = async () => {
      const result = await adapter.query(readGraphStateRowsQuery());
      const rows = parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []).rows;
      return Object.fromEntries(rows.map((row) => [row.readGraph, `${row.state}@${row.generation}`]));
    };
    await expect(store.delete([q('urn:s:3', '"v3"', fixture.graphs[3]!)])).rejects.toThrow('connection reset');
    expect(layer.runtime.mirror.get(wholeVm)).toMatchObject({ state: 'dirty', generation: 2 });
    expect(layer.runtime.mirror.get(codeVm)).toMatchObject({ state: 'dirty', generation: 2 });
    expect(layer.runtime.mirror.get(wholeSwm)).toMatchObject({ state: 'ready', generation: 1 });
    expect(await stored()).toEqual({ [wholeVm]: 'dirty@2', [codeVm]: 'dirty@2', [wholeSwm]: 'ready@1', [agentWm]: 'ready@1' });
    // A write refused before it was sent changes no row.
    await expect(store.update!('INSERT DATA { <urn:a> <urn:b> <urn:c> }')).rejects.toBeInstanceOf(ReadGraphWriteRefusedError);
    expect(layer.runtime.mirror.get(wholeSwm)?.state).toBe('ready');
    expect((await stored())[wholeSwm]).toBe('ready@1');
  });

  it('stores a dirty mark that failed at the next unknown outcome, although the mirror already says dirty', async () => {
    class Unsure extends PlanningOxigraphStore {
      override readonly readGraphCapabilities = { ...new PlanningOxigraphStore().readGraphCapabilities, serialUpdates: false };
      refusing = false;
      override async delete(): Promise<void> {
        throw new Error('connection reset');
      }
      override async update(sparql: string, options?: Parameters<PlanningOxigraphStore['update']>[1]): Promise<void> {
        if (this.refusing && options?.source === 'storage.readGraphDirtyMark') throw new Error('connection reset');
        return super.update(sparql, options);
      }
    }
    const unsure = new Unsure();
    const { adapter, fixture, layer, store } = await layered(unsure);
    const { wholeVm } = fixture.readGraphs;
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(wholeVm)));
    const storedState = async () => {
      const result = await adapter.query(readGraphStateRowsQuery());
      const row = parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []).rows.find((found) => found.readGraph === wholeVm);
      return `${row?.state}@${row?.generation}`;
    };
    // The first unknown outcome marks the mirror, and its mark does not reach the store.
    unsure.refusing = true;
    await expect(store.delete([q('urn:s:3', '"v3"', fixture.graphs[3]!)])).rejects.toThrow('connection reset');
    expect(layer.runtime.mirror.get(wholeVm)).toMatchObject({ state: 'dirty', generation: 2 });
    expect(await storedState()).toBe('ready@1');
    // The next one sends the mark again from the stored row, and the mirror does not advance a second time.
    unsure.refusing = false;
    await expect(store.delete([q('urn:s:3', '"v3"', fixture.graphs[3]!)])).rejects.toThrow('connection reset');
    expect(layer.runtime.mirror.get(wholeVm)).toMatchObject({ state: 'dirty', generation: 2 });
    expect(await storedState()).toBe('dirty@2');
  });

  it('hands the adapter one plan, locked in code-point order, and restates inserted quads in the same call', async () => {
    const { adapter, fixture, store } = await layered();
    const { wholeVm, codeVm } = fixture.readGraphs;
    const planning = adapter as PlanningOxigraphStore;
    planning.requests.length = 0;
    await store.dropGraph(fixture.graphs[4]!);
    expect(planning.requests).toHaveLength(1);
    expect(planning.requests[0]).toContain(`GRAPH <${codeVm}>`);
    // `…/_~read/cg/…` comes before `…/_~read/sub/…` in code-point order.
    expect(planning.requests[0]!.indexOf(`<${wholeVm}>`)).toBeLessThan(planning.requests[0]!.indexOf(`<${codeVm}>`));
    planning.requests.length = 0;
    await store.insert([q('urn:s:i', '"i"', fixture.graphs[1]!)]);
    expect(planning.requests).toEqual([]);
    const held = await adapter.query(`ASK { GRAPH <${wholeVm}> { <urn:s:i> <${P}> "i" } }`);
    expect(held.type === 'boolean' && held.value).toBe(true);
  });
});
