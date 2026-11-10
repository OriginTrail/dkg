import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDkgProfile, profileParameters } from './dkg-profile.mjs';
import { dkgComponentStore } from './test-support/dkg-component-store-fixture.mjs';
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
    `const { loadStudioContext } = await import(${JSON.stringify(new URL('./studio-context.mjs', import.meta.url).href)}); const { registry: { componentRegistry } } = await loadStudioContext(); console.log(JSON.stringify(componentRegistry.filter(c => c.category === 'DKG')));`],
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
test('authenticated execution pins its principal and rechecks revocation before cached results or effects', async () => {
  const db = new DatabaseSync(':memory:'), calls = [];
  let revoked = false, checks = 0;
  const owner = { id: 'person-1', accountId: 'account-real', role: 'owner' };
  const scoped = { ...profile, requiresNosActor: true, accountId: owner.accountId,
    async authorize(actor) { assert.deepEqual(actor, owner); checks++; if (revoked) throw new Error('owner revoked'); } };
  try {
    const remote = transport(calls);
    const store = dkgComponentStore(db, (p, op, context) => { assert.deepEqual(context.actor, owner); return remote(p, op); }, [], scoped);
    assert.throws(() => store.grant(workflow, id, input), /owner/);
    assert.throws(() => store.grant(workflow, id, input, { ...owner, accountId: 'other' }), /owner/);
    store.grant(workflow, id, input, owner);
    assert.throws(() => store.grant(workflow, id, input, { ...owner, id: 'person-2' }), /different account or principal/);
    const source = await store.call(request('read', [{}]), workflow, 'native');
    const calculated = await store.call(request('invoke', source.items), workflow, 'native');
    const saved = await store.call(request('write', calculated.items), workflow, 'native');
    assert.equal(saved.items[0].status, 'wm-sealed');
    assert.equal(calls.length, 3);
    revoked = true;
    await assert.rejects(store.call(request('write', calculated.items), workflow, 'native'), /revoked/);
    await assert.rejects(store.call(request('invoke', source.items), workflow, 'native'), /revoked/);
    assert.equal(checks, 6); assert.equal(calls.length, 3); // Includes authorization after write readback.
  } finally { db.close(); }
});
test('write recovery retains its exact payload and refuses unjournalled legacy recovery', async () => {
  const db = new DatabaseSync(':memory:'), calls = [], scoped = { ...profile };
  try {
    let store = dkgComponentStore(db, transport(calls, true), [], scoped);
    store.grant(workflow, id, input);
    const source = await store.call(request('read', [{}]), workflow, 'native');
    const calculated = await store.call(request('invoke', source.items), workflow, 'native');
    const value = request('write', calculated.items);
    await assert.rejects(store.call(value, workflow, 'native'), { code: 'DKG_WRITE_PENDING' });
    const saved = db.prepare('SELECT * FROM dkg_component_calls WHERE id=?').get(id + ':write');
    assert.deepEqual(JSON.parse(saved.request), value);
    assert.deepEqual({ ...JSON.parse(saved.prepared).payload, allowCreate: true }, calls.at(-1).payload);
    assert.equal(saved.response, null);
    assert.throws(() => store.writeRecovery(workflow, id, 'native', '43'), /different native execution/);
    db.prepare('UPDATE dkg_component_calls SET prepared=NULL WHERE id=?').run(id + ':write');
    assert.throws(() => store.writeRecovery(workflow, id, 'native', '42'), /legacy write has no saved request/);
    assert.throws(() => store.grant(workflow, '11223344-1234-4234-8234-123456789abd', input), { code: 'DKG_WRITE_PENDING' });
    await assert.rejects(store.call(value, workflow, 'native'), /legacy write has no saved request/);
    db.exec('CREATE TABLE dkg_component_writes (id TEXT PRIMARY KEY, request TEXT NOT NULL, evidence TEXT NOT NULL, receipt TEXT)');
    db.prepare('INSERT INTO dkg_component_writes VALUES (?,?,?,NULL)').run(saved.id, saved.request, saved.prepared);
    db.exec('ALTER TABLE dkg_component_calls DROP COLUMN request; ALTER TABLE dkg_component_calls DROP COLUMN prepared');
    scoped.evidence = () => { throw new Error('Recovery must not rebuild the write payload'); };
    // Upgrade an uncertain write from the old schema without allowing another create.
    db.exec('ALTER TABLE dkg_component_calls DROP COLUMN response');
    store = dkgComponentStore(db, transport(calls, true), [], scoped);
    const recovery = store.writeRecovery(workflow, id, 'native', '42');
    const receipt = await store.call(recovery.request, workflow, 'native');
    assert.deepEqual(calls.at(-1).payload, { ...JSON.parse(saved.prepared).payload, allowCreate: false });
    assert.deepEqual(JSON.parse(db.prepare('SELECT response FROM dkg_component_calls WHERE id=?').get(saved.id).response), receipt);
    assert.equal(store.writeRecovery(workflow, id, 'native', '42').pending, false);
  } finally { db.close(); }
});
test('ownership withdrawn during write readback leaves the original write pending', async () => {
  const db = new DatabaseSync(':memory:'), calls = [];
  const actor = { id: 'person-1', accountId: 'test-account', role: 'owner' };
  let revoked = false, withdraw = true;
  const scoped = { ...profile, requiresNosActor: true, accountId: actor.accountId,
    async authorize() { if (revoked) throw new Error('owner revoked'); } };
  const remote = transport(calls);
  try {
    const store = dkgComponentStore(db, async (payload, kind) => {
      const result = await remote(payload, kind);
      if (kind === 'write' && withdraw) revoked = true;
      return result;
    }, [], scoped);
    store.grant(workflow, id, input, actor);
    const source = await store.call(request('read', [{}]), workflow, 'native');
    const calculated = await store.call(request('invoke', source.items), workflow, 'native');
    const value = request('write', calculated.items);
    await assert.rejects(store.call(value, workflow, 'native'), /owner revoked/);
    assert.equal(db.prepare('SELECT result FROM dkg_component_calls WHERE id=?').get(id + ':write').result, null);
    revoked = false; withdraw = false;
    await store.call(value, workflow, 'native');
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
    db.prepare('INSERT INTO dkg_component_runs (id,ka_ref,source_hash,input,expires) VALUES (?,?,?,?,?)').run(id, workflow.kaRef, workflow.sourceHash, JSON.stringify(input), Date.now()+600000);
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
test('Invoke-to-Write requires its journalled presentation even without a Program receipt field', async t => {
  const db = new DatabaseSync(':memory:'), calls = [], contexts = [];
  t.after(() => db.close());
  const scoped = { ...profile, evidence(rows, context, read, input, programContext) {
    contexts.push(programContext);
    return profile.evidence(rows, context, read, input, programContext);
  } };
  const store = dkgComponentStore(db, transport(calls), [], scoped);
  store.grant(workflow, id, input);
  const source = await store.call(request('read', [{}]), workflow, 'native');
  const result = await store.call(request('invoke', source.items), workflow, 'native');
  const withoutReceipt = structuredClone(result.items); delete withoutReceipt[0].programExecution;
  for (const items of [withoutReceipt, measurements])
    await assert.rejects(store.call(request('write', items), workflow, 'native'), /Program output differs/);
  assert.deepEqual(contexts, []);
  assert.deepEqual(calls.map(c => c.operation), ['read', 'invoke']);
  await store.call(request('write', result.items), workflow, 'native');
  const journal = JSON.parse(db.prepare('SELECT result FROM dkg_component_calls WHERE id=?').get(id + ':invoke').result);
  assert.deepEqual(contexts, [{ blockId: 'invoke', receipt: journal.items[0].programExecution, rawOutputs: journal.rawOutputs }]);
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
  for (const file of ['dkg-components.mjs', 'dkg-component-operations.mjs', 'dkg-program.mjs', 'dkg-profile.mjs', 'component-registry.mjs', 'studio-service.mjs'])
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

test('completed Read, Invoke and Write replay exact journalled responses after reopen and authority checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-response-')), file = join(dir, 'journal.sqlite'), calls = [];
  const actor = { id: 'owner', accountId: 'response-test', role: 'owner' };
  let revoked = false, db = new DatabaseSync(file);
  const scoped = { ...profile, requiresNosActor: true, accountId: actor.accountId,
    authorize() { if (revoked) throw new Error('owner revoked'); } };
  try {
    let store = dkgComponentStore(db, transport(calls), [], scoped);
    store.grant(workflow, id, input, actor);
    const requests = [request('read', [{}])], responses = [];
    responses.push(await store.call(requests[0], workflow, 'native'));
    requests.push(request('invoke', responses[0].items));
    responses.push(await store.call(requests[1], workflow, 'native'));
    requests.push(request('write', responses[1].items));
    responses.push(await store.call(requests[2], workflow, 'native'));
    db.close(); db = new DatabaseSync(file);
    store = dkgComponentStore(db, () => assert.fail('completed replay cannot dispatch'), [], {
      ...scoped, readItems: () => assert.fail('completed Read cannot be remapped'),
      evidence: () => assert.fail('completed Write cannot rebuild evidence'),
    });
    db.exec("CREATE TRIGGER no_write_recompletion BEFORE UPDATE ON dkg_component_calls BEGIN SELECT RAISE(ABORT, 'completed Write must use its stored response'); END");
    for (let i = 0; i < requests.length; i++) {
      assert.deepEqual(await store.call(requests[i], workflow, 'native'), responses[i]);
      assert.deepEqual(JSON.parse(db.prepare('SELECT response FROM dkg_component_calls WHERE id=?').get(id + ':' + requests[i].blockId).response), responses[i]);
      await assert.rejects(store.call({ ...requests[i], items: [{ changed: true }] }, workflow, 'native'), /different inputs/);
    }
    revoked = true;
    for (const value of requests) await assert.rejects(store.call(value, workflow, 'native'), /owner revoked/);
    assert.deepEqual(calls.map(c => c.operation), ['read', 'invoke', 'write']);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('older completed journals adopt responses without dispatch and consume the persisted write receipt', async () => {
  const db = new DatabaseSync(':memory:'), calls = [];
  try {
    let store = dkgComponentStore(db, transport(calls), [], profile);
    store.grant(workflow, id, input);
    const source = await store.call(request('read', [{}]), workflow, 'native');
    const calculated = await store.call(request('invoke', source.items), workflow, 'native');
    const receipt = await store.call(request('write', calculated.items), workflow, 'native');
    receipt.items[0].historicalReceiptField = 'preserve original response';
    db.exec('CREATE TABLE dkg_component_writes (id TEXT PRIMARY KEY, request TEXT NOT NULL, evidence TEXT NOT NULL, receipt TEXT)');
    db.prepare('INSERT INTO dkg_component_writes SELECT id,request,prepared,? FROM dkg_component_calls WHERE id=?').run(JSON.stringify(receipt), id + ':write');
    db.exec('ALTER TABLE dkg_component_calls DROP COLUMN request; ALTER TABLE dkg_component_calls DROP COLUMN prepared');
    // Model the pre-response schema, including its operation-specific result column.
    if (db.prepare('PRAGMA table_info(dkg_component_calls)').all().some(c => c.name === 'response'))
      db.exec('ALTER TABLE dkg_component_calls DROP COLUMN response');
    store = dkgComponentStore(db, () => assert.fail('migration cannot dispatch'), [], profile);
    for (const [value, response] of [[request('read', [{}]), source], [request('invoke', source.items), calculated],
      [request('write', calculated.items), receipt]])
      assert.deepEqual(await store.call(value, workflow, 'native'), response);
    assert.equal(store.writeRecovery(workflow, id, 'native', '42').pending, false);
    db.prepare('UPDATE dkg_component_calls SET response=NULL WHERE id=?').run(id + ':write');
    await assert.rejects(store.call(request('write', calculated.items), workflow, 'native'), /legacy write has no saved receipt/);
    assert.deepEqual(calls.map(c => c.operation), ['read', 'invoke', 'write']);
  } finally { db.close(); }
});
