import { beforeEach, describe, expect, it } from 'vitest';
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
  type Quad,
} from '@origintrail-official/dkg-storage';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import {
  computeFlatKCRootV10,
  computePrivateRootV10,
  resolveKnowledgeAssetWorkspaceHead,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { FinalizationHandler } from '../src/finalization-handler.js';
import {
  openSqliteFinalizationRecoveryStore,
  type SqliteFinalizationRecoveryStore,
} from '../src/finalization-recovery-sqlite-store.js';
import type { FinalizationRecoveryStore } from '../src/finalization-recovery-store.js';
import { protobufScalarToBigInt } from '../src/protobuf-scalars.js';

const CG = 'rootless-finalization';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const PUBLISHER = '0x2222222222222222222222222222222222222222';
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const SHARE_ID = 'graph-finalization-share';
const VERSION = '1';
const PACKED_KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const RECOVERY_BLOCK_HASH = `0x${'cd'.repeat(32)}`;

function canonicalReceipt(message: FinalizationMessageMsg, txIndex = 4) {
  return {
    status: 'confirmed' as const,
    receipt: {
      txHash: message.txHash,
      blockNumber: Number(message.blockNumber),
      blockHash: RECOVERY_BLOCK_HASH,
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

async function closeInbox(inbox: SqliteFinalizationRecoveryStore | undefined): Promise<void> {
  await inbox?.close().catch(() => {});
}

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
      const scopedHandler = new FinalizationHandler(store, undefined);
      (scopedHandler as unknown as {
        verifyOnChain: () => Promise<{ verified: boolean; authorAddress: string; txIndex: number }>;
      }).verifyOnChain = async () => ({ verified: true, authorAddress: AUTHOR, txIndex: 4 });

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

  it('resolves an omitted graph-scoped target context graph id', async () => {
    const { message, vmGraph } = await stageGraph();
    let resolverCalls = 0;
    const resolvingHandler = new FinalizationHandler(
      store,
      undefined,
      undefined,
      async () => {
        resolverCalls += 1;
        return '42';
      },
    );
    (resolvingHandler as unknown as {
      verifyOnChain: () => Promise<{ verified: boolean; authorAddress: string; txIndex: number }>;
    }).verifyOnChain = async () => ({ verified: true, authorAddress: AUTHOR, txIndex: 4 });

    await resolvingHandler.handleFinalizationMessage(
      encodeFinalizationMessage({ ...message, targetContextGraphId: undefined }),
      CG,
    );

    expect(resolverCalls).toBe(1);
    expect(await store.countQuads(vmGraph)).toBe(2);
  });

  it('applies after one transient scheduler timeout without journaling', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-'));
    const query = store.query.bind(store);
    try {
      const { message, vmGraph } = await stageGraph();
      const retryingHandler = new FinalizationHandler(store, undefined);
      (retryingHandler as unknown as {
        verifyOnChain: () => Promise<{ verified: boolean; authorAddress: string; txIndex: number }>;
      }).verifyOnChain = async () => ({ verified: true, authorAddress: AUTHOR, txIndex: 4 });
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
        { recoveryStore: inbox },
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
        { recoveryStore: inbox },
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
        databasePath: inbox.databasePath,
        get closed() { return inbox!.closed; },
        receive: inbox.receive.bind(inbox),
        markVerified: async () => ({ status: 'closed' }),
        listForKnowledgeAsset: inbox.listForKnowledgeAsset.bind(inbox),
        transition: inbox.transition.bind(inbox),
        recordAttempt: inbox.recordAttempt.bind(inbox),
        health: inbox.health.bind(inbox),
        close: inbox.close.bind(inbox),
      };
      const recoveryHandler = new FinalizationHandler(store, chain, {
        recoveryStore: failingVerifiedStore,
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
      const recoveryHandler = new FinalizationHandler(store, chain, { recoveryStore: inbox });
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
      const recoveryHandler = new FinalizationHandler(store, chain, { recoveryStore: inbox });
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

  it('rejects verified recovery when the persisted receipt is no longer canonical', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-'));
    let inbox: SqliteFinalizationRecoveryStore | undefined;
    try {
      const { message } = await stageGraph();
      let receiptCanonical = true;
      let receiptChecks = 0;
      const chain = {
        chainId: 'base:84532',
        getLatestMerkleRoot: async () => message.kcMerkleRoot,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 42n,
        resolveCanonicalFinalizationReceipt: async () => {
          receiptChecks += 1;
          return receiptCanonical
            ? canonicalReceipt(message)
            : { status: 'reorged' as const };
        },
      } as ChainAdapter;
      inbox = await openSqliteFinalizationRecoveryStore(directory);
      const recoveryHandler = new FinalizationHandler(store, chain, { recoveryStore: inbox });

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
      receiptCanonical = false;
      await expect(recoveryHandler.handleChainReconciledKC(
        reconcileInput,
        createOperationContext('system'),
      )).resolves.toBe('verified-vm-metadata-pending');

      expect(receiptChecks).toBeGreaterThanOrEqual(2);
      expect(await inbox.list()).toMatchObject([{
        state: 'REJECTED',
        lastError: 'persisted receipt disagrees with canonical chain truth',
      }]);
      await expect(store.query(
        `ASK { GRAPH <did:dkg:context-graph:${CG}/_meta> { <${UAL}> `
          + `<http://dkg.io/ontology/transactionHash> "${message.txHash}" . } }`,
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
        { recoveryStore: inbox },
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
