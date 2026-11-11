import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, READ_GRAPH_SEGMENT, readGraphIri, readGraphStateGraphIri, readScope } from '@origintrail-official/dkg-core';
import { createTripleStore, OxigraphStore, type TripleStore } from '../src/index.js';
import { readGraphPartitionMaintenanceStore, storeMayHoldReadGraphPartitions } from '../src/read-graph-partition-store.js';
import { markReadGraphsDirtyAtStart } from '../src/read-graph-partition-startup.js';
import { mayHoldReadGraphPartitions, noteReadGraphPartitions } from '../src/read-graph-partition-marker.js';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  MAX_READ_GRAPH_GENERATION,
  parseReadGraphStateRows,
  READ_GRAPH_STATE_PREDICATES,
  readGraphStateCompareAndSet,
  readGraphStateRowsQuery,
  type ReadGraphState,
  type ReadGraphStateRow,
} from '../src/read-graph/state.js';

const CG = 'startup';
const VM = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
const SWM = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.SharedWorkingMemory });
const CODE = readGraphIri({ scope: readScope(CG, 'code'), layer: MemoryLayer.VerifiableMemory });
const STATE = readGraphStateGraphIri(CG);
const byGraph = (a: ReadGraphStateRow, b: ReadGraphStateRow) => a.readGraph.localeCompare(b.readGraph);

function row(readGraph: string, state: ReadGraphState, generation: number): ReadGraphStateRow {
  return { readGraph, state, generation, ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion,
    builderVersion: CURRENT_READ_GRAPH_VERSIONS.builderVersion };
}

async function rows(store: TripleStore) {
  const result = await readGraphPartitionMaintenanceStore(store).query(readGraphStateRowsQuery());
  return parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []);
}

async function stateValues(store: TripleStore, graph: string): Promise<string[]> {
  const result = await readGraphPartitionMaintenanceStore(store).query(
    `SELECT ?state WHERE { GRAPH <${graph}> { ?readGraph <${READ_GRAPH_STATE_PREDICATES.state}> ?state } }`);
  return result.type === 'bindings' ? result.bindings.map(binding => binding.state!).sort() : [];
}

async function anyReady(store: TripleStore): Promise<boolean> {
  const result = await readGraphPartitionMaintenanceStore(store).query(
    `ASK { GRAPH <${STATE}> { ?readGraph <${READ_GRAPH_STATE_PREDICATES.state}> "ready" } }`);
  return result.type === 'boolean' && result.value;
}

const opened: TripleStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map(store => store.close()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function storeWithRows(...stored: ReadGraphStateRow[]): Promise<TripleStore> {
  const store = await createTripleStore({ backend: 'oxigraph' });
  opened.push(store);
  const adapter = readGraphPartitionMaintenanceStore(store);
  for (const created of stored) await adapter.update!(readGraphStateCompareAndSet(undefined, created));
  return store;
}

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'read-graph-startup-'));
  dirs.push(dir);
  return dir;
}

