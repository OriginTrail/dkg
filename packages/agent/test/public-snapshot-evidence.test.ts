import { DKGQueryEngine } from "../../query/src/dkg-query-engine.js";
import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { OxigraphStore } from "@origintrail-official/dkg-storage";
import { sealPublicGraphSnapshot } from "@origintrail-official/dkg-chain";
import {
  PublicSnapshotEvidence,
  withPublicSnapshotQueryTrust,
  markCoreTrustedGraph,
  assertPublicSnapshotQueryTrust,
} from "../src/public-snapshot-evidence.js";
import {
  materializeVerifiedGraphScopedAsset,
  type VerifiedGraphScopedAsset,
} from "../src/sync/requester/graph-scoped-materialization.js";
const graph = "snapshot-evidence",
  address = `0x${"1".repeat(40)}`,
  id = ((BigInt(address) << 96n) | 1n).toString();
const snapshot = sealPublicGraphSnapshot({
  version: 1,
  chainId: "evm:31337",
  deploymentId: "test",
  contextGraphId: graph,
  onChainId: "1",
  nameHash: ethers.id(graph),
  contextGraphStorage: address,
  assetStorage: address,
  blockNumber: "10",
  blockHash: `0x${"a".repeat(64)}`,
  finalityConfirmations: 1,
  observedAt: 1000,
  expiresAt: 121000,
  accessPolicy: 0,
  assets: [{ id, root: `0x${"b".repeat(64)}`, version: "2" }],
});
const meta = `did:dkg:context-graph:${graph}/_meta`,
  ual = `did:dkg:evm:31337/${address}/1`;
