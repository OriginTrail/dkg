import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readGraphIri, readGraphStateGraphIri, readScope, MemoryLayer } from '@origintrail-official/dkg-core';
import {
  ATOMIC_GRAPH_REPLACE_STAGING_PREFIX,
  BlazegraphStore,
  GraphSetIndexStore,
  OxigraphStore,
  SparqlHttpStore,
  createTripleStore,
  type Quad,
  type TripleStore,
} from '../src/index.js';
import {
  isReadGraphPartitionGraph,
  isStorageHiddenGraph,
  storeGraphEnumerationVisibility,
} from '../src/graph-enumeration-visibility.js';
import {
  READ_GRAPH_PARTITION_WRITE_CODE,
  ReadGraphPartitionStore,
  ReadGraphPartitionWriteError,
  dropReadGraphPartitions,
  readGraphPartitionMaintenanceStore,
} from '../src/read-graph-partition-store.js';
import { sparqlNamesReadGraphPartition } from '../src/read-graph-partition-reference.js';
import {
  clearReadGraphPartitionsNote,
  mayHoldReadGraphPartitions,
  noteReadGraphPartitions,
  readGraphPartitionsMarkerPath,
} from '../src/read-graph-partition-marker.js';
import { listStoredContextGraphOwnerCandidates } from '../src/stored-context-graph-owners.js';
import { isStoreOperationNotStarted } from '../src/store-operation-outcome.js';
import { authorCommitInput, P_VALUE, SEAL } from './rfc64-author-commit-cas-harness.js';

const CG = 'partition-test';
const ROOT = `did:dkg:context-graph:${CG}`;
const ASSET = `${ROOT}/_verifiable_memory/0xabc/1`;
const SWM = `${ROOT}/_shared_memory/0xabc/1`;
const META = `${ROOT}/_meta`;
const VM_READ = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
const SWM_READ = readGraphIri({ scope: readScope(CG, 'code'), layer: MemoryLayer.SharedWorkingMemory });
const STATE = readGraphStateGraphIri(CG);
const STRAY = `${ROOT}/_read/stray/graph`;
const PARTITION_GRAPHS = [VM_READ, SWM_READ, STATE, STRAY];

function quad(graph: string, subject = 'urn:s', object = '"v"'): Quad {
  return { graph, subject, predicate: 'urn:p', object };
}

const memberQuads = [quad(ASSET), quad(SWM, 'urn:t'), quad(META, 'urn:m')];
const plantedQuads = [
  quad(VM_READ), quad(SWM_READ, 'urn:t'), quad(STRAY, 'urn:x'),
  quad(STATE, VM_READ, '"ready"'),
];

/** The same store contents, with read graphs planted below the guard in one of them. */
async function storePair(): Promise<{ plain: TripleStore; planted: TripleStore }> {
  const plain = await createTripleStore({ backend: 'oxigraph' });
  const planted = await createTripleStore({ backend: 'oxigraph' });
  await plain.insert(memberQuads);
  await planted.insert(memberQuads);
  await readGraphPartitionMaintenanceStore(planted).insert(plantedQuads);
  return { plain, planted };
}

const opened: TripleStore[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map(store => store.close()));
});

