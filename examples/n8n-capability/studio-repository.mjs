import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db.prepare('PRAGMA table_info(workflows)').all();
    if (!columns.some(c => c.name === 'executor')) db.exec('ALTER TABLE workflows ADD COLUMN executor TEXT');
    if (!columns.some(c => c.name === 'requires_export')) db.exec('ALTER TABLE workflows ADD COLUMN requires_export INTEGER NOT NULL DEFAULT 0');
    if (!db.prepare('PRAGMA table_info(events)').all().some(c => c.name === 'input_json')) db.exec('ALTER TABLE events ADD COLUMN input_json TEXT');
    for (const saved of db.prepare('SELECT ka_ref,grant_json FROM workflows WHERE executor IS NULL AND grant_json IS NOT NULL').all()) {
      const grant = JSON.parse(saved.grant_json), program = grant.kind === 'program-workflow-v1';
      db.prepare('UPDATE workflows SET executor=?,requires_export=?,grant_json=? WHERE ka_ref=?').run(
        program ? 'dkg-program' : 'native-n8n', grant.requiresExportAuthorization ? 1 : 0, program ? null : saved.grant_json, saved.ka_ref);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  const row = ref => db.prepare('SELECT * FROM workflows WHERE ka_ref=?').get(ref);
  function ensure(compiled) {
    if (!row(compiled.kaRef)) {
      if (Number(db.prepare('SELECT COUNT(*) AS n FROM workflows').get().n) >= 24) invalid('The PoC supports 24 saved graph revisions.');
      db.prepare('INSERT INTO workflows (ka_ref,name,created_at) VALUES (?,?,?)').run(compiled.kaRef, compiled.workflowName, Date.now());
    }
    return row(compiled.kaRef);
  }
  function saved(ref, kind, requiresExportAuthorization) {
    const existing = row(ref);
    if (!existing || !['dkg-program', 'native-n8n'].includes(kind)
      || existing.executor && existing.executor !== kind
      || kind === 'native-n8n' && !existing.grant_json
      || kind === 'dkg-program' && (existing.grant_json || existing.provider_id)) invalid('The saved workflow executor changed.');
    db.prepare('UPDATE workflows SET executor=?,requires_export=? WHERE ka_ref=?').run(kind, requiresExportAuthorization ? 1 : 0, ref);
  }
  return { db, row, ensure, saved,
    list: () => db.prepare('SELECT ka_ref FROM workflows WHERE executor IS NOT NULL ORDER BY created_at DESC LIMIT 24').all(),
    close: () => db.close() };
}