describe('marking read graphs dirty at start', () => {
  it('marks every row that is not dirty with a new generation, and notes the partition', async () => {
    const store = await storeWithRows(row(VM, 'ready', 5), row(SWM, 'dirty', 9), row(CODE, 'building', 3));
    const dir = await dataDir();
    expect(storeMayHoldReadGraphPartitions(store)).toBe(false);
    const log = vi.fn();
    expect(await markReadGraphsDirtyAtStart(store, { dataDir: dir, log })).toBe(2);
    expect(log.mock.calls).toEqual([['Marked 2 read graph(s) dirty: this release does not maintain read graphs']]);
    expect(mayHoldReadGraphPartitions(dir)).toBe(true);
    expect(storeMayHoldReadGraphPartitions(store)).toBe(true);
    const after = await rows(store);
    expect(after.damaged).toEqual([]);
    expect(after.rows.sort(byGraph)).toEqual([row(VM, 'dirty', 6), row(SWM, 'dirty', 9), row(CODE, 'dirty', 4)].sort(byGraph));
    expect(await markReadGraphsDirtyAtStart(store, { dataDir: dir, log })).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('changes nothing and notes nothing on a store without read-graph state', async () => {
    const store = await storeWithRows();
    const dir = await dataDir();
    const log = vi.fn();
    expect(await markReadGraphsDirtyAtStart(store, { dataDir: dir, log })).toBe(0);
    expect(log).not.toHaveBeenCalled();
    expect(mayHoldReadGraphPartitions(dir)).toBe(false);
    expect(storeMayHoldReadGraphPartitions(store)).toBe(false);
  });

  it('treats a note left by an interrupted drop as partitions that may remain', async () => {
    const store = await storeWithRows();
    const dir = await dataDir();
    noteReadGraphPartitions(dir);
    expect(await markReadGraphsDirtyAtStart(store, { dataDir: dir })).toBe(0);
    expect(storeMayHoldReadGraphPartitions(store)).toBe(true);
  });

  it('leaves no ready state behind a damaged row, and creates it again, dirty', async () => {
    const store = await storeWithRows(row(VM, 'ready', 5));
    // A row that holds a second state, with a copy in another context graph's state graph, is damaged.
    const elsewhere = readGraphStateGraphIri('elsewhere');
    await readGraphPartitionMaintenanceStore(store).insert([
      { graph: STATE, subject: VM, predicate: READ_GRAPH_STATE_PREDICATES.state, object: '"building"' },
      { graph: elsewhere, subject: VM, predicate: READ_GRAPH_STATE_PREDICATES.state, object: '"ready"' },
    ]);
    expect((await rows(store)).damaged).toEqual([VM]);
    expect(await markReadGraphsDirtyAtStart(store)).toBe(1);
    expect(await anyReady(store)).toBe(false);
    const after = await rows(store);
    expect(after.damaged).toEqual([]);
    expect(after.rows.map(({ readGraph, state }) => [readGraph, state])).toEqual([[VM, 'dirty']]);
    expect(await stateValues(store, elsewhere)).toEqual([]);
  });

  it('starts a row whose generation cannot grow again', async () => {
    const store = await storeWithRows(row(VM, 'ready', MAX_READ_GRAPH_GENERATION));
    expect(await markReadGraphsDirtyAtStart(store)).toBe(1);
    const [after] = (await rows(store)).rows;
    expect(after?.state).toBe('dirty');
    expect(after!.generation).toBeLessThan(MAX_READ_GRAPH_GENERATION);
  });

  it('changes only rows in a context graph\'s own state graph', async () => {
    const store = await storeWithRows(row(VM, 'ready', 5));
    // A partition graph of a context graph that can have no read graphs, planted
    // below the guard, and an ordinary graph with a `_read` segment, written through it.
    const notState = `did:dkg:context-graph:a/_x/${READ_GRAPH_SEGMENT}/state`;
    const ordinary = 'did:dkg:context-graph:a/_x/_read/state';
    const rowsIn = (graph: string) => [VM, 'urn:s'].map(subject =>
      ({ graph, subject, predicate: READ_GRAPH_STATE_PREDICATES.state, object: '"ready"' }));
    await readGraphPartitionMaintenanceStore(store).insert(rowsIn(notState));
    await store.insert(rowsIn(ordinary));
    expect(await markReadGraphsDirtyAtStart(store)).toBe(1);
    for (const graph of [notState, ordinary]) expect(await stateValues(store, graph), graph).toEqual(['"ready"', '"ready"']);
    expect(await stateValues(store, STATE)).toEqual(['"dirty"']);
    // A store whose only rows are outside every such state graph holds no read graphs.
    const plain = await storeWithRows();
    await readGraphPartitionMaintenanceStore(plain).insert(rowsIn(notState));
    const dir = await dataDir();
    expect(await markReadGraphsDirtyAtStart(plain, { dataDir: dir })).toBe(0);
    expect(mayHoldReadGraphPartitions(dir)).toBe(false);
    expect(storeMayHoldReadGraphPartitions(plain)).toBe(false);
  });

  it('keeps each damaged row\'s removal and new row in one request', async () => {
    const graphs = Array.from({ length: 100 }, (_, index) =>
      readGraphIri({ scope: readScope(`damaged-${index}`), layer: MemoryLayer.VerifiableMemory }));
    const store = await storeWithRows(...graphs.map(graph => row(graph, 'ready', 1)));
    const adapter = readGraphPartitionMaintenanceStore(store);
    // A copy in another context graph's state graph damages each row: two removals and a new row apiece.
    await adapter.insert(graphs.map(graph => ({
      graph: readGraphStateGraphIri('elsewhere'), subject: graph, predicate: READ_GRAPH_STATE_PREDICATES.state, object: '"ready"',
    })));
    const update = vi.spyOn(adapter, 'update');
    expect(await markReadGraphsDirtyAtStart(store)).toBe(100);
    expect(update).toHaveBeenCalledTimes(2);
    for (const [request] of update.mock.calls) {
      expect((request.match(/^DELETE \{/gm) ?? []).length).toBe(2 * (request.match(/^INSERT \{/gm) ?? []).length);
    }
    const after = await rows(store);
    expect(after.damaged).toEqual([]);
    // Every row is back, each dirty at a new generation of its own.
    expect(after.rows.map(({ readGraph, state }) => `${readGraph} ${state}`).sort()).toEqual(graphs.map(graph => `${graph} dirty`).sort());
    expect(await stateValues(store, readGraphStateGraphIri('elsewhere'))).toEqual([]);
  });

  it('marks many read graphs in bounded requests', async () => {
    const graphs = Array.from({ length: 1_001 }, (_, index) =>
      readGraphIri({ scope: readScope(`many-${index}`), layer: MemoryLayer.VerifiableMemory }));
    const store = await storeWithRows(...graphs.map(graph => row(graph, 'ready', 1)));
    const update = vi.spyOn(readGraphPartitionMaintenanceStore(store), 'update');
    expect(await markReadGraphsDirtyAtStart(store)).toBe(1_001);
    expect(update).toHaveBeenCalledTimes(2);
    const after = await rows(store);
    expect(after.damaged).toEqual([]);
    expect(after.rows.sort(byGraph)).toEqual(graphs.map(graph => row(graph, 'dirty', 2)).sort(byGraph));
  });

  it('runs below the partition guard', async () => {
    const adapter = new OxigraphStore();
    opened.push(adapter);
    await adapter.update(readGraphStateCompareAndSet(undefined, row(VM, 'ready', 1)));
    expect(await markReadGraphsDirtyAtStart(adapter)).toBe(1);
    expect((await rows(adapter)).rows).toEqual([row(VM, 'dirty', 2)]);
  });

  it('refuses an answer that is not a list of rows, and a store that cannot update', async () => {
    const adapter = new OxigraphStore();
    opened.push(adapter);
    const lookup = adapter.query.bind(adapter);
    adapter.query = async () => ({ type: 'boolean', value: true });
    await expect(markReadGraphsDirtyAtStart(adapter)).rejects.toThrow('expected state-row bindings');
    await adapter.update(readGraphStateCompareAndSet(undefined, row(VM, 'ready', 1)));
    adapter.query = lookup;
    const readOnly = { query: lookup } as unknown as TripleStore;
    await expect(markReadGraphsDirtyAtStart(readOnly)).rejects.toThrow('has no update()');
  });
});
