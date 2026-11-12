import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, readGraphIri, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { mayHoldReadGraphPartitions } from '../src/read-graph-partition-marker.js';
import { missingReadGraphMethods } from '../src/read-graph/adapter-contract.js';
import { guardReadGraphPartition, storeMayHoldReadGraphPartitions } from '../src/read-graph-partition-store.js';
import { ReadGraphBuilder } from '../src/read-graph/builder.js';
import { checkReadGraph, memberGraphListingQuery } from '../src/read-graph/check.js';
import {
  clearUnstoredReadGraphMarks,
  noteUnstoredReadGraphMark,
  readGraphMarkJournalPath,
  readUnstoredReadGraphMarks,
  unstoredReadGraphMarksText,
  useReadGraphMarkJournal,
} from '../src/read-graph/mark-journal.js';
import { matchesGraphNameTest, readGraphEnumerationRoots, readGraphMembership, type GraphNameTest } from '../src/read-graph/membership.js';
import { readGraphLayerOf, wrapReadGraphLayer, type ReadGraphStore } from '../src/read-graph/read-graph-store.js';
import {
  buildReadGraph,
  refreshReadGraphRegistry,
  markReadGraphDirty,
  removeReadGraph,
  repairReadGraph,
  ReadGraphJobError,
  type ReadGraphJobContext,
} from '../src/read-graph/rebuild.js';
import { withReadGraphBackgroundSlot } from '../src/read-graph/background-slot.js';
import { readStoredReadGraphRow } from '../src/read-graph/stored-states.js';
import { readReadGraphRegistry } from '../src/read-graph/registry.js';
import { fenceReadGraphs, liftReadGraphFences } from '../src/read-graph/registry-fences.js';
import {
  parseReadGraphRegistryRecords,
  readGraphRegistryRecordsQuery,
  readGraphRegistryRecordUpdate,
  recordReadGraphRegistry,
} from '../src/read-graph/registry-record.js';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  MAX_READ_GRAPH_GENERATION,
  READ_GRAPH_STATE_PREDICATES,
  parseReadGraphStateRows,
  readGraphStateCompareAndSet,
  readGraphStateMarkDirtyAtStart,
  readGraphStateRowQuery,
  readGraphStateRowsQuery,
  servingReadGraphGeneration,
  type ReadGraphStateRow,
} from '../src/read-graph/state.js';
import { readGraphBackfillBatch, readGraphFencedDrop, readGraphHoldsTripleAsk } from '../src/read-graph/statements.js';
import { startReadGraphs, type ReadGraphStartOptions } from '../src/read-graph/startup.js';
import {
  READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE,
  installWorkingMemoryIdentity,
  recordedWorkingMemoryIdentity,
} from '../src/read-graph/working-memory-identity.js';
import { noteReadGraphStoreRestored } from '../src/read-graph/store-restored.js';
import { registerStoreRecoveryGeneration } from '../src/store-recovery-generation.js';
import type { Quad, QueryOptions, TripleStore, UpdateOptions } from '../src/triple-store.js';
import { AGENT, isLayerMember, layerFixture, P, q, readyRow, type LayerFixture } from './helpers/read-graph-layer-conformance.js';
import { PlanningOxigraphStore } from './helpers/read-graph-planning-store.js';

/**
 * An adapter that offers only the methods it plans, as an adapter with
 * read-graph support does, and lets a test act on each update before it is
 * sent.
 */
class HookedStore extends PlanningOxigraphStore {
  onUpdate: ((sparql: string, options: UpdateOptions | undefined) => Promise<void> | void) | undefined;
  onInsert: (() => Promise<void>) | undefined;
  onFlush: (() => Promise<void> | void) | undefined;
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
    await this.onInsert?.();
    return super.insert(quads, options);
  }
  override async flush(): Promise<void> {
    await this.onFlush?.();
    return super.flush();
  }
}

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

const IDLE = {
  ackInflight: 0, normalInflight: 0, backgroundInflight: 0, ackQueued: 0, normalQueued: 0, backgroundQueued: 0, maxConcurrent: 4, ackReservedSlots: 0,
};

let sequence = 0;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function open(adapter: TripleStore = new HookedStore()) {
  const fixture = layerFixture(`builder-${sequence += 1}`);
  const layer = wrapReadGraphLayer(adapter, { backend: 'oxigraph' });
  const store = guardReadGraphPartition(layer);
  await adapter.insert([
    ...fixture.facts,
    ...fixture.graphs.flatMap((graph, i) => [q('urn:s:shared', '"both"', graph), q(`urn:s:${i}`, `"v${i}"`, graph)]),
  ]);
  const dataDir = mkdtempSync(join(tmpdir(), 'read-graph-builder-'));
  dirs.push(dataDir);
  const context: ReadGraphJobContext = { store, dataDir, batching: { pauseRatio: 0, graphsPerBatch: 2 } };
  return { adapter: adapter as HookedStore, fixture, layer, store, context, dataDir };
}

async function storedRows(adapter: TripleStore): Promise<Record<string, string>> {
  const result = await adapter.query(readGraphStateRowsQuery());
  const rows = parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []).rows;
  return Object.fromEntries(rows.map((row) => [row.readGraph, `${row.state}@${row.generation}`]));
}

async function triplesOf(adapter: TripleStore, graph: string): Promise<string[]> {
  const result = await adapter.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  return (result.type === 'bindings' ? result.bindings : []).map((b) => `${b.s} ${b.p} ${b.o}`).sort();
}

/** The read graph of `key` holds exactly the union of its member graphs. */
async function expectUnion(adapter: TripleStore, layer: ReadGraphStore, fixture: LayerFixture, key: ReadGraphKey): Promise<void> {
  const result = await adapter.query(`SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${fixture.root}")) }`);
  const quads = result.type === 'bindings' ? result.bindings : [];
  const triple = (b: Record<string, string>) => `${b.s} ${b.p} ${b.o}`;
  const expected = [...new Set(quads.filter((b) => isLayerMember(layer, fixture, key, b.g!)).map(triple))].sort();
  expect(await triplesOf(adapter, readGraphIri(key))).toEqual(expected);
}

const row = (readGraph: string, state: ReadGraphStateRow['state'], generation: number): ReadGraphStateRow => ({ ...readyRow(readGraph, generation), state });

async function storedRecords(adapter: TripleStore) {
  const result = await adapter.query(readGraphRegistryRecordsQuery());
  return parseReadGraphRegistryRecords(result.type === 'bindings' ? result.bindings : []);
}

/** The read graph of `key` holds exactly the union of its member graphs under the registry the store holds now. */
async function expectCurrentUnion(adapter: TripleStore, layer: ReadGraphStore, fixture: LayerFixture, key: ReadGraphKey): Promise<void> {
  const membership = readGraphMembership(key, await readReadGraphRegistry(adapter, fixture.contextGraphId), layer.runtime.workingMemoryIdentity);
  const result = await adapter.query(`SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${fixture.root}")) }`);
  const quads = result.type === 'bindings' ? result.bindings : [];
  const triple = (b: Record<string, string>) => `${b.s} ${b.p} ${b.o}`;
  const expected = [...new Set(quads.filter((b) => matchesGraphNameTest(membership, b.g!)).map(triple))].sort();
  expect(await triplesOf(adapter, readGraphIri(key))).toEqual(expected);
}

const SUB_GRAPH_TYPE = (fixture: LayerFixture, name: string) =>
  `<${fixture.root}/${name}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/SubGraph>`;

describe('read-graph state and statements for builds', () => {
  it('reads one row, and a damaged or misplaced one as damaged', async () => {
    const { adapter, fixture } = await open();
    const { wholeVm, wholeSwm } = fixture.readGraphs;
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(wholeVm, 7)));
    expect(await readStoredReadGraphRow(adapter, wholeVm)).toEqual({ row: readyRow(wholeVm, 7), damaged: false });
    expect(await readStoredReadGraphRow(adapter, wholeSwm)).toEqual({ row: undefined, damaged: false });
    await adapter.insert([{ subject: wholeVm, predicate: 'http://dkg.io/ontology/readGraphGeneration', object: '"8"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: `${fixture.root}/_~read/state` }]);
    expect(await readStoredReadGraphRow(adapter, wholeVm)).toEqual({ row: undefined, damaged: true });
    expect(() => readGraphStateRowQuery(`${fixture.root}/not-a-read-graph`)).toThrow(/Not a read-graph IRI/);
  });

  it('marks listed rows dirty at start with the next generation, in any state, and leaves others', async () => {
    const { adapter, fixture } = await open();
    const { wholeVm, wholeSwm, codeVm, agentWm } = fixture.readGraphs;
    await adapter.update!([
      readGraphStateCompareAndSet(undefined, readyRow(wholeVm, 3)),
      readGraphStateCompareAndSet(undefined, row(wholeSwm, 'dirty', 5)),
      readGraphStateCompareAndSet(undefined, row(codeVm, 'rebuilding', 9)),
      readGraphStateCompareAndSet(undefined, readyRow(agentWm, 11)),
    ].join(';\n'));
    await adapter.update!(readGraphStateMarkDirtyAtStart([wholeVm, wholeSwm, codeVm, wholeVm]));
    expect(await storedRows(adapter)).toEqual({ [wholeVm]: 'dirty@4', [wholeSwm]: 'dirty@6', [codeVm]: 'dirty@10', [agentWm]: 'ready@11' });
    expect(() => readGraphStateMarkDirtyAtStart([])).toThrow(/at least one/);
  });

  it('records a context graph\'s registry in its state graph, apart from its rows', async () => {
    const { adapter, fixture } = await open();
    const { wholeVm } = fixture.readGraphs;
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(wholeVm, 3)));
    await adapter.update!(readGraphRegistryRecordUpdate(fixture.registry));
    expect(await storedRecords(adapter)).toEqual(new Map([[fixture.contextGraphId, fixture.registry]]));
    // A row read takes the record for no row, and a new record replaces the old one.
    expect(await storedRows(adapter)).toEqual({ [wholeVm]: 'ready@3' });
    const later = { ...fixture.registry, subGraphNames: ['code', 'docs'] };
    await adapter.update!(readGraphRegistryRecordUpdate(later));
    expect(await storedRecords(adapter)).toEqual(new Map([[fixture.contextGraphId, later]]));
    // Two records, or one that does not parse, give none to trust.
    const stateGraph = `${fixture.root}/_~read/state`;
    await adapter.insert([{ subject: stateGraph, predicate: 'http://dkg.io/ontology/readGraphRegistry', object: '"v1"', graph: stateGraph }]);
    expect(await storedRecords(adapter)).toEqual(new Map([[fixture.contextGraphId, undefined]]));
    await adapter.update!(readGraphRegistryRecordUpdate(fixture.registry));
    await adapter.update!(`DELETE WHERE { GRAPH <${stateGraph}> { <${stateGraph}> <http://dkg.io/ontology/readGraphRegistry> ?o } };
INSERT DATA { GRAPH <${stateGraph}> { <${stateGraph}> <http://dkg.io/ontology/readGraphRegistry> "v2 sub:code" } }`);
    expect(await storedRecords(adapter)).toEqual(new Map([[fixture.contextGraphId, undefined]]));
  });

  it('records no registry it cannot carry, and trusts no record it cannot read', async () => {
    const { fixture, layer } = await open();
    const stateGraph = `${fixture.root}/_~read/state`;
    // A name with a space, or a root with one, cannot be carried: the record is only removed.
    for (const snapshot of [{ ...fixture.registry, subGraphNames: ['two words'] }, { ...fixture.registry, childContextGraphRoots: [`${fixture.root}/a b`] }]) {
      expect(readGraphRegistryRecordUpdate(snapshot)).not.toContain('INSERT');
    }
    const records = parseReadGraphRegistryRecords([
      { stateGraph, record: '"v1 sub:code"@en' },
      { stateGraph: 'urn:not:a:state:graph', record: '"v1"' },
      { stateGraph: 'did:dkg:context-graph:_reserved/_~read/state', record: '"v1"' },
      { stateGraph: `${fixture.root}-other/_~read/state`, record: '"v1 sub:code other:x"' },
      { stateGraph: `${fixture.root}-third/_~read/state` },
    ]);
    expect(records).toEqual(new Map([[fixture.contextGraphId, undefined], [`${fixture.contextGraphId}-other`, undefined]]));
    await expect(recordReadGraphRegistry({ query: async () => ({ type: 'bindings', bindings: [] }) } as unknown as TripleStore, layer.runtime, fixture.registry))
      .rejects.toThrow(/no update\(\)/);
  });

  it('reads only well-formed marks from the journal, and notes none it cannot write', async () => {
    const { fixture, layer, dataDir } = await open();
    const { wholeVm, codeVm } = fixture.readGraphs;
    writeFileSync(readGraphMarkJournalPath(dataDir), `3 ${wholeVm}\nnot a line\nx ${codeVm}\n4 ${wholeVm}\n5 urn:not:a:read:graph\n6 ${codeVm} extra\n`);
    expect(readUnstoredReadGraphMarks(dataDir)).toEqual(new Map([[wholeVm, new Set([3, 4])]]));
    clearUnstoredReadGraphMarks(dataDir);
    expect(readUnstoredReadGraphMarks(dataDir)).toEqual(new Map());
    // A data directory that cannot be written keeps nothing, and the mark goes on.
    useReadGraphMarkJournal(layer.runtime, join(dataDir, 'missing'));
    expect(() => noteUnstoredReadGraphMark(layer.runtime, wholeVm, 7)).not.toThrow();
    expect(readUnstoredReadGraphMarks(join(dataDir, 'missing'))).toEqual(new Map());
  });

  it('asks whether a read graph holds a triple', async () => {
    const { adapter, fixture } = await open();
    const ask = async () => (await adapter.query(readGraphHoldsTripleAsk(fixture.readGraphs.wholeVm))) as { value: boolean };
    expect((await ask()).value).toBe(false);
    await adapter.insert([q('urn:s:x', '"x"', fixture.readGraphs.wholeVm)]);
    expect((await ask()).value).toBe(true);
  });

  it('lists the names a membership can hold', () => {
    const fixture = layerFixture('roots');
    const registry = fixture.registry;
    const identity = { ownerOf: (address: string) => address, addressesOf: (address: string) => [address] };
    const roots = (key: ReadGraphKey) => readGraphEnumerationRoots(readGraphMembership(key, registry, identity));
    const [wholeVm, wholeSwm, codeVm, agentWm] = fixture.keys as [ReadGraphKey, ReadGraphKey, ReadGraphKey, ReadGraphKey];
    expect(roots(wholeVm)).toEqual({
      iris: [fixture.root, `${fixture.root}/code`],
      prefixes: [`${fixture.root}/_verifiable_memory/`, `${fixture.root}/code/_verifiable_memory/`, `${fixture.root}/context/`],
    });
    expect(roots(wholeSwm)).toEqual({
      iris: [`${fixture.root}/_shared_memory`, `${fixture.root}/code/_shared_memory`],
      prefixes: [`${fixture.root}/_shared_memory/`, `${fixture.root}/code/_shared_memory/`],
    });
    expect(roots(codeVm)).toEqual({ iris: [`${fixture.root}/code`], prefixes: [`${fixture.root}/code/_verifiable_memory/`] });
    expect(roots(agentWm)?.prefixes).toEqual([
      `${fixture.root}/_working_memory/`, `${fixture.root}/assertion/`, `${fixture.root}/code/_working_memory/`, `${fixture.root}/code/assertion/`,
    ]);
    expect(roots({ scope: readScope('roots', 'unregistered'), layer: MemoryLayer.VerifiableMemory })).toEqual({ iris: [], prefixes: [] });
    const nested: GraphNameTest = { kind: 'any', tests: [{ kind: 'prefix', prefix: 'urn:a/' }, { kind: 'prefix', prefix: 'urn:a/b/' }, { kind: 'equals', iri: 'urn:a/b/c' }, { kind: 'equals', iri: 'urn:z' }] };
    expect(readGraphEnumerationRoots(nested)).toEqual({ iris: ['urn:z'], prefixes: ['urn:a/'] });
    expect(readGraphEnumerationRoots({ kind: 'contains', text: 'x' })).toBeUndefined();
    expect(readGraphEnumerationRoots({ kind: 'all', tests: [] })).toBeUndefined();
    expect(readGraphEnumerationRoots({ kind: 'all', tests: [{ kind: 'segment', segment: 'x' }, { kind: 'prefix', prefix: 'urn:p/' }] })).toEqual({ iris: [], prefixes: ['urn:p/'] });
  });
});

