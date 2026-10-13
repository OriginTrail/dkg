import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { performance } from 'node:perf_hooks';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { PublicSnapshotEvidence, assertPublicSnapshotQueryTrust } from '../src/public-snapshot-evidence.js';
import { makeAdapterConfig, HARDHAT_KEYS, takeSnapshot, revertSnapshot } from '../../chain/test/evm-test-context.js';
import { graph, publicSnapshotFixture, mismatchedSnapshotMember } from './helpers/public-snapshot-local-fixture.js';

const fixtures: Awaited<ReturnType<typeof publicSnapshotFixture>>[] = [];
async function fixture(transport: 'exact' | 'bulk') {
  const result = await publicSnapshotFixture(transport); fixtures.push(result); return result;
}
let before: string;
beforeEach(async () => { vi.stubEnv('DKG_PUBLIC_SNAPSHOT_BULK', '0'); before = await takeSnapshot(); });
beforeAll(() => { vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1'); });
afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.dispose();
  await revertSnapshot(before);
});
afterAll(() => vi.unstubAllEnvs());

describe("public snapshot recovery over live local nodes and chain", () => {
  it.each(["exact", "bulk"] as const)("reuses coherent core evidence without receiver asset RPCs (%s)", async transport => {
    if (transport === "bulk") vi.stubEnv("DKG_PUBLIC_SNAPSHOT_BULK", "1");
    const { rpcUrl, hubAddress, signer, adapter, onChainId, source, make } = await fixture(transport);
    const snapshotRead = vi.spyOn(adapter, 'readPublicGraphSnapshot');
    const core = await make("SnapshotCore", "core", adapter, source);
    const receiverChain = new EVMChainAdapter(
      makeAdapterConfig(rpcUrl, hubAddress, HARDHAT_KEYS.REC1_OP),
    );
    const target = new OxigraphStore();
    const receiver = await make(
      "SnapshotReceiver",
      "edge",
      receiverChain,
      target,
    );
    await receiver.connectTo(
      core.multiaddrs.find(
        (a) => a.includes("/tcp/") && !a.includes("/p2p-circuit"),
      )!,
    );
    const assetCalls = [
      "getLatestMerkleRoot",
      "getMerkleRootCount",
      "getKAContextGraphId",
      "resolvePublishByTxHash",
      "verifyKAUpdate",
      "readPublicGraphSnapshot",
    ] as const;
    const calls = assetCalls.map((name) =>
      vi
        .spyOn(receiverChain, name)
        .mockRejectedValue(
          new Error("Receiver asset RPC forbidden in core-cache mode"),
        ),
    );
    expect(
      receiver.getSubscribedContextGraphs().get(graph)?.subscribed,
    ).not.toBe(true);
    await receiver.awaitInitialChainPoll();
    receiver.subscribeToContextGraph(graph, { onChainId, syncMode: "on-demand", trackSyncScope: false, deferSharedMemoryGossipSubscribe: true });
    receiver.recordCgWireId(graph, null);
    // Cold-start enumeration can finish while the first snapshot batch is
    // arriving. Use the real discovery/subscription path at that boundary.
    const recover = receiver.syncExactKnowledgeAssetsFromPeerDetailed.bind(receiver);
    let discoveredDuringRecovery = false;
    vi.spyOn(receiver, "syncExactKnowledgeAssetsFromPeerDetailed").mockImplementation(async (...args) => {
      if (!discoveredDuringRecovery) {
        discoveredDuringRecovery = true;
        await receiver.discoverContextGraphsFromStorage();
      }
      return recover(...args);
    });
    if (transport === 'bulk') {
      const replace = target.replaceAssetGroup.bind(target);
      vi.spyOn(target, 'replaceAssetGroup').mockImplementation(async (...args) => {
        if (!discoveredDuringRecovery) { discoveredDuringRecovery = true; await receiver.discoverContextGraphsFromStorage(); }
        return replace(...args);
      });
    }
    const t = performance.now();
    const result = await receiver.syncPublicGraphSnapshot({
      transport, contextGraphId: graph,
      onChainId,
      trustedCorePeerIds: [core.peerId],
    });
    expect(result).toMatchObject({
      mode: "core-cache",
      assets: 12,
      committed: 12,
      completeAsOfSnapshot: true,
      current: true,
    });
    expect(discoveredDuringRecovery).toBe(true);
    expect(snapshotRead).toHaveBeenCalledTimes(2);
    for (const call of calls) {
      expect(call).not.toHaveBeenCalled();
      call.mockRestore();
    }
    const found = await target.query(
      `SELECT ?name WHERE {GRAPH ?g {?s <http://schema.org/name> ?name}}`,
    );
    expect(found.type === "bindings" && found.bindings.length).toBe(12);
    const privateRows = await target.query('SELECT ?value WHERE {GRAPH ?g {?s <urn:secret> ?value}}');
    expect(privateRows.type === 'bindings' && privateRows.bindings.length).toBe(0);
    const commitments = await target.query('SELECT ?root WHERE {GRAPH ?g {?s <http://dkg.io/ontology/privateMerkleRoot> ?root}}');
    expect(commitments.type === 'bindings' && commitments.bindings.length).toBe(transport === 'exact' ? 1 : 0);
    await expect(assertPublicSnapshotQueryTrust(target, graph)).rejects.toThrow(
      "core-trusted",
    );
    await expect(
      assertPublicSnapshotQueryTrust(target, graph, "core-cache"),
    ).resolves.toBeUndefined();
    console.log(
      JSON.stringify({
        measurement: "local-public-snapshot-recovery",
        assets: 12,
        elapsedMs: performance.now() - t,
        receiverAssetRpcCalls: 0,
        coreSnapshotBuilds: snapshotRead.mock.calls.length,
      }),
    );
    await expect(
      receiver.query(
        "SELECT ?name WHERE {GRAPH ?g {?s <http://schema.org/name> ?name}}",
        {
          contextGraphId: graph,
          includeContextGraphPartitions: true,
        },
      ),
    ).rejects.toMatchObject({ code: "CORE_CACHE_QUERY_TRUST_REQUIRED" });
    const accepted = await receiver.query(
      "SELECT ?name WHERE {GRAPH ?g {?s <http://schema.org/name> ?name}}",
      {
        contextGraphId: graph,
        includeContextGraphPartitions: true,
        chainEvidenceMode: "core-cache",
      },
    );
    expect(accepted.bindings?.length).toBe(12);
    // The remote protocol has no evidence-acceptance field yet, so it must
    // refuse marked graphs rather than silently weakening the caller's trust.
    for (const response of [
      await core.findEntitiesByType(receiver.peerId, graph, "http://schema.org/Thing"),
      await core.queryRemoteSparql(receiver.peerId, graph, "SELECT ?s WHERE {?s ?p ?o} LIMIT 1"),
      await core.lookupEntity(receiver.peerId, `did:dkg:evm:31337/${signer.address.toLowerCase()}/1`),
    ]) {
      expect(response.status).not.toBe("OK");
      expect(response.bindings).toBeUndefined();
      expect(response.ntriples).toBeUndefined();
    }
    const rpcChain = new EVMChainAdapter(
      makeAdapterConfig(rpcUrl, hubAddress, HARDHAT_KEYS.REC2_OP),
    );
    const rpcReads = vi.spyOn(rpcChain, "readPublicGraphSnapshot");
    const rpcReceiver = await make(
      "IndependentReceiver",
      "edge",
      rpcChain,
      new OxigraphStore(),
    );
    await rpcReceiver.connectTo(
      core.multiaddrs.find(
        (a) => a.includes("/tcp/") && !a.includes("/p2p-circuit"),
      )!,
    );
    const rpcStart = performance.now();
    const rpcResult = await rpcReceiver.syncPublicGraphSnapshot({
      contextGraphId: graph,
      onChainId,
      trustedCorePeerIds: [core.peerId],
      mode: "rpc-only",
    });
    expect(rpcResult).toMatchObject({
      mode: "rpc-only",
      sourceCore: null,
      assets: 12,
      committed: 12,
      current: true,
    });
    expect(rpcReads).toHaveBeenCalledTimes(2);
    console.log(
      JSON.stringify({
        measurement: "local-independent-snapshot-recovery",
        assets: 12,
        elapsedMs: performance.now() - rpcStart,
        independentSnapshots: 2,
      }),
    );
    const independent = await receiverChain.readPublicGraphSnapshot(
      graph,
      onChainId,
    );
    expect(independent.inventoryDigest).toBe(
      (await adapter.readPublicGraphSnapshot(graph, onChainId)).inventoryDigest,
    );
    const privateCreated = await adapter.createOnChainContextGraph({
      participantAgents: [],
      metadataBatchId: 0n,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: ethers.ZeroAddress,
      publishAuthorityAccountId: 0n,
      nameHash: ethers.id("snapshot-private"),
    });
    await expect(
      adapter.readPublicGraphSnapshot(
        "snapshot-private",
        privateCreated.contextGraphId.toString(),
      ),
    ).rejects.toThrow("unavailable");
  }, 180_000);

  it('rejects a bulk group with a matching first member and mismatched second member before publication', async () => {
    vi.stubEnv('DKG_PUBLIC_SNAPSHOT_BULK', '1');
    const f = await fixture('bulk');
    const { supplier, sink, mismatchStore, ual, beforeRows, rows } = await mismatchedSnapshotMember(f, 2, 'bulk');
    const writes = vi.spyOn(mismatchStore, 'replaceGraphAndSubject');
    const groupWrites = vi.spyOn(mismatchStore, 'replaceAssetGroup');
    const authenticated: string[] = [];
    const original = PublicSnapshotEvidence.prototype.authenticate;
    const authentication = vi.spyOn(PublicSnapshotEvidence.prototype, 'authenticate').mockImplementation(function(asset) {
      authenticated.push(asset.ual);
      return original.call(this, asset);
    });
    try {
      await expect(sink.syncPublicGraphSnapshot({ transport: 'bulk', contextGraphId: graph,
        onChainId: f.onChainId, trustedCorePeerIds: [supplier.peerId] })).rejects.toThrow();
      expect(authenticated).toContain(`did:dkg:evm:31337/${f.signer.address.toLowerCase()}/1`);
      expect(authenticated).toContain(ual);
      expect(groupWrites).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(await rows()).toEqual(beforeRows);
    } finally { authentication.mockRestore(); }
  }, 180_000);

  it.each(['stream-required', 'legacy'] as const)('rejects unanchored exact content without replacing local data (%s)', async transport => {
    const f = await fixture('exact');
    const independent = await f.adapter.readPublicGraphSnapshot(graph, f.onChainId);
    const { supplier, sink, mismatchStore, ual, beforeRows, rows } = await mismatchedSnapshotMember(f, transport === 'legacy' ? 12 : 1, transport);
    const writes = vi.spyOn(mismatchStore, 'replaceGraphAndSubject');
    const evidence = new PublicSnapshotEvidence({ snapshot: independent, mode: 'core-cache', sourceCore: supplier.peerId }, () => true);
    const authenticate = vi.fn(asset => evidence.authenticate(asset));
    const rejected = await sink.syncExactKnowledgeAssetsFromPeerDetailed(supplier.peerId, graph, [ual], {
      forceFreshExactSession: true, exactRecoveryTransportMode: transport, totalTimeoutMs: 15000,
      authenticateGraphScopedAsset: authenticate,
      registeredPublicEvidence: { usableFor: () => true, revoke: () => {} },
    });
    expect(authenticate).toHaveBeenCalled();
    expect(rejected.committedExactAssetUals ?? []).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
    expect(await rows()).toEqual(beforeRows);
  }, 180_000);
});
