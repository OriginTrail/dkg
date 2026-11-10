import { createStudioCompiler } from './studio-definition.mjs';

/** The same plan supplies upload declarations and approval permissions.
 * @param {import('./studio-definition.mjs').StudioExecution} compiled
 */
export function studioExecutionPlan(compiled, graphId, compiler = createStudioCompiler()) {
  const source = compiler.studioProgramSource(compiled);
  const limits = { maxConcurrency: 1, timeoutMs: 60000 };
  if (compiled.kind === 'dkg-program') {
    const children = [...new Map(compiled.definition.nodes.map(n => [n.kaRef, { graphId,
      operationIri: n.componentId === 'run-program' ? n.params.operationIri : n.kaRef }])).values()];
    return {
      upload: { source, requiredTools: [], permittedPrograms: [...new Set(compiled.definition.nodes.map(n => n.kaRef))] },
      approval: { typescript: { children, maxCalls: 256, ...limits } } };
  }
  return {
    upload: { source, requiredTools: ['urn:dkg:tool:n8n'], permittedPrograms: [], requestedPermissions: { graphId, n8n: compiled.grant } },
    approval: { n8n: compiled.grant, typescript: { children: [], maxCalls: 16, ...limits } } };
}

export async function prepareStudioExecution(definition, graphId, provisionNative, compiler = createStudioCompiler()) {
  const execution = compiler.normalizeStudioExecution(definition);
  let compiled;
  switch (execution.kind) {
    case 'dkg-program': compiled = compiler.compileStudio(execution.definition); break;
    case 'native-n8n': compiled = await provisionNative(execution.definition); break;
    default: throw Object.assign(new Error('Unknown Studio execution variant.'), { code: 'INVALID_WORKFLOW', status: 400 });
  }
  return { compiled, plan: studioExecutionPlan(compiled, graphId, compiler) };
}
