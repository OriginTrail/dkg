import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { dkgComponentStore } from './test-support/dkg-component-store-fixture.mjs';
import { profileParameters } from './dkg-profile.mjs';
import { JPB_SOURCE, JPB_WORKBOOK } from './profiles/jpb-evidence.mjs';

const rows = () => Array.from({ length: 4 }, (_, i) => ({ row: i, quantity: i + 1,
  allocationStatus: 'unconfirmed', mapping: { operation: 'CUT', unit: 'kg' }, evidence: { contentDigest: JPB_WORKBOOK } }));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'jpb-policy-')), file = join(dir, 'inputs.json');
  return { dir, file, write: value => writeFileSync(file, JSON.stringify([{ workbook: value }])),
    close: () => rmSync(dir, { recursive: true, force: true }) };
}
function sessionFile(dir) {
  const secretFile = join(dir, 'secret'), file = join(dir, 'session.json');
  writeFileSync(secretFile, 'fictional-profile-test-service-secret', { mode: 0o600 });
  writeFileSync(file, JSON.stringify({ accountId: 'test-account', controlPlaneUrl: 'http://127.0.0.1:4610', runnerBindingRevision: 'test-runner-v1', secretFile }));
  return file;
}
async function load(file) {
  const old = process.env.NOS_JPB_WORKBOOK_INPUT_FILE;
  try {
    if (file) process.env.NOS_JPB_WORKBOOK_INPUT_FILE = file; else delete process.env.NOS_JPB_WORKBOOK_INPUT_FILE;
    return (await import(new URL('./profiles/jpb.mjs?snapshot=' + randomUUID(), import.meta.url))).default;
  } finally {
    if (old === undefined) delete process.env.NOS_JPB_WORKBOOK_INPUT_FILE; else process.env.NOS_JPB_WORKBOOK_INPUT_FILE = old;
  }
}
const reorderKeys = value => Array.isArray(value) ? value.map(reorderKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorderKeys(item)])) : value;

test('JPB pins a normalized workbook snapshot and never reloads or exposes its mutable policy', async () => {
  const f = fixture();
  try {
    const original = rows(); f.write(original);
    const profile = await load(f.file), revision = profile.revision;
    assert.deepEqual(profile.loadInputs(), original);
    const returned = profile.loadInputs(); returned[0].quantity = 777;
    assert.deepEqual(profile.loadInputs(), original);
    const changed = rows(); changed[0].quantity = 999; f.write(changed);
    assert.deepEqual(profile.loadInputs(), original);
    assert.equal(profile.revision, revision);
    const otherFile = join(f.dir, 'same-policy.json');
    writeFileSync(otherFile, JSON.stringify([{ workbook: reorderKeys(original) }], null, 2));
    assert.equal((await load(otherFile)).revision, revision);
    assert.notEqual((await load(f.file)).revision, revision);
    changed[0].quantity = original[0].quantity; changed[0].mapping.unit = 'g'; f.write(changed);
    assert.notEqual((await load(f.file)).revision, revision);
    assert.notEqual((await load()).revision, revision);
  } finally { f.close(); }
});

test('JPB validates bounded workbook policy at profile load', async () => {
  const f = fixture();
  try {
    for (const value of [[], [null, null, null, null], rows().map(r => ({ ...r, evidence: { contentDigest: '0'.repeat(64) } })),
      rows().map(r => ({ ...r, mapping: 'x'.repeat(9000) }))]) {
      f.write(value); await assert.rejects(load(f.file));
    }
    writeFileSync(f.file, '{broken'); await assert.rejects(load(f.file));
  } finally { f.close(); }
});

