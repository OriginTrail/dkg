import { readFileSync } from 'node:fs';
import { createStudioRepository } from './studio-repository.mjs';
import { createHash } from 'node:crypto';
import { compileStudio } from './studio-definition.mjs';
import { nativeTimerEvents } from './studio-native-events.mjs';
import { n8nWorkflowSha256, n8nResultSha256 } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';

/** The operator owns provisioning. Neither this API key nor credential data reaches a KA or browser. */
export function createStudioProvider({ state, config, graphId, owner, headerCredential, credentials, fetchImpl = fetch }) {
  const repository = createStudioRepository(state), { db, row } = repository;
  const error = message => Object.assign(new Error(message), { status: 409, code: 'INVALID_WORKFLOW' });
  async function api(path, method = 'GET', body) {
    const installation = config.n8nNative;
    const token = readFileSync(installation.apiTokenFile, 'utf8').trim();
    const res = await fetchImpl(new URL('/api/v1' + path, installation.baseUrl), { method, redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { 'X-N8N-API-KEY': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!res.ok) { await res.body?.cancel(); throw error('n8n did not confirm provisioning (' + res.status + '). Retry this save.'); }
    const bytes = await res.text(); if (bytes.length > 1_048_576) throw error('n8n response exceeds the PoC limit.');
    return JSON.parse(bytes);
  }
  const installGrant = grant => {
    const flows = config.n8nNative.workflows;
    const current = flows.find(w => w.workflowId === grant.workflowId && w.contextGraphId === graphId && w.executorAgentAddress === owner);
    if (current && current.workflowSha256 !== grant.workflowSha256) throw error('An installed native workflow revision changed.');
    const resultSha256 = n8nResultSha256(grant);
    if (current && current.resultSha256 !== resultSha256) throw error('The installed output contract requires operator review.');
    if (!current) { if (flows.length >= 64) throw error('The native installation inventory is full.');
      flows.push({ contextGraphId: graphId, executorAgentAddress: owner, workflowId: grant.workflowId, workflowSha256: grant.workflowSha256, resultSha256 }); }
  };
  for (const saved of db.prepare('SELECT grant_json FROM workflows WHERE grant_json IS NOT NULL').all()) installGrant(JSON.parse(saved.grant_json));
  async function provision(definition) {
    let compiled = compileStudio(definition, { graphId, owner, headerCredential, credentials });
    if (!compiled.workflow || !compiled.grant?.toolIri) throw error('Native provisioning requires an n8n execution plan.');
    let saved = repository.ensure(compiled);
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
  const timerEvents = options => nativeTimerEvents(api, { ...options, graphId, owner });
  return { repository, db, row, api, provision, setPublished, fingerprint, installGrant, timerEvents, close: repository.close };
}
