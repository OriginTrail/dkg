import { describe, expect, it, vi } from 'vitest';
import {
  BlazegraphStore,
  EXACT_GRAPH_EXPORT_MAX_RESPONSE_BYTES,
  EXACT_GRAPH_EXPORT_MAX_ROWS,
  ExactGraphReadError,
  OxigraphStore,
  StoreResponseTooLargeError,
  readExactGraph,
  supportsBoundedExactGraphExport,
  type QueryOptions,
  type QueryResult,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata, workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, createOperationContext } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/dkg-agent.js';
import { authenticateVerifiedGraphScopedAsset, materializeVerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';
import { verifyExactGraphContent } from '../src/exact-graph-content-verifier.js';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';

const graph = 'did:dkg:context-graph:bounded-export/_verifiable_memory/0x1111111111111111111111111111111111111111/1';

function body(count: number): Quad[] {
  return Array.from({ length: count }, (_, index) => ({
    subject: `urn:row:${index}`, predicate: 'urn:value', object: `"${index}"`, graph: '',
  }));
}

function httpStore(quads: Quad[], options: {
  beforeCount?: string;
  afterCount?: string;
  replaceRows?: Array<Record<string, string>>;
  rejectLargeRead?: boolean;
} = {}) {
  const store = new BlazegraphStore('http://127.0.0.1:1/namespace/unused/sparql');
  let counts = 0;
  const query = vi.spyOn(store, 'query').mockImplementation(async (sparql): Promise<QueryResult> => {
    if (sparql.includes('COUNT(*)')) {
      counts += 1;
      return { type: 'bindings', bindings: [{ count: counts === 1
        ? options.beforeCount ?? String(quads.length)
        : options.afterCount ?? String(quads.length) }] };
    }
    const offset = Number(/OFFSET\s+(\d+)/.exec(sparql)?.[1] ?? 0);
    const limit = Number(/LIMIT\s+(\d+)/.exec(sparql)?.[1] ?? quads.length + 1);
    if (options.rejectLargeRead && !sparql.includes('ORDER BY')) {
      throw new StoreResponseTooLargeError(EXACT_GRAPH_EXPORT_MAX_RESPONSE_BYTES, EXACT_GRAPH_EXPORT_MAX_RESPONSE_BYTES + 1);
    }
    return {
      type: 'bindings',
      bindings: options.replaceRows ?? quads.slice(offset, offset + limit).map((quad) => ({
        s: quad.subject, p: quad.predicate, o: quad.object,
      })),
    };
  });
  return { store, query };
}

async function verify(store: TripleStore, quads: Quad[], override: Partial<Parameters<typeof verifyExactGraphContent>[1]> = {}) {
  return verifyExactGraphContent(store, {
    graphUri: graph, publicTripleCount: quads.length,
    expectedMerkleRoot: computeFlatKCRootV10(quads, []),
    source: 'test.exactGraphExport', ...override,
  });
}

describe('bounded exact graph export', () => {
  it('verifies a KA through one bounded payload query and two count fences', async () => {
    const quads = body(1_000);
    const { store, query } = httpStore(quads);
    const result = await verify(store, quads);
    expect(result.status).toBe('verified');
    if (result.status === 'verified') expect(result.quads).toEqual(quads);
    expect(query).toHaveBeenCalledTimes(3);
    const payload = query.mock.calls.find(([sparql]) => sparql.includes('SELECT ?s ?p ?o'))!;
    expect(payload[0]).toContain('LIMIT 1001');
    expect(payload[0]).not.toContain('OFFSET');
    expect(payload[1]?.maxResponseBytes).toBe(EXACT_GRAPH_EXPORT_MAX_RESPONSE_BYTES);
    expect(payload[1]?.source).toBe('test.exactGraphExport');
  });

  it('retains the private root in the authoritative Merkle calculation', async () => {
    const quads = body(4);
    const privateRoot = new Uint8Array(32).fill(7);
    const { store } = httpStore(quads);
    expect((await verify(store, quads, {
      privateMerkleRoot: privateRoot,
      expectedMerkleRoot: computeFlatKCRootV10(quads, [privateRoot]),
    })).status).toBe('verified');
    expect((await verify(store, quads, { privateMerkleRoot: privateRoot })).status).toBe('merkle-mismatch');
  });

  it('rejects an equal-count content mutation with the ordinary Merkle check', async () => {
    const quads = body(4);
    const changed = quads.map((quad, index) => index === 1 ? { ...quad, object: '"changed"' } : quad);
    const { store } = httpStore(changed);
    expect((await verify(store, quads)).status).toBe('merkle-mismatch');
  });

  it('retains an expected workspace digest check', async () => {
    const quads = body(4);
    const { store } = httpStore(quads);
    expect((await verify(store, quads, { expectedPublicQuadsDigest: workspacePublicQuadsDigest(quads) })).status).toBe('verified');
    expect((await verify(store, quads, { expectedPublicQuadsDigest: 'wrong' })).status).toBe('head-mismatch');
  });

  it('rejects a preflight count mismatch before reading the body', async () => {
    const { store, query } = httpStore(body(4), { beforeCount: '5' });
    expect(await verify(store, body(4))).toMatchObject({ status: 'count-mismatch', actualCount: 5 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects a count-changing mutation at the postflight fence', async () => {
    const { store, query } = httpStore(body(4), { afterCount: '3' });
    expect(await verify(store, body(4))).toMatchObject({ status: 'count-mismatch', actualCount: 3 });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('rejects duplicate rows even when their count matches', async () => {
    const { store } = httpStore(body(2), {
      replaceRows: [{ s: 'urn:a', p: 'urn:b', o: '"c"' }, { s: 'urn:a', p: 'urn:b', o: '"c"' }],
    });
    await expect(verify(store, body(2))).rejects.toMatchObject({ code: 'INVALID_QUERY_RESULT' });
  });

  it('rejects malformed rows and invalid count literals', async () => {
    const malformed = httpStore(body(1), { replaceRows: [{ s: 'urn:a', p: 'urn:b' }] });
    await expect(verify(malformed.store, body(1))).rejects.toBeInstanceOf(ExactGraphReadError);
    const invalidCount = httpStore(body(1), { beforeCount: '1.0' });
    await expect(verify(invalidCount.store, body(1))).rejects.toMatchObject({ code: 'INVALID_QUERY_RESULT' });
  });

  it('retains the paged reader for an oversized HTTP response', async () => {
    const quads = body(500);
    const { store, query } = httpStore(quads, { rejectLargeRead: true });
    expect((await verify(store, quads)).status).toBe('verified');
    expect(query.mock.calls.filter(([sparql]) => sparql.includes('ORDER BY'))).toHaveLength(2);
    for (const [sparql] of query.mock.calls.filter(([sparql]) => sparql.includes('ORDER BY'))) {
      expect(Number(/LIMIT\s+(\d+)/.exec(sparql)?.[1])).toBeLessThanOrEqual(256);
    }
  });

  it('refuses unknown adapters and over-profile counts without issuing a large query', async () => {
    const unknown = { query: vi.fn() } as unknown as TripleStore;
    expect(supportsBoundedExactGraphExport(unknown)).toBe(false);
    expect(unknown.query).not.toHaveBeenCalled();
    const expectedQuadCount = EXACT_GRAPH_EXPORT_MAX_ROWS + 1;
    const { store, query } = httpStore([], { beforeCount: String(expectedQuadCount) });
    await expect(readExactGraph(store, graph, {
      expectedQuadCount, profile: 'bounded-single-result',
    })).rejects.toMatchObject({ code: 'QUAD_COUNT_MISMATCH' });
    const payloads = query.mock.calls.filter(([sparql]) => !sparql.includes('COUNT(*)'));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]![0]).toMatch(/ORDER BY[\s\S]+LIMIT 256[\s\S]+OFFSET 0/);
  });

  it('retains the original reader for embedded stores', async () => {
    const store = new OxigraphStore();
    const quads = body(300);
    await store.insert(quads.map((quad) => ({ ...quad, graph })));
    const query = vi.spyOn(store, 'query');
    expect((await verify(store, quads)).status).toBe('verified');
    expect(query.mock.calls.filter(([sparql]) => sparql.includes('OFFSET'))).toHaveLength(2);
    await store.close();
  });

  it('forwards the operation cancellation signal to every physical query', async () => {
    const { store, query } = httpStore(body(2));
    const signal = new AbortController().signal;
    const options: QueryOptions = { source: 'test.signal', signal, priority: 'background' };
    expect(await readExactGraph(store, graph, {
      expectedQuadCount: 2, profile: 'bounded-single-result', queryOptions: options,
    })).toHaveLength(2);
    for (const [, observed] of query.mock.calls) {
      expect(observed?.signal).toBe(signal);
      expect(observed?.priority).toBe('background');
    }
  });

  it('does not widen a caller response ceiling', async () => {
    const { store, query } = httpStore(body(2));
    expect(await readExactGraph(store, graph, {
      expectedQuadCount: 2, profile: 'bounded-single-result', queryOptions: { maxResponseBytes: 1024 },
    })).toHaveLength(2);
    for (const [, options] of query.mock.calls) expect(options?.maxResponseBytes).toBe(1024);
  });
});

describe('native recovery sizing call profile', () => {
  it('counts sizing-only lookahead reads separately from authentication', async () => {
    // Actual host planning and rotation; the existing harness deliberately
    // stubs transport/authentication/reconciliation so these counts are sizing
    // hints only, not the complete cold-sync RPC count.
    const localCgId = '0x0000000000000000000000000000000000000001/sizing-call-profile';
    const harness = await createVmRecoveryHostHarness({
      name: 'NativeSizingCallProfile', localCgId,
      peers: ['12D3KooWSizingA', '12D3KooWSizingB', '12D3KooWSizingC'],
      targetCount: 10,
      targetForOrdinal: (ordinal) => ({
        localCgId, onChainCgId: '1', ordinal, reason: 'no-swm' as const,
        ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
        kaId: String(ordinal), merkleRoot: `root-${ordinal}`,
      }),
      footprintForOrdinal: () => ({ byteSize: 3_000_000n, merkleLeafCount: 12_000n }),
      onFetch: (_peerId, requested, recovered) => {
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    try {
      const sizing = vi.spyOn(harness.chainAdapter, 'getKnowledgeAssetUpdateContext');
      const publicAuthority = vi.spyOn(harness.chainAdapter, 'getContextGraphLiveAuthority');
      const result = await harness.run();
      expect(harness.fetched.map(({ uals }) => uals.length)).toEqual([1, 1, 1, 1, 1, 1]);
      expect(result.attemptedOrdinals).toEqual([0, 1, 2, 3, 4, 5]);
      expect(sizing.mock.calls.map(([kaId]) => Number(kaId))).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9,
        3, 4, 5, 6, 7, 8, 9,
        5, 6, 7, 8, 9,
      ]);
      expect(sizing).toHaveBeenCalledTimes(21);
      expect(new Set(sizing.mock.calls.map(([kaId]) => kaId)).size).toBe(9);
      expect(publicAuthority).toHaveBeenCalledTimes(3);
    } finally {
      await harness.agent.stop();
    }
  });
});

/**
 * One knowledge asset registered at ordinal 0 of a mock graph, with the verified asset a
 * successful exact fetch would materialize and the host seams the recovery batch runs through.
 */
async function coldRecoveryFixture(name: string, localCgId: string) {
  const chain = new MockChainAdapter();
  const nameHash = ethers.keccak256(ethers.toUtf8Bytes(localCgId));
  const { contextGraphId } = await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash });
  const scope = createGraphKnowledgeAssetScope('did:dkg:mock:31337/0x1111111111111111111111111111111111111111/7', 1);
  const kaId = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
  const publicQuads = body(4);
  const root = computeFlatKCRootV10(publicQuads, []);
  chain.__registerKC({ kaId, contextGraphId, merkleRootHex: ethers.hexlify(root), chunks: [], merkleLeafCount: 4, byteSize: 256n });
  const agent = await DKGAgent.create({ name, chainAdapter: chain });
  const internals = agent as any;
  internals.node = { peerId: `12D3KooW${name}Local`, libp2p: { getConnections: () => [] } };
  const assertionGraph = knowledgeAssetLayerGraphUri(localCgId, MemoryLayer.VerifiableMemory, scope);
  const metadataQuads = generateGraphKnowledgeAssetMetadata({
    contextGraphId: localCgId, ual: scope.ual, assertionVersion: 1,
    merkleRoot: root, publisherPeerId: 'rfc64-finalized-catalog-v1',
    accessPolicy: 'public', allowedPeers: [], timestamp: new Date('2026-09-30T12:00:00Z'),
    authorAddress: scope.agentAddress, publicTripleCount: 4, privateTripleCount: 0, assertionGraph,
  }, { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
    batchId: kaId, materializedVersion: { blockNumber: 100, txIndex: 0 },
  } } });
  const asset = { contextGraphId: localCgId, ual: scope.ual, assertionVersion: 1n, assertionGraph,
    metaGraph: `did:dkg:context-graph:${localCgId}/_meta`,
    dataQuads: publicQuads.map((quad) => ({ ...quad, graph: assertionGraph })), metadataQuads };
  const targetOptions = { isTargetCurrent: () => true, revalidateTarget: async () => true };
  /** The exact fetch the batch runs: a verified, authenticated, atomically committed materialization. */
  const installVerifiedFetch = () => {
    internals.syncExactKnowledgeAssetsFromPeerDetailed = async () => {
      const authenticated = await authenticateVerifiedGraphScopedAsset(chain, asset,
        (localId, onChainId, signal) => internals.requireLocalCgMatchesOnChainSlot(localId, onChainId.toString(), undefined, { signal }));
      expect(await materializeVerifiedGraphScopedAsset({ store: internals.store, asset: authenticated.asset })).toBe('applied');
      return { disposition: 'found', result: { fetchedDataTriples: 4, fetchedMetaTriples: metadataQuads.length,
        insertedTriples: 4 + metadataQuads.length, failedPeers: 0, failedPhases: 0, deferredBackpressure: 0 } };
    };
  };
  const runBatch = (recovery: unknown) => internals.executeVmRecoveryBatch({ localCgId, onChainCgId: contextGraphId,
    peerId: '12D3KooWNativeColdProfileSource', attempts: [{ entry: { index: 0, target: recovery,
      prepared: { slotKey: 'test-profile', suppressed: false } }, installedRecord: undefined, candidatePeerIds: [] }],
    unavailablePeerIds: [], headBlock: 100, isRecoveryCurrent: () => true,
    revalidateTarget: targetOptions.revalidateTarget, ctx: createOperationContext('system') });
  return { chain, agent, internals, localCgId, contextGraphId, kaId, targetOptions, installVerifiedFetch, runBatch };
}

