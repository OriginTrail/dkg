import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryLayer, readGraphIri, readGraphStateGraphIri, readScope } from '@origintrail-official/dkg-core';
import { createTripleStore, OxigraphStore, type TripleStore } from '../src/index.js';
import { readGraphPartitionMaintenanceStore } from '../src/read-graph-partition-store.js';
import { markReadGraphsDirtyAtStart } from '../src/read-graph-partition-startup.js';
import { mayHoldReadGraphPartitions } from '../src/read-graph-partition-marker.js';
import {
  CURRENT_READ_GRAPH_VERSIONS,
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
    expect(await markReadGraphsDirtyAtStart(store, { dataDir: dir })).toBe(2);
    expect(mayHoldReadGraphPartitions(dir)).toBe(true);
    const after = await rows(store);
    expect(after.damaged).toEqual([]);
    expect(after.rows.sort(byGraph)).toEqual([row(VM, 'dirty', 6), row(SWM, 'dirty', 9), row(CODE, 'dirty', 4)].sort(byGraph));
    expect(await markReadGraphsDirtyAtStart(store, { dataDir: dir })).toBe(0);
  });

  it('changes nothing and notes nothing on a store without read-graph state', async () => {
    const store = await storeWithRows();
    const dir = await dataDir();
    expect(await markReadGraphsDirtyAtStart(store, { dataDir: dir })).toBe(0);
    expect(mayHoldReadGraphPartitions(dir)).toBe(false);
  });

  it('leaves no ready state behind a damaged row', async () => {
    const store = await storeWithRows(row(VM, 'ready', 5));
    // A row that holds a second state is damaged; its ready value must still go.
    await readGraphPartitionMaintenanceStore(store).insert([
      { graph: STATE, subject: VM, predicate: READ_GRAPH_STATE_PREDICATES.state, object: '"building"' },
    ]);
    expect((await rows(store)).damaged).toEqual([VM]);
    expect(await markReadGraphsDirtyAtStart(store)).toBe(1);
    expect(await anyReady(store)).toBe(false);
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
