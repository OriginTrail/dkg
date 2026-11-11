import test from 'node:test';
import assert from 'node:assert/strict';
import { compileStudio } from './studio-definition.mjs';
import { normalizeStudioArguments } from '../../packages/studio-contracts/dist/studio-inputs.js';
import { definition, graphId, owner } from './test-support/studio-service-fixture.mjs';
import { nativeExpression } from './test-support/studio-native-expression.mjs';
import { component } from './component-registry.mjs';
import { workflowInvocationInput } from './studio-inputs.mjs';
import { studioProgramSource } from './studio-definition.mjs';
import { programAdmission } from './test-support/studio-program-vm.mjs';

test('direct native dispatch enforces the complete declared interface before any component', () => {
  const graph = definition(['limit', 'edit-fields'], [[0, 0, 1, 0]]);
  graph.inputs = [
    { name: 'count', label: 'Count', required: false,
      spec: { type: 'integer', label: 'Count', default: 2, min: 1, max: 2 },
      targets: [{ nodeId: 'n0', parameter: 'count' }] },
    { name: 'status', label: 'Status', required: true,
      spec: { type: 'string', label: 'Status', default: '', options: ['approved', 'rejected'], maxLength: 20 },
      targets: [{ nodeId: 'n1', parameter: 'status', kind: 'input' }] },
    { name: 'fields', label: 'Fields', required: false,
      spec: { type: 'json', label: 'Fields', default: {}, maxLength: 2048 },
      targets: [{ nodeId: 'n1', parameter: 'fields' }] },
  ];
  const compiled = compileStudio(graph, { fixture: true, graphId, owner });
  assert.equal(compiled.compiler, 9);
  const admission = compiled.workflow.nodes.find(n => n.name === 'Admit arguments');
  const next = name => compiled.workflow.connections[name].main[0].map(edge => edge.node);
  assert.deepEqual(next('Execution accepted'), [compiled.workflow.nodes.find(n => n.name.startsWith('nOS scope ')).name]);
  assert.deepEqual(next(next('Execution accepted')[0]), [admission.name]);
  assert.deepEqual(next(admission.name), ['Prepare input']);
  let dispatches = 0;
  const dispatch = argumentsJson => {
    const packet = { argumentsJson };
    const admitted = nativeExpression(compiled, admission.parameters.jsonOutput, packet).result;
    dispatches++;
    return { packet, admitted };
  };
  for (const args of [{ status: 'approved' }, { fields: { city: 'Belgrade' }, count: 1, status: 'rejected' }]) {
    const { packet, admitted } = dispatch(JSON.stringify(args));
    assert.deepEqual(admitted.values, normalizeStudioArguments(graph.inputs, args));
    const limit = compiled.workflow.nodes.find(n => n.name === 'Block n0');
    assert.equal(nativeExpression(compiled, limit.parameters.maxItems, packet).result, args.count ?? 2);
  }
  for (const args of [{}, { status: 'unknown' }, { status: 'approved', count: 10 },
    { status: 'approved', count: 1.5 }, { status: 'approved', extra: true },
    { status: 'approved', fields: { nested: '{{ $env.SECRET }}' } },
    { status: 'approved', fields: JSON.parse('{"constructor":1}') },
    { status: 'approved', fields: { value: 'x'.repeat(2048) } }]) {
    assert.throws(() => normalizeStudioArguments(graph.inputs, args));
    assert.throws(() => dispatch(JSON.stringify(args)));
  }
  for (const raw of [undefined, 'null', '[]', '{', ' '.repeat(8193)]) assert.throws(() => dispatch(raw));
  assert.equal(dispatches, 2, 'No block runs for malformed or out-of-contract direct tool input');
});

test('invalid downstream native parameters cannot pass admission before an earlier write', () => {
  const graph = definition(['google-sheets', 'http-request'], [[0, 0, 1, 0]]);
  graph.inputs = [{ name: 'url', label: 'URL', required: false,
    spec: { ...component('http-request').parameters.url, default: 'https://api.github.com' },
    targets: [{ nodeId: 'n1', parameter: 'url' }] }];
  const compiled = compileStudio(graph, { fixture: true, graphId, owner });
  const gate = compiled.workflow.nodes.find(n => n.name === 'Admit arguments');
  const guest = programAdmission(studioProgramSource(compiled));
  const raw = { itemsJson: '[{"name":"Ana"}]', paramsJson: JSON.stringify(graph.nodes[0].params), executionId: '' };
  let writes = 0;
  const nativeDispatch = args => {
    const packet = { ...raw, argumentsJson: JSON.stringify(args) };
    const admitted = nativeExpression(compiled, gate.parameters.jsonOutput, packet).result;
    writes++; // The Google Sheets entry is downstream of this mandatory gate.
    return admitted;
  };
  for (const url of ['http://127.0.0.1:4631/internal', 'https://internal.local', '   ', 'https://user:password@api.github.com']) {
    assert.throws(() => workflowInvocationInput(compiled, { url }, raw, component('google-sheets')));
    assert.throws(() => guest.run({ ...raw, argumentsJson: JSON.stringify({ url }) }));
    assert.throws(() => nativeDispatch({ url }));
  }
  assert.equal(writes, 0);
  assert.equal(guest.calls.length, 0);
  for (const args of [{}, { url: 'https://api.github.com/zen' }]) {
    const admitted = workflowInvocationInput(compiled, args, raw, component('google-sheets'));
    assert.deepEqual(JSON.parse(JSON.stringify(guest.run(admitted))), admitted);
    assert.equal(nativeDispatch(args).values.url, args.url ?? 'https://api.github.com');
  }
  assert.equal(writes, 2);
});
