import { describe, it, expect, vi } from 'vitest';
import {
  encodeFinalizationMessage,
  paranetDataGraphUri,
  paranetWorkspaceGraphUri,
  contextGraphDataUri,
  contextGraphMetaUri,
  paranetMetaGraphUri,
  Logger,
} from '@dkg/core';
import { OxigraphStore, GraphManager, type Quad } from '@dkg/storage';
import { computeTripleHash } from '@dkg/publisher';
import { MerkleTree } from '@dkg/core';
import { FinalizationHandler } from '../src/finalization-handler.js';

const PARANET = 'test-finalization';

function makeQuads(rootEntity: string, count: number, graph: string): Quad[] {
  const quads: Quad[] = [];
  for (let i = 0; i < count; i++) {
    quads.push({
      subject: rootEntity,
      predicate: `http://example.org/p${i}`,
      object: `"value-${i}"`,
      graph,
    });
  }
  return quads;
}

function computeMerkleForQuads(quads: Quad[], paranetId: string): Uint8Array {
  const dataGraph = paranetDataGraphUri(paranetId);
  return computeMerkleForQuadsWithGraph(quads, dataGraph);
}

function computeMerkleForQuadsWithGraph(quads: Quad[], _dataGraph: string): Uint8Array {
  const hashes = quads.map(computeTripleHash);
  return new MerkleTree(hashes).root;
}

function makeFinalizationMsg(opts: {
  ual?: string;
  paranetId?: string;
  kcMerkleRoot?: Uint8Array;
  rootEntities?: string[];
  txHash?: string;
  blockNumber?: number;
  operationId?: string;
  contextGraphId?: string;
}) {
  return encodeFinalizationMessage({
    ual: opts.ual ?? 'did:dkg:base:31337/0xPub/1',
    paranetId: opts.paranetId ?? PARANET,
    kcMerkleRoot: opts.kcMerkleRoot ?? new Uint8Array(32),
    txHash: opts.txHash ?? '0xabc123',
    blockNumber: opts.blockNumber ?? 100,
    batchId: 1,
    startKAId: 1,
    endKAId: 1,
    publisherAddress: '0x1111111111111111111111111111111111111111',
    rootEntities: opts.rootEntities ?? ['http://example.org/entity/1'],
    timestampMs: Date.now(),
    operationId: opts.operationId,
    contextGraphId: opts.contextGraphId,
  });
}

