import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { remote } from "./jpb-output.mjs";
import { programRequest, programResult } from './dkg-program.mjs';

export const JPB_SOURCE = "0xf77258a965ba13adc77bca85da7c6a287272959a/jpb-data";
export const JPB_TARGET =
  "0xf77258a965ba13adc77bca85da7c6a287272959a/jpb-plca-study";
export const JPB_WORKBOOK =
  "2f0585064042668c4a854290a2e0ef365a24e57d58345881108067d397470fbf";
export const isDkg = (id) => ["dkg-read", "dkg-write", "invoke-dkg-program"].includes(id);
export const needsExport = (d) => !!d.writes && d.id !== "dkg-write";
const hash = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fail = (message) =>
  Object.assign(new Error(message), {
    status: 409,
    code: "DKG_COMPONENT_UNCONFIRMED",
  });
export function assertDkgEnabled(definition) {
  for (const n of definition.nodes.filter((n) => isDkg(n.componentId))) {
    if (
      process.env[
        n.componentId === 'invoke-dkg-program' ? 'NOS_JPB_PROGRAM_ENABLED' : n.componentId === "dkg-read"
          ? "NOS_JPB_READ_ENABLED"
          : "NOS_JPB_WRITE_ENABLED"
      ] !== "1"
    )
      throw fail(n.componentId + " is not enabled for JPB.");
  }
}
export function validateDkgTopology(definition) {
  if (definition.nodes.some(n => n.componentId === 'invoke-dkg-program') &&
    definition.nodes.some(n => ['loop-items', 'schedule', 'webhook', 'run-program'].includes(n.componentId)))
    throw fail('Remote Programs support bounded native manual workflows only.');
  const reads = definition.nodes.filter((n) => n.componentId === "dkg-read");
  const writes = definition.nodes.filter((n) => n.componentId === "dkg-write");
  if (!reads.length && !writes.length) return;
  if (
    reads.length !== 1 ||
    definition.entryId !== reads[0].id ||
    writes.length > 1
  )
    throw fail("Start with one DKG Read; use at most one DKG Write.");
  if (
    definition.nodes.some((n) =>
      ["loop-items", "schedule", "webhook", "run-program"].includes(
        n.componentId,
      ),
    )
  )
    throw fail(
      "JPB components currently support bounded native manual workflows only.",
    );
  if (writes.some((n) => definition.edges.some((e) => e.from === n.id)))
    throw fail("DKG Write must be the terminal output.");
}
export function componentEvidence(rows, context, read, workbook, programOutput) {
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > 20 ||
    JSON.stringify(rows).length > 8192
  )
    throw fail("Use one bounded JPB evidence batch.");
  for (const r of rows) {
    if (!r || (!r.erp && !r.workbook))
      throw fail("Write mapped ERP/workbook evidence records.");
    if (r.erp && !read.records.some((v) => isDeepStrictEqual(v, r.erp)))
      throw fail("ERP provenance differs from this execution DKG Read.");
    if (
      r.workbook &&
      (!workbook.some((v) => isDeepStrictEqual(v, r.workbook)) ||
        r.workbook.evidence?.contentDigest !== JPB_WORKBOOK ||
        r.workbook.allocationStatus !== "unconfirmed")
    )
      throw fail("Workbook provenance differs from this execution input.");
  }
  const payload = JSON.stringify({
    kind: programOutput ? 'PLCADemoResult' : "PLCAInputEvidence",
    interpretation: "planned-routing-reference-only",
    allocationStatus: "unconfirmed",
    plcaCalculated: programOutput?.result?.assessment?.calculated === true,
    ...(programOutput ? { assessment: programOutput.result.assessment, programExecution: programOutput.programExecution } : {}),
    execution: { ...context, status: "running-at-write" },
    source: read.source,
    records: rows,
  });
  const digest = createHash("sha256").update(payload).digest("hex"),
    subject = "urn:nos:jpb:input-evidence:" + digest;
  const q = (predicate, object) => ({ subject, predicate, object, graph: "" });
  const quads = [
    q(
      "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
      programOutput ? 'urn:nos:workflow:PLCADemoResult' : "urn:nos:workflow:PLCAInputEvidence",
    ),
    q("urn:nos:workflow:payload", JSON.stringify(payload)),
    q("urn:nos:workflow:sha256", JSON.stringify(digest)),
    q("urn:nos:workflow:allocationStatus", JSON.stringify("unconfirmed")),
    q("http://www.w3.org/ns/prov#wasGeneratedBy", context.executionIri),
    q("urn:nos:workflow:workflow", context.kaRef),
  ];
  if (programOutput) quads.push(q('http://www.w3.org/ns/prov#wasGeneratedBy', programOutput.programExecution.executionIri));
  for (const r of rows)
    for (const ref of [
      r.erp?.recordId,
      r.erp?.evidence?.sourceEvidence,
      r.workbook && "urn:sha256:" + r.workbook.evidence.contentDigest,
    ].filter(Boolean))
      quads.push(q("http://www.w3.org/ns/prov#wasDerivedFrom", ref));
  return {
    name: "nos-input-" + digest,
    digest,
    quads: [...new Map(quads.map((q) => [JSON.stringify(q), q])).values()],
  };
}

