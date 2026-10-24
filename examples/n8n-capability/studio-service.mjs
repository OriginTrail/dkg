import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { component, normalizeComponentInput } from './component-registry.mjs';
import { normalizeStudio, readStudio, studioProgramSource, validateStudioCapabilities } from './studio-definition.mjs';
import { workflowUuid } from './workflow-definition.mjs';
import { n8nObservationScope, n8nExecutionMatches } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';

const reference = (source, graphId) => ({ graphId, programIri: source.programIri, programLayer: 'wm', authorAgentAddress: source.authorAgentAddress, sourceHash: source.sourceHash });
const reject = message => Object.assign(new Error(message), { code: 'INVALID_WORKFLOW', status: 400 });
const eventUuid = (ref, id) => { const b = createHash('sha256').update(ref + ':' + id).digest(); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = b.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; };

export function createStudioService({ graphId, owner, client, provider, listCapabilities, loadOutputs, exportTokenFile }) {
  const saving = new Map(); let polling = false, stopped = false;
  async function approved(kaRef, sourceHash) {
    try { const a = await client.programs.getApproval({ graphId, operationIri: kaRef }); return a.binding.enabled && a.binding.program.sourceHash === sourceHash; }
    catch (e) { if (e.status === 404) return false; throw e; }
  }
  const activation = ref => { const row = provider.row(ref); return row?.activation_json ? JSON.parse(row.activation_json) : { active: false }; };
  async function get(kaRef, sourceHash) {
    if (typeof kaRef !== 'string' || !provider.row(kaRef)?.grant_json) throw reject('Unknown saved graph.');
    const source = await client.programs.getSource({ graphId, programIri: kaRef, programLayer: 'wm' });
    const compiled = readStudio(source.source);
    if (compiled.kaRef !== kaRef || sourceHash && sourceHash !== source.sourceHash) throw reject('The saved graph revision changed.');
    return { compiled, source, workflow: { definition: compiled.definition, kaRef, sourceHash: source.sourceHash, graphId,
      mode: compiled.mode, approved: await approved(kaRef, source.sourceHash), requiresExportAuthorization: compiled.requiresExportAuthorization,
      activation: (({ active, count, expiresAt }) => ({ active, count, expiresAt }))(activation(kaRef)), readbackVerified: true } };
  }
  async function list() {
    const workflows = [];
    for (const row of provider.db.prepare('SELECT ka_ref FROM workflows WHERE grant_json IS NOT NULL ORDER BY created_at DESC LIMIT 24').all()) {
      try { workflows.push((await get(row.ka_ref)).workflow); } catch (e) { if (!['PROGRAM_NOT_FOUND', 'INVALID_WORKFLOW'].includes(e.code)) throw e; }
    }
    return workflows;
  }
  async function save(value, authorize) {
    const definition = normalizeStudio(value); validateStudioCapabilities(definition, await listCapabilities());
    if (definition.nodes.some(n => component(n.componentId).writes)) authorize();
    const key = JSON.stringify(definition); if (saving.has(key)) return saving.get(key);
    const pending = (async () => {
      const compiled = await provider.provision(definition), sourceText = studioProgramSource(compiled);
      const sourceHash = createHash('sha256').update(sourceText).digest('hex');
      let source;
      try { source = await client.programs.getSource({ graphId, programIri: compiled.kaRef, programLayer: 'wm' }); }
      catch (e) { if (e.code !== 'PROGRAM_NOT_FOUND') throw e; }
      if (!source) {
        await client.programs.upload({ graphId, programIri: compiled.kaRef, name: 'studio-' + sourceHash.slice(0, 24), label: definition.name,
          language: 'typescript-v1', version: '1.0.0', source: sourceText, requiredTools: ['urn:dkg:tool:n8n'],
          permittedPrograms: [...new Set(definition.nodes.map(n => n.kaRef))], requestedPermissions: { graphId, n8n: compiled.grant } });
        source = await client.programs.getSource({ graphId, programIri: compiled.kaRef, programLayer: 'wm' });
      }
      if (source.sourceHash !== sourceHash || source.source !== sourceText) throw reject('The graph source differs from its saved revision.');
      validateStudioCapabilities(definition, await listCapabilities());
      if (compiled.requiresExportAuthorization) authorize();
      if (!await approved(compiled.kaRef, sourceHash)) await client.programs.approve({ graphId, operationIri: compiled.kaRef,
        program: reference(source, graphId), allowedCallers: [owner], n8n: compiled.grant,
        typescript: { children: [...new Set(definition.nodes.map(n => n.kaRef))].map(operationIri => ({ graphId, operationIri })), maxCalls: 16, maxConcurrency: 1, timeoutMs: 60000 } });
      return (await get(compiled.kaRef, sourceHash)).workflow;
    })();
    saving.set(key, pending); try { return await pending; } finally { saving.delete(key); }
  }
  async function run(value, authorize) {
    if (!value || Object.keys(value).some(k => !['kaRef', 'sourceHash', 'itemsJson', 'invocationId'].includes(k))) throw reject('Invalid graph invocation.');
    const invocationId = workflowUuid(value.invocationId), { compiled, workflow } = await get(value.kaRef, value.sourceHash);
    if (!workflow.approved) throw reject('This graph is not approved.');
    if (compiled.mode === 'schedule' && !activation(workflow.kaRef).active) throw reject('Activate this Schedule workflow before running it.');
    validateStudioCapabilities(compiled.definition, await listCapabilities());
    if (workflow.requiresExportAuthorization) authorize();
    const root = compiled.definition.nodes.find(n => n.id === compiled.definition.entryId);
    const descriptor = { ...component(root.componentId), ...(compiled.mode === 'schedule' ? { mode: 'action' } : {}) };
    let input; try { input = normalizeComponentInput(descriptor, { itemsJson: value.itemsJson, paramsJson: JSON.stringify(root.params), executionId: '' }); }
    catch (e) { throw reject(e.message); }
    const result = await client.programs.invoke({ graphId, operationIri: workflow.kaRef, invocationId, inputs: [input] });
    if (!isDeepStrictEqual(await loadOutputs(result.executionIri), result.rawOutputs)) throw new Error('The DKG receipt readback differs.');
    const output = result.outputs[0];
    if (output?.kind !== 'n8n-result' || output.workflowSha256 !== compiled.grant.workflowSha256 || !output.output || typeof output.output.traceJson !== 'string') throw new Error('Native graph evidence is incomplete.');
    const trace = JSON.parse(output.output.traceJson);
    return { kaRef: workflow.kaRef, sourceHash: workflow.sourceHash, invocationId, executionIri: result.executionIri,
      n8nExecutionId: output.n8nExecutionId, workflowSha256: output.workflowSha256, output: output.output,
      steps: compiled.definition.nodes.map((n, i) => ({ nodeId: n.id, componentId: n.componentId, kaRef: n.kaRef, ...trace[i] })),
      persisted: true, readbackVerified: true };
  }
  function eventAuthorized(ref, compiled, reserved = false) {
    const active = activation(ref);
    if (!active.active || active.expiresAt < Date.now() || !reserved && active.count >= 5) throw reject('This event workflow is inactive or its PoC event limit was reached.');
    if (compiled.requiresExportAuthorization && (!exportTokenFile || active.exportFingerprint !== provider.fingerprint(exportTokenFile))) throw reject('The operator export authorization changed.');
  }
  async function activate(value, authorize) {
    if (!value || Object.keys(value).some(k => !['kaRef', 'sourceHash', 'active', 'activationId'].includes(k)) || typeof value.active !== 'boolean') throw reject('Choose an activation state.');
    const activationId = workflowUuid(value.activationId);
    const { compiled, workflow } = await get(value.kaRef, value.sourceHash);
    if (!['schedule', 'webhook'].includes(compiled.mode)) throw reject('Start with a Webhook or Schedule Trigger to activate events.');
    if (activation(value.kaRef).activationId === activationId) {
      const current = activation(value.kaRef);
      if (value.active && current.active && current.expiresAt > Date.now() && compiled.mode === 'schedule') await provider.setPublished(workflow.kaRef, true);
      return (await get(value.kaRef)).workflow;
    }
    if (value.active) {
      if (!workflow.approved) throw reject('This graph is not approved.');
      validateStudioCapabilities(compiled.definition, await listCapabilities());
      if (workflow.requiresExportAuthorization) authorize();
      const a = { active: true, activationId, startedAt: Date.now(), expiresAt: Date.now() + 30 * 60 * 1000, count: 0,
        ...(workflow.requiresExportAuthorization ? { exportFingerprint: provider.fingerprint(exportTokenFile) } : {}) };
      provider.db.prepare('UPDATE workflows SET activation_json=?,event_key=? WHERE ka_ref=?').run(JSON.stringify(a), randomUUID(), workflow.kaRef);
      if (compiled.mode === 'schedule') await provider.setPublished(workflow.kaRef, true);
    } else {
      if (compiled.mode === 'schedule') await provider.setPublished(workflow.kaRef, false);
      provider.db.prepare('UPDATE workflows SET activation_json=?,event_key=NULL WHERE ka_ref=?').run(JSON.stringify({ active: false, activationId }), workflow.kaRef);
    }
    return (await get(workflow.kaRef)).workflow;
  }
  async function event(key, value) {
    if (!value || Object.keys(value).some(k => !['invocationId', 'items'].includes(k))) throw reject('Supply an event identity and items.');
    const row = provider.db.prepare('SELECT * FROM workflows WHERE event_key=?').get(key);
    if (!row) throw reject('Inactive event endpoint.');
    const { compiled, workflow } = await get(row.ka_ref);
    if (compiled.mode !== 'webhook') throw reject('This endpoint is not a webhook.');
    const invocationId = workflowUuid(value.invocationId), itemsJson = JSON.stringify(value.items);
    const previous = provider.db.prepare('SELECT * FROM events WHERE provider_id=? AND execution_id=?').get(row.provider_id, invocationId);
    if (previous && previous.input_json !== itemsJson) throw reject('This event identity already belongs to different input.');
    eventAuthorized(row.ka_ref, compiled, !!previous);
    if (previous?.receipt_json) return JSON.parse(previous.receipt_json);
    if (!previous) {
      const a = activation(row.ka_ref); a.count++;
      provider.db.prepare('INSERT INTO events (provider_id,execution_id,ka_ref,invocation_id,input_json) VALUES (?,?,?,?,?)').run(row.provider_id, invocationId, row.ka_ref, invocationId, itemsJson);
      provider.db.prepare('UPDATE workflows SET activation_json=? WHERE ka_ref=?').run(JSON.stringify(a), row.ka_ref);
    }
    const receipt = await run({ kaRef: row.ka_ref, sourceHash: workflow.sourceHash, itemsJson, invocationId }, () => eventAuthorized(row.ka_ref, compiled, true));
    provider.db.prepare('UPDATE events SET receipt_json=? WHERE provider_id=? AND execution_id=?').run(JSON.stringify(receipt), row.provider_id, invocationId);
    return receipt;
  }
  async function history(ref) {
    await get(ref);
    const row = provider.row(ref), a = activation(ref);
    return { activation: { active: !!a.active && a.expiresAt > Date.now() && a.count < 5, count: a.count ?? 0, expiresAt: a.expiresAt },
      ...(row.event_key && a.active ? { eventPath: '/spike/ka/events/' + row.event_key } : {}),
      executions: provider.db.prepare('SELECT invocation_id,execution_id,receipt_json FROM events WHERE ka_ref=? ORDER BY rowid DESC LIMIT 20').all(ref)
        .map(r => ({ invocationId: r.invocation_id, triggerExecutionId: r.execution_id, receipt: r.receipt_json ? JSON.parse(r.receipt_json) : null })) };
  }
  async function poll() {
    if (polling || stopped) return; polling = true;
    try {
      for (const row of provider.db.prepare('SELECT * FROM workflows WHERE activation_json IS NOT NULL').all()) {
        const a = activation(row.ka_ref); if (!a.active) continue;
        let compiled, workflow;
        try {
          ({ compiled, workflow } = await get(row.ka_ref)); eventAuthorized(row.ka_ref, compiled);
          validateStudioCapabilities(compiled.definition, await listCapabilities());
          if (!workflow.approved) throw reject('Event workflow approval changed.');
        } catch {
          try { await activate({ kaRef: row.ka_ref, active: false, activationId: randomUUID() }, () => {}); } catch {}
          continue;
        }
        if (compiled.mode !== 'schedule') continue;
        const native = await provider.api('/workflows/' + row.provider_id);
        const published = { ...native.activeVersion, settings: native.settings };
        const executions = await provider.api('/executions?limit=20&workflowId=' + encodeURIComponent(row.provider_id));
        for (const e of executions.data.slice().reverse()) {
          if (e.status !== 'success' || Date.parse(e.startedAt) < a.startedAt || !/^\d{1,20}$/.test(String(e.id))) continue;
          const detail = await provider.api('/executions/' + e.id + '?includeData=true');
          const scope = n8nObservationScope(graphId, owner, row.provider_id) + ' trigger';
          const runs = detail.data?.resultData?.runData?.[scope];
          if (!Array.isArray(runs) || !runs.length || !n8nExecutionMatches(published, detail.workflowData)) continue;
          const old = provider.db.prepare('SELECT * FROM events WHERE provider_id=? AND execution_id=?').get(row.provider_id, String(e.id));
          if (old?.receipt_json) continue;
          const invocationId = old?.invocation_id ?? eventUuid(row.ka_ref, String(e.id));
          if (!old) {
            eventAuthorized(row.ka_ref, compiled);
            const current = activation(row.ka_ref); current.count++;
            provider.db.prepare('INSERT INTO events (provider_id,execution_id,ka_ref,invocation_id) VALUES (?,?,?,?)').run(row.provider_id, String(e.id), row.ka_ref, invocationId);
            provider.db.prepare('UPDATE workflows SET activation_json=? WHERE ka_ref=?').run(JSON.stringify(current), row.ka_ref);
          }
          const items = runs.at(-1).data.main[0].map(item => item.json);
          try {
            const receipt = await run({ kaRef: row.ka_ref, sourceHash: workflow.sourceHash, itemsJson: JSON.stringify(items), invocationId }, () => {
              const active = activation(row.ka_ref); if (!active.active || active.expiresAt < Date.now()
                || compiled.requiresExportAuthorization && active.exportFingerprint !== provider.fingerprint(exportTokenFile)) throw reject('Event authorization expired.');
            });
            provider.db.prepare('UPDATE events SET receipt_json=? WHERE provider_id=? AND execution_id=?').run(JSON.stringify(receipt), row.provider_id, String(e.id));
          } catch { /* Retain this exact invocation for the next reconciliation poll. */ }
        }
      }
    } catch { /* A bounded retry resumes the same journalled event identities. */ }
    finally { polling = false; }
  }
  const timer = setInterval(() => void poll(), 3000); timer.unref();
  return { list, get, save, run, activate, event, history, poll, stop() { stopped = true; clearInterval(timer); } };
}
