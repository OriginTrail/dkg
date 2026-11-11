import { createHash } from 'node:crypto';

export const WORKFLOW_PREFIX = 'urn:demo:nos:workflow:';
const mappingError = 'Map fields selects a column missing from its input. Correct the mapping.';
const headersError = 'Google Sheets needs unique column names beginning with a letter. Add Map fields to rename them.';
const markers = { 1: '// nos-ka-workflow-v1:', 2: '// nos-ka-workflow-v2:' };
const kinds = ['text', 'csv-parse', 'csv-map', 'google-sheets-export'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { const error = new Error(message); error.status = 400; error.code = 'INVALID_WORKFLOW'; throw error; };
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('Unexpected workflow fields.');
}
export function workflowUuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail('A stable workflow or invocation UUID is required.');
  return value.toLowerCase();
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/i.test(value)) fail('Invalid step identity.');
  return value;
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} is required (maximum ${max} characters).`);
  return value.trim();
}
export function normalizeWorkflow(value) {
  keys(value, ['id', 'name', 'savedAt', 'nodes', 'edges']);
  const id = workflowUuid(value.id), name = text(value.name, 80, 'Workflow name');
  if (typeof value.savedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.savedAt)
    || !Number.isFinite(Date.parse(value.savedAt))) fail('Invalid workflow save time.');
  if (!Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 8) fail('Add between one and eight KA blocks.');
  if (!Array.isArray(value.edges) || value.edges.length !== value.nodes.length - 1) fail('Connect every block into one path.');
  const nodes = value.nodes.map(node => {
    keys(node, ['id', 'kaRef', 'sourceHash', 'kind', 'x', 'y', 'config']);
    if (!kinds.includes(node.kind) || typeof node.kaRef !== 'string' || !/^urn:[a-z0-9:._-]{1,500}$/i.test(node.kaRef)
      || typeof node.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(node.sourceHash)) fail('Choose a verified capability KA.');
    if (![node.x, node.y].every(n => Number.isInteger(n) && n >= 0 && n <= 10000)) fail('Invalid block position.');
    let config = {};
    if (node.kind === 'csv-map') {
      keys(node.config, ['mapping']);
      if (!Array.isArray(node.config.mapping) || !node.config.mapping.length || node.config.mapping.length > 8) fail('Choose one to eight output columns.');
      const mapping = node.config.mapping.map(entry => {
        keys(entry, ['source', 'target']);
        if (!Number.isInteger(entry.source) || entry.source < 0 || entry.source > 7
          || typeof entry.target !== 'string' || !/^[A-Za-z][A-Za-z0-9 _.-]{0,63}$/.test(entry.target)
          || ['constructor', 'prototype'].includes(entry.target)) fail('Use a source column and a valid output name.');
        return { source: entry.source, target: entry.target };
      });
      if (new Set(mapping.map(m => m.target)).size !== mapping.length) fail('Output column names must be unique.');
      config = { mapping };
    } else if (node.kind === 'google-sheets-export') {
      keys(node.config, ['title']); config = { title: text(node.config.title, 80, 'Google Sheet title') };
    } else keys(node.config, []);
    return { id: identifier(node.id), kaRef: node.kaRef, sourceHash: node.sourceHash, kind: node.kind, x: node.x, y: node.y, config };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(nodes.map(n => n.id)).size !== nodes.length) fail('Block identities must be unique.');
  const edges = value.edges.map(edge => { keys(edge, ['from', 'to']); return { from: identifier(edge.from), to: identifier(edge.to) }; })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const definition = { id, name, savedAt: value.savedAt, nodes, edges };
  orderedWorkflow(definition);
  return definition;
}
export function canConnectWorkflow(from, to) {
  return (from === 'text' && ['text', 'csv-parse'].includes(to))
    || (['csv-parse', 'csv-map'].includes(from) && ['csv-map', 'google-sheets-export'].includes(to));
}
export function orderedWorkflow(definition) {
  const byId = new Map(definition.nodes.map(node => [node.id, node]));
  const incoming = new Map(), outgoing = new Map();
  for (const edge of definition.edges) {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to || from === to || incoming.has(to.id) || outgoing.has(from.id)) fail('Each block needs one connected input and at most one output.');
    if (!canConnectWorkflow(from.kind, to.kind)) fail('These block inputs and outputs are incompatible.');
    incoming.set(to.id, from.id); outgoing.set(from.id, to.id);
  }
  const roots = definition.nodes.filter(node => !incoming.has(node.id));
  if (roots.length !== 1 || !['text', 'csv-parse'].includes(roots[0].kind)) fail('Start with Parse CSV or Normalize text.');
  const ordered = [], seen = new Set(); let next = roots[0];
  while (next) {
    if (seen.has(next.id)) fail('Workflow connections cannot contain a cycle.');
    seen.add(next.id); ordered.push(next); next = byId.get(outgoing.get(next.id));
  }
  if (ordered.length !== definition.nodes.length) fail('Connect every block into one path.');
  return ordered;
}
export function validateWorkflowCapabilities(definition, capabilities) {
  for (const node of definition.nodes) {
    const current = capabilities.find(c => c.kaRef === node.kaRef && c.sourceHash === node.sourceHash && (c.kind ?? 'text') === node.kind);
    if (!current || !current.available) { const error = new Error('A selected KA version is unavailable. Refresh the catalog and save a new workflow version.'); error.code = 'WORKFLOW_CAPABILITY_CHANGED'; error.status = 409; throw error; }
  }
}
export function workflowRunInput(definition, value) {
  const kind = orderedWorkflow(definition)[0].kind, field = kind === 'text' ? 'text' : 'csv';
  keys(value, [field]);
  if (typeof value[field] !== 'string' || !value[field].length || Buffer.byteLength(value[field]) > (field === 'csv' ? 2048 : 1024)) fail(`Supply ${field === 'csv' ? 'CSV up to 2 KiB' : 'text up to 1 KiB'}.`);
  return { [field]: value[field] };
}
export function workflowTableProblem(node, table) {
  if (node.kind === 'csv-map' && node.config.mapping.some(m => m.source >= table.columns.length)) return mappingError;
  if (node.kind === 'google-sheets-export' && table.columns.some((name, i) => !/^[A-Za-z][A-Za-z0-9 _.-]{0,63}$/.test(name) || ['constructor', 'prototype'].includes(name) || table.columns.indexOf(name) !== i)) return headersError;
  return null;
}
export function compileWorkflow(value, compilerVersion = 2) {
  if (![1, 2].includes(compilerVersion)) fail('Unsupported workflow compiler.');
  const definition = normalizeWorkflow(value), ordered = orderedWorkflow(definition);
  const revision = createHash('sha256').update(JSON.stringify(compilerVersion === 1 ? definition : { compilerVersion, definition })).digest('hex');
  const kaRef = `${WORKFLOW_PREFIX}${definition.id}:${revision.slice(0, 20)}`;
  const stepResults = length => ordered.slice(0, length).map((node, i) => `{ nodeId: ${JSON.stringify(node.id)}, kaRef: ${JSON.stringify(node.kaRef)}, result: r${i} }`).join(',\n    ');
  const calls = ordered.map((node, i) => {
    const previous = `r${i - 1}.output`;
    let input;
    if (!i) input = node.kind === 'text' ? '{ text: input.text }' : '{ csv: input.csv }';
    else if (node.kind === 'text') input = `{ text: ${previous}.text }`;
    else if (node.kind === 'csv-parse') input = `{ csv: ${previous}.text }`;
    else if (node.kind === 'csv-map') input = `{ columns: ${previous}.columns, rows: ${previous}.rows, mapping: ${JSON.stringify(node.config.mapping)} }`;
    else input = `{ columns: ${previous}.columns, rows: ${previous}.rows, title: ${JSON.stringify(node.config.title)} }`;
    const rejection = message => `{ kind: 'nos-ka-workflow-result', status: 'input-rejected', reason: 'invalid-input', rejectedNode: ${JSON.stringify(node.id)}, steps: [${stepResults(i)}], output: { ok: false, columns: [], rows: [], error: ${JSON.stringify(message)} } }`;
    const preflight = compilerVersion === 2 && i && node.kind === 'csv-map'
      ? `  if (${JSON.stringify(node.config.mapping)}.some(m => m.source >= ${previous}.columns.length)) return ${rejection(mappingError)};\n`
      : compilerVersion === 2 && i && node.kind === 'google-sheets-export'
        ? `  if (${previous}.columns.some((name, i) => !/^[A-Za-z][A-Za-z0-9 _.-]{0,63}$/.test(name) || ['constructor', 'prototype'].includes(name) || ${previous}.columns.indexOf(name) !== i)) return ${rejection(headersError)};\n` : '';
    return preflight + `  const r${i} = await invoke_program(${JSON.stringify(node.kaRef)}, [${input}]) as any;\n`
      + (['csv-parse', 'csv-map'].includes(node.kind) ? compilerVersion === 1
        ? `  if (!r${i}.output.ok) throw new Error(r${i}.output.error);\n`
        : `  if (!r${i}.output.ok) return { kind: 'nos-ka-workflow-result', status: 'input-rejected', reason: 'child-rejected', rejectedNode: ${JSON.stringify(node.id)}, steps: [${stepResults(i + 1)}], output: r${i}.output };\n` : '');
  });
  const source = `${markers[compilerVersion]}${Buffer.from(JSON.stringify(definition)).toString('base64url')}\n`
    + `import { invoke_program } from '@origintrail-official/dkg-graph-computer/program';\n`
    + `export async function run(input: { text?: string; csv?: string }) {\n${calls.join('')}`
    + `  return { kind: 'nos-ka-workflow-result', ${compilerVersion === 2 ? "status: 'completed', " : ''}steps: [${stepResults(ordered.length)}], output: r${ordered.length - 1}.output };\n}\n`;
  return { definition, revision, compilerVersion, kaRef, source, sourceHash: createHash('sha256').update(source).digest('hex'),
    name: `nos-workflow-${definition.id}-${revision.slice(0, 20)}`, ordered,
    requiresExportAuthorization: ordered.some(n => n.kind === 'google-sheets-export') };
}
export function readWorkflow(source) {
  const first = source.split('\n', 1)[0];
  const compilerVersion = [1, 2].find(version => first.startsWith(markers[version]));
  if (!compilerVersion || first.length > 32000) return null;
  try {
    const compiled = compileWorkflow(JSON.parse(Buffer.from(first.slice(markers[compilerVersion].length), 'base64url').toString('utf8')), compilerVersion);
    return compiled.source === source ? compiled : null;
  } catch { return null; }
}
