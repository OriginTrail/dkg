import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { createUalOnlyExactAssetSelection } from '../src/sync/exact-assets.js';
import { exactAssetFetchSessionPolicy } from '../src/sync/requester/exact-durable-fetch.js';
import * as exactRecovery from '../src/exact-recovery-execution.js';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { BULK_GRAPH_KIND, BULK_GRAPH_PROTOCOL } from '@origintrail-official/dkg-core';
import { performance } from 'node:perf_hooks';
import { normalizePublicGraphSnapshot, EVMChainAdapter } from '@origintrail-official/dkg-chain';
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
  vi.restoreAllMocks();
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
    const recover = exactRecovery.runExactRecovery;
    let discoveredDuringRecovery = false;
    vi.spyOn(exactRecovery, "runExactRecovery").mockImplementation(async (...args) => {
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
    const namedVm = await receiver.query('SELECT ?entity WHERE {?entity a <http://schema.org/Thing>}', {
      contextGraphId:graph,view:'verifiable-memory',chainEvidenceMode:'core-cache',
    });
    expect(namedVm.bindings).toEqual([{entity:'urn:entity:3'}]);
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
    // Re-authenticate through ordinary RPC exact sync after snapshot import. Replacing
    // the snapshot receipt must leave the canonical partition route discoverable.
    const replayUal = `did:dkg:evm:31337/${signer.address.toLowerCase()}/3`;
    const replay = await rpcReceiver.syncExactKnowledgeAssetsFromPeerDetailed(core.peerId, graph, [replayUal], {
      exactRecoveryTransportMode: 'legacy',
    });
    expect(replay.committedExactAssetUals).toContain(replayUal);
    expect(replay.result.failedPhases).toBe(0);
    const replayed = await rpcReceiver.query('SELECT ?entity WHERE {?entity a <http://schema.org/Thing>}', {
      contextGraphId: graph, view: 'verifiable-memory',
    });
    expect(replayed.bindings).toEqual([{entity:'urn:entity:3'}]);
    const entities = await core.findEntitiesByType(rpcReceiver.peerId, graph, 'http://schema.org/Thing');
    expect(entities).toMatchObject({status:'OK',entityUris:['urn:entity:3']});
    const triples = await core.getEntityTriples(rpcReceiver.peerId, graph, 'urn:entity:3');
    expect(triples).toMatchObject({status:'OK',resultCount:2});
    expect(triples.ntriples).toContain('<urn:entity:3>');
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

  it.each(['unsubscribe', 'rebind'] as const)('quarantines dispatched bulk writes after a real %s transition', async transition => {
    vi.stubEnv('DKG_PUBLIC_SNAPSHOT_BULK', '1');
    const f = await fixture('bulk');
    const core = await f.make('RevocationCore', 'core', f.adapter, f.source);
    const store = new OxigraphStore();
    const receiver = await f.make('RevocationReceiver', 'edge',
      new EVMChainAdapter(makeAdapterConfig(f.rpcUrl, f.hubAddress, HARDHAT_KEYS.REC1_OP)), store);
    await receiver.awaitInitialChainPoll();
    receiver.subscribeToContextGraph(graph, { onChainId: f.onChainId, syncMode: 'on-demand', trackSyncScope: false });
    await receiver.connectTo(core.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!);
    const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
    const entered = deferred(), release = deferred(), quarantining = deferred(), drain = deferred();
    const replace = store.replaceAssetGroup.bind(store);
    const writes: Parameters<typeof replace>[0][] = [];
    vi.spyOn(store, 'replaceAssetGroup').mockImplementation(async (...args) => {
      writes.push(args[0]);
      if (writes.length === 1) { entered.resolve(); await release.promise; }
      else { quarantining.resolve(); await drain.promise; }
      await replace(...args);
    });
    const commits: number[] = [];
    const exchange = receiver.router.withDuplexStream.bind(receiver.router);
    vi.spyOn(receiver.router, 'withDuplexStream').mockImplementation((peer, protocol, options, consume) =>
      exchange(peer, protocol, options, (stream, signal) => {
        if (protocol === BULK_GRAPH_PROTOCOL) {
          const send = stream.send.bind(stream);
          stream.send = bytes => { const data = bytes.subarray(); if (data[4] === BULK_GRAPH_KIND.COMMIT) commits.push(data[4]); return send(bytes); };
        }
        return consume(stream, signal);
      }));
    let settled = false;
    const pending = receiver.syncPublicGraphSnapshot({ transport: 'bulk', contextGraphId: graph,
      onChainId: f.onChainId, trustedCorePeerIds: [core.peerId] })
      .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    try {
      await entered.promise;
      if (transition === 'unsubscribe') receiver.unsubscribeFromContextGraph(graph);
      else receiver.subscribeToContextGraph(graph, { onChainId: String(BigInt(f.onChainId) + 1n), syncMode: 'on-demand', trackSyncScope: false });
      expect(settled).toBe(false);
      expect(commits).toEqual([]);
      release.resolve();
      await Promise.race([quarantining.promise, pending.then(() => { throw new Error('Job settled without quarantining revoked publication'); })]);
      expect(settled).toBe(false); // The job owns the physical quarantine too.
      expect(writes).toHaveLength(2);
      expect(writes[0]!.length).toBeGreaterThan(1);
      expect(writes[1]!.map(a => a.metadataSubject)).toEqual(writes[0]!.map(a => a.metadataSubject));
      expect(writes[1]!.every(a => !a.graphQuads.length && !a.metadataQuads.length)).toBe(true);
      drain.resolve();
      const result = await pending;
      expect('error' in result).toBe(true);
      expect(commits).toEqual([]);
      for (const member of writes[0]!) {
        expect(await store.countQuads(member.graphUri)).toBe(0);
        const rows = await store.query(`SELECT ?p WHERE { GRAPH <${member.metaGraphUri}> { <${member.metadataSubject}> ?p ?o } }`);
        expect(rows.type === 'bindings' && rows.bindings).toEqual([]);
      }
    } finally { release.resolve(); drain.resolve(); await pending; }
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

  it.each(['stream-required', 'legacy', 'legacy-envelope'] as const)('rejects unanchored exact content without replacing local data (%s)', async scenario => {
    const transport = scenario === 'legacy-envelope' ? 'legacy' : scenario;
    const f = await fixture('exact');
    const independent = await f.adapter.readPublicGraphSnapshot(graph, f.onChainId);
    const { supplier, sink, mismatchStore, ual, beforeRows, rows, changed, metadata } = await mismatchedSnapshotMember(f, scenario === 'legacy-envelope' ? 2 : transport === 'legacy' ? 12 : 1, scenario);
    const writes = vi.spyOn(mismatchStore, 'replaceGraphAndSubject');
    const evidence = new PublicSnapshotEvidence({ snapshot: normalizePublicGraphSnapshot(independent, { ...independent, now: independent.observedAt }), mode: 'rpc-only', sourceCore: null }, () => true);
    const authenticate = vi.spyOn(evidence, 'authenticate');
    if (scenario === 'legacy-envelope') {
      // A controlled malicious peer reply, with real worker, RPC evidence and store.
      vi.spyOn(sink as any, 'fetchSyncPages').mockImplementation(async (...args: any[]) => {
        const phase = args[4], quads = phase === 'meta' ? metadata : changed;
        return {quads,bytesReceived:0,resumedFromOffset:0,nextOffset:quads.length,
          checkpointKey:`malicious:${phase}`,completed:true,timedOut:false};
      });
    }
    const rejected = await exactRecovery.runExactRecovery({
      host: (DKGAgentBase as any).createDurableRecoveryCapabilities(sink), ctx: createOperationContext('sync'),
      remotePeerId: supplier.peerId, contextGraphId: graph, policy: exactAssetFetchSessionPolicy(createUalOnlyExactAssetSelection([ual]), 'vm-update-refresh'), authority: evidence,
      options: {
      exactRecoveryTransportMode: transport, totalTimeoutMs: 15000,
      },
    });
    expect(await rows()).toEqual(beforeRows);
    if (scenario === 'legacy-envelope') {
      expect(rejected.result.complete).toBe(false);
      expect(rejected.result.failedPhases).toBeGreaterThan(0);
      expect(authenticate).not.toHaveBeenCalled();
    } else expect(authenticate).toHaveBeenCalled();
    expect(rejected.committedExactAssetUals ?? []).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
    expect(await rows()).toEqual(beforeRows);
  }, 180_000);
});
