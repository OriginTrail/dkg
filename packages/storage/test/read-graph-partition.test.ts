import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextGraphStorageOwnerCandidates, READ_GRAPH_SEGMENT, readGraphIri, readGraphStateGraphIri, readScope, MemoryLayer } from '@origintrail-official/dkg-core';
import {
  ATOMIC_GRAPH_REPLACE_STAGING_PREFIX,
  BlazegraphStore,
  GraphSetIndexStore,
  OxigraphStore,
  OxigraphWorkerStore,
  SparqlHttpStore,
  createTripleStore,
  type Quad,
  type TripleStore,
} from '../src/index.js';
import {
  isReadGraphPartitionGraph,
  isReadGraphStateGraph,
  isStorageHiddenGraph,
  readGraphPartitionOwner,
  storeGraphEnumerationVisibility,
} from '../src/graph-enumeration-visibility.js';
import {
  READ_GRAPH_PARTITION_WRITE_CODE,
  ReadGraphPartitionStore,
  isReadGraphPartitionWriteTarget,
  ReadGraphPartitionWriteError,
  dropReadGraphPartitions,
  noteStoreMayHoldReadGraphPartitions,
  readGraphPartitionMaintenanceStore,
  storeMayHoldReadGraphPartitions,
} from '../src/read-graph-partition-store.js';
import { sparqlNamesReadGraphPartition, sparqlUpdateMayWriteReadGraphPartition, sparqlUpdateReach } from '../src/read-graph-partition-reference.js';
import {
  clearReadGraphPartitionsNote,
  mayHoldReadGraphPartitions,
  noteReadGraphPartitions,
  readGraphPartitionsMarkerPath,
} from '../src/read-graph-partition-marker.js';
import { listStoredContextGraphOwnerCandidates } from '../src/stored-context-graph-owners.js';
import { isStoreOperationNotStarted } from '../src/store-operation-outcome.js';
import { isQueryDatasetUnrestrictedError } from '../src/withheld-graph-query.js';
import { authorCommitInput, P_VALUE, SEAL } from './rfc64-author-commit-cas-harness.js';

const CG = 'partition-test';
const ROOT = `did:dkg:context-graph:${CG}`;
const ASSET = `${ROOT}/_verifiable_memory/0xabc/1`;
const SWM = `${ROOT}/_shared_memory/0xabc/1`;
const META = `${ROOT}/_meta`;
const VM_READ = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
const SWM_READ = readGraphIri({ scope: readScope(CG, 'code'), layer: MemoryLayer.SharedWorkingMemory });
const STATE = readGraphStateGraphIri(CG);
// A graph under the partition that no read graph is named after is still the partition's.
const STRAY = `${ROOT}/${READ_GRAPH_SEGMENT}/stray/graph`;
const PARTITION_GRAPHS = [VM_READ, SWM_READ, STATE, STRAY];
// Ordinary graphs of context graphs whose IDs have a `_read` segment, one of
// them named like a read graph would be under that segment.
const LEGACY_ASSET = `${ROOT}/_read/project/_verifiable_memory/0xaa/1`;
const LEGACY_SHARED = `${ROOT}/_read/cg/_shared_memory`;

const COMMENTED_GRAPH_VARIABLE = 'DELETE { GRAPH # comment\n ?g { ?s ?p ?o } } WHERE { GRAPH # comment\n ?g { ?s ?p ?o } }';

function quad(graph: string, subject = 'urn:s', object = '"v"'): Quad {
  return { graph, subject, predicate: 'urn:p', object };
}

