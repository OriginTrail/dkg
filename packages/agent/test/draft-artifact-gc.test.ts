// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { NoChainAdapter, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { GraphManager, OxigraphStore, deleteByPatternWithoutCount, type Quad } from '@origintrail-official/dkg-storage';
import { STORAGE_ACK_LEDGER_GRAPH, TripleStoreAsyncLiftPublisher, storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead, workspaceOperationSubject } from '@origintrail-official/dkg-publisher';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { collectAbandonedDraftArtifacts, withUnqueuedDraftOperation } from '../src/draft-artifact-gc.js';
const CG = 'draft-gc';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const KA = `did:dkg:31337/${AUTHOR}/7`;
const DKG = 'http://dkg.io/ontology/';
const NOW = Date.parse('2026-10-04T06:00:00Z');
const META = `did:dkg:context-graph:${CG}/_shared_memory_meta`;
const PRIVATE = `did:dkg:context-graph:${CG}/_private/${AUTHOR}/7/assertions`;
const ROOT_META = `did:dkg:context-graph:${CG}/_meta`;
const publicQuads: Quad[] = [{ subject: 'urn:item', predicate: 'urn:title', object: '"sealed"', graph: '' }];
async function fixture() {
  const store = new OxigraphStore(); const graphManager = new GraphManager(store);
  const chain: ChainAdapter = Object.assign(new NoChainAdapter(), { chainId: '31337', readKnowledgeAssetVersionSnapshot: async (knowledgeAssetId: bigint) => ({ knowledgeAssetId, rootCount: 1n, latestAuthor: AUTHOR, latestRoot: `0x${'11'.repeat(32)}` }) });
  const writeLocks = new Map<string, Promise<void>>();
  const op = async (id: string, version = '3', kaUal = KA) => storeKnowledgeAssetOperationPublicQuads({ store, graphManager, contextGraphId: CG, shareOperationId: id, kaUal, assertionVersion: version, quads: publicQuads, timestamp: new Date(NOW - 10 * 60_000) });
  const head = async (id = 'new', version = '2') => storeKnowledgeAssetWorkspaceHead({ store, graphManager, contextGraphId: CG, kaUal: KA, assertionVersion: version, shareOperationId: id });
  const privateGraph = async (version: number, suffix = '') => { const graph = `${PRIVATE}/${version}${suffix}`; await store.insert([{ ...publicQuads[0]!, graph }]); return graph; };
  const has = async (graph: string, subject?: string) => { const result = await store.query(`ASK { GRAPH <${graph}> { ${subject ? `<${subject}>` : '?s'} ?p ?o } }`); if (result.type !== 'boolean') throw new Error('expected ASK'); return result.value; };
  const collect = () => collectAbandonedDraftArtifacts({ store, chain, writeLocks, contextGraphId: CG, now: NOW });
  return { store, chain, op, head, privateGraph, has, collect };
}
describe('reference-safe abandoned draft maintenance', () => {
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
    await withUnqueuedDraftOperation(f.store, CG, undefined, workspaceOperationSubject(CG, 'queued'), NOW, async () => { deleted = true; });
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
    await withUnqueuedDraftOperation(f.store, CG, undefined, operation, NOW, async () => { deleted = true; });
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
