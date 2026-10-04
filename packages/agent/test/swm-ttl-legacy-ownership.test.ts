// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { generateShareMetadata, storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead, swmEntityWriteLockKey, withKeyedLocks, workspaceOperationSubject, withWorkspaceOperationWriteLock } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/index.js';
import { withUnqueuedDraftOperation } from '../src/swm-operation-expiry.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';

const DKG = 'http://dkg.io/ontology/';
const CG = 'legacy-ttl';
const TTL = 60_000;
const ROOT = 'urn:legacy:root';
const OTHER = 'urn:legacy:other';
const nodes: DKGAgent[] = [];
afterEach(async () => { await Promise.all(nodes.splice(0).map(node => node.stop())); });
const payload = (subject: string, name: string): Quad[] => [{ subject, predicate: 'urn:name', object: JSON.stringify(name), graph: '' }];

async function nodeFixture() {
  const node = await DKGAgent.create({ name: CG, listenPort: 0, chainAdapter: new NoChainAdapter(), kaNumberAllocator: makeTestKaNumberAllocator(), sharedMemoryTtlMs: TTL });
  nodes.push(node);
  await node.start();
  await node.cleanupExpiredSharedMemory();
  await node.createContextGraph({ id: CG, name: CG });
  return node;
}

async function expire(store: DKGAgent['store'], operation: string, meta: string) {
  await store.deleteByPattern({ graph: meta, subject: operation, predicate: `${DKG}publishedAt` });
  await store.insert([{ graph: meta, subject: operation, predicate: `${DKG}publishedAt`, object: `"${new Date(Date.now() - TTL * 2).toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` }]);
}

