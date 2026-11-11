import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStudioMcpRepository } from './studio-mcp-repository.mjs';

const invalid = message => { throw Object.assign(new Error(message), { status: 409, code: 'INVALID_WORKFLOW' }); };
/** Saved revisions and event identities belong to Studio, independently of the executor. */
export function createStudioRepository(state) {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const file = join(state, 'studio.sqlite'), db = new DatabaseSync(file); chmodSync(file, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workflows (
    ka_ref TEXT PRIMARY KEY, name TEXT NOT NULL, provider_id TEXT, creating INTEGER DEFAULT 0,
    grant_json TEXT, activation_json TEXT, event_key TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (provider_id TEXT NOT NULL, execution_id TEXT NOT NULL,
    ka_ref TEXT NOT NULL, invocation_id TEXT NOT NULL, input_json TEXT, receipt_json TEXT, PRIMARY KEY(provider_id,execution_id));`);
  let mcp;
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db.prepare('PRAGMA table_info(workflows)').all();
    if (!columns.some(c => c.name === 'executor')) db.exec('ALTER TABLE workflows ADD COLUMN executor TEXT');
    if (!columns.some(c => c.name === 'requires_export')) db.exec('ALTER TABLE workflows ADD COLUMN requires_export INTEGER NOT NULL DEFAULT 0');
    if (!columns.some(c => c.name === 'unpublish_pending')) db.exec('ALTER TABLE workflows ADD COLUMN unpublish_pending TEXT');
    if (!columns.some(c => c.name === 'activation_revision')) db.exec('ALTER TABLE workflows ADD COLUMN activation_revision INTEGER NOT NULL DEFAULT 0');
    if (!columns.some(c => c.name === 'mode')) db.exec('ALTER TABLE workflows ADD COLUMN mode TEXT');
    if (!columns.some(c => c.name === 'source_hash')) db.exec('ALTER TABLE workflows ADD COLUMN source_hash TEXT');
    if (!db.prepare('PRAGMA table_info(events)').all().some(c => c.name === 'input_json')) db.exec('ALTER TABLE events ADD COLUMN input_json TEXT');
    // Only legacy schemas lack completion metadata. In current schemas a null
    // executor is an unfinished save, even when native provisioning has a grant.
    if (!columns.some(c => c.name === 'executor')) for (const saved of db.prepare('SELECT ka_ref,grant_json FROM workflows WHERE executor IS NULL AND grant_json IS NOT NULL').all()) {
      const grant = JSON.parse(saved.grant_json), program = grant.kind === 'program-workflow-v1';
      db.prepare('UPDATE workflows SET executor=?,requires_export=?,grant_json=? WHERE ka_ref=?').run(
        program ? 'dkg-program' : 'native-n8n', grant.requiresExportAuthorization ? 1 : 0, program ? null : saved.grant_json, saved.ka_ref);
    }
    mcp = createStudioMcpRepository(db);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  const row = ref => db.prepare('SELECT * FROM workflows WHERE ka_ref=?').get(ref);
  function ensure(compiled) {
    if (!row(compiled.kaRef)) {
      if (Number(db.prepare('SELECT COUNT(*) AS n FROM workflows').get().n) >= 24) invalid('The PoC supports 24 saved graph revisions.');
      db.prepare('INSERT INTO workflows (ka_ref,name,created_at) VALUES (?,?,?)').run(compiled.kaRef, compiled.workflowName, Date.now());
    }
    return workflow(compiled.kaRef);
  }
  function saved(ref, kind, requiresExportAuthorization) {
    const existing = row(ref);
    if (!existing || !['dkg-program', 'native-n8n'].includes(kind)
      || existing.executor && existing.executor !== kind
      || kind === 'native-n8n' && !existing.grant_json
      || kind === 'dkg-program' && (existing.grant_json || existing.provider_id)) invalid('The saved workflow executor changed.');
    db.prepare('UPDATE workflows SET executor=?,requires_export=MAX(requires_export,?) WHERE ka_ref=?').run(kind, requiresExportAuthorization ? 1 : 0, ref);
  }
  function completeSave(compiled, kind, requiresExportAuthorization, published, sourceHash = null) {
    const needsSnapshot = kind === 'native-n8n' && !['schedule', 'webhook'].includes(compiled.mode);
    if (needsSnapshot !== (published !== undefined)) invalid('Save completion requires the verified native snapshot.');
    db.exec('BEGIN IMMEDIATE');
    try {
      saved(compiled.kaRef, kind, requiresExportAuthorization);
      const existing = row(compiled.kaRef);
      if (existing.mode && existing.mode !== compiled.mode || existing.source_hash && existing.source_hash !== sourceHash)
        invalid('The saved graph revision changed.');
      db.prepare('UPDATE workflows SET mode=?,source_hash=? WHERE ka_ref=?').run(compiled.mode, sourceHash, compiled.kaRef);
      if (needsSnapshot) mcp.recordSavedNative(compiled, published);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function nativeRevision(ref) {
    const saved = row(ref);
    return saved && { providerId: saved.provider_id, creating: !!saved.creating,
      grant: saved.grant_json ? JSON.parse(saved.grant_json) : null };
  }
  function beginNativeCreate(ref) {
    const result = db.prepare(`UPDATE workflows SET creating=1 WHERE ka_ref=? AND provider_id IS NULL AND creating=0
      AND (executor IS NULL OR executor='native-n8n')`).run(ref);
    if (result.changes !== 1) invalid('An earlier create request is unconfirmed. Its identity is retained for reconciliation.');
  }
  function nativeCreated(ref, providerId) {
    const result = db.prepare(`UPDATE workflows SET provider_id=?,creating=0 WHERE ka_ref=?
      AND (provider_id IS NULL OR provider_id=?) AND (executor IS NULL OR executor='native-n8n')`).run(providerId, ref, providerId);
    if (result.changes !== 1) invalid('The native workflow identity changed.');
    return nativeRevision(ref);
  }
  function nativeGranted(ref, grant) {
    const encoded = JSON.stringify(grant);
    const result = db.prepare(`UPDATE workflows SET grant_json=? WHERE ka_ref=? AND provider_id=?
      AND (grant_json IS NULL OR grant_json=?) AND (executor IS NULL OR executor='native-n8n')`).run(encoded, ref, grant.workflowId, encoded);
    if (result.changes !== 1) invalid('The native workflow grant changed.');
    return nativeRevision(ref);
  }
  const lifecycleValue = value => value && ({ kaRef: value.ka_ref, providerId: value.provider_id,
    executor: value.executor, mode: value.mode, sourceHash: value.source_hash,
    activation: value.activation_json ? JSON.parse(value.activation_json) : { active: false },
    revision: value.activation_revision, eventKey: value.event_key, pendingUnpublication: value.unpublish_pending });
  // Decode one row so authority and its revision always describe the same state.
  const lifecycle = ref => lifecycleValue(row(ref));
  const workflow = ref => {
    const value = row(ref);
    return value && { ...lifecycleValue(value), completed: value.executor !== null, requiresExportAuthorization: !!value.requires_export };
  };
  const activation = ref => lifecycle(ref)?.activation ?? { active: false };
  const eventValue = value => value && ({ kaRef: value.ka_ref, providerId: value.provider_id, executionId: value.execution_id,
    invocationId: value.invocation_id, receipt: value.receipt_json ? JSON.parse(value.receipt_json) : null });
  function setActivation(ref, value, eventKey = null, expectedRevision = row(ref)?.activation_revision) {
    if (!Number.isSafeInteger(expectedRevision)) invalid('The workflow activation changed.');
    const result = db.prepare(`UPDATE workflows SET activation_json=?,event_key=?,activation_revision=activation_revision+1 WHERE ka_ref=?
      AND activation_revision=? AND (?=0 OR unpublish_pending IS NULL)`)
      .run(JSON.stringify(value), eventKey, ref, expectedRevision, value.active ? 1 : 0);
    if (result.changes !== 1) invalid('The workflow activation changed or native schedule cleanup is pending. Retry activation.');
  }
  function deactivate(ref, activationId, unpublish, expectedRevision = null) {
    // Revoke event access and retain cleanup together, before any provider await.
    const result = db.prepare(`UPDATE workflows SET activation_json=?,event_key=NULL,activation_revision=activation_revision+1,
      unpublish_pending=CASE WHEN ? THEN ? ELSE unpublish_pending END WHERE ka_ref=?
      AND (? IS NULL OR activation_revision=?)`)
      .run(JSON.stringify({ active: false, activationId }), unpublish ? 1 : 0, activationId, ref, expectedRevision, expectedRevision);
    return result.changes === 1;
  }
  /** Authorization is synchronous, so admission, replay and quota see one database state. */
  function reserveEvent({ kaRef, providerId, executionId, invocationId, inputJson }, authorize) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (row(kaRef)?.provider_id !== providerId) invalid('The event workflow identity changed.');
      const previous = db.prepare('SELECT * FROM events WHERE provider_id=? AND execution_id=?').get(providerId, executionId);
      if (previous && (previous.ka_ref !== kaRef || inputJson !== undefined && previous.input_json !== inputJson))
        invalid('This event identity already belongs to different input or workflow.');
      authorize();
      const a = activation(kaRef);
      if (!a.active || a.expiresAt < Date.now()) invalid('This event workflow is inactive.');
      if (!previous) {
        if (a.count >= 5) invalid('This event workflow has reached its PoC event limit.');
        db.prepare('INSERT INTO events (provider_id,execution_id,ka_ref,invocation_id,input_json) VALUES (?,?,?,?,?)')
          .run(providerId, executionId, kaRef, invocationId, inputJson ?? null);
        a.count++;
        db.prepare('UPDATE workflows SET activation_json=? WHERE ka_ref=?').run(JSON.stringify(a), kaRef);
      }
      const event = eventValue(previous ?? db.prepare('SELECT * FROM events WHERE provider_id=? AND execution_id=?').get(providerId, executionId));
      db.exec('COMMIT');
      return event;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function completeEvent(event, receipt) {
    const encoded = JSON.stringify(receipt);
    const result = db.prepare(`UPDATE events SET receipt_json=? WHERE provider_id=? AND execution_id=? AND ka_ref=? AND invocation_id=?
      AND (receipt_json IS NULL OR receipt_json=?)`).run(encoded, event.providerId, event.executionId, event.kaRef, event.invocationId, encoded);
    if (result.changes !== 1) invalid('The reserved event identity or completed receipt changed.');
    return receipt;
  }
  return { db, mcp, workflow, ensure, saved, completeSave, nativeRevision, beginNativeCreate, nativeCreated, nativeGranted, lifecycle, activation, setActivation, deactivate, reserveEvent, completeEvent,
    pendingUnpublications: () => db.prepare('SELECT * FROM workflows WHERE unpublish_pending IS NOT NULL').all().map(lifecycleValue),
    completeUnpublication: (ref, activationId) => db.prepare('UPDATE workflows SET unpublish_pending=NULL WHERE ka_ref=? AND unpublish_pending=?')
      .run(ref, activationId),
    nativeWorkflow: providerId => db.prepare('SELECT ka_ref FROM workflows WHERE provider_id=?').get(providerId)?.ka_ref,
    hasActiveWorkflows: () => db.prepare('SELECT * FROM workflows WHERE activation_json IS NOT NULL').all().some(r => lifecycleValue(r).activation.active),
    eventWorkflow: key => lifecycleValue(db.prepare('SELECT * FROM workflows WHERE event_key=?').get(key)),
    activatedWorkflows: () => db.prepare('SELECT * FROM workflows WHERE activation_json IS NOT NULL').all().map(lifecycleValue),
    pendingEvents: ref => db.prepare('SELECT * FROM events WHERE ka_ref=? AND receipt_json IS NULL').all(ref).map(eventValue),
    eventHistory: ref => db.prepare('SELECT * FROM events WHERE ka_ref=? ORDER BY rowid DESC LIMIT 20').all(ref)
      .map(value => { const event = eventValue(value); return { invocationId: event.invocationId, triggerExecutionId: event.executionId, receipt: event.receipt }; }),
    list: () => db.prepare('SELECT ka_ref FROM workflows WHERE executor IS NOT NULL ORDER BY created_at DESC LIMIT 24').all().map(value => value.ka_ref),
    close: () => db.close() };
}
