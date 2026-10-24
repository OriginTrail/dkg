import { fixtureRoot } from './verified-asset-root-fixture.js';
import { DKGQueryEngine } from "../../query/src/dkg-query-engine.js";
import { describe, it, expect, vi } from "vitest";
import { ethers } from "ethers";
import { OxigraphStore } from "@origintrail-official/dkg-storage";
import { normalizePublicGraphSnapshot, sealPublicGraphSnapshot } from "@origintrail-official/dkg-chain";
import { contextGraphMetaUri } from "@origintrail-official/dkg-core";
import {
  PublicSnapshotEvidence,
  queryWithPublicSnapshotTrust,
  markCoreTrustedGraph,
  assertPublicSnapshotQueryTrust,
  readCoreCacheWithheldGraphRoots,
  SNAPSHOT_TRUST_GRAPH,
} from "../src/public-snapshot-evidence.js";
import {
  materializeVerifiedGraphScopedAsset,
  type VerifiedGraphScopedAsset,
} from "../src/sync/requester/graph-scoped-materialization.js";
const graph = "snapshot-evidence",
  address = `0x${"1".repeat(40)}`,
  id = ((BigInt(address) << 96n) | 1n).toString();
const rawSnapshot = sealPublicGraphSnapshot({
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
const snapshot = normalizePublicGraphSnapshot(rawSnapshot, { ...rawSnapshot, now: 1000 });
const meta = `did:dkg:context-graph:${graph}/_meta`,
  ual = `did:dkg:evm:31337/${address}/1`;
const assertionGraph = `did:dkg:context-graph:${graph}/_verifiable_memory/${address}/1`;
const asset = (): VerifiedGraphScopedAsset => ({
      merkleRootHex: fixtureRoot([{ predicate: 'http://dkg.io/ontology/merkleRoot', object: `"${"b".repeat(64)}"`, graph: '', subject: '' }]),
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
  it('owns immutable scope, asset roots and provenance independently of the input wrapper', () => {
    const original = { ...snapshot, assets: snapshot.assets.map(asset => ({ ...asset })) };
    const accepted = normalizePublicGraphSnapshot(original, { ...original, now: 1000 });
    const input = { snapshot: accepted, mode: 'core-cache' as const, sourceCore: 'original-core' };
    const evidence = new PublicSnapshotEvidence(input, () => true);
    input.snapshot = normalizePublicGraphSnapshot(rawSnapshot, { ...rawSnapshot, now: 1000 });
    input.sourceCore = 'other-core';
    original.assets[0]!.root = `0x${'c'.repeat(64)}`;
    expect(evidence.snapshot).toBe(accepted);
    expect(evidence.snapshot.contextGraphId).toBe(graph);
    expect(evidence.sourceCore).toBe('original-core');
    expect(evidence.authenticate(asset()).onChainContextGraphId).toBe('1');
    expect(Object.isFrozen(evidence.observation)).toBe(true);
    expect(Object.isFrozen(evidence.snapshot.assets[0])).toBe(true);
  });

  it("labels local trust and removes peer receipt claims; closed jobs cannot authenticate", () => {
    let current = true;
    const evidence = new PublicSnapshotEvidence({snapshot, mode: "core-cache", sourceCore: "configured-core"}, () => current,
    );
    expect(evidence.isRegisteredPublic(graph)).toBe(true);
    expect(evidence.isRegisteredPublic('other-graph')).toBe(false);
    const cancelled = new AbortController(); cancelled.abort(new Error('cancelled job'));
    expect(evidence.isRegisteredPublic(graph, cancelled.signal)).toBe(false);
    expect(() => evidence.authenticate(asset(), Infinity, cancelled.signal)).toThrow('cancelled job');
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
    expect(evidence.isRegisteredPublic(graph)).toBe(false);
    expect(() => evidence.authenticate(asset())).toThrow("no longer current");
  });
  it.each(["root", "version", "graph", "identity"])(
    "rejects mismatched %s",
    (kind) => {
      const a = asset();
      if (kind === "root") Object.assign(a, { merkleRootHex: "c".repeat(64) });
      if (kind === "version") a.assertionVersion = 3n;
      if (kind === "graph") a.contextGraphId = "other";
      if (kind === "identity") a.ual = a.ual.slice(0, -1) + "2";
      expect(() =>
        new PublicSnapshotEvidence({snapshot, mode: "core-cache", sourceCore: "core"}, () => true,
        ).authenticate(a),
      ).toThrow("pinned");
    },
  );
  it("guards scoped queries durably and preserves the existing stale-write gate", async () => {
    const store = new OxigraphStore();
    try {
      await assertPublicSnapshotQueryTrust(store, graph);
      await markCoreTrustedGraph(store, graph);
      await expect(
        assertPublicSnapshotQueryTrust(store, graph),
      ).rejects.toThrow("core-trusted");
      // The assert-only form serves callers that cannot leave marked graphs out
      // of what they read (remote UAL lookups): without a graph it still refuses.
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
  it("answers unscoped queries without the marked graph and keeps acceptance per graph", async () => {
    const store = new OxigraphStore();
    try {
      const engine = new DKGQueryEngine(store);
      await markCoreTrustedGraph(store, graph);
      const imported = new PublicSnapshotEvidence({snapshot, mode: "core-cache", sourceCore: "core"}, () => true).authenticate(asset());
      expect(await materializeVerifiedGraphScopedAsset({ store, asset: imported.asset })).toBe("applied");
      await store.insert([{ subject: "urn:entity:open", predicate: "urn:value", object: '"open"',
        graph: `did:dkg:context-graph:${graph}-other/_verifiable_memory/${address}/1` }]);
      const sparql = "SELECT ?value WHERE { GRAPH ?g { ?s <urn:value> ?value } }";
      const unscoped = (mode?: "core-cache" | "rpc-only", text = sparql) => queryWithPublicSnapshotTrust(store, engine, text, {}, mode);
      // Succeeds, and returns no triple from the marked graph.
      expect((await unscoped()).bindings).toEqual([{ value: '"open"' }]);
      expect((await unscoped("rpc-only")).bindings).toEqual([{ value: '"open"' }]);
      const raw = await store.query(sparql);
      expect(raw.type === "bindings" ? raw.bindings : []).toHaveLength(2);
      // Acceptance stays per graph: it needs an explicit context graph, as documented.
      await expect(unscoped("core-cache")).rejects.toThrow("explicit context graph");
      await expect(queryWithPublicSnapshotTrust(store, engine, sparql, {}, "other" as never)).rejects.toThrow("Unknown chain evidence mode");
      // Naming the marked graph reads nothing from it: it is not in the dataset.
      expect((await unscoped(undefined, `SELECT ?value WHERE { GRAPH <${assertionGraph}> { ?s <urn:value> ?value } }`)).bindings).toEqual([]);
      // The store replaces any dataset the query names, so naming one is refused.
      await expect(unscoped(undefined, `SELECT ?value FROM NAMED <${assertionGraph}> WHERE { GRAPH ?g { ?s <urn:value> ?value } }`))
        .rejects.toMatchObject({ code: "CORE_CACHE_QUERY_TRUST_REQUIRED" });
      // A scoped read of the marked graph still needs explicit acceptance.
      const scoped = (mode?: "core-cache" | "rpc-only") => queryWithPublicSnapshotTrust(store, engine,
        "SELECT ?value WHERE { ?s <urn:value> ?value }", { contextGraphId: graph, view: "verifiable-memory" }, mode);
      for (const mode of [undefined, "rpc-only"] as const)
        await expect(scoped(mode)).rejects.toMatchObject({ code: "CORE_CACHE_QUERY_TRUST_REQUIRED" });
      expect((await scoped("core-cache")).bindings).toEqual([{ value: '"safe"' }]);
    } finally {
      await store.close();
    }
  });
  it("withholds an unscoped result if a graph is marked while the query runs", async () => {
    const store = new OxigraphStore();
    try {
      const engine = { query: vi.fn(async () => {
        await markCoreTrustedGraph(store, graph);
        return { bindings: [{ value: '"must not escape"' }] };
      }) };
      await expect(queryWithPublicSnapshotTrust(store, engine, "SELECT * WHERE { ?s ?p ?o }", {}, undefined))
        .rejects.toMatchObject({ code: "CORE_CACHE_QUERY_TRUST_REQUIRED" });
      expect(engine.query).toHaveBeenCalledWith("SELECT * WHERE { ?s ?p ?o }", { withheldGraphRoots: [] });
    } finally {
      await store.close();
    }
  });
  it("leaves out whole graphs for legacy markers and refuses unscoped reads it cannot place", async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([{ subject: contextGraphMetaUri(`${graph}/legacy`), predicate: "http://dkg.io/ontology/chainEvidenceMode",
        object: '"core-cache"', graph: SNAPSHOT_TRUST_GRAPH }]);
      await markCoreTrustedGraph(store, graph);
      expect(await readCoreCacheWithheldGraphRoots(store)).toEqual([
        `did:dkg:context-graph:${graph}`, `did:dkg:context-graph:${graph}/legacy`,
      ]);
      await store.insert([{ subject: "urn:not-a-context-graph", predicate: "http://dkg.io/ontology/chainEvidenceMode",
        object: '"core-cache"', graph: SNAPSHOT_TRUST_GRAPH }]);
      await expect(queryWithPublicSnapshotTrust(store, new DKGQueryEngine(store), "SELECT * WHERE { ?s ?p ?o }", {}, undefined))
        .rejects.toMatchObject({ code: "CORE_CACHE_QUERY_TRUST_REQUIRED" });
    } finally {
      await store.close();
    }
  });
  it("refuses unscoped reads beyond the bound on marked graphs", async () => {
    const store = new OxigraphStore();
    try {
      await store.insert(Array.from({ length: 257 }, (_, index) => ({ subject: `did:dkg:context-graph:bulk-${index}`,
        predicate: "http://dkg.io/ontology/chainEvidenceMode", object: '"core-cache"', graph: SNAPSHOT_TRUST_GRAPH })));
      await expect(readCoreCacheWithheldGraphRoots(store)).rejects.toMatchObject({ code: "CORE_CACHE_QUERY_TRUST_REQUIRED" });
      vi.spyOn(store, "query").mockResolvedValueOnce({ type: "boolean", value: true });
      await expect(readCoreCacheWithheldGraphRoots(store)).rejects.toThrow("Chain evidence metadata is unavailable");
    } finally {
      await store.close();
    }
  });
  it("withholds a query result if a cache import starts during execution", async () => {
    const store = new OxigraphStore();
    try {
      await expect(
        queryWithPublicSnapshotTrust(store, { query: async () => {
          await markCoreTrustedGraph(store, graph);
          return { bindings: [{ value: '"must not escape"' }] };
        } }, "SELECT * WHERE { ?s ?p ?o }", { contextGraphId: graph }, undefined),
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
    const imported = new PublicSnapshotEvidence({snapshot:normalizePublicGraphSnapshot(childSnapshot, { ...childSnapshot, now: 1000 }),mode:"core-cache",sourceCore:"core"},()=>true).authenticate(a);
    expect(await materializeVerifiedGraphScopedAsset({store,asset:imported.asset})).toBe("applied");
    const engine = new DKGQueryEngine(store);
    const read = (mode?: "core-cache" | "rpc-only") => queryWithPublicSnapshotTrust(store,engine,
      'SELECT ?value WHERE { <urn:entity> <urn:value> ?value }',
      {contextGraphId:graph,view:"verifiable-memory",subGraphName:"v1"},mode);
    for (const mode of [undefined,"rpc-only"] as const) await expect(read(mode)).rejects.toMatchObject({code:"CORE_CACHE_QUERY_TRUST_REQUIRED"});
    const result = await read("core-cache");
    expect(result.bindings).toEqual([{value:'"safe"'}]);
    await assertPublicSnapshotQueryTrust(store,`${graph}-unrelated`);
  } finally {await store.close();}
});
