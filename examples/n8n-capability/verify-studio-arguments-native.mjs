/** Exercise emitted argument admission in n8n's actual expression engine, without services or credentials. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { compileStudio } from './studio-definition.mjs';
import { definition, graphId, owner } from './test-support/studio-service-fixture.mjs';

assert.ok(process.argv[2], 'Supply the installed n8n package directory (2.43.8).');
const pkg = resolve(process.argv[2]);
const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
assert.equal(version, '2.43.8');
const { Expression } = createRequire(join(pkg, 'package.json'))('n8n-workflow');
const engine = new Expression('UTC');
const graph = definition(['limit', 'edit-fields'], [[0, 0, 1, 0]]);
graph.inputs = [
  { name: 'count', label: 'Count', required: false,
    spec: { type: 'integer', label: 'Count', default: 2, min: 1, max: 2 },
    targets: [{ nodeId: 'n0', parameter: 'count' }] },
  { name: 'status', label: 'Status', required: true,
    spec: { type: 'string', label: 'Status', default: '', maxLength: 40 },
    targets: [{ nodeId: 'n1', parameter: 'status', kind: 'input' }] },
];
const compiled = compileStudio(graph, { fixture: true, graphId, owner });
const node = name => compiled.workflow.nodes.find(n => n.name === name);
let admitted, packet, effects = 0;
const evaluate = value => engine.resolveSimpleParameterValue(value, {
  $json: { original: true }, $input: { all: () => [{ json: { original: true } }] },
  $: name => {
    if (name === 'Receive input') return { first: () => ({ json: { body: { input: packet } } }) };
    assert.equal(name, 'Admit arguments');
    return { first: () => ({ json: admitted }) };
  },
});
for (const args of [{ status: 'approved' }, { status: 'rejected', count: 1 }]) {
  packet = { argumentsJson: JSON.stringify(args) };
  admitted = evaluate(node('Admit arguments').parameters.jsonOutput);
  assert.deepEqual(admitted.values, { count: args.count ?? 2, status: args.status });
  assert.deepEqual(evaluate(node('Block n0 check 0').parameters.jsonOutput), { original: true });
  assert.equal(evaluate(node('Block n0').parameters.maxItems), args.count ?? 2);
  assert.deepEqual(evaluate(node('Block n1 check 0').parameters.jsonOutput), { original: true, status: args.status });
  effects++;
}
for (const args of [{ count: 1 }, { status: 'approved', count: 10 },
  { status: 'approved', extra: true }, { status: '{{ $env.SECRET }}' }]) {
  packet = { argumentsJson: JSON.stringify(args) };
  // Tournament reports user-expression failures as undefined. Set's raw JSON mode
  // then fails the node, as also checked by the live HTTP workflow smoke.
  admitted = evaluate(node('Admit arguments').parameters.jsonOutput);
  assert.equal(admitted, undefined);
}
assert.equal(effects, 2);
console.log(JSON.stringify({ n8nVersion: version, compiler: compiled.compiler, valid: 2, rejectedBeforeComponents: 4 }));
