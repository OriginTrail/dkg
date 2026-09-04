import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  ExactGraphReadError,
  OxigraphStore,
  StoreSchedulerBusyError,
  type Quad,
  type QueryResult,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import {
  computeFlatKCRootV10,
  computePrivateRootV10,
  generateAssertionCreatedMetadata,
  generateGraphKnowledgeAssetMetadata,
  replaceLocallyTrustedKnowledgeAssetControls,
  resolveKnowledgeAssetWorkspaceHead,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
  swmKaWriteLockKey,
  withKeyedLocks,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import { FinalizationHandler } from '../src/finalization-handler.js';
import { resolveConfirmedGraphScopedVm } from '../src/confirmed-graph-scoped-vm-resolver.js';
import { verifyExactGraphContent } from '../src/exact-graph-content-verifier.js';
import {
  openSqliteFinalizationRecoveryStore,
  type SqliteFinalizationRecoveryStore,
} from '../src/finalization-recovery-sqlite-store.js';
import type { FinalizationRecoveryStore } from '../src/finalization-recovery-store.js';
import { protobufScalarToBigInt } from '../src/protobuf-scalars.js';
import {
  reconcileContextGraph,
  type ChainReconcilerDeps,
} from '../src/chain-reconciler.js';
import { createCursorState } from '../src/reconcile-cursor.js';
import {
  createRetireConfirmedGraphScopedSwmTwinIfOrphaned,
  reconcileFinalizedSwmTwinFromCatalogProjection,
} from
  '../src/sync/requester/finalized-swm-twin-reconciliation.js';

const CG = 'rootless-finalization';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const PUBLISHER = '0x2222222222222222222222222222222222222222';
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const SHARE_ID = 'graph-finalization-share';
const VERSION = '1';
const PACKED_KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const RECOVERY_BLOCK_HASH = `0x${'cd'.repeat(32)}`;

function canonicalReceipt(
  message: FinalizationMessageMsg,
  txIndex = 4,
  blockHash = RECOVERY_BLOCK_HASH,
) {
  return {
    status: 'confirmed' as const,
    receipt: {
      txHash: message.txHash,
      blockNumber: Number(message.blockNumber),
      blockHash,
      txIndex,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: message.publisherAddress,
      authorAddress: AUTHOR,
      batchId: protobufScalarToBigInt(message.batchId),
      kaId: PACKED_KA_ID,
      startKAId: PACKED_KA_ID,
      endKAId: PACKED_KA_ID,
    },
  };
}

function legacyFinalizationChain(
  txIndex: number | null = 4,
  overrides: Partial<ChainAdapter> = {},
): ChainAdapter {
  const privateMerkleRoot = computePrivateRootV10([{
    subject: 'urn:asset:secret',
    predicate: 'urn:predicate:value',
    object: '"hidden"',
    graph: '',
  }]);
  const privateOnlyMerkleRoot = computePrivateRootV10([{
    subject: 'urn:asset:private-only',
    predicate: 'urn:predicate:value',
    object: '"hidden"',
    graph: '',
  }]);
  if (!privateMerkleRoot || !privateOnlyMerkleRoot) {
    throw new Error('expected test private commitments');
  }
  const standardRoot = computeFlatKCRootV10([
    { subject: 'urn:asset:one', predicate: 'urn:predicate:value', object: '"one"', graph: '' },
    { subject: 'urn:asset:two', predicate: 'urn:predicate:value', object: '"two"', graph: '' },
  ], [privateMerkleRoot]);
  const privateOnlyRoot = computeFlatKCRootV10([], [privateOnlyMerkleRoot]);
  return {
    chainId: 'legacy:1',
    isV10Ready: () => true,
    listenForEvents: async function* (filter) {
      if (
        !filter.eventTypes.includes('KCCreated')
        && !filter.eventTypes.includes('KnowledgeBatchCreated')
      ) return;
      for (const [txHash, merkleRoot] of [
        [`0x${'ab'.repeat(32)}`, standardRoot],
        [`0x${'cd'.repeat(32)}`, privateOnlyRoot],
      ] as const) {
        yield {
          blockNumber: 123,
          data: {
            txHash,
            merkleRoot,
            publisherAddress: PUBLISHER,
            startKAId: PACKED_KA_ID.toString(),
            endKAId: PACKED_KA_ID.toString(),
            author: AUTHOR,
            ...(txIndex !== null ? { txIndex } : {}),
          },
        };
      }
    },
    ...overrides,
  } as ChainAdapter;
}

async function closeInbox(inbox: SqliteFinalizationRecoveryStore | undefined): Promise<void> {
  await inbox?.close().catch(() => {});
}

function recoveryOptions(
  recoveryStore: FinalizationRecoveryStore,
  localTopicOnChainContextGraphId = '42',
) {
  return {
    recoveryStore,
    resolveContextGraphOnChainId: async () => localTopicOnChainContextGraphId,
  };
}

function recoveryReconciler(
  recoveryHandler: FinalizationHandler,
  input: Parameters<FinalizationHandler['handleChainReconciledKC']>[0],
  persistedWatermarks: number[],
): ChainReconcilerDeps {
  return {
    getKCCount: async () => 1,
    getHeadBlock: async () => undefined,
    reconcileOrdinal: async () => {
      const outcome = await recoveryHandler.handleChainReconciledKC(
        input,
        createOperationContext('system'),
      );
      if (outcome === 'promoted') return { status: 'reconciled', blockNumber: 123 };
      if (outcome === 'already-confirmed' || outcome === 'stale-target') {
        return { status: 'already', blockNumber: 123 };
      }
      return { status: 'pending' };
    },
    persistWatermark: (_contextGraphId, watermark) => {
      persistedWatermarks.push(watermark);
    },
    confirmationDepth: 0,
    log: () => {},
  };
}

describe('graph-scoped finalization handler', () => {
  let store: OxigraphStore;
  let graphManager: GraphManager;
  let handler: FinalizationHandler;

  beforeEach(() => {
    store = new OxigraphStore();
    graphManager = new GraphManager(store);
    handler = new FinalizationHandler(store, legacyFinalizationChain());
  });

  async function stageGraph(durableAccess?: {
    accessPolicy: 'ownerOnly' | 'allowList';
    allowedPeers?: string[];
  }, subGraphName?: string): Promise<{
    message: FinalizationMessageMsg;
    swmGraph: string;
    vmGraph: string;
  }> {
    const scope = createGraphKnowledgeAssetScope(UAL, VERSION);
    const swmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.SharedWorkingMemory,
      scope,
      subGraphName,
    );
    const vmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      scope,
      subGraphName,
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
      subGraphName,
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: SHARE_ID,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      subGraphName,
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
        subGraphName,
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

  async function seedAuthenticatedLocalControls(
    message: FinalizationMessageMsg,
    accessPolicy: 'public' | 'ownerOnly' | 'allowList' = 'ownerOnly',
    allowedPeers: string[] = [],
    publisherPeerId = '12D3KooWPublisher',
  ): Promise<void> {
    const scope = createGraphKnowledgeAssetScope(UAL, message.assertionVersion ?? VERSION);
    const metadata = generateGraphKnowledgeAssetMetadata({
      ual: scope.ual,
      contextGraphId: CG,
      merkleRoot: message.kcMerkleRoot,
      publisherPeerId,
      accessPolicy,
      allowedPeers,
      timestamp: new Date(),
      assertionVersion: scope.assertionVersion,
      publicTripleCount: Number(message.publicTripleCount),
      privateTripleCount: Number(message.privateTripleCount),
      ...(message.privateMerkleRoot?.length
        ? { privateMerkleRoot: message.privateMerkleRoot }
        : {}),
      assertionGraph: knowledgeAssetLayerGraphUri(
        CG,
        MemoryLayer.SharedWorkingMemory,
        scope,
        message.subGraphName || undefined,
      ),
      ...(message.subGraphName ? { subGraphName: message.subGraphName } : {}),
    }, { status: 'tentative' });
    await replaceLocallyTrustedKnowledgeAssetControls(store, scope.ual, metadata);
  }

  function trustedRecoveryEvidence(
    message: FinalizationMessageMsg,
    accessPolicy: 'public' | 'ownerOnly' | 'allowList' = 'ownerOnly',
    allowedPeers: string[] = [],
  ) {
    const txIndex = Number(message.txIndex);
    if (!Number.isSafeInteger(txIndex) || txIndex < 0) {
      throw new Error('trusted test evidence requires an exact transaction index');
    }
    return {
      assertionVersion: message.assertionVersion!,
      publicTripleCount: message.publicTripleCount!,
      ...(message.privateMerkleRoot
        ? { privateMerkleRoot: `0x${Buffer.from(message.privateMerkleRoot).toString('hex')}` }
        : {}),
      privateTripleCount: message.privateTripleCount!,
      publisherPeerId: '12D3KooWPublisher',
      publisherAddress: message.publisherAddress,
      transactionHash: message.txHash,
      blockNumber: Number(message.blockNumber),
      blockHash: RECOVERY_BLOCK_HASH,
      txIndex,
      authorAddress: AUTHOR,
      accessPolicy,
      allowedPeers,
    };
  }

  type GraphReconcileInput = Parameters<FinalizationHandler['handleChainReconciledKC']>[0];

  function graphReconcileInput(
    message: FinalizationMessageMsg,
    overrides: Partial<GraphReconcileInput> = {},
  ): GraphReconcileInput {
    return {
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      batchId: message.batchId,
      versionBlock: 123,
      authorAddress: AUTHOR,
      ...overrides,
    };
  }

  function makeReconcileHandler(
    chainOverrides: Partial<ChainAdapter>,
    options: { forbidLegacyRootScan?: boolean } = {},
  ): FinalizationHandler {
    const reconcileHandler = new FinalizationHandler(
      store,
      legacyFinalizationChain(4, chainOverrides),
    );
    const internals = reconcileHandler as unknown as {
      verifyChainCgBinding: (kaId: bigint, cgId: string) => Promise<boolean>;
      findSwmSnapshotForMerkleRoot?: () => Promise<never>;
    };
    internals.verifyChainCgBinding = async () => true;
    if (options.forbidLegacyRootScan) {
      internals.findSwmSnapshotForMerkleRoot = async () => {
        throw new Error('legacy root scan must not run for graph-scoped SWM');
      };
    }
    return reconcileHandler;
  }

  function makePublicReconcileHandler(
    message: FinalizationMessageMsg,
    chainOverrides: Partial<ChainAdapter> = {},
  ): FinalizationHandler {
    return makeReconcileHandler({
      isContextGraphActiveOnChain: async () => true,
      getContextGraphAccessPolicy: async () => 0,
      getMerkleRootCount: async () => 1n,
      getLatestMerkleRoot: async () => message.kcMerkleRoot,
      ...chainOverrides,
    }, { forbidLegacyRootScan: true });
  }

  function reconcileGraphScoped(
    reconcileHandler: FinalizationHandler,
    message: FinalizationMessageMsg,
    overrides: Partial<GraphReconcileInput> = {},
  ) {
    return reconcileHandler.handleChainReconciledKC(
      graphReconcileInput(message, overrides),
      createOperationContext('system'),
    );
  }

  async function expectGraphScopedMetadata(
    pattern: string,
    present = true,
  ): Promise<void> {
    await expect(store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> { <${UAL}> ${pattern} } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: present });
  }

  async function retainExactContentOnlyInVm(
    swmGraph: string,
    vmGraph: string,
  ): Promise<void> {
    const staged = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`,
    );
    if (staged.type !== 'quads') throw new Error('expected staged SWM quads');
    await store.dropGraph(vmGraph);
    await store.insert(staged.quads.map((quad) => ({ ...quad, graph: vmGraph })));
    await store.dropGraph(swmGraph);
    await store.deleteByPattern({
      graph: `did:dkg:context-graph:${CG}/_meta`,
      subject: UAL,
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

  it('accepts adapter batch metadata when the singleton KA range matches the UAL', async () => {
    const { message, vmGraph } = await stageGraph();

    await handler.handleFinalizationMessage(encodeFinalizationMessage({
      ...message,
      batchId: 42n,
    }), CG, '12D3KooWPublisher');

    expect(await store.countQuads(vmGraph)).toBe(2);
  });

  it('does not borrow named-subgraph workspace evidence for a root finalization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-scope-binding-'));
    try {
      const { message, swmGraph, vmGraph } = await stageGraph(undefined, 'named-scope');
      const scopedHandler = new FinalizationHandler(store, legacyFinalizationChain());

      await scopedHandler.handleFinalizationMessage(encodeFinalizationMessage({
        ...message,
        subGraphName: undefined,
        operationId: 'root-finalization-cannot-borrow-named-head',
      }), CG, '12D3KooWPublisher');

      expect(await store.countQuads(swmGraph)).toBe(2);
      expect(await store.countQuads(vmGraph)).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it('persists publisher authority for relay-first recovery across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-relay-duplicate-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const { message, vmGraph } = await stageGraph();
      const finalization = {
        ...message,
        accessPolicy: 'allowList' as const,
        allowedPeers: ['12D3KooWReader'],
      };
      let receiptReady = false;
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => finalization.kcMerkleRoot,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () => receiptReady
          ? canonicalReceipt(finalization)
          : { status: 'pending' as const },
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const recoveringHandler = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox),
      );
      const wire = encodeFinalizationMessage(finalization);

      await recoveringHandler.handleFinalizationMessage(
        wire,
        CG,
        '12D3KooWUntrustedRelay',
      );
      expect(await inbox.list()).toMatchObject([{
        state: 'RECEIVED',
        sourcePeerId: '12D3KooWUntrustedRelay',
      }]);

      await recoveringHandler.handleFinalizationMessage(
        wire,
        CG,
        '12D3KooWPublisher',
      );
      expect(await inbox.list()).toMatchObject([{
        state: 'RECEIVED',
        sourcePeerId: '12D3KooWUntrustedRelay',
        trustedPublisherPeerId: '12D3KooWPublisher',
      }]);

      await inbox.close();
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      receiptReady = true;
      const restartedHandler = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox),
      );
      await expect(restartedHandler.handleChainReconciledKC({
        contextGraphId: CG,
        onChainCgId: '42',
        ual: UAL,
        merkleRoot: finalization.kcMerkleRoot,
        publisherAddress: PUBLISHER,
        kaId: PACKED_KA_ID,
        versionBlock: 123,
        authorAddress: AUTHOR,
      }, createOperationContext('system'))).resolves.toBe('already-confirmed');
      expect(await inbox.list()).toMatchObject([{
        state: 'SETTLED',
        sourcePeerId: '12D3KooWUntrustedRelay',
        trustedPublisherPeerId: '12D3KooWPublisher',
        verifiedEvidence: {
          accessPolicy: 'allowList',
          allowedPeers: ['12D3KooWReader'],
        },
      }]);
      expect(await store.countQuads(vmGraph)).toBe(2);

      const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
      const metadata = await store.query(
        `ASK { GRAPH <${metaGraph}> { <${UAL}> `
          + `<http://dkg.io/ontology/accessPolicy> "allowList" ; `
          + `<http://dkg.io/ontology/allowedPeer> "12D3KooWReader" } }`,
      );
      expect(metadata).toMatchObject({ type: 'boolean', value: true });
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('repairs a relay-settled owner-only policy when the publisher arrives later', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-late-publisher-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const { message } = await stageGraph();
      const finalization = {
        ...message,
        accessPolicy: 'allowList' as const,
        allowedPeers: ['12D3KooWReader'],
      };
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => finalization.kcMerkleRoot,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () => canonicalReceipt(finalization),
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const recoveringHandler = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox),
      );
      const wire = encodeFinalizationMessage(finalization);
      const metaGraph = `did:dkg:context-graph:${CG}/_meta`;

      await recoveringHandler.handleFinalizationMessage(
        wire,
        CG,
        '12D3KooWUntrustedRelay',
      );
      expect(await inbox.list()).toMatchObject([{
        state: 'SETTLED',
        generation: 0,
        sourcePeerId: '12D3KooWUntrustedRelay',
        verifiedEvidence: {
          accessPolicy: 'ownerOnly',
          allowedPeers: [],
        },
      }]);
      await expect(store.query(
        `ASK { GRAPH <${metaGraph}> { <${UAL}> `
          + '<http://dkg.io/ontology/accessPolicy> "ownerOnly" } }',
      )).resolves.toMatchObject({ type: 'boolean', value: true });

      await recoveringHandler.handleFinalizationMessage(
        wire,
        CG,
        '12D3KooWPublisher',
      );
      expect(await inbox.list()).toMatchObject([{
        state: 'SETTLED',
        generation: 1,
        sourcePeerId: '12D3KooWUntrustedRelay',
        trustedPublisherPeerId: '12D3KooWPublisher',
        verifiedEvidence: {
          accessPolicy: 'allowList',
          allowedPeers: ['12D3KooWReader'],
        },
      }]);
      await expect(store.query(
        `ASK { GRAPH <${metaGraph}> { <${UAL}> `
          + '<http://dkg.io/ontology/accessPolicy> "allowList" ; '
          + '<http://dkg.io/ontology/allowedPeer> "12D3KooWReader" } }',
      )).resolves.toMatchObject({ type: 'boolean', value: true });
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers a pending late-publisher receipt check after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-pending-publisher-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const { message } = await stageGraph();
      const finalization = {
        ...message,
        accessPolicy: 'allowList' as const,
        allowedPeers: ['12D3KooWReader'],
      };
      let now = 1_000;
      let receiptState: 'confirmed' | 'pending' = 'confirmed';
      let receiptCalls = 0;
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => finalization.kcMerkleRoot,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () => {
          receiptCalls += 1;
          return receiptState === 'confirmed'
            ? canonicalReceipt(finalization)
            : { status: 'pending' as const };
        },
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory, { now: () => now });
      const recoveringHandler = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox),
      );
      const wire = encodeFinalizationMessage(finalization);
      const metaGraph = `did:dkg:context-graph:${CG}/_meta`;

      await recoveringHandler.handleFinalizationMessage(
        wire,
        CG,
        '12D3KooWUntrustedRelay',
      );
      expect(receiptCalls).toBe(1);
      expect(await inbox.list()).toMatchObject([{
        state: 'SETTLED',
        generation: 0,
        publisherUpgradePending: false,
        sourcePeerId: '12D3KooWUntrustedRelay',
        verifiedEvidence: {
          accessPolicy: 'ownerOnly',
          allowedPeers: [],
        },
      }]);

      receiptState = 'pending';
      await recoveringHandler.handleFinalizationMessage(
        wire,
        CG,
        '12D3KooWPublisher',
      );
      expect(receiptCalls).toBe(2);
      const [pendingUpgrade] = await inbox.list();
      expect(pendingUpgrade).toMatchObject({
        state: 'SETTLED',
        generation: 0,
        publisherUpgradePending: true,
        sourcePeerId: '12D3KooWUntrustedRelay',
        trustedPublisherPeerId: '12D3KooWPublisher',
        attemptCount: 1,
        nextAttemptAt: 2_000,
        verifiedEvidence: {
          accessPolicy: 'ownerOnly',
          allowedPeers: [],
        },
      });
      await expect(store.query(
        `ASK { GRAPH <${metaGraph}> { <${UAL}> `
          + '<http://dkg.io/ontology/accessPolicy> "ownerOnly" } }',
      )).resolves.toMatchObject({ type: 'boolean', value: true });

      await recoveringHandler.handleFinalizationMessage(
        wire,
        CG,
        '12D3KooWPublisher',
      );
      expect(receiptCalls).toBe(2);

      await inbox.close();
      inbox = await openSqliteFinalizationRecoveryStore(directory, { now: () => now });
      now = pendingUpgrade!.nextAttemptAt!;
      receiptState = 'confirmed';
      const restartedHandler = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox),
      );
      await expect(restartedHandler.handleChainReconciledKC({
        contextGraphId: CG,
        onChainCgId: '42',
        ual: UAL,
        merkleRoot: finalization.kcMerkleRoot,
        publisherAddress: PUBLISHER,
        kaId: PACKED_KA_ID,
        versionBlock: 123,
        authorAddress: AUTHOR,
      }, createOperationContext('system'))).resolves.toBe('already-confirmed');
      expect(receiptCalls).toBe(4);
      expect(await inbox.list()).toMatchObject([{
        state: 'SETTLED',
        generation: 1,
        publisherUpgradePending: false,
        sourcePeerId: '12D3KooWUntrustedRelay',
        trustedPublisherPeerId: '12D3KooWPublisher',
        attemptCount: 0,
        verifiedEvidence: {
          accessPolicy: 'allowList',
          allowedPeers: ['12D3KooWReader'],
        },
      }]);
      await expect(store.query(
        `ASK { GRAPH <${metaGraph}> { <${UAL}> `
          + '<http://dkg.io/ontology/accessPolicy> "allowList" ; '
          + '<http://dkg.io/ontology/allowedPeer> "12D3KooWReader" } }',
      )).resolves.toMatchObject({ type: 'boolean', value: true });
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers a late-publisher rearm after restart without another gossip delivery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-late-publisher-crash-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const { message } = await stageGraph();
      const finalization = {
        ...message,
        accessPolicy: 'allowList' as const,
        allowedPeers: ['12D3KooWReader'],
      };
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => finalization.kcMerkleRoot,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () => canonicalReceipt(finalization),
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const recoveringHandler = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox),
      );
      const wire = encodeFinalizationMessage(finalization);
      const metaGraph = `did:dkg:context-graph:${CG}/_meta`;

      await recoveringHandler.handleFinalizationMessage(
        wire,
        CG,
        '12D3KooWUntrustedRelay',
      );
      const replaceGraphAndSubject = store.replaceGraphAndSubject?.bind(store);
      if (!replaceGraphAndSubject) {
        throw new Error('Oxigraph replaceGraphAndSubject unavailable');
      }
      store.replaceGraphAndSubject = async () => {
        throw new StoreSchedulerBusyError(
          'queue_wait_timeout',
          'normal',
          'sparql-http.update',
        );
      };
      await recoveringHandler.handleFinalizationMessage(
        wire,
        CG,
        '12D3KooWPublisher',
      );
      store.replaceGraphAndSubject = replaceGraphAndSubject;

      expect(await inbox.list()).toMatchObject([{
        state: 'VERIFIED',
        generation: 1,
        sourcePeerId: '12D3KooWUntrustedRelay',
        trustedPublisherPeerId: '12D3KooWPublisher',
        verifiedEvidence: {
          accessPolicy: 'allowList',
          allowedPeers: ['12D3KooWReader'],
        },
      }]);
      await expect(store.query(
        `ASK { GRAPH <${metaGraph}> { <${UAL}> `
          + '<http://dkg.io/ontology/accessPolicy> "ownerOnly" } }',
      )).resolves.toMatchObject({ type: 'boolean', value: true });
      await expect(store.query(
        `ASK { GRAPH <${metaGraph}> { <${UAL}> `
          + '<http://dkg.io/ontology/allowedPeer> "12D3KooWReader" } }',
      )).resolves.toMatchObject({ type: 'boolean', value: false });

      await inbox.close();
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const restartedHandler = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox),
      );
      await expect(restartedHandler.handleChainReconciledKC({
        contextGraphId: CG,
        onChainCgId: '42',
        ual: UAL,
        merkleRoot: finalization.kcMerkleRoot,
        publisherAddress: PUBLISHER,
        kaId: PACKED_KA_ID,
        versionBlock: 123,
        authorAddress: AUTHOR,
      }, createOperationContext('system'))).resolves.toBe('already-confirmed');
      expect(await inbox.list()).toMatchObject([{
        state: 'SETTLED',
        generation: 1,
        trustedPublisherPeerId: '12D3KooWPublisher',
        verifiedEvidence: {
          accessPolicy: 'allowList',
          allowedPeers: ['12D3KooWReader'],
        },
      }]);
      await expect(store.query(
        `ASK { GRAPH <${metaGraph}> { <${UAL}> `
          + '<http://dkg.io/ontology/accessPolicy> "allowList" ; '
          + '<http://dkg.io/ontology/allowedPeer> "12D3KooWReader" } }',
      )).resolves.toMatchObject({ type: 'boolean', value: true });
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the old VM graph and remains retryable when the atomic swap fails', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    await store.insert([{
      subject: UAL,
      predicate: 'urn:test:old-metadata',
      object: '"preserved"',
      graph: metaGraph,
    }]);
    const replaceGraphAndSubject = store.replaceGraphAndSubject?.bind(store);
    if (!replaceGraphAndSubject) throw new Error('Oxigraph replaceGraphAndSubject unavailable');
    store.replaceGraphAndSubject = async (graphUri, quads, metadataGraph, subject, metadata, options) => {
      if (graphUri === vmGraph) throw new Error('injected graph finalization failure');
      return replaceGraphAndSubject(graphUri, quads, metadataGraph, subject, metadata, options);
    };

    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    expect(await store.countQuads(vmGraph)).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(2);
    await expect(store.query(
      `ASK { GRAPH <${metaGraph}> { <${UAL}> <urn:test:old-metadata> "preserved" } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: true });

    store.replaceGraphAndSubject = replaceGraphAndSubject;
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(2);
    await expect(store.query(
      `ASK { GRAPH <${metaGraph}> { <${UAL}> <http://dkg.io/ontology/transactionHash> "${message.txHash}" } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: true });
  });

  it('resolves an omitted graph-scoped target context graph id by packed KA id', async () => {
    const { message, vmGraph } = await stageGraph();
    const chainLookups: bigint[] = [];
    let localTopicResolverCalls = 0;
    const resolvingHandler = new FinalizationHandler(store, legacyFinalizationChain(4, {
      getKAContextGraphId: async (kaId) => {
        chainLookups.push(kaId);
        return 42n;
      },
    }), {
      resolveContextGraphOnChainId: async () => {
        localTopicResolverCalls += 1;
        return '99';
      },
    });
    await resolvingHandler.handleFinalizationMessage(
      encodeFinalizationMessage({
        ...message,
        batchId: 42n,
        targetContextGraphId: undefined,
      }),
      CG,
    );

    expect(chainLookups).toEqual([PACKED_KA_ID]);
    expect(localTopicResolverCalls).toBe(1);
    expect(await store.countQuads(vmGraph)).toBe(2);
    await expect(store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> { `
        + `<${UAL}> <http://dkg.io/ontology/transactionHash> "${message.txHash}" } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: true });
  });

  it('keeps the legacy live-path transaction-index fallback without an inbox', async () => {
    const { message, vmGraph } = await stageGraph();
    const liveHandler = new FinalizationHandler(store, legacyFinalizationChain(null));

    await liveHandler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    expect(await store.countQuads(vmGraph)).toBe(2);
    await expect(store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> { `
        + `<${UAL}> <http://dkg.io/ontology/materializedVersion> "123:0" } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: true });
  });

  it('falls back to legacy live verification when canonical receipts are unsupported', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-unsupported-live-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const { message, vmGraph } = await stageGraph();
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const legacyChain = {
        chainId: 'legacy:1',
        isV10Ready: () => true,
        listenForEvents: async function* (filter: { eventTypes: string[] }) {
          if (
            !filter.eventTypes.includes('KCCreated')
            && !filter.eventTypes.includes('KnowledgeBatchCreated')
          ) return;
          yield {
            blockNumber: Number(message.blockNumber),
            data: {
              txHash: message.txHash,
              merkleRoot: message.kcMerkleRoot,
              publisherAddress: message.publisherAddress,
              startKAId: PACKED_KA_ID.toString(),
              endKAId: PACKED_KA_ID.toString(),
              author: AUTHOR,
              txIndex: 4,
            },
          };
        },
      } as unknown as ChainAdapter;
      const liveHandler = new FinalizationHandler(store, legacyChain, {
        ...recoveryOptions(inbox),
      });

      await liveHandler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

      expect(await inbox.list()).toEqual([]);
      expect(await store.countQuads(vmGraph)).toBe(2);
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('applies after one transient scheduler timeout without journaling', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-'));
    const query = store.query.bind(store);
    try {
      const { message, vmGraph } = await stageGraph();
      const retryingHandler = new FinalizationHandler(store, legacyFinalizationChain());
      let busyReads = 1;
      store.query = async (sparql, options) => {
        if (busyReads > 0) {
          busyReads -= 1;
          throw new StoreSchedulerBusyError(
            'queue_wait_timeout',
            'normal',
            'sparql-http.query',
          );
        }
        return query(sparql, options);
      };

      await retryingHandler.handleFinalizationMessage(
        encodeFinalizationMessage(message),
        CG,
        '12D3KooWPublisher',
      );

      expect(busyReads).toBe(0);
      expect(await store.countQuads(vmGraph)).toBe(2);
    } finally {
      store.query = query;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers adapter-batch provenance after a pre-verification store timeout and restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const staged = await stageGraph();
      const message = { ...staged.message, batchId: 42n };
      const { vmGraph } = staged;
      const wire = encodeFinalizationMessage(message);
      let currentRootCount = 0n;
      let receiptVerified = false;
      let receiptTxIndex: number | undefined;
      let verifyCalls = 0;
      const contextGraphBindingLookups: bigint[] = [];
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => message.kcMerkleRoot,
        getMerkleRootCount: async () => currentRootCount,
        getKAContextGraphId: async (kaId: bigint) => {
          contextGraphBindingLookups.push(kaId);
          return kaId === PACKED_KA_ID ? 42n : 43n;
        },
        resolveCanonicalFinalizationReceipt: async () => {
          verifyCalls += 1;
          return receiptVerified && receiptTxIndex !== undefined
            ? canonicalReceipt(message, receiptTxIndex)
            : { status: 'pending' as const };
        },
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const pressured = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox),
      );

      const query = store.query.bind(store);
      let busyReads = 2;
      store.query = async (sparql, options) => {
        if (busyReads > 0) {
          busyReads -= 1;
          throw new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'sparql-http.query');
        }
        return query(sparql, options);
      };
      await pressured.handleFinalizationMessage(wire, CG, '12D3KooWPublisher');
      expect(await inbox.list()).toMatchObject([{
        state: 'RECEIVED',
        attemptCount: 1,
        lastError: 'store scheduler remained busy',
        sourcePeerId: '12D3KooWPublisher',
        txHash: message.txHash,
        kaId: PACKED_KA_ID.toString(),
        batchId: '42',
      }]);
      store.query = query;

      await inbox.close();
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const restarted = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox),
      );
      const internals = restarted as unknown as {
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
        versionBlock: 123,
        authorAddress: AUTHOR,
      };
      await expect(restarted.handleChainReconciledKC(
        reconcileInput,
        createOperationContext('system'),
      )).resolves.toBe('verified-vm-metadata-pending');
      expect(await inbox.list()).toHaveLength(1);

      currentRootCount = 1n;
      await expect(restarted.handleChainReconciledKC(
        reconcileInput,
        createOperationContext('system'),
      )).resolves.toBe('verified-vm-metadata-pending');
      expect(verifyCalls).toBe(1);
      expect(await inbox.list()).toMatchObject([{ state: 'RECEIVED' }]);
      expect(await store.countQuads(vmGraph)).toBe(1);

      receiptVerified = true;
      await expect(restarted.handleChainReconciledKC(
        reconcileInput,
        createOperationContext('system'),
      )).resolves.toBe('verified-vm-metadata-pending');
      expect(await inbox.list()).toMatchObject([{ state: 'RECEIVED' }]);
      expect(await store.countQuads(vmGraph)).toBe(1);

      receiptTxIndex = 4;
      const replaceGraphAndSubject = store.replaceGraphAndSubject?.bind(store);
      if (!replaceGraphAndSubject) throw new Error('Oxigraph replaceGraphAndSubject unavailable');
      store.replaceGraphAndSubject = async () => {
        throw new StoreSchedulerBusyError(
          'queue_wait_timeout',
          'normal',
          'sparql-http.update',
        );
      };
      await expect(restarted.handleChainReconciledKC(
        reconcileInput,
        createOperationContext('system'),
      )).resolves.toBe('verified-vm-metadata-pending');
      expect(await inbox.list()).toMatchObject([{ state: 'VERIFIED' }]);
      expect(await store.countQuads(vmGraph)).toBe(1);

      store.replaceGraphAndSubject = replaceGraphAndSubject;
      await expect(restarted.handleChainReconciledKC(
        reconcileInput,
        createOperationContext('system'),
      )).resolves.toBe('already-confirmed');
      expect(await store.countQuads(vmGraph)).toBe(2);
      expect(await inbox.list()).toMatchObject([{ state: 'SETTLED' }]);
      expect(contextGraphBindingLookups.length).toBeGreaterThan(0);
      expect(contextGraphBindingLookups.every((kaId) => kaId === PACKED_KA_ID)).toBe(true);
      await expect(store.query(
        `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> { <${UAL}> `
          + `<http://dkg.io/ontology/transactionHash> "${message.txHash}" ; `
          + '<http://dkg.io/ontology/materializedVersion> "123:4" . } }',
      )).resolves.toMatchObject({ type: 'boolean', value: true });
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('autonomously drains a persisted busy finalization after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-worker-restart-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    let restarted: FinalizationHandler | undefined;
    const query = store.query.bind(store);
    try {
      const { message, vmGraph } = await stageGraph();
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => message.kcMerkleRoot,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () => canonicalReceipt(message),
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory, {
        maxPerContextGraph: 1,
      });
      const pressured = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox),
      );
      let busyReads = 2;
      store.query = async (sparql, options) => {
        if (busyReads > 0) {
          busyReads -= 1;
          throw new StoreSchedulerBusyError(
            'queue_wait_timeout',
            'normal',
            'autonomous-finalization-recovery.query',
          );
        }
        return query(sparql, options);
      };

      await pressured.handleFinalizationMessage(
        encodeFinalizationMessage(message),
        CG,
        '12D3KooWPublisher',
      );
      expect(await inbox.list()).toMatchObject([{
        state: 'RECEIVED',
        attemptCount: 1,
        lastError: 'store scheduler remained busy',
      }]);
      expect(await inbox.health()).toMatchObject({
        ready: false,
        degradedReason: 'capacity-exhausted',
      });

      store.query = query;
      await inbox.close();
      inbox = await openSqliteFinalizationRecoveryStore(directory, {
        maxPerContextGraph: 1,
      });
      restarted = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox),
      );
      restarted.startRecoveryWorker();

      await vi.waitFor(async () => {
        expect(await inbox!.list()).toMatchObject([{ state: 'SETTLED' }]);
      });
      expect(await store.countQuads(vmGraph)).toBe(2);
      const health = await inbox.health();
      expect(health.ready).toBe(true);
      expect(health).not.toHaveProperty('degradedReason');
    } finally {
      store.query = query;
      await restarted?.stopRecoveryWorker();
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('promotes a durably deferred finalization after live inbox capacity clears', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-deferred-capacity-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    let recoveryHandler: FinalizationHandler | undefined;
    try {
      const { message, vmGraph } = await stageGraph();
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => message.kcMerkleRoot,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () => canonicalReceipt(message),
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory, {
        maxEntries: 1,
        maxPerPeer: 1,
        maxPerContextGraph: 1,
      });
      const fillerKey = 'capacity-filler';
      await expect(inbox.receive({
        key: fillerKey,
        chainId: 'base:84532',
        contextGraphId: CG,
        sourcePeerId: '12D3KooWFiller',
        ual: `did:dkg:otp:20430/${AUTHOR}/999`,
        txHash: `0x${'ef'.repeat(32)}`,
        assertionVersion: '1',
        merkleRoot: `0x${'12'.repeat(32)}`,
        kaId: '999',
        batchId: '999',
        targetContextGraphId: '42',
        rawMessage: new Uint8Array([1]),
      })).resolves.toMatchObject({ status: 'inserted' });

      recoveryHandler = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox),
      );
      await recoveryHandler.handleFinalizationMessage(
        encodeFinalizationMessage(message),
        CG,
        '12D3KooWPublisher',
      );

      expect(await store.countQuads(vmGraph)).toBe(1);
      expect(await inbox.health()).toMatchObject({
        deferredEntries: 1,
        dueEntries: 1,
      });
      await expect(inbox.transition(fillerKey, 0, 'SUPERSEDED')).resolves.toBe(true);

      recoveryHandler.startRecoveryWorker();
      await vi.waitFor(async () => {
        expect(await inbox!.list()).toMatchObject([
          { key: fillerKey, state: 'SUPERSEDED' },
          { state: 'SETTLED', ual: UAL },
        ]);
        expect(await inbox!.health()).toMatchObject({ deferredEntries: 0 });
      });
      expect(await store.countQuads(vmGraph)).toBe(2);
    } finally {
      await recoveryHandler?.stopRecoveryWorker();
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not mutate Oxigraph when the VERIFIED transaction cannot commit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const { message, vmGraph } = await stageGraph();
      const chain = {
        chainId: 'base:84532',
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () => canonicalReceipt(message),
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const failingVerifiedStore: FinalizationRecoveryStore = {
        get closed() { return inbox!.closed; },
        get: inbox.get.bind(inbox),
        receive: inbox.receive.bind(inbox),
        promotePending: inbox.promotePending.bind(inbox),
        recordPendingTrustedPublisher:
          inbox.recordPendingTrustedPublisher.bind(inbox),
        recordTrustedPublisher: inbox.recordTrustedPublisher.bind(inbox),
        recordSettledPublisherUpgrade:
          inbox.recordSettledPublisherUpgrade.bind(inbox),
        rearmSettledWithTrustedPublisher:
          inbox.rearmSettledWithTrustedPublisher.bind(inbox),
        commitVerifiedEvidence: async () => ({ status: 'closed' }),
        markReorged: inbox.markReorged.bind(inbox),
        clearSettledRetry: inbox.clearSettledRetry.bind(inbox),
        rejectSettled: inbox.rejectSettled.bind(inbox),
        isAttemptDue: inbox.isAttemptDue.bind(inbox),
        listDue: inbox.listDue.bind(inbox),
        listForKnowledgeAsset: inbox.listForKnowledgeAsset.bind(inbox),
        transition: inbox.transition.bind(inbox),
        recordAttempt: inbox.recordAttempt.bind(inbox),
        health: inbox.health.bind(inbox),
        close: inbox.close.bind(inbox),
      };
      const recoveryHandler = new FinalizationHandler(store, chain, {
        ...recoveryOptions(failingVerifiedStore),
      });
      const createGraph = store.createGraph.bind(store);
      let createGraphCalls = 0;
      store.createGraph = async (graphUri) => {
        createGraphCalls += 1;
        return createGraph(graphUri);
      };
      const internals = recoveryHandler as unknown as {
        verifyChainCgBinding: () => Promise<boolean>;
      };
      internals.verifyChainCgBinding = async () => true;

      try {
        await recoveryHandler.handleFinalizationMessage(
          encodeFinalizationMessage(message),
          CG,
          '12D3KooWPublisher',
        );
      } finally {
        store.createGraph = createGraph;
      }

      expect(createGraphCalls).toBe(0);
      expect(await store.countQuads(vmGraph)).toBe(1);
      expect(await inbox.list()).toMatchObject([{
        state: 'RECEIVED',
        attemptCount: 1,
      }]);
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['capacity', 'write-failure'] as const)(
    'fails closed at the handler boundary when inbox admission reports %s',
    async (failureMode) => {
      const { message, vmGraph } = await stageGraph();
      let canonicalReceiptCalls = 0;
      let contextGraphBindingCalls = 0;
      const chain = {
        chainId: 'base:84532',
        getKAContextGraphId: async () => {
          contextGraphBindingCalls += 1;
          return 42n;
        },
        resolveCanonicalFinalizationReceipt: async () => {
          canonicalReceiptCalls += 1;
          return canonicalReceipt(message);
        },
      } as ChainAdapter;
      const rejectedStore: FinalizationRecoveryStore = {
        closed: false,
        get: async () => undefined,
        receive: async () => {
          if (failureMode === 'write-failure') throw new Error('disk full');
          return { status: 'capacity' };
        },
        promotePending: async () => 0,
        recordPendingTrustedPublisher: async () => {
          throw new Error('recordPendingTrustedPublisher must not run after failed admission');
        },
        recordTrustedPublisher: async () => {
          throw new Error('recordTrustedPublisher must not run after failed admission');
        },
        recordSettledPublisherUpgrade: async () => {
          throw new Error('recordSettledPublisherUpgrade must not run after failed admission');
        },
        rearmSettledWithTrustedPublisher: async () => {
          throw new Error('rearmSettledWithTrustedPublisher must not run after failed admission');
        },
        commitVerifiedEvidence: async () => {
          throw new Error('commitVerifiedEvidence must not run after failed admission');
        },
        markReorged: async () => false,
        clearSettledRetry: async () => {},
        rejectSettled: async () => false,
        isAttemptDue: () => true,
        listDue: async () => [],
        listForKnowledgeAsset: async () => [],
        transition: async () => false,
        recordAttempt: async () => {},
        health: async () => ({
          available: true,
          closed: false,
          stateCounts: {},
          livePayloadBytes: 0,
          dueEntries: 0,
        }),
        close: async () => {},
      };
      const recoveryHandler = new FinalizationHandler(store, chain, {
        ...recoveryOptions(rejectedStore),
      });
      const query = store.query.bind(store);
      let materializationReads = 0;
      store.query = async (sparql, options) => {
        materializationReads += 1;
        return query(sparql, options);
      };
      try {
        const handling = recoveryHandler.handleFinalizationMessage(
          encodeFinalizationMessage(message),
          CG,
          '12D3KooWPublisher',
        );
        if (failureMode === 'capacity') {
          await expect(handling).rejects.toMatchObject({
            code: 'FINALIZATION_RECOVERY_CAPACITY',
            retryable: true,
          });
        } else {
          await expect(handling).resolves.toBeUndefined();
        }
      } finally {
        store.query = query;
      }

      expect(materializationReads).toBe(0);
      expect(canonicalReceiptCalls).toBe(0);
      expect(contextGraphBindingCalls).toBe(0);
      expect(await store.countQuads(vmGraph)).toBe(1);
    },
  );

  it('requires the canonical KA-to-context-graph binding before materialization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-binding-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const { message, vmGraph } = await stageGraph();
      let boundContextGraphId = 43n;
      const chain = {
        chainId: 'base:84532',
        getKAContextGraphId: async (kaId: bigint) => {
          expect(kaId).toBe(PACKED_KA_ID);
          return boundContextGraphId;
        },
        resolveCanonicalFinalizationReceipt: async () => canonicalReceipt(message),
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const recoveryHandler = new FinalizationHandler(store, chain, {
        ...recoveryOptions(inbox),
      });

      await recoveryHandler.handleFinalizationMessage(
        encodeFinalizationMessage(message),
        CG,
        '12D3KooWPublisher',
      );

      expect(await store.countQuads(vmGraph)).toBe(1);
      expect(await inbox.list()).toMatchObject([{
        state: 'RECEIVED',
        attemptCount: 1,
        lastError: 'finalization processing deferred',
      }]);

      boundContextGraphId = 42n;
      await recoveryHandler.handleFinalizationMessage(
        encodeFinalizationMessage(message),
        CG,
        '12D3KooWPublisher',
      );

      expect(await store.countQuads(vmGraph)).toBe(2);
      expect(await inbox.list()).toMatchObject([{ state: 'SETTLED' }]);
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('requires local topic, wire target, and canonical KA binding to agree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-topic-binding-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const { message, vmGraph } = await stageGraph();
      const replayedMessage = {
        ...message,
        targetContextGraphId: '43',
      };
      const chain = {
        chainId: 'base:84532',
        getKAContextGraphId: async (kaId: bigint) => {
          expect(kaId).toBe(PACKED_KA_ID);
          return 43n;
        },
        resolveCanonicalFinalizationReceipt: async () => canonicalReceipt(replayedMessage),
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const recoveryHandler = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox, '42'),
      );

      await recoveryHandler.handleFinalizationMessage(
        encodeFinalizationMessage(replayedMessage),
        CG,
        '12D3KooWPublisher',
      );

      expect(await store.countQuads(vmGraph)).toBe(1);
      expect(await inbox.list()).toMatchObject([{
        state: 'RECEIVED',
        attemptCount: 1,
        lastError: 'finalization processing deferred',
      }]);
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains a terminal recovery record after chain truth supersedes it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const { message, vmGraph } = await stageGraph();
      let latestRoot = message.kcMerkleRoot;
      let rootCount = 1n;
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => latestRoot,
        getMerkleRootCount: async () => rootCount,
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () => canonicalReceipt(message),
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const recoveryHandler = new FinalizationHandler(store, chain, recoveryOptions(inbox));
      const internals = recoveryHandler as unknown as {
        verifyChainCgBinding: () => Promise<boolean>;
      };
      internals.verifyChainCgBinding = async () => true;

      const replaceGraphAndSubject = store.replaceGraphAndSubject?.bind(store);
      if (!replaceGraphAndSubject) throw new Error('Oxigraph replaceGraphAndSubject unavailable');
      store.replaceGraphAndSubject = async () => {
        throw new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'sparql-http.update');
      };
      await recoveryHandler.handleFinalizationMessage(
        encodeFinalizationMessage(message),
        CG,
        '12D3KooWPublisher',
      );
      store.replaceGraphAndSubject = replaceGraphAndSubject;
      expect(await inbox.list()).toMatchObject([{ state: 'VERIFIED' }]);

      latestRoot = Uint8Array.from(message.kcMerkleRoot, (byte) => byte ^ 0xff);
      rootCount = 2n;
      await recoveryHandler.handleChainReconciledKC({
        contextGraphId: CG,
        onChainCgId: '42',
        ual: UAL,
        merkleRoot: latestRoot,
        publisherAddress: PUBLISHER,
        kaId: PACKED_KA_ID,
        versionBlock: 124,
        authorAddress: AUTHOR,
      }, createOperationContext('system'));

      expect(await inbox.list()).toMatchObject([{ state: 'SUPERSEDED' }]);
      expect(await store.countQuads(vmGraph)).toBe(1);
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('repairs verified metadata after a newer SWM assertion replaces the mutable head', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const { message, swmGraph, vmGraph } = await stageGraph();
      const staged = await store.query(
        `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`,
      );
      if (staged.type !== 'quads') throw new Error('expected staged graph-scoped quads');
      await store.dropGraph(vmGraph);
      await store.insert(staged.quads.map((quad) => ({ ...quad, graph: vmGraph })));

      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => message.kcMerkleRoot,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () => canonicalReceipt(message),
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const recoveryHandler = new FinalizationHandler(store, chain, recoveryOptions(inbox));
      const internals = recoveryHandler as unknown as {
        verifyChainCgBinding: () => Promise<boolean>;
      };
      internals.verifyChainCgBinding = async () => true;

      const replaceGraphAndSubject = store.replaceGraphAndSubject?.bind(store);
      if (!replaceGraphAndSubject) throw new Error('Oxigraph replaceGraphAndSubject unavailable');
      store.replaceGraphAndSubject = async () => {
        throw new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'sparql-http.update');
      };
      await recoveryHandler.handleFinalizationMessage(
        encodeFinalizationMessage(message),
        CG,
        '12D3KooWPublisher',
      );
      store.replaceGraphAndSubject = replaceGraphAndSubject;
      expect(await inbox.list()).toMatchObject([{
        state: 'VERIFIED',
        verifiedEvidence: {
          assertionVersion: '1',
          transactionHash: message.txHash,
          blockHash: RECOVERY_BLOCK_HASH,
          txIndex: 4,
        },
      }]);

      await stageNewerWorkspaceAssertion(
        swmGraph,
        message.privateMerkleRoot,
        message.privateTripleCount,
      );
      await expect(recoveryHandler.handleChainReconciledKC({
        contextGraphId: CG,
        onChainCgId: '42',
        ual: UAL,
        merkleRoot: message.kcMerkleRoot,
        publisherAddress: PUBLISHER,
        kaId: PACKED_KA_ID,
        versionBlock: 999,
        authorAddress: AUTHOR,
      }, createOperationContext('system'))).resolves.toBe('already-confirmed');

      expect(await inbox.list()).toMatchObject([{ state: 'SETTLED' }]);
      const currentHead = await resolveKnowledgeAssetWorkspaceHead({
        store,
        graphManager,
        contextGraphId: CG,
        kaUal: UAL,
      });
      expect(currentHead?.assertionVersion).toBe('2');
      await expect(store.query(
        `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> { <${UAL}> `
          + `<http://dkg.io/ontology/transactionHash> "${message.txHash}" ; `
          + '<http://dkg.io/ontology/materializedVersion> "123:4" . } }',
      )).resolves.toMatchObject({ type: 'boolean', value: true });
      await expect(store.query(
        `ASK { GRAPH <${swmGraph}> { <urn:asset:newer-unpublished> `
          + '<urn:predicate:value> "newer" } }',
      )).resolves.toMatchObject({ type: 'boolean', value: true });
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['a later block', 124],
    ['a same-height replacement block', 123],
  ] as const)(
    'recovers a durable reorg without another gossip envelope when re-included in %s',
    async (_case, replacementBlockNumber) => {
      const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-'));
      let inbox: SqliteFinalizationRecoveryStore | undefined;
      try {
        const { message } = await stageGraph();
        const replacementBlockHash = `0x${'ef'.repeat(32)}`;
        const reIncludedMessage = {
          ...message,
          blockNumber: replacementBlockNumber,
        };
        let receiptPhase: 'block-a' | 'block-b' = 'block-a';
        let receiptChecks = 0;
        let replayCheckedPersistedIdentity = false;
        let replacementCheckedWithoutStaleIdentity = false;
        const chain = {
          chainId: 'base:84532',
          getLatestMerkleRoot: async () => message.kcMerkleRoot,
          getMerkleRootCount: async () => 1n,
          getKAContextGraphId: async () => 42n,
          resolveCanonicalFinalizationReceipt: async (_txHash, expected = {}) => {
            receiptChecks += 1;
            if (receiptPhase === 'block-a') return canonicalReceipt(message);
            if (
              expected.expectedBlockHash === RECOVERY_BLOCK_HASH
              && expected.expectedBlockNumber === Number(message.blockNumber)
            ) {
              replayCheckedPersistedIdentity = expected.expectedBlockHash
                === RECOVERY_BLOCK_HASH
                && expected.expectedBlockNumber === Number(message.blockNumber);
              return { status: 'reorged' as const };
            }
            replacementCheckedWithoutStaleIdentity = expected.expectedBlockHash === undefined
              && expected.expectedBlockNumber === undefined;
            if (!replacementCheckedWithoutStaleIdentity) {
              return { status: 'reorged' as const };
            }
            return canonicalReceipt(reIncludedMessage, 4, replacementBlockHash);
          },
        } as ChainAdapter;
        inbox = await openSqliteFinalizationRecoveryStore(directory);
        const recoveryHandler = new FinalizationHandler(
          store,
          chain,
          recoveryOptions(inbox),
        );

        await recoveryHandler.handleFinalizationMessage(
          encodeFinalizationMessage(message),
          CG,
          '12D3KooWPublisher',
        );
        expect(await inbox.list()).toMatchObject([{
          state: 'SETTLED',
          generation: 0,
          verifiedEvidence: {
            blockNumber: Number(message.blockNumber),
            blockHash: RECOVERY_BLOCK_HASH,
          },
        }]);
        await expect(store.query(
          `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> { <${UAL}> `
            + `<http://dkg.io/ontology/transactionHash> "${message.txHash}" ; `
            + '<http://dkg.io/ontology/materializedVersion> "123:4" . } }',
        )).resolves.toMatchObject({ type: 'boolean', value: true });

        const reconcileInput = {
          contextGraphId: CG,
          onChainCgId: '42',
          ual: UAL,
          merkleRoot: message.kcMerkleRoot,
          publisherAddress: PUBLISHER,
          kaId: PACKED_KA_ID,
          versionBlock: 123,
          authorAddress: AUTHOR,
        };

        await inbox.close();
        inbox = await openSqliteFinalizationRecoveryStore(directory);
        const reopenedHandler = new FinalizationHandler(
          store,
          chain,
          recoveryOptions(inbox),
        );
        receiptPhase = 'block-b';
        await expect(reopenedHandler.handleChainReconciledKC(
          reconcileInput,
          createOperationContext('system'),
        )).resolves.toBe('already-confirmed');

        expect(receiptChecks).toBeGreaterThanOrEqual(3);
        expect(replayCheckedPersistedIdentity).toBe(true);
        expect(replacementCheckedWithoutStaleIdentity).toBe(true);
        expect(await inbox.list()).toMatchObject([{
          state: 'SETTLED',
          generation: 1,
          verifiedEvidence: {
            transactionHash: message.txHash,
            blockNumber: replacementBlockNumber,
            blockHash: replacementBlockHash,
          },
        }]);
        await expect(store.query(
          `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> { <${UAL}> `
            + `<http://dkg.io/ontology/transactionHash> "${message.txHash}" ; `
            + `<http://dkg.io/ontology/materializedVersion> `
            + `"${replacementBlockNumber}:4" . } }`,
        )).resolves.toMatchObject({ type: 'boolean', value: true });
      } finally {
        await closeInbox(inbox);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('repairs missing VM content before a SETTLED recovery row advances the watermark', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-settled-vm-repair-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const { message, vmGraph } = await stageGraph();
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => message.kcMerkleRoot,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () => canonicalReceipt(message),
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const recoveryHandler = new FinalizationHandler(store, chain, recoveryOptions(inbox));
      await recoveryHandler.handleFinalizationMessage(
        encodeFinalizationMessage(message),
        CG,
        '12D3KooWPublisher',
      );
      expect(await inbox.list()).toMatchObject([{ state: 'SETTLED' }]);
      expect(await store.countQuads(vmGraph)).toBe(2);

      await store.dropGraph(vmGraph);
      expect(await store.countQuads(vmGraph)).toBe(0);

      const persistedWatermarks: number[] = [];
      const cursor = createCursorState(0);
      const deps = recoveryReconciler(recoveryHandler, {
        contextGraphId: CG,
        onChainCgId: '42',
        ual: UAL,
        merkleRoot: message.kcMerkleRoot,
        publisherAddress: PUBLISHER,
        kaId: PACKED_KA_ID,
        versionBlock: 123,
        authorAddress: AUTHOR,
      }, persistedWatermarks);
      await expect(reconcileContextGraph(deps, cursor, CG, 42n)).resolves.toMatchObject({
        watermark: 1,
        reconciled: 1,
      });

      expect(persistedWatermarks).toEqual([1]);
      expect(await store.countQuads(vmGraph)).toBe(2);
      await expect(store.query(
        `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> { <${UAL}> `
          + '<http://dkg.io/ontology/status> "confirmed" ; '
          + `<http://dkg.io/ontology/transactionHash> "${message.txHash}" ; `
          + `<http://dkg.io/ontology/assertionGraph> <${vmGraph}> . } }`,
      )).resolves.toMatchObject({ type: 'boolean', value: true });
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('holds the production watermark until a SETTLED receipt retry is due and confirmed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-settled-pending-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      let now = 1_000;
      const { message, vmGraph } = await stageGraph();
      let receiptPhase: 'confirmed' | 'pending' = 'confirmed';
      let receiptChecks = 0;
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => message.kcMerkleRoot,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () => {
          receiptChecks += 1;
          return receiptPhase === 'confirmed'
            ? canonicalReceipt(message)
            : { status: 'pending' as const };
        },
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory, { now: () => now });
      const recoveryHandler = new FinalizationHandler(store, chain, recoveryOptions(inbox));
      await recoveryHandler.handleFinalizationMessage(
        encodeFinalizationMessage(message),
        CG,
        '12D3KooWPublisher',
      );
      expect(await inbox.list()).toMatchObject([{ state: 'SETTLED', attemptCount: 0 }]);

      receiptPhase = 'pending';
      const persistedWatermarks: number[] = [];
      const cursor = createCursorState(0);
      const deps = recoveryReconciler(recoveryHandler, {
        contextGraphId: CG,
        onChainCgId: '42',
        ual: UAL,
        merkleRoot: message.kcMerkleRoot,
        publisherAddress: PUBLISHER,
        kaId: PACKED_KA_ID,
        versionBlock: 123,
        authorAddress: AUTHOR,
      }, persistedWatermarks);

      await expect(reconcileContextGraph(deps, cursor, CG, 42n)).resolves.toMatchObject({
        watermark: 0,
        pending: 1,
      });
      const [deferred] = await inbox.list();
      expect(deferred).toMatchObject({ state: 'SETTLED', attemptCount: 1 });
      const checksBeforeBackoffSweep = receiptChecks;
      await expect(reconcileContextGraph(deps, cursor, CG, 42n)).resolves.toMatchObject({
        watermark: 0,
        pending: 1,
      });
      expect(receiptChecks).toBe(checksBeforeBackoffSweep);
      expect(persistedWatermarks).toEqual([]);

      now = deferred.nextAttemptAt!;
      receiptPhase = 'confirmed';
      await expect(reconcileContextGraph(deps, cursor, CG, 42n)).resolves.toMatchObject({
        watermark: 1,
        reconciled: 1,
      });
      expect(persistedWatermarks).toEqual([1]);
      expect(await inbox.list()).toMatchObject([{ state: 'SETTLED', attemptCount: 0 }]);
      expect(await store.countQuads(vmGraph)).toBe(2);
      await expect(store.query(
        `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> { <${UAL}> `
          + '<http://dkg.io/ontology/status> "confirmed" ; '
          + `<http://dkg.io/ontology/transactionHash> "${message.txHash}" ; `
          + `<http://dkg.io/ontology/assertionGraph> <${vmGraph}> . } }`,
      )).resolves.toMatchObject({ type: 'boolean', value: true });
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('drives bounded SETTLED not-found probes from production reconciliation sweeps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-settled-not-found-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      let now = 1_000;
      const { message, vmGraph } = await stageGraph();
      let missing = false;
      let receiptChecks = 0;
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => message.kcMerkleRoot,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () => {
          receiptChecks += 1;
          return missing
            ? { status: 'not-found' as const }
            : canonicalReceipt(message);
        },
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory, { now: () => now });
      const recoveryHandler = new FinalizationHandler(store, chain, recoveryOptions(inbox));
      await recoveryHandler.handleFinalizationMessage(
        encodeFinalizationMessage(message),
        CG,
        '12D3KooWPublisher',
      );

      missing = true;
      const persistedWatermarks: number[] = [];
      const cursor = createCursorState(0);
      const deps = recoveryReconciler(recoveryHandler, {
        contextGraphId: CG,
        onChainCgId: '42',
        ual: UAL,
        merkleRoot: message.kcMerkleRoot,
        publisherAddress: PUBLISHER,
        kaId: PACKED_KA_ID,
        versionBlock: 123,
        authorAddress: AUTHOR,
      }, persistedWatermarks);

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const sweep = await reconcileContextGraph(deps, cursor, CG, 42n);
        const [entry] = await inbox.list();
        if (attempt < 5) {
          expect(sweep).toMatchObject({ watermark: 0, pending: 1 });
          expect(entry).toMatchObject({
            state: 'SETTLED',
            attemptCount: attempt,
            lastError: 'settled canonical receipt is not-found',
          });
          now = entry.nextAttemptAt!;
        } else {
          expect(sweep).toMatchObject({ watermark: 0, pending: 1 });
          expect(entry).toMatchObject({
            state: 'REJECTED',
            attemptCount: 4,
            lastError: 'canonical receipt disappeared after bounded retries',
          });
        }
      }
      expect(receiptChecks).toBe(6);
      expect(persistedWatermarks).toEqual([]);
      expect(await store.countQuads(vmGraph)).toBe(0);
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the production ordinal pending after retracting a permanently rejected receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-rejected-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const { message, vmGraph } = await stageGraph();
      let rejected = false;
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => message.kcMerkleRoot,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () =>
          rejected ? { status: 'rejected' as const } : canonicalReceipt(message),
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const recoveryHandler = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox),
      );

      await recoveryHandler.handleFinalizationMessage(
        encodeFinalizationMessage(message),
        CG,
        '12D3KooWPublisher',
      );
      expect(await inbox.list()).toMatchObject([{ state: 'SETTLED' }]);
      expect(await store.countQuads(vmGraph)).toBe(2);

      rejected = true;
      const persistedWatermarks: number[] = [];
      const cursor = createCursorState(0);
      const deps = recoveryReconciler(recoveryHandler, {
        contextGraphId: CG,
        onChainCgId: '42',
        ual: UAL,
        merkleRoot: message.kcMerkleRoot,
        publisherAddress: PUBLISHER,
        kaId: PACKED_KA_ID,
        versionBlock: 123,
        authorAddress: AUTHOR,
      }, persistedWatermarks);
      await expect(reconcileContextGraph(deps, cursor, CG, 42n)).resolves.toMatchObject({
        watermark: 0,
        pending: 1,
      });

      expect(await inbox.list()).toMatchObject([{
        state: 'REJECTED',
        lastError: 'canonical receipt permanently rejected',
      }]);
      expect(await store.countQuads(vmGraph)).toBe(0);
      expect(persistedWatermarks).toEqual([]);
      await expect(store.query(
        `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> { <${UAL}> `
          + '<http://dkg.io/ontology/status> "confirmed" . } }',
      )).resolves.toMatchObject({ type: 'boolean', value: false });
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never persists structurally invalid or legacy envelopes under store pressure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const { message } = await stageGraph();
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const pressured = new FinalizationHandler(
        store,
        undefined,
        recoveryOptions(inbox),
      );
      await pressured.handleFinalizationMessage(encodeFinalizationMessage({
        ...message,
        startKAId: PACKED_KA_ID + 1n,
      }), CG);
      expect(await inbox.list()).toEqual([]);

      const query = store.query.bind(store);
      store.query = async () => {
        throw new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'sparql-http.query');
      };
      await expect(pressured.handleFinalizationMessage(encodeFinalizationMessage({
        ...message,
        contentScopeVersion: 0,
        rootEntities: ['urn:legacy:root'],
      }), CG)).rejects.toBeInstanceOf(StoreSchedulerBusyError);
      store.query = query;
      expect(await inbox.list()).toEqual([]);
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a scheduler timeout observable when durable recovery is unavailable', async () => {
    const { message } = await stageGraph();
    const pressured = new FinalizationHandler(store, undefined);
    const query = store.query.bind(store);
    store.query = async () => {
      throw new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'sparql-http.query');
    };

    await expect(pressured.handleFinalizationMessage(
      encodeFinalizationMessage(message),
      CG,
    )).rejects.toBeInstanceOf(StoreSchedulerBusyError);
    store.query = query;
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

  it('promotes exact public SWM from chain inventory without inventing transaction provenance', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    const publicHandler = makePublicReconcileHandler(message, {
      isContextGraphActiveOnChain: async (contextGraphId) => {
        expect(contextGraphId).toBe(42n);
        return true;
      },
      getContextGraphAccessPolicy: async (contextGraphId) => {
        expect(contextGraphId).toBe(42n);
        return 0;
      },
      getMerkleRootCount: async (kaId) => {
        expect(kaId).toBe(PACKED_KA_ID);
        return 1n;
      },
      getLatestMerkleRoot: async (kaId) => {
        expect(kaId).toBe(PACKED_KA_ID);
        return message.kcMerkleRoot;
      },
      getLatestMerkleRootAuthor: async (kaId) => {
        expect(kaId).toBe(PACKED_KA_ID);
        return AUTHOR;
      },
    });

    const outcome = await reconcileGraphScoped(publicHandler, message);

    expect(outcome).toBe('promoted');
    await expect(reconcileGraphScoped(publicHandler, message)).resolves.toBe('already-confirmed');
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(2);
    await expectGraphScopedMetadata(`
      <http://dkg.io/ontology/status> "confirmed" ;
      <http://dkg.io/ontology/accessPolicy> "public" ;
      <http://dkg.io/ontology/publisherPeerId> "chain-finalized-reconcile-v1" ;
      <http://dkg.io/ontology/confirmationKind> "finalized-materialization" ;
      <http://dkg.io/ontology/materializedVersion> "123:0" ;
      <http://www.w3.org/ns/prov#wasAttributedTo> <did:dkg:agent:${AUTHOR}> .
      FILTER NOT EXISTS { <${UAL}> <http://dkg.io/ontology/transactionHash> ?tx }
    `);
  });

  it('retires the exact SWM twin after receiptless public chain promotion', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    const writeLocks = new Map<string, Promise<void>>();
    const retire = vi.fn(async (candidate: { swmGraph: string }) => {
      await store.dropGraph(candidate.swmGraph);
    });
    const publicHandler = new FinalizationHandler(
      store,
      legacyFinalizationChain(4, {
        isContextGraphActiveOnChain: async () => true,
        getContextGraphAccessPolicy: async () => 0,
        getMerkleRootCount: async () => 1n,
        getLatestMerkleRoot: async () => message.kcMerkleRoot,
        getLatestMerkleRootAuthor: async () => AUTHOR,
      }),
      {
        reconcileConfirmedGraphScopedSwmTwin: async (evidence) => {
          const outcome = await reconcileFinalizedSwmTwinFromCatalogProjection({
            store,
            writeLocks,
            evidence,
            retire,
          });
          expect(outcome).toBe('retired');
        },
      },
    );
    const internals = publicHandler as unknown as {
      verifyChainCgBinding: () => Promise<boolean>;
      findSwmSnapshotForMerkleRoot?: () => Promise<never>;
    };
    internals.verifyChainCgBinding = async () => true;
    internals.findSwmSnapshotForMerkleRoot = async () => {
      throw new Error('legacy root scan must not run for graph-scoped SWM');
    };

    await expect(reconcileGraphScoped(publicHandler, message)).resolves.toBe('promoted');

    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(0);
    expect(retire).toHaveBeenCalledOnce();
  });

  it('promotes a later exact public SWM assertion when the chain version advances', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    let rootCount = 1n;
    let latestRoot = message.kcMerkleRoot;
    const publicHandler = makePublicReconcileHandler(message, {
      getMerkleRootCount: async () => rootCount,
      getLatestMerkleRoot: async () => latestRoot,
      getLatestMerkleRootAuthor: async () => AUTHOR,
    });

    await expect(reconcileGraphScoped(publicHandler, message)).resolves.toBe('promoted');

    await stageNewerWorkspaceAssertion(
      swmGraph,
      message.privateMerkleRoot,
      message.privateTripleCount,
    );
    const nextQuads: Quad[] = [{
      subject: 'urn:asset:newer-unpublished',
      predicate: 'urn:predicate:value',
      object: '"newer"',
      graph: '',
    }, {
      subject: 'urn:asset:newer-unpublished-two',
      predicate: 'urn:predicate:value',
      object: '"newer-two"',
      graph: '',
    }];
    latestRoot = computeFlatKCRootV10(
      nextQuads,
      message.privateMerkleRoot?.length ? [message.privateMerkleRoot] : [],
    );
    rootCount = 2n;

    const reconcileUpdate = {
      merkleRoot: latestRoot,
      versionBlock: 124,
    };
    await expect(reconcileGraphScoped(publicHandler, message, reconcileUpdate)).resolves.toBe('promoted');
    await expect(reconcileGraphScoped(publicHandler, message, reconcileUpdate)).resolves.toBe('already-confirmed');

    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(2);
    await expect(store.query(
      `ASK { GRAPH <${vmGraph}> { <urn:asset:newer-unpublished> `
        + '<urn:predicate:value> "newer" } }',
    )).resolves.toMatchObject({ type: 'boolean', value: true });
    await expect(store.query(
      `ASK { GRAPH <${vmGraph}> { <urn:asset:one> ?p ?o } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: false });
    await expectGraphScopedMetadata(`
      <http://dkg.io/ontology/assertionVersion> "2"^^<http://www.w3.org/2001/XMLSchema#integer> ;
      <http://dkg.io/ontology/status> "confirmed" ;
      <http://dkg.io/ontology/confirmationKind> "finalized-materialization" ;
      <http://dkg.io/ontology/materializedVersion> "124:0" .
      FILTER NOT EXISTS { <${UAL}> <http://dkg.io/ontology/transactionHash> ?tx }
    `);
  });

  it('repairs receiptless public metadata after exact VM content committed alone', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await retainExactContentOnlyInVm(swmGraph, vmGraph);

    const repairHandler = makePublicReconcileHandler(message, {
      getLatestMerkleRootAuthor: async () => AUTHOR,
    });

    await expect(reconcileGraphScoped(repairHandler, message)).resolves.toBe('already-confirmed');

    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(0);
    await expectGraphScopedMetadata(`
      <http://dkg.io/ontology/status> "confirmed" ;
      <http://dkg.io/ontology/accessPolicy> "public" ;
      <http://dkg.io/ontology/confirmationKind> "finalized-materialization" ;
      <http://dkg.io/ontology/materializedVersion> "123:0" .
      FILTER NOT EXISTS { <${UAL}> <http://dkg.io/ontology/transactionHash> ?tx }
    `);
  });

  it.each([
    {
      sourceLayer: 'SWM',
      stageExactVm: false,
      expectedOutcome: 'promoted',
      expectedSwmCount: 2,
    },
    {
      sourceLayer: 'VM',
      stageExactVm: true,
      expectedOutcome: 'already-confirmed',
      expectedSwmCount: 0,
    },
  ] as const)(
    'uses the shared receiptless public policy for exact $sourceLayer content',
    async ({ stageExactVm, expectedOutcome, expectedSwmCount }) => {
      const { message, swmGraph, vmGraph } = await stageGraph();
      if (stageExactVm) await retainExactContentOnlyInVm(swmGraph, vmGraph);
      const publicHandler = makePublicReconcileHandler(message, {
        getLatestMerkleRootAuthor: async () => AUTHOR,
      });

      await expect(reconcileGraphScoped(publicHandler, message)).resolves.toBe(expectedOutcome);

      expect(await store.countQuads(vmGraph)).toBe(2);
      expect(await store.countQuads(swmGraph)).toBe(expectedSwmCount);
      await expectGraphScopedMetadata(`
        <http://dkg.io/ontology/status> "confirmed" ;
        <http://dkg.io/ontology/accessPolicy> "public" ;
        <http://dkg.io/ontology/publisherPeerId> "chain-finalized-reconcile-v1" ;
        <http://dkg.io/ontology/confirmationKind> "finalized-materialization" ;
        <http://dkg.io/ontology/materializedVersion> "123:0" ;
        <http://www.w3.org/ns/prov#wasAttributedTo> <did:dkg:agent:${AUTHOR}> .
        FILTER NOT EXISTS { <${UAL}> <http://dkg.io/ontology/transactionHash> ?tx }
      `);
    },
  );

  it.each([
    { sourceLayer: 'SWM', stageExactVm: false, expectedVmCount: 1, expectedSwmCount: 2 },
    { sourceLayer: 'VM', stageExactVm: true, expectedVmCount: 2, expectedSwmCount: 0 },
  ] as const)(
    'fails closed before applying receiptless public $sourceLayer content when authority is unavailable',
    async ({ stageExactVm, expectedVmCount, expectedSwmCount }) => {
      const { message, swmGraph, vmGraph } = await stageGraph();
      if (stageExactVm) await retainExactContentOnlyInVm(swmGraph, vmGraph);
      const guardedHandler = makePublicReconcileHandler(message, {
        isContextGraphActiveOnChain: async () => false,
      });
      const internals = guardedHandler as unknown as {
        applyVerifiedGraphScopedFinalization: () => Promise<never>;
      };
      internals.applyVerifiedGraphScopedFinalization = async () => {
        throw new Error('receiptless apply must not run without public chain authority');
      };

      await expect(reconcileGraphScoped(guardedHandler, message))
        .resolves.toBe('verified-vm-metadata-pending');

      expect(await store.countQuads(vmGraph)).toBe(expectedVmCount);
      expect(await store.countQuads(swmGraph)).toBe(expectedSwmCount);
      await expectGraphScopedMetadata(
        '<http://dkg.io/ontology/status> "confirmed" .',
        false,
      );
    },
  );

  it('preserves one newer materialized version during stale receiptless metadata repair', async () => {
    const { message } = await stageGraph();
    const publicHandler = makePublicReconcileHandler(message);

    const reconcileInput = {
      versionBlock: 200,
    };
    await expect(reconcileGraphScoped(publicHandler, message, reconcileInput)).resolves.toBe('promoted');

    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    await store.deleteByPattern({
      graph: metaGraph,
      subject: UAL,
      predicate: 'http://dkg.io/ontology/accessPolicy',
    });
    await expect(reconcileGraphScoped(
      publicHandler,
      message,
      { ...reconcileInput, versionBlock: 123 },
    )).resolves.toBe('already-confirmed');

    const versions = await store.query(
      `SELECT ?version WHERE { GRAPH <${metaGraph}> {
        <${UAL}> <http://dkg.io/ontology/materializedVersion> ?version .
      } }`,
    );
    expect(versions.type).toBe('bindings');
    if (versions.type !== 'bindings') throw new Error('expected materialized-version bindings');
    expect(versions.bindings).toEqual([{ version: '"200:0"' }]);
  });

  it('keeps exact private SWM fail-closed without transaction provenance', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph({ accessPolicy: 'ownerOnly' });
    const privateHandler = makeReconcileHandler({
      isContextGraphActiveOnChain: async () => true,
      getContextGraphAccessPolicy: async () => 1,
      getMerkleRootCount: async () => 1n,
      getLatestMerkleRoot: async () => message.kcMerkleRoot,
    }, { forbidLegacyRootScan: true });

    await expect(reconcileGraphScoped(privateHandler, message))
      .resolves.toBe('verified-vm-metadata-pending');

    expect(await store.countQuads(vmGraph)).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(2);
  });

  it.each([
    { label: 'inactive context graph', active: false, rootCount: 1n, latestRootMatches: true },
    { label: 'assertion-version mismatch', active: true, rootCount: 2n, latestRootMatches: true },
    { label: 'latest-root mismatch', active: true, rootCount: 1n, latestRootMatches: false },
  ])('keeps exact public SWM fail-closed for $label', async ({
    active,
    rootCount,
    latestRootMatches,
  }) => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    const guardedHandler = makeReconcileHandler({
      isContextGraphActiveOnChain: async () => active,
      getContextGraphAccessPolicy: async () => 0,
      getMerkleRootCount: async () => rootCount,
      getLatestMerkleRoot: async () => latestRootMatches
        ? message.kcMerkleRoot
        : Uint8Array.from({ length: 32 }, () => 0x44),
    });

    await expect(reconcileGraphScoped(guardedHandler, message))
      .resolves.toBe('verified-vm-metadata-pending');

    expect(await store.countQuads(vmGraph)).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(2);
  });

  it('fails closed when a same-root chain update overlaps the public authority read', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    let rootCountReads = 0;
    const guardedHandler = makePublicReconcileHandler(message, {
      isContextGraphActiveOnChain: async () => true,
      getContextGraphAccessPolicy: async () => 0,
      getMerkleRootCount: async () => {
        rootCountReads += 1;
        return rootCountReads === 1 ? 1n : 2n;
      },
      getLatestMerkleRoot: async () => message.kcMerkleRoot,
    });

    await expect(reconcileGraphScoped(guardedHandler, message))
      .resolves.toBe('verified-vm-metadata-pending');

    expect(rootCountReads).toBe(2);
    expect(await store.countQuads(vmGraph)).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(2);
  });

  it('repairs legacy peer-materialized VM metadata without a confirmation kind', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph({ accessPolicy: 'ownerOnly' });
    await seedAuthenticatedLocalControls(message);
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    for (const predicate of [
      'http://dkg.io/ontology/accessPolicy',
      'http://dkg.io/ontology/publisherPeerId',
      'http://dkg.io/ontology/confirmationKind',
      'http://www.w3.org/ns/prov#wasAttributedTo',
    ]) {
      await store.deleteByPattern({ graph: metaGraph, subject: UAL, predicate });
    }

    let receiptReads = 0;
    const repairHandler = makeReconcileHandler({
      getMerkleRootCount: async () => 1n,
      resolveCanonicalFinalizationReceipt: async (transactionHash) => {
        receiptReads += 1;
        expect(transactionHash).toBe(message.txHash);
        return canonicalReceipt(message);
      },
    });

    await expect(reconcileGraphScoped(repairHandler, message, { versionBlock: 200 }))
      .resolves.toBe('already-confirmed');

    expect(receiptReads).toBe(1);
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(2);
    await expectGraphScopedMetadata(`
      <http://dkg.io/ontology/accessPolicy> "ownerOnly" ;
      <http://dkg.io/ontology/publisherPeerId> "12D3KooWPublisher" ;
      <http://dkg.io/ontology/confirmationKind> "transaction" ;
      <http://dkg.io/ontology/transactionHash> "${message.txHash}" ;
      <http://dkg.io/ontology/materializedVersion> "123:4" ;
      <http://www.w3.org/ns/prov#wasAttributedTo> <did:dkg:agent:${AUTHOR}> .
    `);
  });

  it('repairs private version-2 VM metadata from its chain-verified update receipt', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph({ accessPolicy: 'ownerOnly' });
    await stageNewerWorkspaceAssertion(
      swmGraph,
      message.privateMerkleRoot,
      message.privateTripleCount,
    );
    const staged = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`,
    );
    if (staged.type !== 'quads') throw new Error('expected staged version-2 SWM quads');
    const publicQuads = staged.quads.map((quad) => ({ ...quad, graph: '' }));
    const updateRoot = computeFlatKCRootV10(
      publicQuads,
      message.privateMerkleRoot ? [message.privateMerkleRoot] : [],
    );
    const updateTxHash = `0x${'ef'.repeat(32)}`;
    const updateBlockHash = `0x${'12'.repeat(32)}`;
    const updateMessage: FinalizationMessageMsg = {
      ...message,
      kcMerkleRoot: updateRoot,
      txHash: updateTxHash,
      blockNumber: 222,
      txIndex: 5,
      assertionVersion: '2',
      operationId: 'graph-finalization-update-op',
    };

    await seedAuthenticatedLocalControls(updateMessage);
    await store.dropGraph(vmGraph);
    await store.insert(publicQuads.map((quad) => ({ ...quad, graph: vmGraph })));
    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    await store.deleteByPattern({ graph: metaGraph, subject: UAL });
    await store.insert(generateGraphKnowledgeAssetMetadata({
      ual: UAL,
      contextGraphId: CG,
      merkleRoot: updateRoot,
      publisherPeerId: '12D3KooWPublisher',
      accessPolicy: 'ownerOnly',
      timestamp: new Date(),
      assertionVersion: '2',
      publicTripleCount: publicQuads.length,
      privateTripleCount: Number(message.privateTripleCount),
      ...(message.privateMerkleRoot?.length
        ? { privateMerkleRoot: message.privateMerkleRoot }
        : {}),
      assertionGraph: vmGraph,
      authorAddress: AUTHOR,
    }, {
      status: 'confirmed',
      confirmation: {
        kind: 'transaction',
        provenance: {
          txHash: updateTxHash,
          blockNumber: 222,
          blockTimestamp: 1_700_000_000,
          publisherAddress: PUBLISHER,
          batchId: PACKED_KA_ID,
          chainId: 'legacy:1',
        },
      },
    }));
    for (const predicate of [
      'http://dkg.io/ontology/accessPolicy',
      'http://dkg.io/ontology/publisherPeerId',
    ]) {
      await store.deleteByPattern({ graph: metaGraph, subject: UAL, predicate });
    }

    let updateReceiptReads = 0;
    const repairHandler = makeReconcileHandler({
      getMerkleRootCount: async () => 2n,
      verifyKAUpdate: async (transactionHash, kaId, publisherAddress) => {
        updateReceiptReads += 1;
        expect(transactionHash).toBe(updateTxHash);
        expect(kaId).toBe(PACKED_KA_ID);
        expect(publisherAddress).toBe(PUBLISHER);
        return {
          verified: true,
          onChainMerkleRoot: updateRoot,
          blockNumber: 222,
          blockHash: updateBlockHash,
          txIndex: 5,
          merkleRootCount: 2n,
        };
      },
    });

    await expect(reconcileGraphScoped(repairHandler, updateMessage, { versionBlock: 222 }))
      .resolves.toBe('already-confirmed');

    expect(updateReceiptReads).toBe(1);
    expect(await store.countQuads(vmGraph)).toBe(publicQuads.length);
    await expectGraphScopedMetadata(`
      <http://dkg.io/ontology/assertionVersion> "2"^^<http://www.w3.org/2001/XMLSchema#integer> ;
      <http://dkg.io/ontology/accessPolicy> "ownerOnly" ;
      <http://dkg.io/ontology/publisherPeerId> "12D3KooWPublisher" ;
      <http://dkg.io/ontology/confirmationKind> "transaction" ;
      <http://dkg.io/ontology/transactionHash> "${updateTxHash}" ;
      <http://dkg.io/ontology/materializedVersion> "222:5" .
    `);
  });

  it('does not trust peer-recovered workspace controls without an authenticated local sidecar', async () => {
    const { message, vmGraph } = await stageGraph({
      accessPolicy: 'allowList',
      allowedPeers: ['12D3KooWAttacker'],
    });
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    for (const predicate of [
      'http://dkg.io/ontology/accessPolicy',
      'http://dkg.io/ontology/allowedPeer',
      'http://dkg.io/ontology/publisherPeerId',
    ]) {
      await store.deleteByPattern({ graph: metaGraph, subject: UAL, predicate });
    }
    let accessPolicyReads = 0;
    const repairHandler = makeReconcileHandler({
      isContextGraphActiveOnChain: async (contextGraphId) => {
        expect(contextGraphId).toBe(42n);
        return true;
      },
      getMerkleRootCount: async () => 1n,
      resolveCanonicalFinalizationReceipt: async () => canonicalReceipt(message),
      getContextGraphAccessPolicy: async (contextGraphId) => {
        accessPolicyReads += 1;
        expect(contextGraphId).toBe(42n);
        return 1;
      },
    });

    await expect(reconcileGraphScoped(repairHandler, message, { versionBlock: 200 }))
      .resolves.toBe('verified-vm-metadata-pending');

    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(accessPolicyReads).toBe(1);
    await expectGraphScopedMetadata(
      '<http://dkg.io/ontology/allowedPeer> "12D3KooWAttacker" .',
      false,
    );
  });

  it('repairs public VM metadata from chain truth without a local SWM control sidecar', async () => {
    const { message, vmGraph } = await stageGraph({
      accessPolicy: 'allowList',
      allowedPeers: ['12D3KooWUntrustedWorkspacePeer'],
    });
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    for (const predicate of [
      'http://dkg.io/ontology/accessPolicy',
      'http://dkg.io/ontology/allowedPeer',
      'http://dkg.io/ontology/publisherPeerId',
    ]) {
      await store.deleteByPattern({ graph: metaGraph, subject: UAL, predicate });
    }
    let accessPolicyReads = 0;
    const repairHandler = makeReconcileHandler({
      isContextGraphActiveOnChain: async (contextGraphId) => {
        expect(contextGraphId).toBe(42n);
        return true;
      },
      getMerkleRootCount: async () => 1n,
      resolveCanonicalFinalizationReceipt: async () => canonicalReceipt(message),
      getContextGraphAccessPolicy: async (contextGraphId) => {
        accessPolicyReads += 1;
        expect(contextGraphId).toBe(42n);
        return 0;
      },
    });

    await expect(reconcileGraphScoped(repairHandler, message, { versionBlock: 200 }))
      .resolves.toBe('already-confirmed');

    expect(accessPolicyReads).toBe(1);
    expect(await store.countQuads(vmGraph)).toBe(2);
    await expectGraphScopedMetadata(`
      <http://dkg.io/ontology/accessPolicy> "public" ;
      <http://dkg.io/ontology/publisherPeerId> "unknown" ;
      <http://dkg.io/ontology/transactionHash> "${message.txHash}" .
    `);
    await expectGraphScopedMetadata(
      '<http://dkg.io/ontology/allowedPeer> "12D3KooWUntrustedWorkspacePeer" .',
      false,
    );
  });

  it.each([
    {
      label: 'missing a liveness reader',
      activeOnChain: undefined,
      onChainCgId: '42',
      expectedActiveReads: 0,
    },
    {
      label: 'inactive',
      activeOnChain: false,
      onChainCgId: '42',
      expectedActiveReads: 1,
    },
    {
      label: 'non-positive',
      activeOnChain: true,
      onChainCgId: '0',
      expectedActiveReads: 0,
    },
  ])('keeps public-policy fallback pending when the on-chain CG is $label', async ({
    activeOnChain,
    onChainCgId,
    expectedActiveReads,
  }) => {
    const { message, vmGraph } = await stageGraph({ accessPolicy: 'ownerOnly' });
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    for (const predicate of [
      'http://dkg.io/ontology/accessPolicy',
      'http://dkg.io/ontology/allowedPeer',
      'http://dkg.io/ontology/publisherPeerId',
    ]) {
      await store.deleteByPattern({ graph: metaGraph, subject: UAL, predicate });
    }
    let activeReads = 0;
    let accessPolicyReads = 0;
    const repairHandler = makeReconcileHandler({
      ...(activeOnChain === undefined ? {} : {
        isContextGraphActiveOnChain: async (contextGraphId) => {
          activeReads += 1;
          expect(contextGraphId).toBe(42n);
          return activeOnChain;
        },
      }),
      getMerkleRootCount: async () => 1n,
      resolveCanonicalFinalizationReceipt: async () => canonicalReceipt(message),
      getContextGraphAccessPolicy: async () => {
        accessPolicyReads += 1;
        return 0;
      },
    });

    await expect(reconcileGraphScoped(repairHandler, message, {
      onChainCgId,
      versionBlock: 200,
    })).resolves.toBe('verified-vm-metadata-pending');

    expect(activeReads).toBe(expectedActiveReads);
    expect(accessPolicyReads).toBe(0);
    expect(await store.countQuads(vmGraph)).toBe(2);
    await expectGraphScopedMetadata(
      '<http://dkg.io/ontology/accessPolicy> "public" .',
      false,
    );
  });

  it('does not repair peer-materialized VM metadata from a non-unique on-chain root', async () => {
    const { message, vmGraph } = await stageGraph({ accessPolicy: 'ownerOnly' });
    await seedAuthenticatedLocalControls(message);
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    await store.deleteByPattern({
      graph: metaGraph,
      subject: UAL,
      predicate: 'http://dkg.io/ontology/accessPolicy',
    });

    const repairHandler = makeReconcileHandler({
      getMerkleRootCount: async () => 2n,
      resolveCanonicalFinalizationReceipt: async () => canonicalReceipt(message),
    });

    await expect(reconcileGraphScoped(repairHandler, message, { versionBlock: 200 }))
      .resolves.toBe('verified-vm-metadata-pending');

    expect(await store.countQuads(vmGraph)).toBe(2);
    await expectGraphScopedMetadata(
      '<http://dkg.io/ontology/accessPolicy> ?policy .',
      false,
    );
  });

  it.each([
    'publisher',
    'merkle-root',
    'ka-id',
    'batch-id',
    'range-start',
    'range-end',
  ] as const)(
    'does not repair peer-materialized VM metadata when the receipt mismatches %s',
    async (mismatch) => {
      const { message } = await stageGraph({ accessPolicy: 'ownerOnly' });
      await seedAuthenticatedLocalControls(message);
      await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
      const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
      await store.deleteByPattern({
        graph: metaGraph,
        subject: UAL,
        predicate: 'http://dkg.io/ontology/accessPolicy',
      });

      const mismatched = canonicalReceipt(message);
      if (mismatched.status !== 'confirmed') throw new Error('expected confirmed receipt');
      if (mismatch === 'publisher') {
        mismatched.receipt.publisherAddress = '0x3333333333333333333333333333333333333333';
      } else if (mismatch === 'merkle-root') {
        mismatched.receipt.merkleRoot = Uint8Array.from({ length: 32 }, () => 0x44);
      } else if (mismatch === 'ka-id') {
        mismatched.receipt.kaId = PACKED_KA_ID + 1n;
      } else if (mismatch === 'batch-id') {
        mismatched.receipt.batchId = PACKED_KA_ID + 1n;
      } else if (mismatch === 'range-start') {
        mismatched.receipt.startKAId = PACKED_KA_ID + 1n;
      } else {
        mismatched.receipt.endKAId = PACKED_KA_ID + 1n;
      }
      const repairHandler = makeReconcileHandler({
        getMerkleRootCount: async () => 1n,
        resolveCanonicalFinalizationReceipt: async () => mismatched,
      });

      await expect(reconcileGraphScoped(repairHandler, message, { versionBlock: 200 }))
        .resolves.toBe('verified-vm-metadata-pending');
      await expectGraphScopedMetadata(
        '<http://dkg.io/ontology/accessPolicy> ?policy .',
        false,
      );
    },
  );

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

    await expect(handler.handleExactChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      batchId: PACKED_KA_ID,
      versionBlock: 123,
      authorAddress: AUTHOR,
    }, createOperationContext('system'))).resolves.toBe('already-confirmed');
    expect(bindingVerified).toBe(true);
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(2);
  });

  it('recognizes only exact confirmed Verifiable Memory metadata after the workspace head is lost', async () => {
    const staged = await stageGraph();
    const message = { ...staged.message, batchId: 42n };
    const { vmGraph } = staged;
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    await store.deleteByPattern({
      graph: graphManager.sharedMemoryMetaUri(CG),
      subject: `${UAL}#dkg-swm-head`,
    });
    await expect(resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
    })).resolves.toBeUndefined();

    const internals = handler as unknown as {
      verifyChainCgBinding: () => Promise<boolean>;
    };
    internals.verifyChainCgBinding = async () => true;

    await expect(handler.handleExactChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      batchId: 42n,
      versionBlock: 124,
      authorAddress: AUTHOR,
    }, createOperationContext('system'))).resolves.toBe('already-confirmed');

    expect(await store.countQuads(vmGraph)).toBe(2);

    const query = store.query.bind(store);
    store.query = async (sparql, options) => {
      if (sparql.includes('SELECT ?predicate ?object')) {
        throw new Error('injected confirmed metadata outage');
      }
      return query(sparql, options);
    };
    await expect(handler.handleChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      batchId: 42n,
      versionBlock: 125,
      authorAddress: AUTHOR,
    }, createOperationContext('system'))).rejects.toThrow('injected confirmed metadata outage');
    store.query = query;

    const vmResult = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`,
    );
    if (vmResult.type !== 'quads') throw new Error('expected finalized VM quads');
    await store.dropGraph(vmGraph);
    await store.insert(vmResult.quads.map((quad, index) => index === 0
      ? { ...quad, object: '"same-count-corruption"', graph: vmGraph }
      : { ...quad, graph: vmGraph }));

    await expect(handler.handleChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      batchId: 42n,
      versionBlock: 126,
      authorAddress: AUTHOR,
    }, createOperationContext('system'))).resolves.toBe('no-swm');
  });

  it('retires an orphaned exact-recovery SWM twin after confirming VM without a workspace head', async () => {
    const staged = await stageGraph();
    const message = { ...staged.message, batchId: 42n };
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    await store.deleteByPattern({
      graph: graphManager.sharedMemoryMetaUri(CG),
      subject: `${UAL}#dkg-swm-head`,
    });
    expect(await store.countQuads(staged.swmGraph)).toBe(2);

    const retire = vi.fn(async (candidate: {
      contextGraphId: string;
      ual: string;
      agentAddress: string;
      kaNumber: bigint;
      assertionVersion: bigint;
    }) => {
      expect(candidate).toMatchObject({
        contextGraphId: CG,
        ual: UAL,
        agentAddress: AUTHOR,
        kaNumber: 7n,
        assertionVersion: 1n,
      });
      await store.dropGraph(staged.swmGraph);
    });
    const recoveringHandler = new FinalizationHandler(
      store,
      legacyFinalizationChain(),
      {
        retireConfirmedGraphScopedSwmTwinIfOrphaned:
          createRetireConfirmedGraphScopedSwmTwinIfOrphaned({
            store,
            writeLocks: new Map(),
            retire,
          }),
      },
    );
    const internals = recoveringHandler as unknown as {
      verifyChainCgBinding: () => Promise<boolean>;
    };
    internals.verifyChainCgBinding = async () => true;

    await expect(recoveringHandler.handleExactChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      batchId: 42n,
      versionBlock: 124,
      authorAddress: AUTHOR,
    }, createOperationContext('system'))).resolves.toBe('already-confirmed');

    expect(retire).toHaveBeenCalledOnce();
    expect(await store.countQuads(staged.vmGraph)).toBe(2);
    expect(await store.countQuads(staged.swmGraph)).toBe(0);
  });

  it('preserves a newly staged workspace head that races orphan retirement', async () => {
    const staged = await stageGraph();
    const message = { ...staged.message, batchId: 42n };
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    await store.deleteByPattern({
      graph: graphManager.sharedMemoryMetaUri(CG),
      subject: `${UAL}#dkg-swm-head`,
    });

    const writeLocks = new Map<string, Promise<void>>();
    const lockKey = swmKaWriteLockKey(CG, undefined, UAL);
    let releaseLock!: () => void;
    let markLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => { markLockHeld = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const blocker = withKeyedLocks(writeLocks, [lockKey], async () => {
      markLockHeld();
      await release;
    });
    await lockHeld;

    const retire = vi.fn(async () => store.dropGraph(staged.swmGraph));
    const recoveringHandler = new FinalizationHandler(
      store,
      legacyFinalizationChain(),
      {
        retireConfirmedGraphScopedSwmTwinIfOrphaned:
          createRetireConfirmedGraphScopedSwmTwinIfOrphaned({ store, writeLocks, retire }),
      },
    );
    const internals = recoveringHandler as unknown as {
      verifyChainCgBinding: () => Promise<boolean>;
    };
    internals.verifyChainCgBinding = async () => true;
    const recovery = recoveringHandler.handleExactChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      batchId: 42n,
      versionBlock: 124,
      authorAddress: AUTHOR,
    }, createOperationContext('system'));

    const swm = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${staged.swmGraph}> { ?s ?p ?o } }`,
    );
    if (swm.type !== 'quads') throw new Error('expected SWM quads');
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'newer-share-racing-retirement',
      kaUal: UAL,
      assertionVersion: '2',
      quads: swm.quads,
      privateMerkleRoot: message.privateMerkleRoot,
      privateTripleCount: Number(message.privateTripleCount),
      publisherPeerId: '12D3KooWNewerPublisher',
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'newer-share-racing-retirement',
      kaUal: UAL,
      assertionVersion: '2',
    });
    releaseLock();
    await blocker;
    await expect(recovery).resolves.toBe('already-confirmed');

    expect(retire).not.toHaveBeenCalled();
    await expect(resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
    })).resolves.toMatchObject({ assertionVersion: '2' });
    expect(await store.countQuads(staged.swmGraph)).toBe(2);
  });

  it('retries failed orphan retirement and never retires an invalid VM', async () => {
    const staged = await stageGraph();
    const message = { ...staged.message, batchId: 42n };
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    await store.deleteByPattern({
      graph: graphManager.sharedMemoryMetaUri(CG),
      subject: `${UAL}#dkg-swm-head`,
    });
    const retire = vi.fn()
      .mockRejectedValueOnce(new Error('injected retirement failure'))
      .mockImplementationOnce(() => store.dropGraph(staged.swmGraph));
    const recoveringHandler = new FinalizationHandler(
      store,
      legacyFinalizationChain(),
      {
        retireConfirmedGraphScopedSwmTwinIfOrphaned:
          createRetireConfirmedGraphScopedSwmTwinIfOrphaned({
            store,
            writeLocks: new Map(),
            retire,
          }),
      },
    );
    const internals = recoveringHandler as unknown as {
      verifyChainCgBinding: () => Promise<boolean>;
    };
    internals.verifyChainCgBinding = async () => true;
    const input = {
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      batchId: 42n,
      versionBlock: 124,
      authorAddress: AUTHOR,
    };

    await expect(recoveringHandler.handleExactChainReconciledKC(
      input,
      createOperationContext('system'),
    )).rejects.toThrow('injected retirement failure');
    await expect(recoveringHandler.handleExactChainReconciledKC(
      input,
      createOperationContext('system'),
    )).resolves.toBe('already-confirmed');
    expect(retire).toHaveBeenCalledTimes(2);

    await store.insert([{
      subject: 'urn:invalid-vm-row',
      predicate: 'urn:predicate:value',
      object: '"corrupt"',
      graph: staged.vmGraph,
    }]);
    await expect(recoveringHandler.handleExactChainReconciledKC(
      input,
      createOperationContext('system'),
    )).resolves.toBe('no-swm');
    expect(retire).toHaveBeenCalledTimes(2);
  });

  it('uses one confirmed VM resolver for absent, matching, and invalid metadata', async () => {
    await expect(resolveConfirmedGraphScopedVm(store, {
      contextGraphId: CG,
      ual: UAL,
      merkleRoot: new Uint8Array(32),
      kaId: PACKED_KA_ID,
      batchId: PACKED_KA_ID,
    })).resolves.toEqual({ status: 'absent' });

    const { message } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    await expect(resolveConfirmedGraphScopedVm(store, {
      contextGraphId: CG,
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      kaId: PACKED_KA_ID,
      batchId: PACKED_KA_ID,
    })).resolves.toMatchObject({
      status: 'verified',
      envelope: { assertionVersion: VERSION, batchId: PACKED_KA_ID },
      scope: { ual: UAL },
    });

    await store.insert([{
      graph: `did:dkg:context-graph:${CG}/_meta`,
      subject: UAL,
      predicate: 'http://dkg.io/ontology/contentScopeVersion',
      object: '"999"',
    }]);
    await expect(resolveConfirmedGraphScopedVm(store, {
      contextGraphId: CG,
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      kaId: PACKED_KA_ID,
      batchId: PACKED_KA_ID,
    })).resolves.toEqual({ status: 'invalid', reason: 'metadata' });
  });

  it('uses one verifier for exact graph content, count, root, and digest checks', async () => {
    const { message, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    const base = {
      graphUri: vmGraph,
      publicTripleCount: Number(message.publicTripleCount),
      ...(message.privateMerkleRoot?.length
        ? { privateMerkleRoot: message.privateMerkleRoot }
        : {}),
      expectedMerkleRoot: message.kcMerkleRoot,
      source: 'agent.test.verifyExactGraphContent',
    };

    const matching = await verifyExactGraphContent(store, base);
    expect(matching).toMatchObject({ status: 'verified', graphUri: vmGraph });
    if (matching.status !== 'verified') throw new Error('expected matching graph content');

    await expect(verifyExactGraphContent(store, {
      ...base,
      publicTripleCount: base.publicTripleCount + 1,
    })).resolves.toMatchObject({ status: 'count-mismatch', actualCount: 2 });
    await expect(verifyExactGraphContent(store, {
      ...base,
      expectedMerkleRoot: new Uint8Array(32),
    })).resolves.toMatchObject({ status: 'merkle-mismatch' });
    await expect(verifyExactGraphContent(store, {
      ...base,
      expectedPublicQuadsDigest: `sha256:${'00'.repeat(32)}`,
    })).resolves.toMatchObject({ status: 'head-mismatch' });
    await expect(verifyExactGraphContent(store, {
      ...base,
      expectedPublicQuadsDigest: workspacePublicQuadsDigest(matching.quads),
    })).resolves.toMatchObject({ status: 'verified' });
  });

  it('preserves typed invalid-result failures from the bounded exact graph reader', async () => {
    const invalidStore = {
      query: async (sparql: string): Promise<QueryResult> => sparql.includes('COUNT(*)')
        ? { type: 'bindings', bindings: [{ count: '"1"' }] }
        : { type: 'boolean', value: false },
    } as Pick<TripleStore, 'query'> as TripleStore;

    const error = await verifyExactGraphContent(invalidStore, {
      graphUri: 'urn:test:invalid-exact-graph-result',
      publicTripleCount: 1,
      expectedMerkleRoot: new Uint8Array(32),
      source: 'agent.test.verifyExactGraphContent.invalid-result',
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExactGraphReadError);
    expect(error).toMatchObject({ code: 'INVALID_QUERY_RESULT' });
  });

  it('keeps exact graph verification reads page-bounded', async () => {
    let pageQuery = '';
    const boundedStore = {
      query: async (sparql: string): Promise<QueryResult> => {
        if (sparql.includes('COUNT(*)')) {
          return { type: 'bindings', bindings: [{ count: '"5000"' }] };
        }
        pageQuery = sparql;
        return { type: 'bindings', bindings: [] };
      },
    } as Pick<TripleStore, 'query'> as TripleStore;

    await expect(verifyExactGraphContent(boundedStore, {
      graphUri: 'urn:test:bounded-exact-graph-read',
      publicTripleCount: 5000,
      expectedMerkleRoot: new Uint8Array(32),
      source: 'agent.test.verifyExactGraphContent.bounded',
    })).resolves.toMatchObject({ status: 'count-mismatch', actualCount: 0 });
    expect(pageQuery).toMatch(/LIMIT 256\s+OFFSET 0/);
  });

  it('settles a RECEIVED inbox row after the workspace head is lost and its receipt moves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-received-vm-settle-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const staged = await stageGraph({ accessPolicy: 'ownerOnly' });
      const message = { ...staged.message, batchId: 42n };
      const { vmGraph } = staged;
      await seedAuthenticatedLocalControls(message);
      await handler.handleFinalizationMessage(
        encodeFinalizationMessage(message),
        CG,
        '12D3KooWPublisher',
      );
      expect(await store.countQuads(vmGraph)).toBe(2);

      await store.deleteByPattern({
        graph: graphManager.sharedMemoryMetaUri(CG),
        subject: `${UAL}#dkg-swm-head`,
      });
      await expect(resolveKnowledgeAssetWorkspaceHead({
        store,
        graphManager,
        contextGraphId: CG,
        kaUal: UAL,
      })).resolves.toBeUndefined();

      const movedReceipt = canonicalReceipt(message);
      movedReceipt.receipt = {
        ...movedReceipt.receipt,
        blockNumber: 124,
        blockHash: `0x${'ef'.repeat(32)}`,
        txIndex: 7,
      };
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => message.kcMerkleRoot,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () => movedReceipt,
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const recoveryHandler = new FinalizationHandler(
        store,
        chain,
        recoveryOptions(inbox),
      );
      await recoveryHandler.handleFinalizationMessage(
        encodeFinalizationMessage(message),
        CG,
        '12D3KooWPublisher',
      );
      expect(await inbox.list()).toMatchObject([{ state: 'RECEIVED' }]);

      await expect(recoveryHandler.handleExactChainReconciledKC(
        graphReconcileInput(message),
        createOperationContext('system'),
      )).resolves.toBe('already-confirmed');

      expect(await store.countQuads(vmGraph)).toBe(2);
      expect(await inbox.list()).toMatchObject([{
        state: 'SETTLED',
        batchId: '42',
        generation: 1,
        verifiedEvidence: {
          transactionHash: message.txHash,
          blockNumber: 124,
          blockHash: `0x${'ef'.repeat(32)}`,
          txIndex: 7,
          publisherAddress: PUBLISHER,
          accessPolicy: 'ownerOnly',
        },
      }]);
    } finally {
      await closeInbox(inbox);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the confirmed VM namespace when a named workspace head is lost', async () => {
    const { message, vmGraph } = await stageGraph(undefined, 'named-scope');
    await store.insert(generateAssertionCreatedMetadata({
      contextGraphId: CG,
      agentAddress: AUTHOR,
      assertionName: 'named-asset',
      subGraphName: 'named-scope',
      timestamp: new Date(),
      kaNumber: 7,
      reservedUal: UAL,
    }, { provenanceEvents: false }));
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    await store.deleteByPattern({
      graph: graphManager.sharedMemoryMetaUri(CG, 'named-scope'),
      subject: `${UAL}#dkg-swm-head`,
    });
    await expect(resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
      subGraphName: 'named-scope',
    })).resolves.toBeUndefined();
    const internals = handler as unknown as {
      verifyChainCgBinding: () => Promise<boolean>;
    };
    internals.verifyChainCgBinding = async () => true;

    const input = graphReconcileInput(message);
    await expect(handler.handleExactChainReconciledKC(
      input,
      createOperationContext('system'),
    )).resolves.toBe('already-confirmed');
    await expect(handler.handleExactChainReconciledKC(
      { ...input, subGraphName: 'named-scope' },
      createOperationContext('system'),
    )).resolves.toBe('already-confirmed');
    await expect(handler.handleExactChainReconciledKC(
      { ...input, subGraphName: 'different-scope' },
      createOperationContext('system'),
    )).resolves.toBe('no-swm');
    expect(await store.countQuads(vmGraph)).toBe(2);
  });

  it('rejects stale confirmed A-v1 state when the chain returns to root A at v3', async () => {
    const { message } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    await store.deleteByPattern({
      graph: graphManager.sharedMemoryMetaUri(CG),
      subject: `${UAL}#dkg-swm-head`,
    });
    const internals = handler as unknown as {
      verifyChainCgBinding: () => Promise<boolean>;
    };
    internals.verifyChainCgBinding = async () => true;

    // The local confirmed envelope is assertion v1 with root A. The coherent
    // chain snapshot has advanced A(v1) -> B(v2) -> A(v3). Equal content alone
    // must not let the v1 envelope advance the v3 materialization stamp.
    await expect(handler.handleExactChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      assertionVersion: 3n,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      batchId: message.batchId,
      versionBlock: 999,
      authorAddress: AUTHOR,
    }, createOperationContext('system'))).resolves.toBe('no-swm');

    const metaGraph = `did:dkg:context-graph:${CG}/_meta`;
    const advanced = await store.query(
      `ASK { GRAPH <${metaGraph}> { <${UAL}> `
        + '<http://dkg.io/ontology/materializedVersion> "999:0" } }',
    );
    expect(advanced.type === 'boolean' && advanced.value).toBe(false);
  });

  it('recognizes an exact confirmed VM copy when the mutable workspace head is corrupt', async () => {
    const { message, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    await store.insert([{
      graph: graphManager.sharedMemoryMetaUri(CG),
      subject: `${UAL}#dkg-swm-head`,
      predicate: 'http://dkg.io/ontology/shareOperationId',
      object: '"storage-ack-equivalent"',
    }]);
    await expect(resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
    })).rejects.toThrow(/head carries 2 shareOperationId values/);

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
      batchId: PACKED_KA_ID,
      versionBlock: 124,
      authorAddress: AUTHOR,
    }, createOperationContext('system')))
      .resolves.toBe('already-confirmed');

    expect(await store.countQuads(vmGraph)).toBe(2);
  });

  it('promotes named-subgraph SWM when the exact caller omits the namespace', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph(undefined, 'named-scope');
    await store.insert(generateAssertionCreatedMetadata({
      contextGraphId: CG,
      agentAddress: AUTHOR,
      assertionName: 'named-asset',
      subGraphName: 'named-scope',
      timestamp: new Date(),
      kaNumber: 7,
      reservedUal: UAL,
    }, { provenanceEvents: false }));
    const publicHandler = makePublicReconcileHandler(message, {
      getLatestMerkleRootAuthor: async () => AUTHOR,
    });

    await expect(publicHandler.handleExactChainReconciledKC(
      graphReconcileInput(message),
      createOperationContext('system'),
    )).resolves.toBe('promoted');

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
        batchId: PACKED_KA_ID,
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

  it('repairs stale access metadata from trusted recovery evidence', async () => {
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
      trustedAssertionEvidence: trustedRecoveryEvidence(message),
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

    const replayHandler = new FinalizationHandler(store, legacyFinalizationChain());
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
    if (!message.privateMerkleRoot) throw new Error('expected private commitment');
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
      trustedAssertionEvidence: trustedRecoveryEvidence(message),
    }, createOperationContext('system'));

    expect(outcome).toBe('already-confirmed');
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(0);
    const repaired = await store.query(
      `ASK { GRAPH <${metaGraph}> {
        <${UAL}> <http://dkg.io/ontology/contentScopeVersion> "2"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/assertionVersion> "1"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/assertionGraph> <${vmGraph}> ;
          <http://dkg.io/ontology/privateTripleCount> "1"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/privateMerkleRoot> "${Buffer.from(message.privateMerkleRoot).toString('hex')}" ;
          <http://dkg.io/ontology/status> "confirmed" ;
          <http://dkg.io/ontology/materializedVersion> "123:4" .
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
      trustedAssertionEvidence: trustedRecoveryEvidence(message),
    }, createOperationContext('system'))).resolves.toBe('already-confirmed');

    const repairedVersion = await store.query(
      `ASK { GRAPH <${metaGraph}> {
        <${UAL}> <${materializedVersionPredicate}> "123:4" .
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

    expect(outcome).toBe('verified-vm-metadata-pending');
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
      trustedAssertionEvidence: trustedRecoveryEvidence(message),
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
          <http://dkg.io/ontology/materializedVersion> "123:4" .
      } }`,
    );
    expect(repaired).toMatchObject({ type: 'boolean', value: true });
  });

  it('defers absent metadata behind a newer public head without transaction provenance', async () => {
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
    )).resolves.toBe('verified-vm-metadata-pending');
    await expect(handler.handleChainReconciledKC(
      reconcileInput,
      createOperationContext('system'),
    )).resolves.toBe('verified-vm-metadata-pending');

    expect(await store.countQuads(vmGraph)).toBe(2);
    const failClosedPolicy = await store.query(
      `ASK { GRAPH <${metaGraph}> {
        <${UAL}> <http://dkg.io/ontology/assertionVersion> "2"^^<http://www.w3.org/2001/XMLSchema#integer> ;
          <http://dkg.io/ontology/accessPolicy> "ownerOnly" ;
          <http://dkg.io/ontology/status> "confirmed" .
      } }`,
    );
    expect(failClosedPolicy).toMatchObject({ type: 'boolean', value: false });
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

    expect(outcome).toBe('verified-vm-metadata-pending');
    expect(await store.countQuads(nextVmGraph)).toBe(2);
    expect(await store.countQuads(nextSwmGraph)).toBe(1);
    const version = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> {
        <${UAL}> <http://dkg.io/ontology/assertionVersion> "2"^^<http://www.w3.org/2001/XMLSchema#integer> .
      } }`,
    );
    expect(version).toMatchObject({ type: 'boolean', value: false });
  });
});