/** Transport journal only. Scheduling, mapping, joins and step errors belong to native n8n. */
function configuredWorkbook() {
  const file = process.env.NOS_JPB_WORKBOOK_INPUT_FILE;
  if (!file) return [];
  const rows = JSON.parse(readFileSync(file, "utf8"))[0]?.workbook;
  if (
    !Array.isArray(rows) ||
    rows.length !== 4 ||
    rows.some((r) => r.evidence?.contentDigest !== JPB_WORKBOOK)
  )
    throw fail(
      "Configure the reviewed workbook revision before enabling JPB writes.",
    );
  return rows;
}
export function dkgComponentStore(
  db,
  remoteCall = remote,
  approvedWorkbook = configuredWorkbook(),
) {
  db.exec(`CREATE TABLE IF NOT EXISTS dkg_component_runs(id TEXT PRIMARY KEY, ka_ref TEXT NOT NULL, source_hash TEXT NOT NULL, input TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dkg_component_calls(id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result TEXT);`);
  const active = new Map();
  function grant(workflow, invocationId, input) {
    if (workflow.definition.nodes.some((n) => n.componentId === "dkg-write")) {
      const wb = JSON.parse(input.itemsJson)[0]?.workbook;
      if (!approvedWorkbook.length || !isDeepStrictEqual(wb, approvedWorkbook))
        throw fail(
          "Use the reviewed workbook rows and revision for this JPB demo.",
        );
    }
    const encoded = JSON.stringify(input),
      old = db
        .prepare("SELECT * FROM dkg_component_runs WHERE id=?")
        .get(invocationId);
    if (
      old &&
      (old.ka_ref !== workflow.kaRef ||
        old.source_hash !== workflow.sourceHash ||
        old.input !== encoded)
    )
      throw fail(
        "Invocation identity belongs to different workflow or inputs.",
      );
    db.prepare(
      "INSERT INTO dkg_component_runs VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires",
    ).run(
      invocationId,
      workflow.kaRef,
      workflow.sourceHash,
      encoded,
      Date.now() + 600000,
    );
  }
  async function call(value, workflow, nativeId) {
    if (
      !value ||
      Object.keys(value).some(
        (k) =>
          ![
            "effectId",
            "workflowId",
            "executionId",
            "blockId",
            "items",
          ].includes(k),
      )
    )
      throw fail("Invalid DKG component request.");
    const match = /^urn:sr:effect:([a-f0-9-]{36}):[^\s]{1,100}$/.exec(
      value.effectId ?? "",
    );
    if (
      !match ||
      value.workflowId !== nativeId ||
      !/^\d{1,20}$/.test(value.executionId ?? "") ||
      typeof value.blockId !== "string"
    )
      throw fail("Native execution identity required.");
    const id = match[1],
      run = db.prepare("SELECT * FROM dkg_component_runs WHERE id=?").get(id),
      definition = workflow.definition;
    assertDkgEnabled(definition);
    validateDkgTopology(definition);
    if (
      !run ||
      run.expires < Date.now() ||
      run.ka_ref !== workflow.kaRef ||
      run.source_hash !== workflow.sourceHash
    )
      throw fail(
        "Run the approved workflow as its account owner before accessing JPB.",
      );
    const node = definition.nodes.find(
      (n) => n.id === value.blockId && isDkg(n.componentId),
    );
    if (!node) throw fail("DKG block is not in this pinned workflow.");
    const input = JSON.parse(run.input),
      rows = value.items;
    if (
      !Array.isArray(rows) ||
      !rows.length ||
      rows.length > 20 ||
      JSON.stringify(rows).length > 8192
    )
      throw fail("Bounded DKG component input required.");
    if (
      node.params.node !== "JPB" || node.componentId !== 'invoke-dkg-program' &&
      node.params.contextGraph !==
        (node.componentId === "dkg-read" ? JPB_SOURCE : JPB_TARGET)
    )
      throw fail("JPB Context Graph scope mismatch.");
    if (
      node.componentId === "dkg-read" &&
      (node.params.orderNo !== "62633" ||
        !isDeepStrictEqual(rows, JSON.parse(input.itemsJson)) ||
        rows.length !== 1 ||
        Object.hasOwn(rows[0], "erp"))
    )
      throw fail(
        "DKG Read takes one workbook batch and reads saved JPB order 62633. Do not supply ERP records.",
      );
    const key = id + ":" + node.id,
      requestHash = hash(value),
      prior = db
        .prepare("SELECT * FROM dkg_component_calls WHERE id=?")
        .get(key);
    if (prior && prior.request_hash !== requestHash)
      throw fail(
        "This DKG step already belongs to different inputs or native execution.",
      );
    if (active.has(key)) return active.get(key);
    if (node.componentId === 'invoke-dkg-program' && prior?.result) return JSON.parse(prior.result);
    if (node.componentId === "dkg-read" && prior?.result)
      return { items: [{ ...rows[0], erp: JSON.parse(prior.result).records }] };
    const pending = (async () => {
      if (!prior)
        db.prepare("INSERT INTO dkg_component_calls VALUES (?,?,NULL)").run(
          key,
          requestHash,
        );
      if (node.componentId === 'invoke-dkg-program') {
        const request = programRequest(node, rows, id);
        const result = programResult(await remoteCall(request, 'jpb-invoke-program.py'), request);
        db.prepare('UPDATE dkg_component_calls SET result=? WHERE id=?').run(JSON.stringify(result), key);
        return result;
      }
      if (node.componentId === "dkg-read") {
        const result = await remoteCall(
          { orderNo: node.params.orderNo },
          "jpb-read.py",
        );
        if (
          result.source?.contextGraphId !== JPB_SOURCE ||
          !Array.isArray(result.records) ||
          result.records.length !== 3 ||
          result.records.some(
            (r) =>
              r.orderNo !== "62633" ||
              r.evidence?.contextGraphId !== JPB_SOURCE,
          )
        )
          throw fail("JPB source response does not match the selected scope.");
        const items = [{ ...rows[0], erp: result.records }];
        if (JSON.stringify(items).length > 8192)
          throw fail("DKG Read result exceeds the workflow batch limit.");
        db.prepare("UPDATE dkg_component_calls SET result=? WHERE id=?").run(
          JSON.stringify(result),
          key,
        );
        return { items };
      }
      const readNode = definition.nodes.find(
        (n) => n.componentId === "dkg-read",
      );
      const read = db
        .prepare("SELECT result FROM dkg_component_calls WHERE id=?")
        .get(id + ":" + readNode.id);
      if (!read?.result)
        throw fail("DKG Read has not completed in this execution.");
      const context = {
        kaRef: workflow.kaRef,
        sourceHash: workflow.sourceHash,
        invocationId: id,
        executionIri: "urn:sr:execution:" + id,
        n8nExecutionId: value.executionId,
        blockId: node.id,
      };
      let evidenceRows = rows, programOutput;
      if (rows.length === 1 && rows[0]?.programExecution) {
        const incoming = definition.edges.find(e => e.to === node.id);
        const invoked = definition.nodes.find(n => n.id === incoming?.from && n.componentId === 'invoke-dkg-program');
        const completed = invoked && db.prepare('SELECT result FROM dkg_component_calls WHERE id=?').get(id + ':' + invoked.id);
        if (!completed?.result || !isDeepStrictEqual(JSON.parse(completed.result).items, rows)) throw fail('Program output differs from this execution.');
        programOutput = rows[0]; evidenceRows = programOutput.result?.records;
      }
      const payload = componentEvidence(
        evidenceRows,
        context,
        JSON.parse(read.result),
        JSON.parse(input.itemsJson)[0].workbook ?? [],
        programOutput,
      );
      const result = await remoteCall({ ...payload, allowCreate: !prior });
      if (
        result.contextGraphId !== JPB_TARGET ||
        result.digest !== payload.digest ||
        result.readbackVerified !== true ||
        result.metadata?.status !== "wm-sealed"
      )
        throw fail("JPB write readback did not confirm this exact evidence.");
      db.prepare("UPDATE dkg_component_calls SET result=? WHERE id=?").run(
        JSON.stringify(result),
        key,
      );
      return {
        items: [
          {
            node: "JPB",
            contextGraphId: JPB_TARGET,
            name: result.name,
            assetId: result.metadata.reservedUal,
            layer: "wm",
            status: "wm-sealed",
            readbackVerified: true,
            digest: payload.digest,
            recordCount: evidenceRows.length,
            executionIri: context.executionIri,
            n8nExecutionId: value.executionId,
            plcaCalculated: programOutput?.result?.assessment?.calculated === true,
            ...(programOutput ? { assessment: programOutput.result.assessment, programExecution: programOutput.programExecution } : {}),
          },
        ],
      };
    })();
    active.set(key, pending);
    try {
      return await pending;
    } finally {
      active.delete(key);
    }
  }
  return { grant, call };
}
