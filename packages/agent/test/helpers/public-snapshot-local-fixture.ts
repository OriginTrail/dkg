import { MULTICALL3_RUNTIME_CODE } from "../../../chain/test/fixtures/multicall3-runtime-code.js";
import { Contract, Wallet, ethers } from "ethers";
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../../src/dkg-agent.js';
import { getSharedContext, createProvider, makeAdapterConfig, HARDHAT_KEYS } from '../../../chain/test/evm-test-context.js';

export const graph = 'public-snapshot-local';
const abi = (name: string) => JSON.parse(readFileSync(new URL(`../../../chain/abi/${name}.json`, import.meta.url), 'utf8'));
export async function publicSnapshotFixture(transport: 'exact' | 'bulk') {
  const agents: DKGAgent[] = [], directories: string[] = [];
  const dispose = async () => {
    for (const agent of agents.splice(0).reverse()) await agent.stop();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  };
  try {
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
    return { rpcUrl, hubAddress, signer, adapter, onChainId, source, make, dispose };
  } catch (error) { await dispose(); throw error; }
}

export async function mismatchedSnapshotMember(f: Awaited<ReturnType<typeof publicSnapshotFixture>>, n: number, label: string) {
  const { signer, source, make, rpcUrl, hubAddress, onChainId } = f;
  const ual = `did:dkg:evm:31337/${signer.address.toLowerCase()}/${n}`;
  const assertionGraph = `did:dkg:context-graph:${graph}/_verifiable_memory/${signer.address.toLowerCase()}/${n}`;
  const metaGraph = `did:dkg:context-graph:${graph}/_meta`;
  const privateRoot = n === 12 ? new Uint8Array(32).fill(7) : undefined;
  const changed: Quad[] = [{subject:`urn:entity:${n}`,predicate:"http://schema.org/name",object:'"Unanchored replacement"',graph:assertionGraph}];
  const root = computeFlatKCRootV10(changed, privateRoot ? [privateRoot] : []);
  const metadata = generateGraphKnowledgeAssetMetadata({contextGraphId:graph,ual,assertionGraph,merkleRoot:root,publisherPeerId:"fixture",accessPolicy:"public",allowedPeers:[],timestamp:new Date(),assertionVersion:1,authorAddress:signer.address,publicTripleCount:1,privateTripleCount:privateRoot?1:0,privateMerkleRoot:privateRoot}, {status:"confirmed",confirmation:{kind:"finalized-materialization",provenance:{batchId:BigInt(n),materializedVersion:{blockNumber:0,txIndex:0}}}});
  await source.replaceGraphAndSubject(assertionGraph, changed, metaGraph, ual, metadata);
  // A fresh supplier has no encoded cache for the original content.
  const supplier = await make(`MismatchSource-${label}`, "core", new EVMChainAdapter(makeAdapterConfig(rpcUrl,hubAddress,HARDHAT_KEYS.DEPLOYER)),source);
  const mismatchStore = new OxigraphStore();
  const beforeQuads: Quad[] = [
    {subject:"urn:preserved",predicate:"urn:value",object:'"unchanged"',graph:assertionGraph},
    {subject:ual,predicate:"urn:local-note",object:'"unchanged"',graph:metaGraph},
  ];
  await mismatchStore.insert(beforeQuads);
  const sink = await make(`MismatchReceiver-${label}`, "edge", new EVMChainAdapter(makeAdapterConfig(rpcUrl,hubAddress,HARDHAT_KEYS.REC1_OP)),mismatchStore);
  sink.subscribeToContextGraph(graph,{onChainId,syncMode:"on-demand",trackSyncScope:false});
  await sink.connectTo(supplier.multiaddrs.find(a=>a.includes("/tcp/")&&!a.includes("/p2p-circuit"))!);
  const rows = () => mismatchStore.query(`SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(?g = <${metaGraph}> || STRSTARTS(STR(?g), "did:dkg:context-graph:${graph}/_verifiable_memory/")) } ORDER BY ?g ?s ?p ?o`);
  return { supplier, sink, mismatchStore, ual, beforeRows: await rows(), rows };
}
