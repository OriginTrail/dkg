import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { DKGAgent } from '../src/index.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';
import { persistLocalSwmOperation } from './_helpers/local-swm-operation.js';
import { resolveKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { NoChainAdapter, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { GraphManager, OxigraphStore, deleteByPatternWithoutCount, type Quad, UnsupportedTripleStoreCapabilityError } from '@origintrail-official/dkg-storage';
import { STORAGE_ACK_LEDGER_GRAPH, withWorkspaceOperationWriteLock, TripleStoreAsyncLiftPublisher, storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead, swmKaWriteLockKey, withKeyedLocks, workspaceOperationSubject, storageAckLedgerEntryQuads } from '@origintrail-official/dkg-publisher';
import { storageAckNotRetainedFilters } from '../src/storage-ack-retention.js';
import { expiredSwmOperationMayRetire } from '../src/internal/swm-expiry/swm-expiry-batch.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { collectAbandonedDraftArtifacts } from '../src/internal/draft/draft-artifact-gc.js';
import { withUnqueuedDraftOperation, withDraftOperationCollectionBatches } from '../src/internal/swm-expiry/swm-operation-expiry.js';
const CG = 'draft-gc';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const KA = `did:dkg:31337/${AUTHOR}/7`;
const DKG = 'http://dkg.io/ontology/';
const NOW = Date.parse('2026-10-04T06:00:00Z');
const META = `did:dkg:context-graph:${CG}/_shared_memory_meta`;
const ROOT_META = `did:dkg:context-graph:${CG}/_meta`;
const publicQuads: Quad[] = [{ subject: 'urn:item', predicate: 'urn:title', object: '"sealed"', graph: '' }];
async function fixture(contextGraphId = CG, store = new OxigraphStore()) {
  const graphManager = new GraphManager(store);
  const chain: ChainAdapter = Object.assign(new NoChainAdapter(), { chainId: '31337', readKnowledgeAssetVersionSnapshot: async (knowledgeAssetId: bigint) => ({ knowledgeAssetId, rootCount: 1n, latestAuthor: AUTHOR, latestRoot: `0x${'11'.repeat(32)}` }) });
  const writeLocks = new Map<string, Promise<void>>();
  const op = async (id: string, version = '3', kaUal = KA) => storeKnowledgeAssetOperationPublicQuads({ store, graphManager, contextGraphId, shareOperationId: id, kaUal, assertionVersion: version, quads: publicQuads, timestamp: new Date(NOW - 10 * 60_000) });
  const head = async (id = 'new', version = '2') => storeKnowledgeAssetWorkspaceHead({ store, graphManager, contextGraphId, kaUal: KA, assertionVersion: version, shareOperationId: id });
  const privateGraph = async (version: number, suffix = '') => { const graph = `did:dkg:context-graph:${contextGraphId}/_private/${AUTHOR}/7/assertions/${version}${suffix}`; await store.insert([{ ...publicQuads[0]!, graph }]); return graph; };
  const has = async (graph: string, subject?: string) => { const result = await store.query(`ASK { GRAPH <${graph}> { ${subject ? `<${subject}>` : '?s'} ?p ?o } }`); if (result.type !== 'boolean') throw new Error('expected ASK'); return result.value; };
  const collect = () => collectAbandonedDraftArtifacts({ store, chain, writeLocks, contextGraphId, now: NOW, pendingAckTxWindowMs: DKGAgentBase.STORAGE_ACK_PENDING_TX_WINDOW_MS });
  return { store, chain, writeLocks, op, head, privateGraph, has, collect };
}
describe('reference-safe abandoned draft maintenance', () => {
  it('superseded collection rechecks a refreshed publisher clock after waiting for its KA writer', async () => {
    const f = await fixture(); const id = 'superseded-clock-refresh';
    await f.op(id); await f.op('new', '2'); await f.head();
    const op = workspaceOperationSubject(CG, id), key = swmKaWriteLockKey(CG, undefined, KA);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const writer = withKeyedLocks(f.writeLocks, [key], async () => { entered(); await gate; });
    await ready; const prior = f.writeLocks.get(key); const collecting = f.collect();
    try {
      await vi.waitFor(() => expect(f.writeLocks.get(key)).not.toBe(prior));
      await deleteByPatternWithoutCount(f.store, { graph: META, subject: op, predicate: `${DKG}publishedAt` });
      await f.store.insert([{ graph: META, subject: op, predicate: `${DKG}publishedAt`, object: `"${new Date(NOW).toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` }]);
      release(); await writer;
      expect(await collecting).toEqual({ operations: 0, privateGraphs: 0 });
      expect(await f.has(META, op)).toBe(true);
    } finally { release(); await Promise.allSettled([writer, collecting]); await f.store.close(); }
  });

  it('superseded collection waits for its operation identity writer and revalidates switched KA ownership', async () => {
    const f = await fixture(); const id = 'superseded-owner-switch';
    await f.op(id); await f.op('new', '2'); await f.head();
    const op = workspaceOperationSubject(CG, id), key = swmKaWriteLockKey(CG, undefined, KA);
    const rows = await f.store.query(`SELECT ?g WHERE { GRAPH <${META}> { <${op}> <${DKG}publicSnapshotGraph> ?g } }`);
    if (rows.type !== 'bindings' || !rows.bindings[0]?.['g']) throw new Error('Missing immutable snapshot');
    const snapshot = rows.bindings[0]['g'];
    let release!: () => void, entered!: () => void, allowDelete!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const deleteGate = new Promise<void>(resolve => { allowDelete = resolve; });
    let deletionStarted = false;
    const original = f.store.deleteByPatternWithoutCount.bind(f.store);
    const remove = vi.spyOn(f.store, 'deleteByPatternWithoutCount').mockImplementation(async pattern => {
      if (pattern.subject === op && pattern.predicate === undefined) { deletionStarted = true; await deleteGate; }
      return original(pattern);
    });
    const writer = withWorkspaceOperationWriteLock({ store: f.store, contextGraphId: CG, shareOperationId: id }, async () => { entered(); await gate; });
    await ready; const collecting = f.collect();
    try {
      await vi.waitFor(() => expect(f.writeLocks.has(key)).toBe(true));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(deletionStarted).toBe(false);
      await original({ graph: META, subject: op, predicate: `${DKG}kaUal` });
      await f.store.insert([{ graph: META, subject: op, predicate: `${DKG}kaUal`, object: `${KA}-different` }]);
      release(); await writer; allowDelete();
      expect(await collecting).toEqual({ operations: 0, privateGraphs: 0 });
      expect(await f.has(META, op)).toBe(true); expect(await f.has(snapshot)).toBe(true);
    } finally { release(); allowDelete(); await Promise.allSettled([writer, collecting]); remove.mockRestore(); await f.store.close(); }
  });

  it.each(['TTL', 'superseded'] as const)('%s retirement prevents late queue admission after deletion through the shared boundary', async lane => {
    const f = await fixture(); const id = `${lane.toLowerCase()}-retired`; await f.op(id);
    const op = workspaceOperationSubject(CG, id);
    try {
      if (lane === 'TTL') {
        await withUnqueuedDraftOperation(f.store, CG, undefined, op, NOW, () => deleteByPatternWithoutCount(f.store, { graph: META, subject: op }).then(() => {}), {
          writeLocks: f.writeLocks, cutoffMs: NOW, mayRetire: async () => true,
        });
      } else {
        await f.op('new', '2'); await f.head();
        expect(await f.collect()).toEqual({ operations: 1, privateGraphs: 0 });
      }
      expect(await f.has(META, op)).toBe(false);
      const queue = new TripleStoreAsyncLiftPublisher(f.store);
      await expect(queue.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: CG, shareOperationId: id, assertionVersion: '3', kaUal: KA }))).rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });
      expect(await queue.list()).toEqual([]);
    } finally { await f.store.close(); }
  });

  it.each(['absent', 'refused'] as const)('retains queued operation and snapshot during a real %s atomic-capability fallback transition', async mode => {
    const inner = new OxigraphStore();
    const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
    const orphanRead = gate(); const returnOrphans = gate(); const transitionRead = gate();
    const deleted = gate(); const insertJob = gate();
    let armed = false; let jobRef = ''; let collectorReachedReferences = false;
    const store = new Proxy(inner, { get(target, prop) {
      if (prop === 'replaceSubject') return mode === 'absent' ? undefined : async () => {
        throw new UnsupportedTripleStoreCapabilityError('replaceSubject', 'non-atomic test backend');
      };
      if (prop === 'query') return async (...args: Parameters<OxigraphStore['query']>) => {
        const result = await target.query(...args);
        if (armed && args[1]?.source === 'publisher.asyncLift.getStatus') transitionRead.release();
        if (armed && args[1]?.source === 'publisher.draftArtifacts.orphanRequests') {
          expect(result).toEqual({ type: 'boolean', value: false });
          orphanRead.release(); await returnOrphans.promise;
        }
        if (armed && args[1]?.source === 'publisher.draftArtifacts.queueReferences') collectorReachedReferences = true;
        return result;
      };
      if (prop === 'deleteByPatternWithoutCount') return async (...args: Parameters<OxigraphStore['deleteByPatternWithoutCount']>) => {
        await target.deleteByPatternWithoutCount(...args);
        if (armed && args[0].subject === jobRef) { deleted.release(); await insertJob.promise; }
      };
      const value = Reflect.get(target, prop, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const f = await fixture(CG, store); await f.op('queued'); await f.op('new', '2'); await f.head();
    const operation = workspaceOperationSubject(CG, 'queued');
    const locator = await store.query(`SELECT ?g WHERE { GRAPH <${META}> { <${operation}> <${DKG}publicSnapshotGraph> ?g } }`);
    if (locator.type !== 'bindings' || !locator.bindings[0]?.['g']) throw new Error('Missing native operation snapshot');
    const snapshot = locator.bindings[0]['g'];
    const queue = new TripleStoreAsyncLiftPublisher(store);
    const jobId = await queue.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: CG, shareOperationId: 'queued', kaUal: KA, assertionVersion: '3' }));
    await queue.claimNext('wallet'); jobRef = `urn:dkg:publisher:lift-job:${jobId}`;
    let transition: Promise<void> | undefined; let collecting: ReturnType<typeof f.collect> | undefined;
    try {
      armed = true; collecting = f.collect(); await orphanRead.promise;
      transition = queue.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      await transitionRead.promise; await new Promise<void>(resolve => setImmediate(resolve));
      returnOrphans.release(); const counts = await collecting;
      await deleted.promise; // the supported fallback has really deleted the native job subject
      expect(collectorReachedReferences).toBe(true);
      expect(await queue.getStatus(jobId)).toBeNull();
      expect({ ...counts, operationRetained: await f.has(META, operation), snapshotRetained: await f.has(snapshot) })
        .toEqual({ operations: 0, privateGraphs: 0, operationRetained: true, snapshotRetained: true });
      insertJob.release(); await transition;
      expect((await queue.getStatus(jobId))?.status).toBe('validated');
      expect(await f.has(META, operation)).toBe(true); expect(await f.has(snapshot)).toBe(true);
    } finally {
      returnOrphans.release(); insertJob.release();
      await Promise.allSettled([transition, collecting]); await inner.close();
    }
  });

  it.each([true, false])('retains the complete expired alias class when registered ACK ownership=%s', async retained => {
    const f = await fixture(); const clock = new Date(NOW - 2 * 60 * 60_000);
    const make = (operationId: string) => swmFixtures(CG).share({ version: 2, operationId, marker: 'same-expired-content', ual: KA, timestamp: clock });
    const publisher = make('expired-publisher'); const ack = make('storage-ack-expired');
    for (const op of [publisher, ack]) await persistLocalSwmOperation(f.store, CG, op);
    const headRows = publisher.meta.filter(row => row.subject === publisher.headSubject);
    await f.store.insert([...headRows, { ...headRows.find(row => row.predicate === `${DKG}shareOperationId`)!, object: JSON.stringify(ack.operationId) }, ...publisher.payload.map(row => ({ ...row, graph: publisher.assertionGraph }))]);
    await f.store.insert(storageAckLedgerEntryQuads({ namespace: CG, metaGraph: META, contextGraphId: '42', kaUal: KA, assertionVersion: '2', operation: 'publish', operationSubject: ack.operationSubject, signedAt: clock }));
    await f.store.insert([{ graph: STORAGE_ACK_LEDGER_GRAPH, subject: ack.operationSubject, predicate: `${DKG}${retained ? 'storageAckRegisteredAt' : 'storageAckUnregisteredAt'}`, object: JSON.stringify(clock.toISOString()) }]);
    const cutoff = new Date(NOW - 60 * 60_000).toISOString();
    const mayRetire = (operationSubject = publisher.operationSubject) => expiredSwmOperationMayRetire(f.store, { metaGraph: META, operationSubject, cutoff, retentionFilters: storageAckNotRetainedFilters({ rootMetaGraph: ROOT_META, metaGraph: META, binding: '', opVar: '?op', tsVar: '?ts', retentionCutoffIso: new Date(NOW - 90 * 60_000).toISOString(), suffix: 'AliasRecheck', ledgerReady: true }) });
    const collect = vi.fn(() => deleteByPatternWithoutCount(f.store, { graph: META, subject: publisher.operationSubject }));
    try {
      await withUnqueuedDraftOperation(f.store, CG, undefined, publisher.operationSubject, NOW, collect, { writeLocks: f.writeLocks, cutoffMs: Date.parse(cutoff), mayRetire });
      expect(collect).toHaveBeenCalledTimes(retained ? 0 : 1);
      if (retained) {
        const head = await resolveKnowledgeAssetWorkspaceHead({ store: f.store, graphManager: new GraphManager(f.store), contextGraphId: CG, kaUal: KA });
        expect(head?.operationAliases.map(alias => alias.shareOperationId).sort()).toEqual([publisher.operationId, ack.operationId].sort());
      }
    } finally { await f.store.close(); }
  });
  it.each(['plain', 'rdf-unicode'] as const)('uses the shared literal decoder for %s collector bindings', async form => {
    const f = await fixture(); const id = 'obsolete-🦉'; await f.op(id); await f.op('new', '2'); await f.head();
    const original = f.store.query.bind(f.store);
    const query = vi.spyOn(f.store, 'query').mockImplementation(async (sparql, options) => {
      const result = await original(sparql, options);
      if (result.type !== 'bindings') return result;
      return { ...result, bindings: result.bindings.map(row => ({ ...row,
        ...(row['id'] ? { id: form === 'plain' ? row['id'].replace(/^"|"$/g, '') : row['id'].replace('🦉', '\\U0001F989') } : {}),
        ...(row['cursor'] && form === 'rdf-unicode' ? { cursor: row['cursor'].replace('🦉', '\\U0001F989') } : {}),
      })) };
    });
    try {
      expect(await f.collect()).toEqual({ operations: 1, privateGraphs: 0 });
      expect(await f.has(META, workspaceOperationSubject(CG, id))).toBe(false);
      expect(await f.has(META, workspaceOperationSubject(CG, 'new'))).toBe(true);
    } finally { query.mockRestore(); await f.store.close(); }
  });
  it.each(['clock', 'signed-ledger'] as const)('revalidates a selected expired operation after an in-lock %s refresh', async mode => {
    const f = await fixture(); const id = 'storage-ack-refreshed'; await f.op(id, '1'); await f.head(id, '1');
    const key = swmKaWriteLockKey(CG, undefined, KA);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const writing = withKeyedLocks(f.writeLocks, [key], async () => { entered(); await gate; });
    await ready; const predecessor = f.writeLocks.get(key); const collect = vi.fn(async () => {});
    const retiring = withUnqueuedDraftOperation(f.store, CG, undefined, workspaceOperationSubject(CG, id), NOW, collect, {
      writeLocks: f.writeLocks, cutoffMs: NOW,
      mayRetire: () => expiredSwmOperationMayRetire(f.store, { metaGraph: META, operationSubject: workspaceOperationSubject(CG, id), cutoff: new Date(NOW).toISOString(), retentionFilters: storageAckNotRetainedFilters({ rootMetaGraph: ROOT_META, metaGraph: META, binding: '', opVar: '?op', tsVar: '?ts', retentionCutoffIso: new Date(NOW - 30 * 24 * 60 * 60_000).toISOString(), suffix: 'Recheck', ledgerReady: true }) }),
    });
    await vi.waitFor(() => expect(f.writeLocks.get(key)).not.toBe(predecessor));
    if (mode === 'clock') {
      await f.store.deleteByPattern({ graph: META, subject: workspaceOperationSubject(CG, id), predicate: `${DKG}publishedAt` });
      await f.store.insert([{ graph: META, subject: workspaceOperationSubject(CG, id), predicate: `${DKG}publishedAt`, object: `"${new Date(NOW + 1).toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` }]);
    } else await f.store.insert(storageAckLedgerEntryQuads({ namespace: CG, metaGraph: META, contextGraphId: '42', kaUal: KA, assertionVersion: '1', operation: 'publish', operationSubject: workspaceOperationSubject(CG, id), signedAt: new Date(NOW) }));
    release(); await writing; await retiring;
    expect(collect).not.toHaveBeenCalled();
    expect(await f.has(META, workspaceOperationSubject(CG, id))).toBe(true);
    await f.store.close();
  });
  it('retains an expired operation when its shared KA ownership cannot be proven', async () => {
    const f = await fixture(); const id = 'missing-ka-owner'; await f.op(id);
    await deleteByPatternWithoutCount(f.store, { graph: META, subject: workspaceOperationSubject(CG, id), predicate: `${DKG}kaUal` });
    const collect = vi.fn(async () => {});
    try {
      await withUnqueuedDraftOperation(f.store, CG, undefined, workspaceOperationSubject(CG, id), NOW, collect, {
        writeLocks: f.writeLocks, cutoffMs: NOW, mayRetire: async () => true,
      });
      expect(collect).not.toHaveBeenCalled();
      expect(await f.has(META, workspaceOperationSubject(CG, id))).toBe(true);
    } finally { await f.store.close(); }
  });
  it('acquires queue references once per 32-operation chunk and admits a later queued operation between chunks', async () => {
    const f = await fixture();
    const ids = Array.from({ length: 65 }, (_, index) => `batch-${index}`);
    for (const id of ids) await f.op(id, '1', id === ids[64] ? KA.replace('/7', '/8') : KA);
    const queue = new TripleStoreAsyncLiftPublisher(f.store);
    await queue.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: CG, shareOperationId: ids[0]!, assertionVersion: '1', kaUal: KA }));
    const query = vi.spyOn(f.store, 'query');
    const retired: string[] = [];
    let lateAdmission: Promise<unknown> | undefined;
    await withDraftOperationCollectionBatches(f.store, ids, async (id, session) => {
      await session.withUnqueuedOperation(CG, undefined, workspaceOperationSubject(CG, id), NOW, async () => { retired.push(id); }, { writeLocks: f.writeLocks, cutoffMs: NOW, mayRetire: async () => true });
      if (id === ids[31]) lateAdmission = queue.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: CG, shareOperationId: ids[64]!, name: 'late-other', assertionVersion: '1', kaUal: KA.replace('/7', '/8') }));
    });
    await lateAdmission;
    expect(query.mock.calls.filter(([, options]) => options?.source === 'publisher.draftArtifacts.queueReferences')).toHaveLength(3);
    expect(retired).toHaveLength(63);
    expect(retired).not.toContain(ids[0]); expect(retired).not.toContain(ids[64]);
    await expect(queue.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: CG, shareOperationId: ids[1]!, assertionVersion: '1' }))).rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });
    query.mockRestore(); await f.store.close();
  });
  it('unknown queue coverage preserves every operation in each bounded chunk', async () => {
    const f = await fixture(); const ids = Array.from({ length: 65 }, (_, index) => `unknown-${index}`);
    const original = f.store.query.bind(f.store);
    const query = vi.spyOn(f.store, 'query').mockImplementation((text, options) => options?.source === 'publisher.draftArtifacts.queueReferences' ? Promise.resolve({ type: 'boolean', value: false }) : original(text, options));
    const collect = vi.fn(async () => {});
    await withDraftOperationCollectionBatches(f.store, ids, collect);
    expect(collect).not.toHaveBeenCalled();
    expect(query.mock.calls.filter(([, options]) => options?.source === 'publisher.draftArtifacts.queueReferences')).toHaveLength(3);
    query.mockRestore(); await f.store.close();
  });
  it('preserves queued snapshots and commitments in slash-containing descendant context graphs', async () => {
    const owner = 'a/b'; const f = await fixture(owner);
    await f.op('queued'); await f.op('new', '2'); await f.head();
    const operation = workspaceOperationSubject(owner, 'queued');
    const meta = `did:dkg:context-graph:${owner}/_shared_memory_meta`;
    const result = await f.store.query(`SELECT ?snapshot WHERE { GRAPH <${meta}> { <${operation}> <${DKG}publicSnapshotGraph> ?snapshot } }`);
    if (result.type !== 'bindings') throw new Error('expected snapshot bindings');
    const snapshot = result.bindings[0]!['snapshot']!;
    const archive = await f.privateGraph(3, `/commitments/${'ab'.repeat(32)}`);
    const queue = new TripleStoreAsyncLiftPublisher(f.store);
    await queue.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: owner, shareOperationId: 'queued', assertionVersion: '3' }));
    expect(await collectAbandonedDraftArtifacts({ store: f.store, chain: f.chain, writeLocks: f.writeLocks, contextGraphId: 'a', now: NOW, pendingAckTxWindowMs: DKGAgentBase.STORAGE_ACK_PENDING_TX_WINDOW_MS })).toEqual({ operations: 0, privateGraphs: 0 });
    let deleted = false;
    await withUnqueuedDraftOperation(f.store, 'a', 'b', operation, NOW, async () => { deleted = true; }, { writeLocks: f.writeLocks, cutoffMs: NOW, mayRetire: async () => true });
    expect(deleted).toBe(false);
    for (const graph of [snapshot, archive]) expect(await f.has(graph)).toBe(true);
    expect(await f.has(meta, operation)).toBe(true);
  });
  it('serializes ambiguous private collection with the descendant CG writer and rechecks its seal', async () => {
    const owner = 'a/b'; const f = await fixture(owner); const archive = await f.privateGraph(9);
    const key = swmKaWriteLockKey(owner, undefined, KA);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const writing = withKeyedLocks(f.writeLocks, [key], async () => { entered(); await gate; });
    await ready; const predecessor = f.writeLocks.get(key);
    const collecting = collectAbandonedDraftArtifacts({ store: f.store, chain: f.chain, writeLocks: f.writeLocks, contextGraphId: 'a', now: NOW, pendingAckTxWindowMs: DKGAgentBase.STORAGE_ACK_PENDING_TX_WINDOW_MS });
    try {
      await vi.waitFor(() => expect(f.writeLocks.get(key)).not.toBe(predecessor));
      await f.store.insert([
        { graph: `did:dkg:context-graph:${owner}/_meta`, subject: 'urn:late:seal', predicate: `${DKG}kaUal`, object: KA },
        { graph: `did:dkg:context-graph:${owner}/_meta`, subject: 'urn:late:seal', predicate: `${DKG}assertionVersion`, object: '"9"^^<http://www.w3.org/2001/XMLSchema#integer>' },
      ]);
    } finally { release(); await writing; }
    expect(await collecting).toEqual({ operations: 0, privateGraphs: 0 });
    expect(await f.has(archive)).toBe(true);
  });
  it('protects a descendant queued private archive even when its operation metadata needs recovery', async () => {
    const owner = 'a/b'; const f = await fixture(owner); await f.op('queued');
    const archive = await f.privateGraph(3, `/commitments/${'ab'.repeat(32)}`);
    const queue = new TripleStoreAsyncLiftPublisher(f.store);
    await queue.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: owner, shareOperationId: 'queued', assertionVersion: '3' }));
    await deleteByPatternWithoutCount(f.store, { graph: `did:dkg:context-graph:${owner}/_shared_memory_meta`, subject: workspaceOperationSubject(owner, 'queued') });
    expect(await collectAbandonedDraftArtifacts({ store: f.store, chain: f.chain, writeLocks: f.writeLocks, contextGraphId: 'a', now: NOW, pendingAckTxWindowMs: DKGAgentBase.STORAGE_ACK_PENDING_TX_WINDOW_MS })).toEqual({ operations: 0, privateGraphs: 0 });
    expect(await f.has(archive)).toBe(true);
  });
  it('retires superseded operations before the 30-day TTL and only removes unreachable burned private versions', async () => {
    const f = await fixture(); await f.op('old'); await f.op('new', '2'); await f.head();
    const old = await f.privateGraph(3); const archive = await f.privateGraph(3, `/commitments/${'ab'.repeat(32)}`);
    const previous = await f.privateGraph(1); const next = await f.privateGraph(2);
    const sibling = `did:dkg:context-graph:${CG}/_private/${AUTHOR}/8/assertions/3`;
    await f.store.insert([{ ...publicQuads[0]!, graph: sibling }, { subject: 'urn:sibling:seal', predicate: `${DKG}kaUal`, object: `did:dkg:31337/${AUTHOR}/8`, graph: ROOT_META }, { subject: 'urn:sibling:seal', predicate: `${DKG}assertionVersion`, object: '"3"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: ROOT_META }]);
    expect(await f.collect()).toEqual({ operations: 1, privateGraphs: 2 });
    expect(await f.has(META, workspaceOperationSubject(CG, 'old'))).toBe(false); expect(await f.has(META, workspaceOperationSubject(CG, 'new'))).toBe(true);
    for (const graph of [old, archive]) expect(await f.has(graph)).toBe(false);
    for (const graph of [previous, next, sibling]) expect(await f.has(graph)).toBe(true);
  });
  it('preserves ACK copies, current aliases and sealed private archives', async () => {
    const f = await fixture(); await f.op('current'); await f.head('current', '3');
    await f.op('storage-ack-held'); await f.op('signed-held');
    await f.store.insert([{ subject: workspaceOperationSubject(CG, 'signed-held'), predicate: `${DKG}storageAckSignedAt`, object: '"2026-10-04"', graph: STORAGE_ACK_LEDGER_GRAPH }, { subject: 'urn:seal', predicate: `${DKG}kaUal`, object: KA, graph: ROOT_META }, { subject: 'urn:seal', predicate: `${DKG}assertionVersion`, object: '"3"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: ROOT_META }]);
    const graph = await f.privateGraph(3, `/commitments/${'cd'.repeat(32)}`);
    expect(await f.collect()).toEqual({ operations: 0, privateGraphs: 0 }); expect(await f.has(graph)).toBe(true);
  });
  it('retains an otherwise collectible lifecycle operation and snapshot only until its reference is removed', async () => {
    const f = await fixture(); await f.op('lifecycle-only', '4'); await f.op('new', '2'); await f.head();
    const operation = workspaceOperationSubject(CG, 'lifecycle-only');
    const result = await f.store.query(`SELECT ?snapshot WHERE { GRAPH <${META}> {
      <${operation}> <${DKG}publicSnapshotGraph> ?snapshot
    } }`);
    if (result.type !== 'bindings' || result.bindings.length !== 1) throw new Error('expected one immutable snapshot');
    const snapshot = result.bindings[0]!['snapshot']!;
    await f.store.insert([{ subject: 'urn:lifecycle-only', predicate: `${DKG}currentShareOperationId`, object: '"lifecycle-only"', graph: ROOT_META }]);
    expect(await f.collect()).toEqual({ operations: 0, privateGraphs: 0 });
    expect(await f.has(META, operation)).toBe(true);
    expect(await f.has(snapshot)).toBe(true);
    await deleteByPatternWithoutCount(f.store, { graph: ROOT_META, subject: 'urn:lifecycle-only', predicate: `${DKG}currentShareOperationId` });
    expect(await f.collect()).toEqual({ operations: 1, privateGraphs: 0 });
    expect(await f.has(META, operation)).toBe(false);
    expect(await f.has(snapshot)).toBe(false);
  });
  it('retains queued immutable snapshots and commitments until explicitly cleared', async () => {
    const f = await fixture(); await f.op('queued'); await f.op('new', '2'); await f.head(); const graph = await f.privateGraph(3, `/commitments/${'ab'.repeat(32)}`);
    const queue = new TripleStoreAsyncLiftPublisher(f.store, { knowledgeAssetVmPublishHandler: { preflight: async () => { throw Object.assign(new Error('damaged head'), { code: 'KA_WORKSPACE_HEAD_CORRUPT' }); }, execute: async () => { throw new Error('must not publish'); } } });
    const request = kaVmPublishRequest({ contextGraphId: CG, shareOperationId: 'queued', assertionVersion: '3' }); const jobId = await queue.enqueueKnowledgeAssetVmPublish(request);
    expect(await f.collect()).toEqual({ operations: 0, privateGraphs: 0 }); await queue.processNext('wallet'); expect((await queue.getStatus(jobId))?.status).toBe('failed');
    expect(await f.collect()).toEqual({ operations: 0, privateGraphs: 0 }); expect((await queue.clearTerminalJob(jobId)).outcome).toBe('cleared');
    expect(await f.collect()).toEqual({ operations: 1, privateGraphs: 1 }); expect(await f.has(graph)).toBe(false);
    await expect(queue.enqueueKnowledgeAssetVmPublish(request)).rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' }); expect(await queue.list()).toHaveLength(0);
  });
  it.each(['damaged', 'orphan'])('suspends collection with %s queue coverage', async (mode) => {
    const f = await fixture(); await f.op('old'); await f.op('new', '2'); await f.head(); const graph = await f.privateGraph(3);
    await f.store.insert([{ subject: `urn:${mode}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `urn:dkg:publisher:${mode === 'damaged' ? 'LiftJob' : 'LiftRequest'}`, graph: 'urn:control' }]);
    expect(await f.collect()).toEqual({ operations: 0, privateGraphs: 0 }); expect(await f.has(META, workspaceOperationSubject(CG, 'old'))).toBe(true); expect(await f.has(graph)).toBe(true);
  });
  it.each(['snapshot', 'currency'] as const)('retains private artifacts when the coherent %s RPC rejects', async phase => {
    const f = await fixture();
    const failure = new Error(`${phase} RPC unavailable`);
    if (phase === 'snapshot') f.chain.readKnowledgeAssetVersionSnapshot = async () => { throw failure; };
    else f.chain.knowledgeAssetVersionSnapshotIsCurrent = async () => { throw failure; };
    const graph = await f.privateGraph(9);
    try {
      expect(await f.collect()).toEqual({ operations: 0, privateGraphs: 0 });
      expect(await f.has(graph)).toBe(true);
    } finally { await f.store.close(); }
  });
  it.each(['AbortError', 'ABORT_ERR'] as const)('propagates %s cancellation from private evidence acquisition', async marker => {
    const f = await fixture();
    const failure = marker === 'AbortError'
      ? new DOMException('chain reader closed or target superseded', 'AbortError')
      : Object.assign(new Error('chain reader closed'), { code: 'ABORT_ERR' });
    f.chain.readKnowledgeAssetVersionSnapshot = async () => { throw failure; };
    const graph = await f.privateGraph(9);
    try {
      await expect(f.collect()).rejects.toBe(failure);
      expect(await f.has(graph)).toBe(true);
    } finally { await f.store.close(); }
  });
  it('propagates private-artifact storage deletion failure after available chain evidence', async () => {
    const f = await fixture(); const graph = await f.privateGraph(9);
    const failure = new Error('private artifact deletion failed');
    const drop = vi.spyOn(f.store, 'dropGraph').mockRejectedValue(failure);
    try {
      await expect(f.collect()).rejects.toBe(failure);
      expect(await f.has(graph)).toBe(true);
    } finally { drop.mockRestore(); await f.store.close(); }
  });
  it('continues real TTL cleanup in this and later CGs after private-artifact RPC rejection', async () => {
    const snapshot = vi.fn(async () => { throw new Error('snapshot RPC unavailable'); });
    const chain = Object.assign(new NoChainAdapter(), { chainId: '31337', readKnowledgeAssetVersionSnapshot: snapshot });
    const agent = await DKGAgent.create({ name: 'private-rpc-independent-ttl', chainAdapter: chain, sharedMemoryTtlMs: 60_000 });
    const store = agent.store, manager = new GraphManager(store);
    try {
      await manager.ensureContextGraph('private-rpc-first');
      await manager.ensureContextGraph('private-rpc-later');
      // Put the unavailable artifact in the actual first enumeration entry,
      // so a premature return would also strand the second Context Graph.
      const [first, later] = await manager.listContextGraphs();
      if (!first || !later) throw new Error('Expected both real Context Graphs');
      const privateGraph = `did:dkg:context-graph:${first}/_private/${AUTHOR}/7/assertions/9/commitments/${'ab'.repeat(32)}`;
      await store.insert([{ ...publicQuads[0]!, graph: privateGraph }]);
      const seed = async (cg: string, id: string, ka = KA) => {
        await storeKnowledgeAssetOperationPublicQuads({
          store, graphManager: manager, contextGraphId: cg, shareOperationId: id,
          kaUal: ka, assertionVersion: 1, quads: publicQuads, timestamp: new Date(Date.now() - 120_000),
        });
        await storeKnowledgeAssetWorkspaceHead({ store, graphManager: manager, contextGraphId: cg, kaUal: ka, assertionVersion: 1, shareOperationId: id });
        const meta = manager.sharedMemoryMetaUri(cg), subject = workspaceOperationSubject(cg, id);
        const rows = await store.query(`SELECT ?g WHERE { GRAPH <${meta}> { <${subject}> <${DKG}publicSnapshotGraph> ?g } }`);
        if (rows.type !== 'bindings' || !rows.bindings[0]?.['g']) throw new Error('Expected actual immutable snapshot');
        return { meta, subject, snapshot: rows.bindings[0]['g'] };
      };
      const expired = await seed(first, 'expired');
      const queuedKa = KA.replace('/7', '/8');
      const queued = await seed(first, 'queued', queuedKa);
      const laterExpired = await seed(later, 'later-expired');
      const queue = new TripleStoreAsyncLiftPublisher(store);
      const jobId = await queue.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: first, shareOperationId: 'queued', assertionVersion: '1', kaUal: queuedKa, reservedUal: queuedKa, kaNumber: '8' }));
      const accepted = await queue.getStatus(jobId);
      expect(accepted?.status).toBe('accepted');
      const present = async (graph: string, subject?: string) => {
        const rows = await store.query(`ASK { GRAPH <${graph}> { ${subject ? `<${subject}>` : '?s'} ?p ?o } }`);
        if (rows.type !== 'boolean') throw new Error('Expected native ASK result');
        return rows.value;
      };
      expect(await agent.cleanupExpiredSharedMemory()).toBeGreaterThan(0);
      expect(snapshot).toHaveBeenCalled();
      expect(await present(privateGraph)).toBe(true);
      for (const retired of [expired, laterExpired]) {
        expect(await present(retired.meta, retired.subject)).toBe(false);
        expect(await present(retired.snapshot)).toBe(false);
      }
      expect(await present(queued.meta, queued.subject)).toBe(true);
      expect(await present(queued.snapshot)).toBe(true);
      expect(await queue.getStatus(jobId)).toEqual(accepted);
    } finally { await agent.stop(); await store.close(); }
  });
  it('preserves private records when coherent chain coverage is unavailable', async () => {
    const f = await fixture(); f.chain.readKnowledgeAssetVersionSnapshot = async () => null; const graph = await f.privateGraph(9);
    expect(await f.collect()).toEqual({ operations: 0, privateGraphs: 0 }); expect(await f.has(graph)).toBe(true);
  });
  it('protects queued snapshots from the older 30-day TTL lane as well', async () => {
    const f = await fixture(); await f.op('queued');
    const queue = new TripleStoreAsyncLiftPublisher(f.store);
    await queue.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: CG, shareOperationId: 'queued', assertionVersion: '3' }));
    let deleted = false;
    await withUnqueuedDraftOperation(f.store, CG, undefined, workspaceOperationSubject(CG, 'queued'), NOW, async () => { deleted = true; }, { writeLocks: f.writeLocks, cutoffMs: NOW, mayRetire: async () => true });
    expect(deleted).toBe(false);
  });
  it.each(['missing', 'conflicting'] as const)('refuses TTL collection with a %s operation ID', async (mode) => {
    const f = await fixture(); await f.op('damaged');
    const operation = workspaceOperationSubject(CG, 'damaged');
    if (mode === 'missing') {
      await deleteByPatternWithoutCount(f.store, { graph: META, subject: operation, predicate: `${DKG}shareOperationId` });
    } else {
      await f.store.insert([{ graph: META, subject: operation, predicate: `${DKG}shareOperationId`, object: '"other"' }]);
    }
    let deleted = false;
    await withUnqueuedDraftOperation(f.store, CG, undefined, operation, NOW, async () => { deleted = true; }, { writeLocks: f.writeLocks, cutoffMs: NOW, mayRetire: async () => true });
    expect(deleted).toBe(false);
    expect(await f.has(META, operation)).toBe(true);
  });
  it('advances the operation cursor beyond 32 retained ACK copies to collect later drafts', async () => {
    const f = await fixture();
    for (let index = 0; index < 40; index += 1) await f.op(`old-${index}`);
    await f.op('new', '2'); await f.head();
    const candidates = await f.store.query(`SELECT DISTINCT ?op WHERE { GRAPH <${META}> {
      ?op a <${DKG}WorkspaceOperation> ; <${DKG}shareOperationId> ?id .
      FILTER(?id != "new")
    } } ORDER BY ?op`);
    if (candidates.type !== 'bindings') throw new Error('expected operation bindings');
    expect(candidates.bindings).toHaveLength(40);
    const retained = candidates.bindings.slice(0, 32).map(row => row['op']!);
    const collectible = candidates.bindings.slice(32).map(row => row['op']!);
    await f.store.insert(retained.map(subject => ({
      subject, predicate: `${DKG}storageAckSignedAt`, object: '"2026-10-04"', graph: STORAGE_ACK_LEDGER_GRAPH,
    })));
    expect((await f.collect()).operations).toBe(0);
    expect((await f.collect()).operations).toBe(8);
    for (const op of retained) expect(await f.has(META, op)).toBe(true);
    for (const op of collectible) expect(await f.has(META, op)).toBe(false);
  });

  it('advances a bounded cursor past more than 32 retained private graphs', async () => {
    const f = await fixture();
    for (let index = 0; index < 40; index += 1) await f.privateGraph(1, `/commitments/${index.toString(16).padStart(64, '0')}`);
    const burned = await f.privateGraph(9);
    expect((await f.collect()).privateGraphs).toBe(0);
    expect((await f.collect()).privateGraphs).toBe(1);
    expect(await f.has(burned)).toBe(false);
  });
  it('serializes late admission with retirement and refuses to persist a stranded job', async () => {
    const f = await fixture(); await f.op('old'); await f.op('new', '2'); await f.head();
    let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const entered = new Promise<void>((resolve) => { reached = resolve; });
    const original = f.store.insert.bind(f.store);
    f.store.insert = async (quads, options) => { if (quads.some((quad) => quad.graph === 'urn:dkg:publisher:draft-artifact-retirements')) { reached(); await gate; } return original(quads, options); };
    const collecting = f.collect(); await entered; const queue = new TripleStoreAsyncLiftPublisher(f.store);
    const admitting = queue.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: CG, shareOperationId: 'old', assertionVersion: '3' })).catch((error: unknown) => error);
    release(); expect((await collecting).operations).toBe(1); expect(await admitting).toMatchObject({ code: 'PUBLISH_INTENT_STALE' }); expect(await queue.list()).toHaveLength(0);
  });
});