const memberQuads = [quad(ASSET), quad(SWM, 'urn:t'), quad(META, 'urn:m'), quad(LEGACY_ASSET, 'urn:l'), quad(LEGACY_SHARED, 'urn:k')];
const plantedQuads = [quad(VM_READ), quad(SWM_READ, 'urn:t'), quad(STRAY, 'urn:x'), quad(STATE, VM_READ, '"ready"')];

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
    for (const graph of [...PARTITION_GRAPHS, `${ROOT}/${READ_GRAPH_SEGMENT}`, `did:dkg:context-graph:a/b/${READ_GRAPH_SEGMENT}/cg/_verifiable_memory`,
      `did:dkg:context-graph:a/b/${READ_GRAPH_SEGMENT}/state`, `did:dkg:context-graph:a/_x/${READ_GRAPH_SEGMENT}/state`]) {
      expect(isReadGraphPartitionGraph(graph), graph).toBe(true);
      expect(isStorageHiddenGraph(graph), graph).toBe(true);
      expect(storeGraphEnumerationVisibility(graph), graph).toBe(false);
    }
    expect(isStorageHiddenGraph(`${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}x`)).toBe(true);
    for (const graph of [ASSET, SWM, META, ROOT, LEGACY_ASSET, LEGACY_SHARED, `${ROOT}/_read`, `${ROOT}/_read/state`,
      `${ROOT}/${READ_GRAPH_SEGMENT}er/x`, `${ROOT}/read/x`, `urn:x/${READ_GRAPH_SEGMENT}/state`,
      `did:dkg:context-graph:${READ_GRAPH_SEGMENT}`, `did:dkg:context-graph:${READ_GRAPH_SEGMENT}/state`,
      `${ROOT}/code/_verifiable_memory/0xabc/1`]) {
      expect(isReadGraphPartitionGraph(graph), graph).toBe(false);
      expect(storeGraphEnumerationVisibility(graph), graph).toBe(true);
    }
    expect(storeGraphEnumerationVisibility('')).toBe(false);
    // A caller's name is checked as given and as an adapter writes it, with IRI-breaking characters deleted.
    for (const graph of [`<${STATE}>`, STATE.replace(READ_GRAPH_SEGMENT, '_~re^ad'), `${VM_READ}\``, `"${SWM_READ}"`]) {
      expect(isReadGraphPartitionWriteTarget(graph), graph).toBe(true);
    }
    for (const graph of [`<${ASSET}>`, `${LEGACY_SHARED}|`, `<${ROOT}/${READ_GRAPH_SEGMENT}er>`]) {
      expect(isReadGraphPartitionWriteTarget(graph), graph).toBe(false);
    }
    // One parse names the owner, and tells state graphs from read graphs.
    expect(PARTITION_GRAPHS.map(readGraphPartitionOwner)).toEqual([CG, CG, CG, CG]);
    expect(readGraphPartitionOwner(`did:dkg:context-graph:a/b/${READ_GRAPH_SEGMENT}/state`)).toBe('a/b');
    expect([LEGACY_ASSET, LEGACY_SHARED].map(readGraphPartitionOwner)).toEqual([undefined, undefined]);
    expect([STATE, VM_READ, STRAY, `did:dkg:context-graph:a/_x/${READ_GRAPH_SEGMENT}/state`, `${ROOT}/_read/state`]
      .map(isReadGraphStateGraph)).toEqual([true, false, false, false, false]);
  });

  it('has the HTTP adapters refuse any dataset restriction, an empty one too', async () => {
    const blazegraph = new BlazegraphStore('http://127.0.0.1:1/blazegraph/namespace/kb/sparql');
    const http = new SparqlHttpStore({ queryEndpoint: 'http://127.0.0.1:1/query' });
    for (const store of [blazegraph, http]) {
      for (const withheldGraphRoots of [[], ['urn:root']]) {
        const error = await store.query('SELECT * WHERE { ?s ?p ?o }', { withheldGraphRoots }).then(() => undefined, (caught: unknown) => caught);
        expect(isQueryDatasetUnrestrictedError(error)).toBe(true);
      }
    }
    expect(isQueryDatasetUnrestrictedError(new Error('other'))).toBe(false);
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
    expect(sparqlNamesReadGraphPartition(`PREFIX r: <${ROOT}/> CLEAR GRAPH r:_\\~read`)).toBe(true);
    expect(sparqlNamesReadGraphPartition(`PREFIX r: <${ROOT}/> CLEAR GRAPH r:\\_\\~read\\/state`)).toBe(true);
    expect(sparqlNamesReadGraphPartition(`DROP GRAPH <${ROOT}/\\u005F\\u007Eread/state>`)).toBe(true);
    expect(sparqlNamesReadGraphPartition(`BASE <${ROOT}/> DROP GRAPH <${READ_GRAPH_SEGMENT}/state>`)).toBe(true);
    expect(sparqlNamesReadGraphPartition(`DROP GRAPH <${STRAY}>`)).toBe(true);
    // Relative IRIs resolve against a BASE, so one with the segment counts.
    expect(sparqlNamesReadGraphPartition(`BASE <${ROOT}/${READ_GRAPH_SEGMENT}/> DROP GRAPH <state>`)).toBe(true);
    expect(sparqlNamesReadGraphPartition(`BASE <${ROOT}/${READ_GRAPH_SEGMENT}/cg> DROP GRAPH <_verifiable_memory>`)).toBe(true);
    // Graphs of context graphs whose IDs have a `_read` segment are ordinary.
    expect(sparqlNamesReadGraphPartition(`DROP GRAPH <${LEGACY_SHARED}>`)).toBe(false);
    expect(sparqlNamesReadGraphPartition(`SELECT * WHERE { GRAPH <${LEGACY_ASSET}> { ?s ?p ?o } }`)).toBe(false);
    expect(sparqlNamesReadGraphPartition(`PREFIX l: <${ROOT}/_read/project/> SELECT * WHERE { GRAPH l:_verifiable_memory\\/0xaa\\/1 { ?s ?p ?o } }`)).toBe(false);
    expect(sparqlNamesReadGraphPartition('DROP GRAPH <unterminated')).toBe(false);
    // Text it cannot read through counts as naming the partition.
    expect(sparqlNamesReadGraphPartition('INSERT DATA { GRAPH <urn:g> { <urn:s> <urn:p> "_~read } }')).toBe(true);
    expect(sparqlNamesReadGraphPartition('DROP GRAPH <urn:x\\uZZZZ>')).toBe(true);
    expect(sparqlNamesReadGraphPartition(`INSERT DATA { GRAPH <${ASSET}> { <urn:s> <urn:p> "_~read" } }`)).toBe(false);
    expect(sparqlNamesReadGraphPartition(`DROP GRAPH <${ROOT}/${READ_GRAPH_SEGMENT}er/x>`)).toBe(false);
    // A prefix can split the segment between its namespace and a local name.
    expect(sparqlNamesReadGraphPartition(`PREFIX r: <${ROOT}/_> INSERT DATA { GRAPH r:\\~read\\/state { <urn:s> <urn:p> "v" } }`)).toBe(true);
    expect(sparqlNamesReadGraphPartition(`prefix r: <${ROOT}/_~re> CLEAR GRAPH r:ad\\/state`)).toBe(true);
    expect(sparqlNamesReadGraphPartition(`PREFIX r: <${ROOT}/_> CLEAR GRAPH r:\\~reader`)).toBe(false);
    // An UPDATE that writes through a graph variable cannot be shown to stay outside.
    expect(sparqlUpdateMayWriteReadGraphPartition('DELETE { GRAPH ?g { ?s ?p ?o } } WHERE { GRAPH ?g { ?s ?p ?o } }')).toBe(true);
    expect(sparqlUpdateMayWriteReadGraphPartition('delete where { graph $g { ?s ?p ?o } }')).toBe(true);
    // Comments and escapes between the keyword and the variable change nothing.
    expect(sparqlUpdateMayWriteReadGraphPartition(COMMENTED_GRAPH_VARIABLE)).toBe(true);
    expect(sparqlUpdateMayWriteReadGraphPartition('DELETE WHERE { GRAPH \\u003Fg { <urn:s> <urn:p> <urn:o> } }')).toBe(true);
    expect(sparqlUpdateMayWriteReadGraphPartition(`INSERT DATA { GRAPH <${LEGACY_ASSET}> { <urn:s> <urn:p> "v" } }`)).toBe(false);
    expect(sparqlUpdateMayWriteReadGraphPartition(`INSERT DATA { GRAPH <${ASSET}> { <urn:s> <urn:p> "v" } } # GRAPH ?g`)).toBe(false);
    expect(sparqlUpdateMayWriteReadGraphPartition('INSERT { GRAPH ?g { <urn:s> <urn:p> 1 } } WHERE { VALUES ?g { <urn:g> } }')).toBe(true);
    expect(sparqlUpdateMayWriteReadGraphPartition(`INSERT { GRAPH <${ASSET}> { ?s ?p ?o } } WHERE { GRAPH ?g { ?s ?p ?o } }`)).toBe(false);
    expect(sparqlUpdateMayWriteReadGraphPartition(`INSERT DATA { GRAPH <${ASSET}> { <urn:s> <urn:p> "GRAPH ?g" } }`)).toBe(false);
    expect(sparqlUpdateMayWriteReadGraphPartition(`DROP GRAPH <${STATE}>`)).toBe(true);
    expect(sparqlUpdateMayWriteReadGraphPartition('INSERT { GRAPH ?g { <urn:s> <urn:p> "open } }')).toBe(true);
    expect(sparqlNamesReadGraphPartition(`PREFIX r: <${ROOT}/> CLEAR GRAPH r:reader`)).toBe(false);
    // Clearing or dropping a whole-store target reaches every graph.
    for (const sparql of ['CLEAR ALL', 'drop silent named', 'CLEAR DEFAULT', 'DROP # comment\n ALL', 'CLEAR \\u0041LL']) {
      expect(sparqlUpdateReach(sparql), sparql).toBe('every-graph');
    }
    expect(sparqlUpdateReach(`CLEAR GRAPH <${ASSET}>`)).toBe('elsewhere');
    expect(sparqlUpdateReach(`INSERT DATA { GRAPH <${ASSET}> { <urn:s> <urn:p> "all of it" } }`)).toBe('elsewhere');
    expect(sparqlUpdateReach(`DROP GRAPH <${STATE}>`)).toBe('partition');
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
    const adapter = readGraphPartitionMaintenanceStore(store);
    await adapter.insert(plantedQuads);
    const stored = async () => Promise.all([...PARTITION_GRAPHS, ...memberQuads.map(quad => quad.graph)]
      .map(graph => adapter.countQuads(graph)));
    const before = await stored();
    const writeMethods = ['insert', 'delete', 'deleteByPattern', 'deleteByPatternWithoutCount', 'deleteBySubjectPrefix',
      'dropGraph', 'createGraph', 'replaceGraph', 'replaceAssetGroup', 'replaceGraphAndSubject', 'replaceSubject',
      'replaceSubjectAndInsert', 'rfc64AuthorCommitCasV1', 'update'] as const;
    const writes = writeMethods.map(name => vi.spyOn(adapter as unknown as Record<string, () => unknown>, name));
    const reads = vi.spyOn(adapter, 'query');
    const asset = { graphUri: ASSET, graphQuads: [quad(ASSET)], metaGraphUri: META, metadataSubject: 'urn:m', metadataQuads: [quad(META, 'urn:m')] };
    const computed = `INSERT { GRAPH ?g { <urn:s> <urn:p> "bad" } } WHERE { BIND(IRI("did:dkg:context-graph:x/${READ_GRAPH_SEGMENT}/stray") AS ?g) }`;
    const refusals: Array<[string, () => Promise<unknown>]> = [
      ['insert', () => store.insert([quad(ASSET), quad(VM_READ)])],
      ['delete', () => store.delete([quad(STATE, VM_READ, '"ready"')])],
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
      ['update', () => store.update!(`PREFIX r: <${ROOT}/_> INSERT DATA { GRAPH r:\\~read\\/state { <urn:s> <urn:p> "v" } }`)],
      ['update', () => store.update!(`BASE <${ROOT}/${READ_GRAPH_SEGMENT}/> INSERT DATA { GRAPH <cg/_verifiable_memory> { <urn:s> <urn:p> "v" } }`)],
      ['update', () => store.update!(COMMENTED_GRAPH_VARIABLE)],
      ['update', () => store.update!(computed)],
      ['update', () => store.update!('DELETE WHERE { GRAPH ?g { ?s ?p ?o } }')],
      ['query', () => store.query(`INSERT DATA { GRAPH <${STRAY}> { <urn:s> <urn:p> "v" } }`)],
      ['query', () => store.query(computed)],
      ['query', () => store.query(COMMENTED_GRAPH_VARIABLE)],
      // A name the adapters would render with its IRI-breaking characters deleted targets that graph.
      ['dropGraph', () => store.dropGraph(`<${STATE}>`)],
      ['insert', () => store.insert([quad(`<${VM_READ}>`)])],
      ['deleteByPattern', () => store.deleteByPattern({ graph: `${SWM_READ.slice(0, 30)}{${SWM_READ.slice(30)}` })],
      ['replaceGraph', () => store.replaceGraph!(`${STATE}|`, [])],
      ['dropGraph', () => store.dropGraph(STATE.replace(READ_GRAPH_SEGMENT, '_~re^ad'))],
      ['update', () => store.update!('CLEAR SILENT DEFAULT', { touchedGraphs: [`<${VM_READ}>`] })],
    ];
    for (const [operation, write] of refusals) {
      const error = await write().then(() => undefined, (caught: unknown) => caught);
      expect(error, operation).toBeInstanceOf(ReadGraphPartitionWriteError);
      expect((error as ReadGraphPartitionWriteError).code).toBe(READ_GRAPH_PARTITION_WRITE_CODE);
      expect(isStoreOperationNotStarted(error, operation as Parameters<typeof isStoreOperationNotStarted>[1]), operation).toBe(true);
    }
    // Refused before dispatch: no write reached the adapter, and nothing it holds changed.
    for (const spy of writes) expect(spy).not.toHaveBeenCalled();
    expect(reads.mock.calls.filter(([sparql]) => /\b(INSERT|DELETE|DROP|CLEAR)\b/i.test(sparql))).toEqual([]);
    expect(await stored()).toEqual(before);
  });

  it('refuses writes that reach every graph while the store may hold partitions', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    opened.push(store);
    await store.insert(memberQuads);
    const adapter = readGraphPartitionMaintenanceStore(store);
    await adapter.insert(plantedQuads);
    // Before the store may hold partitions, such writes run as they always have.
    expect(await store.deleteByPattern({ subject: 'urn:m' })).toBe(1);
    await store.update!('CLEAR SILENT DEFAULT');
    noteStoreMayHoldReadGraphPartitions(adapter);
    const refusals: Array<[Parameters<typeof isStoreOperationNotStarted>[1], () => Promise<unknown>]> = [
      ['deleteByPattern', () => store.deleteByPattern({ predicate: 'urn:p' })],
      ['deleteByPattern', () => store.deleteByPattern({ graph: '', predicate: 'urn:p' })],
      ['deleteByPattern', () => store.deleteByPatternWithoutCount!({ predicate: 'urn:p' })],
      ['update', () => store.update!('CLEAR ALL')],
      ['update', () => store.update!('DROP SILENT NAMED')],
      ['query', () => store.query('CLEAR DEFAULT')],
    ];
    for (const [operation, write] of refusals) {
      const error = await write().then(() => undefined, (caught: unknown) => caught);
      expect(error, operation).toBeInstanceOf(ReadGraphPartitionWriteError);
      expect(isStoreOperationNotStarted(error, operation), operation).toBe(true);
    }
    expect(await adapter.countQuads(VM_READ)).toBe(1);
    expect(await adapter.countQuads(STATE)).toBe(1);
    expect(await store.deleteByPattern({ graph: ASSET, predicate: 'urn:p' })).toBe(1);
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
    // A graph variable that only reads is no write target.
    await store.update!(`INSERT { GRAPH <${ASSET}> { ?s <urn:copy> ?o } } WHERE { GRAPH ?g { ?s <urn:p> ?o } FILTER(?g = <${SWM}>) }`);
    await store.update!(`DELETE DATA { GRAPH <${ASSET}> { <urn:s> <urn:p> "w" } }`);
    await store.replaceSubject!(META, 'urn:m', [quad(META, 'urn:m', '"x"')]);
    expect(await store.deleteByPattern({ graph: SWM })).toBe(1);
    // Graphs of context graphs whose IDs have a `_read` segment are written like any other.
    await store.update!(`INSERT DATA { GRAPH <${LEGACY_ASSET}> { <urn:s> <urn:p> "w" } }`, { touchedGraphs: [LEGACY_ASSET] });
    await store.replaceGraph!(LEGACY_SHARED, [quad(LEGACY_SHARED, 'urn:y')]);
    expect(await store.countQuads(LEGACY_ASSET)).toBe(2);
    expect(await store.deleteByPattern({ graph: LEGACY_SHARED })).toBe(1);
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
      expect(await planted.hasGraph(`<${graph}>`), graph).toBe(false);
      expect(await planted.countQuads(`<${graph}>`), graph).toBe(0);
      expect(await readGraphPartitionMaintenanceStore(planted).hasGraph(graph), graph).toBe(true);
    }
    for (const graph of [ASSET, LEGACY_ASSET, LEGACY_SHARED]) {
      expect(await planted.hasGraph(graph), graph).toBe(true);
      expect(await planted.countQuads(graph), graph).toBe(1);
    }
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
    // Exactly the member graphs: a list that keeps any one partition graph differs.
    const members = memberQuads.map(member => member.graph).sort();
    const indexed = new GraphSetIndexStore(new ReadGraphPartitionStore(base), { revalidateMs: 0 });
    expect([...await indexed.listGraphs()].sort()).toEqual(members);
    expect(await indexed.listGraphsByPrefix(`${ROOT}/${READ_GRAPH_SEGMENT}`)).toEqual([]);
    expect((await indexed.listGraphsByPrefix(`${ROOT}/_read/`)).sort()).toEqual([LEGACY_ASSET, LEGACY_SHARED].sort());
    expect(await indexed.hasGraph(VM_READ)).toBe(false);
    expect(indexed.graphEnumerationVisibility?.(VM_READ)).toBe(false);
    expect(indexed.graphEnumerationVisibility?.(ASSET)).toBe(true);
    const passthrough = new GraphSetIndexStore(base, { enabled: false });
    expect([...await passthrough.listGraphsByPrefix(ROOT)].sort()).toEqual(members);
  });
});

