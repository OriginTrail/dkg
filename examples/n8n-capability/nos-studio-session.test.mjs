import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadNosStudioSession } from './nos-studio-session.mjs';
import { createNosNodeClient, invokeNosProgram, writeNosEvidence } from './nos-node-transport.mjs';
import { createHash } from 'node:crypto';

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
