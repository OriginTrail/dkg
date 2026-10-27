import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { TypeScriptProgramHost } from '../../packages/semantic-runtime/dist/index.js';
import { component, normalizeComponentInput } from './component-registry.mjs';
import { resolveComponentValue } from './component-values.mjs';
import { compileStudio, readStudio, studioProgramSource, normalizeStudio, validateStudioCapabilities } from './studio-definition.mjs';
import { programWorkflowReceipt } from './program-workflow-receipt.mjs';
import { createProgramCatalog } from './program-catalog.mjs';
import { programRecords } from './program-block.mjs';
import { createStudioProvider } from './studio-provider.mjs';
import { createStudioService } from './studio-service.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const host = new TypeScriptProgramHost();
after(() => host.stop());
const sha = text => createHash('sha256').update(text).digest('hex');
const program = { id: 'program', componentId: 'run-program', kaRef: 'urn:test:scale:1.0.0', sourceHash: 'b'.repeat(64),
  params: { operationIri: 'urn:test:scale-op:1', version: '1.0.0', inputMode: 'each-item', inputMapping: { value: '{{ $json.value }}', factor: 3 } }, x: 300, y: 80 };
const native = (id, fields) => ({ id, componentId: 'edit-fields', kaRef: 'urn:demo:n8n:component:edit-fields:test', sourceHash: 'a'.repeat(64),
  params: { fields, keepInput: 'no' }, x: id === 'before' ? 40 : 560, y: 80 });
const graph = (nodes = [native('before', { value: '{{ $json.incoming.number }}' }), program, native('after', { answer: '{{ $json.result }}' })]) => ({
  id: '123e4567-e89b-42d3-a456-426614174099', name: 'Program between native steps', entryId: nodes[0].id, nodes,
  edges: nodes.slice(0, -1).map((n, i) => ({ from: n.id, output: 0, to: nodes[i + 1].id, input: 0 })),
});
const inputFor = (compiled, items) => ({ itemsJson: JSON.stringify(items), paramsJson: JSON.stringify(compiled.ordered[0].params), executionId: '' });
async function execute(definition, items, programFn = input => ({ result: input.value * input.factor })) {
  const compiled = compileStudio(definition), source = studioProgramSource(compiled), stores = new Map(), calls = [];
  const input = inputFor(compiled, items), artifact = await host.compile(source);
  const output = await host.execute(artifact, JSON.stringify([input]), { children: [], maxCalls: 256, maxConcurrency: 1, timeoutMs: 30000 }, async effect => {
    const node = compiled.ordered.find(n => n.kaRef === effect.program);
    let value;
    if (node.componentId === 'run-program') value = programFn(effect.args[0]);
    else {
      const v = normalizeComponentInput(component(node.componentId), effect.args[0]);
      const params = JSON.parse(v.paramsJson), rows = JSON.parse(v.itemsJson).map(item => resolveComponentValue(params.fields, item));
      value = { kind: 'n8n-result', n8nExecutionId: String(100 + calls.length), workflowSha256: 'c'.repeat(64),
        output: { ok: true, itemsJson: JSON.stringify(rows), portsJson: '{}', error: '' } };
    }
    const executionIri = 'urn:sr:execution:' + randomUUID();
    stores.set(executionIri, [JSON.stringify(value)]);
    calls.push({ kind: 'program', target: effect.program, status: 'succeeded', executionIri, args: effect.args });
    return value;
  });
  const result = { outputs: [JSON.parse(output)], rawOutputs: [output], trace: { calls } };
  const receipt = await programWorkflowReceipt(compiled, result, input, async iri => stores.get(iri));
  return { compiled, result, receipt, stores, calls, input };
}

test('maps native data into a Program and its result into the following native block, with child receipt readback', async () => {
  const proof = await execute(graph(), [{ incoming: { number: 7 } }, { incoming: { number: 4 } }]);
  assert.deepEqual(JSON.parse(proof.receipt.output.itemsJson), [{ answer: 21 }, { answer: 12 }]);
  assert.deepEqual(proof.calls.filter(c => c.target === program.kaRef).map(c => c.args), [[{ value: 7, factor: 3 }], [{ value: 4, factor: 3 }]]);
  assert.equal(proof.receipt.executor, 'dkg');
  assert.equal(proof.receipt.steps.find(s => s.nodeId === 'program').executionIris.length, 2);
  assert.deepEqual(readStudio(studioProgramSource(proof.compiled)).definition, proof.compiled.definition);
});

