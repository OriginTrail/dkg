import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { compileWorkflow, normalizeWorkflow, readWorkflow, validateWorkflowCapabilities, workflowRunInput } from '../../../examples/n8n-capability/workflow-definition.mjs';
import { createWorkflowService } from '../../../examples/n8n-capability/workflow-service.mjs';

const { transpileModule, ScriptTarget, ModuleKind } = createRequire(import.meta.url)('typescript');
const capabilities = ['text', 'csv-parse', 'csv-map', 'google-sheets-export'].map((kind, i) => ({
  kind, kaRef: `urn:test:${kind}`, sourceHash: String(i + 1).repeat(64), available: true,
}));
const sample = () => ({ id: '123e4567-e89b-42d3-a456-426614174000', name: 'My CSV workflow', savedAt: '2026-10-23T20:00:00.000Z',
  nodes: [
    { ...capabilities[1], id: 'parse', x: 100, y: 100, config: {} },
    { ...capabilities[2], id: 'map', x: 400, y: 100, config: { mapping: [{ source: 1, target: 'Email' }] } },
  ].map(({ available: _available, ...node }) => node), edges: [{ from: 'parse', to: 'map' }] });
function guest(source, invoke) {
  const js = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ES2022 } }).outputText
    .replace(/^import .*;\s*$/m, '').replace('export async function run', 'async function run');
  return new Function('invoke_program', `${js}\nreturn run;`)(invoke);
}
const parsed = { kind: 'n8n-result', n8nExecutionId: '1', workflowSha256: 'a'.repeat(64),
  output: { ok: true, columns: ['name', 'email'], rows: [['Ana', 'ana@example.com']], error: '' } };
const mapped = { kind: 'n8n-result', n8nExecutionId: '2', workflowSha256: 'b'.repeat(64),
  output: { ok: true, columns: ['Email'], rows: [['ana@example.com']], error: '' } };

test('graph connections determine invocation order and wire real child outputs into mapped inputs', async () => {
  const value = sample(); value.nodes.reverse();
  const compiled = compileWorkflow(value), calls = [];
  const result = await guest(compiled.source, async (target, inputs) => {
    calls.push({ target, inputs }); return calls.length === 1 ? parsed : mapped;
  })({ csv: 'name,email\nAna,ana@example.com' });
  assert.deepEqual(calls, [
    { target: 'urn:test:csv-parse', inputs: [{ csv: 'name,email\nAna,ana@example.com' }] },
    { target: 'urn:test:csv-map', inputs: [{ columns: ['name', 'email'], rows: [['Ana', 'ana@example.com']], mapping: [{ source: 1, target: 'Email' }] }] },
  ]);
  assert.equal(result.kind, 'nos-ka-workflow-result'); assert.deepEqual(result.output, mapped.output);
  assert.deepEqual(result.steps.map(s => s.nodeId), ['parse', 'map']);
  assert.deepEqual(readWorkflow(compiled.source).definition, compiled.definition);
  assert.equal(readWorkflow(compiled.source + 'throw new Error("extra code");'), null);
});
test('stable saves are idempotent; configuration and layout edits produce a new immutable revision', () => {
  const first = compileWorkflow(sample()), reorder = sample(); reorder.nodes.reverse();
  assert.equal(compileWorkflow(reorder).kaRef, first.kaRef);
  const changed = sample(); changed.nodes[1].config.mapping[0].target = 'Contact';
  assert.notEqual(compileWorkflow(changed).kaRef, first.kaRef);
  changed.nodes[1].x += 10; assert.notEqual(compileWorkflow(changed).sourceHash, first.sourceHash);
});
test('compiler versions have distinct identities and earlier stored Programs remain readable', () => {
  const previous = compileWorkflow(sample(), 1), current = compileWorkflow(sample());
  assert.notEqual(previous.kaRef, current.kaRef);
  assert.equal(readWorkflow(previous.source).compilerVersion, 1);
  assert.equal(readWorkflow(current.source).compilerVersion, 2);
});
test('rejects disconnected, cyclic, branching, incompatible and excessive graphs', () => {
  const cases = [
    d => { d.edges = []; },
    d => { d.edges[0] = { from: 'map', to: 'parse' }; },
    d => { d.edges[0].to = 'missing'; },
    d => { d.nodes.push({ ...d.nodes[1], id: 'second-map' }); d.edges.push({ from: 'parse', to: 'second-map' }); },
    d => { d.nodes[1].id = d.nodes[0].id; },
    d => { d.nodes = Array.from({ length: 9 }, (_, i) => ({ ...d.nodes[0], id: 'n' + i })); },
    d => { d.nodes[0].x = Infinity; },
    d => { d.nodes[0].config = { remoteUrl: 'https://example.com' }; },
    d => { d.nodes[1].config.mapping.push({ source: 0, target: 'Email' }); },
    d => { d.nodes[1].config.mapping[0].target = '__proto__'; },
    d => { d.exportToken = 'must-never-be-stored'; },
  ];
  for (const mutate of cases) { const d = sample(); mutate(d); assert.throws(() => normalizeWorkflow(d)); }
});
test('requires installed exact child pins and bounded root input without credentials', () => {
  const definition = normalizeWorkflow(sample()); validateWorkflowCapabilities(definition, capabilities);
  assert.throws(() => validateWorkflowCapabilities(definition, capabilities.filter(c => c.kind !== 'csv-map')), /unavailable/);
  assert.throws(() => validateWorkflowCapabilities(definition, capabilities.map(c => ({ ...c, sourceHash: 'f'.repeat(64) }))), /unavailable/);
  assert.throws(() => workflowRunInput(definition, { csv: 'ok', exportToken: 'secret' }));
  assert.throws(() => workflowRunInput(definition, { csv: 'a'.repeat(2049) }));
});
test('malformed parser result stops downstream calls and configured strings cannot inject code', async () => {
  let calls = 0;
  const rejected = await guest(compileWorkflow(sample()).source, async () => { calls++; return { ...parsed, output: { ok: false, error: 'Invalid CSV' } }; })({ csv: 'bad' });
  assert.equal(rejected.status, 'input-rejected'); assert.equal(rejected.steps.length, 1);
  assert.equal(calls, 1);
  const d = sample(); d.nodes.push({ ...capabilities[3], id: 'export', x: 700, y: 100, config: { title: '"}); throw new Error("injected"); //' } });
  delete d.nodes[2].available; d.edges.push({ from: 'map', to: 'export' });
  const inputs = [];
  await guest(compileWorkflow(d).source, async (_target, args) => { inputs.push(args[0]); return inputs.length === 1 ? parsed : mapped; })({ csv: 'ok' });
  assert.equal(inputs[2].title, d.nodes[2].config.title);
});
test('an out-of-range column is a confirmed rejection before calling the mapper', async () => {
  const value = sample(); value.nodes[1].config.mapping[0].source = 7;
  let calls = 0;
  const result = await guest(compileWorkflow(value).source, async () => { calls++; return parsed; })({ csv: 'valid' });
  assert.equal(calls, 1); assert.equal(result.status, 'input-rejected'); assert.equal(result.rejectedNode, 'map');
  assert.match(result.output.error, /column missing/);
});

