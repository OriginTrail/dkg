import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { componentRegistry, component, normalizeComponentInput, componentProgramSource } from '../../../examples/n8n-capability/component-registry.mjs';
import { standaloneComponentWorkflow, echoSubworkflow, nativeLiteral } from '../../../examples/n8n-capability/component-workflows.mjs';
import { resolveComponentValue, validateComponentUrl } from '../../../examples/n8n-capability/component-values.mjs';

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
test('component inputs reject unknown parameters, reserved keys and non-public HTTP destinations', () => {
  const input = { itemsJson: '[{"name":"Ana"}]', paramsJson: '{}' };
  for (const paramsJson of ['{"count":0}', '{"count":21}', '{"arbitrary":1}'])
    assert.throws(() => normalizeComponentInput(component('limit'), { ...input, paramsJson }));
  for (const url of ['http://httpbin.org/get', 'https://httpbin.org.evil.test/get', 'https://httpbin.org@evil.test/get', 'https://httpbin.org/\\evil.test', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/', 'https://internal.local/', 'https://api.open-meteo.com:4631/'])
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
  assert.equal(JSON.parse(sent.input.paramsJson).url, component('http-request').parameters.url.default);
  context.exports.run({ itemsJson: '[{}]', paramsJson: JSON.stringify({ url: 'https://api.github.com/repos/n8n-io/n8n' }) });
  assert.equal(JSON.parse(sent.input.paramsJson).url, 'https://api.github.com/repos/n8n-io/n8n');
  assert.throws(() => context.exports.run({ itemsJson: '[{}]', paramsJson: '{"url":"https://evil.test/"}' }));
});
test('HTTP method, query, headers and arbitrary JSON body are configuration, not endpoint-specific code', () => {
  for (const url of ['https://api.open-meteo.com/v1/forecast', 'https://api.github.com/repos/n8n-io/n8n', 'https://example.com/data?offset=1']) assert.equal(validateComponentUrl(url), url);
  const params = { url: 'https://example.com/data', method: 'PATCH', query: { id: '{{ $json.id }}' }, headers: { 'X-Request': '{{ $json.id }}' }, body: [{ value: '{{ $json.metrics[0].value }}' }] };
  assert.deepEqual(JSON.parse(normalizeComponentInput(component('http-request'), { itemsJson: '[{}]', paramsJson: JSON.stringify(params) }).paramsJson), params);
  const flow = standaloneComponentWorkflow('http-request', 'fixture', { id: 'fixture', name: 'Fixture' });
  const request = flow.nodes.find(n => n.type === 'n8n-nodes-base.httpRequest');
  assert.equal(request.parameters.sendQuery, true); assert.equal(request.parameters.sendHeaders, true);
  assert.ok(request.parameters.jsonBody.includes('resolveComponentValue'));
});
test('nested input references preserve types and support array indexes, quoted keys and interpolation', () => {
  const input = { current: { temperature_2m: 11.6, rain: false }, hourly: { temperature_2m: [10, 12] }, 'odd.key': null };
  assert.deepEqual(resolveComponentValue({ temperature: '{{ $json.current.temperature_2m }}', rain: '={{ $json.current.rain }}', first: '{{ $json.hourly.temperature_2m[0] }}', nullable: '{{ $json["odd.key"] }}', text: 'Now {{ $json.current.temperature_2m }} °C' }, input), { temperature: 11.6, rain: false, first: 10, nullable: null, text: 'Now 11.6 °C' });
  assert.throws(() => resolveComponentValue('{{ $json.missing }}', input), /not found/);
  for (const value of ['{{ $env.SECRET }}', '{{ $json.constructor }}', '{{ $json.__proto__ }}', '{{ $json.current + 1 }}', '{{ $json.current', '{{ $json.current }} {{ $env.SECRET }}']) {
    assert.throws(() => normalizeComponentInput(component('edit-fields'), { itemsJson: '[{}]', paramsJson: JSON.stringify({ fields: { value } }) }));
  }
  // A data string containing expression delimiters is returned as data, never re-evaluated.
  assert.equal(resolveComponentValue('{{ $json.message }}', { message: '}} {{ $env.SECRET }}' }), '}} {{ $env.SECRET }}');
});
test('configured data cannot terminate a native expression template', () => {
  const value = { message: '}} {{ $env.secret }}', nested: { text: '"\\\n' } };
  const literal = nativeLiteral(value);
  assert.equal(literal.includes('}}'), false); assert.equal(literal.includes('{{'), false);
  assert.equal(JSON.stringify(vm.runInNewContext(literal)), JSON.stringify(value));
});