const assertionGraph = `did:dkg:context-graph:${graph}/_verifiable_memory/${address}/1`;
const asset = (): VerifiedGraphScopedAsset => ({
  contextGraphId: graph,
  ual,
  assertionVersion: 2n,
  assertionGraph,
  metaGraph: meta,
  dataQuads: [
    {
      subject: "urn:entity",
      predicate: "urn:value",
      object: '"safe"',
      graph: assertionGraph,
    },
  ],
  metadataQuads: [
    ["merkleRoot", `"${"b".repeat(64)}"`],
    ["assertionVersion", '"2"'],
    ["transactionHash", `"0x${"f".repeat(64)}"`],
    ["chainEvidenceMode", '"rpc-only"'],
  ].map(([key, value]) => ({
    subject: ual,
    predicate: `http://dkg.io/ontology/${key}`,
    object: value!,
    graph: meta,
  })),
});
describe("job-scoped public snapshot evidence", () => {
  it("labels local trust and removes peer receipt claims; closed jobs cannot authenticate", () => {
    let current = true;
    const evidence = new PublicSnapshotEvidence({snapshot, mode: "core-cache", sourceCore: "configured-core"}, () => current,
    );
    const result = evidence.authenticate(asset());
    expect(
      result.asset.metadataQuads.some((q) =>
        q.predicate.endsWith("/transactionHash"),
      ),
    ).toBe(false);
    expect(
      result.asset.metadataQuads
        .filter((q) => q.predicate.endsWith("/chainEvidenceMode"))
        .map((q) => q.object),
    ).toEqual(['"core-cache"']);
    current = false;
    expect(() => evidence.authenticate(asset())).toThrow("no longer current");
  });
  it.each(["root", "version", "graph", "identity"])(
    "rejects mismatched %s",
    (kind) => {
      const a = asset();
      if (kind === "root") a.metadataQuads[0]!.object = `"${"c".repeat(64)}"`;
      if (kind === "version") a.assertionVersion = 3n;
      if (kind === "graph") a.contextGraphId = "other";
      if (kind === "identity") a.ual = a.ual.slice(0, -1) + "2";
      expect(() =>
        new PublicSnapshotEvidence({snapshot, mode: "core-cache", sourceCore: "core"}, () => true,
        ).authenticate(a),
      ).toThrow("pinned");
    },
  );
  it("guards scoped and unscoped queries durably and preserves the existing stale-write gate", async () => {
    const store = new OxigraphStore();
    try {
      await assertPublicSnapshotQueryTrust(store, graph);
      await markCoreTrustedGraph(store, graph);
      await expect(
        assertPublicSnapshotQueryTrust(store, graph),
      ).rejects.toThrow("core-trusted");
      await expect(assertPublicSnapshotQueryTrust(store)).rejects.toThrow(
        "core-trusted",
      );
      await expect(
        assertPublicSnapshotQueryTrust(store, undefined, "core-cache"),
      ).rejects.toThrow("explicit context graph");
      await assertPublicSnapshotQueryTrust(store, "other");
      await assertPublicSnapshotQueryTrust(store, graph, "core-cache");
      const authenticated = new PublicSnapshotEvidence({snapshot, mode: "core-cache", sourceCore: "core"}, () => true,
      ).authenticate(asset());
      expect(
        await materializeVerifiedGraphScopedAsset({
          store,
          asset: authenticated.asset,
        }),
      ).toBe("applied");
      expect(
        await materializeVerifiedGraphScopedAsset({
          store,
          asset: { ...asset(), assertionVersion: 1n },
        }),
      ).toBe("stale");
      const saved = await store.query(
        `SELECT ?mode WHERE {GRAPH <${meta}> {<${ual}> <http://dkg.io/ontology/chainEvidenceMode> ?mode}}`,
      );
      expect(saved.type === "bindings" && saved.bindings[0]?.mode).toBe(
        '"core-cache"',
      );
    } finally {
      await store.close();
    }
  });
  it("withholds a query result if a cache import starts during execution", async () => {
    const store = new OxigraphStore();
    try {
      await expect(
        withPublicSnapshotQueryTrust(store, graph, undefined, async () => {
          await markCoreTrustedGraph(store, graph);
          return "must not escape";
        }),
      ).rejects.toThrow("core-trusted");
    } finally {
      await store.close();
    }
  });
  it.each(["core-cache", "rpc-only"] as const)("preserves typed local publication dates and same-version replay in %s", async mode => {
    const store = new OxigraphStore();
    try {
      const evidence = new PublicSnapshotEvidence(mode === "core-cache" ? {snapshot, mode, sourceCore: "core"} : {snapshot, mode, sourceCore: null}, () => true);
      const first = evidence.authenticate(asset()).asset;
      expect(first.metadataQuads.find(q => q.predicate.endsWith("/chainEvidenceSource"))!.object).toBe(JSON.stringify(mode === "core-cache" ? "core" : "local-rpc"));
      const date = first.metadataQuads.find(q => q.predicate.endsWith("/publishedAt"))!.object;
      expect(date).toMatch(/\^\^<http:\/\/www.w3.org\/2001\/XMLSchema#dateTime>$/);
      expect(await materializeVerifiedGraphScopedAsset({store,asset:first})).toBe("applied");
      const replay = evidence.authenticate(asset()).asset;
      replay.metadataQuads.find(q => q.predicate.endsWith("/publishedAt"))!.object = '"2099-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>';
      expect(await materializeVerifiedGraphScopedAsset({store,asset:replay})).toBe("applied");
      const saved = await store.query(`SELECT ?date WHERE { GRAPH <${meta}> { <${ual}> <http://dkg.io/ontology/publishedAt> ?date . FILTER(?date > "2020-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>) } }`);
      expect(saved.type).toBe("bindings");
      if (saved.type !== "bindings") throw new Error("Expected bindings");
      expect(saved.bindings).toHaveLength(1);
      expect(Date.parse(saved.bindings[0]!.date.split('"')[1]!)).toBe(Date.parse(date.split('"')[1]!));
    } finally { await store.close(); }
  });

});

it("guards parent queries that resolve imported child VM partitions", async () => {
  const store = new OxigraphStore();
  try {
    const child = `${graph}/v1`;
    const a = asset(); a.contextGraphId = child;
    a.metaGraph = `did:dkg:context-graph:${child}/_meta`;
    a.assertionGraph = `did:dkg:context-graph:${child}/_verifiable_memory/${address}/1`;
    a.dataQuads = a.dataQuads.map(q => ({...q,graph:a.assertionGraph}));
    a.metadataQuads = a.metadataQuads.map(q => ({...q,graph:a.metaGraph}));
    const childSnapshot = sealPublicGraphSnapshot({...snapshot,contextGraphId:child,nameHash:ethers.id(child)});
    await markCoreTrustedGraph(store,child);
    const imported = new PublicSnapshotEvidence({snapshot:childSnapshot,mode:"core-cache",sourceCore:"core"},()=>true).authenticate(a);
    expect(await materializeVerifiedGraphScopedAsset({store,asset:imported.asset})).toBe("applied");
    const engine = new DKGQueryEngine(store);
    const read = (mode?: "core-cache" | "rpc-only") => withPublicSnapshotQueryTrust(store,graph,mode,()=>engine.query(
      'SELECT ?value WHERE { <urn:entity> <urn:value> ?value }',
      {contextGraphId:graph,view:"verifiable-memory",subGraphName:"v1"}));
    for (const mode of [undefined,"rpc-only"] as const) await expect(read(mode)).rejects.toMatchObject({code:"CORE_CACHE_QUERY_TRUST_REQUIRED"});
    const result = await read("core-cache");
    expect(result.bindings).toEqual([{value:'"safe"'}]);
    await assertPublicSnapshotQueryTrust(store,`${graph}-unrelated`);
  } finally {await store.close();}
});
