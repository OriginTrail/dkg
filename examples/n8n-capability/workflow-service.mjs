import { isDeepStrictEqual } from 'node:util';
import { compileWorkflow, readWorkflow, validateWorkflowCapabilities, workflowRunInput, workflowUuid, workflowTableProblem, WORKFLOW_PREFIX } from './workflow-definition.mjs';

export function createWorkflowService({ graphId, owner, client, listCapabilities, listPrograms, persistProgram, loadOutputs }) {
  const saving = new Map();
  const reference = value => ({ graphId, programIri: value.programIri, programLayer: 'wm', authorAgentAddress: value.authorAgentAddress, sourceHash: value.sourceHash });
  async function record(compiled, source) {
    let approved = false;
    try { const approval = await client.programs.getApproval({ graphId, operationIri: compiled.kaRef }); approved = approval.binding.enabled && approval.binding.program.sourceHash === source.sourceHash; }
    catch (error) { if (error.status !== 404) throw error; }
    return { definition: compiled.definition, kaRef: compiled.kaRef, sourceHash: source.sourceHash,
      graphId, layer: 'wm', approved, requiresExportAuthorization: compiled.requiresExportAuthorization, readbackVerified: true };
  }
  async function get(kaRef, sourceHash) {
    if (typeof kaRef !== 'string' || !kaRef.startsWith(WORKFLOW_PREFIX) || kaRef.length > 200) throw Object.assign(new Error('Unknown saved workflow.'), { status: 404 });
    const source = await client.programs.getSource({ graphId, programIri: kaRef, programLayer: 'wm' });
    const compiled = readWorkflow(source.source);
    if (!compiled || compiled.kaRef !== kaRef || compiled.sourceHash !== source.sourceHash
      || (sourceHash && sourceHash !== source.sourceHash)) throw Object.assign(new Error('Saved workflow revision differs.'), { status: 409 });
    return { compiled, source, workflow: await record(compiled, source) };
  }
  async function list() {
    const programs = await listPrograms();
    if (programs.length > 128) throw Object.assign(new Error('The PoC workflow inventory is full.'), { status: 409 });
    const workflows = [];
    for (const iri of programs) { const stored = await get(iri); workflows.push(stored.workflow); }
    return workflows.sort((a, b) => b.definition.savedAt.localeCompare(a.definition.savedAt) || a.kaRef.localeCompare(b.kaRef));
  }
  async function save(value, authorizeExport) {
    const compiled = compileWorkflow(value);
    const authorized = async () => {
      validateWorkflowCapabilities(compiled.definition, await listCapabilities());
      if (compiled.requiresExportAuthorization) authorizeExport();
    };
    await authorized();
    if (saving.has(compiled.kaRef)) return saving.get(compiled.kaRef);
    const pending = (async () => {
      const inventory = await listPrograms();
      if (inventory.length >= 128 && !inventory.includes(compiled.kaRef)) throw Object.assign(new Error('The PoC workflow inventory is full.'), { status: 409 });
      await persistProgram(compiled, authorized);
      const source = await client.programs.getSource({ graphId, programIri: compiled.kaRef, programLayer: 'wm' });
      if (source.sourceHash !== compiled.sourceHash) throw new Error('Saved workflow source readback differs.');
      await authorized();
      let approval;
      try { approval = await client.programs.getApproval({ graphId, operationIri: compiled.kaRef }); }
      catch (error) { if (error.status !== 404) throw error; }
      if (!approval) await client.programs.approve({ graphId, operationIri: compiled.kaRef, program: reference(source), allowedCallers: [owner],
        typescript: { children: [...new Set(compiled.ordered.map(n => n.kaRef))].map(operationIri => ({ graphId, operationIri })), maxCalls: 16, maxConcurrency: 1, timeoutMs: 60000 } });
      const workflow = await record(compiled, source);
      if (!workflow.approved) throw Object.assign(new Error('Workflow approval is unavailable.'), { status: 409 });
      return { ...workflow, readbackVerified: true };
    })();
    saving.set(compiled.kaRef, pending);
    try { return await pending; } finally { saving.delete(compiled.kaRef); }
  }
  async function run(value, authorizeExport) {
    if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['kaRef', 'sourceHash', 'input', 'invocationId'].includes(k))
      || typeof value.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceHash)) throw Object.assign(new Error('Invalid workflow invocation.'), { status: 400 });
    const invocationId = workflowUuid(value.invocationId);
    const { compiled, workflow } = await get(value.kaRef, value.sourceHash);
    if (!workflow.approved) throw Object.assign(new Error('This workflow needs an owner approval.'), { status: 409 });
    validateWorkflowCapabilities(compiled.definition, await listCapabilities());
    if (compiled.requiresExportAuthorization) authorizeExport();
    const input = workflowRunInput(compiled.definition, value.input);
    const result = await client.programs.invoke({ graphId, operationIri: compiled.kaRef, invocationId, inputs: [input] });
    if (!isDeepStrictEqual(await loadOutputs(result.executionIri), result.rawOutputs)) throw new Error('Parent DKG receipt readback differs.');
    const output = result.outputs[0];
    const calls = result.trace?.calls.filter(c => c.kind === 'program') ?? [];
    const status = output?.status ?? (compiled.compilerVersion === 1 ? 'completed' : undefined);
    if (!output || output.kind !== 'nos-ka-workflow-result' || !Array.isArray(output.steps)
      || !['completed', 'input-rejected'].includes(status) || !output.steps.length || output.steps.length > compiled.ordered.length
      || (status === 'completed' && output.steps.length !== compiled.ordered.length) || calls.length !== output.steps.length) throw new Error('Workflow child receipts are missing.');
    const last = output.steps.at(-1), lastNode = compiled.ordered[output.steps.length - 1], nextNode = compiled.ordered[output.steps.length];
    if (status === 'input-rejected') {
      const childRejected = output.reason === 'child-rejected' && output.rejectedNode === lastNode.id
        && ['csv-parse', 'csv-map'].includes(lastNode.kind) && last.result?.output?.ok === false
        && isDeepStrictEqual(output.output, last.result.output);
      const problem = nextNode && last.result?.output?.ok === true ? workflowTableProblem(nextNode, last.result.output) : null;
      const inputRejected = output.reason === 'invalid-input' && output.rejectedNode === nextNode?.id && problem
        && isDeepStrictEqual(output.output, { ok: false, columns: [], rows: [], error: problem });
      if (!childRejected && !inputRejected) throw new Error('Workflow input rejection is invalid.');
    } else if (!isDeepStrictEqual(output.output, last?.result?.output)) throw new Error('Workflow final output differs from its last child receipt.');
    const steps = [];
    for (const [i, node] of compiled.ordered.slice(0, output.steps.length).entries()) {
      const step = output.steps[i], call = calls[i];
      if (step.nodeId !== node.id || step.kaRef !== node.kaRef || step.result?.kind !== 'n8n-result'
        || call.target !== node.kaRef || call.status !== 'succeeded' || !call.executionIri) throw new Error('Workflow child identity differs.');
      const stored = await loadOutputs(call.executionIri);
      if (stored.length !== 1 || !isDeepStrictEqual(JSON.parse(stored[0]), step.result)) throw new Error('Child DKG receipt readback differs.');
      steps.push({ nodeId: node.id, kaRef: node.kaRef, sourceHash: node.sourceHash, executionIri: call.executionIri,
        n8nExecutionId: step.result.n8nExecutionId, workflowSha256: step.result.workflowSha256,
        output: step.result.output, persisted: true, readbackVerified: true });
    }
    return { kaRef: workflow.kaRef, sourceHash: workflow.sourceHash, invocationId, executionIri: result.executionIri,
      status, output: output.output, steps, persisted: true, readbackVerified: true };
  }
  return { list, get, save, run };
}
