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
  OxigraphStore,
  StoreSchedulerBusyError,
  asGraphWriteGenSource,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import {
  computeFlatKCRootV10,
  computePrivateRootV10,
  resolveKnowledgeAssetWorkspaceHead,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
  swmKaWriteLockKey,
  withKeyedLocks,
  workspaceOperationSubject,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import {
  FINALIZED_SWM_CLEANUP_ROOT_PREDICATE,
  FINALIZED_SWM_CLEANUP_TASK_TYPE,
  FinalizationHandler,
} from '../src/finalization-handler.js';
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
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { FinalizedSwmCleanupService } from '../src/finalized-swm-cleanup-service.js';

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

/** The read the cleanup service takes again once it owns the writer lock. */
const WORKSPACE_HEAD_READ_PREFIX = 'SELECT ?scopeVersion ?kaUal ?assertionVersion';

const WRITE_GEN_CAPABILITY_KEYS = new Set(['getWriteGen', 'innerStore', 'inner']);

/**
 * A store whose per-graph write-generation capability cannot be recovered.
 *
 * `asGraphWriteGenSource` is documented as fail-open, so on such a store every
 * generation comparison in the cleanup service is inert and the head re-read
 * taken inside the writer lock is the only remaining proof that nothing moved
 * while verification ran outside it.
 */
function withoutWriteGenTracking(inner: OxigraphStore): TripleStore {
  return new Proxy(inner as unknown as object, {
    get(target, prop) {
      if (WRITE_GEN_CAPABILITY_KEYS.has(prop as string)) return undefined;
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(target, prop) {
      if (WRITE_GEN_CAPABILITY_KEYS.has(prop as string)) return false;
      return Reflect.has(target, prop);
    },
  }) as unknown as TripleStore;
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
  let writeLocks: Map<string, Promise<void>>;

  beforeEach(() => {
    store = new OxigraphStore();
    graphManager = new GraphManager(store);
    writeLocks = new Map<string, Promise<void>>();
    handler = new FinalizationHandler(store, legacyFinalizationChain(), { writeLocks });
  });

  function cleanupService(
    locks: Map<string, Promise<void>> | null = writeLocks,
  ): FinalizedSwmCleanupService {
    return new FinalizedSwmCleanupService({
      store,
      writeLocks: locks ?? undefined,
      listContextGraphIds: async () => [CG],
      listSharedMemoryMetaGraphs: async () => [graphManager.sharedMemoryMetaUri(CG)],
    });
  }

  async function drainFinalizedSwm(
    locks: Map<string, Promise<void>> | null = writeLocks,
    subGraphName?: string,
  ): Promise<number> {
    return cleanupService(locks).cleanupKnownMetaGraph({
      contextGraphId: CG,
      swmMetaGraph: graphManager.sharedMemoryMetaUri(CG, subGraphName),
      maxCandidates: 16,
    });
  }

  async function stageGraph(durableAccess?: {
    accessPolicy: 'ownerOnly' | 'allowList';
    allowedPeers?: string[];
  }, subGraphName?: string): Promise<{
    message: FinalizationMessageMsg;
    swmGraph: string;
    vmGraph: string;
    publicQuads: Quad[];
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
      publicQuads,
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

  it('atomically replaces the exact VM graph and emits constant-size rootless metadata', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();

    await handler.handleFinalizationMessage(encodeFinalizationMessage({
      ...message,
      accessPolicy: 'allowList',
      allowedPeers: ['12D3KooWReader'],
    }), CG, '12D3KooWPublisher');

    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(2);
    expect(await drainFinalizedSwm()).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(0);
    await expect(resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
    })).resolves.toBeUndefined();
    await expect(store.query(
      `ASK { GRAPH <${graphManager.sharedMemoryMetaUri(CG)}> {
        ?operation <http://dkg.io/ontology/shareOperationId> ${JSON.stringify(SHARE_ID)} .
      } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: true });
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

  it('eventually removes a late repeated snapshot after the node becomes idle again', async () => {
    const { message, swmGraph, vmGraph, publicQuads } = await stageGraph();
    const metaGraph = graphManager.sharedMemoryMetaUri(CG);
    const beforeFinalization = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`,
    );
    expect(beforeFinalization.type).toBe('quads');
    if (beforeFinalization.type !== 'quads') throw new Error('expected SWM metadata');
    const [descriptor] = parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: CG,
      metaQuads: beforeFinalization.quads.map((quad) => ({ ...quad, graph: metaGraph })),
    });
    expect(descriptor).toBeDefined();
    if (!descriptor) throw new Error('expected graph-scoped SWM descriptor');

    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    expect(await drainFinalizedSwm()).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(0);
    expect(await store.countQuads(vmGraph)).toBe(publicQuads.length);

    // A delayed/repeated snapshot lands normally. Ingest only re-arms the
    // constant-size durable task; it never scans VM or deletes SWM.
    const materializer = createSharedMemorySnapshotMaterializer({
      store,
      writeLocks,
      invalidateListContextGraphsCache: () => {},
      insertReplacementMetadata: (quads) => store.insert([...quads]),
    });
    await materializer.withKaWriteLock(CG, undefined, UAL, async () => {
      await materializer.ensureFinalizedCleanupTask(CG, descriptor);
      await materializer.replaceGraph(swmGraph, publicQuads);
      await materializer.replaceHeadMetadata(CG, descriptor);
    });
    expect(await store.countQuads(swmGraph)).toBe(publicQuads.length);
    expect(await store.countQuads(vmGraph)).toBe(publicQuads.length);

    // Once idle, only the dedicated GC performs the expensive verification
    // and exact conditional delete. VM remains byte-for-byte intact.
    expect(await drainFinalizedSwm()).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(0);
    expect(await store.countQuads(vmGraph)).toBe(publicQuads.length);
    expect(await drainFinalizedSwm()).toBe(0);
    await expect(store.query(
      `ASK { GRAPH <${metaGraph}> { ?task `
        + `<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> `
        + `<${FINALIZED_SWM_CLEANUP_TASK_TYPE}> } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: false });
    await expect(store.query(
      `ASK { GRAPH <${metaGraph}> { <${workspaceOperationSubject(CG, SHARE_ID)}> `
        + `<${FINALIZED_SWM_CLEANUP_ROOT_PREDICATE}> ?root } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: true });
    const finalVm = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`,
    );
    expect(finalVm.type).toBe('quads');
    if (finalVm.type !== 'quads') throw new Error('expected VM content');
    expect(workspacePublicQuadsDigest(finalVm.quads.map((quad) => ({ ...quad, graph: '' }))))
      .toBe(workspacePublicQuadsDigest(publicQuads.map((quad) => ({ ...quad, graph: '' }))));
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
    expect(await drainFinalizedSwm()).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(0);
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
        recordTrustedPublisher: inbox.recordTrustedPublisher.bind(inbox),
        recordSettledPublisherUpgrade:
          inbox.recordSettledPublisherUpgrade.bind(inbox),
        rearmSettledWithTrustedPublisher:
          inbox.rearmSettledWithTrustedPublisher.bind(inbox),
        markVerified: async () => ({ status: 'closed' }),
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
        recordTrustedPublisher: async () => {
          throw new Error('recordTrustedPublisher must not run after failed admission');
        },
        recordSettledPublisherUpgrade: async () => {
          throw new Error('recordSettledPublisherUpgrade must not run after failed admission');
        },
        rearmSettledWithTrustedPublisher: async () => {
          throw new Error('rearmSettledWithTrustedPublisher must not run after failed admission');
        },
        markVerified: async () => {
          throw new Error('markVerified must not run after failed admission');
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
        await recoveryHandler.handleFinalizationMessage(
          encodeFinalizationMessage(message),
          CG,
          '12D3KooWPublisher',
        );
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

  it('preserves finalized SWM when the committed VM graph disappears before cleanup', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    expect(await store.countQuads(vmGraph)).toBe(2);

    // Simulate external VM loss only after finalization has persisted the
    // cleanup marker. The drain must re-verify VM durability and fail closed.
    await store.dropGraph(vmGraph);

    expect(await drainFinalizedSwm()).toBe(0);
    expect(await store.countQuads(swmGraph)).toBe(2);
    await expect(resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
    })).resolves.toMatchObject({ shareOperationId: SHARE_ID });
  });

  it('preserves finalized SWM when its exact assertion changes before cleanup', async () => {
    const { message, swmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    // Keep the finalized rows but add one new row after the marker is written.
    // Exact-digest re-verification must reject this three-row graph.
    await store.insert([{
      subject: 'urn:asset:post-finalization-change',
      predicate: 'urn:predicate:value',
      object: '"newer"',
      graph: swmGraph,
    }]);

    expect(await store.countQuads(swmGraph)).toBe(3);
    expect(await drainFinalizedSwm()).toBe(0);
    expect(await store.countQuads(swmGraph)).toBe(3);
    await expect(resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
    })).resolves.toMatchObject({ shareOperationId: SHARE_ID });
  });

  /**
   * Despite its previous name, this test does not observe cleanup serializing
   * against a contended lock: the blocking writer is released before the drain
   * ever runs. Pointing that writer at an unrelated lock key leaves the test
   * green, which is the proof. What it does verify is still worth keeping —
   * finalization commits the VM graph even while another writer holds the
   * per-KA SWM lock, and it leaves SWM entirely to the independent drain.
   *
   * The serialization property itself is covered by
   * `re-reads the head under the lock when the store cannot track write
   * generations`, which queues the drain behind a held lock and asserts the
   * ordering across it.
   */
  it('commits VM under a held per-KA SWM lock and leaves SWM to the later drain', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    const writeLocks = new Map<string, Promise<void>>();
    const lockingHandler = new FinalizationHandler(store, legacyFinalizationChain(), {
      writeLocks,
    });
    let releaseWriterLock!: () => void;
    let markWriterLockAcquired!: () => void;
    const writerLockAcquired = new Promise<void>((resolve) => {
      markWriterLockAcquired = resolve;
    });
    const holdWriterLock = new Promise<void>((resolve) => {
      releaseWriterLock = resolve;
    });
    const blocker = withKeyedLocks(
      writeLocks,
      [swmKaWriteLockKey(CG, undefined, UAL)],
      async () => {
        markWriterLockAcquired();
        await holdWriterLock;
      },
    );
    await writerLockAcquired;

    let markVmCommitted!: () => void;
    const vmCommitted = new Promise<void>((resolve) => {
      markVmCommitted = resolve;
    });
    const replaceGraphAndSubject = store.replaceGraphAndSubject?.bind(store);
    if (!replaceGraphAndSubject) throw new Error('Oxigraph replaceGraphAndSubject unavailable');
    store.replaceGraphAndSubject = async (
      graphUri,
      quads,
      metadataGraph,
      subject,
      metadata,
      options,
    ) => {
      await replaceGraphAndSubject(
        graphUri,
        quads,
        metadataGraph,
        subject,
        metadata,
        options,
      );
      if (graphUri === vmGraph) markVmCommitted();
    };

    const finalization = lockingHandler.handleFinalizationMessage(
      encodeFinalizationMessage(message),
      CG,
    );
    await vmCommitted;
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(2);

    releaseWriterLock();
    await blocker;
    await finalization;
    expect(await store.countQuads(swmGraph)).toBe(2);
    expect(await drainFinalizedSwm(writeLocks)).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(0);
  });

  it('preserves an assertion replaced between the pre-lock head read and the in-lock re-check', async () => {
    const { message, swmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    expect(await store.countQuads(swmGraph)).toBe(2);

    // Discovery and both payload verifications run OUTSIDE the per-KA writer
    // lock by design, so everything the drain has proven is only as fresh as
    // the head it read before taking the lock. The re-read taken under the
    // lock is the sole check that closes that window: the write-generation
    // comparisons are already behind us by then, and the marker ASK only
    // proves the cleanup task still exists, not that the assertion is still
    // the one that was verified.
    //
    // Mutating the head *before* the drain does not reach this branch — the
    // pre-lock triage in `cleanupMetaGraph` sees the mismatch first and
    // retires the task. The race has to land between the two reads.
    const originalQuery = store.query.bind(store);
    let racedInsideLock = false;
    const querySpy = vi.spyOn(store, 'query').mockImplementation(async (query, options) => {
      if (
        !racedInsideLock
        && options?.source === 'agent.finalizedSwmCleanup'
        && query.startsWith(WORKSPACE_HEAD_READ_PREFIX)
      ) {
        racedInsideLock = true;
        // Drop the seam first so the staging writes and the rest of the commit
        // path run against the real store.
        querySpy.mockRestore();
        await stageNewerWorkspaceAssertion(
          swmGraph,
          message.privateMerkleRoot,
          message.privateTripleCount,
        );
      }
      return originalQuery(query, options);
    });

    await expect(drainFinalizedSwm()).resolves.toBe(0);
    expect(racedInsideLock).toBe(true);

    // The newer assertion shares the SWM graph URI with the finalized one, so
    // a delete here destroys unpublished data rather than a redundant copy.
    expect(await store.countQuads(swmGraph)).toBe(2);
    await expect(store.query(
      `ASK { GRAPH <${swmGraph}> { <urn:asset:newer-unpublished> `
        + `<urn:predicate:value> "newer" } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: true });
    await expect(resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
    })).resolves.toMatchObject({ assertionVersion: '2' });
  });

  it('re-reads the head under the lock when the store cannot track write generations', async () => {
    const { message, swmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    expect(await store.countQuads(swmGraph)).toBe(2);

    const untrackedStore = withoutWriteGenTracking(store);
    expect(asGraphWriteGenSource(untrackedStore)).toBeNull();

    const lockKey = swmKaWriteLockKey(CG, undefined, UAL);
    let releaseWriter!: () => void;
    let markWriterHolding!: () => void;
    const writerHolding = new Promise<void>((resolve) => { markWriterHolding = resolve; });
    const writerDone = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const blocker = withKeyedLocks(writeLocks, [lockKey], async () => {
      markWriterHolding();
      await writerDone;
    });
    // `withKeyedLocks` installs its gate synchronously, before its first await.
    const writerGate = writeLocks.get(lockKey);
    expect(writerGate).toBeDefined();
    await writerHolding;

    const drain = new FinalizedSwmCleanupService({
      store: untrackedStore,
      writeLocks,
      listContextGraphIds: async () => [CG],
      listSharedMemoryMetaGraphs: async () => [graphManager.sharedMemoryMetaUri(CG)],
    }).cleanupKnownMetaGraph({
      contextGraphId: CG,
      swmMetaGraph: graphManager.sharedMemoryMetaUri(CG),
      maxCandidates: 16,
    });

    // Wait until the drain has finished discovery plus both verifications and
    // queued behind the writer; the map entry flips to the drain's own gate.
    let drainQueuedBehindWriter = false;
    for (let attempt = 0; attempt < 1_000 && !drainQueuedBehindWriter; attempt += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      drainQueuedBehindWriter = writeLocks.get(lockKey) !== writerGate;
    }
    expect(drainQueuedBehindWriter).toBe(true);

    // The lock holder replaces the assertion the drain just verified. Nothing
    // the drain captured before queueing is true any more.
    await stageNewerWorkspaceAssertion(
      swmGraph,
      message.privateMerkleRoot,
      message.privateTripleCount,
    );
    releaseWriter();
    await blocker;

    await expect(drain).resolves.toBe(0);
    expect(await store.countQuads(swmGraph)).toBe(2);
    await expect(store.query(
      `ASK { GRAPH <${swmGraph}> { <urn:asset:newer-unpublished> `
        + `<urn:predicate:value> "newer" } }`,
    )).resolves.toMatchObject({ type: 'boolean', value: true });
    await expect(resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
    })).resolves.toMatchObject({ assertionVersion: '2' });
  });

  /**
   * The lock that matters here belongs to the cleanup SERVICE, not the handler:
   * `cleanupService(null)` is what makes this fail closed. The uncoordinated
   * handler is incidental — finalization no longer takes a per-KA SWM lock at
   * all, and its `writeLocks` option has since been deleted as dead.
   */
  it('preserves finalized SWM when the cleanup service has no writer lock map', async () => {
    const { message, swmGraph } = await stageGraph();
    const uncoordinated = new FinalizationHandler(store, legacyFinalizationChain());

    await uncoordinated.handleFinalizationMessage(
      encodeFinalizationMessage(message),
      CG,
    );

    expect(await cleanupService(null).cleanupKnownMetaGraph({
      contextGraphId: CG,
      swmMetaGraph: graphManager.sharedMemoryMetaUri(CG),
      maxCandidates: 16,
    })).toBe(0);
    expect(await store.countQuads(swmGraph)).toBe(2);
    await expect(resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
    })).resolves.toMatchObject({ shareOperationId: SHARE_ID });
  });

  it('defers durable cleanup while the store is busy and resumes after restart when idle', async () => {
    const { message, swmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    let busy = true;
    Object.defineProperty(store, 'getPressureSnapshot', {
      configurable: true,
      value: () => ({
        ackInflight: 0,
        healthInflight: 0,
        normalInflight: busy ? 1 : 0,
        backgroundInflight: 0,
        ackQueued: 0,
        healthQueued: 0,
        normalQueued: 0,
        backgroundQueued: 0,
        maxConcurrent: 4,
        ackReservedSlots: 1,
      }),
    });
    expect(await drainFinalizedSwm()).toBe(0);
    expect(await store.countQuads(swmGraph)).toBe(2);

    busy = false;
    expect(await drainFinalizedSwm()).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(0);
    await expect(resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
    })).resolves.toBeUndefined();
    const immutableFinalizationTombstone = await store.query(
      `ASK { GRAPH <${graphManager.sharedMemoryMetaUri(CG)}> { `
        + `<${workspaceOperationSubject(CG, SHARE_ID)}> `
        + `<${FINALIZED_SWM_CLEANUP_ROOT_PREDICATE}> ?root } }`,
    );
    expect(immutableFinalizationTombstone).toMatchObject({
      type: 'boolean',
      value: true,
    });
  });

  it('never bypasses active store pressure for finalized cleanup', async () => {
    const { message, swmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    Object.defineProperty(store, 'getPressureSnapshot', {
      configurable: true,
      value: () => ({
        ackInflight: 1,
        healthInflight: 1,
        normalInflight: 2,
        backgroundInflight: 2,
        ackQueued: 3,
        healthQueued: 2,
        normalQueued: 4,
        backgroundQueued: 4,
        maxConcurrent: 4,
        ackReservedSlots: 1,
      }),
    });

    const querySpy = vi.spyOn(store, 'query');
    expect(await drainFinalizedSwm()).toBe(0);
    expect(await store.countQuads(swmGraph)).toBe(2);
    expect(querySpy).not.toHaveBeenCalled();
    querySpy.mockRestore();
  });

  it('discovers the independent cleanup task for bounded subgraph cleanup', async () => {
    const subGraphName = 'named-cleanup';
    const { message, swmGraph } = await stageGraph(undefined, subGraphName);
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    const discoverQueries: string[] = [];
    const originalQuery = store.query.bind(store);
    const querySpy = vi.spyOn(store, 'query').mockImplementation(async (query, options) => {
      if (options?.source === 'agent.finalizedSwmCleanup.discover') {
        discoverQueries.push(query);
      }
      return originalQuery(query, options);
    });

    await expect(cleanupService().cleanupKnownMetaGraph({
      contextGraphId: CG,
      swmMetaGraph: graphManager.sharedMemoryMetaUri(CG, subGraphName),
      maxCandidates: 1,
    })).resolves.toBe(1);
    expect(discoverQueries.some((query) => query.includes(
      '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/FinalizedSwmCleanupTask>',
    ))).toBe(true);
    expect(await store.countQuads(swmGraph)).toBe(0);
    await expect(resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
      subGraphName,
    })).resolves.toBeUndefined();
    querySpy.mockRestore();
  });

  it('keeps cleanup background-only and leaves retry to the worker after scheduler pressure', async () => {
    const { message, swmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);

    const originalQuery = store.query.bind(store);
    let injectedBusyTimeout = false;
    const cleanupPriorities: Array<string | undefined> = [];
    const querySpy = vi.spyOn(store, 'query').mockImplementation(async (query, options) => {
      if (options?.source?.startsWith('agent.finalizedSwmCleanup')) {
        cleanupPriorities.push(options.priority);
      }
      if (
        !injectedBusyTimeout
        && options?.source === 'agent.finalizedSwmCleanup.discover'
        && query.includes('SELECT DISTINCT ?task ?ual ?version ?root ?shareId')
      ) {
        injectedBusyTimeout = true;
        throw new StoreSchedulerBusyError(
          'queue_wait_timeout',
          'background',
          options.source,
        );
      }
      return originalQuery(query, options);
    });

    await expect(cleanupService().cleanupKnownMetaGraph({
      contextGraphId: CG,
      swmMetaGraph: graphManager.sharedMemoryMetaUri(CG),
      maxCandidates: 16,
    })).rejects.toBeInstanceOf(StoreSchedulerBusyError);
    expect(injectedBusyTimeout).toBe(true);
    expect(cleanupPriorities.length).toBeGreaterThan(0);
    expect(new Set(cleanupPriorities)).toEqual(new Set(['background']));
    expect(await store.countQuads(swmGraph)).toBe(2);
    querySpy.mockRestore();
  });

  it('repairs VM from the immutable operation snapshot after deferred SWM cleanup', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    expect(await drainFinalizedSwm()).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(0);
    const internals = handler as unknown as {
      verifyChainCgBinding: (kaId: bigint, cgId: string) => Promise<boolean>;
    };
    internals.verifyChainCgBinding = async () => true;

    await store.dropGraph(vmGraph);
    await store.deleteByPattern({
      graph: graphManager.metaGraphUri(CG),
      subject: UAL,
    });

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
    }, createOperationContext('system'))).resolves.toBe('promoted');
    expect(await store.countQuads(vmGraph)).toBe(2);
    expect(await store.countQuads(swmGraph)).toBe(0);
  });

  /**
   * Stage extra operation subjects for the SAME assertion, so late-receipt
   * discovery has several candidates to choose between. `shareOperationId`
   * values are chosen to sort BEFORE the real one, because discovery is
   * `ORDER BY ?shareId` and that order is unrelated to which candidate matches.
   */
  async function stageDecoyOperations(input: {
    count: number;
    prefix: string;
    contentFor: (index: number) => string;
  }): Promise<string[]> {
    const scope = createGraphKnowledgeAssetScope(UAL, VERSION);
    const shareIds: string[] = [];
    for (let index = 0; index < input.count; index += 1) {
      const shareOperationId = `${input.prefix}-${index}`;
      shareIds.push(shareOperationId);
      const value = input.contentFor(index);
      await storeKnowledgeAssetOperationPublicQuads({
        store,
        graphManager,
        contextGraphId: CG,
        shareOperationId,
        kaUal: scope.ual,
        assertionVersion: scope.assertionVersion,
        // Same public triple count as the real assertion, so the count filter
        // in discovery cannot separate them — only a full payload resolution can.
        quads: [
          { subject: 'urn:asset:one', predicate: 'urn:predicate:value', object: `"${value}-one"`, graph: '' },
          { subject: 'urn:asset:two', predicate: 'urn:predicate:value', object: `"${value}-two"`, graph: '' },
        ],
        publisherPeerId: '12D3KooWPublisher',
      });
    }
    return shareIds;
  }

  async function reconcileFromImmutableSnapshot(
    message: FinalizationMessageMsg,
  ): Promise<string> {
    const internals = handler as unknown as {
      verifyChainCgBinding: (kaId: bigint, cgId: string) => Promise<boolean>;
    };
    internals.verifyChainCgBinding = async () => true;
    return handler.handleChainReconciledKC({
      contextGraphId: CG,
      onChainCgId: '42',
      ual: UAL,
      merkleRoot: message.kcMerkleRoot,
      publisherAddress: PUBLISHER,
      kaId: PACKED_KA_ID,
      versionBlock: 123,
      authorAddress: AUTHOR,
      // Carries no publicQuadsDigest, so discovery cannot pre-filter by content
      // and every candidate must be resolved to be told apart. This is the case
      // a candidate cap silently broke.
      trustedAssertionEvidence: trustedRecoveryEvidence(message),
    }, createOperationContext('system'));
  }

  /**
   * Regression guard against re-introducing a candidate cap.
   *
   * Discovery orders by `?shareId`, which has no relationship to which snapshot
   * actually matches the receipt. Truncating that list therefore does not do
   * less work, it returns a different answer — and because the list is
   * deterministic, every retry re-derives the identical truncation, so the
   * receipt is stranded permanently rather than delayed. Five candidates with
   * the matching one last is past the boundary of the cap this replaced.
   */
  it('verifies a late receipt whose matching snapshot sorts last among many candidates', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    expect(await drainFinalizedSwm()).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(0);

    // 'aaa-decoy-*' sorts before 'graph-finalization-share'.
    await stageDecoyOperations({
      count: 4,
      prefix: 'aaa-decoy',
      contentFor: (index) => `decoy-${index}`,
    });
    await store.dropGraph(vmGraph);
    await store.deleteByPattern({ graph: graphManager.metaGraphUri(CG), subject: UAL });

    await expect(reconcileFromImmutableSnapshot(message)).resolves.toBe('promoted');
    expect(await store.countQuads(vmGraph)).toBe(2);
  });

  /**
   * The subtle half of the content memo: a THROW must not memo.
   *
   * Failing to READ one operation's snapshot says nothing about whether that
   * content is correct, and a sibling operation may hold a readable copy of the
   * very same content. Memoing on throw would therefore skip the readable copy
   * and strand the receipt. Both candidates here carry identical content, so
   * they share a digest — which is exactly when a wrongly-placed memo bites.
   */
  it('still verifies a readable snapshot after an identical-content sibling fails to resolve', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    expect(await drainFinalizedSwm()).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(0);

    // Same content as the real assertion, so it advertises the same digest, and
    // it sorts first. Its snapshot payload is then made unreadable.
    const scope = createGraphKnowledgeAssetScope(UAL, VERSION);
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: 'aaa-unreadable-twin',
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      quads: [
        { subject: 'urn:asset:one', predicate: 'urn:predicate:value', object: '"one"', graph: '' },
        { subject: 'urn:asset:two', predicate: 'urn:predicate:value', object: '"two"', graph: '' },
      ],
      privateMerkleRoot: message.privateMerkleRoot,
      privateTripleCount: message.privateTripleCount,
      publisherPeerId: '12D3KooWPublisher',
    });
    const twinSnapshotGraph = (await store.query(
      `SELECT ?graph WHERE { GRAPH <${graphManager.sharedMemoryMetaUri(CG)}> { `
        + `<${workspaceOperationSubject(CG, 'aaa-unreadable-twin')}> `
        + `<http://dkg.io/ontology/publicSnapshotGraph> ?graph } }`,
    ));
    if (twinSnapshotGraph.type !== 'bindings' || !twinSnapshotGraph.bindings[0]?.['graph']) {
      throw new Error('expected a snapshot graph for the twin operation');
    }
    await store.dropGraph(twinSnapshotGraph.bindings[0]['graph']!);

    await store.dropGraph(vmGraph);
    await store.deleteByPattern({ graph: graphManager.metaGraphUri(CG), subject: UAL });

    await expect(reconcileFromImmutableSnapshot(message)).resolves.toBe('promoted');
    expect(await store.countQuads(vmGraph)).toBe(2);
  });

  /**
   * The other half of the memo: a content rejection MUST memo, or the bound on
   * repeated work does not exist and we are back to a full payload read per
   * candidate. The answer is identical either way, so this can only be observed
   * by counting payload resolutions — an output-equality assertion here would
   * pass with the memo deleted.
   */
  it('resolves an already-rejected snapshot digest only once across candidates', async () => {
    const { message, swmGraph, vmGraph } = await stageGraph();
    await handler.handleFinalizationMessage(encodeFinalizationMessage(message), CG);
    expect(await drainFinalizedSwm()).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(0);

    // Two candidates with IDENTICAL wrong content, so they advertise the same
    // digest and the second is provably a repeat of work already done.
    await stageDecoyOperations({ count: 2, prefix: 'aaa-dup', contentFor: () => 'same-wrong' });
    await store.dropGraph(vmGraph);
    await store.deleteByPattern({ graph: graphManager.metaGraphUri(CG), subject: UAL });

    const payloadReads: string[] = [];
    const originalQuery = store.query.bind(store);
    const querySpy = vi.spyOn(store, 'query').mockImplementation(async (query, options) => {
      if (
        options?.source === 'agent.finalization.resolveImmutableSnapshotPayload'
        && query.startsWith('CONSTRUCT')
      ) payloadReads.push(query);
      return originalQuery(query, options);
    });

    await expect(reconcileFromImmutableSnapshot(message)).resolves.toBe('promoted');
    expect(await store.countQuads(vmGraph)).toBe(2);
    // One rejected duplicate plus the matching snapshot — never the skipped twin.
    expect(payloadReads).toHaveLength(2);
    querySpy.mockRestore();
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

  it('defers SWM-only chain reconciliation without transaction provenance', async () => {
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

    expect(outcome).toBe('verified-vm-metadata-pending');
    expect(await store.countQuads(vmGraph)).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(2);
  });

  it('verifies chain binding and exact private VM metadata before cleaning an exact SWM copy', async () => {
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
    expect(await drainFinalizedSwm()).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(0);
  });

  it('recognizes only exact confirmed Verifiable Memory metadata after the workspace head is lost', async () => {
    const { message, vmGraph } = await stageGraph();
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
      versionBlock: 126,
      authorAddress: AUTHOR,
    }, createOperationContext('system'))).resolves.toBe('no-swm');
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
    expect(await drainFinalizedSwm()).toBe(1);
    expect(await store.countQuads(swmGraph)).toBe(0);

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
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`,
    );
    if (staged.type !== 'quads') throw new Error('expected staged SWM quads');
    await store.insert(staged.quads.map((quad) => ({ ...quad, graph: swmGraph })));
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
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`,
    );
    if (staged.type !== 'quads') throw new Error('expected staged SWM quads');
    await store.insert(staged.quads.map((quad) => ({ ...quad, graph: swmGraph })));
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
