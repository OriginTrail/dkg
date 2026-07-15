import { beforeEach, describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createOperationContext,
  createGraphKnowledgeAssetScope,
  encodeFinalizationMessage,
  knowledgeAssetLayerGraphUri,
  type FinalizationMessageMsg,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  OxigraphStore,
  type Quad,
} from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  computePrivateRootV10,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { FinalizationHandler } from '../src/finalization-handler.js';

const CG = 'rootless-finalization';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const PUBLISHER = '0x2222222222222222222222222222222222222222';
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const SHARE_ID = 'graph-finalization-share';
const VERSION = '1';
const PACKED_KA_ID = (BigInt(AUTHOR) << 96n) | 7n;

describe('graph-scoped finalization handler', () => {
  let store: OxigraphStore;
  let graphManager: GraphManager;
  let handler: FinalizationHandler;

  beforeEach(() => {
    store = new OxigraphStore();
    graphManager = new GraphManager(store);
    handler = new FinalizationHandler(store, undefined);
    (handler as unknown as {
      verifyOnChain: () => Promise<{ verified: boolean; authorAddress: string; txIndex: number }>;
    }).verifyOnChain = async () => ({
      verified: true,
      authorAddress: AUTHOR,
      txIndex: 4,
    });
  });

  async function stageGraph(): Promise<{
    message: FinalizationMessageMsg;
    swmGraph: string;
    vmGraph: string;
  }> {
    const scope = createGraphKnowledgeAssetScope(UAL, VERSION);
    const swmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    const vmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    const publicQuads: Quad[] = [
      { subject: 'urn:asset:one', predicate: 'urn:predicate:value', object: '"one"', graph: swmGraph },
      { subject: 'urn:asset:two', predicate: 'urn:predicate:value', object: '"two"', graph: swmGraph },
    ];
    const privateQuads: Quad[] = [
      { subject: 'urn:asset:secret', predicate: 'urn:predicate:value', object: '"hidden"', graph: '' },
    ];
    const privateMerkleRoot = computePrivateRootV10(privateQuads);
    if (!privateMerkleRoot) throw new Error('expected private commitment');
    const merkleRoot = computeFlatKCRootV10(
      publicQuads.map((quad) => ({ ...quad, graph: '' })),
      [privateMerkleRoot],
    );

    await store.insert(publicQuads);
    await store.insert([{
      subject: 'urn:stale:must-be-replaced',
      predicate: 'urn:predicate:value',
      object: '"stale"',
      graph: vmGraph,
    }]);
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: SHARE_ID,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      quads: publicQuads,
      privateMerkleRoot,
      privateTripleCount: privateQuads.length,
      publisherPeerId: '12D3KooWPublisher',
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: SHARE_ID,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
    });

    return {
      swmGraph,
      vmGraph,
      message: {
        ual: scope.ual,
        contextGraphId: CG,
        kcMerkleRoot: merkleRoot,
        txHash: `0x${'ab'.repeat(32)}`,
        blockNumber: 123,
        txIndex: 4,
        batchId: PACKED_KA_ID,
        startKAId: PACKED_KA_ID,
        endKAId: PACKED_KA_ID,
        publisherAddress: PUBLISHER,
        rootEntities: [],
        timestampMs: Date.now(),
        operationId: 'graph-finalization-op',
        targetContextGraphId: '42',
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        assertionVersion: scope.assertionVersion,
        publicTripleCount: publicQuads.length,
        privateMerkleRoot,
        privateTripleCount: privateQuads.length,
      },
    };
  }

  it('atomically replaces the exact VM graph and emits constant-size rootless metadata', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();

    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(0);
    const stale = await store.query(
      `ASK { GRAPH <${vmGraph}> { <urn:stale:must-be-replaced> ?p ?o } }`,
    );
    expect(stale).toMatchObject({ type: 'boolean', value: false });

    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    const metadata = await store.query(
      `SELECT ?scope ?version ?count ?privateCount ?graph ?policy WHERE {
        GRAPH <${metaGraph}> {
          <${UAL}> <http://dkg.io/ontology/contentScopeVersion> ?scope ;
            <http://dkg.io/ontology/assertionVersion> ?version ;
            <http://dkg.io/ontology/publicTripleCount> ?count ;
            <http://dkg.io/ontology/privateTripleCount> ?privateCount ;
            <http://dkg.io/ontology/assertionGraph> ?graph ;
            <http://dkg.io/ontology/accessPolicy> ?policy ;
            <http://dkg.io/ontology/status> "confirmed" .
        }
      }`,
    );
    expect(metadata.type).toBe('bindings');
    if (metadata.type !== 'bindings') throw new Error('expected bindings');
    expect(metadata.bindings).toHaveLength(1);
    expect(metadata.bindings[0]).toMatchObject({
      scope: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
      version: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
      count: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
      privateCount: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
      graph: vmGraph,
      policy: '"ownerOnly"',
    });
    const legacyRoots = await store.query(
      `ASK { GRAPH <${metaGraph}> { ?s <http://dkg.io/ontology/rootEntity> ?root } }`,
    );
    expect(legacyRoots).toMatchObject({ type: 'boolean', value: false });
  });

  it('finalizes a fully private KA without requiring a public root or placeholder triple', async () => {
    const scope = createGraphKnowledgeAssetScope(UAL, VERSION);
    const vmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    const privateQuads: Quad[] = [{
      subject: 'urn:asset:private-only',
      predicate: 'urn:predicate:value',
      object: '"hidden"',
      graph: '',
    }];
    const privateMerkleRoot = computePrivateRootV10(privateQuads);
    if (!privateMerkleRoot) throw new Error('expected private commitment');
    const merkleRoot = computeFlatKCRootV10([], [privateMerkleRoot]);

    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: SHARE_ID,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      quads: [],
      privateMerkleRoot,
      privateTripleCount: privateQuads.length,
      publisherPeerId: '12D3KooWPublisher',
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: SHARE_ID,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
    });

    await handler.handleFinalizationMessage(encodeFinalizationMessage({
      ual: scope.ual,
      contextGraphId: CG,
      kcMerkleRoot: merkleRoot,
      txHash: `0x${'cd'.repeat(32)}`,
      blockNumber: 123,
      txIndex: 4,
      batchId: PACKED_KA_ID,
      startKAId: PACKED_KA_ID,
      endKAId: PACKED_KA_ID,
      publisherAddress: PUBLISHER,
      rootEntities: [],
      timestampMs: Date.now(),
      operationId: 'fully-private-finalization-op',
      targetContextGraphId: '42',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      assertionVersion: scope.assertionVersion,
      publicTripleCount: 0,
      privateMerkleRoot,
      privateTripleCount: privateQuads.length,
    }), CG);

    expect(await store.countQuads(vmGraph)).toBe(0);
    const metadata = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> {
        <${UAL}> <http://dkg.io/ontology/status> "confirmed" ;
          <http://dkg.io/ontology/publicTripleCount> "0"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/privateTripleCount> "1"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/privateMerkleRoot> "${Buffer.from(privateMerkleRoot).toString('hex')}" .
      } }`,
    );
    expect(metadata).toMatchObject({ type: 'boolean', value: true });
  });

  it('keeps the old VM graph and remains retryable when the atomic swap fails', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    const replaceGraph = store.replaceGraph?.bind(store);
    if (!replaceGraph) throw new Error('Oxigraph replaceGraph unavailable');
    store.replaceGraph = async (graphUri, quads, options) => {
      if (graphUri === vmGraph) throw new Error('injected graph finalization failure');
      return replaceGraph(graphUri, quads, options);
    };

    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    expect(await store.countQuads(vmGraph)).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(2);

    store.replaceGraph = replaceGraph;
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(0);
  });

  it('rejects mixed graph-scope and legacy-root finalization envelopes', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(
      encodeFinalizationMessage({ ...message, rootEntities: ['urn:legacy:root'] }),
      CG,
    );
    expect(await store.countQuads(vmGraph)).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(2);
  });

  it('chain-reconciles a late joiner from the exact KA head without scanning legacy roots', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    const internals = handler as unknown as {
      verifyChainCgBinding: (kaId: bigint, cgId: string) => Promise<boolean>;
      findSwmSnapshotForMerkleRoot: () => Promise<never>;
    };
    internals.verifyChainCgBinding = async () => true;
    internals.findSwmSnapshotForMerkleRoot = async () => {
      throw new Error('legacy root scan must not run for graph-scoped SWM');
    };

    const outcome = await handler.handleChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      versionBlock: 123,
      authorAddress: AUTHOR,
    }, createOperationContext('system'));

    expect(outcome).toBe('promoted');
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(0);
  });

  it('does not let an older confirmed assertion mask reconciliation of a newer chain root', async () => {
    const first = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(first.message), CG);

    const nextScope = createGraphKnowledgeAssetScope(UAL, '2');
    const nextSwmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.SharedWorkingMemory,
      nextScope,
    );
    const nextVmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      nextScope,
    );
    const nextQuads: Quad[] = [{
      subject: 'urn:asset:next',
      predicate: 'urn:predicate:value',
      object: '"two"',
      graph: nextSwmGraph,
    }];
    await store.insert(nextQuads);
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'graph-finalization-update',
      kaUal: UAL,
      assertionVersion: nextScope.assertionVersion,
      quads: nextQuads,
      privateTripleCount: 0,
      publisherPeerId: '12D3KooWPublisher',
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'graph-finalization-update',
      kaUal: UAL,
      assertionVersion: nextScope.assertionVersion,
    });
    const nextMerkleRoot = computeFlatKCRootV10(
      nextQuads.map((quad) => ({ ...quad, graph: '' })),
      [],
    );
    const internals = handler as unknown as {
      verifyChainCgBinding: (kaId: bigint, cgId: string) => Promise<boolean>;
      findSwmSnapshotForMerkleRoot: () => Promise<never>;
    };
    internals.verifyChainCgBinding = async () => true;
    internals.findSwmSnapshotForMerkleRoot = async () => {
      throw new Error('legacy root scan must not run for a V2 update');
    };

    const outcome = await handler.handleChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: nextMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      versionBlock: 124,
      authorAddress: AUTHOR,
    }, createOperationContext('system'));

    expect(outcome).toBe('promoted');
    expect(await store.countQuads(nextVmGraph)).toBe(1);
    expect(await store.countQuads(nextSwmGraph)).toBe(0);
    const version = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> {
        <${UAL}> <http://dkg.io/ontology/assertionVersion> "2"^^<http://www.w3.org/2001/XMLSchema#integer> .
      } }`,
    );
    expect(version).toMatchObject({ type: 'boolean', value: true });
  });

  it('does not finalize graph-scoped gossip that fails on-chain verification', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    (handler as unknown as {
      verifyOnChain: () => Promise<{ verified: boolean }>;
    }).verifyOnChain = async () => ({ verified: false });

    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    // Unverified gossip must not replace VM, confirm metadata, or consume SWM.
    expect(await store.countQuads(vmGraph)).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(2);
    const confirmed = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> { <${UAL}> <http://dkg.io/ontology/status> "confirmed" } }`,
    );
    expect(confirmed).toMatchObject({ type: 'boolean', value: false });

    // The message stays retryable: restoring the verifier finalizes it.
    (handler as unknown as {
      verifyOnChain: () => Promise<{ verified: boolean; authorAddress: string; txIndex: number }>;
    }).verifyOnChain = async () => ({ verified: true, authorAddress: AUTHOR, txIndex: 4 });
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(0);
  });

  it('rejects a graph-scoped envelope whose batchId does not match the UAL-derived kaId', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(
      encodeFinalizationMessage({ ...message, batchId: PACKED_KA_ID + 1n }),
      CG,
    );
    expect(await store.countQuads(vmGraph)).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(2);
  });

  it('recognizes an already-confirmed assertion across restart and chain reconciliation', async () => {
    const { message } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    // Fresh handler: the in-memory gossip dedupe is gone, exactly like a
    // restart. Stored metadata roots are bare hex while the chain root is
    // bytes — the comparison must normalize or this loops as `no-swm` forever.
    const restarted = new FinalizationHandler(store, undefined);
    (restarted as unknown as {
      verifyChainCgBinding: () => Promise<boolean>;
    }).verifyChainCgBinding = async () => true;
    const outcome = await restarted.handleChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      versionBlock: 123,
    }, createOperationContext('system'));
    expect(outcome).toBe('already-confirmed');

    // Duplicate gossip after restart is acknowledged, not deferred.
    (restarted as unknown as {
      verifyOnChain: () => Promise<{ verified: boolean; authorAddress: string; txIndex: number }>;
    }).verifyOnChain = async () => ({ verified: true, authorAddress: AUTHOR, txIndex: 4 });
    const confirmed = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> { <${UAL}> <http://dkg.io/ontology/status> "confirmed" } }`,
    );
    expect(confirmed).toMatchObject({ type: 'boolean', value: true });
  });

  it('treats a newer assertion with an identical Merkle root as new work, not a duplicate', async () => {
    const first = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(first.message), CG);

    // Version 2 has byte-identical content, therefore the same flat-KC root.
    const nextScope = createGraphKnowledgeAssetScope(UAL, '2');
    const swmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, nextScope);
    const vmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, nextScope);
    const publicQuads: Quad[] = [
      { subject: 'urn:asset:one', predicate: 'urn:predicate:value', object: '"one"', graph: swmGraph },
      { subject: 'urn:asset:two', predicate: 'urn:predicate:value', object: '"two"', graph: swmGraph },
    ];
    const privateQuads: Quad[] = [
      { subject: 'urn:asset:secret', predicate: 'urn:predicate:value', object: '"hidden"', graph: '' },
    ];
    const privateMerkleRoot = computePrivateRootV10(privateQuads);
    if (!privateMerkleRoot) throw new Error('expected private commitment');
    await store.insert(publicQuads);
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'same-root-update',
      kaUal: UAL,
      assertionVersion: nextScope.assertionVersion,
      quads: publicQuads,
      privateMerkleRoot,
      privateTripleCount: privateQuads.length,
      publisherPeerId: '12D3KooWPublisher',
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'same-root-update',
      kaUal: UAL,
      assertionVersion: nextScope.assertionVersion,
    });

    await handler.handleFinalizationMessage(encodeFinalizationMessage({
      ...first.message,
      txHash: `0x${'ef'.repeat(32)}`,
      blockNumber: 124,
      assertionVersion: nextScope.assertionVersion,
      operationId: 'same-root-update-op',
    }), CG);

    // The v2 assertion must be materialized as v2 — not skipped as an
    // already-confirmed duplicate of v1 (which would also delete its SWM).
    expect(await store.countQuads(vmGraph)).toBe(2);
    const version = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> {
        <${UAL}> <http://dkg.io/ontology/assertionVersion> "2"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/status> "confirmed" .
      } }`,
    );
    expect(version).toMatchObject({ type: 'boolean', value: true });
    expect(await store.countQuads(swmGraph)).toBe(0);
  });

  it('finalizes a chain-confirmed older assertion after a newer SWM write, without erasing it', async () => {
    // Stage v1 but do NOT finalize it yet.
    const first = await stageGraph();

    // A v2 update is accepted into SWM before v1's finalization arrives:
    // the shared per-KA graph now holds v2 content and the head moved on.
    const nextScope = createGraphKnowledgeAssetScope(UAL, '2');
    const sharedSwmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, nextScope);
    const nextQuads: Quad[] = [{
      subject: 'urn:asset:next',
      predicate: 'urn:predicate:value',
      object: '"v2"',
      graph: sharedSwmGraph,
    }];
    await store.dropGraph(sharedSwmGraph);
    await store.insert(nextQuads);
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'out-of-order-update',
      kaUal: UAL,
      assertionVersion: nextScope.assertionVersion,
      quads: nextQuads,
      privateTripleCount: 0,
      publisherPeerId: '12D3KooWPublisher',
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'out-of-order-update',
      kaUal: UAL,
      assertionVersion: nextScope.assertionVersion,
    });

    // Deliver the verified v1 finalization AFTER the v2 SWM write.
    await handler.handleFinalizationMessage(encodeFinalizationMessage(first.message), CG);

    // v1 (the chain-confirmed state) is materialized from its immutable
    // operation snapshot...
    const vmGraph = first.vmGraph;
    expect(await store.countQuads(vmGraph)).toBe(2);
    const confirmed = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> {
        <${UAL}> <http://dkg.io/ontology/assertionVersion> "1"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/status> "confirmed" .
      } }`,
    );
    expect(confirmed).toMatchObject({ type: 'boolean', value: true });
    // ...and the newer staged v2 content is NOT erased by the older finalizer.
    expect(await store.countQuads(sharedSwmGraph)).toBe(1);

    // The chain sweep for the v1 root now converges instead of looping no-swm.
    const internals = handler as unknown as { verifyChainCgBinding: () => Promise<boolean> };
    internals.verifyChainCgBinding = async () => true;
    const outcome = await handler.handleChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: first.message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      versionBlock: 123,
    }, createOperationContext('system'));
    expect(outcome).toBe('already-confirmed');
  });

  it('late-join sweep locates the V2 head even when the caller passes a legacy-shaped UAL', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    const internals = handler as unknown as {
      verifyChainCgBinding: (kaId: bigint, cgId: string) => Promise<boolean>;
      findSwmSnapshotForMerkleRoot: () => Promise<never>;
    };
    internals.verifyChainCgBinding = async () => true;
    internals.findSwmSnapshotForMerkleRoot = async () => {
      throw new Error('legacy root scan must not run for graph-scoped SWM');
    };

    // Production `reconcileChainOrdinal` builds
    // did:dkg:<chain>/<storage-contract>/<packed-id> — the V2 identity must be
    // recovered from the packed kaId, not from the caller's UAL shape.
    const legacyShapedUal = `did:dkg:otp:20430/0x9999999999999999999999999999999999999999/${PACKED_KA_ID}`;
    const outcome = await handler.handleChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: legacyShapedUal,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      versionBlock: 123,
      authorAddress: AUTHOR,
    }, createOperationContext('system'));

    expect(outcome).toBe('promoted');
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(0);
    const confirmed = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> { <${UAL}> <http://dkg.io/ontology/status> "confirmed" } }`,
    );
    expect(confirmed).toMatchObject({ type: 'boolean', value: true });
  });

  it('does not let a duplicate older finalization drop a newer staged assertion after restart', async () => {
    const first = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(first.message), CG);

    // v2 staged after v1 confirmed: same physical SWM graph, head at v2.
    const nextScope = createGraphKnowledgeAssetScope(UAL, '2');
    const sharedSwmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, nextScope);
    const nextQuads: Quad[] = [{
      subject: 'urn:asset:next',
      predicate: 'urn:predicate:value',
      object: '"v2"',
      graph: sharedSwmGraph,
    }];
    await store.insert(nextQuads);
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'post-confirm-update',
      kaUal: UAL,
      assertionVersion: nextScope.assertionVersion,
      quads: nextQuads,
      privateTripleCount: 0,
      publisherPeerId: '12D3KooWPublisher',
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'post-confirm-update',
      kaUal: UAL,
      assertionVersion: nextScope.assertionVersion,
    });

    // Restarted node re-receives the v1 finalization (no in-memory dedupe).
    const restarted = new FinalizationHandler(store, undefined);
    (restarted as unknown as {
      verifyOnChain: () => Promise<{ verified: boolean; authorAddress: string; txIndex: number }>;
    }).verifyOnChain = async () => ({ verified: true, authorAddress: AUTHOR, txIndex: 4 });
    await restarted.handleFinalizationMessage(encodeFinalizationMessage(first.message), CG);

    // Already-confirmed cleanup must not delete v2's staged content.
    expect(await store.countQuads(sharedSwmGraph)).toBe(1);
  });
});
