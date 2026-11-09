import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadNosStudioSession } from './nos-studio-session.mjs';
import { createNosNodeClient, invokeNosProgram, writeNosEvidence } from './nos-node-transport.mjs';
import { createHash } from 'node:crypto';
import measurementProfile, { measurements } from './test-support/measurement-profile.mjs';
import { verifyJpbEvidence } from './profiles/jpb-evidence.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nos-studio-auth-'));
  const secret = 'test-service-secret-'.repeat(3), secretFile = join(dir, 'secret');
  writeFileSync(secretFile, secret, { mode: 0o600 });
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ accountId: 'account-actual', controlPlaneUrl: 'http://127.0.0.1:4610', secretFile }));
  const session = loadNosStudioSession(file);
  const headers = { 'x-nos-workflows-secret': secret, 'x-nos-workflows-account': 'account-actual', 'x-nos-workflows-principal': 'person-owner', 'x-nos-workflows-role': 'owner' };
  return { dir, file, session, headers, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
test('configured companion refuses kit, untrusted, foreign and bearer-forwarded identities', () => {
  const f = fixture();
  try {
    assert.equal(f.session.actor(f.headers).id, 'person-owner');
    for (const h of [{ authorization: 'Bearer l1-owner-a' }, { ...f.headers, 'x-nos-workflows-secret': 'wrong' },
      { ...f.headers, 'x-nos-workflows-account': 'other' }, { ...f.headers, authorization: 'Bearer real-user-secret' }])
      assert.throws(() => f.session.actor(h));
    f.session.bindState(f.dir);
    writeFileSync(join(f.dir, 'nos-account.json'), JSON.stringify({ accountId: 'another' }));
    assert.throws(() => f.session.bindState(f.dir));
  } finally { f.clean(); }
});
test('node callback sends only the service credential and bound principal; unknown outcome stays unconfirmed', async () => {
  const f = fixture();
  try {
    const actor = f.session.actor(f.headers);
    const call = createNosNodeClient(f.session, actor, async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:4610/studio/account-actual/service/node');
      assert.equal(init.headers.authorization, undefined);
      assert.equal(JSON.parse(init.body).approvedBy, 'person-owner');
      return Response.json({ kind: 'lost', reason: 'timeout' });
    });
    await assert.rejects(call('programs/execute', { invocationId: 'retained' }), /unconfirmed/);
    assert.throws(() => createNosNodeClient(f.session, { ...actor, accountId: 'other' }));
    assert.throws(() => createNosNodeClient(f.session, { ...actor, role: 'viewer' }));
  } finally { f.clean(); }
});
test('Program transport preserves invocation, checks binding and source, and parses persisted output', async () => {
  const source = 'return 3;', selected = { contextGraphId: 'study', operationIri: 'urn:calculate', version: '1', bindingDigest: 'b'.repeat(64),
    program: { contextGraphId: 'programs', programIri: 'urn:p', programLayer: 'wm', sourceHash: createHash('sha256').update(source).digest('hex') } };
  const request = { selected, invocationId: 'same-id', inputs: [{ value: 3 }] }; let executes = 0;
  const call = async (path, body) => {
    if (path === 'programs/bindings') return { bindingDigest: selected.bindingDigest, binding: { enabled: true, program: selected.program } };
    if (path === 'programs/source') return { source, version: '1' };
    assert.equal(body.invocationId, request.invocationId); executes++;
    return { persisted: true, invocationId: request.invocationId, executionIri: 'urn:sr:execution:same-id', outputs: ['{"calculated":true}'] };
  };
  assert.deepEqual((await invokeNosProgram(call, request)).outputs, [{ calculated: true }]);
  await assert.rejects(invokeNosProgram(async (path, ...rest) => path === 'programs/source' ? { source: 'changed', version: '1' } : call(path, ...rest), request));
  assert.equal(executes, 1);
});
test('Write seals and reads back exact evidence; ambiguous retry cannot recreate or report a draft as sealed', async () => {
  const payloadText = '{"calculated":true,"operation":"Ébavurer"}', digest = createHash('sha256').update(payloadText).digest('hex');
  const payload = { name: 'result-one', digest, allowCreate: true, quads: [{ subject: 'urn:a', predicate: 'urn:nos:workflow:payload', object: JSON.stringify(payloadText) }] };
  let exists = false, creates = 0, status = 'wm-sealed';
  const call = async (path, body) => {
    if (path === 'knowledge-assets') { assert.equal(body.alsoPublishVm, false); assert.equal(body.finalize, true); creates++; exists = true; return {}; }
    if (!exists) throw Object.assign(new Error('missing'), { status: 404 });
    if (path.endsWith('/wm/quads')) return { quads: payload.quads.map(q => ({ ...q, object: q.object.replaceAll('É', '\\u00C9') })) };
    return { status, reservedUal: 'urn:asset:1' };
  };
  assert.equal((await writeNosEvidence(call, payload, 'study')).readbackVerified, true);
  await writeNosEvidence(call, { ...payload, allowCreate: false }, 'study'); assert.equal(creates, 1);
  status = 'wm-draft'; await assert.rejects(writeNosEvidence(call, payload, 'study'), /sealed/);
  exists = false; await assert.rejects(writeNosEvidence(call, { ...payload, allowCreate: false }, 'study'), /unconfirmed/);
  assert.equal(creates, 1);
});

