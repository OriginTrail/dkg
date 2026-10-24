import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { componentRegistry, component, normalizeComponentInput, componentProgramSource } from '../../../examples/n8n-capability/component-registry.mjs';
import { standaloneComponentWorkflow, echoSubworkflow, nativeLiteral } from '../../../examples/n8n-capability/component-workflows.mjs';

test('thirty native components have bounded descriptors and valid workflow result selectors', () => {
  assert.equal(componentRegistry.length, 30); assert.equal(new Set(componentRegistry.map(c => c.id)).size, 30);
  for (const c of componentRegistry) {
    normalizeComponentInput(c, { itemsJson: JSON.stringify(c.sampleItems), paramsJson: '{}', executionId: c.mode === 'schedule' ? '1' : '' });
    const flow = standaloneComponentWorkflow(c.id, 'fixture_' + c.id, { id: 'fixture', name: 'Fixture' });
    assert.ok(flow.nodes.every(n => Number.isFinite(n.typeVersion)), c.id);
    assert.ok(flow.nodes.some(n => n.name === flow.result.nodes[0]), c.id);
    assert.ok(!flow.nodes.some(n => n.type === 'n8n-nodes-base.code'), c.id);
    assert.ok(flow.nodes.some(n => n.type === c.nodeType), c.id);
  }
  assert.equal(echoSubworkflow().nodes[0].type, 'n8n-nodes-base.executeWorkflowTrigger');
});
test('component inputs reject unknown parameters, reserved keys and foreign HTTP destinations', () => {
  const input = { itemsJson: '[{"name":"Ana"}]', paramsJson: '{}' };
  for (const paramsJson of ['{"count":0}', '{"count":21}', '{"arbitrary":1}'])
    assert.throws(() => normalizeComponentInput(component('limit'), { ...input, paramsJson }));
  for (const url of ['http://httpbin.org/get', 'https://httpbin.org.evil.test/get', 'https://httpbin.org@evil.test/get', 'https://httpbin.org/\\evil.test', 'https://127.0.0.1/'])
    assert.throws(() => normalizeComponentInput(component('http-request'), { ...input, paramsJson: JSON.stringify({ url }) }));
  assert.throws(() => normalizeComponentInput(component('edit-fields'), { ...input, itemsJson: '[{"__proto__":{}}]' }));
  assert.throws(() => normalizeComponentInput(component('extract-file'), input));
});
test('the generated Program performs validation inside the guest before invoking n8n', () => {
  const require = createRequire(new URL('../../../package.json', import.meta.url)), ts = require('typescript');
  const source = ts.transpileModule(componentProgramSource('http-request'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  let sent;
  const context = { exports: {}, require: () => ({ invoke_tool: (tool, input) => { sent = { tool, input }; return input; } }) };
  vm.runInNewContext(source, context, { timeout: 1000 });
  context.exports.run({ itemsJson: '[{}]', paramsJson: '{}' });
  assert.equal(sent.tool, 'urn:dkg:tool:n8n');
  assert.equal(JSON.parse(sent.input.paramsJson).url, 'http://127.0.0.1:4631/spike/ka/demo-data');
  assert.throws(() => context.exports.run({ itemsJson: '[{}]', paramsJson: '{"url":"https://evil.test/"}' }));
});
test('configured data cannot terminate a native expression template', () => {
  const value = { message: '}} {{ $env.secret }}', nested: { text: '"\\\n' } };
  const literal = nativeLiteral(value);
  assert.equal(literal.includes('}}'), false); assert.equal(literal.includes('{{'), false);
  assert.equal(JSON.stringify(vm.runInNewContext(literal)), JSON.stringify(value));
});
