/**
 * TTL expiry regression tests for graph-scoped V2 SWM operations
 * (zsculac P1 on PR #1714: "TTL cleanup does not discard a whole V2 KA").
 *
 * V2 operations have no dkg:rootEntity rows, so the legacy cleanup sweep
 * only removed the operation metadata subject and stranded:
 *   1. the per-KA SWM assertion graph,
 *   2. the `${kaUal}#dkg-swm-head` subject (whose surviving rows then point
 *      at a deleted operation and read as CORRUPT in
 *      resolveKnowledgeAssetWorkspaceHead),
 *   3. the operation's public snapshot graph.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { DKGAgent } from '../src/index.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';
import { GraphManager, type TripleStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  contextGraphSharedMemoryMetaUri,
} from '@origintrail-official/dkg-core';
// Deep dist import: `storeKnowledgeAssetWorkspaceHead` is not re-exported from
// the publisher package index, and seeding through the real production writers
// keeps these fixtures byte-identical to what publish/share persists.
import {
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

const TTL_MS = 60_000;
const KA_UAL = 'did:dkg:hardhat1:31337/0x1111111111111111111111111111111111111111/1';
const DKG = 'http://dkg.io/ontology/';

function opSubject(contextGraphId: string, shareOperationId: string): string {
  return `urn:dkg:share:${contextGraphId}:${shareOperationId}`;
}

function headSubject(kaUal: string): string {
  return `${kaUal}#dkg-swm-head`;
}

async function subjectRowCount(store: TripleStore, graph: string, subject: string): Promise<number> {
  const res = await store.query(
    `SELECT ?p WHERE { GRAPH <${graph}> { <${subject}> ?p ?o } }`,
  );
  return res.type === 'bindings' ? res.bindings.length : 0;
}

async function graphTripleCount(store: TripleStore, graph: string): Promise<number> {
  const res = await store.query(
    `SELECT ?s WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
  );
  return res.type === 'bindings' ? res.bindings.length : 0;
}

async function resolveSnapshotGraph(store: TripleStore, metaGraph: string, subject: string): Promise<string> {
  const res = await store.query(
    `SELECT ?g WHERE { GRAPH <${metaGraph}> { <${subject}> <${DKG}publicSnapshotGraph> ?g } } LIMIT 1`,
  );
  const graph = res.type === 'bindings' ? res.bindings[0]?.['g'] : undefined;
  expect(graph, 'seeded operation must carry a dkg:publicSnapshotGraph row').toBeTruthy();
  return graph as string;
}

/** Seed one V2 operation + snapshot graph through the production writers. */
async function seedV2Operation(store: TripleStore, opts: {
  contextGraphId: string;
  shareOperationId: string;
  assertionVersion: number;
  ageMs: number;
  subGraphName?: string;
}): Promise<{ opSubject: string; snapshotGraph: string; metaGraph: string }> {
  const graphManager = new GraphManager(store);
  await storeKnowledgeAssetOperationPublicQuads({
    store,
    graphManager,
    contextGraphId: opts.contextGraphId,
    shareOperationId: opts.shareOperationId,
    kaUal: KA_UAL,
    assertionVersion: opts.assertionVersion,
    quads: [
      { subject: 'urn:v2:entity:1', predicate: 'http://schema.org/name', object: `"v${opts.assertionVersion} payload"`, graph: '' },
    ],
    publisherPeerId: 'peer-v2-test',
    subGraphName: opts.subGraphName,
    timestamp: new Date(Date.now() - opts.ageMs),
  });
  const metaGraph = contextGraphSharedMemoryMetaUri(opts.contextGraphId, opts.subGraphName);
  const subject = opSubject(opts.contextGraphId, opts.shareOperationId);
  const snapshotGraph = await resolveSnapshotGraph(store, metaGraph, subject);
  return { opSubject: subject, snapshotGraph, metaGraph };
}

