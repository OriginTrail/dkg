import { randomUUID } from 'node:crypto';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, BlazegraphStore, BlazegraphNamespaceManager, GraphSetIndexStore, ChangelogStore, type Quad } from '@origintrail-official/dkg-storage';
import { storageAckOperationId, clearDischargedStorageAckCopies } from '@origintrail-official/dkg-publisher';
import { createStorageAckCopyCleanupWriter } from '../src/internal/storage-ack-copy-cleanup-writer.js';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { createProjectionMutationObserver } from '../src/internal/projection-mutation-observer.js';
import { createObservedStoreMutation } from '../src/internal/observed-store-mutation.js';
import { createMutationObservedStore } from '../src/internal/context-graph-cache-invalidating-store.js';

const GRAPH = 'did:dkg:context-graph:cleanup/_shared_memory_meta';
const UAL = 'did:dkg:base:84532/0x1111111111111111111111111111111111111111/1';
const DKG = 'http://dkg.io/ontology/';
const INPUT = { metaGraph: GRAPH, kaUal: UAL, cleanedOperations: ['urn:share:original'] };
const stores: Array<OxigraphStore | BlazegraphStore> = [];
const namespaces: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); for (const dispose of namespaces.splice(0)) await dispose(); });
function operation(subject: string, shareId: string, version: number): Quad[] {
  return [
    { graph: GRAPH, subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}WorkspaceOperation` },
    { graph: GRAPH, subject, predicate: `${DKG}kaUal`, object: UAL },
    { graph: GRAPH, subject, predicate: `${DKG}shareOperationId`, object: JSON.stringify(shareId) },
    { graph: GRAPH, subject, predicate: `${DKG}assertionVersion`, object: `"${version}"^^<http://www.w3.org/2001/XMLSchema#integer>` },
  ];
}
async function stack(decorated = false) {
  let raw: OxigraphStore | BlazegraphStore;
  const url = process.env.DKG_CLEANUP_BLAZEGRAPH_URL;
  if (url) {
    const manager = new BlazegraphNamespaceManager({ namespaceApiUrl: `${url}/namespace` });
    const handles = await manager.acquireMany([`cleanup-${randomUUID()}`]);
    namespaces.push(() => manager.disposeAll(handles));
    raw = new BlazegraphStore(handles[0]!.sparqlUrl);
  } else raw = new OxigraphStore();
  stores.push(raw);
  const retained = [...operation('urn:share:original', 'original', 1),
    ...operation('urn:share:newer', storageAckOperationId(UAL, 2, new Uint8Array(32)), 2)];
  await raw.insert([...retained, ...operation('urn:share:copy', storageAckOperationId(UAL, 1, new Uint8Array(32)), 1)]);
  const projection = new ContextGraphMetaProjection(raw);
  await projection.recipientKeyRouteFence.ensureReady();
  const configured = decorated ? new ChangelogStore(new GraphSetIndexStore(raw)) : raw;
  const execute = createObservedStoreMutation(() => {}, createProjectionMutationObserver(() => projection));
  const store = createMutationObservedStore(configured, execute);
  return { raw, projection, store, retained, writer: createStorageAckCopyCleanupWriter(configured, execute) };
}
describe('StorageACK cleanup observation', () => {
  it.each([false, true])('retains unrelated proofs and exact RDF after cleanup (decorated=%s)', async decorated => {
    const { raw, projection, writer, retained } = await stack(decorated);
    const cached = await projection.get('unrelated');
    const before = projection.recipientKeyRouteFence.revision;
    const query = vi.spyOn(raw, 'query');
    await writer(INPUT);
    expect(projection.recipientKeyRouteFence.revision).toBe(before);
    expect(await projection.get('unrelated')).toEqual(cached);
    expect(query.mock.calls.filter(([sparql]) => sparql.includes('unrelated'))).toHaveLength(0);
    const result = await raw.query(`SELECT ?s ?p ?o WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } }`);
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') expect(result.bindings).toEqual(expect.arrayContaining(retained.map(q => ({ s: q.subject, p: q.predicate, o: q.object }))));
    if (result.type === 'bindings') expect(result.bindings).toHaveLength(retained.length);
  });

  it('eliminates repeated unrelated projection reads in matched cleanup arms', async () => {
    const counts: number[] = [];
    for (const scoped of [false, true, true, false]) {
      const { raw, projection, writer, store } = await stack();
      const ids = Array.from({ length: 8 }, (_, i) => `unrelated-${i}`);
      for (const id of ids) await projection.get(id);
      const query = vi.spyOn(raw, 'query');
      for (let turn = 0; turn < 4; turn++) {
        await (scoped ? writer(INPUT) : clearDischargedStorageAckCopies(store, INPUT));
        for (const id of ids) await projection.get(id);
      }
      counts.push(query.mock.calls.filter(([sparql]) => sparql.includes('unrelated-')).length);
      query.mockRestore();
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[3]).toBe(counts[0]);
    expect(counts.slice(1, 3)).toEqual([0, 0]);
    console.info('cleanup projection read counts (control, candidate, candidate, control):', counts);
  });

  it('keeps unrelated reads reusable while cleanup holds a store slot', async () => {
    const { raw, projection, writer } = await stack();
    const cached = await projection.get('unrelated');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const update = raw.update.bind(raw);
    vi.spyOn(raw, 'update').mockImplementation(async (...args) => { await gate; await update(...args); });
    const pending = writer(INPUT);
    try {
      expect(projection.recipientKeyRouteFence.hasPendingWrites).toBe(false);
      expect(projection.recipientKeyRouteFence.cacheable).toBe(true);
      expect(await projection.get('unrelated')).toEqual(cached);
    } finally { release(); await pending; }
  });

  it.each([false, true])('propagates uncertain failure without replay (committed=%s)', async committed => {
    const { raw, projection, writer, store } = await stack();
    const update = raw.update.bind(raw);
    const failure = new Error('lost update response');
    const write = vi.spyOn(raw, 'update').mockImplementation(async (...args) => {
      if (committed) await update(...args);
      throw failure;
    });
    const before = projection.recipientKeyRouteFence.revision;
    await expect(writer(INPUT)).rejects.toBe(failure);
    expect(write).toHaveBeenCalledOnce();
    expect(projection.recipientKeyRouteFence.revision).toBe(before);
    const remaining = await raw.query(`ASK { GRAPH <${GRAPH}> { <urn:share:copy> ?p ?o } }`);
    expect(remaining).toEqual({ type: 'boolean', value: !committed });
    // A late-discovered recipient key in the uncertain graph must not escape its fence.
    await store.insert([keyFact()]);
    expect(projection.recipientKeyRouteFence.cacheable).toBe(false);
  });

  it('fences actual recipient data in the cleanup graph, including uncertain completion', async () => {
    const { raw, projection, writer, store } = await stack();
    await store.insert([keyFact()]);
    const before = projection.recipientKeyRouteFence.revision;
    vi.spyOn(raw, 'update').mockImplementation(async () => {
      expect(projection.recipientKeyRouteFence.hasPendingWrites).toBe(true);
      throw new Error('uncertain');
    });
    await expect(writer(INPUT)).rejects.toThrow('uncertain');
    expect(projection.recipientKeyRouteFence.revision).toBeGreaterThan(before);
    expect(projection.recipientKeyRouteFence.cacheable).toBe(false);
  });

  it('learns a key inserted into the graph while cleanup is still pending', async () => {
    const { raw, projection, writer, store } = await stack();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const update = raw.update.bind(raw);
    vi.spyOn(raw, 'update').mockImplementation(async (...args) => { await gate; await update(...args); });
    const pending = writer(INPUT);
    try {
      await store.insert([keyFact()]);
      expect(projection.recipientKeyRouteFence.hasPendingWrites).toBe(true);
    } finally { release(); await pending; }
    expect(projection.recipientKeyRouteFence.hasPendingWrites).toBe(false);
    expect(await raw.query(`ASK { GRAPH <${GRAPH}> { <urn:share:copy> ?p ?o } }`)).toEqual({ type: 'boolean', value: false });
  });

  it('leaves generic UPDATE opaque even when the caller supplies touchedGraphs', async () => {
    const { store, projection } = await stack();
    const before = projection.recipientKeyRouteFence.revision;
    await store.update!(`DELETE WHERE { GRAPH <${GRAPH}> { <urn:none> ?p ?o } }`, { touchedGraphs: [GRAPH] });
    expect(projection.recipientKeyRouteFence.revision).toBeGreaterThan(before);
  });

  it('does not observe or dispatch empty or malformed cleanup plans', async () => {
    const { raw, projection, writer } = await stack();
    const update = vi.spyOn(raw, 'update');
    const before = projection.recipientKeyRouteFence.revision;
    await writer({ ...INPUT, cleanedOperations: [] });
    for (const bad of [
      { ...INPUT, metaGraph: 'urn:bad> }' }, { ...INPUT, kaUal: 'urn:bad> }' },
      { ...INPUT, cleanedOperations: ['urn:bad> }'] },
    ]) await expect(writer(bad)).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
    expect(projection.recipientKeyRouteFence.revision).toBe(before);
    expect(projection.recipientKeyRouteFence.hasPendingWrites).toBe(false);
  });

  it('refuses absent capability rather than silently skipping cleanup', async () => {
    const { raw, projection, writer } = await stack();
    Object.defineProperty(raw, 'update', { value: undefined });
    await expect(writer(INPUT)).rejects.toThrow('cannot run an update');
    expect(projection.recipientKeyRouteFence.hasPendingWrites).toBe(false);
  });

  it('constructs the production agent with a scoped writer over its configured store', async () => {
    const { raw } = await stack();
    const agent = await DKGAgent.create({ name: 'ack-copy-cleanup', store: raw,
      chainAdapter: new NoChainAdapter(), chainConfig: { type: 'none' } });
    try {
      const before = await agent.listContextGraphs();
      const update = vi.spyOn(raw, 'update');
      await agent.storageAckCopyCleanup(INPUT);
      expect(update).toHaveBeenCalledOnce();
      expect(update.mock.calls[0]![1]).toEqual({ source: 'publisher.storageAckCopyCleanup', touchedGraphs: [GRAPH] });
      expect(await agent.listContextGraphs()).toEqual(before);
    } finally { await agent.stop(); }
  });
});

function keyFact(): Quad {
  return { graph: GRAPH, subject: 'did:dkg:agent:0x1111111111111111111111111111111111111111', predicate: DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY, object: '"key"' };
}