function serviceFixture() {
  const programs = new Map(), approvals = new Map(), outputs = new Map();
  const counts = { persist: 0, approve: 0, invoke: 0 }; let inventory = structuredClone(capabilities);
  const client = { programs: {
    getSource: async ({ programIri }) => { if (!programs.has(programIri)) throw Object.assign(new Error('missing'), { status: 404 }); return programs.get(programIri); },
    getApproval: async ({ operationIri }) => { if (!approvals.has(operationIri)) throw Object.assign(new Error('missing'), { status: 404 }); return approvals.get(operationIri); },
    approve: async value => { counts.approve++; const record = { binding: { enabled: true, program: value.program, typescript: value.typescript } }; approvals.set(value.operationIri, record); return record; },
    invoke: async value => {
      counts.invoke++; const compiled = readWorkflow(programs.get(value.operationIri).source);
      const steps = compiled.ordered.map((node, i) => ({ nodeId: node.id, kaRef: node.kaRef, result: node.kind === 'text'
        ? { ...parsed, n8nExecutionId: String(i + 1), output: { text: 'step-' + i } } : i ? mapped : parsed }));
      const result = { kind: 'nos-ka-workflow-result', status: 'completed', output: steps.at(-1).result.output, steps };
      const executionIri = `urn:sr:execution:${value.invocationId}`, rawOutputs = [JSON.stringify(result)]; outputs.set(executionIri, rawOutputs);
      for (const [i, step] of result.steps.entries()) if (!outputs.has(`urn:child:${i}`)) outputs.set(`urn:child:${i}`, [JSON.stringify(step.result)]);
      return { invocationId: value.invocationId, executionIri, rawOutputs, outputs: [result], persisted: true,
        trace: { calls: result.steps.map((step, i) => ({ kind: 'program', target: step.kaRef, status: 'succeeded', executionIri: `urn:child:${i}` })) } };
    },
  } };
  const dependencies = { graphId: 'test', owner: 'owner', client, listCapabilities: async () => inventory,
    listPrograms: async () => [...programs.keys()], loadOutputs: async iri => outputs.get(iri),
    persistProgram: async compiled => { counts.persist++; programs.set(compiled.kaRef, { programIri: compiled.kaRef, source: compiled.source, sourceHash: compiled.sourceHash, authorAgentAddress: 'owner' }); },
  };
  return { service: createWorkflowService(dependencies), dependencies, programs, approvals, outputs, counts,
    inventory: value => { inventory = value; } };
}
test('saves and reopens source from DKG and approves only the selected child operations', async () => {
  const f = serviceFixture(), saved = await f.service.save(sample(), () => assert.fail('not a Google workflow'));
  assert.equal(saved.readbackVerified, true); assert.equal(saved.approved, true);
  await f.service.save(sample(), () => {}); assert.equal(f.programs.size, 1); assert.equal(f.counts.approve, 1);
  const reopened = createWorkflowService(f.dependencies); assert.deepEqual((await reopened.list())[0].definition, saved.definition);
  assert.deepEqual(f.approvals.get(saved.kaRef).binding.typescript.children.map(c => c.operationIri), ['urn:test:csv-parse', 'urn:test:csv-map']);
});
test('refuses a Google-containing parent before storing source or granting child permissions', async () => {
  const f = serviceFixture(), d = sample(); d.nodes[1] = { ...d.nodes[1], kind: 'google-sheets-export', kaRef: capabilities[3].kaRef, sourceHash: capabilities[3].sourceHash, config: { title: 'Test' } };
  await assert.rejects(f.service.save(d, () => { throw Object.assign(new Error('Export denied'), { status: 403 }); }), /Export denied/);
  assert.equal(f.programs.size, 0); assert.equal(f.counts.approve, 0); assert.equal(f.counts.invoke, 0);
});
test('run returns parent and per-block receipts only after independent DKG readback', async () => {
  const f = serviceFixture(), saved = await f.service.save(sample(), () => {});
  const request = { kaRef: saved.kaRef, sourceHash: saved.sourceHash, input: { csv: 'name,email\nAna,ana@example.com' }, invocationId: '123e4567-e89b-42d3-a456-426614174099' };
  const result = await f.service.run(request, () => {}); assert.equal(result.readbackVerified, true);
  assert.deepEqual(result.steps.map(s => s.n8nExecutionId), ['1', '2']);
  f.outputs.set('urn:child:1', [JSON.stringify({ ...mapped, output: 'tampered' })]);
  await assert.rejects(f.service.run(request, () => {}), /Child DKG receipt/);
});
test('revoked parents and stale child pins are rejected before any invocation', async () => {
  const f = serviceFixture(), saved = await f.service.save(sample(), () => {});
  const request = { kaRef: saved.kaRef, sourceHash: saved.sourceHash, input: { csv: 'ok' }, invocationId: '123e4567-e89b-42d3-a456-426614174099' };
  f.inventory([]); await assert.rejects(f.service.run(request, () => {}), /unavailable/);
  f.inventory(capabilities); f.approvals.get(saved.kaRef).binding.enabled = false;
  await assert.rejects(f.service.run(request, () => {}), /approval/); assert.equal(f.counts.invoke, 0);
});

