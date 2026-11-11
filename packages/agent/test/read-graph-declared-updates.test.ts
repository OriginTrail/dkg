import { describe, expect, it } from 'vitest';
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import { STORAGE_ACK_LEDGER_GRAPH, STORAGE_ACK_LEDGER_PREDICATES } from '@origintrail-official/dkg-publisher';
import { CURRENT_READ_GRAPH_VERSIONS, createTripleStore, readGraphLayerOf, type TripleStore } from '@origintrail-official/dkg-storage';
import { applyStorageAckLedgerTimestamp } from '../src/internal/storage-ack-ledger-timestamp-writer.js';
import { pruneTerminalJoinRequestRecords } from '../src/join-request-retention.js';
import { LocalContextGraphRegistrationStatusStore } from '../src/local-context-graph-registration-status.js';
import { deleteSwmOperationMetadata } from '../src/sync/swm-operation-published-at.js';

const CG = 'declared-updates';
const ROOT = `did:dkg:context-graph:${CG}`;
const META = `${ROOT}/_meta`;
const ASSET = `${ROOT}/_verifiable_memory/0x${'ab'.repeat(20)}/1`;
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

describe('agent updates while a read graph exists', () => {
  it('registry: a context graph\'s registration status is written', async () => {
    const store = await nodeStoreWithReadGraph();
    const statuses = new LocalContextGraphRegistrationStatusStore({ store, markProjectionDirty: () => {} });
    await statuses.set(CG, 'registered');
    await expect(statuses.read(CG)).resolves.toBe('registered');
    await expectReadGraphUnchanged(store);
  });

  it('SWM catch-up: an operation\'s metadata is replaced', async () => {
    const store = await nodeStoreWithReadGraph();
    const meta = `${ROOT}/_shared_memory_meta`;
    const operation = 'urn:declared:operation';
    const publishedAt = 'http://dkg.io/ontology/publishedAt';
    await store.insert([
      { subject: operation, predicate: 'urn:declared:state', object: '"old"', graph: meta },
      { subject: operation, predicate: publishedAt, object: '"2026-11-11T00:00:00Z"', graph: meta },
    ]);
    await deleteSwmOperationMetadata(store, meta, operation, true, {});
    expect(await holds(store, meta, operation, 'urn:declared:state')).toBe(false);
    await expectReadGraphUnchanged(store);
  });

  it('StorageACK ledger: a timestamp is marked', async () => {
    const store = await nodeStoreWithReadGraph();
    const subject = 'urn:declared:ack';
    await expect(applyStorageAckLedgerTimestamp(store)(subject, STORAGE_ACK_LEDGER_PREDICATES.seenAt, new Date(), {}))
      .resolves.toBe(true);
    expect(await holds(store, STORAGE_ACK_LEDGER_GRAPH, subject, STORAGE_ACK_LEDGER_PREDICATES.seenAt)).toBe(true);
    await expectReadGraphUnchanged(store);
  });

  it('join retention: terminal join requests past the cap are pruned', async () => {
    const store = await nodeStoreWithReadGraph();
    const request = 'did:dkg:join-request:declared';
    await store.insert([
      { subject: request, predicate: 'https://dkg.network/ontology#requestStatus', object: '"approved"', graph: META },
      { subject: request, predicate: 'https://dkg.network/ontology#decisionTimestamp', object: '"1"', graph: META },
    ]);
    await expect(pruneTerminalJoinRequestRecords(store, CG, 0)).resolves.toBe(1);
    expect(await holds(store, META, request, 'https://dkg.network/ontology#requestStatus')).toBe(false);
    await expectReadGraphUnchanged(store);
  });
});
