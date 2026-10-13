import { MULTICALL3_RUNTIME_CODE } from "../../chain/test/fixtures/multicall3-runtime-code.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Contract, Wallet, ethers } from "ethers";
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { EVMChainAdapter } from "@origintrail-official/dkg-chain";
import { OxigraphStore, type Quad } from "@origintrail-official/dkg-storage";
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
} from "@origintrail-official/dkg-publisher";
import { DKGAgent } from "../src/dkg-agent.js";
import { PublicSnapshotEvidence, assertPublicSnapshotQueryTrust } from "../src/public-snapshot-evidence.js";
import {
  getSharedContext,
  createProvider,
  makeAdapterConfig,
  HARDHAT_KEYS,
  takeSnapshot,
  revertSnapshot,
} from "../../chain/test/evm-test-context.js";

const agents: DKGAgent[] = [];
const directories: string[] = [];
beforeEach(async () => { vi.stubEnv('DKG_PUBLIC_SNAPSHOT_BULK', '0'); before = await takeSnapshot(); });
const graph = "public-snapshot-local";
const abi = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../chain/abi/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
let before: string;
beforeAll(async () => {
  vi.stubEnv("DKG_EXACT_BATCH_STREAM_ENABLED", "1");
});
afterEach(async () => {
  for (const agent of agents.splice(0).reverse()) await agent.stop();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  await revertSnapshot(before);
});
afterAll(() => vi.unstubAllEnvs());

