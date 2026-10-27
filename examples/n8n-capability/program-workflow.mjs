import { createHash } from 'node:crypto';
import { component, componentValidationSource } from './component-registry.mjs';
import { programRecords } from './program-block.mjs';

export const PROGRAM_STUDIO_MARKER = '// nos-program-studio-v1:';
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_WORKFLOW', status: 400 }); };

export function programOrder(definition) {
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

export function compileProgramWorkflow(definition) {
  const ordered = programOrder(definition);
  const operations = new Map();
  for (const node of ordered) {
    const operation = node.componentId === 'run-program' ? node.params.operationIri : node.kaRef;
    if (operations.has(node.kaRef) && operations.get(node.kaRef) !== operation) fail('Use one approved operation for each Program version in a workflow.');
    operations.set(node.kaRef, operation);
  }
  const revision = createHash('sha256').update(JSON.stringify({ compiler: 'program-v1', definition })).digest('hex');
  return { definition, ordered, kaRef: `urn:demo:nos:studio:${definition.id}:${revision.slice(0, 20)}`,
    workflowName: 'nOS Program workflow ' + revision, mode: 'action', executor: 'dkg',
    grant: { kind: 'program-workflow-v1' }, requiresExportAuthorization: definition.nodes.some(n => component(n.componentId).writes) };
}

/** Compiled with static child declarations; invoke_program retains caller identity and host-selected child IDs. */
export async function runProgramSteps(input, nodes, invoke, normalize, resolve, records) {
  let items = records(JSON.parse(input.itemsJson));
  let ok = true, error = '';
  const steps = [];
  // Validate the root parameters as well as the incoming record set.
  const checked = normalize(nodes[0].descriptor, input);
  if (checked.paramsJson !== JSON.stringify(nodes[0].params) || checked.executionId) throw new Error('Use the saved workflow parameters.');
  for (const node of nodes) {
    const results = [];
    let status = 'skipped';
    if (ok && (items.length || node.componentId === 'run-program' && node.params.inputMode === 'all-items')) {
      status = 'completed';
      if (node.componentId === 'run-program') {
        // Resolve every mapping before invoking this block, so a missing field cannot partially dispatch its batch.
        const args = node.params.inputMode === 'all-items'
          ? [resolve(node.params.inputMapping, items)]
          : items.map(item => resolve(node.params.inputMapping, item));
        if (JSON.stringify(args).length > 8192) throw new Error('Mapped program input exceeds 8 KiB.');
        for (const arg of args) results.push(await invoke(node.kaRef, [arg]));
        items = records(results.flatMap(value => Array.isArray(value) ? value : [value]));
      } else {
        const value = await invoke(node.kaRef, [normalize(node.descriptor, {
          itemsJson: JSON.stringify(items), paramsJson: JSON.stringify(node.params), executionId: '',
        })]);
        if (value?.kind !== 'n8n-result' || typeof value.output?.ok !== 'boolean') throw new Error('The n8n child returned an invalid result.');
        results.push(value);
        ok = value.output.ok;
        if (!ok) { status = 'failed'; error = String(value.output.error).slice(0, 512); items = []; }
        else items = records(JSON.parse(value.output.itemsJson));
      }
    }
    steps.push({ nodeId: node.id, kaRef: node.kaRef, status, results });
  }
  return { kind: 'nos-program-workflow-result', steps,
    output: { ok, itemsJson: JSON.stringify(items), portsJson: '{}', error } };
}

export function programWorkflowSource(compiled) {
  const nodes = compiled.ordered.map(node => ({ ...node, descriptor: component(node.componentId) }));
  return PROGRAM_STUDIO_MARKER + Buffer.from(JSON.stringify(compiled.definition)).toString('base64') + '\n'
    + `import { invoke_program } from '@origintrail-official/dkg-graph-computer/program';\n${componentValidationSource()}`
    + `const records = ${programRecords.toString()};\nconst execute = ${runProgramSteps.toString()};\n`
    + `export function run(input: any) { return execute(input, ${JSON.stringify(nodes)}, invoke_program, normalize, resolveComponentValue, records); }\n`;
}

export function readProgramWorkflow(source, normalizeStudio) {
  if (source.length > 65536) fail('Saved Program workflow source is too large.');
  const definition = normalizeStudio(JSON.parse(Buffer.from(source.split('\n')[0].slice(PROGRAM_STUDIO_MARKER.length), 'base64').toString('utf8')));
  const compiled = compileProgramWorkflow(definition);
  if (programWorkflowSource(compiled) !== source) fail('Saved Program workflow differs from its pinned definition.');
  return compiled;
}
