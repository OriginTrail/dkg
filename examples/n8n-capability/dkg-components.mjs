import { invocationDefinition } from './studio-inputs.mjs';
import { createComponentRegistry } from './component-registry.mjs';
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { requireDkgOperation, validateDkgProfile } from './dkg-profile.mjs';
import { dkgComponentOperations, componentFailure as fail } from './dkg-component-operations.mjs';
import { migrateDkgInvocationMetadata } from './dkg-component-schema.mjs';
import { createDkgCallJournal } from './dkg-call-journal.mjs';

export const isDkg = (id) => ["dkg-read", "dkg-write", "invoke-dkg-program"].includes(id);
const hash = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function assertDkgEnabled(definition, profile = null) {
  for (const node of definition.nodes.filter(n => isDkg(n.componentId))) {
    const operation = requireDkgOperation(profile, node.componentId);
    if (!operation.enabled()) throw fail(node.componentId + ' is not enabled for this execution profile.');
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
export function dkgComponentStore(db, profile = null) {
  if (profile) profile = validateDkgProfile(profile);
  const registry = createComponentRegistry(profile);
  const inputSnapshots = new Map(), operationInputs = {};
  for (const [id, operation] of Object.entries(profile?.operations ?? {})) {
    if (!inputSnapshots.has(operation.loadInputs)) inputSnapshots.set(operation.loadInputs, operation.loadInputs?.() ?? []);
    operationInputs[id] = inputSnapshots.get(operation.loadInputs);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS dkg_component_runs(id TEXT PRIMARY KEY, ka_ref TEXT NOT NULL, source_hash TEXT NOT NULL, input TEXT NOT NULL, expires INTEGER NOT NULL);`);
  migrateDkgInvocationMetadata(db);
  const calls = createDkgCallJournal(db);
  db.exec('CREATE TABLE IF NOT EXISTS dkg_component_native_executions (id TEXT PRIMARY KEY, effect_id TEXT NOT NULL, workflow_id TEXT NOT NULL, execution_id TEXT NOT NULL)');
  const operations = dkgComponentOperations({ profile });
  const active = new Map();
  function assertNoPendingWrite(workflow, invocationId) {
    const node = workflow.definition.nodes.find(n => n.componentId === 'dkg-write');
    if (!node) return;
    const pending = calls.pendingWrite(workflow.kaRef, invocationId, node.id);
    if (pending) throw Object.assign(fail('Reconcile the previous DKG write before starting another invocation.'),
      { code: 'DKG_WRITE_PENDING', invocationId: pending });
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
    const resolved = invocationDefinition(workflow.definition, input, registry);
    validateDkgTopology(resolved);
    if (workflow.definition.inputs !== undefined)
      for (const node of resolved.nodes.filter(n => isDkg(n.componentId)))
        requireDkgOperation(profile, node.componentId).validateNode(node, JSON.parse(input.itemsJson), input);
    for (const id of new Set(resolved.nodes.filter(n => isDkg(n.componentId)).map(n => n.componentId)))
      requireDkgOperation(profile, id).validateInput(resolved, input, operationInputs[id]);
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
    const authority = journal.authority == null ? null : JSON.stringify(journal.authority);
    if (old && old.authority !== authority) throw fail('Invocation belongs to different original authority or an unscoped legacy run.');
    if (!old) assertNoPendingWrite(workflow, invocationId);
    const stored = db.prepare(`INSERT INTO dkg_component_runs
      (id,ka_ref,source_hash,input,expires,profile_id,profile_revision,actor,authority) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET expires=excluded.expires
      WHERE ka_ref=excluded.ka_ref AND source_hash=excluded.source_hash AND input=excluded.input
        AND profile_id=excluded.profile_id AND profile_revision=excluded.profile_revision AND actor=excluded.actor
        AND authority IS excluded.authority`)
      .run(invocationId, workflow.kaRef, revisionDigest, encoded, Date.now() + 600000, profile.id, profile.revision, actorText, authority);
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
    if (run.actor === null) throw fail('Unscoped legacy invocation has no recorded ownership.');
    const actor = JSON.parse(run.actor);
    const assertCurrentProfile = () => {
      assertDkgEnabled(definition, profile);
      if (run.profile_id !== profile.id || run.profile_revision !== profile.revision)
        throw fail('Invocation execution profile mismatch.');
      if (profile.requiresNosActor && (!actor || actor.accountId !== profile.accountId || actor.role !== 'owner'))
        throw fail('No authenticated execution owner.');
    };
    assertCurrentProfile();
    if (profile.requiresNosActor) await profile.authorize(actor);
    assertCurrentProfile();
    let node = definition.nodes.find(
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
    if (!isDeepStrictEqual(receivedInput, { invocationId: value.effectId, input }))
      throw fail('Native execution did not receive this invocation grant and its exact input.');
    workflow = { ...workflow, definition: invocationDefinition(definition, input, registry) };
    node = workflow.definition.nodes.find(n => n.id === node.id);
    validateDkgTopology(workflow.definition);
    const capability = requireDkgOperation(profile, node.componentId);
    capability.validateNode(node, rows, input);
    const invocationCalls = calls.invocation(id), requestHash = hash(value);
    const readPrior = () => invocationCalls.read(node.id, requestHash);
    const previous = readPrior();

    const binding = db.prepare('SELECT * FROM dkg_component_native_executions WHERE id=?').get(id);
    if (!binding && invocationCalls.hasCalls())
      throw fail('Legacy DKG calls lack a verified native execution binding; operator reconciliation required.');
    db.prepare('INSERT OR IGNORE INTO dkg_component_native_executions VALUES (?,?,?,?)').run(id, value.effectId, nativeId, value.executionId);
    const bound = db.prepare('SELECT * FROM dkg_component_native_executions WHERE id=?').get(id);
    if (bound.effect_id !== value.effectId || bound.workflow_id !== nativeId || bound.execution_id !== value.executionId)
      throw fail('This invocation belongs to a different native execution.');
    const authorize = async (readbackOnly = false) => {
      if (run.authority !== null && typeof journal.authorize !== 'function') throw fail('Original invocation authority verifier required.');
      const assertInvocationCurrent = await journal.authorize?.(run.authority === null ? null : JSON.parse(run.authority), { readbackOnly });
      // Both policies must remain current across authorization awaits, including
      // the caller's continuation immediately before effects or disclosure.
      const assertCurrent = () => { assertInvocationCurrent?.(); assertCurrentProfile(); };
      assertCurrent();
      return assertCurrent;
    };
    const assertCurrent = await authorize(!!previous);
    assertCurrent?.();
    // Another callback may journal this key while authorization awaits graph
    // access. Check its request identity before sharing any active response.
    const prior = readPrior();
    const activeCall = active.get(id)?.get(node.id);
    if (activeCall) {
      const response = await activeCall;
      const assertCurrent = await authorize(true);
      assertCurrent?.();
      return response;
    }
    const operation = operations[node.componentId];
    const dispatch = async (request, kind, options) => {
      const assertCurrent = await authorize(kind === 'write' && request.allowCreate === false);
      assertCurrent?.();
      return capability.transport(request, options);
    };
    const context = { node, rows, id, input, value, workflow, actor, dispatch,
      completedResult: invocationCalls.completedResult };
    function completedResponse(call) {
      if (call?.result !== null && call?.result !== undefined && call.response === null) {
        call.response = operation.legacyResponse({ ...context, prior: call });
        assertCurrentProfile();
        invocationCalls.adoptResponse(node.id, call.response);
      }
      assertCurrentProfile();
      return call?.response ?? null;
    }
    const replay = completedResponse(prior);
    if (replay !== null) return replay;
    const pending = (async () => {
      const { call, reconcile } = invocationCalls.prepare(node.id, requestHash, value, reconcile => {
        if (!reconcile && node.componentId === 'dkg-write') assertNoPendingWrite(workflow, id);
        return operation.prepare(context, reconcile);
      });
      const replay = completedResponse(call);
      if (replay !== null) return replay;
      const { result, response } = await operation.execute(context, call.prepared, { reconcile });
      const assertCurrent = await authorize(true);
      assertCurrent?.();
      invocationCalls.complete(node.id, result, response);
      return response;
    })();
    const activeBlocks = active.get(id) ?? new Map();
    active.set(id, activeBlocks); activeBlocks.set(node.id, pending);
    try {
      const response = await pending;
      assertCurrentProfile();
      return response;
    } finally {
      activeBlocks.delete(node.id);
      if (!activeBlocks.size) active.delete(id);
    }
  }
  function writeRecovery(workflow, invocationId, workflowId, executionId) {
    const node = workflow.definition.nodes.find(n => n.componentId === 'dkg-write');
    if (!node) return null;
    const prior = calls.invocation(invocationId).read(node.id);
    if (!prior) return null;
    if (!prior.request || !prior.prepared) {
      if (prior.result) return null;
      throw Object.assign(fail('The legacy write has no saved request; operator reconciliation is required.'), { code: 'DKG_WRITE_PENDING', invocationId });
    }
    const request = prior.request;
    if (hash(request) !== prior.requestHash || request.workflowId !== workflowId || request.executionId !== executionId)
      throw fail('The saved write belongs to a different native execution.');
    return { request, requestHash: prior.requestHash, pending: !prior.response && !prior.result };
  }
  return { grant, call, writeRecovery };
}