/** Point the KA head at one operation and fill its per-KA assertion graph. */
async function seedHeadAndAssertionGraph(store: TripleStore, opts: {
  contextGraphId: string;
  shareOperationId: string;
  assertionVersion: number;
  subGraphName?: string;
}): Promise<string> {
  const graphManager = new GraphManager(store);
  await storeKnowledgeAssetWorkspaceHead({
    store,
    graphManager,
    contextGraphId: opts.contextGraphId,
    kaUal: KA_UAL,
    assertionVersion: opts.assertionVersion,
    shareOperationId: opts.shareOperationId,
    subGraphName: opts.subGraphName,
  });
  const assertionGraph = knowledgeAssetLayerGraphUri(
    opts.contextGraphId,
    MemoryLayer.SharedWorkingMemory,
    createGraphKnowledgeAssetScope(KA_UAL, opts.assertionVersion),
    opts.subGraphName,
  );
  const dataQuads: Quad[] = [
    { subject: 'urn:v2:entity:1', predicate: 'http://schema.org/name', object: `"v${opts.assertionVersion} payload"`, graph: assertionGraph },
    { subject: 'urn:v2:entity:1', predicate: 'http://schema.org/version', object: `"${opts.assertionVersion}"`, graph: assertionGraph },
  ];
  await store.insert(dataQuads);
  return assertionGraph;
}

