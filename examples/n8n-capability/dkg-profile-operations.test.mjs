import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadDkgProfile, profileOperations, profileParameters, validateDkgProfile } from './dkg-profile.mjs';
import { createStudioContext } from './studio-context.mjs';
import { standaloneComponentWorkflow } from './component-workflows.mjs';
import { dkgComponentStore } from './dkg-components.mjs';
import measurementProfile, { measurements } from './test-support/measurement-profile.mjs';
import readProfile from './test-support/agent-read-profile.mjs';

test('legacy profiles normalize once with stable operations, one shared loader and live policy hooks', async () => {
  let loads = 0, enabled = true, authorized = true, transports = 0;
  const source = { ...measurementProfile, requiresNosActor: true, accountId: 'fixture-account',
    loadInputs() { loads++; return []; }, enabled: () => enabled,
    async authorize() { if (!authorized) throw new Error('revoked'); },
    transport() { transports++; return { graph: 'urn:test:measurements', measurements }; } };
  const context = createStudioContext({ profile: source }), runtime = context.profile;
  assert.notEqual(runtime, source); assert.equal(runtime, context.registry.profile);
  assert.equal(validateDkgProfile(source), runtime); assert.equal(validateDkgProfile(runtime), runtime);
  assert.equal(profileOperations(source), runtime.operations);
  assert.equal(Object.hasOwn(runtime, 'transport'), false);
  assert.equal(runtime.revision, source.revision);
  const operations = Object.values(runtime.operations), load = operations[0].loadInputs;
  assert.ok(operations.every(operation => operation.loadInputs === load));
  const db = new DatabaseSync(':memory:');
  try { dkgComponentStore(db, source); assert.equal(loads, 1); } finally { db.close(); }
  enabled = false; assert.equal(runtime.operations['dkg-read'].enabled(), false);
  source.enabled = () => true; assert.equal(runtime.operations['dkg-read'].enabled(), true);
  await runtime.authorize(); authorized = false; await assert.rejects(runtime.authorize(), /revoked/);
  source.authorize = async () => {}; await runtime.authorize();
  await runtime.operations['dkg-read'].transport({}, {}); assert.equal(transports, 1);
  source.revision = 'f'.repeat(64); assert.equal(runtime.revision, source.revision);
  assert.equal(validateDkgProfile(source).operations, runtime.operations);
});

test('read-only profile loads without Program, write or shared transport placeholders and advertises only Read', async () => {
  const profile = await loadDkgProfile(fileURLToPath(new URL('./test-support/agent-read-profile.mjs', import.meta.url)));
  assert.deepEqual(Object.keys(profile.operations), ['dkg-read']);
  for (const key of ['targetGraph', 'programs', 'catalogRevision', 'parameters', 'evidence', 'transport', 'loadInputs'])
    assert.equal(Object.hasOwn(profile, key), false, key);
  const { registry } = createStudioContext({ profile });
  assert.deepEqual(registry.componentRegistry.filter(c => c.category === 'DKG').map(c => c.id), ['dkg-read']);
  for (const id of ['invoke-dkg-program', 'dkg-write']) {
    assert.throws(() => profileParameters(profile, id), /not supported/);
    assert.throws(() => registry.component(id), { code: 'WORKFLOW_CAPABILITY_CHANGED' });
  }
});

test('declared read capability dispatches and replays with current authorization and its enable switch', async () => {
  let enabled = true, authorized = true, calls = 0, loads = 0;
  const selectedInputs = [{ sample: 'a' }];
  const profile = { ...readProfile, authorize() { if (!authorized) throw new Error('owner revoked'); },
    operations: { 'dkg-read': { ...readProfile.operations['dkg-read'], enabled: () => enabled,
      loadInputs() { loads++; return structuredClone(selectedInputs); },
      validateInput(definition, input, approvedInputs) {
        readProfile.operations['dkg-read'].validateInput(definition, input);
        if (input.itemsJson !== JSON.stringify(approvedInputs)) throw new Error('Input differs from the approved profile snapshot');
      },
      transport(request) { calls++; assert.equal(request.sample, 'a'); return { graph: 'urn:test:measurements', measurements }; } } } };
  const db = new DatabaseSync(':memory:');
  try {
    const store = dkgComponentStore(db, profile);
    selectedInputs[0].sample = 'b'; // Configuration changes cannot mutate this journal's loaded snapshot.
    const node = { id: 'read', componentId: 'dkg-read', params: Object.fromEntries(Object.entries(profileParameters(profile, 'dkg-read')).map(([k, v]) => [k, v.default])) };
    const workflow = { kaRef: 'urn:test:readonly', sourceHash: 'a'.repeat(64), definition: { entryId: node.id, nodes: [node], edges: [] } };
    const id = '11223344-1234-4234-8234-123456789abc', input = { itemsJson: '[{"sample":"a"}]', paramsJson: '{}', executionId: '' };
    const journal = { invocationId: id, revisionDigest: workflow.sourceHash };
    const actor = { id: 'owner', role: 'owner', accountId: profile.accountId };
    const request = { blockId: node.id, items: [{ sample: 'a' }], effectId: 'urn:sr:effect:' + id + ':0', workflowId: 'native', executionId: '42' };
    const call = () => store.call(request, workflow, journal, 'native', { invocationId: request.effectId, input });
    store.grant(workflow, journal, input, actor);
    assert.throws(() => store.grant(workflow, { ...journal, invocationId: 'different-run' },
      { ...input, itemsJson: '[{"sample":"b"}]' }, actor), /approved profile snapshot/);
    assert.deepEqual(await call(), { items: measurements });
    assert.deepEqual(await call(), { items: measurements });
    enabled = false;
    await assert.rejects(call(), /not enabled/);
    enabled = true; authorized = false;
    await assert.rejects(call(), /owner revoked/);
    for (const componentId of ['invoke-dkg-program', 'dkg-write']) {
      const unsupported = { ...workflow, definition: { ...workflow.definition, nodes: [{ ...node, componentId }] } };
      assert.throws(() => store.grant(unsupported, journal, input, actor), /not supported/);
    }
    assert.equal(calls, 1);
    assert.equal(loads, 1);
  } finally { db.close(); }
});

