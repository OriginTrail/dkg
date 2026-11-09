import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { configuredDkgProfile, requireDkgProfile } from './dkg-profile.mjs';
import { dkgComponentOperations, componentFailure as fail } from './dkg-component-operations.mjs';
import { migrateDkgInvocationMetadata } from './dkg-component-schema.mjs';

export const isDkg = (id) => ["dkg-read", "dkg-write", "invoke-dkg-program"].includes(id);
const hash = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
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
    CREATE TABLE IF NOT EXISTS dkg_component_calls(id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result TEXT, response TEXT);`);
  migrateDkgInvocationMetadata(db);
  db.exec('CREATE TABLE IF NOT EXISTS dkg_component_writes (id TEXT PRIMARY KEY, request TEXT NOT NULL, evidence TEXT NOT NULL, receipt TEXT)');
  db.exec('CREATE TABLE IF NOT EXISTS dkg_component_native_executions (id TEXT PRIMARY KEY, effect_id TEXT NOT NULL, workflow_id TEXT NOT NULL, execution_id TEXT NOT NULL)');
  // Retain operation evidence in result; only response is returned to native callers.
  // Older completed calls acquire a response lazily after the same authority checks.
  if (!db.prepare('PRAGMA table_info(dkg_component_calls)').all().some(column => column.name === 'response'))
    db.exec('ALTER TABLE dkg_component_calls ADD COLUMN response TEXT');
  const operations = dkgComponentOperations({ db, profile, transport, assertNoPendingWrite });
  const active = new Map();
  function assertNoPendingWrite(workflow, invocationId) {
    const node = workflow.definition.nodes.find(n => n.componentId === 'dkg-write');
    if (!node) return;
    const pending = db.prepare(`SELECT r.id FROM dkg_component_runs r JOIN dkg_component_calls c ON c.id=r.id||':'||?
      WHERE r.ka_ref=? AND r.id<>? AND c.response IS NULL AND c.result IS NULL LIMIT 1`).get(node.id, workflow.kaRef, invocationId);
    if (pending) throw Object.assign(fail('Reconcile the previous DKG write before starting another invocation.'),
      { code: 'DKG_WRITE_PENDING', invocationId: pending.id });
  }
  // Adapters resolve their wire identities. The legacy source_hash column stores
  // the explicit revision digest for either protocol; journal keys stay unchanged.
  function journalScope(scope) {
    if (!scope || typeof scope.invocationId !== 'string' || !scope.invocationId || scope.invocationId.length > 128
      || typeof scope.revisionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(scope.revisionDigest))
      throw fail('Invocation identity and revision digest required.');
    return scope;
  }
  function grant(workflow, journal, input, actor) {
    const { invocationId, revisionDigest } = journalScope(journal);
    if (profile?.requiresNosActor && (!actor || actor.role !== 'owner' || actor.accountId !== profile.accountId))
      throw fail('Authenticated nOS owner required.');
    const actorText = JSON.stringify(actor ?? null);
    const old = db.prepare('SELECT * FROM dkg_component_runs WHERE id=?').get(invocationId);
    if (old && (old.actor !== null && old.actor !== actorText || profile?.requiresNosActor && old.actor === null))
      throw fail('This invocation belongs to a different account or principal.');
    assertDkgEnabled(workflow.definition, profile);
    profile.validateInput(workflow.definition, input, approvedInputs);
    const encoded = JSON.stringify(input);
    if (
      old &&
      (old.ka_ref !== workflow.kaRef ||
        old.source_hash !== revisionDigest ||
        old.input !== encoded)
    )
      throw fail(
        "Invocation identity belongs to different workflow or inputs.",
      );
    if (old && (old.profile_id !== profile.id || old.profile_revision !== profile.revision))
      throw fail('Invocation identity belongs to a different execution profile or an unscoped legacy run.');
    if (old && old.actor === null) throw fail('Unscoped legacy invocation has no recorded ownership.');
    if (!old) assertNoPendingWrite(workflow, invocationId);
    const stored = db.prepare(`INSERT INTO dkg_component_runs
      (id,ka_ref,source_hash,input,expires,profile_id,profile_revision,actor) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET expires=excluded.expires
      WHERE ka_ref=excluded.ka_ref AND source_hash=excluded.source_hash AND input=excluded.input
        AND profile_id=excluded.profile_id AND profile_revision=excluded.profile_revision AND actor=excluded.actor`)
      .run(invocationId, workflow.kaRef, revisionDigest, encoded, Date.now() + 600000, profile.id, profile.revision, actorText);
    if (stored.changes !== 1) throw fail('Invocation identity belongs to different workflow, inputs, profile or principal.');
  }
  async function call(value, workflow, journal, nativeId, receivedInput) {
    const { invocationId: id, revisionDigest } = journalScope(journal);
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
    if (
      typeof value.effectId !== 'string' || !value.effectId ||
      value.workflowId !== nativeId ||
      !/^\d{1,20}$/.test(value.executionId ?? "") ||
      typeof value.blockId !== "string"
    )
      throw fail("Native execution identity required.");
    const run = db.prepare("SELECT * FROM dkg_component_runs WHERE id=?").get(id),
      definition = workflow.definition;
    assertDkgEnabled(definition, profile);
    validateDkgTopology(definition);
    if (
      !run ||
      run.expires < Date.now() ||
      run.ka_ref !== workflow.kaRef ||
      run.source_hash !== revisionDigest
    )
      throw fail(
        "Run the approved workflow as its account owner before accessing DKG.",
      );
    if (run.profile_id !== profile.id || run.profile_revision !== profile.revision)
      throw fail('Invocation execution profile mismatch.');
    if (run.actor === null) throw fail('Unscoped legacy invocation has no recorded ownership.');
    const actor = JSON.parse(run.actor);
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
    if (!isDeepStrictEqual(receivedInput, { invocationId: value.effectId, input }))
      throw fail('Native execution did not receive this invocation grant and its exact input.');
    const binding = db.prepare('SELECT * FROM dkg_component_native_executions WHERE id=?').get(id);
    // Block IDs cannot contain colons, but MCP run keys can. Only exact keys
    // from this pinned workflow are evidence of calls belonging to this run.
    if (!binding && definition.nodes.some(n => isDkg(n.componentId)
      && db.prepare('SELECT 1 FROM dkg_component_calls WHERE id=?').get(id + ':' + n.id)))
      throw fail('Legacy DKG calls lack a verified native execution binding; operator reconciliation required.');
    db.prepare('INSERT OR IGNORE INTO dkg_component_native_executions VALUES (?,?,?,?)').run(id, value.effectId, nativeId, value.executionId);
    const bound = db.prepare('SELECT * FROM dkg_component_native_executions WHERE id=?').get(id);
    if (bound.effect_id !== value.effectId || bound.workflow_id !== nativeId || bound.execution_id !== value.executionId)
      throw fail('This invocation belongs to a different native execution.');
    if (active.has(key)) return active.get(key);
    const operation = operations[node.componentId];
    const context = { node, rows, id, key, input, value, workflow, actor, prior };
    if (prior?.result && !prior.response) {
      const response = operation.legacyResponse(context);
      db.prepare('UPDATE dkg_component_calls SET response=? WHERE id=?').run(JSON.stringify(response), key);
      prior.response = JSON.stringify(response);
    }
    if (prior?.response) return JSON.parse(prior.response);
    const pending = (async () => {
      let execute;
      db.exec('SAVEPOINT dkg_call_pending');
      try {
        db.prepare('INSERT OR IGNORE INTO dkg_component_calls (id,request_hash,result,response) VALUES (?,?,NULL,NULL)').run(key, requestHash);
        execute = operation.prepare(context);
        db.exec('RELEASE dkg_call_pending');
      } catch (error) {
        db.exec('ROLLBACK TO dkg_call_pending'); db.exec('RELEASE dkg_call_pending'); throw error;
      }
      const { result, response } = await execute();
      // Evidence and the exact outward response become complete atomically.
      db.prepare('UPDATE dkg_component_calls SET result=?,response=? WHERE id=?').run(JSON.stringify(result), JSON.stringify(response), key);
      return response;
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
    return { request, requestHash: prior.request_hash, pending: !prior.response && !prior.result };
  }
  return { grant, call, writeRecovery };
}
