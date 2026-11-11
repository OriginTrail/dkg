import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { compileStudio, readStudio, studioProgramSource } from './studio-definition.mjs';
import { environment, definition, graphId, owner } from './test-support/studio-service-fixture.mjs';
import { expandStudioComponents } from '../../packages/studio-contracts/dist/studio-composition.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { nativeExpression } from './test-support/studio-native-expression.mjs';
import { namedMcpInput } from './studio-inputs.mjs';

for (const revision of ['compiler6-file', 'compiler7-data', 'compiler8-data']) test(`${revision} snapshots retain their original source, KA and native pins`, () => {
  const { compiled, sourceHash } = JSON.parse(readFileSync(new URL(`./test-support/${revision}-snapshot.json`, import.meta.url)));
  const source = studioProgramSource(compiled);
  assert.equal(createHash('sha256').update(source).digest('hex'), sourceHash);
  assert.deepEqual(readStudio(source), compiled);
});

const file = { name: 'values.csv', base64: Buffer.from('name,value\nA,1\n').toString('base64') };
const nextFile = { name: 'other.csv', base64: Buffer.from('name,value\nB,2\n').toString('base64') };
const fileInput = { name: 'file', label: 'File', required: true,
  spec: { type: 'json', label: 'File', default: {}, maxLength: 7000 },
  targets: [{ nodeId: 'n0', parameter: 'file', kind: 'input' }] };
const graph = () => ({ ...definition(['extract-file'], []), inputs: [fileInput] });
const plain = value => JSON.parse(JSON.stringify(value));
function program(source) {
  const js = ts.transpileModule(source.replace("import { invoke_tool } from '@origintrail-official/dkg-graph-computer/program';", ''),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls = [], context = { exports: {}, invoke_tool: (_tool, value) => { calls.push(plain(value)); return value; } };
  runInNewContext(js, context);
  return { run: context.exports.run, calls };
}
function nativeGuard(compiled, packet, row = {}) {
  const guard = compiled.workflow.nodes.find(node => node.name === `Block ${compiled.definition.entryId} check 0`);
  return nativeExpression(compiled, guard.parameters.jsonOutput, packet, row).result;
}
for (const mode of ['named', 'fixed', 'composed-fixed']) test(`${mode} entry file binding survives save/reopen and validates before dispatch`, async () => {
  const f = environment();
  try {
    let body = graph();
    if (mode === 'fixed') { delete body.inputs; body.nodes[0].inputValues = { file }; }
    if (mode === 'composed-fixed') {
      const recipe = { schemaVersion: 1, name: 'Extract CSV', workflow: { kaRef: 'urn:demo:nos:studio:template', sourceHash: 'b'.repeat(64) },
        definition: body, inputs: body.inputs, outputs: [{ name: 'rows', nodeId: 'n0', output: 0 }] };
      const hash = createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
      const entry = { kaRef: 'urn:nos:component:workflow:' + hash, sourceHash: hash, recipe };
      const authored = { ...body, inputs: [], nodes: [{ ...body.nodes[0], componentId: 'workflow-component',
        kaRef: entry.kaRef, sourceHash: hash, params: { file } }] };
      body = { ...expandStudioComponents(authored, [entry]).definition, composition: { definition: authored, components: [entry] } };
    }
    const saved = await f.service.save(body), source = f.sources.get(saved.kaRef).source;
    const compiled = readStudio(source), emitted = compileStudio(body, { fixture: true, graphId, owner });
    assert.equal(compiled.compiler, 9);
    f.restart();
    assert.deepEqual((await f.service.get(saved.kaRef, saved.sourceHash)).workflow, saved);
    const guest = program(source);
    for (const [index, selected] of [file, nextFile].entries()) {
      const argumentsValue = mode === 'named' ? { file: selected } : mode === 'composed-fixed' ? {} : undefined;
      await f.service.run({ kaRef: saved.kaRef, sourceHash: saved.sourceHash, itemsJson: '[{}]',
        invocationId: `123e4567-e89b-42d3-a456-42661417400${index}`, ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }) });
      const packet = f.invocations.at(-1).inputs[0];
      assert.equal(packet.itemsJson, '[{}]', 'journal retains original rows; binding occurs in the native guard');
      if (mode === 'named') assert.deepEqual(namedMcpInput({ arguments: argumentsValue }, compiled), packet);
      assert.deepEqual(plain(guest.run(packet)), packet);
      assert.deepEqual(nativeGuard(emitted, packet), { file: mode === 'named' ? selected : file });
      assert.equal(f.sources.get(saved.kaRef).source, source);
      assert.equal(readStudio(source).grant.workflowSha256, compiled.grant.workflowSha256);
    }
    const before = f.invocations.length, effects = guest.calls.length, packet = f.invocations[0].inputs[0];
    for (const itemsJson of ['{}', '[null]', JSON.stringify(Array(21).fill({})), '[{"__nosReserved":1}]']) {
      await assert.rejects(f.service.run({ kaRef: saved.kaRef, sourceHash: saved.sourceHash, itemsJson,
        invocationId: '123e4567-e89b-42d3-a456-426614174009', ...(body.inputs ? { arguments: mode === 'named' ? { file } : {} } : {}) }));
      assert.throws(() => guest.run({ ...packet, itemsJson }));
    }
    if (mode === 'named') for (const badFile of [{}, { ...file, base64: '!' }, { ...file, name: '../bad.csv' }]) {
      await assert.rejects(f.service.run({ kaRef: saved.kaRef, sourceHash: saved.sourceHash, itemsJson: '[{}]',
        invocationId: '123e4567-e89b-42d3-a456-426614174009', arguments: { file: badFile } }), /file/);
      assert.throws(() => guest.run({ ...packet, argumentsJson: JSON.stringify({ file: badFile }) }), /file/);
      assert.throws(() => namedMcpInput({ arguments: { file: badFile } }, compiled), /file/);
    }
    assert.equal(f.invocations.length, before);
    assert.equal(guest.calls.length, effects);
    for (const patch of [{ paramsJson: '[]' }, { paramsJson: '{"constructor":1}' },
      { paramsJson: ' '.repeat(2049) }, { executionId: 'invalid' }, { extra: true }])
      assert.throws(() => guest.run({ ...packet, ...patch }));
    assert.equal(guest.calls.length, effects, 'Malformed raw envelopes cannot dispatch');
  } finally { f.close(); }
});

test('invalid fixed file is rejected by host and generated Program before any provider invocation', async () => {
  const f = environment();
  try {
    const body = definition(['extract-file'], []); body.nodes[0].inputValues = { file: { ...file, base64: '!' } };
    const saved = await f.service.save(body), source = f.sources.get(saved.kaRef).source;
    const guest = program(source);
    const packet = { itemsJson: '[{}]', paramsJson: JSON.stringify(body.nodes[0].params), executionId: '' };
    await assert.rejects(f.service.run({ kaRef: saved.kaRef, sourceHash: saved.sourceHash, itemsJson: '[{}]',
      invocationId: '123e4567-e89b-42d3-a456-426614174009' }), /file/);
    assert.throws(() => guest.run(packet), /file/);
    assert.equal(f.invocations.length, 0); assert.equal(guest.calls.length, 0);
  } finally { f.close(); }
});
