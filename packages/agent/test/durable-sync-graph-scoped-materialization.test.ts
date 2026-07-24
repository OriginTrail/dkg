import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import type { OperationContext } from '@origintrail-official/dkg-core';
import {
  EVMChainAdapter,
  type ChainAdapter,
  type EVMAdapterConfig,
} from '@origintrail-official/dkg-chain';
import {
  LOCAL_TRUSTED_KA_CONTROLS_GRAPH,
  OxigraphStore,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
  readGraphKnowledgeAssetConfirmationKindV1,
  replaceLocallyTrustedKnowledgeAssetControls,
  shouldApplyMaterialization,
} from '@origintrail-official/dkg-publisher';
import { processDurableBatchForWire } from '../src/sync-verify-worker-impl.js';
import { runDurableSync } from '../src/sync/requester/durable-sync.js';
import { uniformDurableSyncBudget } from './durable-sync-test-helpers.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { DKGAgent } from '../src/dkg-agent.js';
import {
  authenticateVerifiedGraphScopedAsset,
  materializeVerifiedGraphScopedAsset,
  type GraphScopedMaterializationOutcome,
  type VerifyContextGraphBinding,
  type VerifiedGraphScopedAsset,
} from '../src/sync/requester/graph-scoped-materialization.js';

const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const contextGraphId = 'graph-scoped-sync-materialization';
const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
const assertionGraph = `did:dkg:context-graph:${contextGraphId}/_verifiable_memory/0x1111111111111111111111111111111111111111/1`;
const ual = 'did:dkg:otp:2043/0x1111111111111111111111111111111111111111/1';
const packedKaId = '7719472615821079694904732333912527190217998977704089058462887978021305712641';
const ctx = { kind: 'system', id: 'test', startedAt: 0 } as OperationContext;
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function transactionHash(version: number): string {
  return `0x${version.toString(16).padStart(64, '0')}`;
}

function dataQuad(version: number): Quad {
  return {
    subject: `http://example.com/entity/v${version}`,
    predicate: 'http://example.com/value',
    object: `"v${version}"`,
    graph: assertionGraph,
  };
}

function metadata(version: number, merkleRoot = String(version).padStart(64, '0')): Quad[] {
  return [
    ['contentScopeVersion', '"2"'],
    ['kaUal', ual],
    ['assertionVersion', `"${version}"`],
    ['assertionGraph', assertionGraph],
    ['contextGraph', `did:dkg:context-graph:${contextGraphId}`],
    ['merkleRoot', `"${merkleRoot}"`],
    ['transactionHash', `"${transactionHash(version)}"`],
  ].map(([predicate, object]) => ({
    subject: ual,
    predicate: `${DKG}${predicate}`,
    object,
    graph: metaGraph,
  }));
}