test('shared node writer stores another profile vocabulary and still refuses differing readback', async () => {
  const { payload } = measurementProfile.evidence(measurements, { executionIri: 'urn:test:execution' }, { measurements });
  let exists = false, creates = 0, stored = payload.quads;
  const call = async (path, body) => {
    if (path === 'knowledge-assets') {
      assert.deepEqual(body.quads, payload.quads); creates++; exists = true; return {};
    }
    if (!exists) throw Object.assign(new Error('missing'), { status: 404 });
    return path.endsWith('/wm/quads') ? { quads: stored } : { status: 'wm-sealed' };
  };
  const receipt = await writeNosEvidence(call, { ...payload, allowCreate: true }, measurementProfile.targetGraph);
  assert.equal(receipt.readbackVerified, true); assert.equal(receipt.digest, payload.digest);
  assert.equal(receipt.contextGraphId, measurementProfile.targetGraph);
  await writeNosEvidence(call, { ...payload, allowCreate: false }, measurementProfile.targetGraph);
  assert.equal(creates, 1);
  for (const quads of [[], [...payload.quads, { subject: 'urn:extra', predicate: 'urn:extra', object: 'urn:extra' }],
    payload.quads.map(q => ({ ...q, object: 'urn:changed' }))]) {
    stored = quads;
    await assert.rejects(writeNosEvidence(call, payload, measurementProfile.targetGraph), /differs/);
  }
  assert.equal(creates, 1);
});

test('JPB owns evidence digest validation, including equivalent Unicode escapes', () => {
  const value = '{"operation":"Ébavurer"}', payload = { digest: createHash('sha256').update(value).digest('hex'),
    quads: [{ subject: 'urn:test:jpb', predicate: 'urn:nos:workflow:payload', object: JSON.stringify(value).replaceAll('É', '\\u00c9') }] };
  verifyJpbEvidence(payload);
  assert.throws(() => verifyJpbEvidence({ ...payload, digest: '0'.repeat(64) }), /digest differs/);
  assert.throws(() => verifyJpbEvidence({ ...payload, quads: [] }), /digest differs/);
  assert.throws(() => verifyJpbEvidence({ ...payload, quads: [...payload.quads, ...payload.quads] }), /digest differs/);
});

for (const [name, requested, stored] of [
  ['integer', '"7"^^<http://www.w3.org/2001/XMLSchema#integer>', '"\\u0037"^^<http://www.w3.org/2001/XMLSchema#integer>'],
  ['date', '"2026-11-09T12:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', '"2026-11-09T12:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>'],
  ['language', '"Équipement"@FR', '"\\u00c9quipement"@fr'],
  ['explicit string', '"text"^^<http://www.w3.org/2001/XMLSchema#string>', '"text"'],
]) test(`node writer verifies ${name} RDF and reconciles without another create`, async () => {
  const payload = { name: 'typed-result', digest: 'a'.repeat(64), allowCreate: true,
    quads: [{ subject: 'urn:test:s', predicate: 'urn:test:p', object: requested }] };
  let exists = false, creates = 0;
  const call = async path => {
    if (path === 'knowledge-assets') { creates++; exists = true; throw new Error('reply lost after sealing'); }
    if (!exists) throw Object.assign(new Error('missing'), { status: 404 });
    return path.endsWith('/wm/quads') ? { quads: payload.quads.map(q => ({ ...q, object: stored })) } : { status: 'wm-sealed' };
  };
  await assert.rejects(writeNosEvidence(call, payload, 'study'), /reply lost/);
  assert.equal((await writeNosEvidence(call, { ...payload, allowCreate: false }, 'study')).readbackVerified, true);
  assert.equal(creates, 1);
});

test('node writer preserves RDF datatype, language, lexical value and literal identity', async () => {
  for (const [requested, stored] of [
    ['"7"^^<http://www.w3.org/2001/XMLSchema#integer>', '"7"^^<http://www.w3.org/2001/XMLSchema#decimal>'],
    ['"7"^^<http://www.w3.org/2001/XMLSchema#integer>', '"8"^^<http://www.w3.org/2001/XMLSchema#integer>'],
    ['"bonjour"@fr', '"bonjour"@en'], ['"bonjour"@fr', '"bonjour"'], ['"urn:test:value"', 'urn:test:value'],
  ]) {
    const quad = { subject: 'urn:test:s', predicate: 'urn:test:p', object: requested };
    const call = async path => path.endsWith('/wm/quads') ? { quads: [{ ...quad, object: stored }] } : { status: 'wm-sealed' };
    await assert.rejects(writeNosEvidence(call, { name: 'rdf-result', quads: [quad] }, 'study'), /differs/);
  }
  let calls = 0;
  await assert.rejects(writeNosEvidence(async () => { calls++; }, { name: 'bad-rdf', quads: [
    { subject: 'urn:test:s', predicate: 'urn:test:p', object: '"unterminated' },
  ] }, 'study'), /Invalid evidence RDF literal/);
  assert.equal(calls, 0);
});