describe('FinalizationHandler', () => {
  it('ignores messages with mismatched paranetId', async () => {
    const store = new OxigraphStore();
    const handler = new FinalizationHandler(store, undefined);
    const insertSpy = vi.spyOn(store, 'insert');

    const data = makeFinalizationMsg({ paranetId: 'other-paranet' });
    await handler.handleFinalizationMessage(data, PARANET);

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('ignores incomplete messages (no UAL)', async () => {
    const store = new OxigraphStore();
    const handler = new FinalizationHandler(store, undefined);
    const insertSpy = vi.spyOn(store, 'insert');

    const data = makeFinalizationMsg({ ual: '' });
    await handler.handleFinalizationMessage(data, PARANET);

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('logs fallback when no workspace data exists for the root entities', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);
    const handler = new FinalizationHandler(store, undefined);
    const insertSpy = vi.spyOn(store, 'insert');

    const data = makeFinalizationMsg({
      rootEntities: ['http://example.org/nonexistent'],
    });
    await handler.handleFinalizationMessage(data, PARANET);

    // No data in workspace → no promotion, no inserts beyond ensureParanet
    const result = await store.query(
      `SELECT ?s WHERE { GRAPH <${paranetDataGraphUri(PARANET)}> { ?s ?p ?o } }`,
    );
    expect(result.type === 'bindings' ? result.bindings.length : 0).toBe(0);
  });

  it('promotes matching workspace data to canonical when merkle matches (no chain verification)', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);

    const rootEntity = 'http://example.org/entity/1';
    const wsGraph = paranetWorkspaceGraphUri(PARANET);
    const wsQuads = makeQuads(rootEntity, 3, wsGraph);
    await store.insert(wsQuads);

    const merkleRoot = computeMerkleForQuads(wsQuads, PARANET);

    // No chain adapter → verifyOnChain returns false, so promotion won't happen.
    // We test that with a chain adapter that returns true.
    const mockChain = {
      chainId: 'mock:31337',
      listenForEvents: async function* () {
        yield {
          type: 'KnowledgeBatchCreated',
          blockNumber: 100,
          data: {
            txHash: '0xabc123',
            merkleRoot: '0x' + Array.from(merkleRoot).map(b => b.toString(16).padStart(2, '0')).join(''),
            publisherAddress: '0x1111111111111111111111111111111111111111',
            startKAId: '1',
            endKAId: '1',
          },
        };
      },
    } as any;

    const handler = new FinalizationHandler(store, mockChain);

    const data = makeFinalizationMsg({
      kcMerkleRoot: merkleRoot,
      rootEntities: [rootEntity],
    });
    await handler.handleFinalizationMessage(data, PARANET);

    // Workspace data should now be in the data graph
    const result = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${paranetDataGraphUri(PARANET)}> { ?s ?p ?o . FILTER(?s = <${rootEntity}>) } }`,
    );
    expect(result.type).toBe('bindings');
    const bindings = result.type === 'bindings' ? result.bindings : [];
    expect(bindings.length).toBe(3);

    // Metadata should be confirmed
    const metaResult = await store.query(
      `SELECT ?status WHERE { GRAPH <did:dkg:paranet:${PARANET}/_meta> { <did:dkg:base:31337/0xPub/1> <http://dkg.io/ontology/status> ?status } }`,
    );
    expect(metaResult.type).toBe('bindings');
    const metaBindings = metaResult.type === 'bindings' ? metaResult.bindings : [];
    expect(metaBindings.length).toBe(1);
    expect(metaBindings[0]['status']).toContain('confirmed');

    // Workspace data should be cleaned up
    const wsResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${wsGraph}> { ?s ?p ?o . FILTER(?s = <${rootEntity}>) } }`,
    );
    expect(wsResult.type === 'bindings' ? wsResult.bindings.length : 0).toBe(0);
  });

  it('does not promote when merkle root does not match', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);

    const rootEntity = 'http://example.org/entity/1';
    const wsGraph = paranetWorkspaceGraphUri(PARANET);
    await store.insert(makeQuads(rootEntity, 3, wsGraph));

    const handler = new FinalizationHandler(store, undefined);

    const wrongMerkle = new Uint8Array(32).fill(0xff);
    const data = makeFinalizationMsg({
      kcMerkleRoot: wrongMerkle,
      rootEntities: [rootEntity],
    });
    await handler.handleFinalizationMessage(data, PARANET);

    // Data graph should remain empty (no promotion)
    const result = await store.query(
      `SELECT ?s WHERE { GRAPH <${paranetDataGraphUri(PARANET)}> { ?s ?p ?o } }`,
    );
    expect(result.type === 'bindings' ? result.bindings.length : 0).toBe(0);

    // Workspace data should still be there (not cleaned up)
    const wsResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${wsGraph}> { ?s ?p ?o . FILTER(?s = <${rootEntity}>) } }`,
    );
    expect(wsResult.type === 'bindings' ? wsResult.bindings.length : 0).toBeGreaterThan(0);
  });

  it('propagates sourceOperationId from the message into log entries', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);
    const handler = new FinalizationHandler(store, undefined);

    const senderOpId = '550e8400-e29b-41d4-a716-446655440000';
    const data = makeFinalizationMsg({
      rootEntities: ['http://example.org/nonexistent'],
      operationId: senderOpId,
    });

    const logEntries: Array<{ sourceOperationId?: string }> = [];
    Logger.setSink((entry) => logEntries.push(entry));
    try {
      await handler.handleFinalizationMessage(data, PARANET);
    } finally {
      Logger.setSink(null);
    }

    expect(logEntries.length).toBeGreaterThan(0);
    expect(logEntries.every(e => e.sourceOperationId === senderOpId)).toBe(true);
  });

  it('does not promote when on-chain verification fails', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);

    const rootEntity = 'http://example.org/entity/1';
    const wsGraph = paranetWorkspaceGraphUri(PARANET);
    const wsQuads = makeQuads(rootEntity, 3, wsGraph);
    await store.insert(wsQuads);

    const merkleRoot = computeMerkleForQuads(wsQuads, PARANET);

    // Chain that yields no matching events
    const mockChain = {
      chainId: 'mock:31337',
      listenForEvents: async function* () {},
    } as any;

    const handler = new FinalizationHandler(store, mockChain);

    const data = makeFinalizationMsg({
      kcMerkleRoot: merkleRoot,
      rootEntities: [rootEntity],
    });
    await handler.handleFinalizationMessage(data, PARANET);

    // Data graph should remain empty
    const result = await store.query(
      `SELECT ?s WHERE { GRAPH <${paranetDataGraphUri(PARANET)}> { ?s ?p ?o } }`,
    );
    expect(result.type === 'bindings' ? result.bindings.length : 0).toBe(0);
  });

  it('promotes to context graph URIs when contextGraphId is present', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);

    const rootEntity = 'http://example.org/entity/1';
    const wsGraph = paranetWorkspaceGraphUri(PARANET);
    const wsQuads = makeQuads(rootEntity, 3, wsGraph);
    await store.insert(wsQuads);

    const ctxGraphId = '42';
    const dataGraph = contextGraphDataUri(PARANET, ctxGraphId);
    const merkleRoot = computeMerkleForQuadsWithGraph(wsQuads, dataGraph);

    const mockChain = {
      chainId: 'mock:31337',
      listenForEvents: async function* () {
        yield {
          type: 'KnowledgeBatchCreated',
          blockNumber: 100,
          data: {
            txHash: '0xabc123',
            merkleRoot: '0x' + Array.from(merkleRoot).map(b => b.toString(16).padStart(2, '0')).join(''),
            publisherAddress: '0x1111111111111111111111111111111111111111',
            startKAId: '1',
            endKAId: '1',
          },
        };
        yield {
          type: 'ContextGraphExpanded',
          blockNumber: 100,
          data: { contextGraphId: ctxGraphId, batchId: '1' },
        };
      },
    } as any;

    const handler = new FinalizationHandler(store, mockChain);

    const data = makeFinalizationMsg({
      kcMerkleRoot: merkleRoot,
      rootEntities: [rootEntity],
      contextGraphId: ctxGraphId,
    });
    await handler.handleFinalizationMessage(data, PARANET);

    // Data should be in context graph, not paranet data graph
    const ctxDataResult = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${dataGraph}> { ?s ?p ?o . FILTER(?s = <${rootEntity}>) } }`,
    );
    expect(ctxDataResult.type).toBe('bindings');
    const ctxBindings = ctxDataResult.type === 'bindings' ? ctxDataResult.bindings : [];
    expect(ctxBindings.length).toBe(3);

    const paranetDataResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${paranetDataGraphUri(PARANET)}> { ?s ?p ?o } }`,
    );
    expect(paranetDataResult.type === 'bindings' ? paranetDataResult.bindings.length : 0).toBe(0);

    // Meta should be in context graph meta, not paranet meta
    const ctxMetaUri = contextGraphMetaUri(PARANET, ctxGraphId);
    const metaResult = await store.query(
      `SELECT ?status WHERE { GRAPH <${ctxMetaUri}> { <did:dkg:base:31337/0xPub/1> <http://dkg.io/ontology/status> ?status } }`,
    );
    expect(metaResult.type).toBe('bindings');
    const metaBindings = metaResult.type === 'bindings' ? metaResult.bindings : [];
    expect(metaBindings.length).toBe(1);
    expect(metaBindings[0]['status']).toContain('confirmed');
  });

  it('skips promotion when UAL is already confirmed (dedup guard)', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);

    const ual = 'did:dkg:base:31337/0xPub/1';
    const metaGraph = paranetMetaGraphUri(PARANET);
    await store.insert([{
      subject: ual,
      predicate: 'http://dkg.io/ontology/status',
      object: '"confirmed"',
      graph: metaGraph,
    }]);

    const handler = new FinalizationHandler(store, undefined);

    const data = makeFinalizationMsg({ ual });
    await handler.handleFinalizationMessage(data, PARANET);

    // Handler should skip; no data promotion
    const dataResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${paranetDataGraphUri(PARANET)}> { ?s ?p ?o } }`,
    );
    expect(dataResult.type === 'bindings' ? dataResult.bindings.length : 0).toBe(0);
  });

  it('derives rootEntities from local workspace data, not gossip (trust boundary)', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);

    const rootA = 'http://example.org/entity/A';
    const rootB = 'http://example.org/entity/B';
    const wsGraph = paranetWorkspaceGraphUri(PARANET);
    const quadsA = makeQuads(rootA, 2, wsGraph);
    const quadsB = makeQuads(rootB, 2, wsGraph);
    await store.insert([...quadsA, ...quadsB]);

    const merkleRoot = computeMerkleForQuads([...quadsA, ...quadsB], PARANET);

    const mockChain = {
      chainId: 'mock:31337',
      listenForEvents: async function* () {
        yield {
          type: 'KnowledgeBatchCreated',
          blockNumber: 100,
          data: {
            txHash: '0xabc123',
            merkleRoot: '0x' + Array.from(merkleRoot).map(b => b.toString(16).padStart(2, '0')).join(''),
            publisherAddress: '0x1111111111111111111111111111111111111111',
            startKAId: '1',
            endKAId: '1',
          },
        };
      },
    } as any;

    const handler = new FinalizationHandler(store, mockChain);

    // Gossip message has roots in REVERSED order (attacker-crafted)
    const data = makeFinalizationMsg({
      kcMerkleRoot: merkleRoot,
      rootEntities: [rootB, rootA],
      blockNumber: 100,
    });
    await handler.handleFinalizationMessage(data, PARANET);

    // Metadata should exist: the handler derived roots from autoPartition (sorted),
    // not from the gossip message's reversed order
    const metaResult = await store.query(
      `SELECT ?s WHERE { GRAPH <did:dkg:paranet:${PARANET}/_meta> { ?s <http://dkg.io/ontology/status> ?st . FILTER(CONTAINS(?st, "confirmed")) } }`,
    );
    expect(metaResult.type).toBe('bindings');
    const bindings = metaResult.type === 'bindings' ? metaResult.bindings : [];
    expect(bindings.length).toBeGreaterThan(0);
  });

  it('skips promotion when UAL is already confirmed in context graph meta (dedup guard)', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);

    const ual = 'did:dkg:base:31337/0xPub/1';
    const ctxGraphId = '42';
    const ctxMetaUri = contextGraphMetaUri(PARANET, ctxGraphId);
    await store.insert([{
      subject: ual,
      predicate: 'http://dkg.io/ontology/status',
      object: '"confirmed"',
      graph: ctxMetaUri,
    }]);

    const handler = new FinalizationHandler(store, undefined);

    const data = makeFinalizationMsg({ ual, contextGraphId: ctxGraphId });
    await handler.handleFinalizationMessage(data, PARANET);

    // Handler should skip; no data in context graph
    const dataGraph = contextGraphDataUri(PARANET, ctxGraphId);
    const dataResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${dataGraph}> { ?s ?p ?o } }`,
    );
    expect(dataResult.type === 'bindings' ? dataResult.bindings.length : 0).toBe(0);
  });

  it('multi-entity workspace: flat merkle matches publisher root (regression for entity-proofs mismatch)', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);

    const rootA = 'http://example.org/entity/A';
    const rootB = 'http://example.org/entity/B';
    const wsGraph = paranetWorkspaceGraphUri(PARANET);

    const quadsA = makeQuads(rootA, 3, wsGraph);
    const quadsB = makeQuads(rootB, 3, wsGraph);
    const allQuads = [...quadsA, ...quadsB];
    await store.insert(allQuads);

    // Compute the merkle root the way the publisher would (flat: hash all triples)
    const publisherRoot = computeMerkleForQuads(allQuads, PARANET);
    const merkleHex = '0x' + Array.from(publisherRoot).map(b => b.toString(16).padStart(2, '0')).join('');

    const mockChain = {
      chainId: 'mock:31337',
      listenForEvents: async function* () {
        yield {
          type: 'KnowledgeBatchCreated',
          blockNumber: 100,
          data: {
            txHash: '0xabc123',
            merkleRoot: merkleHex,
            publisherAddress: '0x1111111111111111111111111111111111111111',
            startKAId: '1',
            endKAId: '1',
          },
        };
      },
    } as any;

    const handler = new FinalizationHandler(store, mockChain);

    const data = makeFinalizationMsg({
      kcMerkleRoot: publisherRoot,
      rootEntities: [rootA, rootB],
    });
    await handler.handleFinalizationMessage(data, PARANET);

    // If the merkle matched, data should be promoted to canonical.
    // Before the flat-mode fix, the finalization handler used entity-proofs
    // (autoPartition → per-entity roots → KC root) which would produce a
    // different root from the publisher's flat mode, causing a mismatch.
    const result = await store.query(
      `SELECT ?s WHERE { GRAPH <${paranetDataGraphUri(PARANET)}> { ?s ?p ?o } }`,
    );
    expect(result.type).toBe('bindings');
    const bindings = result.type === 'bindings' ? result.bindings : [];
    expect(bindings.length).toBeGreaterThan(0);
  });
});
