import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { loadDkgProfile, profileParameters } from './dkg-profile.mjs';
import { dkgComponentStore } from './dkg-components.mjs';
import profile, { measurements } from './test-support/measurement-profile.mjs';
const id = '11223344-1234-4234-8234-123456789abc';
const block = (id, componentId) => ({ id, componentId, params: Object.fromEntries(Object.entries(profileParameters(profile, componentId)).map(([k,v]) => [k,v.default])) });
const read = block('read', 'dkg-read'), invoke = block('invoke', 'invoke-dkg-program'), write = block('write', 'dkg-write');
invoke.params.inputs = ['{{ $json }}']; invoke.params.outputMapping = '{{ $json[0] }}';
const workflow = { kaRef: 'urn:test:flow', sourceHash: 'f'.repeat(64), definition: { entryId: 'read', nodes: [read, invoke, write], edges: [{ from: 'read', to: 'invoke' }, { from: 'invoke', to: 'write' }] } };
const input = { itemsJson: '[{}]', paramsJson: '{}', executionId: '' };
const request = (blockId, items) => ({ blockId, items, effectId: 'urn:sr:effect:' + id + ':0', workflowId: 'native', executionId: '42' });
function transport(calls, failWrite = false) {
  return async (payload, operation) => {
    calls.push({ payload, operation });
    if (operation === 'read') return { graph: 'urn:test:measurements', measurements };
    if (operation === 'invoke') return { invocationId: payload.invocationId, executionIri: 'urn:sr:execution:' + payload.invocationId,
      operationIri: payload.selected.operationIri, bindingDigest: payload.selected.bindingDigest,
      sourceHash: payload.selected.program.sourceHash, outputs: [{ sum: 7, samples: payload.inputs[0] }] };
    if (failWrite && payload.allowCreate) throw new Error('lost reply');
    return { contextGraphId: profile.targetGraph, digest: payload.digest, name: payload.name,
      metadata: { status: 'wm-sealed', reservedUal: 'urn:test:asset:1' }, readbackVerified: true };
  };
}
test('no selected profile means no DKG effects, no customer defaults and no fallback transport', async () => {
  assert.equal(await loadDkgProfile(undefined), null);
  await assert.rejects(loadDkgProfile('./relative-profile.mjs'), /absolute/);
  const env = { ...process.env }; delete env.NOS_DKG_PROFILE_MODULE;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { componentRegistry } = await import(${JSON.stringify(new URL('./component-registry.mjs', import.meta.url).href)}); console.log(JSON.stringify(componentRegistry.filter(c => c.category === 'DKG')));`], { env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(result), []);
  const db = new DatabaseSync(':memory:');
  try { assert.throws(() => dkgComponentStore(db, undefined, [], null).grant(workflow, id, input), /No DKG execution profile/); }
  finally { db.close(); }
});
test('generic registry loads a different dataset and catalog through explicit operator configuration', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { componentRegistry } = await import(${JSON.stringify(new URL('./component-registry.mjs', import.meta.url).href)}); console.log(JSON.stringify(componentRegistry.filter(c => c.category === 'DKG')));`],
    { env: { ...process.env, NOS_DKG_PROFILE_MODULE: fileURLToPath(new URL('./test-support/measurement-profile.mjs', import.meta.url)) }, encoding: 'utf8' });
  const descriptors = JSON.parse(output);
  assert.equal(descriptors.length, 3);
  assert.equal(descriptors[0].parameters.dataset.default, 'set-7');
  assert.equal(descriptors[0].parameters.profileRevision.default, profile.revision);
  assert.equal(descriptors[1].parameters.program.default, 'sum-measurements');
  assert.doesNotMatch(output, /JPB|DMaaST|PLCA|62633|workbook|erp/);
});
test('another profile runs Read -> Invoke -> Write with its own schema, cached Program and reconciled write', async () => {
  const db = new DatabaseSync(':memory:'), calls = [];
  try {
    const store = dkgComponentStore(db, transport(calls, true), [], profile);
    store.grant(workflow, id, input);
    const source = await store.call(request('read', [{}]), workflow, 'native');
    assert.deepEqual(source.items, measurements);
    const calculated = await store.call(request('invoke', source.items), workflow, 'native');
    assert.equal(calculated.items[0].result.sum, 7);
    assert.equal(calculated.items[0].programExecution.node, 'test-node');
    assert.deepEqual(await store.call(request('invoke', source.items), workflow, 'native'), calculated);
    await assert.rejects(store.call(request('write', calculated.items), workflow, 'native'), /lost reply/);
    const saved = await store.call(request('write', calculated.items), workflow, 'native');
    assert.equal(saved.items[0].contextGraphId, profile.targetGraph);
    assert.equal(saved.items[0].measurementTotal, 7);
    assert.equal(saved.items[0].recordCount, 2);
    assert.equal(saved.items[0].readbackVerified, true);
    assert.deepEqual(await store.call(request('write', calculated.items), workflow, 'native'), saved);
    // A completed replay uses its durable receipt, even when the node is unavailable.
    assert.deepEqual(calls.map(c => c.operation), ['read', 'invoke', 'write', 'write']);
    assert.deepEqual(calls.filter(c => c.operation === 'write').map(c => c.payload.allowCreate), [true, false]);
  } finally { db.close(); }
});
test('profile switch and changed revisions cannot reuse an invocation or its cached results', async () => {
  const db = new DatabaseSync(':memory:'), calls = [];
  try {
    const first = dkgComponentStore(db, transport(calls), [], profile);
    first.grant(workflow, id, input);
    await first.call(request('read', [{}]), workflow, 'native');
    const other = { ...profile, id: 'different-scope' };
    const second = dkgComponentStore(db, transport(calls), [], other);
    assert.throws(() => second.grant(workflow, id, input), /different execution profile/);
    await assert.rejects(second.call(request('read', [{}]), workflow, 'native'), /profile mismatch/);
    const revised = dkgComponentStore(db, transport(calls), [], { ...profile, revision: '0'.repeat(64) });
    assert.throws(() => revised.grant(workflow, id, input), /profile changed/);
    assert.equal(calls.length, 1);
  } finally { db.close(); }
});
test('unscoped legacy invocations are never silently rebound to a profile', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = dkgComponentStore(db, () => assert.fail('unexpected transport'), [], profile);
    db.prepare('INSERT INTO dkg_component_runs VALUES (?,?,?,?,?)').run(id, workflow.kaRef, workflow.sourceHash, JSON.stringify(input), Date.now()+600000);
    assert.throws(() => store.grant(workflow, id, input), /unscoped legacy/);
  } finally { db.close(); }
});
test('fabricated Program output cannot be accepted', async () => {
  const db = new DatabaseSync(':memory:'), calls = [];
  try {
    const base = transport(calls);
    const store = dkgComponentStore(db, async (payload, op) => {
      const result = await base(payload, op); return op === 'write' ? { ...result, contextGraphId: 'urn:foreign' } : result;
    }, [], profile);
    store.grant(workflow, id, input);
    const source = await store.call(request('read', [{}]), workflow, 'native');
    const output = await store.call(request('invoke', source.items), workflow, 'native');
    const forged = structuredClone(output.items); forged[0].result.sum = 900;
    await assert.rejects(store.call(request('write', forged), workflow, 'native'), /Program output differs/);
    assert.equal(calls.length, 2);
  } finally { db.close(); }
});
test('wrong destination or digest never produces a successful write receipt', async () => {
  for (const override of [{ contextGraphId: 'urn:foreign' }, { digest: '0'.repeat(64) }, { readbackVerified: false }]) {
    const db = new DatabaseSync(':memory:'), calls = [];
    try {
      const base = transport(calls);
      const store = dkgComponentStore(db, async (payload, op) => {
        const result = await base(payload, op); return op === 'write' ? { ...result, ...override } : result;
      }, [], profile);
      store.grant(workflow, id, input);
      const source = await store.call(request('read', [{}]), workflow, 'native');
      const output = await store.call(request('invoke', source.items), workflow, 'native');
      await assert.rejects(store.call(request('write', output.items), workflow, 'native'), /readback did not confirm/);
      assert.equal(db.prepare('SELECT result FROM dkg_component_calls WHERE id=?').get(id + ':write').result, null);
    } finally { db.close(); }
  }
});
test('core runtime and editor registry contain no domain-specific imports or constants', () => {
  for (const file of ['dkg-components.mjs', 'dkg-program.mjs', 'dkg-profile.mjs', 'component-registry.mjs', 'studio-service.mjs'])
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /jpb|dmaast|holos|62633|100\.113\.215\.1|PLCA/i, file);
});

test('write receipts must identify the exact requested asset name', async () => {
  const db = new DatabaseSync(':memory:'), calls = [];
  try {
    const base = transport(calls);
    const store = dkgComponentStore(db, async (payload, op) => {
      const result = await base(payload, op);
      return op === 'write' ? { ...result, name: 'different-asset' } : result;
    }, [], profile);
    store.grant(workflow, id, input);
    const source = await store.call(request('read', [{}]), workflow, 'native');
    const calculated = await store.call(request('invoke', source.items), workflow, 'native');
    await assert.rejects(store.call(request('write', calculated.items), workflow, 'native'), /exact evidence/);
  } finally { db.close(); }
});
