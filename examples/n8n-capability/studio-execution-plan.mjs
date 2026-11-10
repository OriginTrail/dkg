import { createStudioCompiler } from './studio-definition.mjs';

/** The same plan supplies upload declarations and approval permissions. */
export function studioExecutionPlan(compiled, graphId, compiler = createStudioCompiler()) {
  const source = compiler.studioProgramSource(compiled);
  const limits = { maxConcurrency: 1, timeoutMs: 60000 };
  if (compiled.executor === 'dkg') {
    const children = [...new Map(compiled.definition.nodes.map(n => [n.kaRef, { graphId,
      operationIri: n.componentId === 'run-program' ? n.params.operationIri : n.kaRef }])).values()];
    return { kind: 'dkg-program',
      upload: { source, requiredTools: [], permittedPrograms: [...new Set(compiled.definition.nodes.map(n => n.kaRef))] },
      approval: { typescript: { children, maxCalls: 256, ...limits } } };
  }
  return { kind: 'native-n8n',
    upload: { source, requiredTools: ['urn:dkg:tool:n8n'], permittedPrograms: [], requestedPermissions: { graphId, n8n: compiled.grant } },
    approval: { n8n: compiled.grant, typescript: { children: [], maxCalls: 16, ...limits } } };
}

export async function prepareStudioExecution(definition, graphId, provisionNative, compiler = createStudioCompiler()) {
  const compiled = definition.nodes.some(n => n.componentId === 'run-program')
    ? compiler.compileStudio(definition) : await provisionNative(definition);
  return { compiled, plan: studioExecutionPlan(compiled, graphId, compiler) };
}