describe('stores that may hold read-graph partitions', () => {
  it('records it once per backend, for every decorator over it', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const other = await createTripleStore({ backend: 'oxigraph' });
    opened.push(store, other);
    expect(storeMayHoldReadGraphPartitions(store)).toBe(false);
    noteStoreMayHoldReadGraphPartitions(readGraphPartitionMaintenanceStore(store));
    expect(storeMayHoldReadGraphPartitions(store)).toBe(true);
    expect(storeMayHoldReadGraphPartitions(new GraphSetIndexStore(store))).toBe(true);
    expect(storeMayHoldReadGraphPartitions(other)).toBe(false);
    const adapter = new OxigraphStore();
    opened.push(adapter);
    noteStoreMayHoldReadGraphPartitions(new GraphSetIndexStore(adapter));
    expect(storeMayHoldReadGraphPartitions(adapter)).toBe(true);
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
    for (const graph of [LEGACY_ASSET, LEGACY_SHARED]) expect(await adapter.countQuads(graph), graph).toBe(1);
    expect((await adapter.listGraphs()).sort()).toEqual((await readGraphPartitionMaintenanceStore(plain).listGraphs()).sort());
    expect(await dropReadGraphPartitions(plain)).toBe(0);
  });

  it('drops a read graph emptied by DELETE, which the store keeps registered', async () => {
    const { plain, planted } = await storePair();
    opened.push(plain, planted);
    const adapter = readGraphPartitionMaintenanceStore(planted);
    const registered = async () => {
      const result = await adapter.query('SELECT ?g WHERE { GRAPH ?g {} }');
      return result.type === 'bindings' ? result.bindings.map(row => row.g).filter(isReadGraphPartitionGraph) : [];
    };
    await adapter.delete([quad(VM_READ)]);
    expect(await adapter.countQuads(VM_READ)).toBe(0);
    expect(await registered()).toContain(VM_READ);
    expect(await dropReadGraphPartitions(planted)).toBe(PARTITION_GRAPHS.length);
    expect(await registered()).toEqual([]);
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
    const graphs = [VM_READ, STATE, STRAY, `did:dkg:context-graph:org/team/${READ_GRAPH_SEGMENT}/sub/code/_shared_memory`];
    const store = { listGraphs: async () => graphs } as unknown as TripleStore;
    const owners = await listStoredContextGraphOwnerCandidates(store, {});
    expect(owners.sort()).toEqual([CG, 'org', 'org/team'].sort());
    // A graph of a context graph whose ID has a `_read` segment keeps the owners its own IRI gives.
    const legacy = { listGraphs: async () => [LEGACY_SHARED] } as unknown as TripleStore;
    expect((await listStoredContextGraphOwnerCandidates(legacy, {})).sort())
      .toEqual([...contextGraphStorageOwnerCandidates(LEGACY_SHARED)!].sort());
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

  it('leaves them out across the worker boundary too', async () => {
    const worker = new OxigraphWorkerStore();
    opened.push(worker);
    await worker.insert([...memberQuads, ...plantedQuads]);
    const graphs = (result: Awaited<ReturnType<TripleStore['query']>>) =>
      result.type === 'bindings' ? result.bindings.map(row => row.g).sort() : [];
    expect(graphs(await worker.query(PER_GRAPH, { withheldGraphRoots: [] })))
      .toEqual(memberQuads.map(quad => quad.graph).sort());
    expect(graphs(await worker.query(PER_GRAPH))).toEqual([...memberQuads.map(quad => quad.graph), ...PARTITION_GRAPHS].sort());
  });
});
