import { assertDkgEnabled, isDkg } from './dkg-components.mjs';
import { studioExecutionPlan, prepareStudioExecution } from './studio-execution-plan.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { component, componentNeedsExport, normalizeComponentInput } from './component-registry.mjs';
import { component as componentV1, normalizeComponentInput as normalizeComponentInputV1 } from './component-registry-v1.mjs';
import { normalizeStudio, readStudio, validateStudioCapabilities } from './studio-definition.mjs';
import { workflowUuid } from './workflow-definition.mjs';
import { programWorkflowReceipt } from './program-workflow-receipt.mjs';

const reference = (source, graphId) => ({ graphId, programIri: source.programIri, programLayer: 'wm', authorAgentAddress: source.authorAgentAddress, sourceHash: source.sourceHash });
const reject = message => Object.assign(new Error(message), { code: 'INVALID_WORKFLOW', status: 400 });
const eventUuid = (ref, id) => { const b = createHash('sha256').update(ref + ':' + id).digest(); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = b.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; };

export function createStudioService({ graphId, owner, client, repository, provider, dkg, listCapabilities, loadOutputs, exportTokenFile }) {
  const native = () => { if (!provider) throw reject('Native execution is not configured.'); return provider; };
  const fingerprint = path => createHash('sha256').update(readFileSync(path, 'utf8').trim()).digest('hex');
  const components = () => { if (!dkg) throw reject('DKG component execution is not configured.'); return dkg; };
  const saving = new Map(); let polling = false, stopped = false;
  async function approved(kaRef, sourceHash) {
    try { const a = await client.programs.getApproval({ graphId, operationIri: kaRef }); return a.binding.enabled && a.binding.program.sourceHash === sourceHash; }
    catch (e) { if (e.status === 404) return false; throw e; }
  }
  const activation = repository.activation;
  async function get(kaRef, sourceHash) {
    if (typeof kaRef !== 'string' || !repository.row(kaRef)?.executor) throw reject('Unknown saved graph.');
    const source = await client.programs.getSource({ graphId, programIri: kaRef, programLayer: 'wm' });
    const compiled = readStudio(source.source);
    if (compiled.kaRef !== kaRef || sourceHash && sourceHash !== source.sourceHash) throw reject('The saved graph revision changed.');
    const plan = studioExecutionPlan(compiled, graphId);
    if (repository.row(kaRef).executor !== plan.kind) throw reject('The saved workflow executor changed.');
    return { compiled, plan, source, workflow: { definition: compiled.definition, kaRef, sourceHash: source.sourceHash, graphId,
      mode: compiled.mode, approved: await approved(kaRef, source.sourceHash),
      requiresExportAuthorization: compiled.requiresExportAuthorization || !!repository.row(kaRef).requires_export,
      activation: (({ active, count, expiresAt }) => ({ active, count, expiresAt }))(activation(kaRef)), readbackVerified: true } };
  }
  async function list() {
    const workflows = [];
    for (const row of repository.list()) {
      try { workflows.push((await get(row.ka_ref)).workflow); } catch (e) { if (!['PROGRAM_NOT_FOUND', 'INVALID_WORKFLOW'].includes(e.code)) throw e; }
    }
    return workflows;
  }
  async function save(value, authorize) {
    const definition = normalizeStudio(value);
    assertDkgEnabled(definition);
    let capabilities = (await listCapabilities()).filter(c => !c.retired);
    validateStudioCapabilities(definition, capabilities);
    const needsExport = () => definition.nodes.some(n => componentNeedsExport(component(n.componentId))
      || capabilities.some(c => c.kaRef === n.kaRef && c.sourceHash === n.sourceHash && c.requiresExportAuthorization));
    if (needsExport()) authorize();
    const key = JSON.stringify(definition); if (saving.has(key)) return saving.get(key);
    const pending = (async () => {
      const { compiled, plan } = await prepareStudioExecution(definition, graphId, definition => native().provision(definition));
      repository.ensure(compiled);
      const sourceText = plan.upload.source;
      const sourceHash = createHash('sha256').update(sourceText).digest('hex');
      let source;
      try { source = await client.programs.getSource({ graphId, programIri: compiled.kaRef, programLayer: 'wm' }); }
      catch (e) { if (e.code !== 'PROGRAM_NOT_FOUND') throw e; }
      if (!source) {
        await client.programs.upload({ graphId, programIri: compiled.kaRef, name: 'studio-' + sourceHash.slice(0, 24), label: definition.name,
          language: 'typescript-v1', version: '1.0.0', ...plan.upload });
        source = await client.programs.getSource({ graphId, programIri: compiled.kaRef, programLayer: 'wm' });
      }
      if (source.sourceHash !== sourceHash || source.source !== sourceText) throw reject('The graph source differs from its saved revision.');
      capabilities = (await listCapabilities()).filter(c => !c.retired);
      validateStudioCapabilities(definition, capabilities);
      if (compiled.requiresExportAuthorization || needsExport()) authorize();
      if (!await approved(compiled.kaRef, sourceHash)) await client.programs.approve({ graphId, operationIri: compiled.kaRef,
        program: reference(source, graphId), allowedCallers: [owner], ...plan.approval });
      repository.saved(compiled.kaRef, plan.kind, compiled.requiresExportAuthorization || needsExport());
      return (await get(compiled.kaRef, sourceHash)).workflow;
    })();
    saving.set(key, pending); try { return await pending; } finally { saving.delete(key); }
  }
  async function run(value, authorize, actor) {
    if (!value || Object.keys(value).some(k => !['kaRef', 'sourceHash', 'itemsJson', 'invocationId'].includes(k))) throw reject('Invalid graph invocation.');
    const invocationId = workflowUuid(value.invocationId), { compiled, plan, workflow } = await get(value.kaRef, value.sourceHash);
    if (!workflow.approved) throw reject('This graph is not approved.');
    if (compiled.mode === 'schedule' && !activation(workflow.kaRef).active) throw reject('Activate this Schedule workflow before running it.');
    const capabilities = await listCapabilities();
    validateStudioCapabilities(compiled.definition, capabilities);
    if (workflow.requiresExportAuthorization || compiled.definition.nodes.some(n => capabilities.some(c => c.kaRef === n.kaRef && c.sourceHash === n.sourceHash && c.requiresExportAuthorization))) authorize();
    const root = compiled.definition.nodes.find(n => n.id === compiled.definition.entryId);
    const descriptor = { ...(compiled.legacy ? componentV1 : component)(root.componentId), ...(compiled.mode === 'schedule' ? { mode: 'action' } : {}) };
    let input; try { input = (compiled.legacy ? normalizeComponentInputV1 : normalizeComponentInput)(descriptor, { itemsJson: value.itemsJson, paramsJson: JSON.stringify(root.params), executionId: '' }); }
    catch (e) { throw reject(e.message); }
    assertDkgEnabled(compiled.definition);
    if (plan.kind === 'native-n8n') native().installGrant(compiled.grant);
    if (compiled.definition.nodes.some(n => isDkg(n.componentId))) components().grant(workflow, invocationId, input, actor);
    const invoke = () => client.programs.invoke({ graphId, operationIri: workflow.kaRef, invocationId, inputs: [input] });
    let result;
    try { result = await invoke(); }
    catch (error) {
      if (error.code !== 'INVOCATION_REQUIRES_RECONCILIATION' || plan.kind === 'dkg-program') throw error;
      // The native-only wrapper resumes its durable acknowledgement; it never
      // creates another n8n run or another remote Program invocation.
      result = await invoke();
    }
    if (!isDeepStrictEqual(await loadOutputs(result.executionIri), result.rawOutputs)) throw new Error('The DKG receipt readback differs.');
    if (plan.kind === 'dkg-program') return { kaRef: workflow.kaRef, sourceHash: workflow.sourceHash, invocationId, executionIri: result.executionIri,
      ...await programWorkflowReceipt(compiled, result, input, loadOutputs) };
    const output = result.outputs[0];
    if (output?.kind !== 'n8n-result' || output.workflowSha256 !== compiled.grant.workflowSha256 || !output.output || typeof output.output.traceJson !== 'string') throw new Error('Native graph evidence is incomplete.');
    const write = dkg?.writeRecovery(workflow, invocationId, compiled.grant.workflowId, output.n8nExecutionId);
    let dkgRecovery;
    if (write && (write.pending || output.output.ok === false)) {
      // The native receipt may already be terminal. Reconcile only the journalled
      // write through the same current authority/pin checks as its callback.
      // call() sees the original journal entry and can only use allowCreate:false.
      const receipt = await dkgComponent(write.request);
      const current = await get(workflow.kaRef, workflow.sourceHash);
      if (!current.workflow.approved) throw reject('Workflow approval is unavailable.');
      validateStudioCapabilities(current.compiled.definition, await listCapabilities());
      dkgRecovery = { status: 'confirmed', invocationId, n8nExecutionId: output.n8nExecutionId,
        blockId: write.request.blockId, requestHash: write.requestHash, receipt };
    }
    const trace = JSON.parse(output.output.traceJson);
    return { kaRef: workflow.kaRef, sourceHash: workflow.sourceHash, invocationId, executionIri: result.executionIri,
      n8nExecutionId: output.n8nExecutionId, workflowSha256: output.workflowSha256, output: output.output,
      steps: compiled.definition.nodes.map((n, i) => ({ nodeId: n.id, componentId: n.componentId, kaRef: n.kaRef, ...trace[i] })),
      ...(dkgRecovery ? { dkgRecovery } : {}), persisted: true, readbackVerified: true };
  }
  function eventAuthorized(ref, compiled) {
    const active = activation(ref);
    if (!active.active || active.expiresAt < Date.now()) throw reject('This event workflow is inactive.');
    if (compiled.requiresExportAuthorization && (!exportTokenFile || active.exportFingerprint !== fingerprint(exportTokenFile))) throw reject('The operator export authorization changed.');
  }
  async function activate(value, authorize) {
    if (!value || Object.keys(value).some(k => !['kaRef', 'sourceHash', 'active', 'activationId'].includes(k)) || typeof value.active !== 'boolean') throw reject('Choose an activation state.');
    const activationId = workflowUuid(value.activationId);
    const { compiled, workflow } = await get(value.kaRef, value.sourceHash);
    if (!['schedule', 'webhook'].includes(compiled.mode)) throw reject('Start with a Webhook or Schedule Trigger to activate events.');
    if (activation(value.kaRef).activationId === activationId) {
      const current = activation(value.kaRef);
      if (value.active && current.active && current.expiresAt > Date.now() && compiled.mode === 'schedule') await native().setPublished(workflow.kaRef, true);
      return (await get(value.kaRef)).workflow;
    }
    if (value.active) {
      if (!workflow.approved) throw reject('This graph is not approved.');
      validateStudioCapabilities(compiled.definition, await listCapabilities());
      if (workflow.requiresExportAuthorization) authorize();
      const a = { active: true, activationId, startedAt: Date.now(), expiresAt: Date.now() + 30 * 60 * 1000, count: 0,
        ...(workflow.requiresExportAuthorization ? { exportFingerprint: fingerprint(exportTokenFile) } : {}) };
      repository.setActivation(workflow.kaRef, a, randomUUID());
      if (compiled.mode === 'schedule') await native().setPublished(workflow.kaRef, true);
    } else {
      if (compiled.mode === 'schedule') await native().setPublished(workflow.kaRef, false);
      repository.setActivation(workflow.kaRef, { active: false, activationId });
    }
    return (await get(workflow.kaRef)).workflow;
  }
  async function event(key, value) {
    if (!value || Object.keys(value).some(k => !['invocationId', 'items'].includes(k))) throw reject('Supply an event identity and items.');
    const row = repository.eventWorkflow(key);
    if (!row) throw reject('Inactive event endpoint.');
    const { compiled, workflow } = await get(row.ka_ref);
    if (compiled.mode !== 'webhook') throw reject('This endpoint is not a webhook.');
    if (!workflow.approved) throw reject('Event workflow approval changed.');
    validateStudioCapabilities(compiled.definition, await listCapabilities());
    const invocationId = workflowUuid(value.invocationId), itemsJson = JSON.stringify(value.items);
    const reserved = repository.reserveEvent({ kaRef: row.ka_ref, providerId: row.provider_id,
      executionId: invocationId, invocationId, inputJson: itemsJson }, () => eventAuthorized(row.ka_ref, compiled));
    if (reserved.receipt) return reserved.receipt;
    const receipt = await run({ kaRef: row.ka_ref, sourceHash: workflow.sourceHash, itemsJson, invocationId: reserved.invocationId }, () => eventAuthorized(row.ka_ref, compiled));
    return repository.completeEvent(reserved, receipt);
  }
  async function history(ref, mayDiscloseEvent) {
    const { compiled, workflow } = await get(ref);
    const row = repository.row(ref), a = activation(ref);
    let disclose = false;
    if (row.event_key && workflow.approved && a.active && a.expiresAt > Date.now() && mayDiscloseEvent) {
      const capabilities = await listCapabilities();
      const needsExport = workflow.requiresExportAuthorization || compiled.definition.nodes.some(n =>
        capabilities.some(c => c.kaRef === n.kaRef && c.sourceHash === n.sourceHash && c.requiresExportAuthorization));
      disclose = mayDiscloseEvent(needsExport) === true;
    }
    return { activation: { active: !!a.active && a.expiresAt > Date.now() && a.count < 5, count: a.count ?? 0, expiresAt: a.expiresAt },
      ...(disclose ? { eventPath: '/spike/ka/events/' + row.event_key } : {}),
      executions: repository.eventHistory(ref) };
  }
  async function poll() {
    if (polling || stopped) return; polling = true;
    try {
      for (const row of repository.activatedWorkflows()) {
        const a = activation(row.ka_ref); if (!a.active) continue;
        let compiled, workflow, capabilities;
        try {
          ({ compiled, workflow } = await get(row.ka_ref));
          capabilities = await listCapabilities();
        } catch { continue; } // Unavailable inspection is not evidence of revoked authority.
        try {
          eventAuthorized(row.ka_ref, compiled);
          validateStudioCapabilities(compiled.definition, capabilities);
          if (!workflow.approved) throw reject('Event workflow approval changed.');
        } catch (error) {
          if (['INVALID_WORKFLOW', 'WORKFLOW_CAPABILITY_CHANGED'].includes(error.code)) {
            try { await activate({ kaRef: row.ka_ref, active: false, activationId: randomUUID() }, () => {}); } catch {}
          }
          continue;
        }
        if (compiled.mode !== 'schedule') continue;
        const pendingExecutionIds = repository.pendingEvents(row.ka_ref).map(event => event.executionId);
        for await (const { executionId, items } of native().timerEvents({ grant: compiled.grant,
          startedAt: a.startedAt, pendingExecutionIds })) {
          try {
            const event = repository.reserveEvent({ kaRef: row.ka_ref, providerId: row.provider_id,
              executionId, invocationId: eventUuid(row.ka_ref, executionId) }, () => eventAuthorized(row.ka_ref, compiled));
            if (event.receipt) continue;
            const receipt = await run({ kaRef: row.ka_ref, sourceHash: workflow.sourceHash, itemsJson: JSON.stringify(items),
              invocationId: event.invocationId }, () => eventAuthorized(row.ka_ref, compiled));
            repository.completeEvent(event, receipt);
          } catch { /* Retain this exact invocation for the next reconciliation poll. */ }
        }
      }
    } catch { /* A bounded retry resumes the same journalled event identities. */ }
    finally { polling = false; }
  }
  async function dkgComponent(value) {
    const row=repository.nativeWorkflow(value?.workflowId ?? '');
    if(!row) throw reject('Unknown native workflow.');
    const {compiled,workflow}=await get(row.ka_ref);
    if(!workflow.approved) throw reject('Workflow approval is unavailable.');
    validateStudioCapabilities(compiled.definition,await listCapabilities());
    const input = await native().executionInput({ workflowId: value.workflowId, executionId: value.executionId, grant: compiled.grant });
    return components().call(value, workflow, value.workflowId, input);
  }
  const timer = setInterval(() => void poll(), 3000); timer.unref();
  return { dkgComponent, list, get, save, run, activate, event, history, poll, stop() { stopped = true; clearInterval(timer); } };
}
