import { describe, expect, it, vi } from 'vitest';
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import { CURRENT_READ_GRAPH_VERSIONS, GraphManager, createTripleStore, readGraphLayerOf, type TripleStore } from '@origintrail-official/dkg-storage';
import { replaceCatalogQuads } from '../src/catalog-persistence.js';
import { updateMetaMerkleRoot } from '../src/metadata.js';
import { clearDischargedStorageAckCopies } from '../src/storage-ack-copy-cleanup.js';

const CG = 'declared-publisher-updates';
const ROOT = `did:dkg:context-graph:${CG}`;
const META = `${ROOT}/_meta`;
const ASSET = `${ROOT}/_verifiable_memory/0x${'cd'.repeat(20)}/1`;
const READ = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
const MEMBER = { subject: 'urn:declared:s', predicate: 'urn:declared:p', object: '"member"' };

/** A store as the node composes it, with one ready read graph that holds its member's triple. */
async function nodeStoreWithReadGraph(): Promise<TripleStore> {
  const store = await createTripleStore({ backend: 'oxigraph' });
  const layer = readGraphLayerOf(store)!;
  await layer.innerStore.insert([{ ...MEMBER, graph: ASSET }, { ...MEMBER, graph: READ }]);
  layer.runtime.mirror.set({
    readGraph: READ, state: 'ready', generation: 1,
    ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion, builderVersion: CURRENT_READ_GRAPH_VERSIONS.builderVersion,
  });
  // The store refuses an update that declares nothing while the read graph exists.
  await expect(store.update!(`INSERT DATA { GRAPH <${META}> { <urn:s> <urn:p> "x" } }`)).rejects.toThrow(/writtenGraphs/);
  return store;
}

async function holds(store: TripleStore, graph: string, subject: string, predicate: string): Promise<boolean> {
  const result = await store.query(`ASK { GRAPH <${graph}> { <${subject}> <${predicate}> ?o } }`);
  return result.type === 'boolean' ? result.value : result.type === 'bindings' && result.bindings[0]?.result === 'true';
}

/** The read graph still holds exactly its member's triple. */
async function expectReadGraphUnchanged(store: TripleStore): Promise<void> {
  const inner = readGraphLayerOf(store)!.innerStore;
  const result = await inner.query(`SELECT ?s ?p ?o WHERE { GRAPH <${READ}> { ?s ?p ?o } }`);
  expect(result).toMatchObject({ type: 'bindings', bindings: [{ s: MEMBER.subject, p: MEMBER.predicate, o: MEMBER.object }] });
}

describe('publisher updates while a read graph exists', () => {
  it('registry and catalog: a catalog and a merkle root are written', async () => {
    const store = await nodeStoreWithReadGraph();
    const catalog = `${ROOT}/_catalog`;
    await replaceCatalogQuads(store, catalog, [{ subject: 'urn:declared:asset', predicate: 'urn:declared:in', object: '"catalog"', graph: catalog }]);
    expect(await holds(store, catalog, 'urn:declared:asset', 'urn:declared:in')).toBe(true);
    const ual = 'urn:declared:ual';
    const merkleRoot = 'http://dkg.io/ontology/merkleRoot';
    await store.insert([
      { subject: ual, predicate: 'http://dkg.io/ontology/batchId', object: '"5"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: META },
      { subject: ual, predicate: merkleRoot, object: '"0909"', graph: META },
    ]);
    const update = vi.spyOn(store, 'update');
    const insert = vi.spyOn(store, 'insert');
    await updateMetaMerkleRoot(store, new GraphManager(store), CG, 5n, new Uint8Array([1, 2]));
    // The declared update replaced the root: it succeeded, and the fallback's insert never ran.
    expect(update).toHaveBeenCalledOnce();
    await expect(update.mock.results[0]!.value).resolves.toBeUndefined();
    expect(insert).not.toHaveBeenCalled();
    const roots = await store.query(`SELECT ?root WHERE { GRAPH <${META}> { <${ual}> <${merkleRoot}> ?root } }`);
    expect(roots.type === 'bindings' && roots.bindings).toEqual([{ root: '"0102"' }]);
    await expectReadGraphUnchanged(store);
  });

  it('SWM: discharged StorageACK copies are cleared', async () => {
    const store = await nodeStoreWithReadGraph();
    await expect(clearDischargedStorageAckCopies(store, {
      metaGraph: `${ROOT}/_shared_memory_meta`, kaUal: 'did:dkg:test/declared/1', cleanedOperations: ['urn:declared:operation'],
    })).resolves.toBeUndefined();
    await expectReadGraphUnchanged(store);
  });
});
