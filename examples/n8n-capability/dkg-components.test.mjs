import { JPB_SOURCE, JPB_TARGET, JPB_WORKBOOK } from './profiles/jpb-evidence.mjs';
import './test-support/select-jpb-profile.mjs';
import { dkgComponentStore } from './test-support/dkg-component-store-fixture.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  validateDkgTopology,
} from "./dkg-components.mjs";
import { compileStudio } from "./studio-definition.mjs";
import { component, componentNeedsExport } from "./component-registry.mjs";
process.env.NOS_JPB_READ_ENABLED = "1";
process.env.NOS_JPB_WRITE_ENABLED = "1";
const id = "11223344-1234-4234-8234-123456789abc";
const wb = {
  evidence: { contentDigest: JPB_WORKBOOK },
  allocationStatus: "unconfirmed",
  quantity: null,
};
const records = ["CUT", "USILU", "EBAVM"].map((operationCode) => ({
  operationCode,
  orderNo: "62633",
  recordId: "urn:record:" + operationCode,
  evidence: { contextGraphId: JPB_SOURCE },
}));
const def = {
  id,
  name: "JPB",
  entryId: "read",
  nodes: ["dkg-read", "dkg-write"].map((componentId, i) => ({
    id: i ? "write" : "read",
    componentId,
    kaRef: "urn:demo:n8n:component:" + componentId + ":1234",
    sourceHash: "a".repeat(64),
    params: Object.fromEntries(
      Object.entries(component(componentId).parameters).map(([k, v]) => [
        k,
        v.default,
      ]),
    ),
    x: i * 200,
    y: 0,
  })),
  edges: [{ from: "read", output: 0, to: "write", input: 0 }],
};
const workflow = {
  definition: def,
  kaRef: "urn:workflow:approved",
  sourceHash: "b".repeat(64),
};
const input = {
  itemsJson: JSON.stringify([{ workbook: [wb] }]),
  paramsJson: "{}",
  executionId: "",
};
const request = (blockId, items) => ({
  effectId: "urn:sr:effect:" + id + ":0",
  workflowId: "native1",
  executionId: "31",
  blockId,
  items,
});
function setup(remote) {
  const db = new DatabaseSync(":memory:");
  const store = dkgComponentStore(db, remote, [wb]);
  store.grant(workflow, id, input);
  return { store, db };
}
const readResult = { records, source: { contextGraphId: JPB_SOURCE } };
const written = (p) => ({
  contextGraphId: JPB_TARGET,
  digest: p.digest,
  name: p.name,
  readbackVerified: true,
  metadata: { status: "wm-sealed", reservedUal: "did:dkg:base:8453/example/1" },
});
test('registry separates write capability from export authority, including legacy descriptors', () => {
  for (const [id, required] of [['dkg-write', false], ['google-sheets', true], ['google-drive', true]]) {
    const descriptor = component(id);
    assert.equal(descriptor.writes, true);
    assert.equal(descriptor.requiresExportAuthorization, required);
    assert.equal(componentNeedsExport(descriptor), required);
    const { requiresExportAuthorization: _policy, ...legacy } = descriptor;
    assert.equal(componentNeedsExport(legacy), required);
  }
  assert.equal(componentNeedsExport({ id: 'unrecognized-writer', writes: true }), true);
  assert.equal(componentNeedsExport({ ...component('google-sheets'), requiresExportAuthorization: false }), true);
});
test("native HTTP DKG components are actual connected steps with one batched write and credential references", () => {
  const c = compileStudio(def, {
    graphId: "g",
    owner: "a",
    headerCredential: { id: "credential-reference", name: "node connection" },
  });
  const read = c.workflow.nodes.find((n) => n.name === "Block read request"),
    write = c.workflow.nodes.find((n) => n.name === "Block write request");
  assert.equal(read.type, "n8n-nodes-base.httpRequest");
  assert.equal(write.executeOnce, true);
  assert.equal(write.retryOnFail, true);
  assert.ok(c.grant.result.traceNodes.includes("Block write request"));
  assert.equal(write.credentials.httpHeaderAuth.id, "credential-reference");
  assert.equal(
    write.parameters.options.redirect.redirect.followRedirects,
    false,
  );
  assert.equal(c.requiresExportAuthorization, false);
  assert.equal(c.grant.result.traceNodes.length, 2);
  assert.equal(
    c.workflow.connections["Block read"].main[0][0].node,
    "Block write check 0",
  );
});
test("read is refreshed once per invocation; write and retry preserve exact provenance and identity", async () => {
  const calls = [];
  const { store, db } = setup(async (p, script) => {
    calls.push({ p, script });
    return script === "read" ? readResult : written(p);
  });
  const read = request("read", JSON.parse(input.itemsJson));
  assert.deepEqual(
    (await store.call(read, workflow, "native1")).items[0].erp,
    records,
  );
  await store.call(read, workflow, "native1");
  assert.equal(calls.length, 1);
  const rows = [{ erp: records[1], workbook: wb }, { erp: records[0] }],
    write = request("write", rows);
  const first = await store.call(write, workflow, "native1"),
    second = await store.call(write, workflow, "native1");
  assert.equal(first.items[0].assetId, second.items[0].assetId);
  assert.equal(calls[1].p.allowCreate, true);
  assert.equal(calls.length, 2); // completed write replay is entirely local
  const payload = JSON.parse(
    JSON.parse(
      calls[1].p.quads.find((q) => q.predicate === "urn:nos:workflow:payload")
        .object,
    ),
  );
  assert.equal(payload.records[0].workbook.quantity, null);
  assert.equal(payload.plcaCalculated, false);
  assert.equal(payload.execution.status, "running-at-write");
  db.close();
});
test("rejects ungranted, foreign scope, changed replay, and invented ERP before effects", async () => {
  const calls = [];
  const { store, db } = setup(async (p, script) => {
    calls.push(script);
    return readResult;
  });
  await assert.rejects(
    store.call(
      request("read", [{ erp: records, workbook: [wb] }]),
      workflow,
      "native1",
    ),
    /Do not supply ERP/,
  );
  await assert.rejects(
    store.call(
      {
        ...request("read", JSON.parse(input.itemsJson)),
        effectId: "urn:sr:effect:00000000-0000-4000-8000-000000000000:0",
      },
      workflow,
      "native1",
    ),
    /owner/,
  );
  await store.call(
    request("read", JSON.parse(input.itemsJson)),
    workflow,
    "native1",
  );
  await assert.rejects(
    store.call(
      request("write", [{ erp: { ...records[0], orderNo: "KAM" } }]),
      workflow,
      "native1",
    ),
    /provenance/,
  );
  assert.equal(calls.length, 1);
  assert.throws(
    () => store.grant(workflow, id, { ...input, itemsJson: "[]" }),
    /different|reviewed workbook/,
  );
  const foreign = structuredClone(workflow);
  foreign.definition.nodes[0].params.contextGraph = "kam-data";
  await assert.rejects(
    store.call(
      request("read", JSON.parse(input.itemsJson)),
      foreign,
      "native1",
    ),
    /scope mismatch/,
  );
  db.close();
});
test("ambiguous write is journalled before dispatch and never silently recreated", async () => {
  const allow = [];
  let attempts = 0;
  const { store, db } = setup(async (p, s) => {
    if (s === "read") return readResult;
    allow.push(p.allowCreate);
    if (++attempts === 1)
      throw new Error("transport lost after possible commit");
    return written(p);
  });
  await store.call(
    request("read", JSON.parse(input.itemsJson)),
    workflow,
    "native1",
  );
  const req = request("write", [{ erp: records[0] }]);
  await assert.rejects(store.call(req, workflow, "native1"), /transport lost/);
  await store.call(req, workflow, "native1");
  assert.deepEqual(allow, [true, false]);
  await assert.rejects(
    store.call(request("write", [{ erp: records[1] }]), workflow, "native1"),
    /different inputs/,
  );
  db.close();
});
test("DKG workflow rejects repeated side effects, nonterminal writes and external triggers", () => {
  assert.throws(
    () => validateDkgTopology({ ...def, entryId: "write" }),
    /Start with/,
  );
  assert.throws(
    () =>
      validateDkgTopology({
        ...def,
        edges: [...def.edges, { from: "write", to: "read" }],
      }),
    /terminal/,
  );
  assert.throws(
    () =>
      validateDkgTopology({
        ...def,
        nodes: [...def.nodes, { componentId: "schedule" }],
      }),
    /bounded native manual/,
  );
});

