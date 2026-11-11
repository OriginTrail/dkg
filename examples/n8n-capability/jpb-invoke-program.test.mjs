import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./jpb-invoke-program.py', import.meta.url));
const harness = fileURLToPath(new URL('./test-support/run-jpb-invoke-program.py', import.meta.url));
const owner = '0xF77258a965ba13Adc77bCa85dA7C6A287272959a';
const graph = owner.toLowerCase() + '/jpb-plca-study';
const programGraph = owner.toLowerCase() + '/jpb-plca-program';
const invocationId = '11223344-1234-4234-8234-123456789abc';
const status = '/api/status', binding = '/api/programs/bindings', source = '/api/programs/source', execute = '/api/programs/execute';
const completePath = [status, binding, source, execute, binding];

function fixture() {
  const text = 'export default () => ({ label: "Équipement 🛠", value: 7 });';
  const program = { contextGraphId: programGraph, programIri: 'urn:fixture:jpb:program', programLayer: 'wm',
    authorAgentAddress: owner, sourceHash: createHash('sha256').update(text).digest('hex') };
  const selected = { node: 'JPB', contextGraphId: graph, operationIri: 'urn:fixture:jpb:operation',
    program, version: '1.0.0', bindingDigest: 'b'.repeat(64) };
  const approval = { bindingDigest: selected.bindingDigest, binding: { enabled: true, program,
    executorAgentAddress: owner.toLowerCase(), allowedCallerAgentAddresses: [owner.toLowerCase()] } };
  return { hostname: 'dmaast-mainnet-edge-2', status: { peerId: '12D3KooWNaxdaVran5jSeMFVKzm1nBESdpnQfeXCz6uzTrqSALC5' },
    payload: { selected, invocationId, inputs: [{ rows: [{ quantity: null, label: 'Équipement 🛠' }], quantity: 7 }] },
    beforeApproval: structuredClone(approval), afterApproval: structuredClone(approval),
    source: { source: text, sourceHash: program.sourceHash, version: selected.version },
    receipt: { persisted: true, invocationId, executionIri: 'urn:sr:execution:' + invocationId,
      outputs: ['{"result":7,"label":"Équipement 🛠"}', 'plain output', { typed: true }, 'null'] } };
}
function run(value) {
  const result = spawnSync('python3', [harness, script], { input: JSON.stringify(value), encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function refused(result, paths, error = 'AssertionError') {
  assert.equal(result.ok, false);
  assert.equal(result.error, error, result.message);
  assert.equal(result.printed, '', 'an unverified invocation cannot print a receipt');
  assert.equal(result.receipt, undefined);
  assert.deepEqual(result.calls.map(call => call.path), paths);
  assert.equal(result.calls.filter(call => call.method === 'POST').length, paths.includes(execute) ? 1 : 0);
}

test('actual SSH Program adapter checks authority on both sides of execution and returns only its verified receipt', () => {
  const f = fixture(), result = run(f), selected = f.payload.selected;
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.calls.map(call => call.path), completePath);
  assert.deepEqual(result.calls.map(call => call.method), ['GET', 'GET', 'GET', 'POST', 'GET']);
  assert.ok(result.calls.every(call => call.authorized && call.agent === owner && call.timeout === 30));
  for (const call of result.calls.filter(call => call.path === binding))
    assert.deepEqual(call.query, { contextGraphId: [graph], operationIri: [selected.operationIri] });
  assert.deepEqual(result.calls[2].query, { contextGraphId: [programGraph], programIri: [selected.program.programIri], programLayer: ['wm'] });
  assert.deepEqual(result.calls[3].body, { contextGraphId: graph, operationIri: selected.operationIri,
    invocationId, inputs: f.payload.inputs });
  assert.deepEqual(result.receipt, { invocationId, executionIri: f.receipt.executionIri, operationIri: selected.operationIri,
    sourceHash: selected.program.sourceHash, bindingDigest: selected.bindingDigest,
    outputs: [{ result: 7, label: 'Équipement 🛠' }, 'plain output', { typed: true }, null] });
  assert.equal(result.printed.trim().split('\n').length, 1);
});

for (const [name, change, paths] of [
  ['host', f => { f.hostname = 'another-host'; }, []],
  ['peer', f => { f.status.peerId = 'another-peer'; }, [status]],
]) test(`actual SSH Program adapter rejects a different ${name} before execution`, () => {
  const f = fixture(); change(f); refused(run(f), paths);
});

const approvalChanges = [
  ['disabled binding', approval => { approval.binding.enabled = false; }],
  ['changed binding digest', approval => { approval.bindingDigest = 'c'.repeat(64); }],
  ['changed Program reference', approval => { approval.binding.program.sourceHash = 'd'.repeat(64); }],
  ['changed executor', approval => { approval.binding.executorAgentAddress = '0x' + '2'.repeat(40); }],
  ['removed owner caller', approval => { approval.binding.allowedCallerAgentAddresses = ['0x' + '2'.repeat(40)]; }],
];
for (const [phase, key, paths] of [
  ['before execution', 'beforeApproval', [status, binding]],
  ['after execution', 'afterApproval', completePath],
]) for (const [name, change] of approvalChanges) test(`actual SSH Program adapter rejects ${name} ${phase}`, () => {
  const f = fixture(); change(f[key]); refused(run(f), paths);
});

for (const [name, change] of [
  ['source bytes with an unchanged claimed hash', f => { f.source.source += '\n// changed'; }],
  ['source version', f => { f.source.version = '2.0.0'; }],
]) test(`actual SSH Program adapter rejects mismatched ${name} before execution`, () => {
  const f = fixture(); change(f); refused(run(f), [status, binding, source]);
});

for (const [name, change] of [
  ['unpersisted receipt', receipt => { receipt.persisted = false; }],
  ['non-boolean persistence claim', receipt => { receipt.persisted = 1; }],
  ['foreign invocation', receipt => { receipt.invocationId = '11223344-1234-4234-8234-123456789abd'; }],
  ['foreign execution IRI', receipt => { receipt.executionIri = 'urn:sr:execution:11223344-1234-4234-8234-123456789abd'; }],
]) test(`actual SSH Program adapter withholds ${name}`, () => {
  const f = fixture(); change(f.receipt); refused(run(f), [status, binding, source, execute]);
});

for (const [key, paths] of [
  ['beforeApproval', [status, binding]],
  ['afterApproval', completePath],
  ['receipt', [status, binding, source, execute]],
]) test(`actual SSH Program adapter withholds output on ${key} HTTP failure without retrying execution`, () => {
  const f = fixture(); f.httpErrors = { [key]: 503 }; refused(run(f), paths, 'HTTPError');
});