describe("public snapshot recovery over live local nodes and chain", () => {
  it.each(["exact", "bulk"] as const)("reuses coherent core evidence without receiver asset RPCs (%s)", async transport => {
    if (transport === "bulk") vi.stubEnv("DKG_PUBLIC_SNAPSHOT_BULK", "1");
    const { rpcUrl, hubAddress } = getSharedContext();
    const provider = createProvider();
    const signer = new Wallet(HARDHAT_KEYS.DEPLOYER, provider);
    const adapter = new EVMChainAdapter(
      makeAdapterConfig(rpcUrl, hubAddress, HARDHAT_KEYS.DEPLOYER),
    );
    const created = await adapter.createOnChainContextGraph({
      participantAgents: [],
      metadataBatchId: 0n,
      accessPolicy: 0,
      publishPolicy: 0,
      publishAuthority: ethers.ZeroAddress,
      publishAuthorityAccountId: 0n,
      nameHash: ethers.id(graph),
    });
    const onChainId = created.contextGraphId.toString();
    const hub = new Contract(hubAddress, abi("Hub"), signer);
    await (
      await hub.setContractAddress("SnapshotTestFixture", signer.address)
    ).wait();
    const kas = new Contract(
      await hub.getAssetStorageAddress("DKGKnowledgeAssets"),
      abi("DKGKnowledgeAssets"),
      signer,
    );
    const cg = new Contract(
      await hub.getAssetStorageAddress("ContextGraphStorage"),
      abi("ContextGraphStorage"),
      signer,
    );
    await provider.send("hardhat_setCode", [
      "0xcA11bde05977b3631167028862bE2a173976CA11",
      MULTICALL3_RUNTIME_CODE,
    ]);
    const source = new OxigraphStore();
    for (let n = 1; n <= 12; n++) {
      const id = (BigInt(signer.address) << 96n) | BigInt(n);
      const ual = `did:dkg:evm:31337/${signer.address.toLowerCase()}/${n}`;
      const assertionGraph = `did:dkg:context-graph:${graph}/_verifiable_memory/${signer.address.toLowerCase()}/${n}`;
      const data: Quad[] = [
        {
          subject: `urn:entity:${n}`,
          predicate: "http://schema.org/name",
          object: `"Entity ${n}"`,
          graph: assertionGraph,
        },
      ];
      const privateRoot = n === 12 && transport === "exact" ? new Uint8Array(32).fill(7) : undefined;
      const root = computeFlatKCRootV10(data, privateRoot ? [privateRoot] : []);
      await (
        await kas.createKnowledgeAsset(
          signer.address,
          signer.address,
          id,
          `snapshot-${n}`,
          ethers.hexlify(root),
          1,
          100,
          1,
          2,
          0,
          false,
          1,
        )
      ).wait();
      await (
        await cg.registerKnowledgeAssetToContextGraph(BigInt(onChainId), id)
      ).wait();
      await source.insert([
        ...data,
        ...generateGraphKnowledgeAssetMetadata(
          {
            contextGraphId: graph,
            ual,
            assertionGraph,
            merkleRoot: root,
            publisherPeerId: "fixture",
            accessPolicy: "public",
            allowedPeers: [],
            timestamp: new Date(),
            assertionVersion: 1,
            authorAddress: signer.address,
            publicTripleCount: 1,
            privateTripleCount: privateRoot ? 1 : 0,
            privateMerkleRoot: privateRoot,
          },
          {
            status: "confirmed",
            confirmation: {
              kind: "finalized-materialization",
              provenance: {
                batchId: id,
                materializedVersion: { blockNumber: 0, txIndex: 0 },
              },
            },
          },
        ),
      ]);
    }
    await source.insert([{subject:'urn:private-fixture',predicate:'urn:secret',object:'"synthetic-private-data"',graph:`did:dkg:context-graph:${graph}/_private`}]);
    const snapshotRead = vi.spyOn(adapter, "readPublicGraphSnapshot");
    const make = async (
      name: string,
      nodeRole: "core" | "edge",
      chainAdapter: EVMChainAdapter,
      store: OxigraphStore,
    ) => {
      const dataDir = await mkdtemp(join(tmpdir(), "snapshot-local-")); directories.push(dataDir);
      const a = await DKGAgent.create({
        dataDir, name,
        nodeRole,
        listenHost: "127.0.0.1",
        listenPort: 0,
        chainAdapter,
        store: Object.assign(store, {
          queryResponseLimitMode: "pre-materialization" as const,
        }),
        randomSamplingUseWorkerThread: false,
        syncOnConnectEnabled: false,
        syncReconcilerEnabled: false,
        vmReconcilerEnabled: false,
      });
      agents.push(a);
      await a.start();
      if (nodeRole === "core")
        a.subscribeToContextGraph(graph, { onChainId, syncMode: "on-demand", trackSyncScope: false });
      return a;
    };
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
    // Internally valid peer content B must not replace local content when
    // the accepted chain snapshot still authenticates root A.
    for (const mismatchTransport of (transport === "bulk" ? ["bulk", "stream-required", "legacy"] as const : ["stream-required", "legacy"] as const)) {
      const n = mismatchTransport === "legacy" ? 12 : mismatchTransport === "bulk" ? 2 : 1;
      const ual = `did:dkg:evm:31337/${signer.address.toLowerCase()}/${n}`;
      const assertionGraph = `did:dkg:context-graph:${graph}/_verifiable_memory/${signer.address.toLowerCase()}/${n}`;
      const metaGraph = `did:dkg:context-graph:${graph}/_meta`;
      const privateRoot = n === 12 ? new Uint8Array(32).fill(7) : undefined;
      const changed: Quad[] = [{subject:`urn:entity:${n}`,predicate:"http://schema.org/name",object:'"Unanchored replacement"',graph:assertionGraph}];
      const root = computeFlatKCRootV10(changed, privateRoot ? [privateRoot] : []);
      const metadata = generateGraphKnowledgeAssetMetadata({contextGraphId:graph,ual,assertionGraph,merkleRoot:root,publisherPeerId:"fixture",accessPolicy:"public",allowedPeers:[],timestamp:new Date(),assertionVersion:1,authorAddress:signer.address,publicTripleCount:1,privateTripleCount:privateRoot?1:0,privateMerkleRoot:privateRoot}, {status:"confirmed",confirmation:{kind:"finalized-materialization",provenance:{batchId:BigInt(n),materializedVersion:{blockNumber:0,txIndex:0}}}});
      await source.replaceGraphAndSubject(assertionGraph, changed, metaGraph, ual, metadata);
      // A fresh supplier avoids the encoded cache from the matching-content test.
      const supplier = await make(`MismatchSource-${mismatchTransport}`, "core", new EVMChainAdapter(makeAdapterConfig(rpcUrl,hubAddress,HARDHAT_KEYS.DEPLOYER)),source);
      const mismatchStore = new OxigraphStore();
      const beforeQuads: Quad[] = [
        {subject:"urn:preserved",predicate:"urn:value",object:'"unchanged"',graph:assertionGraph},
        {subject:ual,predicate:"urn:local-note",object:'"unchanged"',graph:metaGraph},
      ];
      await mismatchStore.insert(beforeQuads);
      const sink = await make(`MismatchReceiver-${mismatchTransport}`, "edge", new EVMChainAdapter(makeAdapterConfig(rpcUrl,hubAddress,HARDHAT_KEYS.REC1_OP)),mismatchStore);
      sink.subscribeToContextGraph(graph,{onChainId,syncMode:"on-demand",trackSyncScope:false});
      await sink.connectTo(supplier.multiaddrs.find(a=>a.includes("/tcp/")&&!a.includes("/p2p-circuit"))!);
      const beforeRows = await mismatchStore.query(`SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(?g = <${metaGraph}> || STRSTARTS(STR(?g), "did:dkg:context-graph:${graph}/_verifiable_memory/")) } ORDER BY ?g ?s ?p ?o`);
      const writes = vi.spyOn(mismatchStore,"replaceGraphAndSubject");
      if (mismatchTransport === 'bulk') {
        const groupWrites = vi.spyOn(mismatchStore, 'replaceAssetGroup');
        const authenticated: string[] = [];
        const original = PublicSnapshotEvidence.prototype.authenticate;
        const authentication = vi.spyOn(PublicSnapshotEvidence.prototype, 'authenticate').mockImplementation(function(asset) {
          authenticated.push(asset.ual);
          return original.call(this, asset);
        });
        try {
          await expect(sink.syncPublicGraphSnapshot({ transport: 'bulk', contextGraphId: graph,
            onChainId, trustedCorePeerIds: [supplier.peerId] })).rejects.toThrow();
          // A matching first member and mismatched second member share the
          // real bulk commit callback; authentication must precede every write.
          expect(authenticated).toContain(`did:dkg:evm:31337/${signer.address.toLowerCase()}/1`);
          expect(authenticated).toContain(ual);
          expect(groupWrites).not.toHaveBeenCalled();
          expect(writes).not.toHaveBeenCalled();
          expect(await mismatchStore.query(`SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(?g = <${metaGraph}> || STRSTARTS(STR(?g), "did:dkg:context-graph:${graph}/_verifiable_memory/")) } ORDER BY ?g ?s ?p ?o`)).toEqual(beforeRows);
        } finally { authentication.mockRestore(); }
        continue;
      }
      const evidence = new PublicSnapshotEvidence({snapshot: independent, mode:"core-cache", sourceCore:supplier.peerId},()=>true);
      const authenticate = vi.fn(asset => evidence.authenticate(asset));
      const rejected = await sink.syncExactKnowledgeAssetsFromPeerDetailed(supplier.peerId,graph,[ual],{
        forceFreshExactSession:true,exactRecoveryTransportMode:mismatchTransport,totalTimeoutMs:15000,
        authenticateGraphScopedAsset:authenticate,
        registeredPublicEvidence:{usableFor:()=>true,revoke:()=>{}},
      });
      expect(authenticate).toHaveBeenCalled();
      expect(rejected.committedExactAssetUals ?? []).toEqual([]);
      expect(writes).not.toHaveBeenCalled();
      expect(await mismatchStore.query(`SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(?g = <${metaGraph}> || STRSTARTS(STR(?g), "did:dkg:context-graph:${graph}/_verifiable_memory/")) } ORDER BY ?g ?s ?p ?o`)).toEqual(beforeRows);
    }
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
});
