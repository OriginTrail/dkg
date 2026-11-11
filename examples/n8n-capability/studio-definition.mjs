import { parseStudioDefinition } from '../../packages/studio-contracts/dist/studio-evidence.js';
import { expandStudioComponents } from '../../packages/studio-contracts/dist/studio-composition.js';
import { isDeepStrictEqual } from 'node:util';
import { assertStudioSourceBudget, STUDIO_SOURCE_LIMIT } from './studio-source-budget.mjs';
import { validateInvocationBindings, invocationGrant, invocationParameter, invocationParameters, invocationProgramBody, invocationItem, normalizeInputValueNodes, nativeArgumentAdmission } from './studio-inputs.mjs';
import { hasEntryInputBindings } from './studio-entry-input.mjs';
import { normalizeStudioTopology } from './studio-topology.mjs';
import { validateDkgTopology } from './dkg-components.mjs';
import { createHash } from 'node:crypto';
import { defaultComponentRegistry, componentExecutionDescriptor, normalizeComponentParameters, componentContract, componentValidationSource } from './component-registry.mjs';
import { readStudio as readStudioV1, studioProgramSource as studioProgramSourceV1 } from './studio-definition-v1.mjs';
import { componentPiece, nativeNode, editNode, wire, expression, nativeLiteral } from './component-workflows.mjs';
import { n8nWorkflowSha256, n8nObservationScope } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';
import { workflowUuid } from './workflow-definition.mjs';
import { compileProgramWorkflow, programWorkflowSource, readProgramWorkflow, PROGRAM_STUDIO_MARKER } from './program-workflow.mjs';
import { isProgramReference } from './program-block.mjs';

export const STUDIO_PREFIX = 'urn:demo:nos:studio:';
const marker = '// nos-n8n-studio-v2:';
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_WORKFLOW', status: 400 }); };
const closed = (v, keys) => { if (!record(v) || Object.keys(v).some(k => !keys.includes(k))) fail('Unexpected workflow fields.'); };
const identifier = v => { if (typeof v !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/i.test(v)) fail('Invalid block identity.'); return v; };

/**
 * @typedef {object} StudioExecutionBase
 * @property {ReturnType<typeof normalizeStudio>} definition
 * @property {string} kaRef
 * @property {string} mode
 * @property {boolean} requiresExportAuthorization
 * @property {string} [workflowName]
 * @typedef {StudioExecutionBase & { kind: 'native-n8n', grant: import('../../packages/cli/dist/semantic-runtime-n8n-contract.js').NativeN8nGrant, compiler?: number, legacy?: boolean, workflow?: object, workflowId?: string }} NativeStudioExecution
 * @typedef {StudioExecutionBase & { kind: 'dkg-program', ordered: ReturnType<typeof normalizeStudio>['nodes'] }} ProgramStudioExecution
 * @typedef {NativeStudioExecution | ProgramStudioExecution} StudioExecution
 */

/** Compiler preparation selects the execution variant before native ownership,
 * credentials and provider identity are available to build the native graph.
 * @returns {Pick<StudioExecution, 'kind' | 'definition'>}
 */
export function normalizeStudioExecution(value, registry = defaultComponentRegistry) {
  const definition = normalizeStudio(value, registry);
  return { kind: definition.nodes.some(n => n.componentId === 'run-program') ? 'dkg-program' : 'native-n8n', definition };
}