test('node writer reconciles equivalent bracketed and bare IRIs in every position', async () => {
  for (const bracketedRequest of [true, false]) {
    const shape = (q, brackets) => Object.fromEntries(Object.entries(q).map(([key, value]) => [key, brackets ? `<${value}>` : value]));
    const bare = { subject: 'urn:test:s', predicate: 'urn:test:p', object: 'urn:test:o', graph: 'urn:test:g' };
    const payload = { name: 'iri-result', digest: 'b'.repeat(64), allowCreate: true, quads: [shape(bare, bracketedRequest)] };
    let exists = false, creates = 0, readback = shape(bare, !bracketedRequest);
    const call = async path => {
      if (path === 'knowledge-assets') { creates++; exists = true; throw new Error('reply lost after sealing'); }
      if (!exists) throw Object.assign(new Error('missing'), { status: 404 });
      return path.endsWith('/wm/quads') ? { quads: [readback] } : { status: 'wm-sealed' };
    };
    await assert.rejects(writeNosEvidence(call, payload, 'study'), /reply lost/);
    const retry = { ...payload, allowCreate: false };
    assert.equal((await writeNosEvidence(call, retry, 'study')).readbackVerified, true);
    for (const field of ['subject', 'predicate', 'object', 'graph']) {
      readback = shape({ ...bare, [field]: 'urn:test:different' }, !bracketedRequest);
      await assert.rejects(writeNosEvidence(call, retry, 'study'), /differs/);
    }
    assert.equal(creates, 1);
  }
});

test('node writer normalizes omitted and empty default graphs without dropping named graph identity', async () => {
  const quad = { subject: 'urn:test:s', predicate: 'urn:test:p', object: '"value"' };
  let readback, posts = 0;
  const call = async (path, body) => {
    if (body) posts++;
    return path.endsWith('/wm/quads') ? { quads: readback } : { status: 'wm-sealed' };
  };
  for (const requested of [quad, { ...quad, graph: '' }]) {
    const payload = { name: 'graph-result', allowCreate: false, quads: [requested] };
    readback = [{ ...quad, ...(requested.graph === undefined ? { graph: '' } : {}) }];
    assert.equal((await writeNosEvidence(call, payload, 'study')).readbackVerified, true);
    for (const changed of [[{ ...quad, graph: 'urn:unexpected' }],
      [requested, { ...quad, graph: 'urn:unexpected' }]]) {
      readback = changed;
      await assert.rejects(writeNosEvidence(call, payload, 'study'), /differs/);
    }
  }
  assert.equal(posts, 0);
});


for (const phase of ['before dispatch', 'after execution']) for (const invalid of ['disabled', 'missing', 'digest', 'program pin']) {
  test(`Program transport rejects ${invalid} approval ${phase}`, async () => {
    const source = 'return 3;', selected = { contextGraphId: 'study', operationIri: 'urn:calculate', version: '1', bindingDigest: 'b'.repeat(64),
      program: { contextGraphId: 'programs', programIri: 'urn:p', programLayer: 'wm', authorAgentAddress: '0x' + '1'.repeat(40),
        sourceHash: createHash('sha256').update(source).digest('hex') } };
    const request = { selected, invocationId: 'same-id', inputs: [{ value: 3 }] }, paths = [];
    let executes = 0;
    const call = async (path, body, query) => {
      paths.push(path);
      if (path === 'programs/bindings') {
        assert.deepEqual(query, { contextGraphId: selected.contextGraphId, operationIri: selected.operationIri });
        const approval = { bindingDigest: selected.bindingDigest, binding: { enabled: true, program: structuredClone(selected.program) } };
        if (phase === 'before dispatch' || executes) {
          if (invalid === 'disabled') approval.binding.enabled = false;
          if (invalid === 'missing') delete approval.binding;
          if (invalid === 'digest') approval.bindingDigest = 'c'.repeat(64);
          if (invalid === 'program pin') approval.binding.program.programIri = 'urn:another-program';
        }
        return approval;
      }
      if (path === 'programs/source') return { source, version: '1' };
      assert.equal(path, 'programs/execute');
      assert.deepEqual(body, { contextGraphId: selected.contextGraphId, operationIri: selected.operationIri,
        invocationId: request.invocationId, inputs: request.inputs });
      executes++;
      return { persisted: true, invocationId: request.invocationId, executionIri: 'urn:sr:execution:same-id', outputs: ['{"calculated":true}'] };
    };
    await assert.rejects(invokeNosProgram(call, request), { code: 'DKG_COMPONENT_UNCONFIRMED', message: 'Program binding changed.' });
    assert.equal(executes, phase === 'before dispatch' ? 0 : 1);
    assert.deepEqual(paths, phase === 'before dispatch' ? ['programs/bindings']
      : ['programs/bindings', 'programs/source', 'programs/execute', 'programs/bindings']);
  });
}