test("a reopened journal reuses its source and reconciles an ambiguous write without recreation", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "jpb-journal-"));
  let db;
  try {
    db = new DatabaseSync(join(dir, "journal.sqlite"));
    const first = dkgComponentStore(
      db,
      async (p, script) => {
        if (script === "read") return readResult;
        assert.equal(p.allowCreate, true);
        throw new Error("lost reply after dispatch");
      },
      [wb],
    );
    first.grant(workflow, id, input);
    await first.call(
      request("read", JSON.parse(input.itemsJson)),
      workflow,
      "native1",
    );
    await assert.rejects(
      first.call(request("write", [{ erp: records[0] }]), workflow, "native1"),
      /lost reply/,
    );
    db.close();
    db = new DatabaseSync(join(dir, "journal.sqlite"));
    let calls = 0;
    const second = dkgComponentStore(
      db,
      async (p, script) => {
        calls++;
        assert.notEqual(script, "read");
        assert.equal(p.allowCreate, false);
        return written(p);
      },
      [wb],
    );
    second.grant(workflow, id, input);
    await second.call(
      request("read", JSON.parse(input.itemsJson)),
      workflow,
      "native1",
    );
    await second.call(
      request("write", [{ erp: records[0] }]),
      workflow,
      "native1",
    );
    assert.equal(calls, 1);
    assert.throws(
      () =>
        second.grant(workflow, id, {
          ...input,
          itemsJson: JSON.stringify([{ workbook: [{ ...wb, quantity: 999 }] }]),
        }),
      /reviewed workbook/,
    );
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native lookup filters names and fails closed if pagination is incomplete", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createStudioProvider } = await import("./studio-provider.mjs");
  const dir = mkdtempSync(join(tmpdir(), "jpb-provider-"));
  const tokenFile = join(dir, "test-token");
  writeFileSync(tokenFile, "test-only");
  let requests = 0;
  const provider = createStudioProvider({
    state: dir,
    graphId: "g",
    owner: "a",
    headerCredential: { id: "ref", name: "ref" },
    config: {
      n8nNative: {
        baseUrl: "http://localhost",
        apiTokenFile: tokenFile,
        workflows: [],
      },
    },
    fetchImpl: async (url, options) => {
      requests++;
      assert.equal(options.method, "GET");
      assert.equal(url.searchParams.get("limit"), "10");
      assert.equal(url.searchParams.get("excludePinnedData"), "true");
      assert.ok(url.searchParams.get("name"));
      return Response.json({ data: [], nextCursor: "more" });
    },
  });
  try {
    await assert.rejects(provider.provision(def), /lookup is incomplete/);
    assert.equal(requests, 8);
  } finally {
    provider.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
