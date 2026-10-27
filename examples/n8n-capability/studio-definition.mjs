import { createHash } from 'node:crypto';
import { component, normalizeComponentInput, componentContract, componentValidationSource } from './component-registry.mjs';
import { readStudio as readStudioV1 } from './studio-definition-v1.mjs';
import { componentPiece, nativeNode, editNode, wire, expression, nativeLiteral } from './component-workflows.mjs';
import { n8nWorkflowSha256, n8nObservationScope } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';
import { workflowUuid } from './workflow-definition.mjs';
import { compileProgramWorkflow, programWorkflowSource, readProgramWorkflow, PROGRAM_STUDIO_MARKER } from './program-workflow.mjs';

export const STUDIO_PREFIX = 'urn:demo:nos:studio:';
const marker = '// nos-n8n-studio-v2:';
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_WORKFLOW', status: 400 }); };
const closed = (v, keys) => { if (!record(v) || Object.keys(v).some(k => !keys.includes(k))) fail('Unexpected workflow fields.'); };
const identifier = v => { if (typeof v !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/i.test(v)) fail('Invalid block identity.'); return v; };

export function normalizeStudio(value) {
  closed(value, ['id', 'name', 'entryId', 'nodes', 'edges']);
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) fail('Name this workflow (up to 80 characters).');
  if (!Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 8) fail('Add between one and eight component KAs.');
  if (!Array.isArray(value.edges) || value.edges.length > 20) fail('Too many connections.');
  const nodes = value.nodes.map(n => {
    closed(n, ['id', 'componentId', 'kaRef', 'sourceHash', 'params', 'x', 'y']);
    const descriptor = component(n.componentId);
    if (typeof n.kaRef !== 'string' || (n.componentId === 'run-program' ? !/^[a-z][a-z0-9+.-]*:[^\s<>"{}\\]{1,220}$/i.test(n.kaRef) : !/^urn:demo:n8n:component:[a-z0-9:-]{1,100}$/.test(n.kaRef))
      || typeof n.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(n.sourceHash)) fail('Choose a pinned component KA.');
    if (![n.x, n.y].every(p => Number.isInteger(p) && p >= 0 && p <= 10000)) fail('Invalid block position.');
    let params;
    try { params = JSON.parse(normalizeComponentInput(descriptor, { itemsJson: JSON.stringify(descriptor.sampleItems), paramsJson: JSON.stringify(n.params), executionId: '1' }).paramsJson); }
    catch (e) { fail(e.message); }
    return { id: identifier(n.id), componentId: descriptor.id, kaRef: n.kaRef, sourceHash: n.sourceHash, params, x: n.x, y: n.y };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(nodes.map(n => n.id)).size !== nodes.length) fail('Block identities must be unique.');
  if (nodes.filter(n => n.componentId === 'loop-items').length > 1) fail('This PoC supports one Loop Over Items block per workflow.');
  const byId = new Map(nodes.map(n => [n.id, n]));
  const entryId = identifier(value.entryId);
  if (!byId.has(entryId)) fail('Choose the first block.');
  const edges = value.edges.map(e => {
    closed(e, ['from', 'output', 'to', 'input']);
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b || a === b || !Number.isInteger(e.output) || e.output < 0 || e.output >= component(a.componentId).outputs.length
      || !Number.isInteger(e.input) || e.input < 0 || e.input >= (component(b.componentId).inputs ?? 1)) fail('Connect valid input and output ports.');
    if (['schedule', 'webhook'].includes(b.componentId)) fail('An event trigger must be the first block.');
    if (component(b.componentId).input === 'file' && component(a.componentId).outputs[e.output] !== 'file') fail('Connect a file output to this file input.');
    return { from: a.id, output: e.output, to: b.id, input: e.input };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const seen = new Set();
  for (const e of edges) { const key = `${e.to}:${e.input}`; if (seen.has(key) && byId.get(e.to).componentId !== 'loop-items') fail('Each input port accepts one connection. Use Merge to combine branches.'); seen.add(key); }
  if (new Set(edges.map(e => JSON.stringify(e))).size !== edges.length) fail('Duplicate connection.');
  // A loop has one initial input and exactly one return from its body. All other cycles are rejected.
  const returns = new Set();
  const reachable = (from, target, ignore = new Set(), visited = new Set()) => {
    if (from === target) return true;
    if (visited.has(from)) return false; visited.add(from);
    return edges.some(e => e.from === from && !ignore.has(e) && reachable(e.to, target, ignore, visited));
  };
  for (const n of nodes.filter(n => n.componentId === 'loop-items')) {
    const starts = edges.filter(e => e.from === n.id && e.output === 1);
    if (starts.length !== 1) fail('Connect the loop output to one loop body.');
    const back = edges.filter(e => e.to === n.id && reachable(starts[0].to, e.from, new Set(edges.filter(v => v.to === n.id))));
    if (back.length !== 1) fail('Connect the last loop-body block back to Loop Over Items.');
    returns.add(back[0]);
    if (n.id !== entryId && edges.filter(e => e.to === n.id && !back.includes(e)).length !== 1) fail('A loop needs one initial input.');
  }
  const visiting = new Set(), visited = new Set();
  const walk = id => { if (visiting.has(id)) fail('Only a Loop Over Items return may form a cycle.'); if (visited.has(id)) return;
    visiting.add(id); for (const e of edges.filter(e => e.from === id && !returns.has(e))) walk(e.to); visiting.delete(id); visited.add(id); };
  walk(entryId);
  if (visited.size !== nodes.length) fail('Connect every block to the first block.');
  if (edges.some(e => e.to === entryId && !returns.has(e))) fail('The first block cannot have an incoming connection.');
  for (const n of nodes) {
    if (n.id !== entryId && component(n.componentId).inputs === 2 && [0, 1].some(i => !edges.some(e => e.to === n.id && e.input === i))) fail('Connect both inputs of the join block.');
    if (n.id !== entryId && ['schedule', 'webhook'].includes(n.componentId)) fail('Place event triggers first.');
  }
  if (component(byId.get(entryId).componentId).inputs === 2) fail('A join needs two upstream blocks.');
  return { id: workflowUuid(value.id), name: value.name.trim(), entryId, nodes, edges };
}

export function validateStudioCapabilities(definition, capabilities) {
  for (const n of definition.nodes) {
    const c = capabilities.find(c => c.kaRef === n.kaRef && c.sourceHash === n.sourceHash && c.descriptor?.id === n.componentId
      && (n.componentId !== 'run-program' || c.operationIri === n.params.operationIri));
    if (!c?.available || n.componentId === 'run-program' && n.params.version !== c.version) throw Object.assign(new Error('A selected KA version is unavailable. Refresh the catalog and choose an approved revision.'), { code: 'WORKFLOW_CAPABILITY_CHANGED', status: 409 });
  }
}

export function compileStudio(value, { graphId, owner, headerCredential, credentials = {}, fixture = false, providerId } = {}) {
  const definition = normalizeStudio(value);
  if (definition.nodes.some(n => n.componentId === 'run-program')) return compileProgramWorkflow(definition);
  const revision = createHash('sha256').update(JSON.stringify({ compiler: 2, definition })).digest('hex');
  const kaRef = STUDIO_PREFIX + definition.id + ':' + revision.slice(0, 20), workflowName = 'nOS Studio ' + revision;
  const workflowId = providerId ?? 'nos_studio_' + createHash('sha256').update(JSON.stringify([graphId, owner, 2, definition])).digest('hex').slice(0, 32);
  const scopeName = n8nObservationScope(graphId, owner, workflowId);
  const root = definition.nodes.find(n => n.id === definition.entryId), mode = component(root.componentId).mode;
  const nodes = [], connections = {}, pieces = new Map();
  for (const n of definition.nodes) {
    const descriptor = component(n.componentId), name = 'Block ' + n.id;
    const piece = componentPiece(n.componentId, name, key => n.componentId === 'schedule' ? JSON.stringify(n.params[key]) : nativeLiteral(n.params[key]), { credentials });
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
        const guard = editNode(name + ' check ' + i, `(() => { ${componentValidationSource()} const input = $input.all().map(i => i.json); normalize(${nativeLiteral(descriptor)}, { itemsJson: JSON.stringify(input), paramsJson: ${nativeLiteral(JSON.stringify(n.params))}, executionId: '' }); return $json; })()`);
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
    const chain = [receive.name, ack.name, scope.name, prepare.name, split.name, items.name, pieces.get(root.id).entries[0]];
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
    result: { nodes: [...new Set(sinks.map(s => s.node))], sinks, traceNodes: definition.nodes.map(n => pieces.get(n.id).resultNode), allowObservation: false } };
  return { definition, kaRef, workflowId, workflowName, workflow, grant, mode, requiresExportAuthorization: definition.nodes.some(n => component(n.componentId).writes) };
}

export function studioProgramSource(compiled, grant = compiled.grant) {
  if (compiled.executor === 'dkg') return programWorkflowSource(compiled);
  const metadata = { definition: compiled.definition, grant, mode: compiled.mode };
  const root = compiled.definition.nodes.find(n => n.id === compiled.definition.entryId);
  const descriptor = { ...component(root.componentId), ...(compiled.mode === 'schedule' ? { mode: 'action' } : {}) };
  return marker + Buffer.from(JSON.stringify(metadata)).toString('base64') + '\n'
    + `import { invoke_tool } from '@origintrail-official/dkg-graph-computer/program';\n${componentValidationSource()}`
    + `export function run(input: unknown) { const value = normalize(${JSON.stringify(descriptor)}, input); if (value.paramsJson !== ${JSON.stringify(JSON.stringify(root.params))} || value.executionId) throw new Error('Use the saved workflow parameters.'); return invoke_tool('urn:dkg:tool:n8n', value); }\n`;
}

export function readStudio(source) {
  if (typeof source === 'string' && source.startsWith(PROGRAM_STUDIO_MARKER)) return readProgramWorkflow(source, normalizeStudio);
  if (typeof source === 'string' && source.startsWith('// nos-n8n-studio-v1:')) return { ...readStudioV1(source), legacy: true };
  if (typeof source !== 'string' || !source.startsWith(marker) || source.length > 65536) fail('Saved Studio source is invalid.');
  const data = JSON.parse(Buffer.from(source.split('\n')[0].slice(marker.length), 'base64').toString('utf8'));
  const definition = normalizeStudio(data.definition);
  const revision = createHash('sha256').update(JSON.stringify({ compiler: 2, definition })).digest('hex');
  const compiled = { definition, grant: data.grant, mode: data.mode, kaRef: STUDIO_PREFIX + definition.id + ':' + revision.slice(0, 20),
    requiresExportAuthorization: definition.nodes.some(n => component(n.componentId).writes) };
  if (studioProgramSource(compiled) !== source) fail('Saved Studio source differs from its reviewed definition.');
  return compiled;
}
