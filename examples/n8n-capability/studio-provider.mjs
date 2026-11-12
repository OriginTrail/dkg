import { readFileSync } from 'node:fs';
import { requestN8nJson } from '../../packages/cli/dist/semantic-runtime-n8n-wire.js';
import { createStudioCompiler } from './studio-definition.mjs';
import { nativeTimerEvents } from './studio-native-events.mjs';
import { readNativeExecutionInput } from './studio-native-execution.mjs';
import { n8nWorkflowSha256, n8nResultSha256 } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';

/** The operator owns provisioning. Neither this API key nor credential data reaches a KA or browser. */
export function createStudioProvider({ repository, config, graphId, owner, headerCredential, credentials, fetchImpl = fetch, compiler = createStudioCompiler() }) {
  const { compileStudio, studioProgramSource } = compiler;
  const error = message => Object.assign(new Error(message), { status: 409, code: 'INVALID_WORKFLOW' });
  async function api(path, method = 'GET', body) {
    const installation = config.n8nNative;
    const token = readFileSync(installation.apiTokenFile, 'utf8').trim();
    return requestN8nJson(new URL('/api/v1' + path, installation.baseUrl), {
      method, body, signal: AbortSignal.timeout(12000), maxBytes: 1_048_576, send: fetchImpl,
      headers: { 'X-N8N-API-KEY': token },
      error: (code, context) => error(code === 'N8N_RESPONSE_TOO_LARGE' ? 'n8n response exceeds the PoC limit.'
        : code === 'N8N_RESPONSE_INVALID' ? 'n8n returned an invalid provisioning response. Retry this save.'
          : 'n8n did not confirm provisioning (' + context.status + '). Retry this save.'),
    });
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
  async function provision(definition) {
    // Check the complete serialized source before repository or remote effects.
    // The provider accepts identifiers of at most 80 ASCII characters.
    studioProgramSource(compileStudio(definition, { graphId, owner, headerCredential, credentials, providerId: 'W'.repeat(80) }));
    let compiled = compileStudio(definition, { graphId, owner, headerCredential, credentials });
    if (compiled.kind !== 'native-n8n' || !compiled.workflow) throw error('Native provisioning requires an n8n execution plan.');
    repository.ensure(compiled);
    let saved = repository.nativeRevision(compiled.kaRef);
    if (!saved.providerId) {
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
        repository.beginNativeCreate(compiled.kaRef);
        created = await api('/workflows', 'POST', compiled.workflow);
      }
      if (typeof created.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(created.id)) throw error('Native graph identity is invalid.');
      saved = repository.nativeCreated(compiled.kaRef, created.id);
    }
    compiled = compileStudio(definition, { graphId, owner, headerCredential, credentials, providerId: saved.providerId });
    let native = await api('/workflows/' + saved.providerId);
    if (!saved.grant) {
      // A newly allocated workflow has no publication or callers. Fix its scoped trigger before publishing it.
      if (native.active) throw error('An unreviewed native graph was published outside this service.');
      native = await api('/workflows/' + saved.providerId, 'PUT', compiled.workflow);
      const grant = { ...compiled.grant, workflowSha256: n8nWorkflowSha256(native) };
      saved = repository.nativeGranted(compiled.kaRef, grant);
    }
    const grant = saved.grant;
    if (n8nWorkflowSha256(native.activeVersion ? { ...native.activeVersion, settings: native.settings } : native) !== grant.workflowSha256) throw error('The native graph differs from the saved revision.');
    installGrant(grant);
    if (compiled.mode !== 'schedule' && !native.active) await api('/workflows/' + saved.providerId + '/publish', 'POST', {});
    return { ...compiled, grant };
  }
  async function setPublished(ref, active) {
    const saved = repository.nativeRevision(ref); if (!saved?.grant) throw error('Save this graph first.');
    const native = await api('/workflows/' + saved.providerId);
    const grant = saved.grant;
    if (n8nWorkflowSha256(native.activeVersion ? { ...native.activeVersion, settings: native.settings } : native) !== grant.workflowSha256) throw error('The native graph revision changed.');
    if (!!native.active !== active) await api('/workflows/' + saved.providerId + (active ? '/publish' : '/unpublish'), 'POST', {});
  }
  // Fetch and verify remotely; the repository commits this snapshot with save completion.
  async function savedNativeSnapshot(compiled) {
    if (compiled.kind !== 'native-n8n' || ['schedule', 'webhook'].includes(compiled.mode)) return;
    const native = await api('/workflows/' + compiled.grant.workflowId);
    const published = native.activeVersion ? { ...native.activeVersion, settings: native.settings } : native;
    if (!native.active || n8nWorkflowSha256(published) !== compiled.grant.workflowSha256) throw error('Saved native revision is unavailable.');
    return published;
  }
  const timerEvents = options => nativeTimerEvents(api, { ...options, graphId, owner });
  const executionInput = options => readNativeExecutionInput(api, options);
  return { api, savedNativeSnapshot, provision, setPublished, installGrant, timerEvents, executionInput };
}
