import { createHash } from 'node:crypto';
import { defaultComponentRegistry, componentExecutionDescriptor, componentValidationSource } from './component-registry.mjs';
import { programRecordsSource, runProgramStepsSource } from './guest-sources/program-v1.mjs';

export const PROGRAM_STUDIO_MARKER = '// nos-program-studio-v1:';
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_WORKFLOW', status: 400 }); };

export function programOrder(definition, registry = defaultComponentRegistry) {
  const { component } = registry;
  const ordered = [];
  let current = definition.entryId;
  while (current && !ordered.some(n => n.id === current)) {
    const node = definition.nodes.find(n => n.id === current);
    if (!node) fail('Connect every block to the first block.');
    const descriptor = component(node.componentId);
    if (!['action', 'program', 'subworkflow', 'wait'].includes(descriptor.mode) || descriptor.outputs.length !== 1 || (descriptor.inputs ?? 1) !== 1)
      fail('Run Program KA currently supports a linear workflow. Use action blocks before and after the program.');
    ordered.push(node);
    const next = definition.edges.filter(e => e.from === current);
    if (next.length > 1) fail('Run Program KA currently supports one connection to the next block.');
    current = next[0]?.to;
  }
  if (current || ordered.length !== definition.nodes.length || definition.edges.length !== ordered.length - 1)
    fail('Connect Run Program KA in one linear workflow without branches or cycles.');
  return ordered;
}

/** @returns {import('./studio-definition.mjs').ProgramStudioExecution} */
export function compileProgramWorkflow(definition, registry = defaultComponentRegistry) {
  const { component, componentNeedsExport } = registry;
  const ordered = programOrder(definition, registry);
  const operations = new Map();
  for (const node of ordered) {
    const operation = node.componentId === 'run-program' ? node.params.operationIri : node.kaRef;
    if (operations.has(node.kaRef) && operations.get(node.kaRef) !== operation) fail('Use one approved operation for each Program version in a workflow.');
    operations.set(node.kaRef, operation);
  }
  const revision = createHash('sha256').update(JSON.stringify({ compiler: 'program-v1', definition })).digest('hex');
  return { definition, ordered, kaRef: `urn:demo:nos:studio:${definition.id}:${revision.slice(0, 20)}`,
    workflowName: 'nOS Program workflow ' + revision, mode: 'action', kind: 'dkg-program',
    requiresExportAuthorization: definition.nodes.some(n => componentNeedsExport(component(n.componentId))) };
}

export function programWorkflowSource(compiled, registry = defaultComponentRegistry) {
  const { component } = registry;
  const nodes = compiled.ordered.map(node => ({ ...node, descriptor: componentExecutionDescriptor(component(node.componentId)) }));
  return PROGRAM_STUDIO_MARKER + Buffer.from(JSON.stringify(compiled.definition)).toString('base64') + '\n'
    + `import { invoke_program } from '@origintrail-official/dkg-graph-computer/program';\n${componentValidationSource()}`
    + `const records = ${programRecordsSource};\nconst execute = ${runProgramStepsSource};\n`
    + `export function run(input: any) { return execute(input, ${JSON.stringify(nodes)}, invoke_program, normalize, resolveComponentValue, records); }\n`;
}

export function readProgramWorkflow(source, normalizeStudio, registry = defaultComponentRegistry) {
  if (source.length > 65536) fail('Saved Program workflow source is too large.');
  const definition = normalizeStudio(JSON.parse(Buffer.from(source.split('\n')[0].slice(PROGRAM_STUDIO_MARKER.length), 'base64').toString('utf8')));
  const compiled = compileProgramWorkflow(definition, registry);
  if (programWorkflowSource(compiled, registry) !== source) fail('Saved Program workflow differs from its pinned definition.');
  return compiled;
}