test('changed workbook policy fences saved workflow pins and pending writes after reopen', async () => {
  const f = fixture(), file = join(f.dir, 'journal.sqlite'), calls = [];
  let db;
  const id = '11223344-1234-4234-8234-123456789abc';
  const request = (blockId, items) => ({ blockId, items, effectId: 'urn:sr:effect:' + id + ':0', workflowId: 'native', executionId: '42' });
  try {
    const original = rows(); f.write(original);
    const profile = { ...await load(f.file), enabled: () => true };
    const block = (id, componentId) => ({ id, componentId,
      params: Object.fromEntries(Object.entries(profileParameters(profile, componentId)).map(([k, v]) => [k, v.default])) });
    const workflow = { kaRef: 'urn:test:policy-workflow', sourceHash: 'a'.repeat(64), definition: { entryId: 'read',
      nodes: [block('read', 'dkg-read'), block('write', 'dkg-write')], edges: [{ from: 'read', to: 'write' }] } };
    const input = { itemsJson: JSON.stringify([{ workbook: original }]), paramsJson: '{}', executionId: '' };
    const records = ['CUT', 'USILU', 'EBAVM'].map(operationCode => ({ operationCode, orderNo: '62633',
      recordId: 'urn:test:' + operationCode, evidence: { contextGraphId: JPB_SOURCE } }));
    const transport = async (payload, operation) => {
      calls.push(operation);
      if (operation === 'read') return { records, source: { contextGraphId: JPB_SOURCE } };
      throw new Error('write reply lost');
    };
    db = new DatabaseSync(file);
    const first = dkgComponentStore(db, transport, original, profile);
    first.grant(workflow, id, input);
    await first.call(request('read', JSON.parse(input.itemsJson)), workflow, 'native');
    const writeRequest = request('write', [{ erp: records[0], workbook: original[0] }]);
    await assert.rejects(first.call(writeRequest, workflow, 'native'), /write reply lost/);
    assert.equal(db.prepare('SELECT result FROM dkg_component_calls WHERE id=?').get(id + ':write').result, null);
    db.close(); db = undefined;
    const changed = rows(); changed[0].quantity = 999; f.write(changed);
    const nextProfile = { ...await load(f.file), enabled: () => true };
    db = new DatabaseSync(file);
    const reopened = dkgComponentStore(db, transport, changed, nextProfile);
    assert.throws(() => reopened.grant(workflow, randomUUID(), input), /profile changed/);
    await assert.rejects(reopened.call(writeRequest, workflow, 'native'), /profile changed/);
    const repinned = structuredClone(workflow);
    for (const node of repinned.definition.nodes) node.params.profileRevision = nextProfile.revision;
    await assert.rejects(reopened.call(writeRequest, repinned, 'native'), /profile mismatch/);
    assert.deepEqual(calls, ['read', 'write']);
  } finally { db?.close(); f.close(); }
});

test('authenticated JPB revision also changes with approved workbook quantities', () => {
  const f = fixture();
  try {
    const session = sessionFile(f.dir);
    const read = () => execFileSync(process.execPath, ['--input-type=module', '-e',
      `const {loadStudioContext}=await import(${JSON.stringify(new URL('./studio-context.mjs', import.meta.url).href)}); const {profile:p}=await loadStudioContext({...process.env,NOS_DKG_PROFILE_MODULE:${JSON.stringify(fileURLToPath(new URL('./profiles/jpb-nos.mjs', import.meta.url)))}}); console.log(p.revision);`],
    { encoding: 'utf8', env: { ...process.env, NOS_STUDIO_SESSION_FILE: session, NOS_JPB_WORKBOOK_INPUT_FILE: f.file } }).trim();
    const original = rows(); f.write(original); const revision = read();
    original[0].quantity = 999; f.write(original); assert.notEqual(read(), revision);
  } finally { f.close(); }
});