describe('read-graph partition names in storage', () => {
  it('hides the partition and staging graphs, and nothing that only looks alike', () => {
    for (const graph of [...PARTITION_GRAPHS, `${ROOT}/_read`, `did:dkg:context-graph:a/b/_read/cg/_verifiable_memory`]) {
      expect(isReadGraphPartitionGraph(graph), graph).toBe(true);
      expect(isStorageHiddenGraph(graph), graph).toBe(true);
      expect(storeGraphEnumerationVisibility(graph), graph).toBe(false);
    }
    expect(isStorageHiddenGraph(`${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}x`)).toBe(true);
    for (const graph of [ASSET, SWM, META, ROOT, `${ROOT}/_reader/x`, `${ROOT}/read/x`, 'urn:x:_read',
      'did:dkg:context-graph:_read', `${ROOT}/code/_verifiable_memory/0xabc/1`]) {
      expect(isReadGraphPartitionGraph(graph), graph).toBe(false);
      expect(storeGraphEnumerationVisibility(graph), graph).toBe(true);
    }
    expect(storeGraphEnumerationVisibility('')).toBe(false);
  });

  it('gives every adapter the shared enumeration predicate', () => {
    const blazegraph = new BlazegraphStore('http://127.0.0.1:1/blazegraph/namespace/kb/sparql');
    const http = new SparqlHttpStore({ queryEndpoint: 'http://127.0.0.1:1/query' });
    const oxigraph = new OxigraphStore();
    opened.push(oxigraph);
    for (const store of [blazegraph, http, oxigraph]) {
      expect(store.graphEnumerationVisibility).toBe(storeGraphEnumerationVisibility);
    }
  });

  it('finds partition graphs named in SPARQL text by IRI, prefix or escape', () => {
    expect(sparqlNamesReadGraphPartition(`DROP GRAPH <${VM_READ}>`)).toBe(true);
    expect(sparqlNamesReadGraphPartition(`PREFIX r: <${ROOT}/> CLEAR GRAPH r:_read`)).toBe(true);
    expect(sparqlNamesReadGraphPartition(`PREFIX r: <${ROOT}/> CLEAR GRAPH r:\\_read\\/state`)).toBe(true);
    expect(sparqlNamesReadGraphPartition(`DROP GRAPH <${ROOT}/\\u005Fread/state>`)).toBe(true);
    expect(sparqlNamesReadGraphPartition(`BASE <${ROOT}/> DROP GRAPH <_read/state>`)).toBe(true);
    expect(sparqlNamesReadGraphPartition('DROP GRAPH <unterminated')).toBe(false);
    // Text it cannot read through counts as naming the partition.
    expect(sparqlNamesReadGraphPartition('INSERT DATA { GRAPH <urn:g> { <urn:s> <urn:p> "_read } }')).toBe(true);
    expect(sparqlNamesReadGraphPartition('DROP GRAPH <urn:x\\uZZZZ>')).toBe(true);
    expect(sparqlNamesReadGraphPartition(`INSERT DATA { GRAPH <${ASSET}> { <urn:s> <urn:p> "_read" } }`)).toBe(false);
    expect(sparqlNamesReadGraphPartition(`DROP GRAPH <${ROOT}/_reader/x>`)).toBe(false);
    expect(sparqlNamesReadGraphPartition(`PREFIX r: <${ROOT}/> CLEAR GRAPH r:reader`)).toBe(false);
  });
});