test('workflow inventory reads at most four revisions concurrently and sorts after out-of-order completion', { timeout: 10000 }, async () => {
  const f = serviceFixture();
  for (let i = 0; i < 8; i++) await f.service.save({ ...sample(), name: 'Workflow ' + i,
    savedAt: new Date(1700000000000 + i % 3 * 1000).toISOString() }, () => {});
  const order = [...f.programs.keys()], gates = order.map(() => Promise.withResolvers()), first = Promise.withResolvers(), second = Promise.withResolvers();
  const getSource = f.dependencies.client.programs.getSource, calls = []; let active = 0, peak = 0;
  f.dependencies.client.programs.getSource = async pin => {
    const index = order.indexOf(pin.programIri); calls.push(index); active++; peak = Math.max(peak, active);
    if (calls.length === 4) first.resolve(); if (calls.length === 8) second.resolve();
    await gates[index].promise; active--; return getSource(pin);
  };
  const listing = f.service.list();
  try {
    await first.promise; assert.deepEqual(calls, [0, 1, 2, 3]); assert.equal(active, 4);
    for (const i of [3, 2, 1, 0]) gates[i].resolve();
    await second.promise; assert.equal(active, 4);
    for (const i of [7, 6, 5, 4]) gates[i].resolve();
    const listed = await listing, expected = [...f.programs.values()].map(p => readWorkflow(p.source))
      .sort((a, b) => b.definition.savedAt.localeCompare(a.definition.savedAt) || a.kaRef.localeCompare(b.kaRef));
    assert.equal(peak, 4); assert.equal(active, 0);
    assert.deepEqual(listed.map(w => w.kaRef), expected.map(w => w.kaRef));
  } finally { gates.forEach(g => g.resolve()); }
});
for (const method of ['getSource', 'getApproval']) test(`workflow inventory propagates ${method} failures without returning partial results`, async () => {
  const f = serviceFixture(); await f.service.save(sample(), () => {});
  const failure = new Error('metadata unavailable'); f.dependencies.client.programs[method] = async () => { throw failure; };
  await assert.rejects(f.service.list(), error => error === failure);
});
test('workflow inventory limit rejects before metadata fetching', async () => {
  const f = serviceFixture();
  const service = createWorkflowService({ ...f.dependencies, listPrograms: async () => Array(129).fill('unused'),
    client: { programs: { getSource: () => assert.fail('oversized inventory must not read metadata') } } });
  await assert.rejects(service.list(), /inventory is full/);
});
async function receiptFixture() {
  const f = serviceFixture(), value = { ...sample(), nodes: Array.from({ length: 8 }, (_, i) => ({
    id: 'n' + i, kaRef: capabilities[0].kaRef, sourceHash: capabilities[0].sourceHash, kind: 'text', x: i * 100, y: 0, config: {},
  })), edges: Array.from({ length: 7 }, (_, i) => ({ from: 'n' + i, to: 'n' + (i + 1) })) };
  const saved = await f.service.save(value, () => {});
  return { ...f, request: { kaRef: saved.kaRef, sourceHash: saved.sourceHash, input: { text: 'start' }, invocationId: '123e4567-e89b-42d3-a456-426614174099' } };
}
test('child receipts use four concurrent reads and retain step order after reverse completion', { timeout: 10000 }, async () => {
  const f = await receiptFixture(), gates = Array.from({ length: 8 }, () => Promise.withResolvers());
  const first = Promise.withResolvers(), second = Promise.withResolvers(), reads = []; let active = 0, peak = 0;
  const service = createWorkflowService({ ...f.dependencies, loadOutputs: async iri => {
    if (!iri.startsWith('urn:child:')) return f.dependencies.loadOutputs(iri);
    const index = Number(iri.split(':').at(-1)); reads.push(index); active++; peak = Math.max(peak, active);
    if (reads.length === 4) first.resolve(); if (reads.length === 8) second.resolve();
    await gates[index].promise; active--; return f.dependencies.loadOutputs(iri);
  } });
  const run = service.run(f.request, () => {});
  try {
    await first.promise; assert.deepEqual(reads, [0, 1, 2, 3]); assert.equal(active, 4);
    for (const i of [3, 2, 1, 0]) gates[i].resolve();
    await second.promise; assert.equal(active, 4);
    for (const i of [7, 6, 5, 4]) gates[i].resolve();
    const result = await run;
    assert.equal(peak, 4); assert.equal(active, 0);
    assert.deepEqual(result.steps.map(s => [s.nodeId, s.n8nExecutionId, s.output.text]),
      Array.from({ length: 8 }, (_, i) => ['n' + i, String(i + 1), 'step-' + i]));
  } finally { gates.forEach(g => g.resolve()); }
});
test('a bad final child identity rejects before any child receipt read', async () => {
  const f = await receiptFixture(), invoke = f.dependencies.client.programs.invoke, reads = [];
  f.dependencies.client.programs.invoke = async value => { const result = await invoke(value); result.trace.calls.at(-1).target = 'urn:wrong'; return result; };
  const service = createWorkflowService({ ...f.dependencies, loadOutputs: async iri => { reads.push(iri); return f.dependencies.loadOutputs(iri); } });
  await assert.rejects(service.run(f.request, () => {}), /child identity/);
  assert.deepEqual(reads, ['urn:sr:execution:' + f.request.invocationId]);
});
for (const failure of ['mismatch', 'unavailable']) test(`a ${failure} child receipt rejects the complete workflow response`, async () => {
  const f = await receiptFixture();
  const service = createWorkflowService({ ...f.dependencies, loadOutputs: async iri => {
    if (iri === 'urn:child:7') {
      if (failure === 'unavailable') throw new Error('receipt unavailable');
      return ['{"different":true}'];
    }
    return f.dependencies.loadOutputs(iri);
  } });
  await assert.rejects(service.run(f.request, () => {}), failure === 'unavailable' ? /receipt unavailable/ : /Child DKG receipt/);
});
