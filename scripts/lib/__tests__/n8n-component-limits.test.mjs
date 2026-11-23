import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { componentRegistry, component, normalizeComponentInput } from '../../../examples/n8n-capability/component-registry.mjs';
import { standaloneComponentWorkflow } from '../../../examples/n8n-capability/component-workflows.mjs';

const flow = id => standaloneComponentWorkflow(id, 'limits_' + id, { id: 'fixture', name: 'Fixture' }, { scopeName: 'Fixture scope' });
const input = (items, params = {}) => ({ itemsJson: JSON.stringify(items), paramsJson: JSON.stringify(params), executionId: '' });
const evaluate = (expression, nodes) => vm.runInNewContext(expression.slice(3, -2), {
  $: name => ({ first: () => ({ json: nodes[name] }) }),
}, { timeout: 1000 });
const prepare = (workflow, value) => evaluate(workflow.nodes.find(n => n.name === 'Prepare input').parameters.jsonOutput,
  { 'Receive input': { body: { input: value } } });

test('every callable component validates the whole batch before splitting or executing native actions', () => {
  for (const descriptor of componentRegistry.filter(c => c.mode !== 'schedule')) {
    const workflow = flow(descriptor.id), value = input(descriptor.sampleItems);
    const prepared = prepare(workflow, value);
    const normalized = normalizeComponentInput(descriptor, value);
    assert.equal(JSON.stringify(prepared.records), normalized.itemsJson, descriptor.id);
    assert.equal(JSON.stringify(prepared.params), normalized.paramsJson, descriptor.id);
    // Follow the actual graph from admission. Every path to a component action
    // must pass through the guard before even the first record is split out.
    const prefix = ['Receive input', 'Execution accepted', 'Fixture scope', 'Prepare input', 'Split input', 'Input items'];
    for (let i = 0; i < prefix.length - 1; i++)
      assert.deepEqual(workflow.connections[prefix[i]].main, [[{ node: prefix[i + 1], type: 'main', index: 0 }]], descriptor.id);
    assert.throws(() => prepare(workflow, input(Array(21).fill(descriptor.sampleItems[0]))), /twenty/, descriptor.id);
  }
});

test('100 files fit the wire schema but cannot reach the Google Drive action', () => {
  const workflow = flow('google-drive'), file = { file: { name: 'a', base64: 'YQ==' } };
  const oversized = input(Array(100).fill(file));
  assert.ok(oversized.itemsJson.length < 8192);
  assert.throws(() => prepare(workflow, oversized), /twenty/);
  const accepted = prepare(workflow, input(Array(20).fill(file)));
  assert.equal(accepted.records.length, 20);
  const upload = workflow.nodes.find(n => n.type === 'n8n-nodes-base.googleDrive');
  const name = evaluate(upload.parameters.name, { 'Prepare input': accepted });
  assert.equal(name, component('google-drive').parameters.name.default);
  const custom = prepare(workflow, input([file], { name: 'approved.txt' }));
  assert.equal(evaluate(upload.parameters.name, { 'Prepare input': custom }), 'approved.txt');
});

for (const [label, id, value, error] of [
  ['non-record items', 'limit', input([1]), /records/],
  ['malformed JSON', 'limit', { ...input([]), itemsJson: '{' }, /JSON|property/],
  ['reserved record fields', 'limit', input([{ __nosScope: 'forged' }]), /Reserved/],
  ['unknown parameters', 'google-drive', input(component('google-drive').sampleItems, { arbitrary: 1 }), /Unexpected/],
  ['out-of-range parameters', 'limit', input([{}], { count: 21 }), /Invalid/],
  ['invalid file payload', 'google-drive', input([{ file: { name: 'a', base64: 'invalid!' } }]), /small file/],
  ['invalid last file in a batch', 'google-drive', input([...Array(19).fill({ file: { name: 'a', base64: 'YQ==' } }), { file: { name: '../bad', base64: 'YQ==' } }]), /small file/],
  ['inconsistent Sheets columns', 'google-sheets', input([{ a: 1 }, { b: 2 }]), /consistent/],
  ['private HTTP destination', 'http-request', input([{}], { url: 'https://127.0.0.1/' }), /public|Private|HTTPS/],
  ['unsupported expression', 'edit-fields', input([{}], { fields: { stolen: '{{ $env.SECRET }}' } }), /expression|reference/],
]) test('native preparation rejects ' + label, () => assert.throws(() => prepare(flow(id), value), error));

test('native guard is part of the immutable workflow digest', async () => {
  const { n8nWorkflowSha256 } = await import('../../../packages/cli/dist/semantic-runtime-n8n-contract.js');
  const current = flow('google-drive'), unguarded = structuredClone(current);
  unguarded.nodes.find(n => n.name === 'Prepare input').parameters.jsonOutput = "={{ ({ records: JSON.parse($('Receive input').first().json.body.input.itemsJson) }) }}";
  assert.notEqual(n8nWorkflowSha256(current), n8nWorkflowSha256(unguarded));
  assert.equal(n8nWorkflowSha256(current), n8nWorkflowSha256(flow('google-drive')));
});
