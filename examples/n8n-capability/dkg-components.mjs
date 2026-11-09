import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { configuredDkgProfile, requireDkgProfile } from './dkg-profile.mjs';
import { programRequest, programResult } from './dkg-program.mjs';

export const isDkg = (id) => ["dkg-read", "dkg-write", "invoke-dkg-program"].includes(id);
export const needsExport = (d) => !!d.writes && d.id !== "dkg-write";
const hash = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fail = (message) =>
  Object.assign(new Error(message), {
    status: 409,
    code: "DKG_COMPONENT_UNCONFIRMED",
  });
export function assertDkgEnabled(definition, profile = configuredDkgProfile) {
  for (const node of definition.nodes.filter(n => isDkg(n.componentId))) {
    requireDkgProfile(profile);
    if (!profile.enabled(node.componentId)) throw fail(node.componentId + ' is not enabled for this execution profile.');
    if (node.params.profileRevision !== profile.revision) throw fail('Execution profile changed. Re-select and save the current component revision.');
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
      "DKG components currently support bounded native manual workflows only.",
    );
  if (writes.some((n) => definition.edges.some((e) => e.from === n.id)))
    throw fail("DKG Write must be the terminal output.");
}
/** Transport journal only. Scheduling, transformations and joins remain in native n8n. */
export function dkgComponentStore(db, transport, approvedInputs, profile = configuredDkgProfile) {
  transport ??= profile?.transport;
  approvedInputs ??= profile?.loadInputs() ?? [];
  db.exec(`CREATE TABLE IF NOT EXISTS dkg_component_runs(id TEXT PRIMARY KEY, ka_ref TEXT NOT NULL, source_hash TEXT NOT NULL, input TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dkg_component_calls(id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result TEXT);`);
  db.exec('CREATE TABLE IF NOT EXISTS dkg_component_profiles (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, revision TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS dkg_component_actors (id TEXT PRIMARY KEY, actor TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS dkg_component_writes (id TEXT PRIMARY KEY, request TEXT NOT NULL, evidence TEXT NOT NULL, receipt TEXT)');
  const active = new Map();
  function assertNoPendingWrite(workflow, invocationId) {
    const node = workflow.definition.nodes.find(n => n.componentId === 'dkg-write');
    if (!node) return;
    const pending = db.prepare(`SELECT r.id FROM dkg_component_runs r JOIN dkg_component_calls c ON c.id=r.id||':'||?
      WHERE r.ka_ref=? AND r.id<>? AND c.result IS NULL LIMIT 1`).get(node.id, workflow.kaRef, invocationId);
    if (pending) throw Object.assign(fail('Reconcile the previous DKG write before starting another invocation.'),
      { code: 'DKG_WRITE_PENDING', invocationId: pending.id });
  }
  function grant(workflow, invocationId, input, actor) {
    if (profile?.requiresNosActor && (!actor || actor.role !== 'owner' || actor.accountId !== profile.accountId))
      throw fail('Authenticated nOS owner required.');
    const actorText = JSON.stringify(actor ?? null);
    const existingActor = db.prepare('SELECT actor FROM dkg_component_actors WHERE id=?').get(invocationId);
    const existingRun = db.prepare('SELECT id FROM dkg_component_runs WHERE id=?').get(invocationId);
    if ((existingActor && existingActor.actor !== actorText) || (profile?.requiresNosActor && existingRun && !existingActor))
      throw fail('This invocation belongs to a different account or principal.');
    assertDkgEnabled(workflow.definition, profile);
    profile.validateInput(workflow.definition, input, approvedInputs);
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
    const scope = db.prepare('SELECT * FROM dkg_component_profiles WHERE id=?').get(invocationId);
    if (old && (!scope || scope.profile_id !== profile.id || scope.revision !== profile.revision))
      throw fail('Invocation identity belongs to a different execution profile or an unscoped legacy run.');
    if (!old) assertNoPendingWrite(workflow, invocationId);
    db.exec('SAVEPOINT dkg_profile_grant');
    try {
      db.prepare('INSERT OR IGNORE INTO dkg_component_actors VALUES (?,?)').run(invocationId, actorText);
      db.prepare('INSERT OR IGNORE INTO dkg_component_profiles VALUES (?,?,?)').run(invocationId, profile.id, profile.revision);
      db.prepare('INSERT INTO dkg_component_runs VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires')
        .run(invocationId, workflow.kaRef, workflow.sourceHash, encoded, Date.now() + 600000);
      db.exec('RELEASE dkg_profile_grant');
    } catch (error) {
      db.exec('ROLLBACK TO dkg_profile_grant');
      db.exec('RELEASE dkg_profile_grant');
      throw error;
    }
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
    assertDkgEnabled(definition, profile);
    validateDkgTopology(definition);
    if (
      !run ||
      run.expires < Date.now() ||
      run.ka_ref !== workflow.kaRef ||
      run.source_hash !== workflow.sourceHash
    )
      throw fail(
        "Run the approved workflow as its account owner before accessing DKG.",
      );
    const savedActor = db.prepare('SELECT actor FROM dkg_component_actors WHERE id=?').get(id);
    const actor = savedActor ? JSON.parse(savedActor.actor) : null;
    if (profile.requiresNosActor) {
      if (!actor || actor.accountId !== profile.accountId || actor.role !== 'owner') throw fail('No authenticated execution owner.');
      await profile.authorize(actor);
    }
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
    const scope = db.prepare('SELECT * FROM dkg_component_profiles WHERE id=?').get(id);
    if (!scope || scope.profile_id !== profile.id || scope.revision !== profile.revision)
      throw fail('Invocation execution profile mismatch.');
    profile.validateNode(node, rows, input);
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
    if (node.componentId === 'invoke-dkg-program' && prior?.result) return { items: JSON.parse(prior.result).items };
    if (node.componentId === "dkg-read" && prior?.result)
      return { items: profile.readItems(rows, JSON.parse(prior.result), node) };
    const pending = (async () => {
      if (!prior && node.componentId !== 'dkg-write')
        db.prepare("INSERT INTO dkg_component_calls VALUES (?,?,NULL)").run(
          key,
          requestHash,
        );
      if (node.componentId === 'invoke-dkg-program') {
        const request = programRequest(node, rows, id, profile);
        const result = programResult(await transport(request, 'invoke', { actor }), request);
        db.prepare('UPDATE dkg_component_calls SET result=? WHERE id=?').run(JSON.stringify(result), key);
        return { items: result.items };
      }
      if (node.componentId === "dkg-read") {
        const result = await transport(profile.readRequest(node, rows, input), 'read', { actor });
        const items = profile.readItems(rows, result, node);
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
      let programOutput;
      if (rows.length === 1 && rows[0]?.programExecution) {
        const incoming = definition.edges.find(e => e.to === node.id);
        const invoked = definition.nodes.find(n => n.id === incoming?.from && n.componentId === 'invoke-dkg-program');
        const completed = invoked && db.prepare('SELECT result FROM dkg_component_calls WHERE id=?').get(id + ':' + invoked.id);
        const confirmed = completed?.result && JSON.parse(completed.result);
        if (!confirmed || !isDeepStrictEqual(confirmed.items, rows)) throw fail('Program output differs from this execution.');
        programOutput = { ...confirmed.items[0], rawOutputs: confirmed.rawOutputs };
      }
      const savedWrite = db.prepare('SELECT * FROM dkg_component_writes WHERE id=?').get(key);
      const evidence = savedWrite ? JSON.parse(savedWrite.evidence)
        : profile.evidence(rows, context, JSON.parse(read.result), input, programOutput);
      const { payload, recordCount, summary = {} } = evidence;
      if (!prior) assertNoPendingWrite(workflow, id);
      // Persist the exact callback AND write payload before the first possible effect.
      // A new profile evaluation or a new native run must never stand in for this request.
      db.exec('SAVEPOINT dkg_write_request');
      try {
        db.prepare('INSERT OR IGNORE INTO dkg_component_calls VALUES (?,?,NULL)').run(key, requestHash);
        db.prepare('INSERT OR IGNORE INTO dkg_component_writes VALUES (?,?,?,NULL)').run(key, JSON.stringify(value), JSON.stringify(evidence));
        db.exec('RELEASE dkg_write_request');
      } catch (error) {
        db.exec('ROLLBACK TO dkg_write_request'); db.exec('RELEASE dkg_write_request'); throw error;
      }
      let result;
      try { result = prior?.result ? JSON.parse(prior.result) : await transport({ ...payload, allowCreate: !prior }, 'write', { actor }); }
      catch (error) {
        throw Object.assign(error, { status: error.status ?? 409, code: 'DKG_WRITE_PENDING', invocationId: id, n8nExecutionId: value.executionId });
      }
      if (
        result.contextGraphId !== profile.targetGraph ||
        result.digest !== payload.digest ||
        result.name !== payload.name ||
        result.readbackVerified !== true ||
        result.metadata?.status !== "wm-sealed"
      )
        throw Object.assign(fail("DKG write readback did not confirm this exact evidence."),
          { code: 'DKG_WRITE_PENDING', invocationId: id, n8nExecutionId: value.executionId });
      if (profile.requiresNosActor) await profile.authorize(actor);
      const receipt = {
        items: [
          {
            ...summary,
            node: profile.node,
            contextGraphId: profile.targetGraph,
            name: result.name,
            assetId: result.metadata.reservedUal,
            layer: "wm",
            status: "wm-sealed",
            readbackVerified: true,
            digest: payload.digest,
            recordCount,
            executionIri: context.executionIri,
            n8nExecutionId: value.executionId,
          },
        ],
      };
      db.exec('SAVEPOINT dkg_write_receipt');
      try {
        db.prepare('UPDATE dkg_component_calls SET result=? WHERE id=?').run(JSON.stringify(result), key);
        db.prepare('UPDATE dkg_component_writes SET receipt=? WHERE id=?').run(JSON.stringify(receipt), key);
        db.exec('RELEASE dkg_write_receipt');
      } catch (error) {
        db.exec('ROLLBACK TO dkg_write_receipt'); db.exec('RELEASE dkg_write_receipt'); throw error;
      }
      return receipt;
    })();
    active.set(key, pending);
    try {
      return await pending;
    } finally {
      active.delete(key);
    }
  }
  function writeRecovery(workflow, invocationId, workflowId, executionId) {
    const node = workflow.definition.nodes.find(n => n.componentId === 'dkg-write');
    if (!node) return null;
    const key = invocationId + ':' + node.id;
    const prior = db.prepare('SELECT * FROM dkg_component_calls WHERE id=?').get(key);
    if (!prior) return null;
    const saved = db.prepare('SELECT * FROM dkg_component_writes WHERE id=?').get(key);
    if (!saved) {
      if (prior.result) return null;
      throw Object.assign(fail('The legacy write has no saved request; operator reconciliation is required.'), { code: 'DKG_WRITE_PENDING', invocationId });
    }
    const request = JSON.parse(saved.request);
    if (hash(request) !== prior.request_hash || request.workflowId !== workflowId || request.executionId !== executionId)
      throw fail('The saved write belongs to a different native execution.');
    return { request, requestHash: prior.request_hash, pending: !prior.result };
  }
  return { grant, call, writeRecovery };
}