describe('building a read graph', () => {
  it('creates a read graph with no row, fenced, and publishes it ready at the generation it started with', async () => {
    const { adapter, fixture, layer, context, dataDir } = await open();
    const [key] = fixture.keys as [ReadGraphKey];
    const readGraph = readGraphIri(key);
    // Leftovers of an interrupted removal: a read graph without a row that still holds a triple.
    await adapter.insert([q('urn:s:stale', '"stale"', readGraph)]);
    adapter.requests.length = 0;
    const result = await buildReadGraph(context, key);
    expect(result).toMatchObject({ readGraph, kind: 'build', outcome: 'done', row: { state: 'ready' } });
    expect(result.batches).toBeGreaterThan(1);
    await expectUnion(adapter, layer, fixture, key);
    expect(layer.runtime.mirror.get(readGraph)).toEqual(result.row);
    const operations = adapter.requests.filter((request) => request.includes(`GRAPH <${readGraph}> { ?s ?p ?o }`));
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) expect(operation).toContain('readGraphFence');
    const created = adapter.requests.find((request) => request.startsWith('INSERT {') && request.includes('"building"'));
    expect(created).toContain(`${result.row!.generation} .`);
    expect(mayHoldReadGraphPartitions(dataDir)).toBe(true);
    expect(storeMayHoldReadGraphPartitions(adapter)).toBe(true);
    // A ready row under accepted versions is left as it is.
    adapter.requests.length = 0;
    expect(await buildReadGraph(context, key)).toMatchObject({ outcome: 'current', batches: 0 });
    expect(adapter.requests).toEqual([]);
  });

  it('puts ready in the mirror only once the stored row reads back ready, and not when that read fails', async () => {
    const { adapter, fixture, layer, context } = await open();
    const [key] = fixture.keys as [ReadGraphKey];
    const readGraph = readGraphIri(key);
    // A compare-and-set that writes `ready`: its INSERT line names the state, where a mark's DELETE line names it.
    const publishing = `<${readGraph}> <${READ_GRAPH_STATE_PREDICATES.state}> "ready"`;
    const publishes = (sparql: string) => sparql.split('\n').some((line) => line.startsWith('INSERT {') && line.includes(publishing));
    const seen: string[] = [];
    let armed = true;
    let failReadBack = false;
    adapter.onUpdate = (sparql) => {
      if (!publishes(sparql)) return;
      seen.push(layer.runtime.mirror.get(readGraph)?.state ?? 'absent');
      // Only the first publication's read-back fails.
      failReadBack = armed;
      armed = false;
    };
    const query = adapter.query.bind(adapter);
    adapter.query = async (sparql, options) => {
      if (failReadBack && sparql === readGraphStateRowQuery(readGraph)) {
        failReadBack = false;
        throw new Error('connection reset');
      }
      return query(sparql, options);
    };
    await expect(buildReadGraph(context, key)).rejects.toThrow('connection reset');
    // The compare-and-set went out while the mirror still said building, and the mirror never took ready.
    expect(seen).toEqual(['building']);
    expect((await readStoredReadGraphRow(adapter, readGraph)).row?.state).toBe('ready');
    expect(layer.runtime.mirror.get(readGraph)?.state).toBe('building');
    // The next build finds the stored row and the mirror apart, marks the row dirty and builds it again.
    expect(await buildReadGraph(context, key)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    expect(seen).toEqual(['building', 'rebuilding']);
    expect(layer.runtime.mirror.get(readGraph)?.state).toBe('ready');
    await expectUnion(adapter, layer, fixture, key);
  });

  it('notes that the store may hold read-graph partitions before its first registry record exists', async () => {
    const { adapter, fixture, context, dataDir } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    expect(mayHoldReadGraphPartitions(dataDir)).toBe(false);
    let seen: { readonly records: number; readonly note: boolean; readonly marker: boolean } | undefined;
    const update = adapter.update.bind(adapter);
    adapter.update = async (sparql, options) => {
      await update(sparql, options);
      if (seen !== undefined || !sparql.includes('<http://dkg.io/ontology/readGraphRegistry>')) return;
      // Right after the first record, before any row exists: unscoped reads leave the partition out by these
      // markers, and a restart with read graphs off by the data directory's note.
      seen = { records: (await storedRecords(adapter)).size, note: mayHoldReadGraphPartitions(dataDir), marker: storeMayHoldReadGraphPartitions(adapter) };
    };
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done' });
    expect(seen).toEqual({ records: 1, note: true, marker: true });
  });

  it('records the registry it builds under, and the one a later refresh takes', async () => {
    const { adapter, fixture, store, context } = await open();
    const [key] = fixture.keys as [ReadGraphKey];
    expect(await buildReadGraph(context, key)).toMatchObject({ outcome: 'done' });
    expect(await storedRecords(adapter)).toEqual(new Map([[fixture.contextGraphId, fixture.registry]]));
    // A registration through the layer, which marks what it moves; the next refresh records the registry it leaves.
    const docs = `${fixture.root}/docs`;
    await store.insert([
      { subject: docs, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${fixture.root}/_meta` },
      { subject: docs, predicate: 'http://schema.org/name', object: '"docs"', graph: `${fixture.root}/_meta` },
    ]);
    expect(await refreshReadGraphRegistry(context, fixture.contextGraphId)).toBe(false);
    expect(await storedRecords(adapter)).toEqual(new Map([[fixture.contextGraphId, { ...fixture.registry, subGraphNames: ['code', 'docs'] }]]));
  });

  it('rebuilds a dirty read graph, an abandoned build, and a row under versions this release does not accept', async () => {
    const { adapter, fixture, layer, context } = await open();
    const [vm, swm, code] = fixture.keys as [ReadGraphKey, ReadGraphKey, ReadGraphKey];
    const rows = [row(readGraphIri(vm), 'dirty', 4), row(readGraphIri(swm), 'rebuilding', 6), { ...readyRow(readGraphIri(code), 8), builderVersion: 99 }];
    for (const stored of rows) {
      await adapter.update!(readGraphStateCompareAndSet(undefined, stored));
      layer.runtime.mirror.set(stored);
      await adapter.insert([q('urn:s:gone', '"gone"', stored.readGraph)]);
    }
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready', generation: 5 } });
    expect(await buildReadGraph(context, swm)).toMatchObject({ outcome: 'done', row: { state: 'ready', generation: 8 } });
    expect(await buildReadGraph(context, code)).toMatchObject({ outcome: 'done', row: { state: 'ready', generation: 10, builderVersion: CURRENT_READ_GRAPH_VERSIONS.builderVersion } });
    for (const key of [vm, swm, code]) await expectUnion(adapter, layer, fixture, key);
  });

  it('marks a stored row the mirror does not hold dirty before it plans, and replaces a damaged row', async () => {
    const { adapter, fixture, layer, context } = await open();
    const [vm, swm] = fixture.keys as [ReadGraphKey, ReadGraphKey];
    const { wholeVm, wholeSwm } = fixture.readGraphs;
    // The stored row is ready, but nothing maintained it: the mirror has none.
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(wholeVm, 20)));
    await adapter.insert([q('urn:s:unmaintained', '"u"', wholeVm)]);
    const rebuilt = await buildReadGraph(context, vm);
    expect(rebuilt).toMatchObject({ outcome: 'done', row: { state: 'ready', generation: 22 } });
    await expectUnion(adapter, layer, fixture, vm);
    // A row with two generations is damaged.
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(wholeSwm, 3)));
    await adapter.insert([{ subject: wholeSwm, predicate: 'http://dkg.io/ontology/readGraphGeneration', object: '"4"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: `${fixture.root}/_~read/state` }]);
    expect(await buildReadGraph(context, swm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    expect((await readStoredReadGraphRow(adapter, wholeSwm)).damaged).toBe(false);
    await expectUnion(adapter, layer, fixture, swm);
  });

  it('waits for writes that were in flight before its row existed', async () => {
    const { adapter, fixture, layer, store, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    adapter.onInsert = () => held;
    const write = store.insert([q('urn:s:late', '"late"', fixture.graphs[1]!)]);
    adapter.onInsert = undefined;
    let finished = false;
    const job = buildReadGraph(context, vm).then((result) => { finished = true; return result; });
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(layer.runtime.mirror.get(fixture.readGraphs.wholeVm)?.state).toBe('building');
    release();
    await write;
    expect(await job).toMatchObject({ outcome: 'done' });
    expect(await triplesOf(adapter, fixture.readGraphs.wholeVm)).toContain(`urn:s:late ${P} "late"`);
    await expectUnion(adapter, layer, fixture, vm);
  });

  it('reads the registry again once earlier writes end, so a registration they removed ends the build before it copies', async () => {
    const { adapter, fixture, layer, store, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const unregistering = `DELETE DATA { GRAPH <${fixture.root}/_meta> { ${SUB_GRAPH_TYPE(fixture, 'code')} } }`;
    adapter.onUpdate = (sparql) => (sparql === unregistering ? held : undefined);
    // With no row yet, the unregistration passes the registry by, and the build reads the registry from before it.
    const write = store.update!(unregistering, { writtenGraphs: [`${fixture.root}/_meta`] });
    const job = buildReadGraph(context, vm);
    await vi.waitFor(() => expect(layer.runtime.mirror.get(wholeVm)?.state).toBe('building'));
    release();
    await write;
    expect(await job).toMatchObject({ outcome: 'lost' });
    expect(layer.runtime.mirror.get(wholeVm)?.state).toBe('dirty');
    expect(await triplesOf(adapter, wholeVm)).toEqual([]);
    // The next build takes the registry the store holds.
    adapter.onUpdate = undefined;
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    await expectCurrentUnion(adapter, layer, fixture, vm);
  });

  it('takes a child registration that completed before its first row existed, and publishes nothing under the registry from before it', async () => {
    const { adapter, fixture, layer, store, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    const child = `${fixture.root}/code`;
    let armed = true;
    adapter.onUpdate = async (sparql) => {
      // The build has read the registry and records it; no row exists yet. The registration passes the registry by.
      if (!armed || !sparql.includes('<http://dkg.io/ontology/readGraphRegistry>')) return;
      armed = false;
      await store.insert([{ subject: child, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://dkg.network/ontology#ContextGraph', graph: `${child}/_meta` }]);
    };
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'lost' });
    expect(armed).toBe(false);
    expect(layer.runtime.mirror.get(wholeVm)?.state).toBe('dirty');
    expect(await triplesOf(adapter, wholeVm)).toEqual([]);
    adapter.onUpdate = undefined;
    // The next build follows the registry that holds the child: its data is no member of the parent's read graph.
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    expect((await triplesOf(adapter, wholeVm)).filter((triple) => triple.includes('"v4"'))).toEqual([]);
    await expectCurrentUnion(adapter, layer, fixture, vm);
  });

  it('keeps the read graph equal to its members across writes during the backfill', async () => {
    const { adapter, fixture, layer, store, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    const writes: Promise<void>[] = [];
    let batches = 0;
    let copied = false;
    let deleted = false;
    const first = fixture.graphs[1]!;
    adapter.onUpdate = (sparql) => {
      if (!sparql.includes('VALUES ?g')) return;
      batches += 1;
      const graph = fixture.graphs[batches % 3]!;
      // Each write waits for the lock this batch holds, and lands before the next batch.
      writes.push(store.insert([q(`urn:s:during-${batches}`, '"d"', graph)]));
      writes.push(store.delete([q('urn:s:shared', '"both"', fixture.graphs[2]!)]));
      // Once a member is copied, a delete of a triple only it holds has to leave the read graph.
      if (copied && !deleted) {
        deleted = true;
        writes.push(store.delete([q('urn:s:1', '"v1"', first)]));
      }
      if (sparql.includes(`<${first}>`)) copied = true;
    };
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done' });
    await Promise.all(writes);
    expect(batches).toBeGreaterThan(1);
    expect(deleted).toBe(true);
    expect(await triplesOf(adapter, fixture.readGraphs.wholeVm)).not.toContain(`urn:s:1 ${P} "v1"`);
    await expectUnion(adapter, layer, fixture, vm);
  });

  it('takes a registry that changed since it was cached, and marks the read graphs built under the old one dirty first', async () => {
    const { adapter, fixture, layer, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done' });
    const before = layer.runtime.mirror.get(fixture.readGraphs.wholeVm)!;
    // A sub-graph registered after the snapshot was cached, with data of its own.
    const docs = `${fixture.root}/docs`;
    await adapter.insert([
      { subject: docs, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${fixture.root}/_meta` },
      { subject: docs, predicate: 'http://schema.org/name', object: '"docs"', graph: `${fixture.root}/_meta` },
      q('urn:s:docs', '"d"', `${docs}/_verifiable_memory/${AGENT}/9`),
    ]);
    const docsVm: ReadGraphKey = { scope: readScope(fixture.contextGraphId, 'docs'), layer: MemoryLayer.VerifiableMemory };
    expect(await buildReadGraph(context, docsVm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    expect(await triplesOf(adapter, readGraphIri(docsVm))).toEqual([`urn:s:docs ${P} "d"`]);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
    // The whole graph's read graph was maintained under the old membership: dirty, then rebuilt with the sub-graph.
    expect(layer.runtime.mirror.get(fixture.readGraphs.wholeVm)).toMatchObject({ state: 'dirty', generation: before.generation + 1 });
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done' });
    expect(await triplesOf(adapter, fixture.readGraphs.wholeVm)).toContain(`urn:s:docs ${P} "d"`);
  });

  it('measures a full check against the registry the store holds, so a registration made past the layer is not certified', async () => {
    const { adapter, fixture, layer, store, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    const { wholeVm } = fixture.readGraphs;
    // A sub-graph registered past the layer, with data of its own, before the next builder pass refreshes the registry.
    const docs = `${fixture.root}/docs`;
    await adapter.insert([
      { subject: docs, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${fixture.root}/_meta` },
      { subject: docs, predicate: 'http://schema.org/name', object: '"docs"', graph: `${fixture.root}/_meta` },
      q('urn:s:docs', '"d"', `${docs}/_verifiable_memory/${AGENT}/9`),
    ]);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code']);
    expect(await checkReadGraph(store, wholeVm, 'full', { alert: () => undefined })).toMatchObject({ outcome: 'mismatch', direction: 'missing' });
    expect(servingReadGraphGeneration(layer.runtime.mirror.get(wholeVm))).toBeUndefined();
  });

  it('takes every read graph a registry change moves out of service before it sends a mark, so one the store refuses leaves none serving', async () => {
    const { adapter, fixture, layer, context } = await open();
    const [vm, swm] = fixture.keys as [ReadGraphKey, ReadGraphKey];
    for (const key of [vm, swm]) expect(await buildReadGraph(context, key)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    const { wholeVm, wholeSwm } = fixture.readGraphs;
    // A sub-graph registered past the layer moves the membership of both.
    const docs = `${fixture.root}/docs`;
    await adapter.insert([
      { subject: docs, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${fixture.root}/_meta` },
      { subject: docs, predicate: 'http://schema.org/name', object: '"docs"', graph: `${fixture.root}/_meta` },
    ]);
    let refused = 0;
    adapter.onUpdate = (sparql) => {
      if (refused === 0 && sparql.includes('"dirty"')) {
        refused += 1;
        throw new Error('connection reset');
      }
    };
    await expect(refreshReadGraphRegistry(context, fixture.contextGraphId)).rejects.toThrow('connection reset');
    adapter.onUpdate = undefined;
    for (const readGraph of [wholeVm, wholeSwm]) expect(servingReadGraphGeneration(layer.runtime.mirror.get(readGraph))).toBeUndefined();
    // The cache keeps the registry the marks were measured against: the next refresh marks again, and takes the new one.
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code']);
    expect(await refreshReadGraphRegistry(context, fixture.contextGraphId)).toBe(true);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
  });

  it('takes the facts a refresh reads when the membership stays the same, so a later exact delete is predicted from them', async () => {
    const { adapter, fixture, layer, store, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    const meta = `${fixture.root}/_meta`;
    const type = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const subGraph = 'http://dkg.io/ontology/SubGraph';
    // A second subject registers `code` too.
    await adapter.insert([
      { subject: 'urn:sub:b', predicate: type, object: subGraph, graph: meta },
      { subject: 'urn:sub:b', predicate: 'http://schema.org/name', object: '"code"', graph: meta },
    ]);
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    // A writer outside the layer removes the first registration; `code` stays registered by the second.
    await adapter.update(`DELETE DATA { GRAPH <${meta}> { ${SUB_GRAPH_TYPE(fixture, 'code')} } }`);
    expect(await refreshReadGraphRegistry(context, fixture.contextGraphId)).toBe(false);
    expect(layer.runtime.registries.facts(fixture.contextGraphId)?.some((fact) => fact.subject === `${fixture.root}/code` && fact.predicate === type)).toBe(false);
    // Removing the second, through the layer, now ends the registration: the read graph is marked before it is sent.
    await store.delete([{ subject: 'urn:sub:b', predicate: type, object: subGraph, graph: meta }]);
    expect(layer.runtime.mirror.get(fixture.readGraphs.wholeVm)?.state).toBe('dirty');
    expect((await storedRows(adapter))[fixture.readGraphs.wholeVm]).toMatch(/^dirty@/);
  });

  it('reads the registry again when a write through the layer changed the cached one while the refresh read it', async () => {
    const { adapter, fixture, layer, store, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done' });
    const meta = `${fixture.root}/_meta`;
    const docs = `${fixture.root}/docs`;
    const query = adapter.query.bind(adapter);
    let reads = 0;
    adapter.query = async (sparql, options) => {
      const result = await query(sparql, options);
      // The refresh's first read answers only after a registration through the layer has updated the cached registry.
      if (options?.source === 'storage.readGraphRegistry' && (reads += 1) === 1) {
        await store.insert([
          { subject: docs, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: meta },
          { subject: docs, predicate: 'http://schema.org/name', object: '"docs"', graph: meta },
        ]);
      }
      return result;
    };
    await refreshReadGraphRegistry(context, fixture.contextGraphId);
    // The older answer is not installed over the registration: the refresh read again.
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
    expect(reads).toBeGreaterThan(2);
  });

  it('takes a sub-graph that becomes a child context graph out of its parent, marked before the registration is sent', async () => {
    const { adapter, fixture, layer, store, context } = await open();
    const [vm, , code] = fixture.keys as [ReadGraphKey, ReadGraphKey, ReadGraphKey];
    for (const key of [vm, code]) expect(await buildReadGraph(context, key)).toMatchObject({ outcome: 'done' });
    const { wholeVm, codeVm } = fixture.readGraphs;
    const child = `${fixture.root}/code`;
    // The sub-graph's member data, in the parent's read graph so far.
    expect(await triplesOf(adapter, wholeVm)).toContain(`urn:s:4 ${P} "v4"`);
    const seen: string[] = [];
    adapter.onInsert = async () => {
      const rows = await storedRows(adapter);
      seen.push(`${rows[wholeVm]} ${rows[codeVm]}`);
    };
    // `code` is registered as a child context graph, in its own `_meta` graph.
    await store.insert([{ subject: child, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://dkg.network/ontology#ContextGraph', graph: `${child}/_meta` }]);
    adapter.onInsert = undefined;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^dirty@\d+ dirty@\d+$/);
    // What the child holds, and what it is written later, reach no read graph of the parent, before or after a rebuild.
    await store.insert([q('urn:s:secret', '"secret"', `${child}/_verifiable_memory/${AGENT}/9`)]);
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    const rebuilt = await triplesOf(adapter, wholeVm);
    expect(rebuilt.filter((triple) => triple.includes('"secret"') || triple.includes('"v4"'))).toEqual([]);
    await expectCurrentUnion(adapter, layer, fixture, vm);
  });

  it('ends without effect when a newer dirty mark overtakes it, and nothing of it lands after a newer ready', async () => {
    const { adapter, fixture, layer, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    const runtime = layer.runtime;
    let marked: Promise<void> | undefined;
    adapter.onUpdate = (sparql) => {
      if (marked || !sparql.includes('VALUES ?g')) return;
      // A dirty mark, as the layer or a check makes one, queued behind the batch's lock hold.
      marked = runtime.locks.withLocks([wholeVm], async () => {
        const current = runtime.mirror.get(wholeVm)!;
        const dirty = { ...current, state: 'dirty' as const, generation: current.generation + 1 };
        runtime.mirror.set(dirty);
        await adapter.update!(readGraphStateCompareAndSet(current, dirty));
      });
    };
    const lost = await buildReadGraph(context, vm);
    await marked;
    expect(lost).toMatchObject({ outcome: 'lost', row: { state: 'dirty' } });
    const overtaken = lost.row!.generation - 1;
    expect(runtime.mirror.get(wholeVm)).toEqual(lost.row);
    adapter.onUpdate = undefined;
    const done = await buildReadGraph(context, vm);
    expect(done).toMatchObject({ outcome: 'done', row: { state: 'ready', generation: lost.row!.generation + 1 } });
    const before = await triplesOf(adapter, wholeVm);
    // Operations of the overtaken build land late: a copy of a graph that is no member, and a drop.
    const stale = { state: 'building' as const, generation: overtaken };
    await adapter.update!(readGraphBackfillBatch(wholeVm, stale, [fixture.graphs[9]!]));
    await adapter.update!(readGraphFencedDrop(wholeVm, stale));
    await adapter.update!(readGraphStateCompareAndSet(row(wholeVm, 'building', overtaken), row(wholeVm, 'ready', overtaken)));
    expect(await triplesOf(adapter, wholeVm)).toEqual(before);
    expect(await storedRows(adapter)).toEqual({ [wholeVm]: `ready@${done.row!.generation}` });
    await expectUnion(adapter, layer, fixture, vm);
  });

  it('reports a member graph whose name no operation can carry, and leaves the read graph out of service', async () => {
    const { adapter, fixture, layer, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    // The context graph's listing names a graph the engine itself would refuse.
    const listing = memberGraphListingQuery(adapter, fixture.root);
    const query = adapter.query.bind(adapter);
    adapter.query = async (sparql, options) => {
      const result = await query(sparql, options);
      return result.type === 'bindings' && sparql === listing
        ? { ...result, bindings: [...result.bindings, { g: `${fixture.root}/_verifiable_memory/${AGENT}/a{b` }] }
        : result;
    };
    await expect(buildReadGraph(context, vm)).rejects.toBeInstanceOf(ReadGraphJobError);
    expect(layer.runtime.mirror.get(fixture.readGraphs.wholeVm)?.state).toBe('building');
  });

  it('lists the context graph\'s own graphs on a store without a prefix listing, never the whole store\'s', async () => {
    const { adapter, fixture, layer, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    // A store whose complete list is past its internal limit.
    adapter.listGraphs = async () => { throw new Error('the whole graph list was read'); };
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    await expectUnion(adapter, layer, fixture, vm);
    // The context graph's own list stays under the catalog's internal ceiling.
    vi.stubEnv('DKG_STORE_GRAPH_CATALOG_MAX_BYTES', '64');
    try {
      layer.runtime.mirror.set({ ...layer.runtime.mirror.get(fixture.readGraphs.wholeVm)!, state: 'dirty' });
      await expect(buildReadGraph(context, vm)).rejects.toMatchObject({ code: 'STORE_INTERNAL_LIMIT' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('lists members by prefix where the backend can, pauses between batches, and lets queued foreground work go first', async () => {
    class PrefixStore extends HookedStore {
      readonly prefixes: string[] = [];
      async listGraphsByPrefix(prefix: string, options?: QueryOptions): Promise<string[]> {
        this.prefixes.push(prefix);
        return (await this.listGraphs(options)).filter((graph) => graph.startsWith(prefix));
      }
    }
    const { adapter, fixture, layer, store, context } = await open(new PrefixStore());
    const [vm] = fixture.keys as [ReadGraphKey];
    let queued = 3;
    const pressure = vi.fn(() => ({ ...IDLE, normalQueued: queued > 0 ? queued-- : 0 }));
    Object.assign(store, { getPressureSnapshot: pressure });
    const done = await buildReadGraph({ ...context, batching: { pauseRatio: 1, graphsPerBatch: 1 } }, vm);
    expect(done).toMatchObject({ outcome: 'done' });
    expect((adapter as PrefixStore).prefixes).toEqual([
      `${fixture.root}/_verifiable_memory/`, `${fixture.root}/code/_verifiable_memory/`, `${fixture.root}/context/`,
    ]);
    expect(queued).toBe(0);
    expect(pressure.mock.calls.length).toBeGreaterThan(3);
    await expectUnion(adapter, layer, fixture, vm);
  });

  it('refuses a store without the read-graph layer, or one that cannot update', async () => {
    const plain = new OxigraphStore();
    const [vm] = layerFixture('plain').keys as [ReadGraphKey];
    await expect(buildReadGraph({ store: plain }, vm)).rejects.toThrow(/no read-graph layer/);
    const noUpdate = wrapReadGraphLayer(Object.assign(new HookedStore(), { update: undefined }), { backend: 'oxigraph' });
    await expect(buildReadGraph({ store: noUpdate }, vm)).rejects.toThrow(/no update\(\)/);
    // An adapter that cannot send read-graph operations with its writes gets no read graph to maintain.
    const unable = wrapReadGraphLayer(undeclared(new OxigraphStore()), { backend: 'oxigraph' });
    await expect(buildReadGraph({ store: unable }, vm)).rejects.toThrow(/cannot maintain read graphs/);
    await expect(markReadGraphDirty({ store: unable }, readGraphIri(vm))).rejects.toThrow(/cannot maintain read graphs/);
    expect(unable.runtime.mirror.size).toBe(0);
  });
});

describe('repairing a read graph', () => {
  it('copies the graphs that joined and retracts the intact graphs that left, keeping what another member holds', async () => {
    const { adapter, fixture, layer, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done' });
    const leaving = fixture.graphs[2]!;
    const joined = `${fixture.root}/_verifiable_memory/${AGENT}/joined`;
    await adapter.insert([q('urn:s:joined', '"j"', joined)]);
    const before = readGraphMembership(vm, fixture.registry, layer.runtime.workingMemoryIdentity);
    const membership: GraphNameTest = { kind: 'all', tests: [before, { kind: 'not', test: { kind: 'equals', iri: leaving } }] };
    // Not dirty: the repair does not start.
    expect(await repairReadGraph(context, vm, { joined: [joined], leaving: [leaving], membership })).toMatchObject({ outcome: 'lost', row: { state: 'ready' } });
    await layer.runtime.locks.withLocks([wholeVm], async () => {
      const current = layer.runtime.mirror.get(wholeVm)!;
      const dirty = { ...current, state: 'dirty' as const, generation: current.generation + 1 };
      layer.runtime.mirror.set(dirty);
      await adapter.update!(readGraphStateCompareAndSet(current, dirty));
    });
    const repaired = await repairReadGraph(context, vm, { joined: [joined], leaving: [leaving], membership });
    expect(repaired).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    const held = await triplesOf(adapter, wholeVm);
    expect(held).toContain(`urn:s:joined ${P} "j"`);
    expect(held).not.toContain(`urn:s:2 ${P} "v2"`);
    // Another member holds this triple of the leaving graph.
    expect(held).toContain(`urn:s:shared ${P} "both"`);
    await expect(repairReadGraph(context, vm, { joined: [fixture.graphs[9]!], leaving: [], membership })).rejects.toThrow(/must be a member/);
    await expect(repairReadGraph(context, vm, { joined: [], leaving: [fixture.graphs[1]!], membership })).rejects.toThrow(/must not be a member/);
  });

  it('needs the old contents of a leaving graph: one dropped first takes a full build', async () => {
    const { adapter, fixture, layer, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done' });
    // The read graph is dirty and a graph that left loses its contents before any repair.
    const leaving = fixture.graphs[2]!;
    await layer.runtime.locks.withLocks([wholeVm], async () => {
      const current = layer.runtime.mirror.get(wholeVm)!;
      const dirty = { ...current, state: 'dirty' as const, generation: current.generation + 1 };
      layer.runtime.mirror.set(dirty);
      await adapter.update!(readGraphStateCompareAndSet(current, dirty));
    });
    layer.runtime.mirror.remove(wholeVm);
    await adapter.dropGraph(leaving);
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done' });
    expect(await triplesOf(adapter, wholeVm)).not.toContain(`urn:s:2 ${P} "v2"`);
    await expectUnion(adapter, layer, fixture, vm);
  });

  it('leaves a read graph whose damaged row it had to replace for a full build', async () => {
    const { adapter, fixture, layer, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    await adapter.update!(readGraphStateCompareAndSet(undefined, { ...row(wholeVm, 'dirty', 3), ruleVersion: 99 }));
    await adapter.insert([
      { subject: wholeVm, predicate: 'http://dkg.io/ontology/readGraphGeneration', object: '"4"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: `${fixture.root}/_~read/state` },
      q('urn:s:old', '"built under another rule"', wholeVm),
    ]);
    const membership = readGraphMembership(vm, fixture.registry, layer.runtime.workingMemoryIdentity);
    const repaired = await repairReadGraph(context, vm, { joined: [], leaving: [], membership });
    expect(repaired).toMatchObject({ outcome: 'lost', row: { state: 'dirty', ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion } });
    expect(await triplesOf(adapter, wholeVm)).toEqual([`urn:s:old ${P} "built under another rule"`]);
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done' });
    expect(await triplesOf(adapter, wholeVm)).not.toContain(`urn:s:old ${P} "built under another rule"`);
    await expectUnion(adapter, layer, fixture, vm);
  });

  it('repairs only a row built under the current rule and an accepted builder', async () => {
    const { adapter, fixture, layer, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    const old = { ...row(fixture.readGraphs.wholeVm, 'dirty', 3), ruleVersion: 99 };
    await adapter.update!(readGraphStateCompareAndSet(undefined, old));
    layer.runtime.mirror.set(old);
    const membership = readGraphMembership(vm, fixture.registry, layer.runtime.workingMemoryIdentity);
    expect(await repairReadGraph(context, vm, { joined: [], leaving: [], membership })).toMatchObject({ outcome: 'lost', row: old });
  });
});

describe('marking a read graph dirty', () => {
  it('marks the stored row dirty at the next generation, replaces a damaged one, and leaves an absent one absent', async () => {
    const { adapter, fixture, layer, context } = await open();
    const { wholeVm, wholeSwm, codeVm } = fixture.readGraphs;
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(wholeVm, 4)));
    layer.runtime.mirror.set(readyRow(wholeVm, 4));
    expect(await markReadGraphDirty(context, wholeVm)).toEqual(row(wholeVm, 'dirty', 5));
    expect(layer.runtime.mirror.get(wholeVm)).toEqual(row(wholeVm, 'dirty', 5));
    expect(await markReadGraphDirty(context, wholeVm)).toEqual(row(wholeVm, 'dirty', 6));
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(wholeSwm, 2)));
    await adapter.insert([{ subject: wholeSwm, predicate: 'http://dkg.io/ontology/readGraphGeneration', object: '"3"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: `${fixture.root}/_~read/state` }]);
    expect(await markReadGraphDirty(context, wholeSwm)).toMatchObject({ state: 'dirty' });
    expect((await readStoredReadGraphRow(adapter, wholeSwm)).damaged).toBe(false);
    layer.runtime.mirror.set(readyRow(codeVm, 1));
    expect(await markReadGraphDirty(context, codeVm)).toBeUndefined();
    expect(layer.runtime.mirror.get(codeVm)).toBeUndefined();
    await expect(markReadGraphDirty(context, `${fixture.root}/plain`)).rejects.toThrow(/Not a read-graph IRI/);
  });

  it('keeps a read graph out of service while its dirty mark is not stored, until a build lands', async () => {
    const { adapter, fixture, layer, context, dataDir } = await open();
    const [key] = fixture.keys as [ReadGraphKey];
    const readGraph = readGraphIri(key);
    useReadGraphMarkJournal(layer.runtime, dataDir);
    expect(await buildReadGraph(context, key)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    const built = layer.runtime.mirror.get(readGraph)!;
    // A check found a mismatch and marked the mirror, and its mark did not reach the store.
    layer.runtime.mirror.set({ ...built, state: 'dirty', generation: built.generation + 1 });
    const marking = `<${readGraph}> <${READ_GRAPH_STATE_PREDICATES.state}> "dirty"`;
    let failures = 2;
    adapter.onUpdate = (sparql) => {
      if (failures > 0 && sparql.split('\n').some((line) => line.startsWith('INSERT {') && line.includes(marking))) {
        failures -= 1;
        throw new Error('connection reset');
      }
    };
    // Neither the builder's mark nor a direct one lands: the stored row still says ready, and nothing serves it.
    await expect(buildReadGraph(context, key)).rejects.toThrow('connection reset');
    expect(servingReadGraphGeneration(layer.runtime.mirror.get(readGraph))).toBeUndefined();
    await expect(markReadGraphDirty(context, readGraph)).rejects.toThrow('connection reset');
    expect(layer.runtime.mirror.get(readGraph)?.state).toBe('dirty');
    expect((await readStoredReadGraphRow(adapter, readGraph)).row).toEqual(built);
    // The data directory keeps the mark for a start-up, at the generation the store still holds.
    expect(readUnstoredReadGraphMarks(dataDir)).toEqual(new Map([[readGraph, new Set([built.generation])]]));
    // Once a mark lands, the build rebuilds the read graph, and it serves again.
    expect(await buildReadGraph(context, key)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    expect(servingReadGraphGeneration(layer.runtime.mirror.get(readGraph))).toBe(layer.runtime.mirror.get(readGraph)!.generation);
    await expectUnion(adapter, layer, fixture, key);
  });

  it('keeps the mark for a start-up when neither the dirty mark nor its read-back reaches the store', async () => {
    const { adapter, fixture, layer, context, dataDir } = await open();
    const [key] = fixture.keys as [ReadGraphKey];
    const readGraph = readGraphIri(key);
    useReadGraphMarkJournal(layer.runtime, dataDir);
    const built = (await buildReadGraph(context, key)).row!;
    adapter.onUpdate = (sparql) => { if (sparql.includes('"dirty"')) throw new Error('connection reset'); };
    // The job reads the row, then its mark fails, then the read of what it left fails too.
    let reads = 0;
    const query = adapter.query.bind(adapter);
    adapter.query = async (sparql, options) => {
      if (sparql === readGraphStateRowQuery(readGraph) && (reads += 1) === 2) throw new Error('read timed out');
      return query(sparql, options);
    };
    await expect(markReadGraphDirty(context, readGraph)).rejects.toThrow('read timed out');
    expect(layer.runtime.mirror.get(readGraph)?.state).toBe('dirty');
    expect((await readStoredReadGraphRow(adapter, readGraph)).row).toEqual(built);
    expect(readUnstoredReadGraphMarks(dataDir)).toEqual(new Map([[readGraph, new Set([built.generation])]]));
  });

  it('reads the row back after a request that failed, and keeps a change that landed', async () => {
    const { adapter, fixture, layer, context } = await open();
    const { wholeVm } = fixture.readGraphs;
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(wholeVm, 4)));
    layer.runtime.mirror.set(readyRow(wholeVm, 4));
    // The change lands, but its request reports a failure.
    adapter.onUpdate = async (sparql) => {
      if (!sparql.includes('"dirty"')) return;
      adapter.onUpdate = undefined;
      await adapter.update!(sparql);
      throw new Error('connection reset after commit');
    };
    expect(await markReadGraphDirty(context, wholeVm)).toEqual(row(wholeVm, 'dirty', 5));
    // A change that did not land reports its failure, and the mirror takes what is stored.
    adapter.onUpdate = (sparql) => {
      if (sparql.includes('"dirty"')) throw new Error('refused');
    };
    await expect(markReadGraphDirty(context, wholeVm)).rejects.toThrow('refused');
    expect(layer.runtime.mirror.get(wholeVm)).toEqual(row(wholeVm, 'dirty', 5));
  });
});

describe('installing the working-memory identity rule', () => {
  it('marks dirty the working-memory read graphs whose agent owns other addresses under the new rule, and records it', async () => {
    const { adapter, fixture, layer, context, dataDir } = await open();
    const { wholeVm, agentWm } = fixture.readGraphs;
    for (const readGraph of [wholeVm, agentWm]) {
      await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(readGraph, 4)));
      layer.runtime.mirror.set(readyRow(readGraph, 4));
    }
    const other = `0x${'cd'.repeat(20)}`;
    // Under the runtime's own rule AGENT owns only its own drafts; the node's rule gives it the peer ID's too.
    expect(await installWorkingMemoryIdentity(context, { defaultAgentAddress: AGENT, peerId: 'peer-1' })).toEqual({ marked: [agentWm], recorded: true });
    expect(layer.runtime.mirror.get(agentWm)).toEqual(row(agentWm, 'dirty', 5));
    expect(layer.runtime.workingMemoryIdentity.addressesOf(AGENT)).toHaveLength(2);
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual({ defaultAgentAddress: AGENT, peerId: 'peer-1' });

    // Rebuilt under that rule, the same identity again changes nothing; another default agent takes the peer ID's drafts.
    await adapter.update!(readGraphStateCompareAndSet(row(agentWm, 'dirty', 5), readyRow(agentWm, 5)));
    layer.runtime.mirror.set(readyRow(agentWm, 5));
    expect(await installWorkingMemoryIdentity(context, { defaultAgentAddress: AGENT, peerId: 'peer-1' })).toEqual({ marked: [], recorded: true });
    expect(await installWorkingMemoryIdentity(context, { defaultAgentAddress: other, peerId: 'peer-1' })).toEqual({ marked: [agentWm], recorded: true });
    expect(layer.runtime.mirror.get(agentWm)).toEqual(row(agentWm, 'dirty', 6));
    expect(layer.runtime.mirror.get(wholeVm)).toEqual(readyRow(wholeVm, 4));
    expect(await storedRows(adapter)).toEqual({ [wholeVm]: 'ready@4', [agentWm]: 'dirty@6' });
    expect(layer.runtime.workingMemoryIdentity.addressesOf(AGENT)).toEqual([AGENT]);
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual({ defaultAgentAddress: other, peerId: 'peer-1' });
    expect(await installWorkingMemoryIdentity({ store: new OxigraphStore() }, { defaultAgentAddress: AGENT })).toEqual({ marked: [], recorded: false });
  });

  it('keeps the read graph out of service, and records nothing, when a mark cannot be stored', async () => {
    const { adapter, fixture, layer, context, dataDir } = await open();
    const { agentWm } = fixture.readGraphs;
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(agentWm, 4)));
    layer.runtime.mirror.set(readyRow(agentWm, 4));
    adapter.onUpdate = () => { throw new Error('the store refused the write'); };
    expect(await installWorkingMemoryIdentity(context, { defaultAgentAddress: AGENT, peerId: 'peer-1' })).toEqual({ marked: [agentWm], recorded: false });
    adapter.onUpdate = undefined;
    // The store keeps its ready row; the mirror does not serve it, so the builder marks it again before it plans.
    expect(await storedRows(adapter)).toEqual({ [agentWm]: 'ready@4' });
    expect(layer.runtime.mirror.get(agentWm)?.state).toBe('dirty');
    expect(layer.runtime.workingMemoryIdentity.addressesOf(AGENT)).toHaveLength(2);
    expect(recordedWorkingMemoryIdentity(dataDir)).toBeUndefined();
  });

  it('owes a mark it could not store, stores it at the next installation, and records the identity only then', async () => {
    const { adapter, fixture, layer, context, dataDir } = await open();
    const { agentWm } = fixture.readGraphs;
    const first = { defaultAgentAddress: AGENT, peerId: 'peer-1' };
    const second = { defaultAgentAddress: `0x${'cd'.repeat(20)}`, peerId: 'peer-1' };
    // Recorded under the first identity, with AGENT's read graph built under it and its registry recorded.
    expect(await installWorkingMemoryIdentity(context, first)).toEqual({ marked: [], recorded: true });
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(agentWm, 4)));
    layer.runtime.mirror.set(readyRow(agentWm, 4));
    await adapter.update!(readGraphRegistryRecordUpdate(fixture.registry));
    // The second identity takes the peer ID's drafts from AGENT while the store refuses writes: the record goes.
    adapter.onUpdate = () => { throw new Error('the store refused the write'); };
    expect(await installWorkingMemoryIdentity(context, second)).toEqual({ marked: [agentWm], recorded: false });
    expect(recordedWorkingMemoryIdentity(dataDir)).toBeUndefined();
    // The same identity again has nothing new to mark, and the owed mark still fails: nothing is recorded.
    expect(await installWorkingMemoryIdentity(context, second)).toEqual({ marked: [], recorded: false });
    expect(await storedRows(adapter)).toEqual({ [agentWm]: 'ready@4' });
    expect(layer.runtime.mirror.get(agentWm)?.state).toBe('dirty');
    expect(recordedWorkingMemoryIdentity(dataDir)).toBeUndefined();
    // Once the store takes writes, the same identity stores the owed mark first, then records.
    adapter.onUpdate = undefined;
    expect(await installWorkingMemoryIdentity(context, second)).toEqual({ marked: [], recorded: true });
    expect(await storedRows(adapter)).toEqual({ [agentWm]: 'dirty@5' });
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual(second);
    // A later start under the second identity keeps nothing the first one built.
    const restarted = guardReadGraphPartition(wrapReadGraphLayer(adapter, { backend: 'oxigraph' }));
    await startReadGraphs(restarted, { dataDir, maintains: (key) => key.scope.contextGraphId === fixture.contextGraphId });
    expect((await storedRows(adapter))[agentWm]).toMatch(/^dirty@/);
  });

  it('owes the stored mark of a read graph the mirror already holds dirty, and records the identity only once it is stored', async () => {
    const { adapter, fixture, layer, context, dataDir } = await open();
    const { agentWm } = fixture.readGraphs;
    const first = { defaultAgentAddress: AGENT, peerId: 'peer-1' };
    const second = { defaultAgentAddress: `0x${'cd'.repeat(20)}`, peerId: 'peer-1' };
    expect(await installWorkingMemoryIdentity(context, first)).toEqual({ marked: [], recorded: true });
    // Stored ready under the first identity, and dirty only in the mirror, as when a write's stored mark failed.
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(agentWm, 4)));
    layer.runtime.mirror.set(row(agentWm, 'dirty', 5));
    await adapter.update!(readGraphRegistryRecordUpdate(fixture.registry));
    // The second identity takes the peer ID's drafts from AGENT: the mirror has nothing new to mark, the store does.
    expect(await installWorkingMemoryIdentity(context, second)).toEqual({ marked: [], recorded: true });
    expect(await storedRows(adapter)).toEqual({ [agentWm]: 'dirty@5' });
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual(second);
    // A later start under the second identity keeps nothing the first one built.
    const restarted = guardReadGraphPartition(wrapReadGraphLayer(adapter, { backend: 'oxigraph' }));
    await startReadGraphs(restarted, { dataDir, maintains: (key) => key.scope.contextGraphId === fixture.contextGraphId });
    expect((await storedRows(adapter))[agentWm]).toMatch(/^dirty@/);
  });

  it('records the identity only once the store has made its marks durable, and not when it cannot', async () => {
    const { adapter, fixture, layer, context, dataDir } = await open();
    const { agentWm } = fixture.readGraphs;
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(agentWm, 4)));
    layer.runtime.mirror.set(readyRow(agentWm, 4));
    // The store's flush comes after the stored mark, and until it ends there is no record.
    const seen: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    adapter.onFlush = async () => {
      seen.push((await storedRows(adapter))[agentWm]!, String(recordedWorkingMemoryIdentity(dataDir)));
      await held;
    };
    const installing = installWorkingMemoryIdentity(context, { defaultAgentAddress: AGENT, peerId: 'peer-1' });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual(['dirty@5', 'undefined']);
    release();
    expect(await installing).toEqual({ marked: [agentWm], recorded: true });
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual({ defaultAgentAddress: AGENT, peerId: 'peer-1' });
    // A store that cannot flush leaves no record; the same identity again records once it can.
    await adapter.update!(readGraphStateCompareAndSet(row(agentWm, 'dirty', 5), readyRow(agentWm, 5)));
    layer.runtime.mirror.set(readyRow(agentWm, 5));
    adapter.onFlush = () => { throw new Error('no space left on the device'); };
    expect(await installWorkingMemoryIdentity(context, { peerId: 'peer-1' })).toEqual({ marked: [agentWm], recorded: false });
    expect(recordedWorkingMemoryIdentity(dataDir)).toBeUndefined();
    adapter.onFlush = undefined;
    expect(await installWorkingMemoryIdentity(context, { peerId: 'peer-1' })).toEqual({ marked: [], recorded: true });
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual({ peerId: 'peer-1' });
  });

  it('owes again a mark that a backend restart undid before a flush made it durable, and records the identity only once it is stored again', async () => {
    const { adapter, fixture, layer, context, dataDir } = await open();
    const { agentWm } = fixture.readGraphs;
    let recovery = { generation: 1, ready: true };
    registerStoreRecoveryGeneration(adapter, () => recovery);
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(agentWm, 4)));
    layer.runtime.mirror.set(readyRow(agentWm, 4));
    const identity = { defaultAgentAddress: AGENT, peerId: 'peer-1' };
    // The worker exits after it took the mark and before the flush, and its replacement reloads a snapshot from before it.
    adapter.onFlush = async () => {
      adapter.onFlush = undefined;
      await adapter.update!(readGraphStateCompareAndSet(row(agentWm, 'dirty', 5), readyRow(agentWm, 4)));
      recovery = { generation: 2, ready: true };
      throw new Error('the store worker exited');
    };
    expect(await installWorkingMemoryIdentity(context, identity)).toEqual({ marked: [agentWm], recorded: false });
    expect((await storedRows(adapter))[agentWm]).toBe('ready@4');
    // The same identity again stores the mark again before it records.
    expect(await installWorkingMemoryIdentity(context, identity)).toEqual({ marked: [], recorded: true });
    expect((await storedRows(adapter))[agentWm]).toBe('dirty@5');
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual(identity);
    // A restart that the flush outlives, on the replacement, undoes the mark too.
    const next = { peerId: 'peer-1' };
    await adapter.update!(readGraphStateCompareAndSet(row(agentWm, 'dirty', 5), readyRow(agentWm, 5)));
    layer.runtime.mirror.set(readyRow(agentWm, 5));
    adapter.onFlush = async () => {
      adapter.onFlush = undefined;
      await adapter.update!(readGraphStateCompareAndSet(row(agentWm, 'dirty', 6), readyRow(agentWm, 5)));
      recovery = { generation: 3, ready: true };
    };
    expect(await installWorkingMemoryIdentity(context, next)).toEqual({ marked: [agentWm], recorded: false });
    expect((await storedRows(adapter))[agentWm]).toBe('ready@5');
    expect(recordedWorkingMemoryIdentity(dataDir)).toBeUndefined();
    expect(await installWorkingMemoryIdentity(context, next)).toEqual({ marked: [], recorded: true });
    expect((await storedRows(adapter))[agentWm]).toBe('dirty@6');
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual(next);
  });

  it('records only the last of two overlapping installations, once its marks are stored and flushed', async () => {
    const { adapter, fixture, layer, context, dataDir } = await open();
    const { agentWm } = fixture.readGraphs;
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(agentWm, 4)));
    layer.runtime.mirror.set(readyRow(agentWm, 4));
    const gates: Array<() => void> = [];
    adapter.onFlush = () => new Promise<void>((resolve) => { gates.push(resolve); });
    // AGENT takes the peer ID's drafts, then, while that installation flushes, another default agent takes them.
    const first = { defaultAgentAddress: AGENT, peerId: 'peer-1' };
    const second = { defaultAgentAddress: `0x${'cd'.repeat(20)}`, peerId: 'peer-1' };
    const installingFirst = installWorkingMemoryIdentity(context, first);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const installingSecond = installWorkingMemoryIdentity(context, second);
    gates[0]!();
    // After its flush the first finds a newer identity installed, and records nothing.
    expect(await installingFirst).toEqual({ marked: [agentWm], recorded: false });
    expect(recordedWorkingMemoryIdentity(dataDir)).toBeUndefined();
    // The second stores its own mark (the read graph moved again), flushes, and records only when the flush ends.
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(await storedRows(adapter)).toEqual({ [agentWm]: 'dirty@6' });
    expect(recordedWorkingMemoryIdentity(dataDir)).toBeUndefined();
    gates[1]!();
    expect(await installingSecond).toEqual({ marked: [], recorded: true });
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual(second);
  });

  it('holds working-memory read graphs from building while the record of the identity before cannot be removed', async () => {
    const { adapter, fixture, context, dataDir } = await open();
    const working = fixture.keys.find((key) => key.layer === MemoryLayer.WorkingMemory)!;
    const verifiable = fixture.keys.find((key) => key.layer === MemoryLayer.VerifiableMemory && key.scope.kind === 'context-graph')!;
    const first = { defaultAgentAddress: AGENT, peerId: 'peer-1' };
    const second = { defaultAgentAddress: `0x${'cd'.repeat(20)}`, peerId: 'peer-1' };
    expect(await installWorkingMemoryIdentity(context, first)).toEqual({ marked: [], recorded: true });
    // The record cannot be removed: here its path holds a directory with an entry.
    const record = join(dataDir, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE);
    rmSync(record);
    mkdirSync(record);
    writeFileSync(join(record, 'entry'), '');
    expect(await installWorkingMemoryIdentity(context, second)).toEqual({ marked: [], recorded: false });
    await expect(buildReadGraph(context, working)).rejects.toThrow(/cannot be removed/);
    // Other layers still build.
    expect(await buildReadGraph(context, verifiable)).toMatchObject({ outcome: 'done' });
    // Once the record can be removed, the next installation removes it, records, and releases the hold.
    rmSync(record, { recursive: true });
    expect(await installWorkingMemoryIdentity(context, second)).toEqual({ marked: [], recorded: true });
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual(second);
    expect(await buildReadGraph(context, working)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    expect((await storedRows(adapter))[readGraphIri(working)]).toMatch(/^ready@/);
  });

  it('holds working-memory read graphs while the record of the identity before cannot be reached, as while it cannot be removed', async () => {
    const { fixture, context, dataDir } = await open();
    const working = fixture.keys.find((key) => key.layer === MemoryLayer.WorkingMemory)!;
    const first = { defaultAgentAddress: AGENT, peerId: 'peer-1' };
    const second = { defaultAgentAddress: `0x${'cd'.repeat(20)}`, peerId: 'peer-1' };
    expect(await installWorkingMemoryIdentity(context, first)).toEqual({ marked: [], recorded: true });
    const record = join(dataDir, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE);
    const mode = statSync(dataDir).mode;
    try {
      // The data directory loses its search permission: the record is there, and can be neither seen nor removed.
      chmodSync(dataDir, 0o600);
      try {
        statSync(record);
        return; // Permissions do not apply to this process.
      } catch {
        // Good: the record cannot be reached.
      }
      expect(await installWorkingMemoryIdentity(context, second)).toEqual({ marked: [], recorded: false });
      await expect(buildReadGraph(context, working)).rejects.toThrow(/cannot be removed/);
    } finally {
      chmodSync(dataDir, mode);
    }
    // Once it can be reached, the next installation removes it, records, and releases the hold.
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual(first);
    expect(await installWorkingMemoryIdentity(context, second)).toEqual({ marked: [], recorded: true });
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual(second);
    expect(await buildReadGraph(context, working)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
  });

  it('keeps a working-memory read graph that a registry fence holds out of service when a change of identity moves it', async () => {
    const { adapter, fixture, layer, context } = await open();
    const { agentWm } = fixture.readGraphs;
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(agentWm, 4)));
    layer.runtime.mirror.set(readyRow(agentWm, 4));
    // A registry write fences the read graph, and the node's identity changes before the write settles.
    const fences = fenceReadGraphs(layer.runtime, [agentWm]);
    const installing = installWorkingMemoryIdentity(context, { defaultAgentAddress: AGENT, peerId: 'peer-1' });
    // Lifting the fence must not put back the row built under the rule before.
    liftReadGraphFences(layer.runtime, fences, undefined);
    expect(layer.runtime.mirror.get(agentWm)?.state).toBe('dirty');
    expect(await installing).toMatchObject({ recorded: true });
    expect((await storedRows(adapter))[agentWm]).toMatch(/^dirty@/);
    expect(layer.runtime.mirror.get(agentWm)?.state).toBe('dirty');
  });

  it('publishes no working-memory read graph that a change of identity held while its build ran', async () => {
    const { adapter, fixture, context, dataDir } = await open();
    const working = fixture.keys.find((key) => key.layer === MemoryLayer.WorkingMemory)!;
    const readGraph = readGraphIri(working);
    const first = { defaultAgentAddress: AGENT, peerId: 'peer-1' };
    const second = { defaultAgentAddress: `0x${'cd'.repeat(20)}`, peerId: 'peer-1' };
    expect(await installWorkingMemoryIdentity(context, first)).toEqual({ marked: [], recorded: true });
    // The build pauses in its registry refresh, at the registry record's write, before its row exists.
    let reached!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    adapter.onUpdate = async (sparql) => {
      if (!sparql.includes('http://dkg.io/ontology/readGraphRegistry')) return;
      adapter.onUpdate = undefined;
      reached();
      await gate;
    };
    const building = buildReadGraph(context, working);
    await paused;
    // Meanwhile the identity changes, and the record of the one before cannot be removed.
    const record = join(dataDir, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE);
    rmSync(record);
    mkdirSync(record);
    writeFileSync(join(record, 'entry'), '');
    expect(await installWorkingMemoryIdentity(context, second)).toEqual({ marked: [], recorded: false });
    release();
    // The build ends without publishing: its row is not ready.
    expect(await building).toMatchObject({ outcome: 'lost' });
    expect((await storedRows(adapter))[readGraph]).not.toMatch(/^ready@/);
    rmSync(record, { recursive: true });
  });

  it('reads no identity from a missing or malformed record', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'read-graph-identity-'));
    dirs.push(dataDir);
    expect(recordedWorkingMemoryIdentity(dataDir)).toBeUndefined();
    for (const body of ['not json', '[]', '{"peerId":7}', 'null']) {
      writeFileSync(join(dataDir, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE), body);
      expect(recordedWorkingMemoryIdentity(dataDir), body).toBeUndefined();
    }
    writeFileSync(join(dataDir, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE), '{"peerId":"peer-1"}');
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual({ peerId: 'peer-1' });
  });
});

describe('removing a read graph', () => {
  it('stops maintaining it, empties it fenced and removes its row', async () => {
    const { adapter, fixture, layer, store, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done' });
    const removed = await removeReadGraph({ ...context, batching: { triplesPerDrop: 2, pauseRatio: 0 } }, wholeVm);
    expect(removed).toMatchObject({ outcome: 'done', row: undefined });
    expect(removed.batches).toBeGreaterThan(1);
    expect(await triplesOf(adapter, wholeVm)).toEqual([]);
    expect(await storedRows(adapter)).toEqual({});
    expect(layer.runtime.mirror.get(wholeVm)).toBeUndefined();
    await store.insert([q('urn:s:after', '"a"', fixture.graphs[1]!)]);
    expect(await triplesOf(adapter, wholeVm)).toEqual([]);
    expect(await removeReadGraph(context, wholeVm)).toMatchObject({ outcome: 'current' });
  });

  it('ends a drop whose fence no longer matches the stored row, which no batch could then empty', async () => {
    const { adapter, fixture, layer, context } = await open();
    const { codeVm } = fixture.readGraphs;
    await adapter.insert(Array.from({ length: 40 }, (_, i) => q(`urn:s:drop${i}`, '"d"', codeVm)));
    await adapter.update!(readGraphStateCompareAndSet(undefined, row(codeVm, 'dirty', 3)));
    layer.runtime.mirror.set(row(codeVm, 'dirty', 3));
    let drops = 0;
    adapter.onUpdate = async (sparql) => {
      if (!sparql.startsWith('DELETE') || !sparql.includes('LIMIT')) return;
      drops += 1;
      // Another writer moves the stored row on; the mirror no longer has one.
      if (drops === 5) await adapter.update!(readGraphStateCompareAndSet(row(codeVm, 'dirty', 3), row(codeVm, 'dirty', 9)));
    };
    const removed = await removeReadGraph({ ...context, batching: { triplesPerDrop: 1, pauseRatio: 0 } }, codeVm);
    expect(removed).toMatchObject({ outcome: 'lost', row: row(codeVm, 'dirty', 9) });
    expect(drops).toBe(32);
    expect((await triplesOf(adapter, codeVm)).length).toBe(36);
  });

  it('gives a read graph without a row that still holds triples a dirty row, so its drop is fenced', async () => {
    const { adapter, fixture, context } = await open();
    const { codeVm } = fixture.readGraphs;
    await adapter.insert([q('urn:s:left', '"l"', codeVm)]);
    adapter.requests.length = 0;
    expect(await removeReadGraph(context, codeVm)).toMatchObject({ outcome: 'done' });
    expect(await triplesOf(adapter, codeVm)).toEqual([]);
    expect(adapter.requests.some((request) => request.startsWith('DELETE') && request.includes('readGraphFence'))).toBe(true);
    await expect(removeReadGraph(context, `${fixture.root}/plain`)).rejects.toThrow(/Not a read-graph IRI/);
  });
});

describe('read-graph start-up', () => {
  async function seeded() {
    const opened = await open();
    const { wholeVm, wholeSwm, codeVm, agentWm } = opened.fixture.readGraphs;
    const other = readGraphIri({ scope: readScope(`${opened.fixture.contextGraphId}-other`), layer: MemoryLayer.VerifiableMemory });
    const otherDirty = readGraphIri({ scope: readScope(`${opened.fixture.contextGraphId}-other`), layer: MemoryLayer.SharedWorkingMemory });
    await opened.adapter.update!([
      readGraphStateCompareAndSet(undefined, readyRow(wholeVm, 3)),
      readGraphStateCompareAndSet(undefined, row(wholeSwm, 'dirty', 5)),
      readGraphStateCompareAndSet(undefined, { ...readyRow(codeVm, 7), builderVersion: 99 }),
      readGraphStateCompareAndSet(undefined, readyRow(agentWm, 9)),
      readGraphStateCompareAndSet(undefined, readyRow(other, 11)),
      readGraphStateCompareAndSet(undefined, row(otherDirty, 'dirty', 13)),
    ].join(';\n'));
    // The registry the ready rows were built under, as a builder records it.
    await opened.adapter.update!(readGraphRegistryRecordUpdate(opened.fixture.registry));
    return { ...opened, other, otherDirty };
  }

  it('without anything to maintain is the start-up of a release that does not maintain read graphs', async () => {
    const { adapter, fixture, layer, store, other, otherDirty } = await seeded();
    const { wholeVm, wholeSwm, codeVm, agentWm } = fixture.readGraphs;
    expect(await startReadGraphs(store)).toEqual({ marked: 4, maintained: 0 });
    expect(await storedRows(adapter)).toEqual({
      [wholeVm]: 'dirty@4', [wholeSwm]: 'dirty@5', [codeVm]: 'dirty@8', [agentWm]: 'dirty@10', [other]: 'dirty@12', [otherDirty]: 'dirty@13',
    });
    expect(layer.runtime.mirror.size).toBe(0);
  });

  it('keeps ready rows it maintains, marks the rest dirty at a new generation, and loads the mirror', async () => {
    const { adapter, fixture, layer, store, dataDir, other, otherDirty } = await seeded();
    const { wholeVm, wholeSwm, codeVm, agentWm } = fixture.readGraphs;
    layer.runtime.mirror.set(readyRow(other, 1));
    const ours = (key: ReadGraphKey) => key.scope.contextGraphId === fixture.contextGraphId;
    const logs: string[] = [];
    expect(await startReadGraphs(store, { dataDir, maintains: ours, log: (line) => logs.push(line) })).toEqual({ marked: 4, maintained: 4 });
    expect(await storedRows(adapter)).toEqual({
      [wholeVm]: 'ready@3', [wholeSwm]: 'dirty@6', [codeVm]: 'dirty@8', [agentWm]: 'dirty@10', [other]: 'dirty@12', [otherDirty]: 'dirty@13',
    });
    expect(layer.runtime.mirror.rows().map((stored) => `${stored.readGraph} ${stored.state}@${stored.generation}`).sort()).toEqual([
      `${agentWm} dirty@10`, `${codeVm} dirty@8`, `${wholeSwm} dirty@6`, `${wholeVm} ready@3`,
    ].sort());
    expect(layer.runtime.registries.get(fixture.contextGraphId)).toMatchObject({ subGraphNames: ['code'] });
    expect(mayHoldReadGraphPartitions(dataDir)).toBe(true);
    expect(logs).toEqual(['Marked 4 read graph(s) dirty at start; 4 are maintained']);
  });

  it('marks ready rows whose membership moved since their registry was recorded, as when a process stopped before its marks', async () => {
    const { adapter, fixture, context, dataDir } = await open();
    const [vm, swm, code] = fixture.keys as [ReadGraphKey, ReadGraphKey, ReadGraphKey];
    for (const key of [vm, swm, code]) expect(await buildReadGraph(context, key)).toMatchObject({ outcome: 'done' });
    // `code` stops being a sub-graph, and no mark of that reaches the store: the process stopped first.
    await adapter.update(`DELETE DATA { GRAPH <${fixture.root}/_meta> { ${SUB_GRAPH_TYPE(fixture, 'code')} } }`);
    // The next process over the same store.
    const layer = wrapReadGraphLayer(adapter, { backend: 'oxigraph' });
    const store = guardReadGraphPartition(layer);
    const restarted: ReadGraphJobContext = { ...context, store };
    // With a data directory, so that only the registry record can tell which rows moved.
    expect(await startReadGraphs(store, { dataDir, maintains: () => true })).toEqual({ marked: 3, maintained: 3 });
    const { wholeVm, wholeSwm, codeVm } = fixture.readGraphs;
    expect(Object.values(await storedRows(adapter)).every((stored) => stored.startsWith('dirty@'))).toBe(true);
    expect(Object.keys(await storedRows(adapter)).sort()).toEqual([codeVm, wholeSwm, wholeVm].sort());
    // Start-up recorded the registry it found, and the builder builds to it.
    expect(await storedRecords(adapter)).toEqual(new Map([[fixture.contextGraphId, { ...fixture.registry, subGraphNames: [] }]]));
    for (const key of [vm, swm]) {
      expect(await buildReadGraph(restarted, key)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
      await expectCurrentUnion(adapter, layer, fixture, key);
    }
  });

  it('keeps a ready row whose membership the change did not move, and marks every ready row without a record', async () => {
    const { adapter, fixture, context, dataDir } = await open();
    const [vm, , code] = fixture.keys as [ReadGraphKey, ReadGraphKey, ReadGraphKey];
    for (const key of [vm, code]) expect(await buildReadGraph(context, key)).toMatchObject({ outcome: 'done' });
    const { wholeVm, codeVm } = fixture.readGraphs;
    const before = await storedRows(adapter);
    // A new sub-graph moves the whole graph's members, not those of `code`.
    await adapter.update(`INSERT DATA { GRAPH <${fixture.root}/_meta> { ${SUB_GRAPH_TYPE(fixture, 'docs')} ; <http://schema.org/name> "docs" } }`);
    const first = guardReadGraphPartition(wrapReadGraphLayer(adapter, { backend: 'oxigraph' }));
    expect(await startReadGraphs(first, { dataDir, maintains: () => true })).toEqual({ marked: 1, maintained: 2 });
    expect((await storedRows(adapter))[codeVm]).toBe(before[codeVm]);
    expect((await storedRows(adapter))[wholeVm]).toMatch(/^dirty@/);
    // Without a record, nothing tells which registry a ready row follows.
    const stateGraph = `${fixture.root}/_~read/state`;
    await adapter.update(`DELETE WHERE { GRAPH <${stateGraph}> { <${stateGraph}> <http://dkg.io/ontology/readGraphRegistry> ?o } }`);
    const second = guardReadGraphPartition(wrapReadGraphLayer(adapter, { backend: 'oxigraph' }));
    expect(await startReadGraphs(second, { dataDir, maintains: () => true })).toEqual({ marked: 2, maintained: 2 });
    expect((await storedRows(adapter))[codeVm]).toMatch(/^dirty@/);
    expect((await storedRecords(adapter)).get(fixture.contextGraphId)).toEqual({ ...fixture.registry, subGraphNames: ['code', 'docs'] });
  });

  it('keeps working-memory rows ready under a recorded identity, installs it, and marks only what the node changes', async () => {
    const { adapter, fixture, layer, store, dataDir } = await seeded();
    const { agentWm } = fixture.readGraphs;
    writeFileSync(join(dataDir, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE), JSON.stringify({ defaultAgentAddress: AGENT, peerId: 'peer-1' }));
    // The registry the ready rows follow, as the builder records it.
    await adapter.update!(readGraphRegistryRecordUpdate(fixture.registry));
    const ours = (key: ReadGraphKey) => key.scope.contextGraphId === fixture.contextGraphId;
    expect(await startReadGraphs(store, { dataDir, maintains: ours })).toEqual({ marked: 3, maintained: 4 });
    expect((await storedRows(adapter))[agentWm]).toBe('ready@9');
    expect(layer.runtime.mirror.get(agentWm)).toEqual(readyRow(agentWm, 9));
    expect(layer.runtime.workingMemoryIdentity.addressesOf(AGENT)).toEqual([AGENT, 'peer-1']);
    // The node installs its own identity; the record start-up noted is where it goes, without being named again.
    expect(await installWorkingMemoryIdentity({ store }, { defaultAgentAddress: AGENT, peerId: 'peer-1' })).toEqual({ marked: [], recorded: true });
    expect(await installWorkingMemoryIdentity({ store }, { peerId: 'peer-1' })).toEqual({ marked: [agentWm], recorded: true });
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual({ peerId: 'peer-1' });
  });

  it('marks a ready row dirty at start when its dirty mark never reached the store, as the data directory keeps it', async () => {
    const { adapter, fixture, layer, store, context, dataDir } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    expect(await startReadGraphs(store, { dataDir, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    const built = (await buildReadGraph(context, vm)).row!;
    // A full check finds a triple no member holds, and the store refuses its dirty mark.
    await adapter.insert([q('urn:s:stray', '"stray"', wholeVm)]);
    adapter.onUpdate = (sparql) => { if (sparql.includes('"dirty"')) throw new Error('connection reset'); };
    expect(await checkReadGraph(store, wholeVm, 'full', { alert: () => undefined })).toMatchObject({ outcome: 'mismatch', direction: 'unheld' });
    adapter.onUpdate = undefined;
    expect(layer.runtime.mirror.get(wholeVm)?.state).toBe('dirty');
    expect((await readStoredReadGraphRow(adapter, wholeVm)).row).toEqual(built);
    // The next process over the same store: the stored row and the registry record agree, the journal does not.
    const restarted = guardReadGraphPartition(wrapReadGraphLayer(adapter, { backend: 'oxigraph' }));
    expect(await startReadGraphs(restarted, { dataDir, maintains: () => true })).toEqual({ marked: 1, maintained: 1 });
    expect((await storedRows(adapter))[wholeVm]).toBe(`dirty@${built.generation + 1}`);
    expect(readUnstoredReadGraphMarks(dataDir)).toEqual(new Map());
    // A mark for a generation the row has left keeps nothing out.
    expect(await buildReadGraph({ ...context, store: restarted }, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    writeFileSync(readGraphMarkJournalPath(dataDir), `${built.generation} ${wholeVm}\n`);
    const third = guardReadGraphPartition(wrapReadGraphLayer(adapter, { backend: 'oxigraph' }));
    expect(await startReadGraphs(third, { dataDir, maintains: () => true })).toEqual({ marked: 0, maintained: 1 });
  });

  it('keeps no ready row at start when a refused mark could not be written to the journal either', async () => {
    const { adapter, fixture, store, context, dataDir } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    expect(await startReadGraphs(store, { dataDir, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    const built = (await buildReadGraph(context, vm)).row!;
    // The journal can be read but not written. A full check finds a triple no member holds, and the store refuses its mark.
    writeFileSync(readGraphMarkJournalPath(dataDir), '');
    await chmod(readGraphMarkJournalPath(dataDir), 0o444);
    await adapter.insert([q('urn:s:stray', '"stray"', wholeVm)]);
    adapter.onUpdate = (sparql) => { if (sparql.includes('"dirty"')) throw new Error('connection reset'); };
    expect(await checkReadGraph(store, wholeVm, 'full', { alert: () => undefined })).toMatchObject({ outcome: 'mismatch' });
    adapter.onUpdate = undefined;
    expect(readUnstoredReadGraphMarks(dataDir)).toEqual(new Map());
    // The next process keeps no ready row, so the one the journal missed is marked too.
    const restarted = guardReadGraphPartition(wrapReadGraphLayer(adapter, { backend: 'oxigraph' }));
    expect(await startReadGraphs(restarted, { dataDir, maintains: () => true })).toEqual({ marked: 1, maintained: 1 });
    expect((await storedRows(adapter))[wholeVm]).toBe(`dirty@${built.generation + 1}`);
  });

  it('keeps no ready row across a start without a data directory, where no journal kept a refused mark', async () => {
    const { adapter, fixture, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    const built = (await buildReadGraph(context, vm)).row!;
    const restarted = guardReadGraphPartition(wrapReadGraphLayer(adapter, { backend: 'oxigraph' }));
    expect(await startReadGraphs(restarted, { maintains: () => true })).toEqual({ marked: 1, maintained: 1 });
    expect((await storedRows(adapter))[fixture.readGraphs.wholeVm]).toBe(`dirty@${built.generation + 1}`);
  });

  it('notes that the store holds read-graph partitions when a start finds only a registry record', async () => {
    const { adapter, fixture, context } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done' });
    // The last read graph goes; its context graph's registry record stays.
    expect(await removeReadGraph(context, fixture.readGraphs.wholeVm)).toMatchObject({ outcome: 'done' });
    expect(await storedRows(adapter)).toEqual({});
    expect((await storedRecords(adapter)).size).toBe(1);
    const fresh = mkdtempSync(join(tmpdir(), 'read-graph-builder-'));
    dirs.push(fresh);
    const restarted = guardReadGraphPartition(wrapReadGraphLayer(adapter, { backend: 'oxigraph' }));
    expect(await startReadGraphs(restarted, { dataDir: fresh, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    expect(mayHoldReadGraphPartitions(fresh)).toBe(true);
  });

  const recordOnly: Array<[string, () => TripleStore, ReadGraphStartOptions]> = [
    ['with read graphs off', () => new HookedStore(), {}],
    ['over an adapter that does not declare its read-graph methods', () => undeclared(new OxigraphStore()), { maintains: () => true }],
    ['maintaining every read graph', () => new HookedStore(), { maintains: () => true }],
  ];
  it.each(recordOnly)('notes a fresh store that holds only a registry record as holding read-graph partitions, %s', async (_name, adapterOf, modes) => {
    const adapter = adapterOf();
    const fixture = layerFixture(`builder-${sequence += 1}`);
    await adapter.update!(readGraphRegistryRecordUpdate(fixture.registry));
    const dataDir = mkdtempSync(join(tmpdir(), 'read-graph-builder-'));
    dirs.push(dataDir);
    const store = guardReadGraphPartition(wrapReadGraphLayer(adapter, { backend: 'oxigraph' }));
    expect(await startReadGraphs(store, { dataDir, ...modes })).toEqual({ marked: 0, maintained: 0 });
    expect(mayHoldReadGraphPartitions(dataDir)).toBe(true);
    expect(storeMayHoldReadGraphPartitions(adapter)).toBe(true);
  });

  it('notes a store whose registry records cannot be listed at start, with read graphs off', async () => {
    const failing = new HookedStore();
    const query = failing.query.bind(failing);
    failing.query = async (sparql, options) => {
      if (sparql.includes('<http://dkg.io/ontology/readGraphRegistry>')) throw new Error('connection reset');
      return query(sparql, options);
    };
    const dataDir = mkdtempSync(join(tmpdir(), 'read-graph-builder-'));
    dirs.push(dataDir);
    const logs: string[] = [];
    await startReadGraphs(guardReadGraphPartition(wrapReadGraphLayer(failing, { backend: 'oxigraph' })), { dataDir, log: (line) => logs.push(line) });
    expect(mayHoldReadGraphPartitions(dataDir)).toBe(true);
    expect(storeMayHoldReadGraphPartitions(failing)).toBe(true);
    expect(logs.some((line) => line.includes('could not be listed'))).toBe(true);
  });

  it('leaves the mirror of a backend this process already started to the store objects using it, and applies only its own journal', async () => {
    const adapter = new HookedStore();
    const fixture = layerFixture(`builder-${sequence += 1}`);
    await adapter.insert([
      ...fixture.facts,
      ...fixture.graphs.flatMap((graph, i) => [q('urn:s:shared', '"both"', graph), q(`urn:s:${i}`, `"v${i}"`, graph)]),
    ]);
    const [first, second] = [mkdtempSync(join(tmpdir(), 'read-graph-builder-')), mkdtempSync(join(tmpdir(), 'read-graph-builder-'))];
    dirs.push(first, second);
    // Two agents of one process over the same backend share its runtime.
    const config = { backend: 'oxigraph-persistent' as const, options: { path: join(first, 'store') } };
    const layer = wrapReadGraphLayer(adapter, config);
    const store = guardReadGraphPartition(layer);
    const context: ReadGraphJobContext = { store, dataDir: first, batching: { pauseRatio: 0, graphsPerBatch: 2 } };
    const [vm] = fixture.keys as [ReadGraphKey];
    expect(await startReadGraphs(store, { dataDir: first, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    const built = (await buildReadGraph(context, vm)).row!;
    const other = guardReadGraphPartition(wrapReadGraphLayer(adapter, config));
    expect(readGraphLayerOf(other)!.runtime).toBe(layer.runtime);
    expect(await startReadGraphs(other, { dataDir: second, maintains: () => true })).toEqual({ marked: 0, maintained: 1 });
    // The first agent's writes are still maintained.
    await store.insert([q('urn:s:after', '"after"', fixture.graphs[1]!)]);
    await expectUnion(adapter, layer, fixture, vm);
    // A later start over the same backend applies its own data directory's journal to the running mirror.
    writeFileSync(readGraphMarkJournalPath(second), `${built.generation} ${fixture.readGraphs.wholeVm}\n`);
    expect(await startReadGraphs(other, { dataDir: second, maintains: () => true })).toEqual({ marked: 1, maintained: 1 });
    expect(layer.runtime.mirror.get(fixture.readGraphs.wholeVm)?.state).toBe('dirty');
    expect((await storedRows(adapter))[fixture.readGraphs.wholeVm]).toBe(`dirty@${built.generation + 1}`);
    expect(readUnstoredReadGraphMarks(second)).toEqual(new Map());
  });

  it('leaves the working-memory identity of a backend this process already started to the start-up that loaded it, and records it in every data directory a start-up named', async () => {
    const adapter = new HookedStore();
    const [first, second] = [mkdtempSync(join(tmpdir(), 'read-graph-builder-')), mkdtempSync(join(tmpdir(), 'read-graph-builder-'))];
    dirs.push(first, second);
    const other = `0x${'cd'.repeat(20)}`;
    writeFileSync(join(first, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE), JSON.stringify({ defaultAgentAddress: AGENT, peerId: 'peer-1' }));
    writeFileSync(join(second, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE), JSON.stringify({ defaultAgentAddress: other, peerId: 'peer-1' }));
    // Two agents of one process over the same backend share its runtime.
    const config = { backend: 'oxigraph-persistent' as const, options: { path: join(first, 'store') } };
    const layer = wrapReadGraphLayer(adapter, config);
    const store = guardReadGraphPartition(layer);
    expect(await startReadGraphs(store, { dataDir: first, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    expect(layer.runtime.workingMemoryIdentity.addressesOf(AGENT)).toEqual([AGENT, 'peer-1']);
    const later = guardReadGraphPartition(wrapReadGraphLayer(adapter, config));
    expect(readGraphLayerOf(later)!.runtime).toBe(layer.runtime);
    expect(await startReadGraphs(later, { dataDir: second, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    // The running rule stays the one the first start-up installed. The later start-up's agent may be the one a later
    // process starts alone, so its data directory records the running identity in place of the one it held.
    expect(layer.runtime.workingMemoryIdentity.addressesOf(AGENT)).toEqual([AGENT, 'peer-1']);
    expect(recordedWorkingMemoryIdentity(second)).toEqual({ defaultAgentAddress: AGENT, peerId: 'peer-1' });
    // A change of identity is recorded in both.
    expect(await installWorkingMemoryIdentity({ store }, { peerId: 'peer-1' })).toEqual({ marked: [], recorded: true });
    expect(recordedWorkingMemoryIdentity(first)).toEqual({ peerId: 'peer-1' });
    expect(recordedWorkingMemoryIdentity(second)).toEqual({ peerId: 'peer-1' });
    // A later start-up while a change is not yet recorded keeps no record of the identity before it.
    const third = mkdtempSync(join(tmpdir(), 'read-graph-builder-'));
    dirs.push(third);
    writeFileSync(join(third, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE), JSON.stringify({ defaultAgentAddress: other, peerId: 'peer-1' }));
    adapter.onFlush = () => { throw new Error('no space left on the device'); };
    expect(await installWorkingMemoryIdentity({ store }, { defaultAgentAddress: other, peerId: 'peer-1' })).toEqual({ marked: [], recorded: false });
    adapter.onFlush = undefined;
    expect(await startReadGraphs(guardReadGraphPartition(wrapReadGraphLayer(adapter, config)), { dataDir: third, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    expect([first, second, third].map((dir) => recordedWorkingMemoryIdentity(dir))).toEqual([undefined, undefined, undefined]);
    expect(await installWorkingMemoryIdentity({ store }, { defaultAgentAddress: other, peerId: 'peer-1' })).toEqual({ marked: [], recorded: true });
    expect([first, second, third].map((dir) => recordedWorkingMemoryIdentity(dir))).toEqual([0, 1, 2].map(() => ({ defaultAgentAddress: other, peerId: 'peer-1' })));
  });

  it('records a change of identity in the data directory its backend started from, whichever directory the installation names', async () => {
    const { store, dataDir } = await open();
    const other = mkdtempSync(join(tmpdir(), 'read-graph-builder-'));
    dirs.push(other);
    writeFileSync(join(dataDir, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE), JSON.stringify({ defaultAgentAddress: AGENT, peerId: 'peer-1' }));
    expect(await startReadGraphs(store, { dataDir, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    // A workload over the same backend that names another data directory changes the identity: the record start-up
    // reads is the one that changes.
    expect(await installWorkingMemoryIdentity({ store, dataDir: other }, { defaultAgentAddress: AGENT, peerId: 'peer-2' })).toEqual({ marked: [], recorded: true });
    expect(recordedWorkingMemoryIdentity(dataDir)).toEqual({ defaultAgentAddress: AGENT, peerId: 'peer-2' });
    expect(recordedWorkingMemoryIdentity(other)).toBeUndefined();
  });

  /** Two agents of one process over the same backend: two layers that share its runtime. */
  async function sharedBackend() {
    const adapter = new HookedStore();
    const fixture = layerFixture(`builder-${sequence += 1}`);
    await adapter.insert([
      ...fixture.facts,
      ...fixture.graphs.flatMap((graph, i) => [q('urn:s:shared', '"both"', graph), q(`urn:s:${i}`, `"v${i}"`, graph)]),
    ]);
    const [first, second] = [mkdtempSync(join(tmpdir(), 'read-graph-builder-')), mkdtempSync(join(tmpdir(), 'read-graph-builder-'))];
    dirs.push(first, second);
    const config = { backend: 'oxigraph-persistent' as const, options: { path: join(first, 'store') } };
    const layer = wrapReadGraphLayer(adapter, config);
    const store = guardReadGraphPartition(layer);
    const other = guardReadGraphPartition(wrapReadGraphLayer(adapter, config));
    const context: ReadGraphJobContext = { store, dataDir: first, batching: { pauseRatio: 0, graphsPerBatch: 2 } };
    return { adapter, fixture, layer, store, other, context, first, second };
  }

  it('makes a start-up over a backend another start-up is loading wait for it, and lets a failed load be tried again', async () => {
    const { adapter, layer, store, other, first, second } = await sharedBackend();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const rowsQuery = readGraphStateRowsQuery();
    let fail = 1;
    const query = adapter.query.bind(adapter);
    adapter.query = async (sparql, options) => {
      if (sparql === rowsQuery && fail > 0) { fail -= 1; throw new Error('connection reset'); }
      if (sparql === rowsQuery) await held;
      return query(sparql, options);
    };
    // The first load fails; the next start-up loads again rather than trusting it.
    await expect(startReadGraphs(store, { dataDir: first, maintains: () => true })).rejects.toThrow('connection reset');
    const loading = startReadGraphs(store, { dataDir: first, maintains: () => true });
    let waited = false;
    const waiting = startReadGraphs(other, { dataDir: second, maintains: () => true }).then((result) => { waited = true; return result; });
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(waited).toBe(false);
    release!();
    expect(await loading).toEqual({ marked: 0, maintained: 0 });
    expect(await waiting).toEqual({ marked: 0, maintained: 0 });
    expect(layer.runtime.mirror.size).toBe(0);
  });

  it('tries a failed load again in one start-up, however many waited for it', async () => {
    const { adapter, layer, store, other, first, second } = await sharedBackend();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const rowsQuery = readGraphStateRowsQuery();
    // Without rows, each load reads the state rows once.
    let loads = 0;
    const query = adapter.query.bind(adapter);
    adapter.query = async (sparql, options) => {
      if (sparql === rowsQuery && (loads += 1) === 1) {
        await held;
        throw new Error('connection reset');
      }
      return query(sparql, options);
    };
    // Two start-ups wait for a load that fails: one of them loads again, and the other waits for that load.
    const failing = startReadGraphs(store, { dataDir: first, maintains: () => true });
    const retries = [
      startReadGraphs(store, { dataDir: first, maintains: () => true }),
      startReadGraphs(other, { dataDir: second, maintains: () => true }),
    ];
    release!();
    await expect(failing).rejects.toThrow('connection reset');
    expect(await Promise.all(retries)).toEqual([{ marked: 0, maintained: 0 }, { marked: 0, maintained: 0 }]);
    expect(loads).toBe(2);
    expect(layer.runtime.mirror.size).toBe(0);
  });

  it('applies a journaled mark to a running mirror that already says dirty, and keeps the journal while the store refuses it', async () => {
    const { adapter, fixture, layer, store, other, context, first, second } = await sharedBackend();
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    expect(await startReadGraphs(store, { dataDir: first, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    const built = (await buildReadGraph(context, vm)).row!;
    // A check's mark reached the mirror and not the store, and the journal has it.
    layer.runtime.mirror.set({ ...built, state: 'dirty', generation: built.generation + 1 });
    writeFileSync(readGraphMarkJournalPath(second), `${built.generation} ${wholeVm}\n`);
    adapter.onUpdate = (sparql) => { if (sparql.includes('"dirty"')) throw new Error('connection reset'); };
    expect(await startReadGraphs(other, { dataDir: second, maintains: () => true })).toEqual({ marked: 0, maintained: 1 });
    expect(readUnstoredReadGraphMarks(second)).toEqual(new Map([[wholeVm, new Set([built.generation])]]));
    adapter.onUpdate = undefined;
    expect(await startReadGraphs(other, { dataDir: second, maintains: () => true })).toEqual({ marked: 1, maintained: 1 });
    expect((await storedRows(adapter))[wholeVm]).toBe(`dirty@${built.generation + 1}`);
    expect(readUnstoredReadGraphMarks(second)).toEqual(new Map());
  });

  it('journals a mark the store refused in the data directory of every start-up over the backend, so either agent may start alone next', async () => {
    const { adapter, fixture, layer, store, other, context, first, second } = await sharedBackend();
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    expect(await startReadGraphs(store, { dataDir: first, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    const built = (await buildReadGraph(context, vm)).row!;
    expect(await startReadGraphs(other, { dataDir: second, maintains: () => true })).toEqual({ marked: 0, maintained: 1 });
    // A full check through the second agent finds a triple no member holds, and the store refuses its dirty mark.
    await adapter.insert([q('urn:s:stray', '"stray"', wholeVm)]);
    adapter.onUpdate = (sparql) => { if (sparql.includes('"dirty"')) throw new Error('connection reset'); };
    expect(await checkReadGraph(other, wholeVm, 'full', { alert: () => undefined })).toMatchObject({ outcome: 'mismatch', direction: 'unheld' });
    adapter.onUpdate = undefined;
    expect(layer.runtime.mirror.get(wholeVm)?.state).toBe('dirty');
    expect((await readStoredReadGraphRow(adapter, wholeVm)).row).toEqual(built);
    for (const dataDir of [first, second]) expect(readUnstoredReadGraphMarks(dataDir)).toEqual(new Map([[wholeVm, new Set([built.generation])]]));
    // The next process starts the second agent alone over the same store, with only its own data directory.
    const restarted = guardReadGraphPartition(wrapReadGraphLayer(adapter, { backend: 'oxigraph' }));
    expect(await startReadGraphs(restarted, { dataDir: second, maintains: () => true })).toEqual({ marked: 1, maintained: 1 });
    expect((await storedRows(adapter))[wholeVm]).toBe(`dirty@${built.generation + 1}`);
  });

  it('gives an agent that joins the backend the marks the store refused before it joined', async () => {
    const { adapter, fixture, store, other, context, first, second } = await sharedBackend();
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    expect(await startReadGraphs(store, { dataDir: first, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    const built = (await buildReadGraph(context, vm)).row!;
    // A full check through the first agent finds a mismatch, and the store refuses its dirty mark: only its journal has it.
    await adapter.insert([q('urn:s:stray', '"stray"', wholeVm)]);
    adapter.onUpdate = (sparql) => { if (sparql.includes('"dirty"')) throw new Error('connection reset'); };
    expect(await checkReadGraph(store, wholeVm, 'full', { alert: () => undefined })).toMatchObject({ outcome: 'mismatch' });
    expect(readUnstoredReadGraphMarks(second)).toEqual(new Map());
    // The second agent joins while the store still refuses the mark: its journal takes the mark as it joins.
    expect(await startReadGraphs(other, { dataDir: second, maintains: () => true })).toEqual({ marked: 0, maintained: 1 });
    adapter.onUpdate = undefined;
    expect(readUnstoredReadGraphMarks(second)).toEqual(new Map([[wholeVm, new Set([built.generation])]]));
    // The next process starts the second agent alone, with only its own data directory.
    const restarted = guardReadGraphPartition(wrapReadGraphLayer(adapter, { backend: 'oxigraph' }));
    expect(await startReadGraphs(restarted, { dataDir: second, maintains: () => true })).toEqual({ marked: 1, maintained: 1 });
    expect((await storedRows(adapter))[wholeVm]).toBe(`dirty@${built.generation + 1}`);
  });

  it('fails a start-up whose data directory holds a journal it cannot read, rather than take it for an empty one', async () => {
    const { store, other, first, second } = await sharedBackend();
    // A directory where the journal's file belongs: reading it fails, as it does without permission.
    await mkdir(readGraphMarkJournalPath(first));
    expect(() => readUnstoredReadGraphMarks(first)).toThrow(/EISDIR/);
    expect(() => unstoredReadGraphMarksText(first)).toThrow(/EISDIR/);
    await expect(startReadGraphs(store, { dataDir: first, maintains: () => true })).rejects.toThrow(/EISDIR/);
    rmSync(readGraphMarkJournalPath(first), { recursive: true });
    expect(await startReadGraphs(store, { dataDir: first, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    // A start-up that joins the loaded mirror fails the same way.
    await mkdir(readGraphMarkJournalPath(second));
    await expect(startReadGraphs(other, { dataDir: second, maintains: () => true })).rejects.toThrow(/EISDIR/);
  });

  it('notes read-graph partitions in the data directory of every start-up over the backend, whenever they appear', async () => {
    // A rollback drops the partitions only from a data directory that notes them.
    const partitions = (...dirs: string[]) => dirs.map((dataDir) => mayHoldReadGraphPartitions(dataDir));
    // Partitions built after both start-ups: every directory notes them.
    const later = await sharedBackend();
    expect(await startReadGraphs(later.store, { dataDir: later.first, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    expect(await startReadGraphs(later.other, { dataDir: later.second, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    expect(partitions(later.first, later.second)).toEqual([false, false]);
    await buildReadGraph(later.context, later.fixture.keys[0]!);
    expect(partitions(later.first, later.second)).toEqual([true, true]);
    // Partitions there before a start-up joins: its directory notes them as it joins.
    const earlier = await sharedBackend();
    expect(await startReadGraphs(earlier.store, { dataDir: earlier.first, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    await buildReadGraph(earlier.context, earlier.fixture.keys[0]!);
    expect(partitions(earlier.second)).toEqual([false]);
    expect(await startReadGraphs(earlier.other, { dataDir: earlier.second, maintains: () => true })).toEqual({ marked: 0, maintained: 1 });
    expect(partitions(earlier.second)).toEqual([true]);
  });

  it('replaces damaged rows and rows whose generation cannot grow, and notes nothing without rows', async () => {
    const empty = await open();
    expect(await startReadGraphs(empty.store, { dataDir: empty.dataDir, maintains: () => true })).toEqual({ marked: 0, maintained: 0 });
    expect(mayHoldReadGraphPartitions(empty.dataDir)).toBe(false);
    const { adapter, fixture, layer, store } = await open();
    const { wholeVm, wholeSwm } = fixture.readGraphs;
    await adapter.update!(readGraphStateCompareAndSet(undefined, row(wholeVm, 'building', MAX_READ_GRAPH_GENERATION)));
    await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(wholeSwm, 2)));
    await adapter.insert([{ subject: wholeSwm, predicate: 'http://dkg.io/ontology/readGraphGeneration', object: '"4"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: `${fixture.root}/_~read/state` }]);
    expect(await startReadGraphs(store, { maintains: () => true })).toEqual({ marked: 2, maintained: 2 });
    for (const readGraph of [wholeVm, wholeSwm]) {
      const stored = await readStoredReadGraphRow(adapter, readGraph);
      expect(stored).toMatchObject({ damaged: false, row: { state: 'dirty' } });
      expect(stored.row!.generation).toBeLessThan(2 ** 48);
      expect(layer.runtime.mirror.get(readGraph)).toEqual(stored.row);
    }
  });

  it('fences out an operation an earlier process left in flight', async () => {
    const { adapter, fixture, layer, store, context } = await seeded();
    const { wholeSwm } = fixture.readGraphs;
    await startReadGraphs(store, { maintains: (key) => key.scope.contextGraphId === fixture.contextGraphId });
    // The earlier process's rebuild of the dirty row at generation 5 lands now.
    await adapter.update!(readGraphBackfillBatch(wholeSwm, { state: 'dirty', generation: 5 }, [fixture.graphs[9]!]));
    expect(await triplesOf(adapter, wholeSwm)).toEqual([]);
    const [, swm] = fixture.keys as [ReadGraphKey, ReadGraphKey];
    expect(await buildReadGraph(context, swm)).toMatchObject({ outcome: 'done', row: { state: 'ready', generation: 7 } });
    await expectUnion(adapter, layer, fixture, swm);
  });

  it('maintains nothing over an adapter that does not declare its read-graph methods', async () => {
    const { adapter, fixture, layer, store } = await (async () => {
      const opened = await open(undeclared(new OxigraphStore()));
      await opened.adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(opened.fixture.readGraphs.wholeVm, 3)));
      return opened;
    })();
    expect(await startReadGraphs(store, { maintains: () => true })).toEqual({ marked: 1, maintained: 0 });
    expect(await storedRows(adapter)).toEqual({ [fixture.readGraphs.wholeVm]: 'dirty@4' });
    expect(layer.runtime.mirror.size).toBe(0);
  });
});

describe('a store restored to an earlier state', () => {
  it('takes every read graph out of service and rebuilds it from what the store holds', async () => {
    const { adapter, fixture, layer, store, context } = await open();
    const [vm, swm] = fixture.keys as [ReadGraphKey, ReadGraphKey];
    for (const key of [vm, swm]) expect(await buildReadGraph(context, key)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    const { wholeVm, wholeSwm } = fixture.readGraphs;
    // The engine's last snapshot predates the whole-graph VM read graph: neither its row nor its contents are there.
    await adapter.update!(`DELETE WHERE { GRAPH <${fixture.root}/_~read/state> { <${wholeVm}> ?p ?o } }`);
    await adapter.update!(`DROP SILENT GRAPH <${wholeVm}>`);
    noteReadGraphStoreRestored(store);
    for (const readGraph of [wholeVm, wholeSwm]) expect(servingReadGraphGeneration(layer.runtime.mirror.get(readGraph))).toBeUndefined();
    expect(layer.runtime.registries.get(fixture.contextGraphId)).toBeUndefined();
    // The next builds take what the store holds: one row is created again, the other marked dirty from its stored row.
    for (const key of [vm, swm]) {
      expect(await buildReadGraph(context, key)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
      await expectUnion(adapter, layer, fixture, key);
    }
    // A store without the read-graph layer needs nothing.
    expect(() => noteReadGraphStoreRestored(new OxigraphStore())).not.toThrow();
  });

  it('ends a build whose backend restarted between two of its batches, without publishing', async () => {
    const { adapter, fixture, layer, context } = await open();
    let recovery = { generation: 1, ready: true };
    registerStoreRecoveryGeneration(adapter, () => recovery);
    const [vm] = fixture.keys as [ReadGraphKey];
    adapter.onUpdate = (sparql) => {
      // After the first fenced batch, the backend restarts between requests: no request fails.
      if (sparql.includes('readGraphFence')) recovery = { generation: 2, ready: true };
    };
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'lost' });
    adapter.onUpdate = undefined;
    expect((await readStoredReadGraphRow(adapter, fixture.readGraphs.wholeVm)).row?.state).not.toBe('ready');
    expect(servingReadGraphGeneration(layer.runtime.mirror.get(fixture.readGraphs.wholeVm))).toBeUndefined();
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    await expectUnion(adapter, layer, fixture, vm);
  });

  it('keeps a row published while its backend restarted for a start-up mark, and ends the build out of service', async () => {
    const { adapter, fixture, layer, store, context, dataDir } = await open();
    useReadGraphMarkJournal(layer.runtime, dataDir);
    let recovery = { generation: 1, ready: true };
    registerStoreRecoveryGeneration(adapter, () => recovery);
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    const publishing = `<${wholeVm}> <${READ_GRAPH_STATE_PREDICATES.state}> "ready"`;
    adapter.onUpdate = async (sparql) => {
      if (!sparql.split('\n').some((line) => line.startsWith('INSERT {') && line.includes(publishing))) return;
      // The restart lands after the check before the publication, while its request is on its way, and a query
      // sees it first: the publication's own check then finds the restart already seen.
      recovery = { generation: 2, ready: true };
      await store.query('ASK { ?s ?p ?o }');
    };
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'lost' });
    adapter.onUpdate = undefined;
    const stored = (await readStoredReadGraphRow(adapter, wholeVm)).row!;
    expect(stored.state).toBe('ready');
    expect(servingReadGraphGeneration(layer.runtime.mirror.get(wholeVm))).toBeUndefined();
    expect(readUnstoredReadGraphMarks(dataDir)).toEqual(new Map([[wholeVm, new Set([stored.generation])]]));
  });

  it('ends a build whose publication a reported restore overlaps, and keeps the published row for a start-up mark', async () => {
    const { adapter, fixture, layer, store, context, dataDir } = await open();
    useReadGraphMarkJournal(layer.runtime, dataDir);
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    const publishing = `<${wholeVm}> <${READ_GRAPH_STATE_PREDICATES.state}> "ready"`;
    adapter.onUpdate = (sparql) => {
      // The restore is reported while the publication's request is on its way: no recovery generation tells it.
      if (sparql.split('\n').some((line) => line.startsWith('INSERT {') && line.includes(publishing))) noteReadGraphStoreRestored(store);
    };
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'lost' });
    adapter.onUpdate = undefined;
    const stored = (await readStoredReadGraphRow(adapter, wholeVm)).row!;
    expect(stored.state).toBe('ready');
    expect(servingReadGraphGeneration(layer.runtime.mirror.get(wholeVm))).toBeUndefined();
    expect(readUnstoredReadGraphMarks(dataDir)).toEqual(new Map([[wholeVm, new Set([stored.generation])]]));
    // The next process marks that row dirty rather than trust what the restore may have cut short.
    const restarted = guardReadGraphPartition(wrapReadGraphLayer(adapter, { backend: 'oxigraph' }));
    expect(await startReadGraphs(restarted, { dataDir, maintains: () => true })).toMatchObject({ marked: 1 });
  });

  it('ends a build whose first row a reported restore overlaps, and leaves the background slot free', async () => {
    const { adapter, fixture, layer, store, context, dataDir } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    const creating = `<${wholeVm}> <${READ_GRAPH_STATE_PREDICATES.state}> "building"`;
    adapter.onUpdate = (sparql) => {
      // The restore is reported while the request that creates the row is on its way: the cached registry goes.
      if (sparql.split('\n').some((line) => line.startsWith('INSERT {') && line.includes(creating))) noteReadGraphStoreRestored(store);
    };
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'lost' });
    adapter.onUpdate = undefined;
    expect(servingReadGraphGeneration(layer.runtime.mirror.get(wholeVm))).toBeUndefined();
    // Nothing still holds the read graph's lock or the background slot: a builder's pass builds it, and the builder closes.
    const builder = new ReadGraphBuilder({ store, dataDir, wanted: () => [vm], batching: { pauseRatio: 0 }, intervalMs: 60_000 });
    builder.start();
    await builder.whenIdle();
    expect(layer.runtime.mirror.get(wholeVm)?.state).toBe('ready');
    await builder.close();
    await expectUnion(adapter, layer, fixture, vm);
  });

  it('takes every read graph out of service once a supervised backend tells of a restart, before the next query is served', async () => {
    const { adapter, fixture, layer, store, context } = await open();
    let recovery = { generation: 1, ready: true };
    registerStoreRecoveryGeneration(adapter, () => recovery);
    const [vm] = fixture.keys as [ReadGraphKey];
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    const { wholeVm } = fixture.readGraphs;
    await store.query('ASK { ?s ?p ?o }');
    expect(servingReadGraphGeneration(layer.runtime.mirror.get(wholeVm))).toBeDefined();
    // The worker exits and its replacement reloads a snapshot from before the build.
    recovery = { generation: 2, ready: true };
    await adapter.update!(`DELETE WHERE { GRAPH <${fixture.root}/_~read/state> { <${wholeVm}> ?p ?o } }`);
    await adapter.update!(`DROP SILENT GRAPH <${wholeVm}>`);
    await store.query('ASK { ?s ?p ?o }');
    expect(servingReadGraphGeneration(layer.runtime.mirror.get(wholeVm))).toBeUndefined();
    expect(layer.runtime.registries.get(fixture.contextGraphId)).toBeUndefined();
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    await expectUnion(adapter, layer, fixture, vm);
  });

  it('keeps a read graph out of service from a restart seen before the backend is ready until a build after it', async () => {
    const { adapter, fixture, layer, store, context } = await open();
    let recovery = { generation: 1, ready: true };
    registerStoreRecoveryGeneration(adapter, () => recovery);
    const [vm] = fixture.keys as [ReadGraphKey];
    const { wholeVm } = fixture.readGraphs;
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    const late = q('urn:s:late', '"late"', fixture.graphs[1]!);
    await store.insert([late]);
    // The worker exits, and its replacement reloads a snapshot from before that write: the member graph lacks it,
    // the read graph still holds it. A query sees the new generation while the replacement is not ready yet.
    recovery = { generation: 2, ready: false };
    await adapter.delete([late]);
    await store.query('ASK { ?s ?p ?o }');
    expect(servingReadGraphGeneration(layer.runtime.mirror.get(wholeVm))).toBeUndefined();
    // Ready at the generation already seen is no new restart, and puts nothing back into service.
    recovery = { generation: 2, ready: true };
    await store.query('ASK { ?s ?p ?o }');
    expect(servingReadGraphGeneration(layer.runtime.mirror.get(wholeVm))).toBeUndefined();
    // A build after it takes what the store holds, and serves.
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
    expect(servingReadGraphGeneration(layer.runtime.mirror.get(wholeVm))).toBeDefined();
    await expectUnion(adapter, layer, fixture, vm);
  });
});

describe('the read-graph builder', () => {
  it('builds the read graphs a node wants and the ones in the mirror that are not ready', async () => {
    const { adapter, fixture, layer, store, dataDir } = await open();
    const { wholeVm, wholeSwm } = fixture.readGraphs;
    const [vm, swm, code, wm] = fixture.keys as [ReadGraphKey, ReadGraphKey, ReadGraphKey, ReadGraphKey];
    const dirty = row(wholeSwm, 'dirty', 2);
    await adapter.update!(readGraphStateCompareAndSet(undefined, dirty));
    layer.runtime.mirror.set(dirty);
    const logs: string[] = [];
    const builder = new ReadGraphBuilder({ store, dataDir, wanted: () => [vm, code, wm], batching: { pauseRatio: 0 }, intervalMs: 60_000, log: (line) => logs.push(line) });
    builder.start();
    await builder.whenIdle();
    for (const key of [vm, swm, code, wm]) {
      expect(layer.runtime.mirror.get(readGraphIri(key))?.state).toBe('ready');
      await expectUnion(adapter, layer, fixture, key);
    }
    expect(logs).toHaveLength(4);
    expect(logs.find((line) => line.includes(wholeVm))).toMatch(/batch\(es\), \d+ triple\(s\)$/);
    expect(builder.status()).toMatchObject({ running: false, building: undefined, pending: 0, retrying: [], lastJob: { outcome: 'done' } });
    await builder.close();
  });

  it('rebuilds ready read graphs whose membership a registry change moved', async () => {
    const { adapter, fixture, layer, store } = await open();
    const [vm, , code] = fixture.keys as [ReadGraphKey, ReadGraphKey, ReadGraphKey];
    const { wholeVm, codeVm } = fixture.readGraphs;
    const warnings: string[] = [];
    const builder = new ReadGraphBuilder({ store, wanted: () => [vm, code], batching: { pauseRatio: 0 }, intervalMs: 60_000, warn: (line) => warnings.push(line) });
    builder.start();
    await builder.whenIdle();
    expect(await triplesOf(adapter, wholeVm)).toContain(`urn:s:3 ${P} "v3"`);
    // The sub-graph's registration goes; its data stays.
    await adapter.delete(fixture.facts.filter((quad) => quad.subject === `${fixture.root}/code`));
    builder.request();
    await builder.whenIdle();
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual([]);
    expect(layer.runtime.mirror.get(wholeVm)?.state).toBe('ready');
    expect(await triplesOf(adapter, wholeVm)).not.toContain(`urn:s:3 ${P} "v3"`);
    expect(await triplesOf(adapter, codeVm)).toEqual([]);
    expect(warnings).toEqual([]);
    // A registry that cannot be read is reported, and the pass goes on.
    const query = adapter.query.bind(adapter);
    adapter.query = (sparql, options) => (sparql.includes('ontology/SubGraph') ? Promise.reject(new Error('down')) : query(sparql, options));
    builder.request();
    await builder.whenIdle();
    expect(warnings).toEqual([expect.stringContaining('could not be read: down')]);
    adapter.query = query;
    await builder.close();
  });

  it('tries a failed build again later, after a delay that grows', async () => {
    const { adapter, fixture, layer, store } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    let failing = true;
    adapter.onUpdate = (sparql) => {
      if (failing && sparql.includes('VALUES ?g')) throw new Error('store unavailable');
    };
    let now = 1_000_000;
    const warnings: string[] = [];
    const builder = new ReadGraphBuilder({ store, wanted: () => [vm], batching: { pauseRatio: 0 }, now: () => now, warn: (line) => warnings.push(line) });
    builder.start();
    await builder.whenIdle();
    expect(warnings).toEqual([`Read graph ${fixture.readGraphs.wholeVm} could not be built: store unavailable`]);
    expect(builder.status().retrying).toEqual([{ readGraph: fixture.readGraphs.wholeVm, attempts: 1, retryAt: now + 1_000, error: 'store unavailable' }]);
    builder.request();
    await builder.whenIdle();
    expect(warnings).toHaveLength(1);
    now += 1_000;
    builder.request();
    await builder.whenIdle();
    expect(builder.status().retrying[0]).toMatchObject({ attempts: 2, retryAt: now + 2_000 });
    failing = false;
    now += 2_000;
    builder.request();
    await builder.whenIdle();
    expect(builder.status().retrying).toEqual([]);
    expect(layer.runtime.mirror.get(fixture.readGraphs.wholeVm)?.state).toBe('ready');
    await builder.close();
  });

  it('runs a pass at each interval after the first, which builds what is wanted since, and none once closed', async () => {
    const { fixture, layer, store, dataDir } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    let wanted: ReadGraphKey[] = [];
    let passes = 0;
    const builder = new ReadGraphBuilder({ store, dataDir, wanted: () => { passes += 1; return wanted; }, batching: { pauseRatio: 0 }, intervalMs: 20 });
    builder.start();
    await builder.whenIdle();
    expect(layer.runtime.mirror.get(readGraphIri(vm))).toBeUndefined();
    // Wanted after the first pass: a later one builds it, with no request.
    wanted = [vm];
    for (let wait = 0; wait < 200 && layer.runtime.mirror.get(readGraphIri(vm))?.state !== 'ready'; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(layer.runtime.mirror.get(readGraphIri(vm))?.state).toBe('ready');
    await builder.close();
    const closed = passes;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(passes).toBe(closed);
  });

  it('aborts the build in progress on close, and leaves the read graph out of service', async () => {
    const { adapter, fixture, layer, store } = await open();
    const [vm] = fixture.keys as [ReadGraphKey];
    let entered!: () => void;
    const inBatch = new Promise<void>((resolve) => { entered = resolve; });
    adapter.onUpdate = (sparql, options) => {
      if (!sparql.includes('VALUES ?g')) return;
      entered();
      return new Promise<void>((_, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
    };
    const builder = new ReadGraphBuilder({ store, wanted: () => [vm], batching: { pauseRatio: 0 } });
    builder.start();
    await inBatch;
    await builder.close();
    expect(layer.runtime.mirror.get(fixture.readGraphs.wholeVm)?.state).toBe('building');
    expect(builder.status().running).toBe(false);
  });

  it('runs build jobs one at a time per backend, whoever starts them', async () => {
    const { adapter, fixture, context } = await open();
    const [vm, swm] = fixture.keys as [ReadGraphKey, ReadGraphKey];
    const { wholeVm, wholeSwm } = fixture.readGraphs;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding = false;
    adapter.onUpdate = async (sparql) => {
      if (!holding && sparql.includes('VALUES ?g') && sparql.includes(`<${wholeVm}>`)) {
        holding = true;
        await held;
      }
    };
    adapter.requests.length = 0;
    const first = buildReadGraph(context, vm);
    for (let turn = 0; turn < 50 && !holding; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(holding).toBe(true);
    const second = buildReadGraph(context, swm);
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(adapter.requests.some((request) => request.includes(wholeSwm))).toBe(false);
    release();
    expect(await first).toMatchObject({ outcome: 'done' });
    expect(await second).toMatchObject({ outcome: 'done' });
  });

  it('runs heavy background work one job at a time per backend', async () => {
    const { layer } = await open();
    const order: string[] = [];
    let release!: () => void;
    const first = withReadGraphBackgroundSlot(layer.runtime, async () => {
      order.push('first:start');
      await new Promise<void>((resolve) => { release = resolve; });
      order.push('first:end');
    });
    const second = withReadGraphBackgroundSlot(layer.runtime, async () => { order.push('second'); });
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['first:start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('reports a pass that fails, and runs the next one', async () => {
    const { store } = await open();
    const warnings: string[] = [];
    let calls = 0;
    const builder = new ReadGraphBuilder({ store, wanted: () => { calls += 1; throw new Error('no subscriptions yet'); }, warn: (line) => warnings.push(line) });
    builder.start();
    await builder.whenIdle();
    builder.request();
    await builder.whenIdle();
    expect(calls).toBe(2);
    expect(warnings).toEqual(['Read-graph build pass failed: no subscriptions yet', 'Read-graph build pass failed: no subscriptions yet']);
    await builder.close();
  });

  it('does nothing on a store without the read-graph layer', async () => {
    const builder = new ReadGraphBuilder({ store: new OxigraphStore(), wanted: () => { throw new Error('not asked'); } });
    builder.start();
    await builder.whenIdle();
    expect(builder.status().lastJob).toBeUndefined();
    await builder.close();
  });
});