describe('ordinary native cold recovery call profile', () => {
  it('retains all three KA authentication reads and avoids a coherent snapshot after a verified commit', async () => {
    // This counts logical adapter calls through production recovery/auth/store
    // methods. The mocked chain and transport do not measure physical RPC or
    // prove real-chain authority; no network or existing store is touched.
    const f = await coldRecoveryFixture('NativeColdCallProfile', 'native-cold-call-profile');
    const { chain, internals } = f;
    const ordinal = vi.spyOn(chain, 'getContextGraphKCAt').mockResolvedValue(f.kaId);
    const latestRoot = vi.spyOn(chain, 'getLatestMerkleRoot');
    const count = vi.spyOn(chain, 'getMerkleRootCount');
    const membership = vi.spyOn(chain, 'getKAContextGraphId');
    const committedName = vi.spyOn(chain, 'getContextGraphNameHash');
    const snapshot = vi.spyOn(chain, 'readKnowledgeAssetVersionSnapshot');
    const publisher = vi.spyOn(chain, 'getLatestMerkleRootPublisher');
    try {
      const initial = await internals.reconcileChainOrdinal(f.localCgId, f.contextGraphId, 0, 100, f.targetOptions);
      expect(initial).toMatchObject({ status: 'pending', recovery: { reason: 'no-swm' } });
      expect(ordinal).toHaveBeenCalledTimes(1);
      expect(latestRoot).not.toHaveBeenCalled();
      f.installVerifiedFetch();
      const result = await f.runBatch(initial.recovery);
      expect(result.kind).toBe('completed');
      expect(result.outcomes).toEqual([[0, { status: 'already', blockNumber: 100 }]]);
      expect(ordinal).toHaveBeenCalledTimes(2);
      expect(latestRoot).toHaveBeenCalledTimes(1);
      expect(count).toHaveBeenCalledTimes(1);
      expect(membership).toHaveBeenCalledTimes(1);
      expect(committedName).toHaveBeenCalledTimes(1);
      expect(snapshot).not.toHaveBeenCalled();
      expect(publisher).not.toHaveBeenCalled();
    } finally {
      await f.agent.stop();
    }
  });

  it('revalidates the ordinal after the fetch, so an occupant change during it cannot be skipped', async () => {
    // The scan saw knowledge asset A at ordinal 0 and queued its recovery. While A is fetched,
    // a shallow reorg changes the inventory to [B, A]. A still belongs to the graph and
    // materializes, but ordinal 0 now names B: reporting it complete would let the cursor
    // absorb the ordinal and skip B for good. The post-fetch read must see B and keep it pending.
    const f = await coldRecoveryFixture('NativeColdReorg', 'native-cold-reorg');
    const { chain, internals } = f;
    const kaIdB = f.kaId + 1n;
    chain.__registerKC({ kaId: kaIdB, contextGraphId: f.contextGraphId,
      merkleRootHex: ethers.hexlify(computeFlatKCRootV10(body(5), [])), chunks: [], merkleLeafCount: 5, byteSize: 320n });
    const ordinal = vi.spyOn(chain, 'getContextGraphKCAt').mockResolvedValue(f.kaId);
    try {
      const initial = await internals.reconcileChainOrdinal(f.localCgId, f.contextGraphId, 0, 100, f.targetOptions);
      expect(initial).toMatchObject({ status: 'pending', recovery: { kaId: f.kaId.toString() } });
      f.installVerifiedFetch();
      ordinal.mockResolvedValue(kaIdB);

      const result = await f.runBatch(initial.recovery);

      expect(result.kind).toBe('completed');
      // Ordinal 0 is still owed: the outcome names B (not materialized), never the fetched A.
      expect(result.outcomes).toEqual([[0, expect.objectContaining({
        status: 'pending',
        recovery: expect.objectContaining({ kaId: kaIdB.toString(), reason: 'no-swm' }),
      })]]);
      expect(result.outcomes[0]![1].recovery.ual).not.toBe(initial.recovery.ual);
      expect(ordinal).toHaveBeenCalledTimes(2);
    } finally {
      await f.agent.stop();
    }
  });
});