describe('the read-graph partition guard', () => {
  it('sits directly above every adapter the factory builds', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    opened.push(store);
    const guard = (store as GraphSetIndexStore).innerStore;
    expect(guard).toBeInstanceOf(ReadGraphPartitionStore);
    expect(readGraphPartitionMaintenanceStore(store)).toBeInstanceOf(OxigraphStore);
    const adapter = new OxigraphStore();
    opened.push(adapter);
    expect(readGraphPartitionMaintenanceStore(adapter)).toBe(adapter);
  });

  it('refuses every write that names a partition graph before it reaches the store', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    opened.push(store);
    await store.insert(memberQuads);
    const asset = { graphUri: ASSET, graphQuads: [quad(ASSET)], metaGraphUri: META, metadataSubject: 'urn:m', metadataQuads: [quad(META, 'urn:m')] };
    const refusals: Array<[string, () => Promise<unknown>]> = [
      ['insert', () => store.insert([quad(ASSET), quad(VM_READ)])],
      ['delete', () => store.delete([quad(STATE)])],
      ['deleteByPattern', () => store.deleteByPattern({ graph: VM_READ })],
      ['deleteByPattern', () => store.deleteByPatternWithoutCount!({ graph: SWM_READ })],
      ['deleteBySubjectPrefix', () => store.deleteBySubjectPrefix(VM_READ, 'urn:')],
      ['dropGraph', () => store.dropGraph(STATE)],
      ['createGraph', () => store.createGraph(STRAY)],
      ['replaceGraph', () => store.replaceGraph!(VM_READ, [quad(VM_READ)])],
      ['replaceGraph', () => store.replaceGraph!(ASSET, [quad(VM_READ)])],
      ['replaceAssetGroup', () => store.replaceAssetGroup!([{ ...asset, metaGraphUri: STATE, metadataQuads: [quad(STATE, 'urn:m')] }])],
      ['replaceAssetGroup', () => store.replaceAssetGroup!([{ ...asset, graphQuads: [quad(VM_READ)] }])],
      ['replaceGraphAndSubject', () => store.replaceGraphAndSubject!(VM_READ, [], META, 'urn:m', [])],
      ['replaceGraphAndSubject', () => store.replaceGraphAndSubject!(ASSET, [], STATE, 'urn:m', [])],
      ['replaceSubject', () => store.replaceSubject!(STATE, VM_READ, [quad(STATE, VM_READ)])],
      ['replaceSubjectAndInsert', () => store.replaceSubjectAndInsert!(STATE, VM_READ, [quad(STATE, VM_READ)], [quad(STATE, 'urn:n')])],
      ['update', () => store.update!(`DROP SILENT GRAPH <${STATE}>`)],
      ['update', () => store.update!('CLEAR SILENT DEFAULT', { touchedGraphs: [VM_READ] })],
      ['query', () => store.query(`INSERT DATA { GRAPH <${STRAY}> { <urn:s> <urn:p> "v" } }`)],
    ];
    for (const [operation, write] of refusals) {
      const error = await write().then(() => undefined, (caught: unknown) => caught);
      expect(error, operation).toBeInstanceOf(ReadGraphPartitionWriteError);
      expect((error as ReadGraphPartitionWriteError).code).toBe(READ_GRAPH_PARTITION_WRITE_CODE);
      expect(isStoreOperationNotStarted(error, operation as Parameters<typeof isStoreOperationNotStarted>[1]), operation).toBe(true);
    }
    expect(await store.countQuads()).toBe(memberQuads.length);
    expect(await readGraphPartitionMaintenanceStore(store).countQuads()).toBe(memberQuads.length);
  });

  it('checks every graph an RFC-64 author commit names', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    opened.push(store);
    const intoPartition = authorCommitInput({ authorSealGraph: STATE,
      authorSealQuads: [{ subject: SEAL, predicate: P_VALUE, object: '"x"', graph: STATE }] });
    const error = await store.rfc64AuthorCommitCasV1!(intoPartition).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReadGraphPartitionWriteError);
    expect(isStoreOperationNotStarted(error, 'rfc64AuthorCommitCasV1')).toBe(true);
    // An ordinary commit reaches the adapter; with nothing stored yet its guard does not match.
    expect(await store.rfc64AuthorCommitCasV1!(authorCommitInput())).toBe('conflict');
    // An input the canonical plan refuses is left to the adapter to refuse.
    const adapter = new OxigraphStore();
    opened.push(adapter);
    const refused = await new ReadGraphPartitionStore(adapter).rfc64AuthorCommitCasV1!({} as never)
      .then(() => undefined, (caught: unknown) => caught);
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(ReadGraphPartitionWriteError);
  });

  it('passes ordinary writes and reads of the partition through', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    opened.push(store);
    await store.insert(memberQuads);
    await store.update!(`INSERT DATA { GRAPH <${ASSET}> { <urn:s> <urn:p> "w" } }`, { touchedGraphs: [ASSET] });
    await store.update!(`DELETE DATA { GRAPH <${ASSET}> { <urn:s> <urn:p> "w" } }`);
    await store.replaceSubject!(META, 'urn:m', [quad(META, 'urn:m', '"x"')]);
    expect(await store.deleteByPattern({ graph: SWM })).toBe(1);
    await readGraphPartitionMaintenanceStore(store).insert(plantedQuads);
    const read = await store.query(`SELECT ?o WHERE { GRAPH <${VM_READ}> { ?s ?p ?o } }`);
    expect(read.type === 'bindings' && read.bindings.length).toBe(1);
  });

  it('answers that partition graphs are absent while the adapter holds them', async () => {
    const { plain, planted } = await storePair();
    opened.push(plain, planted);
    for (const graph of PARTITION_GRAPHS) {
      expect(await planted.hasGraph(graph), graph).toBe(false);
      expect(await planted.countQuads(graph), graph).toBe(0);
      expect(await readGraphPartitionMaintenanceStore(planted).hasGraph(graph), graph).toBe(true);
    }
    expect(await planted.hasGraph(ASSET)).toBe(true);
    expect(await planted.listGraphs()).toEqual(await plain.listGraphs());
    expect(await planted.listGraphsByPrefix!(`${ROOT}/`)).toEqual(await plain.listGraphsByPrefix!(`${ROOT}/`));
    expect(await planted.readGraphInventory!(ROOT, {})).toEqual(await plain.readGraphInventory!(ROOT, {}));
    // The adapter lists in its own order, which depends on what was inserted.
    expect((await readGraphPartitionMaintenanceStore(planted).listGraphs()).sort())
      .toEqual((await readGraphPartitionMaintenanceStore(plain).listGraphs()).sort());
  });

  it('exposes each optional capability exactly when the store below has it', () => {
    const blazegraph = new BlazegraphStore('http://127.0.0.1:1/blazegraph/namespace/kb/sparql');
    const guarded = new ReadGraphPartitionStore(blazegraph);
    for (const capability of ['update', 'readGraphInventory', 'listGraphsByPrefix', 'flush'] as const) {
      expect(typeof guarded[capability], capability).toBe(typeof blazegraph[capability as keyof BlazegraphStore]);
    }
    for (const capability of ['replaceGraph', 'replaceAssetGroup', 'replaceGraphAndSubject', 'replaceSubject',
      'replaceSubjectAndInsert', 'rfc64AuthorCommitCasV1', 'deleteByPatternWithoutCount'] as const) {
      expect(typeof guarded[capability], capability).toBe('function');
    }
    expect(guarded.queryCancellation).toBe(blazegraph.queryCancellation);
    expect(guarded.getPressureSnapshot()).toEqual(blazegraph.getPressureSnapshot());
    const bare = new ReadGraphPartitionStore({ graphEnumerationVisibility: undefined } as unknown as TripleStore);
    expect(bare.graphEnumerationVisibility).toBeUndefined();
  });

  it('keeps the graph catalog free of partition graphs through every refresh', async () => {
    const base = new OxigraphStore();
    opened.push(base);
    await base.insert([...memberQuads, ...plantedQuads]);
    const indexed = new GraphSetIndexStore(new ReadGraphPartitionStore(base), { revalidateMs: 0 });
    expect(await indexed.listGraphs()).toEqual(expect.not.arrayContaining(PARTITION_GRAPHS));
    expect(await indexed.listGraphsByPrefix(`${ROOT}/_read`)).toEqual([]);
    expect(await indexed.hasGraph(VM_READ)).toBe(false);
    expect(indexed.graphEnumerationVisibility?.(VM_READ)).toBe(false);
    expect(indexed.graphEnumerationVisibility?.(ASSET)).toBe(true);
    const passthrough = new GraphSetIndexStore(base, { enabled: false });
    expect(await passthrough.listGraphsByPrefix(ROOT)).toEqual(expect.not.arrayContaining(PARTITION_GRAPHS));
  });
});