function finalizedMaterializationMetadata(
  version: number,
  merkleRoot: Uint8Array,
): Quad[] {
  return generateGraphKnowledgeAssetMetadata({
    contextGraphId,
    ual,
    merkleRoot,
    publisherPeerId: 'rfc64-finalized-catalog-v1',
    accessPolicy: 'public',
    allowedPeers: [],
    timestamp: new Date('2026-07-16T08:00:00.000Z'),
    assertionVersion: version,
    authorAddress: '0x1111111111111111111111111111111111111111',
    publicTripleCount: 1,
    privateTripleCount: 0,
    assertionGraph,
  }, {
    status: 'confirmed',
    confirmation: {
      kind: 'finalized-materialization',
      provenance: {
        batchId: BigInt(packedKaId),
        materializedVersion: { blockNumber: 123, txIndex: 0 },
      },
    },
  });
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function page(phase: 'data' | 'meta', quads: Quad[]): SyncPageResult {
  return {
    quads,
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: quads.length,
    checkpointKey: `${contextGraphId}:${phase}`,
    completed: true,
    timedOut: false,
  };
}

function localControlQuad(entry: string, predicate: string, object: string): Quad {
  return {
    subject: entry,
    predicate: `${DKG}${predicate}`,
    object,
    graph: LOCAL_TRUSTED_KA_CONTROLS_GRAPH,
  };
}

async function values(store: OxigraphStore, predicate: string): Promise<string[]> {
  const result = await store.query(`
    SELECT ?value WHERE {
      GRAPH <${metaGraph}> {
        <${ual}> <${DKG}${predicate}> ?value .
      }
    }
  `);
  if (result.type !== 'bindings') return [];
  return result.bindings.map((row) => row.value).sort();
}

async function graphQuads(store: OxigraphStore, graph: string): Promise<Quad[]> {
  const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  if (result.type !== 'bindings') return [];
  return result.bindings.map((row) => ({
    subject: row.s!,
    predicate: row.p!,
    object: row.o!,
    graph,
  }));
}

function strictContextGraphBindingVerifier(
  chain: ChainAdapter,
  wireKeyedLocalIds: string[] = [],
): VerifyContextGraphBinding {
  const subscribedContextGraphs = new Map<string, { onChainHash: string }>();
  const wireIdToLocalCgId = new Map<string, string>();
  for (const localId of wireKeyedLocalIds) {
    const lower = localId.toLowerCase();
    subscribedContextGraphs.set(localId, { onChainHash: lower });
    wireIdToLocalCgId.set(lower, localId);
  }
  const agentLike: any = {
    chain,
    subscribedContextGraphs,
    wireIdToLocalCgId,
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  };
  agentLike.isWireIdKeyedSubscription = (DKGAgent.prototype as any).isWireIdKeyedSubscription;
  agentLike.raceChainPolicyRead = (DKGAgent.prototype as any).raceChainPolicyRead;
  return (localId, onChainId, signal) => (
    DKGAgent.prototype as any
  ).requireLocalCgMatchesOnChainSlot.call(
    agentLike,
    localId,
    onChainId.toString(),
    ctx,
    { signal },
  );
}

function authenticatedV2Chain(overrides: Partial<ChainAdapter> = {}): ChainAdapter {
  const root = new Uint8Array(32);
  root[31] = 2;
  return {
    chainId: 'otp:2043',
    getLatestMerkleRoot: async () => root,
    getMerkleRootCount: async () => 2n,
    getKAContextGraphId: async () => 14n,
    getLatestMerkleRootPublisher: async () => '0x2222222222222222222222222222222222222222',
    verifyKAUpdate: async () => ({
      verified: true,
      onChainMerkleRoot: root,
      blockNumber: 123,
      txIndex: 4,
      merkleRootCount: 2n,
    }),
    ...overrides,
  } as ChainAdapter;
}

function runGraphScopedDurableSync(options: {
  storeGraphScopedAsset: (
    asset: VerifiedGraphScopedAsset,
    deadline: number,
  ) => Promise<GraphScopedMaterializationOutcome>;
  deleteCheckpoint?: (key: string) => void;
  setCheckpoint?: (key: string, offset: number) => void;
  logWarn?: (ctx: OperationContext, message: string) => void;
}) {
  const v2Data = dataQuad(2);
  const v2Meta = metadata(2);
  return runDurableSync({
    ctx,
    remotePeerId: 'peer-graph-scoped-authentication',
    contextGraphIds: [contextGraphId],
    durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
    fetchSyncPages: async (_ctx, _peer, _cg, _shared, phase) => (
      phase === 'data' ? page(phase, [v2Data]) : page(phase, v2Meta)
    ),
    processDurableBatchInWorker: async () => ({
      verifiedData: [v2Data],
      verifiedMeta: v2Meta,
      verifiedGraphScopedDataGraphs: [assertionGraph],
      totalFetchedDataQuads: 1,
      totalFetchedMetaQuads: v2Meta.length,
      rejectedKcs: 0,
      emptyResponses: 0,
      metaOnlyResponses: 0,
      verifiedPrivateOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    }),
    storeInsert: async () => {},
    storeGraphScopedAsset: options.storeGraphScopedAsset,
    deleteCheckpoint: options.deleteCheckpoint ?? (() => {}),
    setCheckpoint: options.setCheckpoint ?? (() => {}),
    logInfo: () => {},
    logWarn: options.logWarn ?? (() => {}),
    logDebug: () => {},
  });
}

describe('durable graph-scoped KA materialization', () => {
  it('adds reader-visible local metadata in no-chain mode and keeps receive time stable on replay', async () => {
    const store = new OxigraphStore();
    const asset = {
      contextGraphId,
      ual,
      assertionVersion: 1n,
      assertionGraph,
      metaGraph,
      dataQuads: [dataQuad(1)],
      metadataQuads: metadata(1),
    };
    const noChain = { chainId: 'none' } as ChainAdapter;
    const firstReceivedAt = new Date('2026-07-16T08:00:00.000Z');
    const authenticated = await authenticateVerifiedGraphScopedAsset(
      noChain,
      asset,
      undefined,
      firstReceivedAt,
    );

    await expect(materializeVerifiedGraphScopedAsset({ store, asset: authenticated.asset }))
      .resolves.toBe('applied');
    expect(await values(store, 'status')).toEqual(['"tentative"']);
    expect(await values(store, 'publishedAt')).toEqual([
      `"2026-07-16T08:00:00Z"^^<${XSD_DATE_TIME}>`,
    ]);
    const visible = await store.query(`ASK { GRAPH <${metaGraph}> {
      <${ual}> <${DKG}status> ?status ; <${DKG}publishedAt> ?publishedAt .
      FILTER(?status IN ("confirmed", "tentative"))
    } }`);
    expect(visible).toEqual({ type: 'boolean', value: true });

    const replayed = await authenticateVerifiedGraphScopedAsset(
      noChain,
      asset,
      undefined,
      new Date('2026-07-16T09:00:00.000Z'),
    );
    await expect(materializeVerifiedGraphScopedAsset({ store, asset: replayed.asset }))
      .resolves.toBe('applied');
    expect(await values(store, 'publishedAt')).toEqual([
      `"2026-07-16T08:00:00Z"^^<${XSD_DATE_TIME}>`,
    ]);
  });

  it('authenticates a cold-join CG directly from its chain-committed name hash', async () => {
    const root = new Uint8Array(32);
    root[31] = 2;
    const nameHashReads: bigint[] = [];
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash: async (onChainId: bigint) => {
        nameHashReads.push(onChainId);
        return ethers.keccak256(ethers.toUtf8Bytes(contextGraphId));
      },
      getLatestMerkleRootPublisher: async () => '0x2222222222222222222222222222222222222222',
      verifyKAUpdate: async () => ({
        verified: true,
        onChainMerkleRoot: root,
        blockNumber: 123,
        txIndex: 4,
        merkleRootCount: 2n,
      }),
    } as ChainAdapter;
    const authenticated = await authenticateVerifiedGraphScopedAsset(
      chain,
      {
        contextGraphId,
        ual,
        assertionVersion: 2n,
        assertionGraph,
        metaGraph,
        dataQuads: [dataQuad(2)],
        metadataQuads: metadata(2),
      },
      strictContextGraphBindingVerifier(chain),
      new Date('2026-07-16T08:30:00.000Z'),
    );

    expect(nameHashReads).toEqual([14n]);
    expect(authenticated.onChainContextGraphId).toBe('14');
    expect(authenticated.asset.metadataQuads).toContainEqual(expect.objectContaining({
      predicate: `${DKG}status`,
      object: '"confirmed"',
    }));
  });

  it('preserves a typed receipt transport failure from the concrete EVM update verifier', async () => {
    const root = new Uint8Array(32);
    root[31] = 2;
    const transportError = Object.assign(
      new Error('receipt providers unavailable'),
      { code: 'RPC_RECEIPT_LOOKUP_FAILED' },
    );
    const config: EVMAdapterConfig = {
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: TEST_PRIVATE_KEY,
      hubAddress: '0x0000000000000000000000000000000000000001',
      chainId: 'otp:2043',
      allowNoAdminSigner: true,
    };
    const chain: any = new EVMChainAdapter(config);
    chain.initialized = true;
    chain.init = async () => {};
    chain.getLatestMerkleRoot = async () => root;
    chain.getMerkleRootCount = async () => 2n;
    chain.getKAContextGraphId = async () => 14n;
    chain.getLatestMerkleRootPublisher = async () => (
      '0x2222222222222222222222222222222222222222'
    );
    chain.contracts.knowledgeAssetStorage = {};
    chain.getTransactionReceiptWithFailover = async () => { throw transportError; };

    try {
      await expect(authenticateVerifiedGraphScopedAsset(
        chain,
        {
          contextGraphId,
          ual,
          assertionVersion: 2n,
          assertionGraph,
          metaGraph,
          dataQuads: [dataQuad(2)],
          metadataQuads: metadata(2),
        },
        async () => true,
      )).rejects.toBe(transportError);
    } finally {
      chain.destroy();
    }
  });

  it('authenticates finalized materialization from independent chain state without a receipt claim', async () => {
    const v2Data = dataQuad(2);
    const root = computeFlatKCRootV10([v2Data], []);
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash: async () => ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)),
      resolvePublishByTxHash: async () => {
        throw new Error('receipt lookup must not run for finalized materialization');
      },
      verifyKAUpdate: async () => {
        throw new Error('receipt lookup must not run for finalized materialization');
      },
    } as ChainAdapter;

    const authenticated = await authenticateVerifiedGraphScopedAsset(
      chain,
      {
        contextGraphId,
        ual,
        assertionVersion: 2n,
        assertionGraph,
        metaGraph,
        dataQuads: [v2Data],
        metadataQuads: finalizedMaterializationMetadata(2, root),
      },
      strictContextGraphBindingVerifier(chain),
      new Date('2026-07-16T08:30:00.000Z'),
    );

    expect(authenticated.onChainContextGraphId).toBe('14');
    expect(authenticated.asset.metadataQuads).not.toContainEqual(expect.objectContaining({
      predicate: `${DKG}transactionHash`,
    }));
    expect(authenticated.asset.metadataQuads.filter(
      (quad) => quad.predicate === `${DKG}materializedVersion`,
    )).toEqual([expect.objectContaining({ object: '"0:0"' })]);
  });

  it('rejects receipt-backed graph metadata when its transaction claim is missing', async () => {
    const v2Data = dataQuad(2);
    const root = computeFlatKCRootV10([v2Data], []);
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash: async () => ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)),
    } as ChainAdapter;

    await expect(authenticateVerifiedGraphScopedAsset(
      chain,
      {
        contextGraphId,
        ual,
        assertionVersion: 2n,
        assertionGraph,
        metaGraph,
        dataQuads: [v2Data],
        metadataQuads: metadata(2, toHex(root)).filter(
          (quad) => quad.predicate !== `${DKG}transactionHash`,
        ),
      },
      strictContextGraphBindingVerifier(chain),
    )).rejects.toMatchObject({ code: 'VM_CHAIN_PROVENANCE_MISMATCH' });
  });

  it('fails closed when the bound CG commits a different name hash', async () => {
    const root = new Uint8Array(32);
    root[31] = 2;
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash: async () => ethers.keccak256(
        ethers.toUtf8Bytes('different-context-graph'),
      ),
    } as ChainAdapter;

    await expect(authenticateVerifiedGraphScopedAsset(chain, {
      contextGraphId,
      ual,
      assertionVersion: 2n,
      assertionGraph,
      metaGraph,
      dataQuads: [dataQuad(2)],
      metadataQuads: metadata(2),
    }, strictContextGraphBindingVerifier(chain))).rejects.toMatchObject({
      code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH',
    });
  });

  it('fails closed when the bound CG has no committed name hash', async () => {
    const root = new Uint8Array(32);
    root[31] = 2;
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash: async () => null,
    } as ChainAdapter;

    await expect(authenticateVerifiedGraphScopedAsset(chain, {
      contextGraphId,
      ual,
      assertionVersion: 2n,
      assertionGraph,
      metaGraph,
      dataQuads: [dataQuad(2)],
      metadataQuads: metadata(2),
    }, strictContextGraphBindingVerifier(chain))).rejects.toMatchObject({
      code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH',
    });
  });

  it('does not treat a zero-padded numeric local id as a direct slot address', async () => {
    const root = new Uint8Array(32);
    root[31] = 2;
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash: async () => ethers.keccak256(
        ethers.toUtf8Bytes('different-context-graph'),
      ),
    } as ChainAdapter;

    await expect(authenticateVerifiedGraphScopedAsset(chain, {
      contextGraphId: '0014',
      ual,
      assertionVersion: 2n,
      assertionGraph,
      metaGraph,
      dataQuads: [dataQuad(2)],
      metadataQuads: metadata(2),
    }, strictContextGraphBindingVerifier(chain))).rejects.toMatchObject({
      code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH',
    });
  });

  it('accepts a locally proven wire-id keyed subscription without double hashing it', async () => {
    const root = new Uint8Array(32);
    root[31] = 2;
    const wireId = `0x${'ab'.repeat(32)}`;
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash: async () => wireId,
      getLatestMerkleRootPublisher: async () => '0x2222222222222222222222222222222222222222',
      verifyKAUpdate: async () => ({
        verified: true,
        onChainMerkleRoot: root,
        blockNumber: 123,
        txIndex: 4,
        merkleRootCount: 2n,
      }),
    } as ChainAdapter;

    const authenticated = await authenticateVerifiedGraphScopedAsset(chain, {
      contextGraphId: wireId,
      ual,
      assertionVersion: 2n,
      assertionGraph,
      metaGraph,
      dataQuads: [dataQuad(2)],
      metadataQuads: metadata(2),
    }, strictContextGraphBindingVerifier(chain, [wireId]));

    expect(authenticated.onChainContextGraphId).toBe('14');
  });

  it('accepts only the canonical decimal spelling as a direct slot address', async () => {
    const root = new Uint8Array(32);
    root[31] = 2;
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getLatestMerkleRootPublisher: async () => '0x2222222222222222222222222222222222222222',
      verifyKAUpdate: async () => ({
        verified: true,
        onChainMerkleRoot: root,
        blockNumber: 123,
        txIndex: 4,
        merkleRootCount: 2n,
      }),
    } as ChainAdapter;

    const authenticated = await authenticateVerifiedGraphScopedAsset(chain, {
      contextGraphId: '14',
      ual,
      assertionVersion: 2n,
      assertionGraph,
      metaGraph,
      dataQuads: [dataQuad(2)],
      metadataQuads: metadata(2),
    }, strictContextGraphBindingVerifier(chain));

    expect(authenticated.onChainContextGraphId).toBe('14');
  });

  it('does not mistake a lifecycle assertionGraph pointer for a second UAL owner', async () => {
    const v2Data = dataQuad(1);
    const root = toHex(computeFlatKCRootV10([v2Data], []));
    const v2Meta = metadata(1, root);
    v2Meta.push(
      {
        subject: ual,
        predicate: `${DKG}publicTripleCount`,
        object: `"1"^^<${XSD_INTEGER}>`,
        graph: metaGraph,
      },
      {
        subject: ual,
        predicate: `${DKG}privateTripleCount`,
        object: `"0"^^<${XSD_INTEGER}>`,
        graph: metaGraph,
      },
    );
    const lifecycle = `${ual}/assertion/1`;
    const lifecycleRows: Quad[] = [
      ['contentScopeVersion', `"2"^^<${XSD_INTEGER}>`],
      ['kaUal', ual],
      ['assertionVersion', `"1"^^<${XSD_INTEGER}>`],
      ['assertionGraph', assertionGraph],
    ].map(([predicate, object]) => ({
      subject: lifecycle,
      predicate: `${DKG}${predicate}`,
      object,
      graph: metaGraph,
    }));
    const assets: Parameters<typeof materializeVerifiedGraphScopedAsset>[0]['asset'][] = [];
    const inserted: Quad[] = [];

    await runDurableSync({
      ctx,
      remotePeerId: 'peer-lifecycle-pointer',
      contextGraphIds: [contextGraphId],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 10_000),
      fetchSyncPages: async (_ctx, _peer, _cg, _shared, phase) => (
        phase === 'data'
          ? page(phase, [v2Data])
          : page(phase, [...v2Meta, ...lifecycleRows])
      ),
      processDurableBatchInWorker: async () => ({
        verifiedData: [v2Data],
        verifiedMeta: [...v2Meta, ...lifecycleRows],
        verifiedGraphScopedDataGraphs: [assertionGraph],
        totalFetchedDataQuads: 1,
        totalFetchedMetaQuads: v2Meta.length + lifecycleRows.length,
        rejectedKcs: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        verifiedPrivateOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
      }),
      storeInsert: async (quads) => { inserted.push(...quads); },
      storeGraphScopedAsset: async (asset) => {
        assets.push(asset);
        return 'applied';
      },
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      ual,
      assertionGraph,
    });
    expect(readGraphKnowledgeAssetConfirmationKindV1(assets[0]!.metadataQuads))
      .toBe('transaction');
    expect(inserted.filter((quad) => quad.subject === lifecycle)).toEqual(
      lifecycleRows.filter((quad) => quad.predicate !== `${DKG}assertionVersion`),
    );
  });

  it.each([
    ['conflicting', ['"transaction"', '"finalized-materialization"']],
    ['unsupported', ['"unsupported"']],
  ])('rejects %s peer confirmation metadata before durable materialization', async (_label, kinds) => {
    const v2Data = dataQuad(2);
    const v2Meta = metadata(2);
    v2Meta.push(
      {
        subject: ual,
        predicate: `${DKG}publicTripleCount`,
        object: `"1"^^<${XSD_INTEGER}>`,
        graph: metaGraph,
      },
      {
        subject: ual,
        predicate: `${DKG}privateTripleCount`,
        object: `"0"^^<${XSD_INTEGER}>`,
        graph: metaGraph,
      },
      ...kinds.map((object) => ({
        subject: ual,
        predicate: `${DKG}confirmationKind`,
        object,
        graph: metaGraph,
      })),
    );
    const materialized: unknown[] = [];

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-invalid-confirmation-kind',
      contextGraphIds: [contextGraphId],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 10_000),
      fetchSyncPages: async (_ctx, _peer, _cg, _shared, phase) => (
        phase === 'data' ? page(phase, [v2Data]) : page(phase, v2Meta)
      ),
      processDurableBatchInWorker: async () => ({
        verifiedData: [v2Data],
        verifiedMeta: v2Meta,
        verifiedGraphScopedDataGraphs: [assertionGraph],
        totalFetchedDataQuads: 1,
        totalFetchedMetaQuads: v2Meta.length,
        rejectedKcs: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        verifiedPrivateOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
      }),
      storeInsert: async () => {},
      storeGraphScopedAsset: async (asset) => {
        materialized.push(asset);
        return 'applied';
      },
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.failedPhases).toBe(1);
    expect(summary.insertedTriples).toBe(0);
    expect(materialized).toEqual([]);
  });

  it('replaces a poisoned v1 union with the verified v2 assertion and metadata', async () => {
    const store = new OxigraphStore();
    const v1Data = dataQuad(1);
    const v2Data = dataQuad(2);
    const v1Meta = metadata(1);
    const v2Root = computeFlatKCRootV10([v2Data], []);
    const v2RootHex = toHex(v2Root);
    const v2Meta = metadata(2, v2RootHex);
    v2Meta.push(
      {
        subject: ual,
        predicate: `${DKG}publicTripleCount`,
        object: `"1"^^<${XSD_INTEGER}>`,
        graph: metaGraph,
      },
      {
        subject: ual,
        predicate: `${DKG}privateTripleCount`,
        object: `"0"^^<${XSD_INTEGER}>`,
        graph: metaGraph,
      },
    );
    const peerControlMarker: Quad = {
      subject: ual,
      predicate: `${DKG}materializedVersion`,
      object: '"999999999:0"',
      graph: metaGraph,
    };
    const peerBatchId: Quad = {
      subject: ual,
      predicate: `${DKG}batchId`,
      object: `"999"^^<${XSD_INTEGER}>`,
      graph: metaGraph,
    };
    const unrelatedPeerControls: Quad[] = [
      {
        subject: 'did:dkg:otp:2043/0x2222222222222222222222222222222222222222/99',
        predicate: `${DKG}materializedVersion`,
        object: '"999999999:0"',
        graph: metaGraph,
      },
      {
        subject: 'did:dkg:otp:2043/0x2222222222222222222222222222222222222222/99',
        predicate: `${DKG}assertionVersion`,
        object: '"999999999"',
        graph: metaGraph,
      },
      ...[
        ['accessPolicy', '"allowList"'],
        ['allowedPeer', '"attacker-peer"'],
        ['publisherPeerId', '"attacker-peer"'],
        ['status', '"confirmed"'],
      ].map(([predicate, object]) => ({
        subject: 'did:dkg:otp:2043/0x2222222222222222222222222222222222222222/99',
        predicate: `${DKG}${predicate}`,
        object,
        graph: metaGraph,
      })),
    ];
    const peerAclInjection: Quad[] = [
      ['accessPolicy', '"allowList"'],
      ['allowedPeer', '"attacker-peer"'],
      ['publisherPeerId', '"attacker-peer"'],
      ['status', '"tentative"'],
    ].map(([predicate, object]) => ({
      subject: ual,
      predicate: `${DKG}${predicate}`,
      object,
      graph: metaGraph,
    }));
    // Reproduce the durable requester's former poisoned state: the first
    // update was appended to the version-independent graph and UAL subject.
    await store.insert([
      v1Data,
      v2Data,
      ...v1Meta,
      ...v2Meta,
      peerControlMarker,
      ...peerAclInjection,
    ]);

    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => v2Root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 1n,
      getContextGraphNameHash: async () => ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)),
      getLatestMerkleRootPublisher: async () => '0x2222222222222222222222222222222222222222',
      verifyKAUpdate: async () => ({
        verified: true,
        onChainMerkleRoot: v2Root,
        blockNumber: 123,
        txIndex: 4,
        merkleRootCount: 2n,
      }),
    } as ChainAdapter;
    const storeHooks = {
      storeInsert: (quads: Quad[]) => store.insert(quads),
      storeGraphScopedAsset: async (
        asset: Parameters<typeof materializeVerifiedGraphScopedAsset>[0]['asset'],
      ) => materializeVerifiedGraphScopedAsset({
        store,
        asset: (await authenticateVerifiedGraphScopedAsset(
          chain,
          asset,
          strictContextGraphBindingVerifier(chain),
          new Date('2026-07-16T08:30:00.000Z'),
        )).asset,
      }),
    };

    await runDurableSync({
      ctx,
      remotePeerId: 'peer-v2',
      contextGraphIds: [contextGraphId],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 10_000),
      fetchSyncPages: async (_ctx, _peer, _cg, _shared, phase) => (
        phase === 'data'
          ? page(phase, [v2Data])
          : page(phase, [
              ...v2Meta,
              peerBatchId,
              peerControlMarker,
              ...unrelatedPeerControls,
              ...peerAclInjection,
            ])
      ),
      processDurableBatchInWorker: async () => ({
        verifiedData: [v2Data],
        verifiedMeta: [
          ...v2Meta,
          peerBatchId,
          peerControlMarker,
          ...unrelatedPeerControls,
          ...peerAclInjection,
        ],
        verifiedGraphScopedDataGraphs: [assertionGraph],
        totalFetchedDataQuads: 1,
        totalFetchedMetaQuads:
          v2Meta.length + 2 + unrelatedPeerControls.length + peerAclInjection.length,
        rejectedKcs: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        verifiedPrivateOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
      }),
      ...storeHooks,
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    const data = await store.query(`SELECT ?s WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`);
    expect(data.type).toBe('bindings');
    expect(data.type === 'bindings' ? data.bindings.map((row) => row.s) : []).toEqual([v2Data.subject]);
    expect(await values(store, 'assertionVersion')).toEqual(['"2"']);
    expect(await values(store, 'merkleRoot')).toEqual([`"${v2RootHex}"`]);
    expect(await values(store, 'batchId')).toEqual([
      `"${packedKaId}"^^<${XSD_INTEGER}>`,
    ]);
    expect(await values(store, 'status')).toEqual(['"confirmed"']);
    expect(await values(store, 'publishedAt')).toEqual([
      `"2026-07-16T08:30:00Z"^^<${XSD_DATE_TIME}>`,
    ]);
    expect(await values(store, 'transactionHash')).toEqual([`"${transactionHash(2)}"`]);
    expect(await values(store, 'materializedVersion')).toEqual(['"123:4"']);
    const unrelatedControls = await store.query(`
      ASK { GRAPH <${metaGraph}> {
        <${unrelatedPeerControls[0]!.subject}> ?p ?o
      } }
    `);
    expect(unrelatedControls).toEqual({ type: 'boolean', value: false });
    const aclControls = await store.query(`
      ASK { GRAPH <${metaGraph}> {
        <${ual}> ?p ?o .
        VALUES ?p {
          <${DKG}accessPolicy>
          <${DKG}allowedPeer>
          <${DKG}publisherPeerId>
        }
      } }
    `);
    expect(aclControls).toEqual({ type: 'boolean', value: false });
    const storedData = await graphQuads(store, assertionGraph);
    const storedMeta = await graphQuads(store, metaGraph);
    const secondHop = processDurableBatchForWire(
      storedData,
      storedMeta,
      false,
      { kind: 'sinceBatchId', sinceBatchId: (BigInt(packedKaId) - 1n).toString() },
    );
    expect(secondHop.rejectedKcs, JSON.stringify(secondHop.logs)).toBe(0);
    expect(secondHop.verifiedGraphScopedDataGraphs).toEqual([assertionGraph]);
    const alreadyCurrent = processDurableBatchForWire(
      [],
      storedMeta,
      false,
      { kind: 'sinceBatchId', sinceBatchId: packedKaId },
    );
    expect(alreadyCurrent.rejectedKcs).toBe(0);
    expect(alreadyCurrent.verifiedDataIndexes).toEqual([]);
    expect(alreadyCurrent.verifiedMetaIndexes).toEqual([]);
    await expect(shouldApplyMaterialization(
      store,
      metaGraph,
      ual,
      { blockNumber: 0, txIndex: 0 },
      1n,
    )).resolves.toBe(false);
  });

  it('syncs a finalized-materialized VM asset from one node store into a fresh requester', async () => {
    const sourceNodeStore = new OxigraphStore();
    const freshRequesterStore = new OxigraphStore();
    const v2Data = dataQuad(2);
    const root = computeFlatKCRootV10([v2Data], []);
    const sourceMetadata = finalizedMaterializationMetadata(2, root);
    await sourceNodeStore.insert([v2Data, ...sourceMetadata]);
    const servedData = await graphQuads(sourceNodeStore, assertionGraph);
    const servedMeta = await graphQuads(sourceNodeStore, metaGraph);
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash: async () => ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)),
    } as ChainAdapter;

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'finalized-vm-source-node',
      contextGraphIds: [contextGraphId],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 10_000),
      fetchSyncPages: async (_ctx, _peer, _cg, _shared, phase) => (
        phase === 'data' ? page(phase, servedData) : page(phase, servedMeta)
      ),
      processDurableBatchInWorker: async (dataQuads, metaQuads, _ctx, acceptUnverified, mode) => {
        const verified = processDurableBatchForWire(
          dataQuads,
          metaQuads,
          acceptUnverified,
          mode,
        );
        return {
          ...verified,
          verifiedData: verified.verifiedDataIndexes.map((index) => dataQuads[index]!),
          verifiedMeta: verified.verifiedMetaIndexes.map((index) => metaQuads[index]!),
        };
      },
      storeInsert: (quads) => freshRequesterStore.insert(quads),
      storeGraphScopedAsset: async (asset) => materializeVerifiedGraphScopedAsset({
        store: freshRequesterStore,
        asset: (await authenticateVerifiedGraphScopedAsset(
          chain,
          asset,
          strictContextGraphBindingVerifier(chain),
          new Date('2026-07-16T09:00:00.000Z'),
        )).asset,
      }),
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.failedPeers).toBe(0);
    expect(summary.failedPhases).toBe(0);
    expect(summary.insertedDataTriples).toBe(1);
    expect(await graphQuads(freshRequesterStore, assertionGraph)).toEqual(servedData);
    expect(await values(freshRequesterStore, 'status')).toEqual(['"confirmed"']);
    expect(await values(freshRequesterStore, 'transactionHash')).toEqual([]);
    // The requester never accepts the serving node's 123:0 local ordering
    // claim; it derives a neutral local stamp after chain authentication.
    expect(await values(freshRequesterStore, 'materializedVersion')).toEqual(['"0:0"']);
  });

  it('does not downgrade same-version local receipt provenance during finalized durable replay', async () => {
    const sourceNodeStore = new OxigraphStore();
    const requesterStore = new OxigraphStore();
    const v2Data = dataQuad(2);
    const root = computeFlatKCRootV10([v2Data], []);
    const sourceMetadata = finalizedMaterializationMetadata(2, root);
    await sourceNodeStore.insert([v2Data, ...sourceMetadata]);
    await requesterStore.insert([
      dataQuad(1),
      ...metadata(2, toHex(root)),
      ...[
        ['publicTripleCount', `"1"^^<${XSD_INTEGER}>`],
        ['privateTripleCount', `"0"^^<${XSD_INTEGER}>`],
        ['status', '"confirmed"'],
        ['publishedAt', `"2026-07-16T08:00:00.000Z"^^<${XSD_DATE_TIME}>`],
        ['materializedVersion', '"456:7"'],
      ].map(([predicate, object]) => ({
        subject: ual,
        predicate: `${DKG}${predicate}`,
        object,
        graph: metaGraph,
      })),
    ]);
    const servedData = await graphQuads(sourceNodeStore, assertionGraph);
    const servedMeta = await graphQuads(sourceNodeStore, metaGraph);
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash: async () => ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)),
    } as ChainAdapter;

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'finalized-vm-replay-source',
      contextGraphIds: [contextGraphId],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 10_000),
      fetchSyncPages: async (_ctx, _peer, _cg, _shared, phase) => (
        phase === 'data' ? page(phase, servedData) : page(phase, servedMeta)
      ),
      processDurableBatchInWorker: async (dataQuads, metaQuads, _ctx, acceptUnverified, mode) => {
        const verified = processDurableBatchForWire(
          dataQuads,
          metaQuads,
          acceptUnverified,
          mode,
        );
        return {
          ...verified,
          verifiedData: verified.verifiedDataIndexes.map((index) => dataQuads[index]!),
          verifiedMeta: verified.verifiedMetaIndexes.map((index) => metaQuads[index]!),
        };
      },
      storeInsert: (quads) => requesterStore.insert(quads),
      storeGraphScopedAsset: async (asset) => materializeVerifiedGraphScopedAsset({
        store: requesterStore,
        asset: (await authenticateVerifiedGraphScopedAsset(
          chain,
          asset,
          strictContextGraphBindingVerifier(chain),
        )).asset,
      }),
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.failedPhases).toBe(0);
    expect(await graphQuads(requesterStore, assertionGraph)).toEqual(servedData);
    expect(await values(requesterStore, 'transactionHash')).toEqual([`"${transactionHash(2)}"`]);
    expect(await values(requesterStore, 'confirmationKind')).toEqual(['"transaction"']);
    expect(await values(requesterStore, 'materializedVersion')).toEqual(['"456:7"']);
    expect(await values(requesterStore, 'publishedAt')).toEqual([
      `"2026-07-16T08:00:00Z"^^<${XSD_DATE_TIME}>`,
    ]);
  });

  it('does not let a stale durable page replace a newer local assertion', async () => {
    const store = new OxigraphStore();
    const v1Data = dataQuad(1);
    const v2Data = dataQuad(2);
    const v1Meta = metadata(1);
    const v2Meta = metadata(2);
    await store.insert([v2Data, ...v2Meta]);

    const outcome = await materializeVerifiedGraphScopedAsset({
      store,
      asset: {
        contextGraphId,
        ual,
        assertionVersion: 1n,
        assertionGraph,
        metaGraph,
        dataQuads: [v1Data],
        metadataQuads: v1Meta,
      },
    });

    expect(outcome).toBe('stale');
    const data = await store.query(`SELECT ?s WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`);
    expect(data.type === 'bindings' ? data.bindings.map((row) => row.s) : []).toEqual([v2Data.subject]);
    expect(await values(store, 'assertionVersion')).toEqual(['"2"']);
  });

  it('preserves verified legacy metadata alongside a V2 exact replacement', async () => {
    const legacyUal = 'did:dkg:legacy:read-only/1';
    const legacyMeta: Quad[] = [
      ['merkleRoot', `"${'ab'.repeat(32)}"`],
      ['rootEntity', 'urn:legacy:root'],
      ['batchId', `"41"^^<${XSD_INTEGER}>`],
      ['status', '"confirmed"'],
      ['accessPolicy', '"public"'],
      ['publisherPeerId', '"legacy-publisher"'],
    ].map(([predicate, object]) => ({
      subject: legacyUal,
      predicate: `${DKG}${predicate}`,
      object,
      graph: metaGraph,
    }));
    const v2Data = dataQuad(2);
    const v2Meta = metadata(2);
    const inserted: Quad[] = [];
    const exactAssets: unknown[] = [];

    await runDurableSync({
      ctx,
      remotePeerId: 'peer-mixed',
      contextGraphIds: [contextGraphId],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 10_000),
      fetchSyncPages: async (_ctx, _peer, _cg, _shared, phase) => (
        phase === 'data'
          ? page(phase, [v2Data])
          : page(phase, [...v2Meta, ...legacyMeta])
      ),
      processDurableBatchInWorker: async () => ({
        verifiedData: [v2Data],
        verifiedMeta: [...v2Meta, ...legacyMeta],
        verifiedGraphScopedDataGraphs: [assertionGraph],
        totalFetchedDataQuads: 1,
        totalFetchedMetaQuads: v2Meta.length + legacyMeta.length,
        rejectedKcs: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        verifiedPrivateOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
      }),
      storeInsert: async (quads) => { inserted.push(...quads); },
      storeGraphScopedAsset: async (asset) => {
        exactAssets.push(asset);
        return 'applied';
      },
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(exactAssets).toHaveLength(1);
    expect(inserted.filter((quad) => quad.subject === legacyUal)).toEqual(legacyMeta);
  });

  it('rejects a peer assertion version that does not match chain root history', async () => {
    const asset = {
      contextGraphId,
      ual,
      assertionVersion: 999_999_999n,
      assertionGraph,
      metaGraph,
      dataQuads: [dataQuad(2)],
      metadataQuads: metadata(2).map((quad) => (
        quad.predicate === `${DKG}assertionVersion`
          ? { ...quad, object: '"999999999"' }
          : quad
      )),
    };
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => {
        const root = new Uint8Array(32);
        root[31] = 2;
        return root;
      },
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 1n,
    } as ChainAdapter;

    await expect(authenticateVerifiedGraphScopedAsset(
      chain,
      asset,
      strictContextGraphBindingVerifier(chain),
    )).rejects.toMatchObject({
      code: 'VM_CHAIN_ASSERTION_VERSION_MISMATCH',
    });
  });

  it('rejects a valid-root KA replayed into a different context graph', async () => {
    const asset = {
      contextGraphId,
      ual,
      assertionVersion: 2n,
      assertionGraph,
      metaGraph,
      dataQuads: [dataQuad(2)],
      metadataQuads: metadata(2),
    };
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => {
        const root = new Uint8Array(32);
        root[31] = 2;
        return root;
      },
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 2n,
      getContextGraphNameHash: async () => ethers.keccak256(
        ethers.toUtf8Bytes('different-context-graph'),
      ),
    } as ChainAdapter;

    await expect(authenticateVerifiedGraphScopedAsset(
      chain,
      asset,
      strictContextGraphBindingVerifier(chain),
    )).rejects.toMatchObject({ code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH' });
  });

  it('clears prior public data when the verified update is private-only', async () => {
    const store = new OxigraphStore();
    const v1Data = dataQuad(1);
    const v2Meta = metadata(2);
    await store.insert([v1Data, ...metadata(1)]);

    const outcome = await materializeVerifiedGraphScopedAsset({
      store,
      asset: {
        contextGraphId,
        ual,
        assertionVersion: 2n,
        assertionGraph,
        metaGraph,
        dataQuads: [],
        metadataQuads: v2Meta,
      },
    });

    expect(outcome).toBe('applied');
    expect(await store.countQuads(assertionGraph)).toBe(0);
    expect(await values(store, 'assertionVersion')).toEqual(['"2"']);
  });

  it('preserves locally trusted access metadata during exact replacement', async () => {
    const store = new OxigraphStore();
    const trustedMetadata: Quad[] = [
      ['accessPolicy', '"allowList"'],
      ['allowedPeer', '"trusted-peer"'],
      ['publisherPeerId', '"owner-peer"'],
    ].map(([predicate, object]) => ({
      subject: ual,
      predicate: `${DKG}${predicate}`,
      object,
      graph: metaGraph,
    }));
    const persistedPeerPoison: Quad[] = [
      ['accessPolicy', '"allowList"'],
      ['allowedPeer', '"attacker-peer"'],
      ['publisherPeerId', '"attacker-peer"'],
      ['materializedVersion', '"999999999:0"'],
    ].map(([predicate, object]) => ({
      subject: ual,
      predicate: `${DKG}${predicate}`,
      object,
      graph: metaGraph,
    }));
    await store.insert([dataQuad(1), ...metadata(1), ...persistedPeerPoison]);
    await replaceLocallyTrustedKnowledgeAssetControls(
      store,
      ual,
      [...metadata(1), ...trustedMetadata],
    );

    const outcome = await materializeVerifiedGraphScopedAsset({
      store,
      asset: {
        contextGraphId,
        ual,
        assertionVersion: 2n,
        assertionGraph,
        metaGraph,
        dataQuads: [dataQuad(2)],
        metadataQuads: metadata(2),
      },
    });

    expect(outcome).toBe('applied');
    expect(await values(store, 'accessPolicy')).toEqual(['"allowList"']);
    expect(await values(store, 'allowedPeer')).toEqual(['"trusted-peer"']);
    expect(await values(store, 'publisherPeerId')).toEqual(['"owner-peer"']);
    expect(await values(store, 'materializedVersion')).toEqual([]);
  });

  it('fails closed instead of falling back past a corrupt newer local-control entry', async () => {
    const store = new OxigraphStore();
    const trustedMetadata: Quad[] = [
      ['accessPolicy', '"allowList"'],
      ['allowedPeer', '"trusted-peer"'],
      ['publisherPeerId', '"owner-peer"'],
    ].map(([predicate, object]) => ({
      subject: ual,
      predicate: `${DKG}${predicate}`,
      object,
      graph: metaGraph,
    }));
    await store.insert([dataQuad(1), ...metadata(1)]);
    await replaceLocallyTrustedKnowledgeAssetControls(
      store,
      ual,
      [...metadata(1), ...trustedMetadata],
    );
    const v2Root = String(2).padStart(64, '0');
    const corruptEntry = `${ual}/_local_controls/2/${v2Root}`;
    await store.insert([
      localControlQuad(corruptEntry, 'kaUal', ual),
      localControlQuad(corruptEntry, 'assertionVersion', '"not-a-version"'),
      localControlQuad(corruptEntry, 'merkleRoot', `"${v2Root}"`),
      localControlQuad(corruptEntry, 'accessPolicy', '"ownerOnly"'),
      localControlQuad(corruptEntry, 'publisherPeerId', '"owner-peer"'),
    ]);

    await expect(materializeVerifiedGraphScopedAsset({
      store,
      asset: {
        contextGraphId,
        ual,
        assertionVersion: 2n,
        assertionGraph,
        metaGraph,
        dataQuads: [dataQuad(2)],
        metadataQuads: metadata(2),
      },
    })).rejects.toThrow('Invalid trusted-control assertionVersion');

    const data = await store.query(`SELECT ?s WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`);
    expect(data.type === 'bindings' ? data.bindings.map((row) => row.s) : []).toEqual([dataQuad(1).subject]);
    expect(await values(store, 'assertionVersion')).toEqual(['"1"']);
  });

  it('fails closed on ambiguous local access-policy or publisher controls', async () => {
    const store = new OxigraphStore();
    await store.insert([dataQuad(1), ...metadata(1)]);
    const v2Root = String(2).padStart(64, '0');
    const corruptEntry = `${ual}/_local_controls/2/${v2Root}`;
    await store.insert([
      localControlQuad(corruptEntry, 'kaUal', ual),
      localControlQuad(corruptEntry, 'assertionVersion', '"2"'),
      localControlQuad(corruptEntry, 'merkleRoot', `"${v2Root}"`),
      localControlQuad(corruptEntry, 'accessPolicy', '"public"'),
      localControlQuad(corruptEntry, 'accessPolicy', '"ownerOnly"'),
      localControlQuad(corruptEntry, 'publisherPeerId', '"owner-peer"'),
      localControlQuad(corruptEntry, 'publisherPeerId', '"other-peer"'),
    ]);

    await expect(materializeVerifiedGraphScopedAsset({
      store,
      asset: {
        contextGraphId,
        ual,
        assertionVersion: 2n,
        assertionGraph,
        metaGraph,
        dataQuads: [dataQuad(2)],
        metadataQuads: metadata(2),
      },
    })).rejects.toThrow('exactly one valid accessPolicy');

    const data = await store.query(`SELECT ?s WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`);
    expect(data.type === 'bindings' ? data.bindings.map((row) => row.s) : []).toEqual([dataQuad(1).subject]);
    expect(await values(store, 'assertionVersion')).toEqual(['"1"']);
  });

  it('quarantines an oversized exact assertion without partially replacing it', async () => {
    const store = new OxigraphStore();
    const v1Data = dataQuad(1);
    await store.insert([v1Data, ...metadata(1)]);

    const outcome = await materializeVerifiedGraphScopedAsset({
      store,
      asset: {
        contextGraphId,
        ual,
        assertionVersion: 2n,
        assertionGraph,
        metaGraph,
        dataQuads: [{ ...dataQuad(2), object: `"${'x'.repeat(60_001)}"` }],
        metadataQuads: metadata(2),
      },
    });

    expect(outcome).toBe('quarantined');
    const data = await store.query(`SELECT ?s WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`);
    expect(data.type === 'bindings' ? data.bindings.map((row) => row.s) : []).toEqual([v1Data.subject]);
    expect(await values(store, 'assertionVersion')).toEqual(['"1"']);
  });

  it('leaves both old partitions intact when the atomic store update fails', async () => {
    const store = new OxigraphStore();
    const v1Data = dataQuad(1);
    await store.insert([v1Data, ...metadata(1)]);
    const failingStore = new Proxy(store, {
      get(target, property) {
        if (property === 'replaceGraphAndSubject') {
          return async () => { throw new Error('injected atomic update failure'); };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;

    await expect(materializeVerifiedGraphScopedAsset({
      store: failingStore,
      asset: {
        contextGraphId,
        ual,
        assertionVersion: 2n,
        assertionGraph,
        metaGraph,
        dataQuads: [dataQuad(2)],
        metadataQuads: metadata(2),
      },
    })).rejects.toThrow('injected atomic update failure');

    const data = await store.query(`SELECT ?s WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`);
    expect(data.type === 'bindings' ? data.bindings.map((row) => row.s) : []).toEqual([v1Data.subject]);
    expect(await values(store, 'assertionVersion')).toEqual(['"1"']);
    expect(await values(store, 'merkleRoot')).toEqual([`"${String(1).padStart(64, '0')}"`]);
  });

  it('fails closed when a store has generic update but no compound atomic capability', async () => {
    const store = new OxigraphStore();
    const v1Data = dataQuad(1);
    await store.insert([v1Data, ...metadata(1)]);
    const updateOnlyStore = new Proxy(store, {
      get(target, property) {
        if (property === 'replaceGraphAndSubject') return undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;

    await expect(materializeVerifiedGraphScopedAsset({
      store: updateOnlyStore,
      asset: {
        contextGraphId,
        ual,
        assertionVersion: 2n,
        assertionGraph,
        metaGraph,
        dataQuads: [dataQuad(2)],
        metadataQuads: metadata(2),
      },
    })).rejects.toMatchObject({ code: 'VM_ATOMIC_REPLACE_UNSUPPORTED' });

    const data = await store.query(`SELECT ?s WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`);
    expect(data.type === 'bindings' ? data.bindings.map((row) => row.s) : []).toEqual([v1Data.subject]);
    expect(await values(store, 'assertionVersion')).toEqual(['"1"']);
  });
});