test('each declared operation validates only its own contract and rejects incomplete or unknown capabilities', () => {
  const common = { id: 'independent-operations', revision: measurementProfile.revision, node: measurementProfile.node };
  const operations = profileOperations(measurementProfile);
  for (const id of Object.keys(operations)) {
    const profile = { ...common, operations: { [id]: operations[id] } };
    assert.equal(validateDkgProfile(profile), profile);
    assert.deepEqual(createStudioContext({ profile }).registry.componentRegistry.filter(c => c.category === 'DKG').map(c => c.id), [id]);
  }
  for (const [id, field] of [['dkg-read', 'readItems'], ['dkg-read', 'readRequest'], ['invoke-dkg-program', 'programs'],
    ['invoke-dkg-program', 'catalogRevision'], ['dkg-write', 'targetGraph'], ['dkg-write', 'evidence'], ['dkg-read', 'transport']]) {
    const operation = { ...operations[id] }; delete operation[field];
    assert.throws(() => validateDkgProfile({ ...common, operations: { [id]: operation } }), /Invalid DKG operation/);
  }
  for (const operations of [{}, { unknown: readProfile.operations['dkg-read'] }, null])
    assert.throws(() => validateDkgProfile({ ...common, operations }), /Invalid DKG operation/);
});

test('JPB profile pins preserve the SSH baseline and explicitly version the nOS bounded-reader change', async () => {
  const previous = Object.fromEntries(['NOS_JPB_WORKBOOK_INPUT_FILE', 'NOS_JPB_READ_ENABLED', 'NOS_JPB_PROGRAM_ENABLED', 'NOS_JPB_WRITE_ENABLED']
    .map(key => [key, process.env[key]]));
  try {
    delete process.env.NOS_JPB_WORKBOOK_INPUT_FILE;
    const { default: ssh } = await import('./profiles/jpb.mjs');
    const { createJpbNosProfile } = await import('./profiles/jpb-nos.mjs');
    const nos = createJpbNosProfile({ accountId: 'fingerprint-fixture', controlPlaneUrl: 'http://127.0.0.1:4610',
      runnerBindingRevision: 'fixture-v1', secret: () => 'synthetic-secret' });
    // Retain the pre-operation-contract baseline; the nOS transport source hash
    // deliberately changes when it adopts the shared bounded-response reader.
    const historical = JSON.parse(readFileSync(new URL('./test-fixtures/jpb-profile-revisions.json', import.meta.url), 'utf8'));
    const expected = { ...historical, 'dmaast-jpb-nos': JSON.parse(readFileSync(new URL('./test-fixtures/jpb-nos-bounded-revision.json', import.meta.url), 'utf8')) };
    assert.notEqual(nos.revision, historical['dmaast-jpb-nos'].revision);
    const hash = value => createHash('sha256').update(value).digest('hex');
    const flags = { 'dkg-read': 'NOS_JPB_READ_ENABLED', 'invoke-dkg-program': 'NOS_JPB_PROGRAM_ENABLED', 'dkg-write': 'NOS_JPB_WRITE_ENABLED' };
    for (const profile of [ssh, nos]) {
      const { registry } = createStudioContext({ profile });
      assert.equal(profile.revision, expected[profile.id].revision);
      for (const [id, flag] of Object.entries(flags)) {
        assert.deepEqual({ descriptorHash: hash(JSON.stringify(registry.component(id))), sourceHash: hash(registry.componentProgramSource(id)),
          nativeHash: hash(JSON.stringify(standaloneComponentWorkflow(id, 'fixture-flow', { id: 'fixture', name: 'Fixture' }, { registry }))) },
        expected[profile.id].components[id]);
        const operation = profileOperations(profile)[id];
        process.env[flag] = '0'; assert.equal(operation.enabled(), false);
        process.env[flag] = '1'; assert.equal(operation.enabled(), true);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