describe('SWM TTL cleanup of graph-scoped V2 operations', () => {
  let node: DKGAgent;
  let store: TripleStore;

  beforeAll(async () => {
    node = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'TtlV2Node',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      sharedMemoryTtlMs: TTL_MS,
    });
    await node.start();
    store = (node as unknown as { store: TripleStore }).store;
  }, 60_000);

  afterAll(async () => {
    try { await node?.stop(); } catch {}
  });

  it('an expired V2 operation that owns the head discards the whole KA', async () => {
    const cg = 'swm-ttl-v2-whole-ka';
    await node.createContextGraph({ id: cg, name: 'V2 TTL whole-KA', description: 'expired op owns head' });

    const seeded = await seedV2Operation(store, {
      contextGraphId: cg, shareOperationId: 'v2-op-old', assertionVersion: 1, ageMs: TTL_MS * 2,
    });
    const assertionGraph = await seedHeadAndAssertionGraph(store, {
      contextGraphId: cg, shareOperationId: 'v2-op-old', assertionVersion: 1,
    });

    // Sanity: everything is in place before the sweep.
    expect(await subjectRowCount(store, seeded.metaGraph, seeded.opSubject)).toBeGreaterThan(0);
    expect(await subjectRowCount(store, seeded.metaGraph, headSubject(KA_UAL))).toBeGreaterThan(0);
    expect(await graphTripleCount(store, assertionGraph)).toBe(2);
    expect(await graphTripleCount(store, seeded.snapshotGraph)).toBe(1);

    const deleted = await node.cleanupExpiredSharedMemory();
    expect(deleted).toBeGreaterThan(0);

    // Whole V2 KA discarded: op metadata, head, assertion graph, snapshot graph.
    expect(await subjectRowCount(store, seeded.metaGraph, seeded.opSubject)).toBe(0);
    expect(await subjectRowCount(store, seeded.metaGraph, headSubject(KA_UAL))).toBe(0);
    expect(await graphTripleCount(store, assertionGraph)).toBe(0);
    expect(await store.hasGraph(assertionGraph)).toBe(false);
    expect(await graphTripleCount(store, seeded.snapshotGraph)).toBe(0);
  }, 60_000);

  it('an expired old V2 operation leaves head + assertion graph owned by a fresh newer operation intact', async () => {
    const cg = 'swm-ttl-v2-newer-head';
    await node.createContextGraph({ id: cg, name: 'V2 TTL newer head', description: 'newer op owns head' });

    const oldOp = await seedV2Operation(store, {
      contextGraphId: cg, shareOperationId: 'v2-op-old', assertionVersion: 1, ageMs: TTL_MS * 2,
    });
    const newOp = await seedV2Operation(store, {
      contextGraphId: cg, shareOperationId: 'v2-op-new', assertionVersion: 2, ageMs: 0,
    });
    // Head advanced to the fresh operation: the KA is alive.
    const assertionGraph = await seedHeadAndAssertionGraph(store, {
      contextGraphId: cg, shareOperationId: 'v2-op-new', assertionVersion: 2,
    });

    const deleted = await node.cleanupExpiredSharedMemory();
    expect(deleted).toBeGreaterThan(0);

    // Old operation fully evicted (metadata + its snapshot graph).
    expect(await subjectRowCount(store, oldOp.metaGraph, oldOp.opSubject)).toBe(0);
    expect(await graphTripleCount(store, oldOp.snapshotGraph)).toBe(0);

    // Live KA untouched: head, assertion graph data, fresh op + its snapshot.
    expect(await subjectRowCount(store, newOp.metaGraph, headSubject(KA_UAL))).toBeGreaterThan(0);
    expect(await graphTripleCount(store, assertionGraph)).toBe(2);
    expect(await subjectRowCount(store, newOp.metaGraph, newOp.opSubject)).toBeGreaterThan(0);
    expect(await graphTripleCount(store, newOp.snapshotGraph)).toBe(1);
  }, 60_000);

  it('expires V2 operations stored in a per-subgraph meta graph', async () => {
    const cg = 'swm-ttl-v2-subgraph';
    const subGraphName = 'notes';
    await node.createContextGraph({ id: cg, name: 'V2 TTL subgraph', description: 'subgraph meta expiry' });

    const seeded = await seedV2Operation(store, {
      contextGraphId: cg, shareOperationId: 'v2-op-sub', assertionVersion: 1, ageMs: TTL_MS * 2, subGraphName,
    });
    const assertionGraph = await seedHeadAndAssertionGraph(store, {
      contextGraphId: cg, shareOperationId: 'v2-op-sub', assertionVersion: 1, subGraphName,
    });
    expect(seeded.metaGraph).toBe(`did:dkg:context-graph:${cg}/${subGraphName}/_shared_memory_meta`);

    const deleted = await node.cleanupExpiredSharedMemory();
    expect(deleted).toBeGreaterThan(0);

    expect(await subjectRowCount(store, seeded.metaGraph, seeded.opSubject)).toBe(0);
    expect(await subjectRowCount(store, seeded.metaGraph, headSubject(KA_UAL))).toBe(0);
    expect(await graphTripleCount(store, assertionGraph)).toBe(0);
    expect(await graphTripleCount(store, seeded.snapshotGraph)).toBe(0);
  }, 60_000);

  it('honors an explicit public owner/name context graph during finalized cleanup', async () => {
    const cg = '0x1111111111111111111111111111111111111111/public-finalized-cleanup';
    const cleanupFinalizedGraphScopedSwmWhenIdle = vi.fn().mockResolvedValue(0);
    const handlerSpy = vi
      .spyOn(node as unknown as { getOrCreateFinalizationHandler: () => unknown }, 'getOrCreateFinalizationHandler')
      .mockReturnValue({ cleanupFinalizedGraphScopedSwmWhenIdle });

    try {
      await node.cleanupExpiredSharedMemory({
        finalizedOnly: true,
        contextGraphIds: [cg],
        finalizedCleanupBudget: 4,
        queueBehindActiveWork: true,
      });
    } finally {
      handlerSpy.mockRestore();
    }

    expect(cleanupFinalizedGraphScopedSwmWhenIdle).toHaveBeenCalledWith({
      contextGraphId: cg,
      swmMetaGraph: contextGraphSharedMemoryMetaUri(cg),
      maxCandidates: 4,
      queueBehindActiveWork: true,
    });
  });
});
