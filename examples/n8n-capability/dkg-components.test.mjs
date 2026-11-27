import { JPB_SOURCE, JPB_TARGET, JPB_WORKBOOK } from './profiles/jpb-evidence.mjs';
import { compiler, registry, profile } from './test-support/jpb-context.mjs';
import { dkgComponentStore, withDkgTestDependencies } from './test-support/dkg-component-store-fixture.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from 'node:timers/promises';
import {
  dkgComponentStore as createStore,
  validateDkgTopology,
} from "./dkg-components.mjs";
const { compileStudio } = compiler;
const { component, componentNeedsExport } = registry;
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
test('ordinary evidence fields cannot select Program provenance', async t => {
  let payload;
  const { store, db } = setup(async (value, operation) => {
    if (operation === 'read') return readResult;
    payload = value; return written(value);
  });
  t.after(() => db.close());
  await store.call(request('read', JSON.parse(input.itemsJson)), workflow, 'native1');
  const rows = [{ erp: records[0], workbook: wb, programExecution: { source: 'ordinary record field' } }];
  await store.call(request('write', rows), workflow, 'native1');
  const evidence = JSON.parse(JSON.parse(payload.quads.find(q => q.predicate === 'urn:nos:workflow:payload').object));
  assert.equal(evidence.kind, 'PLCAInputEvidence');
  assert.deepEqual(evidence.records, rows);
  assert.equal(evidence.programExecution, undefined);
});
test('overlapping identical Write callbacks share one pending transport and reject changed input', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let writes = 0, payload;
  const { store, db } = setup(async (value, operation) => {
    if (operation === 'read') return readResult;
    writes++; payload = value; entered.resolve(); await release.promise; return written(value);
  });
  t.after(() => db.close());
  await store.call(request('read', JSON.parse(input.itemsJson)), workflow, 'native1');
  const value = request('write', [{ erp: records[0], workbook: wb }]);
  const first = store.call(value, workflow, 'native1');
  await entered.promise;
  const second = store.call(structuredClone(value), workflow, 'native1');
  const replies = Promise.all([first, second]); let results;
  try {
    await assert.rejects(store.call({ ...value, items: [{ erp: records[1], workbook: wb }] }, workflow, 'native1'), /different inputs/);
    assert.equal(writes, 1);
    assert.equal(payload.allowCreate, true);
    const pending = db.prepare('SELECT * FROM dkg_component_calls WHERE id=?').get(id + ':write');
    assert.equal(pending.result, null); assert.equal(pending.response, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dkg_component_calls WHERE result IS NULL').get().n, 1);
  } finally { release.resolve(); results = await replies; }
  const [a, b] = results;
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(db.prepare('SELECT response FROM dkg_component_calls WHERE id=?').get(id + ':write').response), a);
  assert.deepEqual(await store.call(value, workflow, 'native1'), a);
  assert.equal(writes, 1);
});
test('a callback waiting on authority reuses the Write completed by its overlapping retry', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let writes = 0;
  const store = createStore(db, withDkgTestDependencies(profile, { transport: async (value, operation) => {
    if (operation === 'read') return readResult;
    writes++; assert.equal(value.allowCreate, true); return written(value);
  }, approvedInputs: [wb] }));
  const scope = { invocationId: id, revisionDigest: workflow.sourceHash, authority: { invocation: id } };
  store.grant(workflow, scope, input);
  const received = { invocationId: request('read', []).effectId, input };
  const authorized = { ...scope, authorize: async () => () => {} };
  await store.call(request('read', JSON.parse(input.itemsJson)), workflow, authorized, 'native1', received);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let first = true;
  const waiting = { ...scope, authorize: async () => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return () => {};
  } };
  const value = request('write', [{ erp: records[0], workbook: wb }]);
  const pending = store.call(value, workflow, waiting, 'native1', received);
  await entered.promise;
  let completed;
  try { completed = await store.call(value, workflow, authorized, 'native1', received); }
  finally { release.resolve(); }
  assert.deepEqual(await pending, completed);
  assert.equal(writes, 1);
  assert.throws(() => store.grant(workflow, { ...scope, authority: { invocation: 'replacement' } }, input), /different original authority/);
  await assert.rejects(store.call(value, workflow, scope, 'native1', received), /authority verifier required/);
  db.prepare('UPDATE dkg_component_runs SET authority=NULL').run();
  assert.throws(() => store.grant(workflow, scope, input), /unscoped legacy run/);
});

test('changed Write rows awaiting authorization cannot inherit an active valid callback receipt', { timeout: 5000 }, async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const authorizing = Promise.withResolvers(), authorized = Promise.withResolvers();
  const writing = Promise.withResolvers(), writtenReply = Promise.withResolvers();
  let writes = 0;
  const store = createStore(db, withDkgTestDependencies(profile, { transport: async (value, operation) => {
    if (operation === 'read') return readResult;
    writes++; writing.resolve(); await writtenReply.promise; return written(value);
  }, approvedInputs: [wb] }));
  const scope = { invocationId: id, revisionDigest: workflow.sourceHash, authority: { invocation: id } };
  store.grant(workflow, scope, input);
  const received = { invocationId: request('read', []).effectId, input };
  const current = { ...scope, authorize: async () => () => {} };
  await store.call(request('read', JSON.parse(input.itemsJson)), workflow, current, 'native1', received);
  let pause = true;
  const waiting = { ...scope, authorize: async () => {
    if (pause) { pause = false; authorizing.resolve(); await authorized.promise; }
    return () => {};
  } };
  const valid = request('write', [{ erp: records[0], workbook: wb }]);
  const changed = { ...valid, items: [{ erp: { ...records[0], orderNo: 'forged' }, workbook: wb }] };
  const outcome = store.call(changed, workflow, waiting, 'native1', received)
    .then(response => ({ response }), error => ({ error }));
  await authorizing.promise;
  assert.equal(db.prepare('SELECT id FROM dkg_component_calls WHERE id=?').get(id + ':write'), undefined);
  const pending = store.call(valid, workflow, current, 'native1', received);
  try {
    await writing.promise;
    authorized.resolve();
    await setImmediate(); // The changed callback resumes while the valid Write is still in flight.
  } finally { authorized.resolve(); writtenReply.resolve(); }
  const [denied, response] = await Promise.all([outcome, pending]);
  assert.match(denied.error?.message ?? '', /different inputs or native execution/);
  assert.equal(denied.response, undefined);
  assert.equal(writes, 1);
  assert.deepEqual(await store.call(valid, workflow, current, 'native1', received), response);
  assert.deepEqual(JSON.parse(db.prepare('SELECT response FROM dkg_component_calls WHERE id=?').get(id + ':write').response), response);
  assert.deepEqual(JSON.parse(db.prepare('SELECT request FROM dkg_component_calls WHERE id=?').get(id + ':write').request), valid);
  assert.equal(writes, 1);
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
  const { createStudioRepository } = await import("./studio-repository.mjs");
  const dir = mkdtempSync(join(tmpdir(), "jpb-provider-"));
  const tokenFile = join(dir, "test-token");
  writeFileSync(tokenFile, "test-only");
  let requests = 0;
  const repository = createStudioRepository(dir);
  const provider = createStudioProvider({
    compiler, repository,
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
    repository.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
