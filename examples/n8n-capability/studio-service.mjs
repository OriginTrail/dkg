import { assertDkgEnabled, isDkg } from './dkg-components.mjs';
import { componentFailure } from './dkg-component-operations.mjs';
import { studioExecutionPlan, prepareStudioExecution } from './studio-execution-plan.mjs';
import { createHash } from 'node:crypto';
import { createStudioEventController, eventHistorySnapshot } from './studio-events.mjs';
import { isDeepStrictEqual } from 'node:util';
import { invocationInput, workflowInvocationInput } from './studio-inputs.mjs';
import { component as componentV1, normalizeComponentInput as normalizeComponentInputV1 } from './component-registry-v1.mjs';
import { createStudioCompiler } from './studio-definition.mjs';
import { workflowUuid } from './workflow-definition.mjs';
import { programWorkflowReceipt } from './program-workflow-receipt.mjs';
import { mapWithConcurrency } from '../../packages/agent/dist/map-with-concurrency.js';

const reference = (source, graphId) => ({ graphId, programIri: source.programIri, programLayer: 'wm', authorAgentAddress: source.authorAgentAddress, sourceHash: source.sourceHash });
const reject = message => Object.assign(new Error(message), { code: 'INVALID_WORKFLOW', status: 400 });

export function createStudioService({ graphId, owner, client, repository, provider, dkg, programAuthority, listCapabilities, loadOutputs, exportTokenFile, compiler = createStudioCompiler(), eventsEnabled = true }) {
  const { normalizeStudio, readStudio, validateStudioCapabilities } = compiler;
  const { component, profile } = compiler.registry;
  const native = () => { if (!provider) throw reject('Native execution is not configured.'); return provider; };
  const components = () => { if (!dkg) throw reject('DKG component execution is not configured.'); return dkg; };
  const saving = new Map();
  async function approved(kaRef, sourceHash) {
    try { const a = await client.programs.getApproval({ graphId, operationIri: kaRef }); return a.binding.enabled && a.binding.program.sourceHash === sourceHash; }
    catch (e) { if (e.status === 404) return false; throw e; }
  }
  async function get(kaRef, sourceHash) {
    if (typeof kaRef !== 'string' || !repository.workflow(kaRef)?.completed) throw reject('Unknown saved graph.');
    const source = await client.programs.getSource({ graphId, programIri: kaRef, programLayer: 'wm' });
    const compiled = readStudio(source.source);
    if (compiled.kaRef !== kaRef || sourceHash && sourceHash !== source.sourceHash) throw reject('The saved graph revision changed.');
    const plan = studioExecutionPlan(compiled, graphId, compiler);
    const isApproved = await approved(kaRef, source.sourceHash);
    // Read the normalized state after remote inspection, so concurrent saves or
    // revocation cannot leave this response with stale export/activation policy.
    const saved = repository.workflow(kaRef);
    if (!saved?.completed) throw reject('Unknown saved graph.');
    if (saved.executor !== compiled.kind) throw reject('The saved workflow executor changed.');
    return { compiled, plan, source, workflow: { definition: compiled.definition, kaRef, sourceHash: source.sourceHash, graphId,
      ...(compiled.kind === 'native-n8n' ? { workflowSha256: compiled.grant.workflowSha256 } : {}),
      mode: compiled.mode, approved: isApproved,
      requiresExportAuthorization: compiled.requiresExportAuthorization || saved.requiresExportAuthorization,
      activation: (({ active, count, expiresAt }) => ({ active, count, expiresAt }))(saved.activation), readbackVerified: true } };
  }
  async function list() {
    const workflows = await mapWithConcurrency(repository.list(), 4, async kaRef => {
      // Unavailable revisions remain saved with their original pins; other workflows can still be listed.
      try { return (await get(kaRef)).workflow; }
      catch (e) {
        if (!['PROGRAM_NOT_FOUND', 'INVALID_WORKFLOW', 'WORKFLOW_CAPABILITY_CHANGED'].includes(e.code)) throw e;
        return null;
      }
    });
    return workflows.filter(workflow => workflow !== null);
  }
  async function save(value, authorize) {
    const definition = normalizeStudio(value);
    assertDkgEnabled(definition, profile);
    const policy = validateStudioCapabilities(definition, (await listCapabilities()).filter(c => !c.retired));
    if (policy.requiresExportAuthorization) authorize();
    const key = JSON.stringify(definition); if (saving.has(key)) return saving.get(key);
    const pending = (async () => {
      const { compiled, plan } = await prepareStudioExecution(definition, graphId, definition => native().provision(definition), compiler);
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
      const currentPolicy = validateStudioCapabilities(definition, (await listCapabilities()).filter(c => !c.retired));
      const requiresExportAuthorization = compiled.requiresExportAuthorization || repository.workflow(compiled.kaRef).requiresExportAuthorization
        || currentPolicy.requiresExportAuthorization;
      if (requiresExportAuthorization) authorize();
      if (!await approved(compiled.kaRef, sourceHash)) await client.programs.approve({ graphId, operationIri: compiled.kaRef,
        program: reference(source, graphId), allowedCallers: [owner], ...plan.approval });
      const published = compiled.kind === 'native-n8n' ? await native().savedNativeSnapshot(compiled) : undefined;
      repository.completeSave(compiled, compiled.kind, requiresExportAuthorization, published, sourceHash);
      return (await get(compiled.kaRef, sourceHash)).workflow;
    })();
    saving.set(key, pending); try { return await pending; } finally { saving.delete(key); }
  }
  function run(value, authorize, actor) {
    return execute(value, { authorizeExport: authorize, actor, prepareExecution: events?.prepareExecution });
  }
  async function execute(value, { authorizeExport, beforeDispatch, actor, prepareExecution }) {
    if (!value || Object.keys(value).some(k => !['kaRef', 'sourceHash', 'itemsJson', 'invocationId', 'arguments'].includes(k))) throw reject('Invalid graph invocation.');
    const invocationId = workflowUuid(value.invocationId), { compiled, workflow } = await get(value.kaRef, value.sourceHash);
    if (!workflow.approved) throw reject('This graph is not approved.');
    const root = compiled.definition.nodes.find(n => n.id === compiled.definition.entryId);
    const descriptor = (compiled.legacy ? componentV1 : component)(root.componentId);
    const preparation = prepareExecution?.({ compiled, workflow, descriptor }) ?? { descriptor };
    const policy = validateStudioCapabilities(compiled.definition, await listCapabilities());
    const requiresExportAuthorization = workflow.requiresExportAuthorization || policy.requiresExportAuthorization;
    if (requiresExportAuthorization) authorizeExport();
    let input;
    try {
      const raw = { itemsJson: value.itemsJson, paramsJson: JSON.stringify(root.params), executionId: '' };
      input = compiled.legacy
        ? invocationInput(compiled.definition, value.arguments, normalizeComponentInputV1(preparation.descriptor, raw), compiler.registry)
        : workflowInvocationInput(compiled, value.arguments, raw, preparation.descriptor, compiler.registry);
    } catch (e) { throw reject(e.message); }
    const authorizeDispatch = () => {
      beforeDispatch?.(requiresExportAuthorization);
      preparation.beforeDispatch?.(requiresExportAuthorization);
    };
    authorizeDispatch();
    assertDkgEnabled(compiled.definition, profile);
    if (compiled.kind === 'native-n8n') native().installGrant(compiled.grant);
    if (compiled.definition.nodes.some(n => isDkg(n.componentId))) {
      if (!programAuthority) throw componentFailure('Original Program invocation authority verifier required.');
      const authority = programAuthority.capture(workflow, invocationId, input);
      components().grant(workflow, { invocationId, revisionDigest: workflow.sourceHash, authority }, input, actor);
    }
    const invoke = () => {
      authorizeDispatch();
      return client.programs.invoke({ graphId, operationIri: workflow.kaRef, invocationId, inputs: [input] });
    };
    let result;
    try { result = await invoke(); }
    catch (error) {
      if (error.code !== 'INVOCATION_REQUIRES_RECONCILIATION' || compiled.kind === 'dkg-program') throw error;
      // The native-only wrapper resumes its durable acknowledgement; it never
      // creates another n8n run or another remote Program invocation.
      result = await invoke();
    }
    if (!isDeepStrictEqual(await loadOutputs(result.executionIri), result.rawOutputs)) throw new Error('The DKG receipt readback differs.');
    if (compiled.kind === 'dkg-program') return { kaRef: workflow.kaRef, sourceHash: workflow.sourceHash, invocationId, executionIri: result.executionIri,
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
    if (compiled.definition.nodes.some(n => isDkg(n.componentId)) && profile.requiresNosActor) {
      // Completed Program replay bypasses native callbacks. Its retained output
      // still requires current node access, independently of Program approval.
      if (!actor || actor.accountId !== profile.accountId || actor.role !== 'owner') throw componentFailure('Authenticated nOS owner required.');
      await profile.authorize(actor);
      const current = await get(workflow.kaRef, workflow.sourceHash);
      if (!current.workflow.approved) throw reject('Workflow approval is unavailable.');
      const policy = validateStudioCapabilities(current.compiled.definition, await listCapabilities());
      assertDkgEnabled(current.compiled.definition, profile);
      if (actor.accountId !== profile.accountId) throw componentFailure('Authenticated nOS owner required.');
      if (current.workflow.requiresExportAuthorization || policy.requiresExportAuthorization) authorizeExport();
    }
    return { kaRef: workflow.kaRef, sourceHash: workflow.sourceHash, invocationId, executionIri: result.executionIri,
      n8nExecutionId: output.n8nExecutionId, workflowSha256: output.workflowSha256, output: output.output,
      steps: compiled.definition.nodes.map((n, i) => ({ nodeId: n.id, componentId: n.componentId, kaRef: n.kaRef, ...trace[i] })),
      ...(dkgRecovery ? { dkgRecovery } : {}), persisted: true, readbackVerified: true };
  }
  async function dkgComponent(value) {
    const invocationId = /^urn:sr:effect:([a-f0-9-]{36}):[^\s]{1,100}$/.exec(value?.effectId ?? '')?.[1];
    if (!invocationId) throw componentFailure('Native execution identity required.');
    const kaRef=repository.nativeWorkflow(value?.workflowId ?? '');
    if(!kaRef) throw reject('Unknown native workflow.');
    const {compiled,workflow}=await get(kaRef);
    if(!workflow.approved) throw reject('Workflow approval is unavailable.');
    validateStudioCapabilities(compiled.definition,await listCapabilities());
    const input = await native().executionInput({ workflowId: value.workflowId, executionId: value.executionId, grant: compiled.grant });
    if (!programAuthority) throw componentFailure('Original Program invocation authority verifier required.');
    return components().call(value, workflow, { invocationId, revisionDigest: workflow.sourceHash,
      authorize: (authority, options) => programAuthority.assert(authority, value.effectId, options) }, value.workflowId, input);
  }
  const events = provider && eventsEnabled ? createStudioEventController({
    repository, provider, lookup: get, execute, listCapabilities, validateStudioCapabilities, exportTokenFile,
  }) : null;
  const requireEvents = () => { if (!events) throw reject('Delegated events are unavailable.'); return events; };
  return { dkgComponent, list, get, save, run,
    activate: async (...args) => requireEvents().activate(...args),
    event: async (...args) => requireEvents().event(...args),
    async history(ref, mayDiscloseEvent) {
      if (events) return events.history(ref, mayDiscloseEvent);
      await get(ref); return eventHistorySnapshot(repository, ref, false);
    },
    poll: async () => events?.poll(), stop() { events?.stop(); },
  };
}