test('runs all-items mode once and preserves typed array input', async () => {
  const selected = structuredClone(program);
  selected.params.inputMode = 'all-items'; selected.params.inputMapping = { records: '{{ $json }}' };
  const proof = await execute(graph([selected]), [{ value: 1 }, { value: 2 }], input => ({ count: input.records.length }));
  assert.equal(proof.calls.length, 1);
  assert.deepEqual(JSON.parse(proof.receipt.output.itemsJson), [{ count: 2 }]);
  const empty = await execute(graph([selected]), [], input => ({ count: input.records.length }));
  assert.equal(empty.calls.length, 1);
  assert.deepEqual(JSON.parse(empty.receipt.output.itemsJson), [{ count: 0 }]);
});

test('passes through data and wraps scalar Program output for downstream mapping', async () => {
  const selected = structuredClone(program); selected.params.inputMapping = '{{ $json }}';
  const proof = await execute(graph([selected, native('after', { answer: '{{ $json.value }}' })]), [{ value: 5 }], input => input.value * 2);
  assert.deepEqual(JSON.parse(proof.receipt.output.itemsJson), [{ answer: 10 }]);
});

test('retains empty branches as skipped steps without any child dispatch', async () => {
  const proof = await execute(graph(), []);
  assert.equal(proof.calls.length, 0);
  assert.ok(proof.receipt.steps.every(s => s.status === 'skipped' && s.executionIris.length === 0));
});

test('rejects invalid or oversized Program output before a downstream call', async () => {
  assert.throws(() => programRecords({ constructor: 'forbidden' }), /Reserved/);
  assert.throws(() => programRecords(Array.from({ length: 21 }, () => ({}))), /twenty/);
  assert.throws(() => programRecords({ text: 'x'.repeat(8193) }), /8 KiB/);
  await assert.rejects(execute(graph([program, native('after', { answer: '{{ $json.result }}' })]), [{ value: 1 }], () => ({ constructor: 'forbidden' })), /Reserved/);
});

test('prevalidates every mapped input of a block and forbids expression evaluation', async () => {
  const selected = structuredClone(program);
  selected.params.inputMapping = '{{ $json.constructor }}';
  assert.throws(() => normalizeStudio(graph([selected])), /Reserved/);
  selected.params.inputMapping = '{{ process.env.SECRET }}';
  assert.throws(() => normalizeStudio(graph([selected])), /input reference/);
  await assert.rejects(execute(graph([program]), [{ value: 2 }, { other: 3 }]), /Input field not found/);
});

test('pins program version, source and approved operation separately', () => {
  const selected = compileStudio(graph([program]));
  const cap = { kind: 'program', kaRef: program.kaRef, sourceHash: program.sourceHash, descriptor: component('run-program'),
    version: program.params.version, operationIri: program.params.operationIri, available: true };
  validateStudioCapabilities(selected.definition, [cap]);
  for (const patch of [{ version: '2.0.0' }, { sourceHash: 'f'.repeat(64) }, { operationIri: 'urn:foreign:operation' }, { available: false }])
    assert.throws(() => validateStudioCapabilities(selected.definition, [{ ...cap, ...patch }]), /unavailable/);
  const changed = structuredClone(program); changed.params.version = '2.0.0';
  assert.notEqual(compileStudio(graph([changed])).kaRef, selected.kaRef);
  assert.throws(() => readStudio(studioProgramSource(selected) + '\n// changed'), /differs/);
});

test('rejects unsupported mixed branches while preserving the native compiler for ordinary graphs', () => {
  const branch = { ...native('branch', {}), componentId: 'if', params: { field: 'value', equals: 'yes' } };
  assert.throws(() => compileStudio(graph([branch, program])), /linear/);
  const original = compileStudio(graph([native('before', { value: 1 }), native('after', { value: '{{ $json.value }}' })]), { fixture: true, graphId: 'test', owner: '0x1111111111111111111111111111111111111111' });
  assert.ok(original.workflow.nodes.some(n => n.type === 'n8n-nodes-base.webhook'));
  assert.equal(original.executor, undefined);
});

test('rejects forged persisted child output and extra child calls', async () => {
  const proof = await execute(graph([program]), [{ value: 7 }]);
  await assert.rejects(programWorkflowReceipt(proof.compiled, proof.result, proof.input, async () => ['{"forged":true}']), /readback differs/);
  proof.result.trace.calls.push({ ...proof.result.trace.calls[0] });
  await assert.rejects(programWorkflowReceipt(proof.compiled, proof.result, proof.input, async iri => proof.stores.get(iri)), /differs/);
});

