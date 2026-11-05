import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { compileStudio } from './studio-definition.mjs';
import { n8nWorkflowSha256 } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';

/** The operator owns provisioning. Neither this API key nor credential data reaches a KA or browser. */
export function createStudioProvider({ state, config, graphId, owner, headerCredential, credentials, fetchImpl = fetch }) {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const file = join(state, 'studio.sqlite'), db = new DatabaseSync(file); chmodSync(file, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workflows (
    ka_ref TEXT PRIMARY KEY, name TEXT NOT NULL, provider_id TEXT, creating INTEGER DEFAULT 0,
    grant_json TEXT, activation_json TEXT, event_key TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (provider_id TEXT NOT NULL, execution_id TEXT NOT NULL,
    ka_ref TEXT NOT NULL, invocation_id TEXT NOT NULL, input_json TEXT, receipt_json TEXT, PRIMARY KEY(provider_id,execution_id));`);
  if (!db.prepare('PRAGMA table_info(events)').all().some(c => c.name === 'input_json')) db.exec('ALTER TABLE events ADD COLUMN input_json TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS studio_saved_native (
    ka_ref TEXT PRIMARY KEY, compiled_json TEXT NOT NULL, published_json TEXT NOT NULL,
    withdrawn INTEGER NOT NULL DEFAULT 0);`);
  const error = message => Object.assign(new Error(message), { status: 409, code: 'INVALID_WORKFLOW' });
  const row = ref => db.prepare('SELECT * FROM workflows WHERE ka_ref=?').get(ref);
  async function api(path, method = 'GET', body) {
    const installation = config.n8nNative;
    const token = readFileSync(installation.apiTokenFile, 'utf8').trim();
    const res = await fetchImpl(new URL('/api/v1' + path, installation.baseUrl), { method, redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { 'X-N8N-API-KEY': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!res.ok) { await res.body?.cancel(); throw error('n8n did not confirm provisioning (' + res.status + '). Retry this save.'); }
    let size = 0; const chunks = [];
    for await (const chunk of res.body ?? []) {
      size += chunk.byteLength;
      if (size > 1_048_576) throw error('n8n response exceeds the PoC limit.');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const installGrant = grant => {
    if (grant.kind === 'program-workflow-v1') return;
    const flows = config.n8nNative.workflows;
    const current = flows.find(w => w.workflowId === grant.workflowId && w.contextGraphId === graphId && w.executorAgentAddress === owner);
    if (current && current.workflowSha256 !== grant.workflowSha256) throw error('An installed native workflow revision changed.');
    if (!current) { if (flows.length >= 64) throw error('The native installation inventory is full.');
      flows.push({ contextGraphId: graphId, executorAgentAddress: owner, workflowId: grant.workflowId, workflowSha256: grant.workflowSha256 }); }
  };
  for (const saved of db.prepare('SELECT grant_json FROM workflows WHERE grant_json IS NOT NULL').all()) installGrant(JSON.parse(saved.grant_json));
  async function provision(definition) {
    let compiled = compileStudio(definition, { graphId, owner, headerCredential, credentials });
    let saved = row(compiled.kaRef);
    if (!saved) {
      if (Number(db.prepare('SELECT COUNT(*) AS n FROM workflows').get().n) >= 24) throw error('The PoC supports 24 saved graph revisions.');
      db.prepare('INSERT INTO workflows (ka_ref,name,created_at) VALUES (?,?,?)').run(compiled.kaRef, compiled.workflowName, Date.now());
      saved = row(compiled.kaRef);
    }
    if (compiled.executor === 'dkg') {
      if (saved.grant_json && JSON.parse(saved.grant_json).kind !== 'program-workflow-v1') throw error('The saved workflow executor changed.');
      db.prepare('UPDATE workflows SET grant_json=? WHERE ka_ref=?').run(JSON.stringify(compiled.grant), compiled.kaRef);
      return compiled;
    }
    if (!saved.provider_id) {
      let cursor, found = [];
      for (let page = 0; page < 8; page++) {
        const list = await api('/workflows?limit=10&excludePinnedData=true&name=' + encodeURIComponent(compiled.workflowName) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        found.push(...list.data.filter(w => w.name === compiled.workflowName)); cursor = list.nextCursor;
        if (!cursor) break;
      }
      if (cursor) throw error('Native graph lookup is incomplete; reconcile before creating another workflow.');
      if (found.length > 1) throw error('Duplicate native graph definitions require operator inspection.');
      let created = found[0];
      if (!created) {
        if (saved.creating) throw error('An earlier create request is unconfirmed. Its identity is retained for reconciliation.');
        db.prepare('UPDATE workflows SET creating=1 WHERE ka_ref=?').run(compiled.kaRef);
        created = await api('/workflows', 'POST', compiled.workflow);
      }
      if (typeof created.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(created.id)) throw error('Native graph identity is invalid.');
      db.prepare('UPDATE workflows SET provider_id=?, creating=0 WHERE ka_ref=?').run(created.id, compiled.kaRef);
      saved = row(compiled.kaRef);
    }
    compiled = compileStudio(definition, { graphId, owner, headerCredential, credentials, providerId: saved.provider_id });
    let native = await api('/workflows/' + saved.provider_id);
    if (!saved.grant_json) {
      // A newly allocated workflow has no publication or callers. Fix its scoped trigger before publishing it.
      if (native.active) throw error('An unreviewed native graph was published outside this service.');
      native = await api('/workflows/' + saved.provider_id, 'PUT', compiled.workflow);
      const grant = { ...compiled.grant, workflowSha256: n8nWorkflowSha256(native) };
      db.prepare('UPDATE workflows SET grant_json=? WHERE ka_ref=?').run(JSON.stringify(grant), compiled.kaRef);
      saved = row(compiled.kaRef);
    }
    const grant = JSON.parse(saved.grant_json);
    if (n8nWorkflowSha256(native.activeVersion ? { ...native.activeVersion, settings: native.settings } : native) !== grant.workflowSha256) throw error('The native graph differs from the saved revision.');
    installGrant(grant);
    if (compiled.mode !== 'schedule' && !native.active) await api('/workflows/' + saved.provider_id + '/publish', 'POST', {});
    return { ...compiled, grant };
  }
  async function setPublished(ref, active) {
    const saved = row(ref); if (!saved?.grant_json) throw error('Save this graph first.');
    const native = await api('/workflows/' + saved.provider_id);
    const grant = JSON.parse(saved.grant_json);
    if (n8nWorkflowSha256(native.activeVersion ? { ...native.activeVersion, settings: native.settings } : native) !== grant.workflowSha256) throw error('The native graph revision changed.');
    if (!!native.active !== active) await api('/workflows/' + saved.provider_id + (active ? '/publish' : '/unpublish'), 'POST', {});
  }
  const fingerprint = path => createHash('sha256').update(readFileSync(path, 'utf8').trim()).digest('hex');
  // Record only after the owner's complete save succeeds. Failed provisioning is
  // not a saved/approved workflow. Existing installations must save once again.
  async function recordSavedNative(compiled) {
    if (compiled.executor === 'dkg' || ['schedule', 'webhook'].includes(compiled.mode)) return;
    const native = await api('/workflows/' + compiled.grant.workflowId);
    const published = native.activeVersion ? { ...native.activeVersion, settings: native.settings } : native;
    if (!native.active || n8nWorkflowSha256(published) !== compiled.grant.workflowSha256) throw error('Saved native revision is unavailable.');
    db.prepare('INSERT INTO studio_saved_native (ka_ref,compiled_json,published_json) VALUES (?,?,?) ON CONFLICT(ka_ref) DO NOTHING')
      .run(compiled.kaRef, JSON.stringify({ definition: compiled.definition, grant: compiled.grant, mode: compiled.mode, kaRef: compiled.kaRef }), JSON.stringify(published));
  }
  return { db, row, api, provision, setPublished, fingerprint, installGrant, recordSavedNative, close: () => db.close() };
}
