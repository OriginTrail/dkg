import { swmFixtures } from './swm-descriptor-fixtures.js';
import { persistLocalSwmOperation } from './_helpers/local-swm-operation.js';
import { resolveKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { NoChainAdapter, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { GraphManager, OxigraphStore, deleteByPatternWithoutCount, type Quad } from '@origintrail-official/dkg-storage';
import { STORAGE_ACK_LEDGER_GRAPH, TripleStoreAsyncLiftPublisher, storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead, swmKaWriteLockKey, withKeyedLocks, workspaceOperationSubject, storageAckLedgerEntryQuads } from '@origintrail-official/dkg-publisher';
import { storageAckNotRetainedFilters } from '../src/storage-ack-retention.js';
import { expiredSwmOperationMayRetire } from '../src/internal/swm-expiry/swm-expiry-batch.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
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
async function fixture(contextGraphId = CG) {
  const store = new OxigraphStore(); const graphManager = new GraphManager(store);
  const chain: ChainAdapter = Object.assign(new NoChainAdapter(), { chainId: '31337', readKnowledgeAssetVersionSnapshot: async (knowledgeAssetId: bigint) => ({ knowledgeAssetId, rootCount: 1n, latestAuthor: AUTHOR, latestRoot: `0x${'11'.repeat(32)}` }) });
  const writeLocks = new Map<string, Promise<void>>();
  const op = async (id: string, version = '3', kaUal = KA) => storeKnowledgeAssetOperationPublicQuads({ store, graphManager, contextGraphId, shareOperationId: id, kaUal, assertionVersion: version, quads: publicQuads, timestamp: new Date(NOW - 10 * 60_000) });
  const head = async (id = 'new', version = '2') => storeKnowledgeAssetWorkspaceHead({ store, graphManager, contextGraphId, kaUal: KA, assertionVersion: version, shareOperationId: id });
  const privateGraph = async (version: number, suffix = '') => { const graph = `did:dkg:context-graph:${contextGraphId}/_private/${AUTHOR}/7/assertions/${version}${suffix}`; await store.insert([{ ...publicQuads[0]!, graph }]); return graph; };
  const has = async (graph: string, subject?: string) => { const result = await store.query(`ASK { GRAPH <${graph}> { ${subject ? `<${subject}>` : '?s'} ?p ?o } }`); if (result.type !== 'boolean') throw new Error('expected ASK'); return result.value; };
  const collect = () => collectAbandonedDraftArtifacts({ store, chain, writeLocks, contextGraphId, now: NOW });
  return { store, chain, writeLocks, op, head, privateGraph, has, collect };
}
describe('reference-safe abandoned draft maintenance', () => {
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
    expect(await collectAbandonedDraftArtifacts({ store: f.store, chain: f.chain, writeLocks: f.writeLocks, contextGraphId: 'a', now: NOW })).toEqual({ operations: 0, privateGraphs: 0 });
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
    const collecting = collectAbandonedDraftArtifacts({ store: f.store, chain: f.chain, writeLocks: f.writeLocks, contextGraphId: 'a', now: NOW });
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
    expect(await collectAbandonedDraftArtifacts({ store: f.store, chain: f.chain, writeLocks: f.writeLocks, contextGraphId: 'a', now: NOW })).toEqual({ operations: 0, privateGraphs: 0 });
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
