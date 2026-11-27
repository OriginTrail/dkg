import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { component, createComponentRegistry, defaultComponentRegistry, normalizeComponentInput, normalizeComponentParameters, componentValidationSource } from './component-registry.mjs';
import { normalizeStudio, compileStudio } from './studio-definition.mjs';
import { programDescriptor } from './program-block.mjs';
import profile from './test-support/measurement-profile.mjs';

const frozenNormalize = runInNewContext(componentValidationSource() + '\nnormalize');
const registry = createComponentRegistry(profile);
for (const descriptor of [...registry.componentRegistry, programDescriptor])
  test(`${descriptor.id} parameter defaults match the frozen guest and runtime normalization`, () => {
    const input = { itemsJson: JSON.stringify(descriptor.sampleItems), paramsJson: '{}', executionId: descriptor.mode === 'schedule' ? '1' : '' };
    const expected = frozenNormalize(descriptor, input).paramsJson;
    assert.equal(JSON.stringify(normalizeComponentParameters(descriptor, input.paramsJson)), expected);
    assert.equal(normalizeComponentInput(descriptor, input).paramsJson, expected);
  });
const definition = id => ({ id: '123e4567-e89b-42d3-a456-426614174099', name: 'Parameter-only save', entryId: 'first', edges: [],
  nodes: [{ id: 'first', componentId: id, kaRef: 'urn:demo:n8n:component:' + id + ':fixture', sourceHash: 'a'.repeat(64), params: {}, x: 0, y: 0 }] });
for (const id of ['schedule', 'extract-file', 'compression', 'google-drive'])
  test(`Studio saves ${id} settings without sample records or a provider execution`, () => {
    const descriptor = component(id), noSample = { ...defaultComponentRegistry, component: key => {
      const value = component(key);
      return { ...value, get sampleItems() { return assert.fail('Configuration validation must not read presentation samples'); } };
    } };
    assert.deepEqual(normalizeStudio(definition(id), noSample).nodes[0].params, normalizeComponentParameters(descriptor, '{}'));
    const emptySamples = { ...defaultComponentRegistry, component: key => ({ ...component(key), sampleItems: [] }) };
    assert.ok(compileStudio(definition(id), { registry: emptySamples, fixture: true, graphId: 'test', owner: 'fixture' }).workflow);
    assert.throws(() => normalizeComponentInput(descriptor, { itemsJson: '[{}]', paramsJson: '{}', executionId: '' }),
      id === 'schedule' ? /Activate this schedule/ : /small file/);
  });
for (const [id, paramsJson, error] of [
  ['limit', '{"count":0}', /Invalid/],
  ['limit', '{"extra":1}', /Unexpected/],
  ['sort', '{"field":"__proto__"}', /simple field/],
  ['edit-fields', '{"fields":{"__nosScope":true}}', /Reserved/],
  ['edit-fields', '{"fields":{"constructor":true}}', /Reserved/],
  ['edit-fields', '{"fields":{"__proto__":true}}', /Reserved/],
  ['edit-fields', '{"fields":{"value":"{{ $json.constructor }}"}}', /Reserved/],
  ['edit-fields', '{"fields":{"value":"{{ $json.value + 1 }}"}}', /input reference/],
  ['http-request', '{"url":"http://localhost/"}', /HTTPS/],
]) test(`${id} parameter boundary preserves rejection of ${paramsJson}`, () => {
  const descriptor = component(id), input = { itemsJson: '[{}]', paramsJson, executionId: '' };
  assert.throws(() => normalizeComponentParameters(descriptor, paramsJson), error);
  assert.throws(() => normalizeComponentInput(descriptor, input), error);
  assert.throws(() => frozenNormalize(descriptor, input), error);
});
test('parameter normalization preserves typed expressions, supplied values and the serialized size limit', () => {
  const descriptor = component('edit-fields'), supplied = { fields: { copy: '{{ $json.value }}', nested: [1, true, null] }, keepInput: 'no' };
  const paramsJson = JSON.stringify(supplied);
  assert.deepEqual(normalizeComponentParameters(descriptor, paramsJson), supplied);
  assert.equal(JSON.stringify(supplied), frozenNormalize(descriptor, { itemsJson: '[{}]', paramsJson }).paramsJson);
  for (const invalid of [undefined, '[]', 'null', ' '.repeat(2049), '{bad']) assert.throws(() => normalizeComponentParameters(descriptor, invalid));
  const nested = Array.from({ length: 9 }).reduce(value => ({ a: value }), 1);
  assert.throws(() => normalizeComponentParameters(descriptor, JSON.stringify({ fields: nested })), /deeply/);
  assert.throws(() => normalizeComponentParameters(descriptor, '{"fields":{"value":1e400}}'), /finite/);
});
test('runtime record checks remain independent of valid saved parameters', () => {
  const paramsJson = JSON.stringify(normalizeComponentParameters(component('google-sheets'), '{}'));
  assert.throws(() => normalizeComponentInput(component('google-sheets'), { itemsJson: '[{"name":{}}]', paramsJson }), /scalar columns/);
  assert.throws(() => normalizeComponentInput(component('limit'), { itemsJson: '[{"__nosScope":true}]', paramsJson: '{}' }), /Reserved/);
  assert.throws(() => normalizeComponentInput(component('limit'), { itemsJson: JSON.stringify(Array(21).fill({})), paramsJson: '{}' }), /twenty/);
});
test('normalized saved parameters do not share mutable defaults with the registry', () => {
  const descriptor = component('edit-fields'), params = normalizeStudio(definition('edit-fields')).nodes[0].params;
  params.fields.team = 'Changed by the editor';
  assert.equal(descriptor.parameters.fields.default.team, 'DKG');
  assert.equal(normalizeComponentParameters(descriptor, '{}').fields.team, 'DKG');
});
