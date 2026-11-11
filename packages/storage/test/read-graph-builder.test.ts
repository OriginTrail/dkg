import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, readGraphIri, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { mayHoldReadGraphPartitions } from '../src/read-graph-partition-marker.js';
import { missingReadGraphMethods } from '../src/read-graph/adapter-contract.js';
import { guardReadGraphPartition, storeMayHoldReadGraphPartitions } from '../src/read-graph-partition-store.js';
import { ReadGraphBuilder } from '../src/read-graph/builder.js';
import { readGraphMembership, type GraphNameTest } from '../src/read-graph/membership.js';
import { wrapReadGraphLayer, type ReadGraphStore } from '../src/read-graph/read-graph-store.js';
import {
  buildReadGraph,
  installWorkingMemoryIdentity,
  markReadGraphDirty,
  readGraphEnumerationRoots,
  readStoredReadGraphRow,
  removeReadGraph,
  repairReadGraph,
  ReadGraphJobError,
  withReadGraphBackgroundSlot,
  type ReadGraphJobContext,
} from '../src/read-graph/rebuild.js';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  MAX_READ_GRAPH_GENERATION,
  parseReadGraphStateRows,
  readGraphStateCompareAndSet,
  readGraphStateMarkDirtyAtStart,
  readGraphStateRowQuery,
  readGraphStateRowsQuery,
  type ReadGraphStateRow,
} from '../src/read-graph/state.js';
import { readGraphBackfillBatch, readGraphFencedDrop, readGraphHoldsTripleAsk } from '../src/read-graph/statements.js';
import { startReadGraphs } from '../src/read-graph/startup.js';
import type { Quad, QueryOptions, TripleStore, UpdateOptions } from '../src/triple-store.js';
import { AGENT, isLayerMember, layerFixture, P, q, readyRow, type LayerFixture } from './helpers/read-graph-layer-conformance.js';
import { PlanningOxigraphStore } from './helpers/read-graph-planning-store.js';

/**
 * An adapter that offers only the methods it plans, as an adapter with
 * read-graph support does, and lets a test act on each update before it is
 * sent and list graph names the engine itself would refuse.
 */
class HookedStore extends PlanningOxigraphStore {
  onUpdate: ((sparql: string, options: UpdateOptions | undefined) => Promise<void> | void) | undefined;
  onInsert: (() => Promise<void>) | undefined;
  readonly extraGraphs: string[] = [];
  constructor() {
    super();
    for (const method of missingReadGraphMethods(this, this.readGraphCapabilities)) {
      Object.defineProperty(this, method, { value: undefined, configurable: true, writable: true });
    }
  }
  override async listGraphs(options?: QueryOptions): Promise<string[]> {
    return [...(await super.listGraphs(options)), ...this.extraGraphs];
  }
  override async update(sparql: string, options?: UpdateOptions): Promise<void> {
    await this.onUpdate?.(sparql, options);
    return super.update(sparql, options);
  }
  override async insert(quads: Quad[], options?: QueryOptions): Promise<void> {
    await this.onInsert?.();
    return super.insert(quads, options);
  }
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
    adapter.extraGraphs.push(`${fixture.root}/_verifiable_memory/${AGENT}/a{b`);
    await expect(buildReadGraph(context, vm)).rejects.toBeInstanceOf(ReadGraphJobError);
    expect(layer.runtime.mirror.get(fixture.readGraphs.wholeVm)?.state).toBe('building');
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
    const unable = wrapReadGraphLayer(new OxigraphStore(), { backend: 'oxigraph' });
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
  it('marks working-memory read graphs dirty when the identity changes, and only then', async () => {
    const { adapter, fixture, layer, context } = await open();
    const { wholeVm, agentWm } = fixture.readGraphs;
    for (const readGraph of [wholeVm, agentWm]) {
      await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(readGraph, 4)));
      layer.runtime.mirror.set(readyRow(readGraph, 4));
    }
    const other = `0x${'cd'.repeat(20)}`;
    await installWorkingMemoryIdentity(context, { defaultAgentAddress: AGENT, peerId: 'peer-1' });
    await installWorkingMemoryIdentity(context, { defaultAgentAddress: AGENT, peerId: 'peer-1' });
    expect(layer.runtime.mirror.get(agentWm)).toEqual(readyRow(agentWm, 4));
    expect(layer.runtime.workingMemoryIdentity.addressesOf(AGENT)).toHaveLength(2);
    await installWorkingMemoryIdentity(context, { defaultAgentAddress: other, peerId: 'peer-1' });
    expect(layer.runtime.mirror.get(agentWm)).toEqual(row(agentWm, 'dirty', 5));
    expect(layer.runtime.mirror.get(wholeVm)).toEqual(readyRow(wholeVm, 4));
    expect(await storedRows(adapter)).toEqual({ [wholeVm]: 'ready@4', [agentWm]: 'dirty@5' });
    expect(layer.runtime.workingMemoryIdentity.addressesOf(AGENT)).toEqual([AGENT]);
    await installWorkingMemoryIdentity({ store: new OxigraphStore() }, { defaultAgentAddress: AGENT });
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
      const opened = await open(new OxigraphStore());
      await opened.adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(opened.fixture.readGraphs.wholeVm, 3)));
      return opened;
    })();
    expect(await startReadGraphs(store, { maintains: () => true })).toEqual({ marked: 1, maintained: 0 });
    expect(await storedRows(adapter)).toEqual({ [fixture.readGraphs.wholeVm]: 'dirty@4' });
    expect(layer.runtime.mirror.size).toBe(0);
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
