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
  resolveKnowledgeAssetWorkspaceHead,
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

  async function stageGraph(durableAccess?: {
    accessPolicy: 'ownerOnly' | 'allowList';
    allowedPeers?: string[];
  }): Promise<{
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
      accessPolicy: durableAccess?.accessPolicy,
      allowedPeers: durableAccess?.allowedPeers,
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

  async function stageNewerWorkspaceAssertion(
    swmGraph: string,
    privateMerkleRoot?: Uint8Array,
    privateTripleCount = 0,
  ): Promise<void> {
    const newerScope = createGraphKnowledgeAssetScope(UAL, '2');
    expect(knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.SharedWorkingMemory,
      newerScope,
    )).toBe(swmGraph);
    const newerQuads: Quad[] = [{
      subject: 'urn:asset:newer-unpublished',
      predicate: 'urn:predicate:value',
      object: '"newer"',
      graph: swmGraph,
    }, {
      subject: 'urn:asset:newer-unpublished-two',
      predicate: 'urn:predicate:value',
      object: '"newer-two"',
      graph: swmGraph,
    }];
    await store.dropGraph(swmGraph);
    await store.insert(newerQuads);
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'graph-finalization-newer-unpublished',
      kaUal: newerScope.ual,
      assertionVersion: newerScope.assertionVersion,
      quads: newerQuads,
      privateMerkleRoot,
      privateTripleCount,
      publisherPeerId: '12D3KooWPublisher',
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'graph-finalization-newer-unpublished',
      kaUal: newerScope.ual,
      assertionVersion: newerScope.assertionVersion,
    });
  }

  it('atomically replaces the exact VM graph and emits constant-size rootless metadata', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();

    await handler.handleFinalizationMessage(encodeFinalizationMessage({
      ...message,
      accessPolicy: 'allowList',
      allowedPeers: ['12D3KooWReader'],
    }), CG, '12D3KooWPublisher');

    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(2);
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
      policy: '"allowList"',
    });
    const allowedPeer = await store.query(
      `ASK { GRAPH <${metaGraph}> { <${UAL}> ` +
        `<http://dkg.io/ontology/allowedPeer> "12D3KooWReader" } }`,
    );
    expect(allowedPeer).toMatchObject({ type: 'boolean', value: true });
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

  it('ignores an access envelope supplied by a relay that is not the durable owner', async () => {
    const { message } = await stageGraph({ accessPolicy: 'ownerOnly' });

    await handler.handleFinalizationMessage(encodeFinalizationMessage({
      ...message,
      accessPolicy: 'allowList',
      allowedPeers: ['12D3KooWAttacker'],
    }), CG, '12D3KooWUntrustedRelay');

    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    const policy = await store.query(
      `SELECT ?policy WHERE { GRAPH <${metaGraph}> { <${UAL}> ` +
        `<http://dkg.io/ontology/accessPolicy> ?policy } }`,
    );
    expect(policy).toMatchObject({
      type: 'bindings',
      bindings: [{ policy: '"ownerOnly"' }],
    });
    const attacker = await store.query(
      `ASK { GRAPH <${metaGraph}> { <${UAL}> ` +
        `<http://dkg.io/ontology/allowedPeer> "12D3KooWAttacker" } }`,
    );
    expect(attacker).toMatchObject({ type: 'boolean', value: false });
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
    expect(await store.countQuads(swmGraph)).toBe(2);
  });

  it('does not delete a newer SWM assertion staged after source verification', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    const internals = handler as unknown as {
      applyVerifiedGraphScopedFinalization: (
        input: unknown,
      ) => Promise<'applied' | 'stale'>;
    };
    const applyVerifiedGraphScopedFinalization =
      internals.applyVerifiedGraphScopedFinalization.bind(handler);
    internals.applyVerifiedGraphScopedFinalization = async (input) => {
      await stageNewerWorkspaceAssertion(
        swmGraph,
        message.privateMerkleRoot,
        message.privateTripleCount,
      );
      return applyVerifiedGraphScopedFinalization(input);
    };

    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(2);
    const newerSwm = await store.query(
      `ASK { GRAPH <${swmGraph}> { <urn:asset:newer-unpublished> `
        + `<urn:predicate:value> "newer" } }`,
    );
    expect(newerSwm).toMatchObject({ type: 'boolean', value: true });
    const currentHead = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
    });
    expect(currentHead?.assertionVersion).toBe('2');
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
    expect(await store.countQuads(swmGraph)).toBe(2);
  });

  it('verifies chain binding and exact private VM metadata without deleting unverified SWM', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    const materializedVersionPredicate = 'http://dkg.io/ontology/materializedVersion';
    await store.deleteByPattern({
      graph: metaGraph,
      subject: UAL,
      predicate: materializedVersionPredicate,
    });
    await store.insert([{
      subject: UAL,
      predicate: materializedVersionPredicate,
      object: '"123:0"',
      graph: metaGraph,
    }]);
    const vmResult = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`,
    );
    if (vmResult.type !== 'quads') throw new Error('expected finalized VM quads');
    await store.insert(vmResult.quads.map((quad) => ({ ...quad, graph: swmGraph })));
    expect(await store.countQuads(swmGraph)).toBe(2);

    let bindingVerified = false;
    const internals = handler as unknown as {
      verifyChainCgBinding: () => Promise<boolean>;
    };
    internals.verifyChainCgBinding = async () => {
      bindingVerified = true;
      return true;
    };

    await expect(handler.handleChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      versionBlock: 123,
      authorAddress: AUTHOR,
    }, createOperationContext('system'))).resolves.toBe('already-confirmed');
    expect(bindingVerified).toBe(true);
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(2);
  });

  it('advances sweep ordering without rewriting an exact VM graph', async () => {
    const { message, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    const replaceGraph = store.replaceGraph?.bind(store);
    if (!replaceGraph) throw new Error('Oxigraph replaceGraph unavailable');
    let vmReplacements = 0;
    store.replaceGraph = async (graphUri, quads, options) => {
      if (graphUri === vmGraph) vmReplacements += 1;
      return replaceGraph(graphUri, quads, options);
    };
    const internals = handler as unknown as {
      verifyChainCgBinding: () => Promise<boolean>;
    };
    internals.verifyChainCgBinding = async () => true;

    for (const versionBlock of [124, 125]) {
      await expect(handler.handleChainReconciledKC({
        contextGraphId: CG,
        onChainCgId: '42',
        ual: UAL,
        merkleRoot: message.kcMerkleRoot,
        publisherAddress: PUBLISHER,
        kaId: PACKED_KA_ID,
        versionBlock,
        authorAddress: AUTHOR,
      }, createOperationContext('system'))).resolves.toBe('already-confirmed');
    }

    expect(vmReplacements).toBe(0);
    const version = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> {
        <${UAL}> <http://dkg.io/ontology/materializedVersion> "125:0" .
      } }`,
    );
    expect(version).toMatchObject({ type: 'boolean', value: true });
  });

  it('repairs stale access metadata from the durable graph-scoped head', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    const accessPolicyPredicate = 'http://dkg.io/ontology/accessPolicy';
    await store.deleteByPattern({
      graph: metaGraph,
      subject: UAL,
      predicate: accessPolicyPredicate,
    });
    await store.insert([{
      subject: UAL,
      predicate: accessPolicyPredicate,
      object: '"public"',
      graph: metaGraph,
    }]);

    let bindingVerified = false;
    const internals = handler as unknown as {
      verifyChainCgBinding: () => Promise<boolean>;
      findSwmSnapshotForMerkleRoot: () => Promise<never>;
      graphScopedMetadataState: (...args: unknown[]) => Promise<'matching' | 'different' | 'absent'>;
    };
    internals.verifyChainCgBinding = async () => {
      bindingVerified = true;
      return true;
    };
    internals.findSwmSnapshotForMerkleRoot = async () => {
      throw new Error('legacy root scan must not run for exact VM metadata repair');
    };
    const graphScopedMetadataState = internals.graphScopedMetadataState.bind(handler);
    internals.graphScopedMetadataState = async (...args) => {
      const state = await graphScopedMetadataState(...args);
      await stageNewerWorkspaceAssertion(
        swmGraph,
        message.privateMerkleRoot,
        message.privateTripleCount,
      );
      return state;
    };

    await expect(handler.handleChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      versionBlock: 124,
      authorAddress: AUTHOR,
    }, createOperationContext('system'))).resolves.toBe('already-confirmed');

    expect(bindingVerified).toBe(true);
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(2);
    const newerSwm = await store.query(
      `ASK { GRAPH <${swmGraph}> { <urn:asset:newer-unpublished> ` +
        `<urn:predicate:value> "newer" } }`,
    );
    expect(newerSwm).toMatchObject({ type: 'boolean', value: true });
    const currentHead = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
    });
    expect(currentHead?.assertionVersion).toBe('2');
    const repairedPolicy = await store.query(
      `ASK { GRAPH <${metaGraph}> {
        <${UAL}> <${accessPolicyPredicate}> "ownerOnly" .
      } }`,
    );
    const stalePolicy = await store.query(
      `ASK { GRAPH <${metaGraph}> {
        <${UAL}> <${accessPolicyPredicate}> "public" .
      } }`,
    );
    expect(repairedPolicy).toMatchObject({ type: 'boolean', value: true });
    expect(stalePolicy).toMatchObject({ type: 'boolean', value: false });
  });

  it('repairs gossip provenance when the stored transaction hash is wrong', async () => {
    const { message } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    const transactionHashPredicate = 'http://dkg.io/ontology/transactionHash';
    await store.deleteByPattern({
      graph: metaGraph,
      subject: UAL,
      predicate: transactionHashPredicate,
    });
    await store.insert([{
      subject: UAL,
      predicate: transactionHashPredicate,
      object: `"0x${'cd'.repeat(32)}"`,
      graph: metaGraph,
    }]);

    const replayHandler = new FinalizationHandler(store, undefined);
    (replayHandler as unknown as {
      verifyOnChain: () => Promise<{ verified: boolean; authorAddress: string; txIndex: number }>;
    }).verifyOnChain = async () => ({
      verified: true,
      authorAddress: AUTHOR,
      txIndex: 4,
    });
    await replayHandler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    const repairedTransactionHash = await store.query(
      `ASK { GRAPH <${metaGraph}> {
        <${UAL}> <${transactionHashPredicate}> "${message.txHash}" .
      } }`,
    );
    expect(repairedTransactionHash).toMatchObject({ type: 'boolean', value: true });
  });

  it('repairs rootless metadata after VM content committed but metadata did not', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    const swmResult = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`,
    );
    if (swmResult.type !== 'quads') throw new Error('expected staged SWM quads');
    await store.dropGraph(vmGraph);
    await store.insert(swmResult.quads.map((quad) => ({ ...quad, graph: vmGraph })));
    await store.dropGraph(swmGraph);
    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    await store.deleteByPattern({ graph: metaGraph, subject: UAL });

    const internals = handler as unknown as {
      verifyChainCgBinding: (kaId: bigint, cgId: string) => Promise<boolean>;
      findSwmSnapshotForMerkleRoot: () => Promise<never>;
    };
    internals.verifyChainCgBinding = async () => true;
    internals.findSwmSnapshotForMerkleRoot = async () => {
      throw new Error('legacy root scan must not run for VM metadata recovery');
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

    expect(outcome).toBe('already-confirmed');
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(0);
    const repaired = await store.query(
      `ASK { GRAPH <${metaGraph}> {
        <${UAL}> <http://dkg.io/ontology/contentScopeVersion> "2"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/assertionVersion> "1"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/assertionGraph> <${vmGraph}> ;
          <http://dkg.io/ontology/status> "confirmed" ;
          <http://dkg.io/ontology/materializedVersion> "123:0" .
      } }`,
    );
    expect(repaired).toMatchObject({ type: 'boolean', value: true });
  });

  it('repairs an incomplete rootless metadata tail after exact VM commit', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(2);

    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    const materializedVersionPredicate = 'http://dkg.io/ontology/materializedVersion';
    await store.deleteByPattern({
      graph: metaGraph,
      subject: UAL,
      predicate: materializedVersionPredicate,
    });

    const internals = handler as unknown as {
      verifyChainCgBinding: (kaId: bigint, cgId: string) => Promise<boolean>;
      findSwmSnapshotForMerkleRoot: () => Promise<never>;
    };
    internals.verifyChainCgBinding = async () => true;
    internals.findSwmSnapshotForMerkleRoot = async () => {
      throw new Error('legacy root scan must not run for VM metadata-tail recovery');
    };

    await expect(handler.handleChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      versionBlock: 123,
      authorAddress: AUTHOR,
    }, createOperationContext('system'))).resolves.toBe('already-confirmed');

    const repairedVersion = await store.query(
      `ASK { GRAPH <${metaGraph}> {
        <${UAL}> <${materializedVersionPredicate}> "123:0" .
      } }`,
    );
    expect(repairedVersion).toMatchObject({ type: 'boolean', value: true });
  });

  it('does not trust matching metadata and quad count when exact VM content is corrupt', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    await store.dropGraph(swmGraph);
    expect(await store.countQuads(swmGraph)).toBe(0);

    const vmResult = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`,
    );
    if (vmResult.type !== 'quads') throw new Error('expected finalized VM quads');
    const corrupted = vmResult.quads.map((quad, index) => index === 0
      ? { ...quad, object: '"same-count-corruption"', graph: vmGraph }
      : { ...quad, graph: vmGraph });
    await store.dropGraph(vmGraph);
    await store.insert(corrupted);
    expect(await store.countQuads(vmGraph)).toBe(message.publicTripleCount);

    const internals = handler as unknown as {
      verifyChainCgBinding: (kaId: bigint, cgId: string) => Promise<boolean>;
      findSwmSnapshotForMerkleRoot: () => Promise<never>;
    };
    internals.verifyChainCgBinding = async () => true;
    internals.findSwmSnapshotForMerkleRoot = async () => {
      throw new Error('legacy root scan must not run for corrupt V2 content');
    };

    await expect(handler.handleChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      versionBlock: 123,
      authorAddress: AUTHOR,
    }, createOperationContext('system'))).resolves.toBe('no-swm');
  });

  it('does not bind an older VM assertion to a newer unpublished SWM head', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    await stageNewerWorkspaceAssertion(
      swmGraph,
      message.privateMerkleRoot,
      message.privateTripleCount,
    );

    const internals = handler as unknown as {
      verifyChainCgBinding: () => Promise<boolean>;
    };
    internals.verifyChainCgBinding = async () => true;

    await expect(handler.handleChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      versionBlock: 123,
      authorAddress: AUTHOR,
    }, createOperationContext('system'))).resolves.toBe('no-swm');

    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(2);
    const confirmedVersion = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> {
        <${UAL}> <http://dkg.io/ontology/assertionVersion> "1"^^<http://www.w3.org/2001/XMLSchema#integer> .
      } }`,
    );
    expect(confirmedVersion).toMatchObject({ type: 'boolean', value: true });
  });

  it('does not publish a newer same-root access policy during chain repair', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    const staged = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`,
    );
    if (staged.type !== 'quads') throw new Error('expected staged SWM quads');
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'graph-finalization-same-root-policy-update',
      kaUal: UAL,
      assertionVersion: '2',
      quads: staged.quads,
      privateMerkleRoot: message.privateMerkleRoot,
      privateTripleCount: message.privateTripleCount,
      publisherPeerId: '12D3KooWPublisher',
      accessPolicy: 'public',
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'graph-finalization-same-root-policy-update',
      kaUal: UAL,
      assertionVersion: '2',
    });

    const internals = handler as unknown as {
      verifyChainCgBinding: () => Promise<boolean>;
    };
    internals.verifyChainCgBinding = async () => true;
    const outcome = await handler.handleChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      versionBlock: 124,
      authorAddress: AUTHOR,
    }, createOperationContext('system'));

    expect(outcome).toBe('already-confirmed');
    expect(await store.countQuads(vmGraph)).toBe(2);
    const confirmedPolicy = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> {
        <${UAL}> <http://dkg.io/ontology/assertionVersion> "1"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/accessPolicy> "ownerOnly" ;
          <http://dkg.io/ontology/materializedVersion> "123:4" .
      } }`,
    );
    expect(confirmedPolicy).toMatchObject({ type: 'boolean', value: true });
    const unpublishedPolicy = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> {
        <${UAL}> <http://dkg.io/ontology/assertionVersion> "2"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/accessPolicy> "public" .
      } }`,
    );
    expect(unpublishedPolicy).toMatchObject({ type: 'boolean', value: false });
  });

  it('repairs rootless metadata after VM content committed but metadata did not', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    const swmResult = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`,
    );
    if (swmResult.type !== 'quads') throw new Error('expected staged SWM quads');
    await store.dropGraph(vmGraph);
    await store.insert(swmResult.quads.map((quad) => ({ ...quad, graph: vmGraph })));
    await store.dropGraph(swmGraph);
    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    await store.deleteByPattern({ graph: metaGraph, subject: UAL });

    const internals = handler as unknown as {
      verifyChainCgBinding: (kaId: bigint, cgId: string) => Promise<boolean>;
      findSwmSnapshotForMerkleRoot: () => Promise<never>;
    };
    internals.verifyChainCgBinding = async () => true;
    internals.findSwmSnapshotForMerkleRoot = async () => {
      throw new Error('legacy root scan must not run for VM metadata recovery');
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

    expect(outcome).toBe('already-confirmed');
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(0);
    const repaired = await store.query(
      `ASK { GRAPH <${metaGraph}> {
        <${UAL}> <http://dkg.io/ontology/contentScopeVersion> "2"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/assertionVersion> "1"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/assertionGraph> <${vmGraph}> ;
          <http://dkg.io/ontology/status> "confirmed" ;
          <http://dkg.io/ontology/materializedVersion> "123:0" .
      } }`,
    );
    expect(repaired).toMatchObject({ type: 'boolean', value: true });
  });

  it('fails closed when metadata is absent behind a newer same-root public head', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    await store.deleteByPattern({ graph: metaGraph, subject: UAL });

    const staged = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`,
    );
    if (staged.type !== 'quads') throw new Error('expected staged SWM quads');
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'graph-finalization-absent-metadata-policy-update',
      kaUal: UAL,
      assertionVersion: '2',
      quads: staged.quads,
      privateMerkleRoot: message.privateMerkleRoot,
      privateTripleCount: message.privateTripleCount,
      publisherPeerId: '12D3KooWPublisher',
      accessPolicy: 'public',
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'graph-finalization-absent-metadata-policy-update',
      kaUal: UAL,
      assertionVersion: '2',
    });

    const internals = handler as unknown as {
      verifyChainCgBinding: () => Promise<boolean>;
    };
    internals.verifyChainCgBinding = async () => true;
    const reconcileInput = {
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      versionBlock: 124,
      authorAddress: AUTHOR,
    };
    await expect(handler.handleChainReconciledKC(
      reconcileInput,
      createOperationContext('system'),
    )).resolves.toBe('already-confirmed');
    await expect(handler.handleChainReconciledKC(
      reconcileInput,
      createOperationContext('system'),
    )).resolves.toBe('already-confirmed');

    expect(await store.countQuads(vmGraph)).toBe(2);
    const failClosedPolicy = await store.query(
      `ASK { GRAPH <${metaGraph}> {
        <${UAL}> <http://dkg.io/ontology/assertionVersion> "2"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/accessPolicy> "ownerOnly" ;
          <http://dkg.io/ontology/status> "confirmed" .
      } }`,
    );
    expect(failClosedPolicy).toMatchObject({ type: 'boolean', value: true });
    const leakedPublicPolicy = await store.query(
      `ASK { GRAPH <${metaGraph}> {
        <${UAL}> <http://dkg.io/ontology/accessPolicy> "public" .
      } }`,
    );
    expect(leakedPublicPolicy).toMatchObject({ type: 'boolean', value: false });
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
    await store.dropGraph(nextSwmGraph);
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
    expect(await store.countQuads(nextSwmGraph)).toBe(1);
    const version = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> {
        <${UAL}> <http://dkg.io/ontology/assertionVersion> "2"^^<http://www.w3.org/2001/XMLSchema#integer> .
      } }`,
    );
    expect(version).toMatchObject({ type: 'boolean', value: true });
  });
});