test('authenticated JPB write checks its digest before dispatch and verifies exact node readback', () => {
  const f = fixture();
  try {
    f.write(rows());
    const script = `
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      const { loadStudioContext } = await import(${JSON.stringify(new URL('./studio-context.mjs', import.meta.url).href)});
      const { profile } = await loadStudioContext({...process.env,NOS_DKG_PROFILE_MODULE:${JSON.stringify(fileURLToPath(new URL('./profiles/jpb-nos.mjs', import.meta.url)))}});
      const text = JSON.stringify({ kind: 'fictional-jpb-test', value: 7 });
      const payload = { name: 'test-result', digest: createHash('sha256').update(text).digest('hex'), allowCreate: true,
        quads: [{ subject: 'urn:test:result', predicate: 'urn:nos:workflow:payload', object: JSON.stringify(text) }] };
      const context = { actor: { id: 'test-owner', accountId: 'test-account', role: 'owner' } };
      let hits = 0, creates = 0, exists = false, changed = false;
      globalThis.fetch = async (_url, init) => {
        hits++; const { path, body } = JSON.parse(init.body);
        if (path === 'knowledge-assets') { creates++; exists = true; assert.deepEqual(body.quads, payload.quads); }
        else if (!exists) return Response.json({ kind: 'answer', status: 404, body: {} });
        return Response.json({ kind: 'answer', status: 200, body: path.endsWith('/wm/quads')
          ? { quads: changed ? [] : payload.quads } : { status: 'wm-sealed' } });
      };
      await assert.rejects(profile.operations['dkg-write'].transport({ ...payload, digest: '0'.repeat(64) }, context), /digest differs/);
      assert.equal(hits, 0);
      assert.equal((await profile.operations['dkg-write'].transport(payload, context)).readbackVerified, true);
      await profile.operations['dkg-write'].transport({ ...payload, allowCreate: false }, context);
      assert.equal(creates, 1);
      changed = true;
      await assert.rejects(profile.operations['dkg-write'].transport(payload, context), /differs/);
      assert.equal(creates, 1);
      console.log('verified');
    `;
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8',
      env: { ...process.env, NOS_STUDIO_SESSION_FILE: sessionFile(f.dir), NOS_JPB_WORKBOOK_INPUT_FILE: f.file } }).trim(), 'verified');
  } finally { f.close(); }
});

