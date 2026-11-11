import test from 'node:test';
import assert from 'node:assert/strict';
import { compileStudio, normalizeStudio, readStudio, studioProgramSource } from './studio-definition.mjs';
const definition = {
  id: '123e4567-e89b-42d3-a456-426614174099', name: 'Named workflow', entryId: 'a',
  nodes: ['a', 'b'].map((id, i) => ({ id, componentId: 'edit-fields', kaRef: 'urn:demo:n8n:component:edit-fields:unit', sourceHash: 'a'.repeat(64), params: { fields: { key: 'value' }, keepInput: 'yes' }, x: i * 320, y: 100 })),
  edges: [{ from: 'a', to: 'b', output: 0, input: 0 }],
};
const options = { graphId: 'g', owner: 'a', fixture: true, providerId: 'fixed-native-id' };
test('names and visual groups roundtrip in source without changing native execution', () => {
  const old = compileStudio(definition, options);
  assert.deepEqual(readStudio(studioProgramSource(old)).definition, normalizeStudio(definition));
  const named = structuredClone(definition);
  named.nodes[0].label = 'Izdvoji ERP zapise'; named.nodes[0].groupId = 'jpb';
  named.groups = [{ id: 'jpb', name: 'JPB podaci', tone: 'teal' }];
  const compiled = compileStudio(named, options);
  assert.deepEqual(readStudio(studioProgramSource(compiled)).definition, normalizeStudio(named));
  assert.deepEqual(compiled.workflow.nodes, old.workflow.nodes);
  assert.deepEqual(compiled.workflow.connections, old.workflow.connections);
  assert.deepEqual(compiled.grant, old.grant);
  assert.notEqual(compiled.kaRef, old.kaRef); // A saved presentation revision remains immutable.
  assert.equal(compiled.mode, old.mode);
  assert.equal(compiled.requiresExportAuthorization, old.requiresExportAuthorization);
});
test('metadata rejects oversized names, unknown groups, duplicate groups and execution fields', () => {
  for (const variant of [
    { ...definition, nodes: definition.nodes.map(n => ({ ...n, label: ' '.repeat(3) })) },
    { ...definition, nodes: definition.nodes.map(n => ({ ...n, label: 'x'.repeat(81) })) },
    { ...definition, nodes: definition.nodes.map(n => ({ ...n, groupId: 'foreign' })) },
    { ...definition, groups: [{ id: 'jpb', name: 'JPB', tone: 'teal', execute: true }] },
    { ...definition, groups: [{ id: 'jpb', name: 'JPB', tone: 'unknown' }] },
    { ...definition, groups: Array(2).fill({ id: 'jpb', name: 'JPB', tone: 'teal' }) },
  ]) assert.throws(() => normalizeStudio(variant));
});