describe('legacy share TTL ownership', () => {
  it.each([undefined, 'branch'])('preserves a fresh graph-scoped KA with the same legacy RDF root in namespace %s', async subGraphName => {
    const node = await nodeFixture();
    const store = node.store;
    const manager = new GraphManager(store);
    if (subGraphName) await manager.ensureSubGraph(CG, subGraphName);
    const meta = manager.sharedMemoryMetaUri(CG, subGraphName);
    const bucket = manager.sharedMemoryUri(CG, subGraphName);
    await store.insert(generateShareMetadata({ contextGraphId: CG, subGraphName, shareOperationId: 'old', rootEntities: [ROOT], publisherPeerId: 'local', timestamp: new Date(Date.now() - TTL * 2) }, meta));
    await store.insert(payload(ROOT, 'expired').map(quad => ({ ...quad, graph: bucket })));
    const ka = 'did:dkg:31337/0x1111111111111111111111111111111111111111/7';
    await storeKnowledgeAssetOperationPublicQuads({ store, graphManager: manager, contextGraphId: CG, subGraphName, shareOperationId: 'fresh-ka', kaUal: ka, assertionVersion: 1, quads: payload(ROOT, 'modern'), publisherPeerId: 'modern' });
    await storeKnowledgeAssetWorkspaceHead({ store, graphManager: manager, contextGraphId: CG, subGraphName, shareOperationId: 'fresh-ka', kaUal: ka, assertionVersion: 1 });
    const head = `${ka}#dkg-swm-head`;
    const rows = await store.query(`SELECT ?g WHERE { GRAPH <${meta}> { <${head}> <${DKG}assertionGraph> ?g } }`);
    if (rows.type !== 'bindings' || !rows.bindings[0]?.['g']) throw new Error('expected modern assertion graph');
    const assertionGraph = rows.bindings[0]['g'];
    await store.insert(payload(ROOT, 'modern').map(quad => ({ ...quad, graph: assertionGraph })));
    const before = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`);
    const deleted = await node.cleanupExpiredSharedMemory();
    expect(deleted).toBeGreaterThan(0);
    expect(await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`)).toEqual(before);
    for (const subject of [head, workspaceOperationSubject(CG, 'fresh-ka')]) {
      expect(await store.query(`ASK { GRAPH <${meta}> { <${subject}> ?p ?o } }`)).toEqual({ type: 'boolean', value: true });
    }
    expect(await store.query(`ASK { GRAPH <${bucket}> { <${ROOT}> ?p ?o } }`)).toEqual({ type: 'boolean', value: false });
  });

  it('expires real raw shares without KA metadata while preserving a fresh share', async () => {
    const node = await nodeFixture();
    await node.share(CG, payload(ROOT, 'expired'));
    const meta = new GraphManager(node.store).sharedMemoryMetaUri(CG);
    const operations = await node.store.query(`SELECT ?op WHERE { GRAPH <${meta}> { ?op <${DKG}rootEntity> <${ROOT}> } }`);
    if (operations.type !== 'bindings') throw new Error('expected legacy operation');
    expect(operations.bindings).toHaveLength(1);
    await expire(node.store, operations.bindings[0]!['op']!, meta);
    await node.share(CG, payload(OTHER, 'fresh'));
    expect(await node.cleanupExpiredSharedMemory()).toBeGreaterThan(0);
    const result = await node.store.query(`SELECT ?s ?name WHERE { GRAPH <${new GraphManager(node.store).sharedMemoryUri(CG)}> { ?s <urn:name> ?name } }`);
    if (result.type !== 'bindings') throw new Error('expected payload bindings');
    expect(result.bindings).toEqual([{ s: OTHER, name: '"fresh"' }]);
  });

  it('waits for the actual publisher share lock before retiring an overwritten entity', async () => {
    const node = await nodeFixture();
    const old = await node.publisher.share(CG, [...payload(ROOT, 'expired'), ...payload(OTHER, 'expired sibling')], { publisherPeerId: 'local' });
    const meta = new GraphManager(node.store).sharedMemoryMetaUri(CG);
    await expire(node.store, workspaceOperationSubject(CG, old.shareOperationId), meta);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const writing = node.publisher.share(CG, payload(ROOT, 'fresh'), { publisherPeerId: 'local', confirmBeforeCommit: async () => { entered(); await gate; return { applied: true }; } });
    await ready;
    const locks = (node as unknown as { writeLocks: Map<string, Promise<void>> }).writeLocks;
    const key = swmEntityWriteLockKey(CG, undefined, ROOT);
    const predecessor = locks.get(key);
    expect(predecessor).toBeDefined();
    const cleanup = node.cleanupExpiredSharedMemory();
    try {
      await vi.waitFor(() => expect(locks.get(key)).not.toBe(predecessor));
    } finally { release(); }
    await writing;
    expect(await cleanup).toBe(0);
    const result = await node.store.query(`SELECT ?name WHERE { GRAPH <${new GraphManager(node.store).sharedMemoryUri(CG)}> { <urn:legacy:root> <urn:name> ?name } }`);
    if (result.type !== 'bindings') throw new Error('expected payload bindings');
    expect(result.bindings).toEqual([{ name: '"fresh"' }]);
    expect(await node.cleanupExpiredSharedMemory()).toBeGreaterThan(0);
    expect(await node.store.query(`ASK { GRAPH <${new GraphManager(node.store).sharedMemoryUri(CG)}> { <${OTHER}> ?p ?o } }`)).toEqual({ type: 'boolean', value: false });
  });

  it.each([undefined, 'branch'])('owns every legacy root in namespace %s and rechecks expiry under those locks', async subGraphName => {
    const store = new OxigraphStore();
    const manager = new GraphManager(store);
    const meta = manager.sharedMemoryMetaUri(CG, subGraphName);
    const op = workspaceOperationSubject(CG, 'old');
    const locks = new Map<string, Promise<void>>();
    await store.insert(generateShareMetadata({ contextGraphId: CG, subGraphName, shareOperationId: 'old', rootEntities: [ROOT, OTHER], publisherPeerId: 'local', timestamp: new Date(Date.now() - TTL * 2) }, meta));
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const keys = [ROOT, OTHER].map(root => swmEntityWriteLockKey(CG, subGraphName, root));
    const writer = withKeyedLocks(locks, [keys[1]!], async () => { entered(); await gate; });
    await ready;
    const predecessor = locks.get(keys[1]!);
    const collect = vi.fn(async () => { for (const key of keys) expect(locks.has(key)).toBe(true); });
    const cleanup = withUnqueuedDraftOperation(store, CG, subGraphName, op, Date.now(), collect, { writeLocks: locks, cutoffMs: Date.now() - TTL, mayRetire: async () => true });
    try {
      await vi.waitFor(() => expect(locks.get(keys[1]!)).not.toBe(predecessor));
      await store.deleteByPattern({ graph: meta, subject: op, predicate: `${DKG}publishedAt` });
      await store.insert([{ graph: meta, subject: op, predicate: `${DKG}publishedAt`, object: JSON.stringify(new Date().toISOString()) }]);
    } finally { release(); }
    await writer; await cleanup;
    expect(collect).not.toHaveBeenCalled();
    await expire(store, op, meta);
    await withUnqueuedDraftOperation(store, CG, subGraphName, op, Date.now(), collect, { writeLocks: locks, cutoffMs: Date.now() - TTL, mayRetire: async () => true });
    expect(collect).toHaveBeenCalledOnce();
    await store.close();
  });

  it('waits for the operation identity writer before certifying a selected legacy owner', async () => {
    const store = new OxigraphStore();
    const meta = new GraphManager(store).sharedMemoryMetaUri(CG);
    const operation = workspaceOperationSubject(CG, 'old');
    await store.insert(generateShareMetadata({ contextGraphId: CG, shareOperationId: 'old', rootEntities: [ROOT], publisherPeerId: 'local', timestamp: new Date(Date.now() - TTL * 2) }, meta));
    const locks = new Map<string, Promise<void>>();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const writer = withWorkspaceOperationWriteLock({ store, contextGraphId: CG, shareOperationId: 'old' }, async () => { entered(); await gate; });
    await ready;
    const collect = vi.fn(async () => {});
    const cleanup = withUnqueuedDraftOperation(store, CG, undefined, operation, Date.now(), collect, { writeLocks: locks, cutoffMs: Date.now() - TTL, mayRetire: async () => true });
    try {
      await vi.waitFor(() => expect(locks.has(swmEntityWriteLockKey(CG, undefined, ROOT))).toBe(true));
      await store.insert([{ graph: meta, subject: operation, predicate: `${DKG}kaUal`, object: 'did:dkg:31337/0x1111111111111111111111111111111111111111/1' }]);
    } finally { release(); }
    await writer; await cleanup;
    expect(collect).not.toHaveBeenCalled();
    await store.close();
  });

  it.each(['2', '99'])('retains incomplete graph scope %s even when it has legacy root rows', async scope => {
    const store = new OxigraphStore();
    const meta = new GraphManager(store).sharedMemoryMetaUri(CG);
    const operation = workspaceOperationSubject(CG, 'incomplete');
    await store.insert(generateShareMetadata({ contextGraphId: CG, shareOperationId: 'incomplete', rootEntities: [ROOT], publisherPeerId: 'local', timestamp: new Date(Date.now() - TTL * 2) }, meta));
    await store.insert([{ graph: meta, subject: operation, predicate: `${DKG}contentScopeVersion`, object: JSON.stringify(scope) }]);
    const collect = vi.fn(async () => {});
    await withUnqueuedDraftOperation(store, CG, undefined, operation, Date.now(), collect, { writeLocks: new Map(), cutoffMs: Date.now() - TTL, mayRetire: async () => true });
    expect(collect).not.toHaveBeenCalled();
    await store.close();
  });

  it.each(['root-added', 'root-removed', 'scope-added', 'ka-added'] as const)('retains stale ownership after an in-lock %s change', async mode => {
    const store = new OxigraphStore();
    const meta = new GraphManager(store).sharedMemoryMetaUri(CG);
    const op = workspaceOperationSubject(CG, 'old');
    await store.insert(generateShareMetadata({ contextGraphId: CG, shareOperationId: 'old', rootEntities: [ROOT], publisherPeerId: 'local', timestamp: new Date(Date.now() - TTL * 2) }, meta));
    const locks = new Map<string, Promise<void>>();
    const key = swmEntityWriteLockKey(CG, undefined, ROOT);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writer = withKeyedLocks(locks, [key], async () => { await gate; });
    const predecessor = locks.get(key);
    const collect = vi.fn(async () => {});
    const cleanup = withUnqueuedDraftOperation(store, CG, undefined, op, Date.now(), collect, { writeLocks: locks, cutoffMs: Date.now() - TTL, mayRetire: async () => true });
    try {
      await vi.waitFor(() => expect(locks.get(key)).not.toBe(predecessor));
      if (mode === 'root-removed') await store.deleteByPattern({ graph: meta, subject: op, predicate: `${DKG}rootEntity` });
      else await store.insert([{ graph: meta, subject: op, predicate: `${DKG}${mode === 'root-added' ? 'rootEntity' : mode === 'scope-added' ? 'contentScopeVersion' : 'kaUal'}`, object: mode === 'root-added' ? OTHER : mode === 'scope-added' ? '"2"' : 'did:dkg:31337/0x1111111111111111111111111111111111111111/1' }]);
    } finally { release(); }
    await writer; await cleanup;
    expect(collect).not.toHaveBeenCalled();
    await store.close();
  });
});