for (const scenario of [
  { name: 'rejects a literal calculated claim over an uncalculated result', raw: { calculated: false, total: null }, mapped: { calculated: true, total: 999 }, reject: true },
  { name: 'rejects a literal replacement of a calculated assessment', raw: { calculated: true, total: 7 }, mapped: { calculated: true, total: 900 }, reject: true },
  { name: 'accepts a genuine calculated assessment', raw: { calculated: true, total: 7 } },
  { name: 'accepts a presentation mapping that preserves the assessment and records', raw: { calculated: true, total: 7 }, project: true },
  { name: 'preserves a genuine uncalculated assessment', raw: { calculated: false, total: null } },
  { name: 'rejects a legacy mapped-only journal without raw output', raw: { calculated: true, total: 7 }, legacy: true, reject: true },
]) test(`JPB calculated evidence ${scenario.name}`, async () => {
  const f = fixture(), workbook = rows(), id = randomUUID(), calls = [], writes = [];
  const flags = ['NOS_JPB_READ_ENABLED', 'NOS_JPB_PROGRAM_ENABLED', 'NOS_JPB_WRITE_ENABLED'];
  const old = flags.map(key => process.env[key]);
  let db;
  try {
    flags.forEach(key => { process.env[key] = '1'; });
    f.write(workbook);
    const profile = await load(f.file);
    const block = (id, componentId) => ({ id, componentId,
      params: Object.fromEntries(Object.entries(profileParameters(profile, componentId)).map(([key, value]) => [key, value.default])) });
    const read = block('read', 'dkg-read'), invoke = block('invoke', 'invoke-dkg-program'), write = block('write', 'dkg-write');
    invoke.params.program = 'JPB PLCA - Calculate mapped demo v1.0.0';
    invoke.params.inputs = [{ records: [{ erp: '{{ $json[0].erp[0] }}', workbook: '{{ $json[0].workbook[0] }}' }] }];
    invoke.params.outputMapping = scenario.mapped || scenario.project
      ? { records: '{{ $json[0].records }}', assessment: scenario.mapped ?? '{{ $json[0].assessment }}', display: 'presentation only' }
      : '{{ $json[0] }}';
    const workflow = { kaRef: 'urn:test:calculated-evidence', sourceHash: 'a'.repeat(64), definition: {
      entryId: 'read', nodes: [read, invoke, write], edges: [{ from: 'read', to: 'invoke' }, { from: 'invoke', to: 'write' }] } };
    const input = { itemsJson: JSON.stringify([{ workbook }]), paramsJson: '{}', executionId: '' };
    const request = (blockId, items) => ({ blockId, items, effectId: `urn:sr:effect:${id}:0`, workflowId: 'native', executionId: '42' });
    const records = ['CUT', 'USILU', 'EBAVM'].map(operationCode => ({ operationCode, orderNo: '62633',
      recordId: 'urn:test:' + operationCode, evidence: { contextGraphId: JPB_SOURCE } }));
    let remoteOutputs;
    const transport = async (payload, operation) => {
      calls.push(operation);
      if (operation === 'read') return { records, source: { contextGraphId: JPB_SOURCE } };
      if (operation === 'invoke') {
        remoteOutputs = [{ records: payload.inputs[0].records, assessment: scenario.raw }];
        return { invocationId: payload.invocationId, executionIri: 'urn:sr:execution:' + payload.invocationId,
          operationIri: payload.selected.operationIri, sourceHash: payload.selected.program.sourceHash,
          bindingDigest: payload.selected.bindingDigest, outputs: remoteOutputs };
      }
      assert.equal(operation, 'write'); writes.push(payload);
      return { contextGraphId: profile.targetGraph, digest: payload.digest, name: payload.name,
        readbackVerified: true, metadata: { status: 'wm-sealed', reservedUal: 'urn:test:calculated-evidence' } };
    };
    const file = join(f.dir, 'calculation.sqlite'); db = new DatabaseSync(file);
    let store = dkgComponentStore(db, transport, undefined, profile);
    store.grant(workflow, id, input);
    const source = await store.call(request('read', JSON.parse(input.itemsJson)), workflow, 'native');
    const result = await store.call(request('invoke', source.items), workflow, 'native');
    assert.deepEqual(Object.keys(result), ['items'], 'raw verification data stays inside the journal');
    const journal = JSON.parse(db.prepare('SELECT result FROM dkg_component_calls WHERE id=?').get(id + ':invoke').result);
    if (scenario.legacy) {
      delete journal.rawOutputs;
      db.prepare('UPDATE dkg_component_calls SET result=? WHERE id=?').run(JSON.stringify(journal), id + ':invoke');
    }
    db.close(); db = new DatabaseSync(file);
    store = dkgComponentStore(db, transport, undefined, profile);
    assert.deepEqual(await store.call(request('invoke', source.items), workflow, 'native'), result);
    if (scenario.reject) {
      await assert.rejects(store.call(request('write', result.items), workflow, 'native'), /verified Program output/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dkg_component_calls WHERE result IS NULL').get().n, 0);
      assert.deepEqual(calls, ['read', 'invoke']);
      return;
    }
    const receipt = await store.call(request('write', result.items), workflow, 'native');
    assert.deepEqual(journal.rawOutputs, remoteOutputs);
    assert.deepEqual(receipt.items[0].assessment, scenario.raw);
    assert.equal(receipt.items[0].plcaCalculated, scenario.raw.calculated);
    const payload = JSON.parse(JSON.parse(writes[0].quads.find(q => q.predicate === 'urn:nos:workflow:payload').object));
    assert.deepEqual(payload.assessment, scenario.raw);
    assert.deepEqual(payload.records, remoteOutputs[0].records);
    assert.equal(payload.plcaCalculated, scenario.raw.calculated);
    assert.equal(payload.programExecution.executionIri, result.items[0].programExecution.executionIri);
    assert.ok(writes[0].quads.some(q => q.predicate === 'http://www.w3.org/ns/prov#wasGeneratedBy'
      && q.object === result.items[0].programExecution.executionIri));
    assert.deepEqual(await store.call(request('write', result.items), workflow, 'native'), receipt);
    assert.deepEqual(calls, ['read', 'invoke', 'write']);
  } finally {
    db?.close(); f.close();
    flags.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
  }
});