describe('dropping read-graph partitions', () => {
  it('drops every partition graph, state first, and nothing else', async () => {
    const { plain, planted } = await storePair();
    opened.push(plain, planted);
    const adapter = readGraphPartitionMaintenanceStore(planted);
    const dropped: string[] = [];
    const dropGraph = adapter.dropGraph.bind(adapter);
    adapter.dropGraph = async (graph, options) => { dropped.push(graph); return dropGraph(graph, options); };
    expect(await dropReadGraphPartitions(planted)).toBe(PARTITION_GRAPHS.length);
    expect(dropped.slice(0, 2).sort()).toEqual([STATE, STRAY].sort());
    expect(dropped.slice(2).sort()).toEqual([VM_READ, SWM_READ].sort());
    expect(await adapter.countQuads()).toBe(memberQuads.length);
    expect((await adapter.listGraphs()).sort()).toEqual((await readGraphPartitionMaintenanceStore(plain).listGraphs()).sort());
    expect(await dropReadGraphPartitions(plain)).toBe(0);
  });

  it('refuses an enumeration that is not a graph list', async () => {
    const store = new OxigraphStore();
    opened.push(store);
    store.query = async () => ({ type: 'boolean', value: true });
    await expect(dropReadGraphPartitions(store)).rejects.toThrow('expected graph bindings');
  });

  it('keeps a note in the data directory while a store may hold partitions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'read-graph-marker-'));
    try {
      expect(mayHoldReadGraphPartitions(dir)).toBe(false);
      noteReadGraphPartitions(dir);
      expect(readGraphPartitionsMarkerPath(dir)).toBe(join(dir, 'read-graph-partitions'));
      expect(mayHoldReadGraphPartitions(dir)).toBe(true);
      clearReadGraphPartitionsNote(dir);
      clearReadGraphPartitionsNote(dir);
      expect(mayHoldReadGraphPartitions(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('stored owners of read-graph partitions', () => {
  it('maps a partition graph to the context graph that holds it', async () => {
    const graphs = [VM_READ, STATE, 'did:dkg:context-graph:org/team/_read/sub/code/_shared_memory'];
    const store = { listGraphs: async () => graphs } as unknown as TripleStore;
    const owners = await listStoredContextGraphOwnerCandidates(store, {});
    expect(owners.sort()).toEqual([CG, 'org', 'org/team'].sort());
  });

  it('reads the same owners with and without planted read graphs', async () => {
    const { plain, planted } = await storePair();
    opened.push(plain, planted);
    expect(await listStoredContextGraphOwnerCandidates(planted, {}))
      .toEqual(await listStoredContextGraphOwnerCandidates(plain, {}));
  });
});

describe('unscoped reads on embedded Oxigraph', () => {
  const PER_GRAPH = 'SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g ORDER BY ?g';

  it('leaves hidden graphs out of the dataset when asked with an empty withheld list', async () => {
    const { plain, planted } = await storePair();
    opened.push(plain, planted);
    await readGraphPartitionMaintenanceStore(planted).insert([quad(`${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}orphan`)]);
    const withheld = { withheldGraphRoots: [] };
    expect(await planted.query(PER_GRAPH, withheld)).toEqual(await plain.query(PER_GRAPH, withheld));
    const unrestricted = await planted.query(PER_GRAPH);
    expect(unrestricted.type === 'bindings' && unrestricted.bindings.length).toBe(memberQuads.length + PARTITION_GRAPHS.length + 1);
  });
});
