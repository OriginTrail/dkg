import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeStudio } from './studio-definition.mjs';
import { normalizeStudio as normalizeLegacy } from './studio-definition-v1.mjs';
import { component } from './component-registry.mjs';
import { component as legacyComponent } from './component-registry-v1.mjs';
import { definition } from './test-support/studio-service-fixture.mjs';

for (const [version, normalize, descriptor] of [['current', normalizeStudio, component], ['historical', normalizeLegacy, legacyComponent]]) {
  const graph = (ids, edges) => {
    const value = definition(ids, edges);
    for (const node of value.nodes) node.params = Object.fromEntries(Object.entries(descriptor(node.componentId).parameters).map(([key, value]) => [key, value.default]));
    return value;
  };
  test(`${version} topology canonicalizes a loop without mutating its saved graph`, () => {
    const value = graph(['loop-items', 'edit-fields', 'aggregate'], [[0,1,1,0], [1,0,0,0], [0,0,2,0]]);
    value.nodes.reverse(); value.edges.reverse();
    const original = structuredClone(value), result = normalize(value);
    assert.deepEqual(value, original);
    assert.deepEqual(result.nodes.map(n => n.id), ['n0', 'n1', 'n2']);
    assert.deepEqual(result.edges, [
      { from: 'n0', output: 0, to: 'n2', input: 0 },
      { from: 'n0', output: 1, to: 'n1', input: 0 },
      { from: 'n1', output: 0, to: 'n0', input: 0 },
    ]);
  });
  for (const [name, nodes, edges, message] of [
    ['ordinary cycle', ['edit-fields', 'limit'], [[0,0,1,0], [1,0,0,0]], /cycle/],
    ['missing loop return', ['loop-items', 'edit-fields'], [[0,1,1,0]], /back/],
    ['missing join input', ['edit-fields', 'merge'], [[0,0,1,0]], /both inputs/],
    ['incompatible file port', ['edit-fields', 'extract-file'], [[0,0,1,0]], /file output/],
    ['downstream trigger', ['edit-fields', 'schedule'], [[0,0,1,0]], /event trigger/],
    ['disconnected block', ['edit-fields', 'limit'], [], /Connect every block/],
  ]) test(`${version} topology rejects ${name}`, () => assert.throws(() => normalize(graph(nodes, edges)), message));
}

test('topology sharing retains each compiler revision node limit and metadata schema', () => {
  const value = definition(Array(9).fill('edit-fields'), Array.from({ length: 8 }, (_, i) => [i,0,i+1,0]));
  assert.equal(normalizeStudio(value).nodes.length, 9);
  assert.throws(() => normalizeLegacy(value), /one and eight/);
  const labeled = definition(['edit-fields'], []); labeled.nodes[0].label = 'Named step';
  assert.equal(normalizeStudio(labeled).nodes[0].label, 'Named step');
  assert.throws(() => normalizeLegacy(labeled), /Unexpected workflow fields/);
});