export function normalizeStudio(value, registry = defaultComponentRegistry) {
  if (value?.composition) {
    const { composition, ...body } = value;
    if (!composition.definition || composition.definition.composition || !Array.isArray(composition.components)) fail('Invalid composition snapshot.');
    for (const c of composition.components) {
      const digest = createHash('sha256').update(JSON.stringify(c.recipe)).digest('hex');
      if (c.sourceHash !== digest || c.kaRef !== 'urn:nos:component:workflow:' + digest) fail('Component source pin changed.');
    }
    const normalized = normalizeStudio(body, registry);
    const expanded = normalizeStudio(expandStudioComponents(composition.definition, composition.components).definition, registry);
    if (!isDeepStrictEqual(normalized, expanded)) fail('Composition differs from its pinned expansion.');
    return parseStudioDefinition({ ...normalized, composition });
  }
  if (value?.inputs !== undefined) {
    const { inputs, ...body } = value;
    const definition = { ...normalizeStudio(body, registry), inputs };
    validateInvocationBindings(definition, registry);
    return definition;
  }
  if (value?.nodes?.some(node => node.inputValues !== undefined))
    return normalizeInputValueNodes(value, body => normalizeStudio(body, registry));

  const { component } = registry;
  closed(value, ['id', 'name', 'entryId', 'nodes', 'edges', 'groups']);
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) fail('Name this workflow (up to 80 characters).');
  if (!Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 12) fail('Add between one and twelve component KAs.');
  if (!Array.isArray(value.edges) || value.edges.length > 20) fail('Too many connections.');
  const nodes = value.nodes.map(n => {
    closed(n, ['id', 'componentId', 'kaRef', 'sourceHash', 'params', 'x', 'y', 'label', 'groupId']);
    if (n.label !== undefined && (typeof n.label !== 'string' || !n.label.trim() || n.label.length > 80)) fail('Name each step using up to 80 characters.');
    if (n.groupId !== undefined) identifier(n.groupId);
    const descriptor = component(n.componentId);
    if (typeof n.kaRef !== 'string' || (n.componentId === 'run-program' ? !isProgramReference(n.kaRef) : !/^urn:(?:demo:n8n|nos):component:[a-z0-9:-]{1,160}$/.test(n.kaRef))
      || typeof n.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(n.sourceHash)) fail('Choose a pinned component KA.');
    if (![n.x, n.y].every(p => Number.isInteger(p) && p >= 0 && p <= 10000)) fail('Invalid block position.');
    let params;
    try { params = normalizeComponentParameters(descriptor, JSON.stringify(n.params)); }
    catch (e) { fail(e.message); }
    return { id: identifier(n.id), componentId: descriptor.id, kaRef: n.kaRef, sourceHash: n.sourceHash, params, x: n.x, y: n.y,
      ...(n.label !== undefined ? { label: n.label } : {}), ...(n.groupId !== undefined ? { groupId: n.groupId } : {}) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const { entryId, edges } = normalizeStudioTopology({ nodes, edges: value.edges, entryId: value.entryId }, component);
  validateDkgTopology({ entryId, nodes, edges });
  let groups;
  if (value.groups !== undefined) {
    if (!Array.isArray(value.groups) || value.groups.length > 12) fail('Use up to twelve visual groups.');
    groups = value.groups.map(g => {
      closed(g, ['id', 'name', 'tone']);
      if (typeof g.name !== 'string' || !g.name.trim() || g.name.length > 80 || !['purple', 'teal', 'amber', 'neutral'].includes(g.tone)) fail('Name each visual group and choose its color.');
      return { id: identifier(g.id), name: g.name, tone: g.tone };
    });
    if (new Set(groups.map(g => g.id)).size !== groups.length) fail('Visual group identities must be unique.');
  }
  if (nodes.some(n => n.groupId !== undefined && !groups?.some(g => g.id === n.groupId))) fail('Choose an existing visual group.');
  return { id: workflowUuid(value.id), name: value.name.trim(), entryId, nodes, edges, ...(groups !== undefined ? { groups } : {}) };
}

export function validateStudioCapabilities(definition, capabilities, registry = defaultComponentRegistry) {
  const { component, componentNeedsExport: needsExport } = registry;
  const selected = definition.nodes.map(n => {
    const c = capabilities.find(c => c.kaRef === n.kaRef && c.sourceHash === n.sourceHash && c.descriptor?.id === n.componentId
      && (n.componentId !== 'run-program' || c.operationIri === n.params.operationIri));
    if (!c?.available || n.componentId === 'run-program' && n.params.version !== c.version) throw Object.assign(new Error('A selected KA version is unavailable. Refresh the catalog and choose an approved revision.'), { code: 'WORKFLOW_CAPABILITY_CHANGED', status: 409 });
    return c;
  });
  return { selected, requiresExportAuthorization: selected.some(c => c.requiresExportAuthorization)
    || definition.nodes.some(n => needsExport(component(n.componentId))) };
}

/** @returns {StudioExecution} */
export function compileStudio(value, { graphId, owner, headerCredential, credentials = {}, fixture = false, providerId, registry = defaultComponentRegistry } = {}) {
  const { component, componentNeedsExport: needsExport } = registry;
  const { kind, definition } = normalizeStudioExecution(value, registry);
  if (kind === 'dkg-program') return compileProgramWorkflow(definition, registry);
  // Embedded helper definitions need a new immutable source identity.
  const compiler = definition.inputs !== undefined ? 8 : hasEntryInputBindings(definition) ? 7 : definition.nodes.some(n => n.componentId === 'execute-workflow') ? 5 : 4;
  const revision = createHash('sha256').update(JSON.stringify({ compiler, definition })).digest('hex');
  const kaRef = STUDIO_PREFIX + definition.id + ':' + revision.slice(0, 20), workflowName = 'nOS Studio ' + revision;
  const workflowId = providerId ?? 'nos_studio_' + createHash('sha256').update(JSON.stringify([graphId, owner, compiler, definition])).digest('hex').slice(0, 32);
  const scopeName = n8nObservationScope(graphId, owner, workflowId);
  const root = definition.nodes.find(n => n.id === definition.entryId), mode = component(root.componentId).mode;
  const nodes = [], connections = {}, pieces = new Map();
  for (const n of definition.nodes) {
    const descriptor = componentExecutionDescriptor(component(n.componentId)), name = 'Block ' + n.id;
    const piece = componentPiece(n.componentId, name, key => n.componentId === 'schedule' ? JSON.stringify(n.params[key]) : invocationParameter(definition, n, key), { registry, blockId: n.id, credentials: { ...credentials, httpHeaderAuth: headerCredential } });
    Object.assign(connections, piece.connections); nodes.push(...piece.nodes);
    if (n.componentId === 'schedule') {
      const event = editNode(name + ' event', '$json'); nodes.push(event);
      piece.entry = event.name; piece.resultNode = event.name; piece.exits = [event.name];
      const triggerScope = editNode(scopeName + ' trigger', '$json'); nodes.push(triggerScope);
      wire(connections, name, triggerScope.name);
      // The native timer only emits an event. The DKG Program authorizes the
      // separate action execution before any downstream side effects can run.
    }
    piece.entries = [];
    if (!['schedule', 'webhook'].includes(n.componentId)) {
      for (let i = 0; i < (descriptor.inputs ?? 1); i++) {
        const guard = editNode(name + ' check ' + i, `(() => { ${componentValidationSource()} const input = $input.all().map(i => ${invocationItem(definition, n, "i.json")}); normalize(${nativeLiteral(descriptor)}, { itemsJson: JSON.stringify(input), paramsJson: ${invocationParameters(definition, n)}, executionId: '' }); return ${invocationItem(definition, n)}; })()`);
        nodes.push(guard); wire(connections, guard.name, piece.entry, 0, i); piece.entries.push(guard.name);
      }
    } else piece.entries = [piece.entry];
    pieces.set(n.id, piece);
  }
  for (const e of definition.edges) wire(connections, pieces.get(e.from).exits[e.output], pieces.get(e.to).entries[e.input], e.output, 0);
  const scope = editNode(scopeName, '$json'); nodes.push(scope);
  {
    const receive = nativeNode('Receive input', 'webhook', { httpMethod: 'POST', path: 'dkg-capability-' + workflowId,
      authentication: fixture ? 'none' : 'headerAuth', responseMode: 'responseNode', options: {} }, { webhookId: workflowId,
      ...(!fixture ? { credentials: { httpHeaderAuth: headerCredential } } : {}) });
    const ack = nativeNode('Execution accepted', 'respondToWebhook', { respondWith: 'json', responseBody: expression('({ executionId: String($execution.id) })'), options: {} }); ack.typeVersion = 1.4;
    const prepare = editNode('Prepare input', `({ records: JSON.parse($('Receive input').first().json.body.input.itemsJson) })`);
    const split = nativeNode('Split input', 'splitOut', { fieldToSplitOut: 'records', include: 'noOtherFields', options: { destinationFieldName: 'record' } });
    const items = editNode('Input items', '$json.record'); nodes.unshift(receive, ack, prepare, split, items);
    const admission = definition.inputs !== undefined ? editNode('Admit arguments', nativeArgumentAdmission(definition)) : undefined;
    if (admission) nodes.push(admission);
    const chain = [receive.name, ack.name, scope.name, ...(admission ? [admission.name] : []), prepare.name, split.name, items.name, pieces.get(root.id).entries[0]];
    chain.slice(0, -1).forEach((from, i) => wire(connections, from, chain[i + 1]));
  }
  const sinks = definition.nodes.flatMap(n => component(n.componentId).outputs.flatMap((name, output) =>
    definition.edges.some(e => e.from === n.id && e.output === output) ? [] : [{ node: pieces.get(n.id).resultNode, port: output, name: n.id + ' ' + name }]));
  // Stop And Error deliberately has no output; retain its node for error evidence.
  if (!sinks.length) sinks.push({ node: pieces.get(definition.nodes.at(-1).id).resultNode, port: 0, name: 'result' });
  if (sinks.length > 16) fail('Use at most sixteen unconnected result ports.');
  nodes.forEach((n, i) => { n.position = [i * 200, 0]; });
  const workflow = { name: workflowName, nodes, connections,
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveManualExecutions: true, executionTimeout: 50 } };
  const grant = { toolIri: 'urn:dkg:tool:n8n', workflowId, workflowSha256: n8nWorkflowSha256(workflow),
    ...componentContract, outputSchema: { ...componentContract.outputSchema, properties: { ...componentContract.outputSchema.properties, traceJson: { type: 'string', maxLength: 8192 } },
      required: [...componentContract.outputSchema.required, 'traceJson'] },
    result: { nodes: [...new Set(sinks.map(s => s.node))], sinks, traceNodes: definition.nodes.map(n => pieces.get(n.id).traceNode ?? pieces.get(n.id).resultNode), allowObservation: false } };
  return { kind: 'native-n8n', compiler, definition, kaRef, workflowId, workflowName, workflow, grant: invocationGrant(definition, grant), mode, requiresExportAuthorization: definition.nodes.some(n => needsExport(component(n.componentId))) };
}

export function studioProgramSource(compiled, grant = compiled.grant, registry = defaultComponentRegistry) {
  const source = uncheckedStudioProgramSource(compiled, grant, registry);
  return compiled.kind === 'dkg-program' ? source : assertStudioSourceBudget(source);
}
function uncheckedStudioProgramSource(compiled, grant, registry) {
  const { component } = registry;
  if (compiled.kind === 'dkg-program') return programWorkflowSource(compiled, registry);
  if (compiled.kind !== 'native-n8n' || !record(grant)) fail('A native Studio execution grant is required.');
  if (compiled.legacy) return studioProgramSourceV1(compiled, grant);
  const metadata = { definition: compiled.definition, grant, mode: compiled.mode,
    ...([4, 5, 6, 7, 8].includes(compiled.compiler) ? { compiler: compiled.compiler } : {}) };
  const root = compiled.definition.nodes.find(n => n.id === compiled.definition.entryId);
  const descriptor = { ...componentExecutionDescriptor(component(root.componentId)), ...(compiled.mode === 'schedule' ? { mode: 'action' } : {}) };
  return marker + Buffer.from(JSON.stringify(metadata)).toString('base64') + '\n'
    + `import { invoke_tool } from '@origintrail-official/dkg-graph-computer/program';\n${componentValidationSource()}`
    + (compiled.compiler === 7 || compiled.definition.inputs !== undefined ? invocationProgramBody(compiled, descriptor, registry) : `export function run(input: unknown) { const value = normalize(${JSON.stringify(descriptor)}, input); if (value.paramsJson !== ${JSON.stringify(JSON.stringify(root.params))} || value.executionId) throw new Error('Use the saved workflow parameters.'); return invoke_tool('urn:dkg:tool:n8n', value); }\n`);
}

/** @returns {StudioExecution} */
export function readStudio(source, registry = defaultComponentRegistry) {
  const { component, componentNeedsExport: needsExport } = registry;
  if (typeof source === 'string' && source.startsWith(PROGRAM_STUDIO_MARKER)) return readProgramWorkflow(source, value => normalizeStudio(value, registry), registry);
  if (typeof source === 'string' && source.startsWith('// nos-n8n-studio-v1:')) return { ...readStudioV1(source), kind: 'native-n8n', legacy: true };
  if (typeof source !== 'string' || !source.startsWith(marker) || source.length > STUDIO_SOURCE_LIMIT) fail('Saved Studio source is invalid.');
  const data = JSON.parse(Buffer.from(source.split('\n')[0].slice(marker.length), 'base64').toString('utf8'));
  const definition = normalizeStudio(data.definition, registry);
  if (data.compiler !== undefined && ![4, 5, 6, 7, 8].includes(data.compiler)) fail('Unknown Studio compiler contract.');
  const compiler = data.compiler ?? (definition.nodes.some(n => n.componentId === 'invoke-dkg-program') ? 3 : 2);
  const revision = createHash('sha256').update(JSON.stringify({ compiler, definition })).digest('hex');
  const compiled = { kind: 'native-n8n', ...([4, 5, 6, 7, 8].includes(data.compiler) ? { compiler: data.compiler } : {}), definition, grant: data.grant, mode: data.mode, kaRef: STUDIO_PREFIX + definition.id + ':' + revision.slice(0, 20),
    requiresExportAuthorization: definition.nodes.some(n => needsExport(component(n.componentId))) };
  if (studioProgramSource(compiled, compiled.grant, registry) !== source) fail('Saved Studio source differs from its reviewed definition.');
  return compiled;
}

/** A compiler belongs to the same profile context as its provider and service. */
export function createStudioCompiler(registry = defaultComponentRegistry) {
  return Object.freeze({ registry,
    normalizeStudio: value => normalizeStudio(value, registry),
    normalizeStudioExecution: value => normalizeStudioExecution(value, registry),
    validateStudioCapabilities: (definition, capabilities) => validateStudioCapabilities(definition, capabilities, registry),
    compileStudio: (value, options) => compileStudio(value, { ...options, registry }),
    studioProgramSource: (compiled, grant) => studioProgramSource(compiled, grant, registry),
    readStudio: source => readStudio(source, registry),
  });
}