test('catalog exposes only enabled, source-matching, caller-approved local Programs and propagates export protection', async () => {
  const owner = '0x1111111111111111111111111111111111111111', graphId = 'program-test';
  const source = { programIri: 'urn:test:program:1', source: 'export function run(x) { return x; }', version: '1.0.0', label: 'My program', authorAgentAddress: owner, language: 'typescript-v1' };
  source.sourceHash = sha(source.source);
  const binding = { contextGraphId: graphId, operationIri: 'urn:test:operation', executorAgentAddress: owner, enabled: true,
    allowedCallerAgentAddresses: [owner], program: { contextGraphId: graphId, programIri: source.programIri, programLayer: 'wm', authorAgentAddress: owner, sourceHash: source.sourceHash }, typescript: { children: [] } };
  let current = structuredClone(binding);
  const list = createProgramCatalog({ graphId, owner, definitions: [], client: { programs: {
    listApprovals: async () => [{ operationIri: current.operationIri, binding: current }], getSource: async () => source,
  } } });
  assert.equal((await list())[0].operationIri, binding.operationIri);
  for (const patch of [{ enabled: false }, { allowedCallerAgentAddresses: [] }, { executorAgentAddress: '0x2222' }, { program: { ...binding.program, sourceHash: 'f'.repeat(64) } }]) {
    current = { ...binding, ...patch }; assert.equal((await list()).length, 0);
  }
  current = { ...binding, n8n: { workflowId: 'external-side-effect' } };
  assert.equal((await list())[0].requiresExportAuthorization, true);
});

test('Studio service saves a pinned mixed revision and reads its persisted parent and child results', async () => {
  const state = mkdtempSync(join(tmpdir(), 'studio-program-test-'));
  const graphId = 'program-test', owner = '0x1111111111111111111111111111111111111111';
  const sources = new Map(), approvals = new Map(), receipts = new Map(), uploads = [];
  let dispatches = 0;
  let cap = { kind: 'program', kaRef: program.kaRef, sourceHash: program.sourceHash, descriptor: component('run-program'),
    version: program.params.version, operationIri: program.params.operationIri, available: true };
  const missing = () => Object.assign(new Error('Missing'), { code: 'PROGRAM_NOT_FOUND', status: 404 });
  const client = { programs: {
    getSource: async ref => { if (!sources.has(ref.programIri)) throw missing(); return sources.get(ref.programIri); },
    getApproval: async ref => { if (!approvals.has(ref.operationIri)) throw missing(); return approvals.get(ref.operationIri); },
    upload: async value => {
      uploads.push(value);
      const source = { ...value, sourceHash: sha(value.source), authorAgentAddress: owner };
      sources.set(value.programIri, source); return source;
    },
    approve: async value => { const result = { binding: { enabled: true, program: value.program }, request: value }; approvals.set(value.operationIri, result); return result; },
    invoke: async value => {
      dispatches++;
      const compiled = readStudio(sources.get(value.operationIri).source);
      const proof = await execute(compiled.definition, JSON.parse(value.inputs[0].itemsJson));
      for (const entry of proof.stores) receipts.set(...entry);
      const executionIri = 'urn:sr:execution:' + value.invocationId;
      receipts.set(executionIri, proof.result.rawOutputs);
      return { ...proof.result, executionIri };
    },
  } };
  const provider = createStudioProvider({ state, config: { n8nNative: { workflows: [] } }, graphId, owner,
    fetchImpl: async () => { throw new Error('Mixed workflows must not provision an n8n graph.'); } });
  const service = createStudioService({ graphId, owner, client, provider, listCapabilities: async () => [cap], loadOutputs: async iri => receipts.get(iri) });
  try {
    const saved = await service.save(graph([program]), () => { throw new Error('A pure Program does not need Google authorization.'); });
    assert.equal(saved.approved, true);
    assert.deepEqual(uploads[0].requiredTools, []);
    assert.deepEqual(approvals.get(saved.kaRef).request.typescript.children, [{ graphId, operationIri: program.params.operationIri }]);
    assert.equal(approvals.get(saved.kaRef).request.n8n, undefined);
    const request = { kaRef: saved.kaRef, sourceHash: saved.sourceHash, invocationId: randomUUID(), itemsJson: '[{"value":7}]' };
    const receipt = await service.run(request, () => {});
    assert.equal(receipt.executor, 'dkg');
    assert.deepEqual(JSON.parse(receipt.output.itemsJson), [{ result: 21 }]);
    assert.equal(receipt.steps[0].programVersion, '1.0.0');
    assert.equal((await service.list())[0].kaRef, saved.kaRef);
    cap = { ...cap, requiresExportAuthorization: true };
    await assert.rejects(service.run({ ...request, invocationId: randomUUID() }, () => { throw new Error('Export denied'); }), /Export denied/);
    cap = { ...cap, available: false };
    await assert.rejects(service.run({ ...request, invocationId: randomUUID() }, () => {}), /unavailable/);
    assert.equal(dispatches, 1);
  } finally { service.stop(); provider.close(); rmSync(state, { recursive: true, force: true }); }
});
